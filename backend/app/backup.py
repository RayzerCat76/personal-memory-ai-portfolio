from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .db import Database, _fingerprint, confidence_label
from .gift_seed import FriendSeedStore
from .schemas import (
    MemoryCalibration,
    MemoryStatus,
    MemoryType,
    OpenLoopStatus,
    ResolutionProposalStatus,
    SourceType,
)


class BackupRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BackupMessage(BackupRecord):
    id: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=100)
    content: str = Field(max_length=100_000)
    created_at: datetime


class BackupImportBatch(BackupRecord):
    id: str = Field(min_length=1, max_length=200)
    source_name: str = Field(min_length=1, max_length=500)
    created_at: datetime


class BackupImportedMessage(BackupRecord):
    id: str = Field(min_length=1, max_length=200)
    import_id: str = Field(min_length=1, max_length=200)
    source_name: str = Field(min_length=1, max_length=500)
    external_id: str | None = Field(default=None, max_length=1000)
    speaker: str = Field(min_length=1, max_length=500)
    content: str = Field(max_length=100_000)
    message_time: datetime | None = None
    dedupe_key: str = Field(min_length=1, max_length=200)
    created_at: datetime


class BackupMemory(BackupRecord):
    id: str = Field(min_length=1, max_length=200)
    type: MemoryType
    content: str = Field(min_length=1, max_length=20_000)
    status: MemoryStatus
    confidence: float = Field(ge=0.0, le=1.0)
    source_type: SourceType
    source_id: str | None = Field(default=None, max_length=2000)
    importance: float = Field(ge=0.0, le=1.0)
    created_at: datetime
    updated_at: datetime
    evidence_text: str | None = None
    subject: str | None = Field(default=None, max_length=1000)


class BackupEvidence(BackupRecord):
    memory_id: str = Field(min_length=1, max_length=200)
    source_id: str | None = Field(default=None, max_length=2000)
    evidence_text: str = Field(max_length=200_000)
    created_at: datetime


class BackupContextNote(BackupRecord):
    id: str = Field(min_length=1, max_length=200)
    memory_id: str = Field(min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=5000)
    status: Literal["active", "superseded", "cleared"]
    revision: int = Field(ge=1)
    created_at: datetime


class BackupRelation(BackupRecord):
    id: str = Field(min_length=1, max_length=200)
    source_memory_id: str = Field(min_length=1, max_length=200)
    target_memory_id: str = Field(min_length=1, max_length=200)
    relation_type: str = Field(min_length=1, max_length=100)
    created_at: datetime


class BackupOpenLoop(BackupRecord):
    id: str = Field(min_length=1, max_length=200)
    memory_id: str = Field(min_length=1, max_length=200)
    kind: Literal["goal", "commitment"]
    content: str = Field(min_length=1, max_length=20_000)
    status: OpenLoopStatus
    created_at: datetime
    resolved_at: datetime | None = None
    resolution_message_id: str | None = Field(default=None, max_length=2000)


class BackupResolutionProposal(BackupRecord):
    id: str = Field(min_length=1, max_length=200)
    open_loop_id: str = Field(min_length=1, max_length=200)
    message_id: str = Field(min_length=1, max_length=2000)
    proposed_status: Literal["completed", "cancelled"]
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_text: str = Field(max_length=200_000)
    status: ResolutionProposalStatus
    created_at: datetime
    updated_at: datetime


