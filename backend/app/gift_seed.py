from __future__ import annotations

import json
from pathlib import Path

from pydantic import TypeAdapter

from .db import Database, _canonical
from .schemas import (
    FriendSeedImportResponse,
    FriendSeedItem,
    MemoryCalibration,
    MemoryCandidate,
    MemoryRead,
)

_seed_adapter = TypeAdapter(list[FriendSeedItem])


def _memory_key(memory_type: str, content: str) -> tuple[str, str]:
    return memory_type, _canonical(content)


class FriendSeedStore:
    """Loads Ray-supplied birthday memories from local, gitignored JSON.

    The seed file itself is deliberately kept outside version control. Each
    entry gets a stable source ID, which makes repeated imports idempotent.
    Calibration feedback is stored in a second local JSON file so 'sort of'
    can be remembered without forcing an inaccurate memory into retrieval.
    """

    def __init__(self, db: Database, seed_path: Path, feedback_path: Path):
        self.db = db
        self.seed_path = seed_path
        self.feedback_path = feedback_path

    def import_seed(self) -> FriendSeedImportResponse:
        if not self.seed_path.exists():
            return FriendSeedImportResponse(
                file_found=False,
                imported=0,
                skipped=0,
                memories=[],
            )

        raw = json.loads(self.seed_path.read_text(encoding="utf-8"))
        items = _seed_adapter.validate_python(raw)
        existing_memories = self.db.list_memories(limit=5000)
        existing_sources = {
            memory.source_id
            for memory in existing_memories
            if memory.source_id
        }
        existing_keys = {
            _memory_key(memory.type, memory.content)
            for memory in existing_memories
            if memory.status in {"unconfirmed", "confirmed"}
        }

        imported: list[MemoryRead] = []
        skipped = 0
        for item in items:
            source_id = f"friend_seed:{item.id}"
            key = _memory_key(item.type, item.content)
            if source_id in existing_sources or key in existing_keys:
                skipped += 1
                continue

            evidence = item.note or "Seeded by Ray for the birthday build."
            candidate = MemoryCandidate(
                type=item.type,
                content=item.content,
                confidence=item.confidence,
                source_type="friend_seed",
                importance=item.importance,
                subject=item.subject,
            )
            memory = self.db.add_candidate(
                candidate,
                source_id=source_id,
                evidence=evidence,
                seed_once=True,
            )
            if memory is None:
                skipped += 1
                continue
            imported.append(memory)
            existing_sources.add(source_id)
            existing_keys.add(key)

        return FriendSeedImportResponse(
            file_found=True,
            imported=len(imported),
            skipped=skipped,
            memories=imported,
        )

    def _file_feedback(self) -> dict[str, MemoryCalibration]:
        if not self.feedback_path.exists():
            return {}
        try:
            raw = json.loads(self.feedback_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
        if not isinstance(raw, dict):
            return {}
        valid = {"accurate", "sort_of", "slander"}
        return {str(memory_id): verdict for memory_id, verdict in raw.items() if verdict in valid}

    def load_feedback(self) -> dict[str, MemoryCalibration]:
        with self.db.connect() as con:
            exists = con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_peer_calibrations'").fetchone()
            if exists:
                rows = con.execute("SELECT memory_id,verdict FROM memory_peer_calibrations ORDER BY memory_id").fetchall()
                return {row["memory_id"]: row["verdict"] for row in rows}
        return self._file_feedback()

    def replace_feedback_cache(self, feedback: dict[str, MemoryCalibration]) -> None:
        self.feedback_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.feedback_path.with_suffix(self.feedback_path.suffix + ".tmp")
        temp.write_text(json.dumps(feedback, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp.replace(self.feedback_path)

    def save_feedback(self, memory_id: str, verdict: MemoryCalibration) -> None:
        feedback = self.load_feedback()
        feedback[memory_id] = verdict
        with self.db.connect() as con:
            exists = con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_peer_calibrations'").fetchone()
            if exists:
                con.execute("INSERT INTO memory_peer_calibrations(memory_id,verdict,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(memory_id) DO UPDATE SET verdict=excluded.verdict,updated_at=excluded.updated_at", (memory_id, verdict))
        self.replace_feedback_cache(feedback)
