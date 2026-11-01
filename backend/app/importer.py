from __future__ import annotations

import hashlib
import sqlite3
import uuid
from datetime import datetime, timezone

from .db import Database
from .schemas import ImportMessage, ImportMessagesRequest, ImportMessagesResponse, MemoryRead


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalise_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


def _dedupe_key(message: ImportMessage) -> str:
    raw = "\x1f".join(
        [
            message.external_id or "",
            _normalise_name(message.speaker),
            message.timestamp.isoformat() if message.timestamp else "",
            " ".join(message.content.split()),
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class ChatHistoryImporter:
    """Stores raw imported chat history and extracts only the subject's messages.

    All participants' messages are preserved for future conversational context,
    but only messages authored by a configured subject speaker are allowed to
    create memories about the owner. This prevents a friend's guesses or jokes
    from silently becoming first-person facts.
    """

    def __init__(self, db: Database, extract_candidates):
        self.db = db
        self.extract_candidates = extract_candidates
        self._initialise()

    def _initialise(self) -> None:
        with self.db.connect() as con:
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS import_batches (
                    id TEXT PRIMARY KEY,
                    source_name TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS imported_messages (
                    id TEXT PRIMARY KEY,
                    import_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
                    source_name TEXT NOT NULL,
                    external_id TEXT,
                    speaker TEXT NOT NULL,
                    content TEXT NOT NULL,
                    message_time TEXT,
                    dedupe_key TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(source_name, dedupe_key)
                );

                CREATE INDEX IF NOT EXISTS idx_imported_messages_speaker
                    ON imported_messages(speaker);
                CREATE INDEX IF NOT EXISTS idx_imported_messages_time
                    ON imported_messages(message_time);
                """
            )

    def import_messages(self, request: ImportMessagesRequest) -> ImportMessagesResponse:
        import_id = f"imp_{uuid.uuid4().hex}"
        with self.db.connect() as con:
            con.execute(
                "INSERT INTO import_batches(id, source_name, created_at) VALUES (?, ?, ?)",
                (import_id, request.source_name, _utc_now_iso()),
            )

        subject_names = {_normalise_name(name) for name in request.subject_speakers}
        stored_count = 0
        skipped_duplicates = 0
        subject_processed = 0
        stored_memories: dict[str, MemoryRead] = {}

        for message in request.messages:
            # Infer before recording the dedupe marker: failed extraction must
            # remain eligible for retry. Already stored messages need no inference.
            with self.db.connect() as con:
                exists = con.execute(
                    "SELECT 1 FROM imported_messages WHERE source_name = ? AND dedupe_key = ?",
                    (request.source_name, _dedupe_key(message)),
                ).fetchone()
            if exists:
                skipped_duplicates += 1
                continue
            is_subject = _normalise_name(message.speaker) in subject_names
            candidates = self.extract_candidates(message.content) if is_subject else []
            message_memories = []
            with self.db.connect() as con:
                # Recheck deduplication under the write lock after inference.
                # Commit the source, proposals, evidence and FTS rows together.
                con.execute("BEGIN IMMEDIATE")
                message_id, created = self._store_message(import_id, request.source_name, message, con)
                if created:
                    for candidate in candidates:
                        imported_candidate = candidate.model_copy(
                            update={"source_type": "conversation_import", "subject": message.speaker}
                        )
                        memory = self.db.add_candidate(
                            imported_candidate, source_id=message_id,
                            evidence=message.content, connection=con,
                        )
                        message_memories.append(memory)
            if not created:
                skipped_duplicates += 1
                continue
            stored_count += 1

            if not is_subject:
                continue

            subject_processed += 1
            for memory in message_memories:
                stored_memories[memory.id] = memory

        return ImportMessagesResponse(
            import_id=import_id,
            source_name=request.source_name,
            messages_received=len(request.messages),
            messages_stored=stored_count,
            duplicate_messages_skipped=skipped_duplicates,
            subject_messages_processed=subject_processed,
            candidate_memories=list(stored_memories.values()),
        )

    def _store_message(
        self,
        import_id: str,
        source_name: str,
        message: ImportMessage,
        con: sqlite3.Connection,
    ) -> tuple[str, bool]:
        key = _dedupe_key(message)
        existing = con.execute(
            "SELECT id FROM imported_messages WHERE source_name = ? AND dedupe_key = ?",
            (source_name, key),
        ).fetchone()
        if existing is not None:
            return existing["id"], False

        message_id = f"imsg_{uuid.uuid4().hex}"
        con.execute(
            """
            INSERT INTO imported_messages(
                id, import_id, source_name, external_id, speaker, content,
                message_time, dedupe_key, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                import_id,
                source_name,
                message.external_id,
                message.speaker,
                message.content,
                message.timestamp.isoformat() if message.timestamp else None,
                key,
                _utc_now_iso(),
            ),
        )
        return message_id, True
