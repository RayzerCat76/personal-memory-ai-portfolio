from app.db import Database, _action_similarity
from app.schemas import MemoryCandidate


def add(db, text, status="confirmed"):
    memory = db.add_candidate(MemoryCandidate(type="fact", content=text, confidence=0.8), text, text)
    return db.set_status(memory.id, status)


def test_chinese_keyword_search_uses_index_and_only_confirmed_memories(tmp_path):
    db = Database(tmp_path / "test.db")
    memory = add(db, "我的生日是七月十日。")
    for status in ("unconfirmed", "rejected", "superseded"):
        add(db, f"生日信息{status}", status)
    add(db, "我喜欢音乐。")
    with db.connect() as con:
        ids = {r[0] for r in con.execute("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?", ('"生日"',))}
        assert memory.id in ids
    result = db.search_confirmed("生日是什么时候？")
    assert [m.id for m in result] == [memory.id]
    assert result[0].content == "我的生日是七月十日。"
    assert result[0].evidence_text == "我的生日是七月十日。"


def test_correction_and_legacy_index_refresh_keep_chinese_search_current(tmp_path):
    path = tmp_path / "test.db"
    db = Database(path)
    memory = add(db, "我喜欢原神。", "unconfirmed")
    db.correct_memory(memory.id, "我喜欢星穹铁道。", memory.content)
    db.set_status(memory.id, "confirmed")
    assert db.search_confirmed("原神") == []
    assert [m.id for m in db.search_confirmed("星穹铁道")] == [memory.id]
    with db.connect() as con:
        con.execute("UPDATE memory_fts SET content=? WHERE memory_id=?", ("我喜欢星穹铁道。", memory.id))
    reopened = Database(path)
    assert [m.id for m in reopened.search_confirmed("星穹铁道")] == [memory.id]


def test_chinese_fallback_without_fts_and_english_behavior(tmp_path):
    db = Database(tmp_path / "test.db")
    chinese = add(db, "我正在写心理学作业。")
    english = add(db, "I play cello.")
    assert [m.id for m in db.search_confirmed("cello")] == [english.id]
    with db.connect() as con:
        con.execute("DROP TABLE memory_fts")
    assert [m.id for m in db.search_confirmed("心理学")] == [chinese.id]
    assert [m.id for m in db.search_confirmed("cello")] == [english.id]


def test_chinese_search_tokens_do_not_enable_automatic_action_matching():
    assert _action_similarity("计划设计产品", "完成设计产品") == 0.0
