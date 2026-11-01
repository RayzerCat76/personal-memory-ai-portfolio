from pathlib import Path
from datetime import timedelta
import sqlite3
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.main import app, get_service
from app.schemas import ImportMessage, ImportMessagesRequest, MemoryCandidate
from app.service import MemoryService
from app.settings import Settings


def build_service(tmp_path: Path, name: str) -> MemoryService:
    root = tmp_path / name
    return MemoryService(
        Settings(
            db_path=root / "memory.db",
            vector_path=root / "vectors",
            friend_seed_path=root / "friend_seed.json",
            friend_seed_feedback_path=root / "friend_seed_feedback.json",
            llm_provider="heuristic",
            embedding_provider="none",
            max_retrieval=6,
        )
    )


def seed_rich_state(service: MemoryService):
    imported = service.import_messages(
        ImportMessagesRequest(
            source_name="sample-export",
            subject_speakers=["Alex"],
            messages=[
                ImportMessage(speaker="Ray", content="Context only."),
                ImportMessage(speaker="Alex", content="I love Formula 1."),
            ],
        )
    )
    assert imported.messages_stored == 2

    commitment = service.db.add_candidate(
        MemoryCandidate(
            type="commitment",
            content="I need to send the robotics document.",
            confidence=0.9,
            source_type="user_statement",
            subject="robotics-document",
        ),
        source_id="manual:commitment",
        evidence="I need to send the robotics document.",
    )
    assert commitment is not None
    service.confirm_memory(commitment.id)

    goal = service.db.add_candidate(
        MemoryCandidate(
            type="goal",
            content="I want to join robotics.",
            confidence=0.9,
            source_type="user_statement",
            subject="robotics-membership",
        ),
        source_id="manual:goal",
        evidence="I want to join robotics.",
    )
    assert goal is not None
    service.confirm_memory(goal.id)

    decision = service.db.add_candidate(
        MemoryCandidate(
            type="decision",
            content="I decided to join robotics.",
            confidence=0.9,
            source_type="user_statement",
            subject="robotics-membership",
        ),
        source_id="manual:decision",
        evidence="I decided to join robotics.",
    )
    assert decision is not None
    service.confirm_memory(decision.id)
    assert service.db.get_memory(goal.id).status == "superseded"

    seed = service.db.add_candidate(
        MemoryCandidate(
            type="interest",
            content="I am interested in game music.",
            confidence=0.45,
            source_type="friend_seed",
        ),
        source_id="friend_seed:backup-test",
        evidence="Birthday seed test.",
        seed_once=True,
    )
    assert seed is not None
    service.friend_seed.save_feedback(seed.id, "sort_of")
    return seed.id


def comparable_dump(backup):
    data = backup.model_dump(mode="json")
    data.pop("exported_at")
    return data


def test_memory_backup_round_trip_and_idempotent_restore(tmp_path: Path):
    source = build_service(tmp_path, "source")
    seed_id = seed_rich_state(source)
    backup = source.export_memory_backup()

    assert backup.format == "personal-memory-backup-v1"
    assert backup.raw_chat_archive_included is False
    assert backup.imported_messages
    assert backup.memories
    assert backup.evidence
    assert backup.relations
    assert backup.open_loops
    assert backup.friend_seed_feedback[seed_id] == "sort_of"

    target = build_service(tmp_path, "target")
    restored = target.restore_memory_backup(backup)
    assert restored.inserted["memories"] == len(backup.memories)
    assert restored.inserted["evidence"] == len(backup.evidence)
    assert restored.friend_seed_feedback_added == 1

    second_export = target.export_memory_backup()
    assert comparable_dump(second_export) == comparable_dump(backup)

    again = target.restore_memory_backup(backup)
    assert all(value == 0 for value in again.inserted.values())
    assert again.identical_kept["memories"] == len(backup.memories)
    assert again.friend_seed_feedback_added == 0


def test_restore_allows_multiple_memories_from_one_message_source(tmp_path: Path):
    source = build_service(tmp_path, "shared-source")
    shared_source_id = "imsg_shared_source"
    first = source.db.add_candidate(
        MemoryCandidate(
            type="preference",
            content="I prefer concise project updates.",
            confidence=0.8,
            source_type="conversation_import",
            subject="Alex",
        ),
        source_id=shared_source_id,
        evidence="One source message can support more than one distinct memory.",
    )
    second = source.db.add_candidate(
        MemoryCandidate(
            type="interest",
            content="I am interested in robotics projects.",
            confidence=0.8,
            source_type="conversation_import",
            subject="Alex",
        ),
        source_id=shared_source_id,
        evidence="One source message can support more than one distinct memory.",
    )
    assert first is not None and second is not None
    assert first.id != second.id

    backup = source.export_memory_backup()
    shared = [memory for memory in backup.memories if memory.source_id == shared_source_id]
    assert len(shared) == 2

    target = build_service(tmp_path, "shared-target")
    restored = target.restore_memory_backup(backup)
    assert restored.inserted["memories"] == 2

    again = target.restore_memory_backup(backup)
    assert all(value == 0 for value in again.inserted.values())
    assert again.identical_kept["memories"] == 2