class MemoryBackupPayload(BackupRecord):
    format: Literal["personal-memory-backup-v1"] = "personal-memory-backup-v1"
    exported_at: datetime
    raw_chat_archive_included: Literal[False] = False
    messages: list[BackupMessage] = Field(default_factory=list, max_length=200_000)
    import_batches: list[BackupImportBatch] = Field(default_factory=list, max_length=100_000)
    imported_messages: list[BackupImportedMessage] = Field(default_factory=list, max_length=500_000)
    memories: list[BackupMemory] = Field(default_factory=list, max_length=100_000)
    evidence: list[BackupEvidence] = Field(default_factory=list, max_length=500_000)
    context_notes: list[BackupContextNote] = Field(default_factory=list, max_length=500_000)
    relations: list[BackupRelation] = Field(default_factory=list, max_length=500_000)
    open_loops: list[BackupOpenLoop] = Field(default_factory=list, max_length=100_000)
    resolution_proposals: list[BackupResolutionProposal] = Field(default_factory=list, max_length=500_000)
    friend_seed_feedback: dict[str, MemoryCalibration] = Field(default_factory=dict)

    @model_validator(mode="after")
    def self_contained_and_unique(self):
        def unique_ids(rows, label: str):
            ids = [row.id for row in rows]
            if len(ids) != len(set(ids)):
                raise ValueError(f"Duplicate {label} id in backup")

        unique_ids(self.messages, "message")
        unique_ids(self.import_batches, "import batch")
        unique_ids(self.imported_messages, "imported message")
        unique_ids(self.memories, "memory")
        unique_ids(self.context_notes, "context note")
        unique_ids(self.relations, "relation")
        unique_ids(self.open_loops, "open loop")
        unique_ids(self.resolution_proposals, "resolution proposal")

        evidence_keys = [
            (row.memory_id, row.source_id, row.evidence_text, row.created_at.isoformat())
            for row in self.evidence
        ]
        if len(evidence_keys) != len(set(evidence_keys)):
            raise ValueError("Duplicate evidence row in backup")

        memory_ids = {row.id for row in self.memories}
        import_batch_ids = {row.id for row in self.import_batches}
        loop_ids = {row.id for row in self.open_loops}
        if any(row.import_id not in import_batch_ids for row in self.imported_messages):
            raise ValueError("Imported message references a missing import batch")
        if any(row.memory_id not in memory_ids for row in self.evidence):
            raise ValueError("Evidence references a missing memory")
        if any(row.memory_id not in memory_ids for row in self.context_notes):
            raise ValueError("Context note references a missing memory")
        context_keys = [(row.memory_id, row.revision) for row in self.context_notes]
        if len(context_keys) != len(set(context_keys)):
            raise ValueError("Duplicate context-note revision in backup")
        if sum(row.status == "active" for row in self.context_notes) > len({row.memory_id for row in self.context_notes if row.status == "active"}):
            raise ValueError("Multiple active context notes for one memory")
        if any(row.source_memory_id not in memory_ids or row.target_memory_id not in memory_ids for row in self.relations):
            raise ValueError("Memory relation references a missing memory")
        if any(row.memory_id not in memory_ids for row in self.open_loops):
            raise ValueError("Open loop references a missing memory")
        if any(row.open_loop_id not in loop_ids for row in self.resolution_proposals):
            raise ValueError("Resolution proposal references a missing open loop")
        if any(memory_id not in memory_ids for memory_id in self.friend_seed_feedback):
            raise ValueError("Friend-seed feedback references a missing memory")
        return self


class MemoryBackupRestoreResponse(BackupRecord):
    inserted: dict[str, int]
    identical_kept: dict[str, int]
    friend_seed_feedback_added: int


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _row_dict(row) -> dict:
    return dict(row)


def _memory_source_identity_is_unique(item: BackupMemory) -> bool:
    """Return whether source_id is itself a one-memory identity.

    Ordinary message/import sources may legitimately yield several distinct
    memories, so sharing their source_id is expected. Friend seeds and the
    explicit source-review flow use stable source IDs as idempotency keys and
    must remain one-to-one.
    """
    return item.source_type == "friend_seed" or bool(
        item.source_id and item.source_id.startswith("source-review:")
    )


