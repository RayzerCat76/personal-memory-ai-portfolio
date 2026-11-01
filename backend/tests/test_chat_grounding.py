from fastapi.testclient import TestClient
import pytest

from app.main import app, get_service
from app.schemas import MemoryCandidate
from app.service import MemoryService
from app.settings import Settings


@pytest.fixture
def service(tmp_path):
    return MemoryService(Settings(
        db_path=tmp_path / "memory.db", vector_path=tmp_path / "vectors",
        llm_provider="heuristic", embedding_provider="none",
        friend_seed_path=tmp_path / "seed.json",
        friend_seed_feedback_path=tmp_path / "feedback.json",
    ))


def candidate(service, content, source="source-1", evidence="Original message"):
    return service.db.add_candidate(
        MemoryCandidate(type="fact", content=content, confidence=0.8,
                        source_type="user_statement"),
        source_id=source, evidence=evidence,
    )


def test_chat_api_preserves_each_supporting_message_after_correction(service):
    memory = candidate(service, "I play violin.", evidence="I play cello.")
    service.db.correct_memory(memory.id, "I play cello.", memory.content)
    duplicate = candidate(service, "I play cello.", "source-2", "Still playing cello.")
    assert duplicate.id == memory.id
    assert service.chat("cello").evidence == []
    service.confirm_memory(memory.id)
    app.dependency_overrides[get_service] = lambda: service
    try:
        with TestClient(app) as client:
            response = client.post("/api/v1/chat", json={"message": "cello"})
        assert response.status_code == 200
        body = response.json()
        assert "cello" in body["answer"]
        assert len(body["evidence"]) == 1
        item = body["evidence"][0]
        assert item["memory_id"] == memory.id
        assert item["content"] == "I play cello."
        assert [(s["source_id"], s["evidence_text"]) for s in item["sources"]] == [
            ("source-1", "I play cello."), ("source-2", "Still playing cello."),
        ]
        assert all(s["created_at"] for s in item["sources"])
    finally:
        app.dependency_overrides.pop(get_service, None)


def test_stale_semantic_hits_never_reach_ai_or_evidence(service):
    confirmed = candidate(service, "I play cello.")
    service.confirm_memory(confirmed.id)
    unsafe = []
    for status in ("unconfirmed", "rejected", "superseded"):
        memory = candidate(service, f"Private {status} fact.", source=status)
        service.db.set_status(memory.id, status)
        unsafe.append(memory.id)

    class StaleIndex:
        def ensure_indexed(self, memories):
            assert [m.id for m in memories] == [confirmed.id]

        def search(self, question, limit):
            return [(i, 1.0) for i in unsafe + ["missing", confirmed.id, confirmed.id]]

    class RecordingAI:
        def answer(self, question, memories):
            assert [m.id for m in memories] == [confirmed.id]
            assert all(m.status == "confirmed" for m in memories)
            return "You play cello."

    service.semantic = StaleIndex()
    service.llm = RecordingAI()
    result = service.chat("Which instrument?")
    assert result.answer == "You play cello."
    assert [e.memory_id for e in result.evidence] == [confirmed.id]
    assert result.evidence[0].sources[0].source_id == "source-1"


def test_failed_semantic_search_keeps_lexical_evidence(service):
    memory = candidate(service, "I play cello.")
    service.confirm_memory(memory.id)

    class OfflineIndex:
        def ensure_indexed(self, memories):
            raise RuntimeError("Embedding service offline")

    service.semantic = OfflineIndex()
    result = service.chat("cello")
    assert [e.memory_id for e in result.evidence] == [memory.id]
    assert result.evidence[0].sources[0].evidence_text == "Original message"
    assert service.semantic_error == "Embedding service offline"


def test_explicit_fact_lookup_avoids_model_and_vectors_preserves_evidence(service):
    memory = candidate(service, "His IB subjects are Music and Physics.", evidence="Original subjects")
    service.confirm_memory(memory.id)
    class NeverCalled:
        def __getattr__(self, name):
            raise AssertionError("Direct fact must not invoke model/vector services")
    service.llm = service.semantic = NeverCalled()
    result = service.chat("What are my IB subjects?")
    assert result.answer == "Your IB subjects are Music and Physics."
    assert [e.memory_id for e in result.evidence] == [memory.id]
    assert result.evidence[0].sources[0].evidence_text == "Original subjects"


@pytest.mark.parametrize("status", ["unconfirmed", "rejected", "superseded"])
def test_direct_fact_never_uses_untrusted_records(service, status):
    memory = candidate(service, "His IB subjects are Music and Physics.")
    service.db.set_status(memory.id, status)
    assert service._direct_fact("What are my IB subjects") is None


def test_direct_fact_does_not_choose_between_conflicting_confirmed_records(service):
    for i, subjects in enumerate(["Music", "Physics"]):
        memory = candidate(service, f"His IB subjects are {subjects}.", source=str(i))
        service.confirm_memory(memory.id)
    assert service._direct_fact("What are my IB subjects") is None


