from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

import pytest

from app.db import Database
from app.importer import ChatHistoryImporter
from app.schemas import ImportMessage, ImportMessagesRequest, MemoryCandidate


def proposal(content):
    return MemoryCandidate(type="interest", content=content, confidence=0.8)


def request():
    return ImportMessagesRequest(
        source_name="synthetic", subject_speakers=["Alex"],
        messages=[ImportMessage(speaker="Ray", content="Hello", external_id="1"),
                  ImportMessage(speaker="Alex", content="I like cello and music.", external_id="2")],
    )


def test_failed_candidate_write_rolls_back_source_evidence_and_search(tmp_path):
    db = Database(tmp_path / "test.db")
    cello = proposal("I like cello.")
    existing = db.add_candidate(cello, "earlier", "Earlier cello statement")
    importer = ChatHistoryImporter(db, lambda text: [cello, proposal("I like music.")])
    original = db.add_candidate
    writes = 0

    def interrupted(*args, **kwargs):
        nonlocal writes
        result = original(*args, **kwargs)
        writes += 1
        if writes == 2:
            raise RuntimeError("Simulated failure after candidate write")
        return result

    with patch.object(db, "add_candidate", side_effect=interrupted):
        with pytest.raises(RuntimeError, match="Simulated failure"):
            importer.import_messages(request())
    assert db.get_memory(existing.id).evidence_count == 1
    assert db.get_memory(existing.id).evidence_text == "Earlier cello statement"
    with db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM imported_messages").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM memories").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM memory_evidence").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM memory_fts").fetchone()[0] == 1

    retry = importer.import_messages(request())
    assert (retry.messages_stored, retry.duplicate_messages_skipped) == (1, 1)
    assert len(retry.candidate_memories) == 2
    assert all(m.status == "unconfirmed" for m in retry.candidate_memories)
    assert db.get_memory(existing.id).evidence_count == 2
    with patch.object(importer, "extract_candidates", side_effect=AssertionError("Repeated inference")):
        assert importer.import_messages(request()).duplicate_messages_skipped == 2
    assert db.get_memory(existing.id).evidence_count == 2


def test_simultaneous_imports_commit_one_source_and_one_evidence(tmp_path):
    db = Database(tmp_path / "test.db")
    barrier = Barrier(2)

    def extract(text):
        barrier.wait(timeout=5)
        return [proposal("I like cello.")]

    importer = ChatHistoryImporter(db, extract)
    payload = request().model_copy(update={"messages": request().messages[1:]})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: importer.import_messages(payload), range(2)))
    assert sorted(r.messages_stored for r in results) == [0, 1]
    assert sorted(r.duplicate_messages_skipped for r in results) == [0, 1]
    with db.connect() as con:
        for table in ("imported_messages", "memories", "memory_evidence"):
            assert con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 1
