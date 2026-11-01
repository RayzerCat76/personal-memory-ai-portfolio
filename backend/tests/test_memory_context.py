from pathlib import Path

import pytest

from app.schemas import MemoryCandidate
from app.service import MemoryService
from app.settings import Settings


def build_service(tmp_path: Path, name: str) -> MemoryService:
    root = tmp_path / name
    return MemoryService(Settings(
        db_path=root / "memory.db",
        vector_path=root / "vectors",
        friend_seed_path=root / "friend_seed.json",
        friend_seed_feedback_path=root / "friend_seed_feedback.json",
        llm_provider="heuristic",
        embedding_provider="none",
        max_retrieval=6,
    ))


def add_memory(service: MemoryService, content: str, *, confirmed: bool = False):
    memory = service.db.add_candidate(MemoryCandidate(
        type="interest", content=content, confidence=0.9,
        source_type="manual_entry", importance=0.7,
    ), source_id="test:" + content, evidence=content)
    assert memory is not None
    return service.confirm_memory(memory.id) if confirmed else memory


def test_context_note_history_stale_write_and_clear(tmp_path: Path):
    service = build_service(tmp_path, "history")
    memory = add_memory(service, "Enjoys watching personal livestreams.")

    active, revision, history = service.db.set_memory_context(memory.id, "About Ray streaming Minecraft.", 0)
    assert active and active.note == "About Ray streaming Minecraft."
    assert revision == 1 and [item.status for item in history] == ["active"]

    with pytest.raises(ValueError, match="changed"):
        service.db.set_memory_context(memory.id, "Stale overwrite", 0)
    assert service.db.get_memory_context(memory.id)[0].note == "About Ray streaming Minecraft."

    active, revision, history = service.db.set_memory_context(memory.id, "Specifically Ray's Minecraft streams.", 1)
    assert active and active.revision == 2 and revision == 2
    assert [item.status for item in history] == ["active", "superseded"]

    active, revision, history = service.db.set_memory_context(memory.id, "   ", 2)
    assert active is None and revision == 3
    assert [item.status for item in history] == ["cleared", "superseded", "superseded"]
    assert history[0].note is None


def test_context_note_disambiguates_confirmed_only(tmp_path: Path):
    service = build_service(tmp_path, "retrieve")
    minecraft = add_memory(service, "Enjoys watching personal livestreams.", confirmed=True)
    esports = add_memory(service, "Enjoys watching competitive livestreams.", confirmed=True)
    pending = add_memory(service, "Enjoys watching creator livestreams.", confirmed=False)

    service.db.set_memory_context(minecraft.id, "Ray streaming Minecraft survival worlds.", 0)
    service.db.set_memory_context(esports.id, "Esports tournament broadcasts.", 0)
    service.db.set_memory_context(pending.id, "A secret unreleased rhythm-game stream.", 0)

    minecraft_hits = service.db.search_confirmed("Minecraft stream", 6)
    assert minecraft_hits and minecraft_hits[0].id == minecraft.id
    assert esports.id not in [memory.id for memory in minecraft_hits]

    assert service.db.search_confirmed("secret unreleased rhythm game", 6) == []
    assert service.db.get_memory(pending.id).status == "unconfirmed"


def test_context_note_backup_round_trip(tmp_path: Path):
    source = build_service(tmp_path, "source")
    memory = add_memory(source, "Enjoys watching personal livestreams.", confirmed=True)
    source.db.set_memory_context(memory.id, "About Ray's Minecraft streams.", 0)
    source.db.set_memory_context(memory.id, "Ray's survival-mode Minecraft streams.", 1)

    backup = source.export_memory_backup()
    assert len(backup.context_notes) == 2
    target = build_service(tmp_path, "target")
    restored = target.restore_memory_backup(backup)
    assert restored.inserted["context_notes"] == 2
    active, revision, history = target.db.get_memory_context(memory.id)
    assert revision == 2 and active and active.note == "Ray's survival-mode Minecraft streams."
    assert [item.status for item in history] == ["active", "superseded"]

    again = target.restore_memory_backup(backup)
    assert again.inserted["context_notes"] == 0
    assert again.identical_kept["context_notes"] == 2
