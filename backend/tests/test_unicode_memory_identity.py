import json

from app.db import Database, _fingerprint
from app.gift_seed import FriendSeedStore
from app.schemas import MemoryCandidate


def candidate(content):
    return MemoryCandidate(type="preference", content=content, confidence=0.8)


def test_chinese_and_negation_do_not_merge_but_repeated_evidence_does(tmp_path):
    db = Database(tmp_path / "test.db")
    contents = ["喜欢原神", "不喜欢原神", "喜欢崩坏星穹铁道", "喜欢 Genshin", "不喜欢 Genshin"]
    memories = [db.add_candidate(candidate(text), f"source-{i}", text) for i, text in enumerate(contents)]
    assert len({m.id for m in memories}) == len(contents)
    repeated = db.add_candidate(candidate("喜欢原神。"), "another", "喜欢原神。")
    assert repeated.id == memories[0].id
    assert repeated.evidence_count == 2
    assert db.get_memory(memories[1].id).evidence_count == 1
    assert _fingerprint("fact", "I like MUSIC!") == _fingerprint("fact", "i like music")


def test_legacy_fingerprint_rebuilt_without_changing_confirmed_content_or_evidence(tmp_path):
    path = tmp_path / "test.db"
    db = Database(path)
    memory = db.add_candidate(candidate("喜欢原神"), "source-1", "喜欢原神")
    db.set_status(memory.id, "confirmed")
    before = db.get_memory(memory.id)
    evidence = db.get_memory_evidence(memory.id)
    with db.connect() as con:
        con.execute("UPDATE memories SET fingerprint='preference:' WHERE id=?", (memory.id,))
    reopened = Database(path)
    assert reopened.get_memory(memory.id) == before
    assert reopened.get_memory_evidence(memory.id) == evidence
    assert reopened.add_candidate(candidate("喜欢原神"), "source-2", "喜欢原神").id == memory.id
    assert reopened.add_candidate(candidate("不喜欢原神"), "source-3", "不喜欢原神").id != memory.id


def test_seed_import_retains_distinct_chinese_entries_and_remains_idempotent(tmp_path):
    db = Database(tmp_path / "test.db")
    seed = tmp_path / "seed.json"
    seed.write_text(json.dumps([
        {"id": "like", "type": "preference", "content": "喜欢原神"},
        {"id": "dislike", "type": "preference", "content": "不喜欢原神"},
        {"id": "repeat", "type": "preference", "content": "喜欢原神。"},
    ]))
    store = FriendSeedStore(db, seed, tmp_path / "feedback.json")
    first = store.import_seed()
    assert (first.imported, first.skipped) == (2, 1)
    assert {m.content for m in first.memories} == {"喜欢原神", "不喜欢原神"}
    again = store.import_seed()
    assert (again.imported, again.skipped) == (0, 3)
