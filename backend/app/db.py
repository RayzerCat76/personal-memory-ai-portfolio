from __future__ import annotations

import re
import sqlite3
import uuid
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from pathlib import Path

from .schemas import (
    MemoryCandidate,
    MemoryContextNoteRead,
    MemoryEvidenceRead,
    MemoryRead,
    OpenLoopRead,
    ResolutionCandidate,
    ResolutionProposalRead,
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def confidence_label(score: float, status: str) -> str:
    if status == "confirmed":
        return "CONFIRMED"
    if status == "rejected":
        return "REJECTED"
    if status == "superseded":
        return "SUPERSEDED"
    if score >= 0.85:
        return "HIGH CONFIDENCE"
    if score >= 0.6:
        return "TENTATIVE"
    return "UNCONFIRMED"


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialise()

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.path)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        try:
            yield con
            con.commit()
        finally:
            con.close()

    def initialise(self) -> None:
        with self.connect() as con:
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    confidence_label TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_id TEXT,
                    importance REAL NOT NULL DEFAULT 0.5,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    evidence_text TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_memories_status
                    ON memories(status);
                CREATE INDEX IF NOT EXISTS idx_memories_type
                    ON memories(type);

                CREATE TABLE IF NOT EXISTS memory_evidence (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                    source_id TEXT,
                    evidence_text TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS memory_context_notes (
                    id TEXT PRIMARY KEY,
                    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                    note TEXT,
                    status TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(memory_id, revision)
                );

                CREATE INDEX IF NOT EXISTS idx_memory_context_notes_memory
                    ON memory_context_notes(memory_id, revision DESC);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_context_notes_active
                    ON memory_context_notes(memory_id) WHERE status = 'active';

                CREATE TABLE IF NOT EXISTS memory_relations (
                    id TEXT PRIMARY KEY,
                    source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                    target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                    relation_type TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(source_memory_id, target_memory_id, relation_type)
                );

                CREATE TABLE IF NOT EXISTS open_loops (
                    id TEXT PRIMARY KEY,
                    memory_id TEXT NOT NULL UNIQUE REFERENCES memories(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT,
                    resolution_message_id TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_open_loops_status
                    ON open_loops(status);

                CREATE TABLE IF NOT EXISTS resolution_proposals (
                    id TEXT PRIMARY KEY,
                    open_loop_id TEXT NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE,
                    message_id TEXT NOT NULL,
                    proposed_status TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    evidence_text TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(open_loop_id, message_id, proposed_status)
                );
                """
            )
            self._ensure_column(con, "memories", "subject", "TEXT")
            self._ensure_column(con, "memories", "fingerprint", "TEXT")
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_memories_fingerprint ON memories(fingerprint)"
            )
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject)"
            )
            try:
                con.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                        memory_id UNINDEXED,
                        content,
                        type
                    )
                    """
                )
            except sqlite3.OperationalError:
                pass

            # Backfill evidence/fingerprints for databases created by Step 5.
            rows = con.execute("SELECT * FROM memories").fetchall()
            for row in rows:
                # Rebuild older ASCII-only identities from retained content.
                # This cannot reconstruct facts already merged by an old key.
                fingerprint = _fingerprint(row["type"], row["content"])
                if row["fingerprint"] != fingerprint:
                    con.execute(
                        "UPDATE memories SET fingerprint = ? WHERE id = ?",
                        (fingerprint, row["id"]),
                    )
                if _chinese_tokens(row["content"]):
                    self._fts_upsert(con, row["id"], row["content"], row["type"])
                count = con.execute(
                    "SELECT COUNT(*) FROM memory_evidence WHERE memory_id = ?",
                    (row["id"],),
                ).fetchone()[0]
                if count == 0 and row["evidence_text"]:
                    con.execute(
                        """
                        INSERT INTO memory_evidence(memory_id, source_id, evidence_text, created_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (row["id"], row["source_id"], row["evidence_text"], row["created_at"]),
                    )

    @staticmethod
    def _ensure_column(con: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        columns = {row["name"] for row in con.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def add_message(self, role: str, content: str, *, connection: sqlite3.Connection | None = None) -> str:
        message_id = f"msg_{uuid.uuid4().hex}"
        with self.connect() if connection is None else nullcontext(connection) as con:
            con.execute(
                "INSERT INTO messages(id, role, content, created_at) VALUES (?, ?, ?, ?)",
                (message_id, role, content, utc_now_iso()),
            )
        return message_id

    def add_candidate(self, candidate: MemoryCandidate, source_id: str, evidence: str, *, seed_once: bool = False, source_review: bool = False, connection: sqlite3.Connection | None = None) -> MemoryRead | None:
        if connection is not None and (seed_once or source_review):
            raise ValueError("Seed and source-review modes manage their own transactions")
        fingerprint = _fingerprint(candidate.type, candidate.content)
        now = utc_now_iso()

        with self.connect() if connection is None else nullcontext(connection) as con:
            if source_review:
                if seed_once or candidate.source_type != "conversation_import":
                    raise ValueError("Invalid source review mode")
                con.execute("BEGIN IMMEDIATE")
                previous = con.execute("SELECT id, content, type, evidence_text FROM memories WHERE source_id = ? LIMIT 1", (source_id,)).fetchone()
                if previous:
                    if (previous["content"] != candidate.content or previous["type"] != candidate.type
                            or previous["evidence_text"] != evidence):
                        raise ValueError("This source already has different wording, category or evidence; review the existing memory")
                    return self.get_memory(previous["id"])
            # Serialize the seed existence check and insert across requests/processes.
            if seed_once:
                if candidate.source_type != "friend_seed":
                    raise ValueError("seed_once is only supported for friend seeds")
                con.execute("BEGIN IMMEDIATE")
                if con.execute("SELECT id FROM memories WHERE source_id = ? LIMIT 1", (source_id,)).fetchone():
                    return None
            existing = con.execute(
                """
                SELECT id FROM memories
                WHERE fingerprint = ? AND status IN ('unconfirmed', 'confirmed')
                ORDER BY created_at ASC LIMIT 1
                """,
                (fingerprint,),
            ).fetchone()
            if existing is not None:
                if source_review:
                    raise ValueError("This memory already exists; review the existing memory")
                if seed_once:
                    return None
                memory_id = existing["id"]
                con.execute(
                    """
                    INSERT INTO memory_evidence(memory_id, source_id, evidence_text, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (memory_id, source_id, evidence, now),
                )
                con.execute(
                    """
                    UPDATE memories
                    SET confidence = MAX(confidence, ?),
                        importance = MAX(importance, ?),
                        updated_at = ?,
                        evidence_text = ?
                    WHERE id = ?
                    """,
                    (candidate.confidence, candidate.importance, now, evidence, memory_id),
                )
            else:
                memory_id = f"mem_{uuid.uuid4().hex}"
                status = "unconfirmed"
                label = confidence_label(candidate.confidence, status)
                con.execute(
                    """
                    INSERT INTO memories(
                        id, type, content, status, confidence, confidence_label,
                        source_type, source_id, importance, created_at, updated_at,
                        evidence_text, subject, fingerprint
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        memory_id,
                        candidate.type,
                        candidate.content,
                        status,
                        candidate.confidence,
                        label,
                        candidate.source_type,
                        source_id,
                        candidate.importance,
                        now,
                        now,
                        evidence,
                        candidate.subject,
                        fingerprint,
                    ),
                )
                con.execute(
                    """
                    INSERT INTO memory_evidence(memory_id, source_id, evidence_text, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (memory_id, source_id, evidence, now),
                )
                self._fts_upsert(con, memory_id, candidate.content, candidate.type)

        return self.get_memory(memory_id, connection=connection)

    def _fts_upsert(self, con: sqlite3.Connection, memory_id: str, content: str, memory_type: str) -> None:
        chinese_tokens = _chinese_tokens(content)
        indexed_content = " ".join([content, *chinese_tokens]) if chinese_tokens else content
        try:
            con.execute("DELETE FROM memory_fts WHERE memory_id = ?", (memory_id,))
            con.execute(
                "INSERT INTO memory_fts(memory_id, content, type) VALUES (?, ?, ?)",
                (memory_id, indexed_content, memory_type),
            )
        except sqlite3.OperationalError:
            pass

    def get_memory(self, memory_id: str, *, connection: sqlite3.Connection | None = None) -> MemoryRead:
        with self.connect() if connection is None else nullcontext(connection) as con:
            row = con.execute(
                """
                SELECT m.*,
                       (SELECT COUNT(*) FROM memory_evidence e WHERE e.memory_id = m.id) AS evidence_count,
                       (SELECT c.note FROM memory_context_notes c WHERE c.memory_id = m.id AND c.status = 'active' ORDER BY c.revision DESC LIMIT 1) AS active_context_note,
                       COALESCE((SELECT MAX(c.revision) FROM memory_context_notes c WHERE c.memory_id = m.id), 0) AS context_revision
                FROM memories m WHERE m.id = ?
                """,
                (memory_id,),
            ).fetchone()
        if row is None:
            raise KeyError(memory_id)
        return self._to_memory(row)

    def get_memory_evidence(self, memory_id: str) -> list[MemoryEvidenceRead]:
        with self.connect() as con:
            rows = con.execute(
                """SELECT source_id, evidence_text, created_at
                   FROM memory_evidence WHERE memory_id = ? ORDER BY id""",
                (memory_id,),
            ).fetchall()
        return [MemoryEvidenceRead.model_validate(dict(row)) for row in rows]

    def get_memory_context(self, memory_id: str) -> tuple[MemoryContextNoteRead | None, int, list[MemoryContextNoteRead]]:
        self.get_memory(memory_id)
        with self.connect() as con:
            rows = con.execute(
                "SELECT id, memory_id, note, status, revision, created_at FROM memory_context_notes WHERE memory_id = ? ORDER BY revision DESC",
                (memory_id,),
            ).fetchall()
        history = [MemoryContextNoteRead.model_validate(dict(row)) for row in rows]
        active = next((item for item in history if item.status == "active"), None)
        return active, (history[0].revision if history else 0), history

    def set_memory_context(self, memory_id: str, note: str, expected_revision: int) -> tuple[MemoryContextNoteRead | None, int, list[MemoryContextNoteRead]]:
        note = note.strip()
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            memory = con.execute("SELECT id, status FROM memories WHERE id = ?", (memory_id,)).fetchone()
            if memory is None:
                raise KeyError(memory_id)
            if memory["status"] not in {"unconfirmed", "confirmed"}:
                raise ValueError("Context notes are only editable for active or awaiting-review memories")
            head = con.execute(
                "SELECT revision FROM memory_context_notes WHERE memory_id = ? ORDER BY revision DESC LIMIT 1",
                (memory_id,),
            ).fetchone()
            current_revision = int(head["revision"]) if head else 0
            if expected_revision != current_revision:
                raise ValueError("Context note changed; refresh before saving")
            con.execute(
                "UPDATE memory_context_notes SET status = 'superseded' WHERE memory_id = ? AND status = 'active'",
                (memory_id,),
            )
            revision = current_revision + 1
            status = "active" if note else "cleared"
            con.execute(
                "INSERT INTO memory_context_notes(id, memory_id, note, status, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (f"ctx_{uuid.uuid4().hex}", memory_id, note or None, status, revision, utc_now_iso()),
            )
        return self.get_memory_context(memory_id)

    def list_memories(self, status: str | None = None, limit: int = 100) -> list[MemoryRead]:
        base = """
            SELECT m.*,
                   (SELECT COUNT(*) FROM memory_evidence e WHERE e.memory_id = m.id) AS evidence_count,
                   (SELECT c.note FROM memory_context_notes c WHERE c.memory_id = m.id AND c.status = 'active' ORDER BY c.revision DESC LIMIT 1) AS active_context_note,
                   COALESCE((SELECT MAX(c.revision) FROM memory_context_notes c WHERE c.memory_id = m.id), 0) AS context_revision
            FROM memories m
        """
        with self.connect() as con:
            if status:
                rows = con.execute(
                    base + " WHERE m.status = ? ORDER BY m.created_at DESC LIMIT ?",
                    (status, limit),
                ).fetchall()
            else:
                rows = con.execute(
                    base + " ORDER BY m.created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        return [self._to_memory(r) for r in rows]

    def correct_memory(self, memory_id: str, content: str, original_content: str, *, memory_type: str | None = None, original_type: str | None = None) -> MemoryRead:
        content = content.strip()
        if not content:
            raise ValueError("Correction cannot be blank")
        if (memory_type is None) != (original_type is None):
            raise ValueError("Category corrections require both type and original_type")
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
            if row is None:
                raise KeyError(memory_id)
            if row["status"] != "unconfirmed" or row["content"] != original_content:
                raise ValueError("Memory changed or is no longer awaiting review; refresh before editing")
            if original_type is not None and row["type"] != original_type:
                raise ValueError("Memory category changed; refresh before editing")
            corrected_type = memory_type if memory_type is not None else row["type"]
            fingerprint = _fingerprint(corrected_type, content)
            duplicate = con.execute(
                "SELECT id FROM memories WHERE fingerprint = ? AND id != ? AND status IN ('unconfirmed', 'confirmed')",
                (fingerprint, memory_id),
            ).fetchone()
            if duplicate:
                raise ValueError("Another memory already has this wording; review that memory instead")
            con.execute("UPDATE memories SET type = ?, content = ?, fingerprint = ?, updated_at = ? WHERE id = ?",
                        (corrected_type, content, fingerprint, utc_now_iso(), memory_id))
            self._fts_upsert(con, memory_id, content, corrected_type)
        return self.get_memory(memory_id)

    def set_status(self, memory_id: str, status: str) -> MemoryRead:
        memory = self.get_memory(memory_id)
        label = confidence_label(memory.confidence, status)
        with self.connect() as con:
            con.execute(
                "UPDATE memories SET status = ?, confidence_label = ?, updated_at = ? WHERE id = ?",
                (status, label, utc_now_iso(), memory_id),
            )

        if status == "confirmed":
            current = self.get_memory(memory_id)
            if current.type in {"goal", "commitment"}:
                self.ensure_open_loop(current)
            self._apply_supersession(current)

        return self.get_memory(memory_id)

    def ensure_open_loop(self, memory: MemoryRead) -> OpenLoopRead:
        if memory.type not in {"goal", "commitment"}:
            raise ValueError("Only goals and commitments can become open loops")
        with self.connect() as con:
            row = con.execute(
                "SELECT * FROM open_loops WHERE memory_id = ?",
                (memory.id,),
            ).fetchone()
            if row is None:
                # Deterministic for peer replicas: independently confirming the same
                # memory must not create two different loop identities. Existing
                # legacy loop IDs remain untouched because the row lookup wins first.
                loop_id = f"loop_{memory.id}"
                con.execute(
                    """
                    INSERT INTO open_loops(id, memory_id, kind, content, status, created_at)
                    VALUES (?, ?, ?, ?, 'active', ?)
                    """,
                    (loop_id, memory.id, memory.type, memory.content, utc_now_iso()),
                )
            else:
                loop_id = row["id"]
        return self.get_open_loop(loop_id)

    def get_open_loop(self, loop_id: str) -> OpenLoopRead:
        with self.connect() as con:
            row = con.execute("SELECT * FROM open_loops WHERE id = ?", (loop_id,)).fetchone()
        if row is None:
            raise KeyError(loop_id)
        return self._to_open_loop(row)

    def list_open_loops(self, status: str = "active", limit: int = 100) -> list[OpenLoopRead]:
        with self.connect() as con:
            rows = con.execute(
                "SELECT * FROM open_loops WHERE status = ? ORDER BY created_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        return [self._to_open_loop(r) for r in rows]

    def set_open_loop_status(
        self,
        loop_id: str,
        status: str,
        resolution_message_id: str | None = None,
    ) -> OpenLoopRead:
        self.get_open_loop(loop_id)
        resolved_at = utc_now_iso() if status in {"completed", "cancelled"} else None
        with self.connect() as con:
            con.execute(
                """
                UPDATE open_loops
                SET status = ?, resolved_at = ?, resolution_message_id = ?
                WHERE id = ?
                """,
                (status, resolved_at, resolution_message_id, loop_id),
            )
        return self.get_open_loop(loop_id)

    def propose_resolutions(
        self,
        message_id: str,
        evidence: str,
        candidates: list[ResolutionCandidate],
        *,
        connection: sqlite3.Connection | None = None,
    ) -> list[ResolutionProposalRead]:
        active = self.list_open_loops(status="active", limit=200)
        proposals: list[ResolutionProposalRead] = []

        for candidate in candidates:
            best_loop: OpenLoopRead | None = None
            best_similarity = 0.0
            for loop in active:
                similarity = _action_similarity(candidate.target_text, loop.content)
                if similarity > best_similarity:
                    best_similarity = similarity
                    best_loop = loop

            if best_loop is None or best_similarity < 0.45:
                continue

            confidence = min(0.99, candidate.confidence * (0.55 + 0.45 * best_similarity))
            proposal = self._add_resolution_proposal(
                best_loop.id,
                message_id,
                candidate.proposed_status,
                confidence,
                evidence,
                connection=connection,
            )
            proposals.append(proposal)

        return proposals

    def _add_resolution_proposal(
        self,
        loop_id: str,
        message_id: str,
        proposed_status: str,
        confidence: float,
        evidence: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> ResolutionProposalRead:
        now = utc_now_iso()
        with self.connect() if connection is None else nullcontext(connection) as con:
            row = con.execute(
                """
                SELECT id FROM resolution_proposals
                WHERE open_loop_id = ? AND message_id = ? AND proposed_status = ?
                """,
                (loop_id, message_id, proposed_status),
            ).fetchone()
            if row is None:
                proposal_id = f"res_{uuid.uuid4().hex}"
                con.execute(
                    """
                    INSERT INTO resolution_proposals(
                        id, open_loop_id, message_id, proposed_status, confidence,
                        evidence_text, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                    """,
                    (
                        proposal_id,
                        loop_id,
                        message_id,
                        proposed_status,
                        confidence,
                        evidence,
                        now,
                        now,
                    ),
                )
            else:
                proposal_id = row["id"]
        return self.get_resolution_proposal(proposal_id, connection=connection)

    def get_resolution_proposal(self, proposal_id: str, *, connection: sqlite3.Connection | None = None) -> ResolutionProposalRead:
        with self.connect() if connection is None else nullcontext(connection) as con:
            row = con.execute(
                "SELECT * FROM resolution_proposals WHERE id = ?",
                (proposal_id,),
            ).fetchone()
        if row is None:
            raise KeyError(proposal_id)
        return self._to_resolution_proposal(row)

    def resolve_proposal(self, proposal_id: str, accept: bool) -> tuple[ResolutionProposalRead, OpenLoopRead | None]:
        proposal = self.get_resolution_proposal(proposal_id)
        if proposal.status != "pending":
            loop = self.get_open_loop(proposal.open_loop_id) if proposal.status == "accepted" else None
            return proposal, loop

        new_status = "accepted" if accept else "rejected"
        with self.connect() as con:
            con.execute(
                "UPDATE resolution_proposals SET status = ?, updated_at = ? WHERE id = ?",
                (new_status, utc_now_iso(), proposal_id),
            )

        loop = None
        if accept:
            loop = self.set_open_loop_status(
                proposal.open_loop_id,
                proposal.proposed_status,
                resolution_message_id=proposal.message_id,
            )
        return self.get_resolution_proposal(proposal_id), loop

    def _apply_supersession(self, new_memory: MemoryRead) -> None:
        if not new_memory.subject:
            return

        if new_memory.type == "decision":
            target_types = ("goal", "commitment")
        elif new_memory.type in {"preference", "interest"}:
            target_types = ("preference", "interest")
        else:
            return

        placeholders = ",".join("?" for _ in target_types)
        with self.connect() as con:
            rows = con.execute(
                f"""
                SELECT id, content FROM memories
                WHERE id != ? AND subject = ? AND status = 'confirmed'
                  AND type IN ({placeholders})
                """,
                (new_memory.id, new_memory.subject, *target_types),
            ).fetchall()

            for row in rows:
                if _canonical(row["content"]) == _canonical(new_memory.content):
                    continue
                con.execute(
                    """
                    UPDATE memories
                    SET status = 'superseded', confidence_label = 'SUPERSEDED', updated_at = ?
                    WHERE id = ?
                    """,
                    (utc_now_iso(), row["id"]),
                )
                try:
                    con.execute(
                        """
                        INSERT INTO memory_relations(
                            id, source_memory_id, target_memory_id, relation_type, created_at
                        ) VALUES (?, ?, ?, 'supersedes', ?)
                        """,
                        (f"rel_{uuid.uuid4().hex}", new_memory.id, row["id"], utc_now_iso()),
                    )
                except sqlite3.IntegrityError:
                    pass
                loop = con.execute(
                    "SELECT id FROM open_loops WHERE memory_id = ? AND status = 'active'",
                    (row["id"],),
                ).fetchone()
                if loop is not None:
                    con.execute(
                        """
                        UPDATE open_loops
                        SET status = 'completed', resolved_at = ?, resolution_message_id = ?
                        WHERE id = ?
                        """,
                        (utc_now_iso(), new_memory.source_id, loop["id"]),
                    )

    def search_confirmed(self, query: str, limit: int = 6) -> list[MemoryRead]:
        query = query.strip()
        if not query:
            return []
        q = set(_tokens(query))
        if not q:
            return []
        memories = self.list_memories(status="confirmed", limit=5000)
        scored: list[tuple[float, MemoryRead]] = []
        for memory in memories:
            content_tokens = set(_tokens(memory.content))
            context_tokens = set(_tokens(memory.active_context_note or ""))
            content_overlap = len(q & content_tokens) / max(1, len(q))
            context_overlap = len(q & context_tokens) / max(1, len(q))
            if content_overlap <= 0 and context_overlap <= 0:
                continue
            score = (
                content_overlap
                + 0.75 * context_overlap
                + 0.15 * memory.importance
                + 0.1 * memory.confidence
                + min(0.08, 0.02 * max(0, memory.evidence_count - 1))
            )
            scored.append((score, memory))
        scored.sort(key=lambda pair: (pair[0], pair[1].importance, pair[1].created_at), reverse=True)
        return [memory for _, memory in scored[:limit]]

    @staticmethod
    def _to_memory(row: sqlite3.Row) -> MemoryRead:
        keys = set(row.keys())
        return MemoryRead(
            id=row["id"],
            type=row["type"],
            content=row["content"],
            status=row["status"],
            confidence=row["confidence"],
            confidence_label=row["confidence_label"],
            source_type=row["source_type"],
            source_id=row["source_id"],
            importance=row["importance"],
            subject=row["subject"] if "subject" in keys else None,
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
            evidence_text=row["evidence_text"],
            evidence_count=row["evidence_count"] if "evidence_count" in keys else 1,
            active_context_note=row["active_context_note"] if "active_context_note" in keys else None,
            context_revision=int(row["context_revision"]) if "context_revision" in keys else 0,
        )

    @staticmethod
    def _to_open_loop(row: sqlite3.Row) -> OpenLoopRead:
        return OpenLoopRead(
            id=row["id"],
            memory_id=row["memory_id"],
            kind=row["kind"],
            content=row["content"],
            status=row["status"],
            created_at=datetime.fromisoformat(row["created_at"]),
            resolved_at=datetime.fromisoformat(row["resolved_at"]) if row["resolved_at"] else None,
            resolution_message_id=row["resolution_message_id"],
        )

    @staticmethod
    def _to_resolution_proposal(row: sqlite3.Row) -> ResolutionProposalRead:
        return ResolutionProposalRead(
            id=row["id"],
            open_loop_id=row["open_loop_id"],
            message_id=row["message_id"],
            proposed_status=row["proposed_status"],
            confidence=row["confidence"],
            evidence_text=row["evidence_text"],
            status=row["status"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )


def _fingerprint(memory_type: str, content: str) -> str:
    return f"{memory_type}:{_canonical(content)}"


def _canonical(value: str) -> str:
    # Identity must retain Unicode words, including Chinese negation. Search
    # tokenization is deliberately separate from duplicate detection.
    return " ".join(re.findall(r"[^\W_]+", value.lower()))


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower()) + _chinese_tokens(text)


def _chinese_tokens(text: str) -> list[str]:
    tokens = []
    for run in re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]+", text):
        tokens.extend(run[i:i + 2] for i in range(len(run) - 1))
        if len(run) == 1:
            tokens.append(run)
    return list(dict.fromkeys(tokens))


def _action_tokens(text: str) -> set[str]:
    replacements = {
        "sent": "send",
        "sending": "send",
        "finished": "finish",
        "completed": "finish",
        "completing": "finish",
        "submitted": "submit",
        "emailed": "email",
        "called": "call",
        "booked": "book",
        "paid": "pay",
        "bought": "buy",
    }
    stop = {
        "i", "a", "an", "the", "to", "my", "our", "your", "their",
        "plans", "plan", "planning", "wants", "want", "considering",
        "going", "need", "needs", "have", "has", "am", "is", "was",
    }
    out: set[str] = set()
    # Keep action matching's existing English grammar separate from Chinese
    # search overlap, which is not proof that a task was completed.
    for token in re.findall(r"[a-z0-9]+", text.lower()):
        token = replacements.get(token, token)
        if token not in stop:
            out.add(token)
    return out


def _action_similarity(left: str, right: str) -> float:
    a = _action_tokens(left)
    b = _action_tokens(right)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)
