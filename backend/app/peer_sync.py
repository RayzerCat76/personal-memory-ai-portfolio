from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .backup import (
    BackupContextNote,
    BackupEvidence,
    BackupMemory,
    BackupOpenLoop,
    BackupRelation,
    BackupResolutionProposal,
)
from .db import Database, _fingerprint, confidence_label
from .schemas import MemoryCalibration

PeerEntityKind = Literal[
    "memory", "evidence", "context", "relation",
    "open_loop", "resolution", "calibration",
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
class PeerRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["memory-peer"] = "memory-peer"
    entity_kind: PeerEntityKind
    entity_id: str = Field(min_length=1, max_length=500)
    value: dict[str, Any]
    origin_event_id: str | None = Field(default=None, max_length=200)


class PeerOutboxEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sequence: int
    event_id: str
    record_id: str
    operation: Literal["put", "delete"]
    record: PeerRecord | None = None


class PeerOutboxResponse(BaseModel):
    events: list[PeerOutboxEvent]


class PeerVaultBinding(BaseModel):
    vault_id: str = Field(min_length=1, max_length=500)


class PeerOutboxAck(BaseModel):
    vault_id: str = Field(min_length=1, max_length=500)
    event_ids: list[str] = Field(default_factory=list, max_length=5000)


class PeerApplyItem(BaseModel):
    record_id: str
    operation: Literal["put", "delete"]
    record: PeerRecord | None = None
class PeerApplyRequest(BaseModel):
    vault_id: str = Field(min_length=1, max_length=500)
    items: list[PeerApplyItem] = Field(default_factory=list, max_length=10000)


class PeerApplyResponse(BaseModel):
    applied: int
    unchanged: int


class MemoryPeerSyncStore:
    def __init__(self, db: Database):
        self.db = db
        self._initialise()

    def _initialise(self) -> None:
        with self.db.connect() as con:
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS memory_peer_outbox (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    record_id TEXT NOT NULL,
                    operation TEXT NOT NULL CHECK(operation IN ('put','delete')),
                    payload TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memory_peer_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memory_peer_apply_guard (
                    id INTEGER PRIMARY KEY CHECK(id = 1)
                );
                CREATE TABLE IF NOT EXISTS memory_peer_calibrations (
                    memory_id TEXT PRIMARY KEY,
                    verdict TEXT NOT NULL CHECK(verdict IN ('accurate','sort_of','slander')),
                    updated_at TEXT NOT NULL
                );
                """
            )
            con.execute("INSERT OR IGNORE INTO memory_peer_meta(key,value) VALUES('instance-id', lower(hex(randomblob(16))))")
            self._install_triggers(con)
    def _install_triggers(self, con: sqlite3.Connection) -> None:
        guard = "NOT EXISTS (SELECT 1 FROM memory_peer_apply_guard WHERE id = 1)"
        memory_payload_new = "json_object('kind','memory-peer','entity_kind','memory','entity_id',NEW.id,'value',json_object('id',NEW.id,'type',NEW.type,'content',NEW.content,'status',NEW.status,'confidence',NEW.confidence,'source_type',NEW.source_type,'source_id',NEW.source_id,'importance',NEW.importance,'created_at',NEW.created_at,'updated_at',NEW.updated_at,'evidence_text',NEW.evidence_text,'subject',NEW.subject))"
        con.executescript(f"""
            CREATE TRIGGER IF NOT EXISTS memory_peer_memory_insert AFTER INSERT ON memories
            WHEN {guard}
            BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at)
              VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:memory:'||NEW.id,'put',{memory_payload_new},strftime('%Y-%m-%dT%H:%M:%fZ','now'));
            END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_memory_update AFTER UPDATE ON memories
            WHEN {guard}
            BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at)
              VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:memory:'||NEW.id,'put',{memory_payload_new},strftime('%Y-%m-%dT%H:%M:%fZ','now'));
            END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_memory_delete AFTER DELETE ON memories
            WHEN {guard}
            BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at)
              VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:memory:'||OLD.id,'delete',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
            END;
        """)
        evidence_payload = "json_object('kind','memory-peer','entity_kind','evidence','entity_id',NEW.memory_id||':'||NEW.id,'value',json_object('memory_id',NEW.memory_id,'source_id',NEW.source_id,'evidence_text',NEW.evidence_text,'created_at',NEW.created_at))"
        context_payload = "json_object('kind','memory-peer','entity_kind','context','entity_id',NEW.memory_id||':'||NEW.revision,'value',json_object('id',NEW.id,'memory_id',NEW.memory_id,'note',NEW.note,'status',NEW.status,'revision',NEW.revision,'created_at',NEW.created_at))"
        con.executescript(f"""
            CREATE TRIGGER IF NOT EXISTS memory_peer_evidence_insert AFTER INSERT ON memory_evidence
            WHEN {guard}
            BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at)
              VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:evidence:'||(SELECT value FROM memory_peer_meta WHERE key='instance-id')||':'||NEW.id,'put',{evidence_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now'));
            END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_context_insert AFTER INSERT ON memory_context_notes
            WHEN {guard}
            BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at)
              VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:context:'||NEW.memory_id||':'||NEW.revision,'put',{context_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now'));
            END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_context_update AFTER UPDATE ON memory_context_notes
            WHEN {guard}
            BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at)
              VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:context:'||NEW.memory_id||':'||NEW.revision,'put',{context_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now'));
            END;
        """)
        relation_payload = "json_object('kind','memory-peer','entity_kind','relation','entity_id',NEW.id,'value',json_object('id',NEW.id,'source_memory_id',NEW.source_memory_id,'target_memory_id',NEW.target_memory_id,'relation_type',NEW.relation_type,'created_at',NEW.created_at))"
        loop_payload = "json_object('kind','memory-peer','entity_kind','open_loop','entity_id',NEW.id,'value',json_object('id',NEW.id,'memory_id',NEW.memory_id,'kind',NEW.kind,'content',NEW.content,'status',NEW.status,'created_at',NEW.created_at,'resolved_at',NEW.resolved_at,'resolution_message_id',NEW.resolution_message_id))"
        resolution_payload = "json_object('kind','memory-peer','entity_kind','resolution','entity_id',NEW.id,'value',json_object('id',NEW.id,'open_loop_id',NEW.open_loop_id,'message_id',NEW.message_id,'proposed_status',NEW.proposed_status,'confidence',NEW.confidence,'evidence_text',NEW.evidence_text,'status',NEW.status,'created_at',NEW.created_at,'updated_at',NEW.updated_at))"
        con.executescript(f"""
            CREATE TRIGGER IF NOT EXISTS memory_peer_relation_insert AFTER INSERT ON memory_relations WHEN {guard} BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at) VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:relation:'||NEW.id,'put',{relation_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_relation_update AFTER UPDATE ON memory_relations WHEN {guard} BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at) VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:relation:'||NEW.id,'put',{relation_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_loop_insert AFTER INSERT ON open_loops WHEN {guard} BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at) VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:open-loop:'||NEW.id,'put',{loop_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_loop_update AFTER UPDATE ON open_loops WHEN {guard} BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at) VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:open-loop:'||NEW.id,'put',{loop_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_resolution_insert AFTER INSERT ON resolution_proposals WHEN {guard} BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at) VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:resolution:'||NEW.id,'put',{resolution_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_resolution_update AFTER UPDATE ON resolution_proposals WHEN {guard} BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at) VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:resolution:'||NEW.id,'put',{resolution_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
        """)
        calibration_payload = "json_object('kind','memory-peer','entity_kind','calibration','entity_id',NEW.memory_id,'value',json_object('memory_id',NEW.memory_id,'verdict',NEW.verdict,'updated_at',NEW.updated_at))"
        con.executescript(f"""
            CREATE TRIGGER IF NOT EXISTS memory_peer_calibration_insert AFTER INSERT ON memory_peer_calibrations WHEN {guard} BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at)
              VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:calibration:'||NEW.memory_id,'put',{calibration_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
            CREATE TRIGGER IF NOT EXISTS memory_peer_calibration_update AFTER UPDATE ON memory_peer_calibrations WHEN {guard} BEGIN
              INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at)
              VALUES('mpe_'||lower(hex(randomblob(16))),'memory-peer:calibration:'||NEW.memory_id,'put',{calibration_payload},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
        """)

    @staticmethod
    def _record(entity_kind: PeerEntityKind, entity_id: str, value: dict[str, Any], origin: str | None = None) -> PeerRecord:
        return PeerRecord(entity_kind=entity_kind, entity_id=entity_id, value=value, origin_event_id=origin)

    def _queue(self, con: sqlite3.Connection, record_id: str, record: PeerRecord) -> None:
        event_id = "mpe_" + con.execute("SELECT lower(hex(randomblob(16)))").fetchone()[0]
        con.execute(
            "INSERT INTO memory_peer_outbox(event_id,record_id,operation,payload,created_at) VALUES(?,?,?,?,?)",
            (event_id, record_id, "put", record.model_dump_json(), _now()),
        )
    def _syncable_count(self, con: sqlite3.Connection) -> int:
        total = 0
        for table in ("memories", "memory_evidence", "memory_context_notes", "memory_relations", "open_loops", "resolution_proposals", "memory_peer_calibrations"):
            total += int(con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        return total

    def bind_vault(self, vault_id: str, feedback: dict[str, MemoryCalibration]) -> str:
        vault_id = vault_id.strip()
        if not vault_id:
            raise ValueError("Memory peer vault ID is required")
        with self.db.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            current = con.execute("SELECT value FROM memory_peer_meta WHERE key='vault-id'").fetchone()
            if current and current["value"] != vault_id:
                if self._syncable_count(con) != 0:
                    raise ValueError("This local Memory store already belongs to another peer vault")
                con.execute("DELETE FROM memory_peer_outbox")
                con.execute("DELETE FROM memory_peer_meta WHERE key='bootstrap-v1'")
                con.execute("UPDATE memory_peer_meta SET value=? WHERE key='vault-id'", (vault_id,))
            elif not current:
                con.execute("INSERT INTO memory_peer_meta(key,value) VALUES('vault-id',?)", (vault_id,))
        self.ensure_bootstrap(feedback)
        return vault_id

    def assert_vault(self, vault_id: str) -> None:
        with self.db.connect() as con:
            row = con.execute("SELECT value FROM memory_peer_meta WHERE key='vault-id'").fetchone()
        if not row or row["value"] != vault_id:
            raise ValueError("Memory peer request does not match this local store's vault")

    def ensure_bootstrap(self, feedback: dict[str, MemoryCalibration]) -> None:
        with self.db.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            if con.execute("SELECT 1 FROM memory_peer_meta WHERE key='bootstrap-v1'").fetchone():
                return
            for row in con.execute(
                "SELECT id,type,content,status,confidence,source_type,source_id,importance,created_at,updated_at,evidence_text,subject FROM memories ORDER BY created_at,id"
            ).fetchall():
                value = dict(row)
                self._queue(con, f"memory-peer:memory:{row['id']}", self._record("memory", row["id"], value))
            for row in con.execute(
                "SELECT memory_id,source_id,evidence_text,created_at,id FROM memory_evidence ORDER BY memory_id,id"
            ).fetchall():
                value = {key: row[key] for key in ("memory_id", "source_id", "evidence_text", "created_at")}
                instance_id = con.execute("SELECT value FROM memory_peer_meta WHERE key='instance-id'").fetchone()[0]
                self._queue(con, f"memory-peer:evidence:{instance_id}:{row['id']}", self._record("evidence", f"{instance_id}:{row['id']}", value))
            for row in con.execute(
                "SELECT id,memory_id,note,status,revision,created_at FROM memory_context_notes ORDER BY memory_id,revision"
            ).fetchall():
                self._queue(con, f"memory-peer:context:{row['memory_id']}:{row['revision']}", self._record("context", f"{row['memory_id']}:{row['revision']}", dict(row)))
            for row in con.execute(
                "SELECT id,source_memory_id,target_memory_id,relation_type,created_at FROM memory_relations ORDER BY created_at,id"
            ).fetchall():
                self._queue(con, f"memory-peer:relation:{row['id']}", self._record("relation", row["id"], dict(row)))
            for row in con.execute(
                "SELECT id,memory_id,kind,content,status,created_at,resolved_at,resolution_message_id FROM open_loops ORDER BY created_at,id"
            ).fetchall():
                self._queue(con, f"memory-peer:open-loop:{row['id']}", self._record("open_loop", row["id"], dict(row)))
            for row in con.execute(
                "SELECT id,open_loop_id,message_id,proposed_status,confidence,evidence_text,status,created_at,updated_at FROM resolution_proposals ORDER BY created_at,id"
            ).fetchall():
                self._queue(con, f"memory-peer:resolution:{row['id']}", self._record("resolution", row["id"], dict(row)))
            con.execute("INSERT OR IGNORE INTO memory_peer_apply_guard(id) VALUES(1)")
            try:
                for memory_id, verdict in feedback.items():
                    con.execute(
                        "INSERT INTO memory_peer_calibrations(memory_id,verdict,updated_at) VALUES(?,?,?) ON CONFLICT(memory_id) DO UPDATE SET verdict=excluded.verdict,updated_at=excluded.updated_at",
                        (memory_id, verdict, _now()),
                    )
            finally:
                con.execute("DELETE FROM memory_peer_apply_guard WHERE id=1")
            for row in con.execute("SELECT memory_id,verdict,updated_at FROM memory_peer_calibrations ORDER BY memory_id").fetchall():
                self._queue(con, f"memory-peer:calibration:{row['memory_id']}", self._record("calibration", row["memory_id"], dict(row)))
            con.execute("INSERT INTO memory_peer_meta(key,value) VALUES('bootstrap-v1',?)", (_now(),))
    def list_outbox(self, vault_id: str, limit: int = 5000) -> PeerOutboxResponse:
        self.assert_vault(vault_id)
        with self.db.connect() as con:
            rows = con.execute(
                "SELECT sequence,event_id,record_id,operation,payload FROM memory_peer_outbox ORDER BY sequence LIMIT ?",
                (limit,),
            ).fetchall()
        events: list[PeerOutboxEvent] = []
        for row in rows:
            record = PeerRecord.model_validate_json(row["payload"]) if row["payload"] else None
            if record is not None:
                record = record.model_copy(update={"origin_event_id": row["event_id"]})
            events.append(PeerOutboxEvent(
                sequence=row["sequence"], event_id=row["event_id"], record_id=row["record_id"],
                operation=row["operation"], record=record,
            ))
        return PeerOutboxResponse(events=events)

    def acknowledge(self, vault_id: str, event_ids: list[str]) -> int:
        self.assert_vault(vault_id)
        unique = list(dict.fromkeys(event_ids))
        if not unique:
            return 0
        with self.db.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            placeholders = ",".join("?" for _ in unique)
            count = con.execute(
                f"SELECT COUNT(*) FROM memory_peer_outbox WHERE event_id IN ({placeholders})", unique
            ).fetchone()[0]
            con.execute(f"DELETE FROM memory_peer_outbox WHERE event_id IN ({placeholders})", unique)
        return int(count)

    def set_calibration(self, memory_id: str, verdict: MemoryCalibration) -> None:
        with self.db.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute(
                "INSERT INTO memory_peer_calibrations(memory_id,verdict,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(memory_id) DO UPDATE SET verdict=excluded.verdict,updated_at=excluded.updated_at",
                (memory_id, verdict, _now()),
            )
    def calibrations(self) -> dict[str, MemoryCalibration]:
        with self.db.connect() as con:
            rows = con.execute("SELECT memory_id,verdict FROM memory_peer_calibrations ORDER BY memory_id").fetchall()
        return {row["memory_id"]: row["verdict"] for row in rows}

    def apply(self, vault_id: str, items: list[PeerApplyItem]) -> PeerApplyResponse:
        self.assert_vault(vault_id)
        puts = [item for item in items if item.operation == "put"]
        deletes = [item for item in items if item.operation == "delete"]
        priority = {"memory": 0, "evidence": 1, "context": 2, "relation": 3, "open_loop": 4, "resolution": 5, "calibration": 6}
        puts.sort(key=lambda item: (priority.get(item.record.entity_kind if item.record else "", 99), item.record_id))
        deletes.sort(key=lambda item: (priority.get(item.record.entity_kind if item.record else "", 99), item.record_id), reverse=True)
        applied = 0
        unchanged = 0
        with self.db.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            con.execute("INSERT OR IGNORE INTO memory_peer_apply_guard(id) VALUES(1)")
            try:
                for item in [*puts, *deletes]:
                    changed = self._apply_one(con, item)
                    applied += int(changed)
                    unchanged += int(not changed)
            finally:
                con.execute("DELETE FROM memory_peer_apply_guard WHERE id=1")
        return PeerApplyResponse(applied=applied, unchanged=unchanged)

    def _apply_one(self, con: sqlite3.Connection, item: PeerApplyItem) -> bool:
        if item.operation == "delete":
            return self._apply_delete(con, item)
        if item.record is None:
            raise ValueError("Peer put is missing its record payload")
        kind = item.record.entity_kind
        value = item.record.value
        if kind == "memory":
            return self._put_memory(con, value)
        if kind == "evidence":
            return self._put_evidence(con, value)
        if kind == "context":
            return self._put_context(con, value)
        if kind == "relation":
            return self._put_relation(con, value)
        if kind == "open_loop":
            return self._put_open_loop(con, value)
        if kind == "resolution":
            return self._put_resolution(con, value)
        if kind == "calibration":
            return self._put_calibration(con, value)
        raise ValueError("Unsupported peer memory record kind")
    @staticmethod
    def _same_row(row: sqlite3.Row | None, expected: dict[str, Any], fields: tuple[str, ...]) -> bool:
        return row is not None and all(row[field] == expected[field] for field in fields)

    def _put_memory(self, con: sqlite3.Connection, value: dict[str, Any]) -> bool:
        item = BackupMemory.model_validate(value)
        expected = item.model_dump(mode="json")
        fields = ("id", "type", "content", "status", "confidence", "source_type", "source_id", "importance", "created_at", "updated_at", "evidence_text", "subject")
        row = con.execute("SELECT * FROM memories WHERE id=?", (item.id,)).fetchone()
        if self._same_row(row, expected, fields):
            return False
        fingerprint = _fingerprint(item.type, item.content)
        label = confidence_label(item.confidence, item.status)
        con.execute(
            """INSERT INTO memories(id,type,content,status,confidence,confidence_label,source_type,source_id,importance,created_at,updated_at,evidence_text,subject,fingerprint)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET type=excluded.type,content=excluded.content,status=excluded.status,
               confidence=excluded.confidence,confidence_label=excluded.confidence_label,source_type=excluded.source_type,
               source_id=excluded.source_id,importance=excluded.importance,created_at=excluded.created_at,
               updated_at=excluded.updated_at,evidence_text=excluded.evidence_text,subject=excluded.subject,fingerprint=excluded.fingerprint""",
            (item.id,item.type,item.content,item.status,item.confidence,label,item.source_type,item.source_id,item.importance,
             expected["created_at"],expected["updated_at"],item.evidence_text,item.subject,fingerprint),
        )
        self.db._fts_upsert(con, item.id, item.content, item.type)
        return True

    def _put_evidence(self, con: sqlite3.Connection, value: dict[str, Any]) -> bool:
        item = BackupEvidence.model_validate(value)
        expected = item.model_dump(mode="json")
        row = con.execute(
            "SELECT 1 FROM memory_evidence WHERE memory_id=? AND source_id IS ? AND evidence_text=? AND created_at=? LIMIT 1",
            (item.memory_id,item.source_id,item.evidence_text,expected["created_at"]),
        ).fetchone()
        if row:
            return False
        con.execute(
            "INSERT INTO memory_evidence(memory_id,source_id,evidence_text,created_at) VALUES(?,?,?,?)",
            (item.memory_id,item.source_id,item.evidence_text,expected["created_at"]),
        )
        return True
    def _put_context(self, con: sqlite3.Connection, value: dict[str, Any]) -> bool:
        item = BackupContextNote.model_validate(value)
        expected = item.model_dump(mode="json")
        fields = ("id", "memory_id", "note", "status", "revision", "created_at")
        row = con.execute("SELECT * FROM memory_context_notes WHERE id=?", (item.id,)).fetchone()
        if self._same_row(row, expected, fields):
            return False
        con.execute(
            "DELETE FROM memory_context_notes WHERE memory_id=? AND revision=? AND id!=?",
            (item.memory_id, item.revision, item.id),
        )
        if item.status == "active":
            con.execute(
                "UPDATE memory_context_notes SET status='superseded' WHERE memory_id=? AND status='active' AND id!=?",
                (item.memory_id, item.id),
            )
        con.execute(
            """INSERT INTO memory_context_notes(id,memory_id,note,status,revision,created_at) VALUES(?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET memory_id=excluded.memory_id,note=excluded.note,status=excluded.status,
               revision=excluded.revision,created_at=excluded.created_at""",
            (item.id,item.memory_id,item.note,item.status,item.revision,expected["created_at"]),
        )
        return True

    def _put_relation(self, con: sqlite3.Connection, value: dict[str, Any]) -> bool:
        item = BackupRelation.model_validate(value)
        expected = item.model_dump(mode="json")
        fields = ("id", "source_memory_id", "target_memory_id", "relation_type", "created_at")
        row = con.execute("SELECT * FROM memory_relations WHERE id=?", (item.id,)).fetchone()
        if self._same_row(row, expected, fields):
            return False
        duplicate = con.execute(
            "SELECT * FROM memory_relations WHERE source_memory_id=? AND target_memory_id=? AND relation_type=? AND id!=?",
            (item.source_memory_id,item.target_memory_id,item.relation_type,item.id),
        ).fetchone()
        if duplicate:
            return False
        con.execute(
            """INSERT INTO memory_relations(id,source_memory_id,target_memory_id,relation_type,created_at) VALUES(?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET source_memory_id=excluded.source_memory_id,target_memory_id=excluded.target_memory_id,
               relation_type=excluded.relation_type,created_at=excluded.created_at""",
            (item.id,item.source_memory_id,item.target_memory_id,item.relation_type,expected["created_at"]),
        )
        return True
    def _put_open_loop(self, con: sqlite3.Connection, value: dict[str, Any]) -> bool:
        item = BackupOpenLoop.model_validate(value)
        expected = item.model_dump(mode="json")
        fields = ("id", "memory_id", "kind", "content", "status", "created_at", "resolved_at", "resolution_message_id")
        row = con.execute("SELECT * FROM open_loops WHERE id=?", (item.id,)).fetchone()
        if self._same_row(row, expected, fields):
            return False
        duplicate = con.execute("SELECT * FROM open_loops WHERE memory_id=? AND id!=?", (item.memory_id,item.id)).fetchone()
        if duplicate:
            duplicate_expected = {field: expected[field] for field in fields if field != "id"}
            if all(duplicate[field] == duplicate_expected[field] for field in duplicate_expected):
                return False
            raise ValueError("Peer open-loop identity conflicts with an existing loop")
        con.execute(
            """INSERT INTO open_loops(id,memory_id,kind,content,status,created_at,resolved_at,resolution_message_id)
               VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET memory_id=excluded.memory_id,kind=excluded.kind,
               content=excluded.content,status=excluded.status,created_at=excluded.created_at,resolved_at=excluded.resolved_at,
               resolution_message_id=excluded.resolution_message_id""",
            (item.id,item.memory_id,item.kind,item.content,item.status,expected["created_at"],expected["resolved_at"],item.resolution_message_id),
        )
        return True

    def _put_resolution(self, con: sqlite3.Connection, value: dict[str, Any]) -> bool:
        item = BackupResolutionProposal.model_validate(value)
        expected = item.model_dump(mode="json")
        fields = ("id", "open_loop_id", "message_id", "proposed_status", "confidence", "evidence_text", "status", "created_at", "updated_at")
        row = con.execute("SELECT * FROM resolution_proposals WHERE id=?", (item.id,)).fetchone()
        if self._same_row(row, expected, fields):
            return False
        duplicate = con.execute(
            "SELECT * FROM resolution_proposals WHERE open_loop_id=? AND message_id=? AND proposed_status=? AND id!=?",
            (item.open_loop_id,item.message_id,item.proposed_status,item.id),
        ).fetchone()
        if duplicate:
            return False
        con.execute(
            """INSERT INTO resolution_proposals(id,open_loop_id,message_id,proposed_status,confidence,evidence_text,status,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET open_loop_id=excluded.open_loop_id,message_id=excluded.message_id,
               proposed_status=excluded.proposed_status,confidence=excluded.confidence,evidence_text=excluded.evidence_text,
               status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at""",
            tuple(expected[field] for field in fields),
        )
        return True
    def _put_calibration(self, con: sqlite3.Connection, value: dict[str, Any]) -> bool:
        memory_id = str(value.get("memory_id", ""))
        verdict = value.get("verdict")
        updated_at = str(value.get("updated_at", ""))
        if not memory_id or verdict not in {"accurate", "sort_of", "slander"} or not updated_at:
            raise ValueError("Invalid peer calibration record")
        row = con.execute("SELECT memory_id,verdict,updated_at FROM memory_peer_calibrations WHERE memory_id=?", (memory_id,)).fetchone()
        if row and row["verdict"] == verdict and row["updated_at"] == updated_at:
            return False
        con.execute(
            "INSERT INTO memory_peer_calibrations(memory_id,verdict,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(memory_id) DO UPDATE SET verdict=excluded.verdict,updated_at=excluded.updated_at",
            (memory_id, verdict, updated_at),
        )
        return True

    def _apply_delete(self, con: sqlite3.Connection, item: PeerApplyItem) -> bool:
        record_id = item.record_id
        mapping = (
            ("memory-peer:resolution:", "resolution_proposals", "id"),
            ("memory-peer:open-loop:", "open_loops", "id"),
            ("memory-peer:relation:", "memory_relations", "id"),
            ("memory-peer:memory:", "memories", "id"),
            ("memory-peer:calibration:", "memory_peer_calibrations", "memory_id"),
        )
        for prefix, table, column in mapping:
            if record_id.startswith(prefix):
                entity_id = record_id[len(prefix):]
                before = con.execute(f"SELECT 1 FROM {table} WHERE {column}=?", (entity_id,)).fetchone()
                if not before:
                    return False
                con.execute(f"DELETE FROM {table} WHERE {column}=?", (entity_id,))
                return True
        if record_id.startswith("memory-peer:context:"):
            parts = record_id.split(":")
            if len(parts) < 4:
                raise ValueError("Invalid context tombstone")
            revision = int(parts[-1]); memory_id = ":".join(parts[2:-1])
            before = con.execute("SELECT 1 FROM memory_context_notes WHERE memory_id=? AND revision=?", (memory_id, revision)).fetchone()
            if not before:
                return False
            con.execute("DELETE FROM memory_context_notes WHERE memory_id=? AND revision=?", (memory_id, revision))
            return True
        if record_id.startswith("memory-peer:evidence:"):
            return False
        raise ValueError("Unsupported peer tombstone")
