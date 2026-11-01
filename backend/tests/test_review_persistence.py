from app.service import MemoryService
from app.settings import Settings


def test_review_state_and_evidence_survive_restart(tmp_path):
    settings = Settings(
        db_path=tmp_path/'test.db', vector_path=tmp_path/'vectors',
        friend_seed_path=tmp_path/'seed.json', friend_seed_feedback_path=tmp_path/'feedback.json',
        llm_provider='heuristic', embedding_provider='none',
    )
    source = 'I prefer Python over Java for personal projects.'
    service = MemoryService(settings)
    proposal = service.ingest_message(source).candidate_memories[0]
    assert proposal.status == 'unconfirmed'
    assert proposal.evidence_text == source
    restarted = MemoryService(settings)
    assert restarted.db.get_memory(proposal.id).status == 'unconfirmed'
    assert restarted.chat('Do I prefer Python or Java?').evidence == []
    restarted.confirm_memory(proposal.id)
    confirmed = MemoryService(settings)
    assert confirmed.db.get_memory(proposal.id).evidence_text == source
    assert any(e.memory_id == proposal.id for e in confirmed.chat('Do I prefer Python or Java?').evidence)
    confirmed.reject_memory(proposal.id)
    rejected = MemoryService(settings)
    assert rejected.db.get_memory(proposal.id).status == 'rejected'
    assert rejected.chat('Do I prefer Python or Java?').evidence == []