def test_direct_fact_does_not_answer_other_people_or_composite_questions(service):
    memory = candidate(service, "Ray's IB subjects are Music.")
    service.confirm_memory(memory.id)
    assert service._direct_fact("What are my IB subjects") is None
    assert service._direct_fact("What are my IB subjects and why?") is None


def test_direct_memory_handles_unambiguous_preference_without_model_or_vectors(service):
    memory = service.db.add_candidate(
        MemoryCandidate(type="preference", content="Prefers writing software over working on mechanical systems in robotics projects", confidence=0.9, source_type="user_statement"),
        source_id="pref-source", evidence="I prefer writing software rather than working on mechanical systems in robotics projects.",
    )
    service.confirm_memory(memory.id)
    class NeverCalled:
        def __getattr__(self, name):
            raise AssertionError("Direct memory lookup must not invoke model/vector services")
    service.llm = service.semantic = NeverCalled()
    result = service.chat("What kind of work do I prefer in robotics?")
    assert result.answer == "You prefer writing software over working on mechanical systems in robotics projects"
    assert [e.memory_id for e in result.evidence] == [memory.id]


def test_direct_memory_handles_simple_fact_variant_and_rejects_composite(service):
    memory = candidate(service, "The recipient's birthday is July 10.")
    service.confirm_memory(memory.id)
    assert service._direct_memory("When is my birthday?").id == memory.id
    assert service._direct_memory("When is my birthday and why?") is None


def test_direct_memory_does_not_choose_between_ambiguous_matches(service):
    for i, content in enumerate([
        "Prefers software work in robotics projects.",
        "Prefers electronics work in robotics projects.",
    ]):
        memory = service.db.add_candidate(
            MemoryCandidate(type="preference", content=content, confidence=0.9, source_type="user_statement"),
            source_id=f"pref-{i}", evidence=content,
        )
        service.confirm_memory(memory.id)
    assert service._direct_memory("What work do I prefer in robotics?") is None


def test_abstention_hides_unrelated_retrieval_evidence(service):
    memory = candidate(service, "His school is YCIS.")
    service.confirm_memory(memory.id)
    class AbstainingAI:
        def answer(self, question, memories):
            assert [m.id for m in memories] == [memory.id]
            return "I don't know that from the confirmed memories I currently have."
    service.llm = AbstainingAI()
    service.retrieve = lambda _question: [memory]
    result = service.chat("What is our inside joke?")
    assert result.answer == "I don't know that from the confirmed memories I currently have."
    assert result.evidence == []


def test_direct_memory_does_not_shortcut_event_on_token_overlap(service):
    memory = service.db.add_candidate(
        MemoryCandidate(type="event", content="The recipient worked on robotics software during a project.", confidence=0.9, source_type="user_statement"),
        source_id="event-source", evidence="I worked on robotics software during a project.",
    )
    service.confirm_memory(memory.id)
    assert service._direct_memory("What work did I do in robotics?") is None


def test_multi_part_direct_facts_avoid_model_and_preserve_requested_order(service):
    birthday = candidate(service, "The recipient's birthday is July 10.", source="birthday")
    school = candidate(service, "His school is YCIS. His education includes the IGCSE and IB programmes.", source="school")
    subjects = candidate(service, "His IB subjects are Music and Physics.", source="subjects")
    for memory in (birthday, school, subjects):
        service.confirm_memory(memory.id)
    class NeverCalled:
        def __getattr__(self, name):
            raise AssertionError("Direct multi-fact lookup must not invoke model/vector services")
    service.llm = service.semantic = NeverCalled()
    result = service.chat("When is my birthday, and what are my school and IB subjects?")
    assert result.answer == "Your birthday is July 10. Your school is YCIS. Your IB subjects are Music and Physics."
    assert [e.memory_id for e in result.evidence] == [birthday.id, school.id, subjects.id]


def test_multi_part_direct_facts_fall_back_if_any_part_is_missing_or_non_fact(service):
    birthday = candidate(service, "The recipient's birthday is July 10.", source="birthday")
    service.confirm_memory(birthday.id)
    assert service._direct_memories("When is my birthday, and what is my school?") is None
    preference = service.db.add_candidate(
        MemoryCandidate(type="preference", content="Prefers YCIS uniforms.", confidence=0.9, source_type="user_statement"),
        source_id="uniform", evidence="I prefer YCIS uniforms.",
    )
    service.confirm_memory(preference.id)
    assert service._direct_memories("When is my birthday, and what do I prefer about YCIS?") is None


def test_multi_part_direct_facts_do_not_bypass_reasoning_questions(service):
    birthday = candidate(service, "The recipient's birthday is July 10.")
    school = candidate(service, "His school is YCIS.", source="school")
    service.confirm_memory(birthday.id); service.confirm_memory(school.id)
    assert service._direct_memories("When is my birthday, and why is my school YCIS?") is None


def test_direct_answer_uses_requested_sentence_not_unrelated_sentence(service):
    memory = candidate(service, "His school is YCIS. His education includes the IGCSE and IB programmes.")
    service.confirm_memory(memory.id)
    result = service.chat("What is my school?")
    assert result.answer == "Your school is YCIS."
