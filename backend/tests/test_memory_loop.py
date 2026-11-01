from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app, get_service
from app.schemas import ImportMessage, ImportMessagesRequest
from app.service import MemoryService
from app.settings import Settings


def build_service(tmp_path: Path) -> MemoryService:
    return MemoryService(
        Settings(
            db_path=tmp_path / "test.db",
            vector_path=tmp_path / "vectors",
            llm_provider="heuristic",
            embedding_provider="none",
            max_retrieval=6,
        )
    )


def test_end_to_end_memory_loop(tmp_path: Path):
    service = build_service(tmp_path)
    app.dependency_overrides[get_service] = lambda: service
    client = TestClient(app)

    ingest = client.post(
        "/api/v1/messages",
        json={"content": "I prefer Python over Java for personal projects."},
    )
    assert ingest.status_code == 200
    candidates = ingest.json()["candidate_memories"]
    assert len(candidates) >= 1
    memory_id = candidates[0]["id"]
    assert candidates[0]["status"] == "unconfirmed"

    before = client.post(
        "/api/v1/chat",
        json={"message": "What programming language do I prefer?"},
    )
    assert before.status_code == 200
    assert before.json()["evidence"] == []

    confirm = client.post(f"/api/v1/memories/{memory_id}/confirm")
    assert confirm.status_code == 200
    assert confirm.json()["memory"]["status"] == "confirmed"

    after = client.post(
        "/api/v1/chat",
        json={"message": "Do I prefer Python or Java?"},
    )
    assert after.status_code == 200
    payload = after.json()
    assert payload["evidence"]
    assert payload["evidence"][0]["memory_id"] == memory_id
    assert "Python" in payload["answer"] or "python" in payload["answer"].lower()

    app.dependency_overrides.clear()


def test_rejected_memory_is_not_retrieved(tmp_path: Path):
    service = build_service(tmp_path)
    response = service.ingest_message("I love Formula 1.")
    memory = response.candidate_memories[0]
    service.db.set_status(memory.id, "rejected")

    result = service.chat("Do I like Formula 1?")
    assert result.evidence == []


def test_duplicate_memory_accumulates_evidence(tmp_path: Path):
    service = build_service(tmp_path)

    first = service.ingest_message("I love Formula 1.").candidate_memories[0]
    second = service.ingest_message("I love Formula 1.").candidate_memories[0]

    assert first.id == second.id
    assert second.evidence_count == 2


def test_confirmed_commitment_becomes_open_loop(tmp_path: Path):
    service = build_service(tmp_path)

    response = service.ingest_message("I need to send Kevin the robotics document.")
    memory = response.candidate_memories[0]
    service.db.set_status(memory.id, "confirmed")

    loops = service.db.list_open_loops("active")
    assert len(loops) == 1
    assert loops[0].memory_id == memory.id
    assert loops[0].kind == "commitment"


def test_resolution_is_proposed_then_accepted(tmp_path: Path):
    service = build_service(tmp_path)

    response = service.ingest_message("I need to send Kevin the robotics document.")
    memory = response.candidate_memories[0]
    service.db.set_status(memory.id, "confirmed")

    resolved_message = service.ingest_message("I sent Kevin the robotics document.")
    assert len(resolved_message.resolution_proposals) == 1
    proposal = resolved_message.resolution_proposals[0]
    assert proposal.proposed_status == "completed"
    assert proposal.status == "pending"

    active_before = service.db.list_open_loops("active")
    assert len(active_before) == 1

    accepted, loop = service.db.resolve_proposal(proposal.id, accept=True)
    assert accepted.status == "accepted"
    assert loop is not None
    assert loop.status == "completed"
    assert service.db.list_open_loops("active") == []


def test_decision_supersedes_matching_goal(tmp_path: Path):
    service = build_service(tmp_path)

    goal_response = service.ingest_message("I want to join robotics.")
    goal = goal_response.candidate_memories[0]
    service.db.set_status(goal.id, "confirmed")
    assert len(service.db.list_open_loops("active")) == 1

    decision_response = service.ingest_message("I decided to join robotics.")
    decision = next(m for m in decision_response.candidate_memories if m.type == "decision")
    service.db.set_status(decision.id, "confirmed")

    assert service.db.get_memory(goal.id).status == "superseded"
    assert service.db.get_memory(decision.id).status == "confirmed"
    assert service.db.list_open_loops("active") == []


def test_chat_import_only_extracts_subject_messages(tmp_path: Path):
    service = build_service(tmp_path)
    request = ImportMessagesRequest(
        source_name="sample-wechat-export",
        subject_speakers=["Alex"],
        messages=[
            ImportMessage(speaker="Ray", content="I love basketball."),
            ImportMessage(speaker="Alex", content="I love Formula 1."),
            ImportMessage(speaker="Alex", content="I want to learn Rust."),
        ],
    )

    result = service.import_messages(request)

    assert result.messages_received == 3
    assert result.messages_stored == 3
    assert result.subject_messages_processed == 2
    assert len(result.candidate_memories) == 2
    assert all(memory.source_type == "conversation_import" for memory in result.candidate_memories)
    assert all(memory.subject == "Alex" for memory in result.candidate_memories)
    assert all("basketball" not in memory.content.lower() for memory in result.candidate_memories)


def test_chat_import_is_idempotent_per_source(tmp_path: Path):
    service = build_service(tmp_path)
    request = ImportMessagesRequest(
        source_name="same-export",
        subject_speakers=["Alex"],
        messages=[ImportMessage(speaker="Alex", content="I love Formula 1.")],
    )

    first = service.import_messages(request)
    second = service.import_messages(request)

    assert first.messages_stored == 1
    assert second.messages_stored == 0
    assert second.duplicate_messages_skipped == 1


def test_hash_vector_index_round_trip(tmp_path: Path):
    service = MemoryService(
        Settings(
            db_path=tmp_path / "semantic.db",
            vector_path=tmp_path / "semantic-vectors",
            llm_provider="heuristic",
            embedding_provider="hash",
            max_retrieval=6,
        )
    )

    memory = service.ingest_message("I love Formula 1.").candidate_memories[0]
    confirmed = service.confirm_memory(memory.id)

    assert service.semantic is not None
    hits = service.semantic.search("Formula 1", limit=3)
    assert hits
    assert hits[0][0] == confirmed.id


def test_prefer_rather_than_is_extracted(tmp_path: Path):
    service = build_service(tmp_path)

    response = service.ingest_message(
        "I prefer writing software rather than working on mechanical systems in robotics projects."
    )

    assert len(response.candidate_memories) == 1
    memory = response.candidate_memories[0]
    assert memory.type == "preference"
    assert "writing software" in memory.content.lower()
    assert "mechanical systems" in memory.content.lower()