class MemoryBackupStore:
    """Versioned, additive backup/restore for the app memory store.

    The separate raw WeChat archive index is intentionally out of scope. Restore
    never overwrites a row with the same identity but different content; any
    conflict aborts the SQLite transaction.
    """

    def __init__(self, db: Database, friend_seed: FriendSeedStore):
        self.db = db
        self.friend_seed = friend_seed

    def export(self) -> MemoryBackupPayload:
        with self.db.connect() as con:
            # Hold SQLite fixed across all table reads and the atomic feedback
            # file read, even in WAL mode. This reserves the writer slot but
            # changes no rows. The resulting payload is a point-in-time snapshot,
            # not a promise that state cannot change after export returns.
            con.execute("BEGIN IMMEDIATE")
            messages = [_row_dict(r) for r in con.execute(
                "SELECT id, role, content, created_at FROM messages ORDER BY created_at, id"
            ).fetchall()]
            import_batches = [_row_dict(r) for r in con.execute(
                "SELECT id, source_name, created_at FROM import_batches ORDER BY created_at, id"
            ).fetchall()]
            imported_messages = [_row_dict(r) for r in con.execute(
                """SELECT id, import_id, source_name, external_id, speaker, content,
                          message_time, dedupe_key, created_at
                   FROM imported_messages ORDER BY created_at, id"""
            ).fetchall()]
            memories = [_row_dict(r) for r in con.execute(
                """SELECT id, type, content, status, confidence, source_type, source_id,
                          importance, created_at, updated_at, evidence_text, subject
                   FROM memories ORDER BY created_at, id"""
            ).fetchall()]
            evidence = [_row_dict(r) for r in con.execute(
                """SELECT memory_id, source_id, evidence_text, created_at
                   FROM memory_evidence ORDER BY memory_id, id"""
            ).fetchall()]
            context_notes = [_row_dict(r) for r in con.execute(
                """SELECT id, memory_id, note, status, revision, created_at
                   FROM memory_context_notes ORDER BY memory_id, revision"""
            ).fetchall()]
            relations = [_row_dict(r) for r in con.execute(
                """SELECT id, source_memory_id, target_memory_id, relation_type, created_at
                   FROM memory_relations ORDER BY created_at, id"""
            ).fetchall()]
            open_loops = [_row_dict(r) for r in con.execute(
                """SELECT id, memory_id, kind, content, status, created_at,
                          resolved_at, resolution_message_id
                   FROM open_loops ORDER BY created_at, id"""
            ).fetchall()]
            proposals = [_row_dict(r) for r in con.execute(
                """SELECT id, open_loop_id, message_id, proposed_status, confidence,
                          evidence_text, status, created_at, updated_at
                   FROM resolution_proposals ORDER BY created_at, id"""
            ).fetchall()]

            feedback = self.friend_seed.load_feedback()

        return MemoryBackupPayload(
            exported_at=datetime.now(timezone.utc),
            messages=messages,
            import_batches=import_batches,
            imported_messages=imported_messages,
            memories=memories,
            evidence=evidence,
            context_notes=context_notes,
            relations=relations,
            open_loops=open_loops,
            resolution_proposals=proposals,
            friend_seed_feedback=feedback,
        )

    @staticmethod
    def _same(existing, expected: dict, fields: tuple[str, ...]) -> bool:
        return all(existing[field] == expected[field] for field in fields)

    @staticmethod
    def _require_same(existing, expected: dict, fields: tuple[str, ...], label: str) -> None:
        if not MemoryBackupStore._same(existing, expected, fields):
            raise ValueError(f"Backup conflicts with an existing {label}; nothing was overwritten")

    def restore(self, backup: MemoryBackupPayload) -> MemoryBackupRestoreResponse:
        current_feedback = self.friend_seed.load_feedback()
        for memory_id, verdict in backup.friend_seed_feedback.items():
            if memory_id in current_feedback and current_feedback[memory_id] != verdict:
                raise ValueError("Backup conflicts with existing friend-seed feedback; nothing was overwritten")
        merged_feedback = {**current_feedback, **backup.friend_seed_feedback}
        feedback_added = len(set(merged_feedback) - set(current_feedback))

        temp_feedback: Path | None = None
        if merged_feedback != current_feedback:
            path = self.friend_seed.feedback_path
            path.parent.mkdir(parents=True, exist_ok=True)
            temp_feedback = path.with_suffix(path.suffix + ".restore.tmp")
            temp_feedback.write_text(
                json.dumps(merged_feedback, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

        inserted = {
            "messages": 0,
            "import_batches": 0,
            "imported_messages": 0,
            "memories": 0,
            "evidence": 0,
            "context_notes": 0,
            "relations": 0,
            "open_loops": 0,
            "resolution_proposals": 0,
        }
        identical = {key: 0 for key in inserted}

        try:
            with self.db.connect() as con:
                con.execute("BEGIN IMMEDIATE")

                for item in backup.messages:
                    expected = {
                        "id": item.id, "role": item.role, "content": item.content,
                        "created_at": _iso(item.created_at),
                    }
                    row = con.execute("SELECT id, role, content, created_at FROM messages WHERE id = ?", (item.id,)).fetchone()
                    if row:
                        self._require_same(row, expected, ("id", "role", "content", "created_at"), "message")
                        identical["messages"] += 1
                    else:
                        con.execute("INSERT INTO messages(id, role, content, created_at) VALUES (?, ?, ?, ?)", tuple(expected[k] for k in ("id", "role", "content", "created_at")))
                        inserted["messages"] += 1

                for item in backup.import_batches:
                    expected = {"id": item.id, "source_name": item.source_name, "created_at": _iso(item.created_at)}
                    row = con.execute("SELECT id, source_name, created_at FROM import_batches WHERE id = ?", (item.id,)).fetchone()
                    if row:
                        self._require_same(row, expected, ("id", "source_name", "created_at"), "import batch")
                        identical["import_batches"] += 1
                    else:
                        con.execute("INSERT INTO import_batches(id, source_name, created_at) VALUES (?, ?, ?)", (item.id, item.source_name, expected["created_at"]))
                        inserted["import_batches"] += 1

                for item in backup.imported_messages:
                    expected = {
                        "id": item.id, "import_id": item.import_id, "source_name": item.source_name,
                        "external_id": item.external_id, "speaker": item.speaker, "content": item.content,
                        "message_time": _iso(item.message_time), "dedupe_key": item.dedupe_key,
                        "created_at": _iso(item.created_at),
                    }
                    row = con.execute("SELECT * FROM imported_messages WHERE id = ?", (item.id,)).fetchone()
                    duplicate = con.execute(
                        "SELECT id FROM imported_messages WHERE source_name = ? AND dedupe_key = ? AND id != ?",
                        (item.source_name, item.dedupe_key, item.id),
                    ).fetchone()
                    if duplicate:
                        raise ValueError("Backup conflicts with an existing imported-message identity; nothing was overwritten")
                    fields = ("id", "import_id", "source_name", "external_id", "speaker", "content", "message_time", "dedupe_key", "created_at")
                    if row:
                        self._require_same(row, expected, fields, "imported message")
                        identical["imported_messages"] += 1
                    else:
                        con.execute(
                            """INSERT INTO imported_messages(id, import_id, source_name, external_id, speaker, content,
                                      message_time, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            tuple(expected[k] for k in fields),
                        )
                        inserted["imported_messages"] += 1

                for item in backup.memories:
                    expected = {
                        "id": item.id, "type": item.type, "content": item.content, "status": item.status,
                        "confidence": item.confidence, "source_type": item.source_type, "source_id": item.source_id,
                        "importance": item.importance, "created_at": _iso(item.created_at), "updated_at": _iso(item.updated_at),
                        "evidence_text": item.evidence_text, "subject": item.subject,
                    }
                    row = con.execute("SELECT * FROM memories WHERE id = ?", (item.id,)).fetchone()
                    fingerprint = _fingerprint(item.type, item.content)
                    if item.source_id and _memory_source_identity_is_unique(item):
                        source_conflict = con.execute(
                            "SELECT id FROM memories WHERE source_id = ? AND id != ? LIMIT 1",
                            (item.source_id, item.id),
                        ).fetchone()
                        if source_conflict:
                            raise ValueError("Backup conflicts with an existing memory source identity; nothing was overwritten")
                    if item.status in {"unconfirmed", "confirmed"}:
                        active_conflict = con.execute(
                            "SELECT id FROM memories WHERE fingerprint = ? AND status IN ('unconfirmed', 'confirmed') AND id != ? LIMIT 1",
                            (fingerprint, item.id),
                        ).fetchone()
                        if active_conflict:
                            raise ValueError("Backup conflicts with an existing active memory identity; nothing was overwritten")
                    fields = ("id", "type", "content", "status", "confidence", "source_type", "source_id", "importance", "created_at", "updated_at", "evidence_text", "subject")
                    if row:
                        self._require_same(row, expected, fields, "memory")
                        identical["memories"] += 1
                    else:
                        con.execute(
                            """INSERT INTO memories(id, type, content, status, confidence, confidence_label,
                                      source_type, source_id, importance, created_at, updated_at, evidence_text,
                                      subject, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            (
                                item.id, item.type, item.content, item.status, item.confidence,
                                confidence_label(item.confidence, item.status), item.source_type, item.source_id,
                                item.importance, expected["created_at"], expected["updated_at"], item.evidence_text,
                                item.subject, fingerprint,
                            ),
                        )
                        self.db._fts_upsert(con, item.id, item.content, item.type)
                        inserted["memories"] += 1

                for item in backup.evidence:
                    created_at = _iso(item.created_at)
                    row = con.execute(
                        """SELECT 1 FROM memory_evidence
                           WHERE memory_id = ? AND source_id IS ? AND evidence_text = ? AND created_at = ? LIMIT 1""",
                        (item.memory_id, item.source_id, item.evidence_text, created_at),
                    ).fetchone()
                    if row:
                        identical["evidence"] += 1
                    else:
                        con.execute(
                            "INSERT INTO memory_evidence(memory_id, source_id, evidence_text, created_at) VALUES (?, ?, ?, ?)",
                            (item.memory_id, item.source_id, item.evidence_text, created_at),
                        )
                        inserted["evidence"] += 1

                for item in backup.context_notes:
                    expected = {
                        "id": item.id, "memory_id": item.memory_id, "note": item.note,
                        "status": item.status, "revision": item.revision, "created_at": _iso(item.created_at),
                    }
                    row = con.execute("SELECT * FROM memory_context_notes WHERE id = ?", (item.id,)).fetchone()
                    duplicate_revision = con.execute(
                        "SELECT id FROM memory_context_notes WHERE memory_id = ? AND revision = ? AND id != ?",
                        (item.memory_id, item.revision, item.id),
                    ).fetchone()
                    if duplicate_revision:
                        raise ValueError("Backup conflicts with an existing context-note revision; nothing was overwritten")
                    active_conflict = con.execute(
                        "SELECT id FROM memory_context_notes WHERE memory_id = ? AND status = 'active' AND id != ?",
                        (item.memory_id, item.id),
                    ).fetchone() if item.status == "active" else None
                    if active_conflict:
                        raise ValueError("Backup conflicts with an existing active context note; nothing was overwritten")
                    fields = ("id", "memory_id", "note", "status", "revision", "created_at")
                    if row:
                        self._require_same(row, expected, fields, "context note")
                        identical["context_notes"] += 1
                    else:
                        con.execute(
                            "INSERT INTO memory_context_notes(id, memory_id, note, status, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                            tuple(expected[k] for k in fields),
                        )
                        inserted["context_notes"] += 1

                for item in backup.relations:
                    expected = {
                        "id": item.id, "source_memory_id": item.source_memory_id,
                        "target_memory_id": item.target_memory_id, "relation_type": item.relation_type,
                        "created_at": _iso(item.created_at),
                    }
                    row = con.execute("SELECT * FROM memory_relations WHERE id = ?", (item.id,)).fetchone()
                    duplicate = con.execute(
                        """SELECT id FROM memory_relations
                           WHERE source_memory_id = ? AND target_memory_id = ? AND relation_type = ? AND id != ?""",
                        (item.source_memory_id, item.target_memory_id, item.relation_type, item.id),
                    ).fetchone()
                    if duplicate:
                        raise ValueError("Backup conflicts with an existing memory relation identity; nothing was overwritten")
                    fields = ("id", "source_memory_id", "target_memory_id", "relation_type", "created_at")
                    if row:
                        self._require_same(row, expected, fields, "memory relation")
                        identical["relations"] += 1
                    else:
                        con.execute(
                            """INSERT INTO memory_relations(id, source_memory_id, target_memory_id, relation_type, created_at)
                               VALUES (?, ?, ?, ?, ?)""",
                            tuple(expected[k] for k in fields),
                        )
                        inserted["relations"] += 1

                for item in backup.open_loops:
                    expected = {
                        "id": item.id, "memory_id": item.memory_id, "kind": item.kind, "content": item.content,
                        "status": item.status, "created_at": _iso(item.created_at), "resolved_at": _iso(item.resolved_at),
                        "resolution_message_id": item.resolution_message_id,
                    }
                    row = con.execute("SELECT * FROM open_loops WHERE id = ?", (item.id,)).fetchone()
                    duplicate = con.execute("SELECT id FROM open_loops WHERE memory_id = ? AND id != ?", (item.memory_id, item.id)).fetchone()
                    if duplicate:
                        raise ValueError("Backup conflicts with an existing open-loop identity; nothing was overwritten")
                    fields = ("id", "memory_id", "kind", "content", "status", "created_at", "resolved_at", "resolution_message_id")
                    if row:
                        self._require_same(row, expected, fields, "open loop")
                        identical["open_loops"] += 1
                    else:
                        con.execute(
                            """INSERT INTO open_loops(id, memory_id, kind, content, status, created_at,
                                      resolved_at, resolution_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                            tuple(expected[k] for k in fields),
                        )
                        inserted["open_loops"] += 1

                for item in backup.resolution_proposals:
                    expected = {
                        "id": item.id, "open_loop_id": item.open_loop_id, "message_id": item.message_id,
                        "proposed_status": item.proposed_status, "confidence": item.confidence,
                        "evidence_text": item.evidence_text, "status": item.status,
                        "created_at": _iso(item.created_at), "updated_at": _iso(item.updated_at),
                    }
                    row = con.execute("SELECT * FROM resolution_proposals WHERE id = ?", (item.id,)).fetchone()
                    duplicate = con.execute(
                        """SELECT id FROM resolution_proposals
                           WHERE open_loop_id = ? AND message_id = ? AND proposed_status = ? AND id != ?""",
                        (item.open_loop_id, item.message_id, item.proposed_status, item.id),
                    ).fetchone()
                    if duplicate:
                        raise ValueError("Backup conflicts with an existing resolution-proposal identity; nothing was overwritten")
                    fields = ("id", "open_loop_id", "message_id", "proposed_status", "confidence", "evidence_text", "status", "created_at", "updated_at")
                    if row:
                        self._require_same(row, expected, fields, "resolution proposal")
                        identical["resolution_proposals"] += 1
                    else:
                        con.execute(
                            """INSERT INTO resolution_proposals(id, open_loop_id, message_id, proposed_status,
                                      confidence, evidence_text, status, created_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            tuple(expected[k] for k in fields),
                        )
                        inserted["resolution_proposals"] += 1

                if temp_feedback is not None:
                    if self.friend_seed.load_feedback() != current_feedback:
                        raise ValueError("Friend-seed feedback changed in another process; retry the restore")
                    temp_feedback.replace(self.friend_seed.feedback_path)
        finally:
            if temp_feedback is not None and temp_feedback.exists():
                temp_feedback.unlink()

        return MemoryBackupRestoreResponse(
            inserted=inserted,
            identical_kept=identical,
            friend_seed_feedback_added=feedback_added,
        )
