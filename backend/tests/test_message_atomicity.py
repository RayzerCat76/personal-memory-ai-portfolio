from unittest.mock import patch

import pytest

from app.schemas import MemoryCandidate, ResolutionCandidate
from app.service import MemoryService
from app.settings import Settings


@pytest.fixture
def service(tmp_path):
    return MemoryService(Settings(db_path=tmp_path / "test.db", llm_provider="heuristic", embedding_provider="none"))


def snapshot(service):
    with service.db.connect() as con:
        return {table: [tuple(row) for row in con.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                for table in ("messages", "memories", "memory_evidence", "memory_fts", "resolution_proposals", "open_loops")}


def test_candidate_failure_rolls_back_whole_message_and_retries(service):
    candidates = [MemoryCandidate(type="interest", content=text, confidence=0.8)
                  for text in ("I like cello.", "I like music.")]
    original_memory = service.db.add_candidate(candidates[0], "earlier", "Earlier evidence")
    before = snapshot(service)
    original = service.db.add_candidate
    calls = 0

    def fail_after_write(*args, **kwargs):
        nonlocal calls
        result = original(*args, **kwargs)
        calls += 1
        if calls == 2:
            raise RuntimeError("Interrupted candidate persistence")
        return result

    with patch.object(service, "_extract_candidates", return_value=candidates):
        with patch.object(service.db, "add_candidate", side_effect=fail_after_write):
            with pytest.raises(RuntimeError, match="Interrupted"):
                service.ingest_message("I like cello and music.")
        assert snapshot(service) == before
        result = service.ingest_message("I like cello and music.")
    assert len(result.candidate_memories) == 2
    assert all(m.status == "unconfirmed" for m in result.candidate_memories)
    assert service.db.get_memory(original_memory.id).evidence_count == 2
    assert service.retrieve("cello") == []


def test_resolution_failure_rolls_back_message_and_keeps_goal_active(service):
    goal = service.db.add_candidate(MemoryCandidate(type="goal", content="finish music project", confidence=0.9),
                                    "earlier", "I want to finish music project.")
    service.confirm_memory(goal.id)
    before = snapshot(service)
    resolution = ResolutionCandidate(target_text="finish music project", proposed_status="completed", confidence=0.9)
    original = service.db._add_resolution_proposal

    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("Interrupted resolution persistence")

    with patch.object(service, "_extract_candidates", return_value=[]), patch.object(service.heuristic, "extract_resolutions", return_value=[resolution]):
        with patch.object(service.db, "_add_resolution_proposal", side_effect=fail_after_write):
            with pytest.raises(RuntimeError, match="Interrupted"):
                service.ingest_message("I finished my music project.")
        assert snapshot(service) == before
        result = service.ingest_message("I finished my music project.")
    assert len(result.resolution_proposals) == 1
    assert result.resolution_proposals[0].status == "pending"
    assert len(service.db.list_open_loops(status="active")) == 1