def test_exact_self_restore_is_noop_with_legacy_unique_source_duplicates(tmp_path: Path):
    service = build_service(tmp_path, "legacy-duplicates")
    shared_source_id = "friend_seed:legacy-duplicate"
    first = service.db.add_candidate(
        MemoryCandidate(
            type="interest",
            content="I am interested in game music.",
            confidence=0.45,
            source_type="friend_seed",
        ),
        source_id=shared_source_id,
        evidence="Legacy source identity example.",
    )
    second = service.db.add_candidate(
        MemoryCandidate(
            type="preference",
            content="I prefer instrumental soundtracks.",
            confidence=0.45,
            source_type="friend_seed",
        ),
        source_id=shared_source_id,
        evidence="Legacy source identity example.",
    )
    assert first is not None and second is not None and first.id != second.id

    backup = service.export_memory_backup()
    restored = service.restore_memory_backup(backup)

    assert all(value == 0 for value in restored.inserted.values())
    assert restored.identical_kept["memories"] == len(backup.memories)
    assert len(service.db.list_memories(limit=100)) == 2


def test_restore_conflict_rolls_back_database_changes(tmp_path: Path):
    source = build_service(tmp_path, "source")
    seed_rich_state(source)
    backup = source.export_memory_backup()

    target = build_service(tmp_path, "target")
    first = backup.memories[0]
    with target.db.connect() as con:
        con.execute(
            """INSERT INTO memories(id, type, content, status, confidence, confidence_label,
                      source_type, source_id, importance, created_at, updated_at, evidence_text,
                      subject, fingerprint)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                first.id,
                first.type,
                "Conflicting local wording.",
                first.status,
                first.confidence,
                "CONFIRMED" if first.status == "confirmed" else "UNCONFIRMED",
                first.source_type,
                first.source_id,
                first.importance,
                first.created_at.isoformat(),
                first.updated_at.isoformat(),
                first.evidence_text,
                first.subject,
                "conflict:fingerprint",
            ),
        )

    with pytest.raises(ValueError, match="nothing was overwritten"):
        target.restore_memory_backup(backup)

    assert target.db.get_memory(first.id).content == "Conflicting local wording."
    with target.db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM memories").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM memory_evidence").fetchone()[0] == 0


def test_backup_api_exports_and_restores_without_model_inference(tmp_path: Path):
    source = build_service(tmp_path, "api-source")
    seed_rich_state(source)
    app.dependency_overrides[get_service] = lambda: source
    client = TestClient(app)
    try:
        response = client.get("/api/v1/backups/memory")
        assert response.status_code == 200
        payload = response.json()
        assert payload["format"] == "personal-memory-backup-v1"
        assert payload["raw_chat_archive_included"] is False

        target = build_service(tmp_path, "api-target")
        app.dependency_overrides[get_service] = lambda: target
        restored = client.post("/api/v1/backups/memory/restore", json=payload)
        assert restored.status_code == 200
        assert restored.json()["inserted"]["memories"] == len(payload["memories"])
        assert len(target.db.list_memories(limit=1000)) == len(payload["memories"])
    finally:
        app.dependency_overrides.clear()


def seed_legacy_state(service):
    seed_rich_state(service)
    service.db.add_message("user", "Synthetic stored message.")
    loop = service.db.list_open_loops(status="active", limit=100)[0]
    service.db._add_resolution_proposal(loop.id, "synthetic-resolution", "completed", 0.8, "Synthetic resolution evidence.")
    for group, source_type in (("friend_seed:pair-a", "friend_seed"), ("friend_seed:pair-b", "friend_seed"), ("source-review:pair", "conversation_import")):
        for index in range(2):
            memory = service.db.add_candidate(
                MemoryCandidate(type="interest", content=f"Synthetic legacy {group} item {index}.", confidence=0.45, source_type=source_type),
                source_id=group, evidence=f"Synthetic evidence {group} {index}.",
            )
            assert memory is not None
            service.db.set_status(memory.id, "rejected")
            if source_type == "friend_seed":
                service.friend_seed.save_feedback(memory.id, "slander")


def test_complete_legacy_noop_preserves_all_state(tmp_path, monkeypatch):
    service = build_service(tmp_path, "complete-legacy")
    seed_legacy_state(service)
    backup = service.export_memory_backup()
    assert all(getattr(backup, key) for key in ("messages", "import_batches", "imported_messages", "memories", "evidence", "relations", "open_loops", "resolution_proposals", "friend_seed_feedback"))
    with service.db.connect() as con:
        original_rows = list(con.iterdump())
    original_feedback = service.friend_seed.feedback_path.read_bytes()
    def forbidden(*args, **kwargs):
        pytest.fail("Exact self-restore called a mutating or inference operation")
    monkeypatch.setattr(service.backup, "restore", forbidden)
    monkeypatch.setattr(service.friend_seed, "save_feedback", forbidden)
    monkeypatch.setattr(service, "_extract_candidates", forbidden)
    monkeypatch.setattr(service, "heuristic", None)
    backup.exported_at += timedelta(days=1)
    for _ in range(2):
        result = service.restore_memory_backup(backup)
        assert result.model_dump() == {
            "inserted": {key: 0 for key in result.inserted},
            "identical_kept": {key: len(getattr(backup, key)) for key in result.inserted},
            "friend_seed_feedback_added": 0,
        }
        assert sum(result.inserted.values()) == 0  # MemoryBackup's no-change notice
        assert comparable_dump(service.export_memory_backup()) == comparable_dump(backup)
        with service.db.connect() as con:
            assert list(con.iterdump()) == original_rows
        assert service.friend_seed.feedback_path.read_bytes() == original_feedback


@pytest.mark.parametrize("collection,field,value", [
    ("messages", "content", "Changed message"),
    ("import_batches", "source_name", "Changed import"),
    ("imported_messages", "speaker", "Changed speaker"),
    ("memories", "status", "unconfirmed"),
    ("memories", "subject", "Changed subject"),
    ("evidence", "evidence_text", "Changed evidence"),
    ("relations", "relation_type", "changed"),
    ("open_loops", "content", "Changed loop"),
    ("resolution_proposals", "evidence_text", "Changed proposal"),
    ("friend_seed_feedback", None, "accurate"),
])
def test_legacy_substantive_change_uses_conflict_validation(tmp_path, monkeypatch, collection, field, value):
    service = build_service(tmp_path, "legacy-conflict")
    seed_legacy_state(service)
    before = service.export_memory_backup()
    changed = before.model_copy(deep=True)
    if field is None:
        key = next(iter(changed.friend_seed_feedback))
        changed.friend_seed_feedback[key] = value
    else:
        rows = getattr(changed, collection)
        row = next((row for row in rows if getattr(row, field) != value), None)
        assert row is not None
        setattr(row, field, value)
    restore = Mock(wraps=service.backup.restore)
    monkeypatch.setattr(service.backup, "restore", restore)
    with pytest.raises(ValueError, match="nothing was overwritten"):
        service.restore_memory_backup(changed)
    restore.assert_called_once_with(changed)
    assert comparable_dump(service.export_memory_backup()) == comparable_dump(before)


def test_different_additive_backup_uses_normal_restore(tmp_path, monkeypatch):
    source = build_service(tmp_path, "additive-source")
    seed_rich_state(source)
    target = build_service(tmp_path, "additive-target")
    restore = Mock(wraps=target.backup.restore)
    monkeypatch.setattr(target.backup, "restore", restore)
    backup = source.export_memory_backup()
    result = target.restore_memory_backup(backup)
    restore.assert_called_once_with(backup)
    assert result.inserted["memories"] == len(backup.memories)
    assert comparable_dump(target.export_memory_backup()) == comparable_dump(backup)


def test_list_order_is_significant_for_exact_noop(tmp_path, monkeypatch):
    service = build_service(tmp_path, "ordered")
    seed_legacy_state(service)
    backup = service.export_memory_backup()
    backup.memories.reverse()
    restore = Mock(wraps=service.backup.restore)
    monkeypatch.setattr(service.backup, "restore", restore)
    with pytest.raises(ValueError, match="nothing was overwritten"):
        service.restore_memory_backup(backup)
    restore.assert_called_once_with(backup)


def test_state_change_before_comparison_cannot_match_stale_backup(tmp_path, monkeypatch):
    service = build_service(tmp_path, "changed-before-check")
    seed_legacy_state(service)
    backup = service.export_memory_backup()
    memory = backup.memories[0]
    with service.db.connect() as con:
        con.execute("UPDATE memories SET content = ? WHERE id = ?", ("Changed before comparison", memory.id))
    before = service.export_memory_backup()
    restore = Mock(wraps=service.backup.restore)
    monkeypatch.setattr(service.backup, "restore", restore)
    with pytest.raises(ValueError, match="nothing was overwritten"):
        service.restore_memory_backup(backup)
    restore.assert_called_once_with(backup)
    assert comparable_dump(service.export_memory_backup()) == comparable_dump(before)


def test_export_holds_database_snapshot_through_feedback_read(tmp_path, monkeypatch):
    service = build_service(tmp_path, "snapshot")
    seed_legacy_state(service)
    load_feedback = service.friend_seed.load_feedback
    def inspect_snapshot():
        # A second connection must not change SQLite between table reads and
        # the atomic feedback-file read, including when SQLite uses WAL.
        with sqlite3.connect(service.db.path, timeout=0) as writer:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                writer.execute("UPDATE memories SET content = 'Concurrent change'")
        return load_feedback()
    with service.db.connect() as con:
        con.execute("PRAGMA journal_mode=WAL")
    monkeypatch.setattr(service.friend_seed, "load_feedback", inspect_snapshot)
    service.export_memory_backup()
