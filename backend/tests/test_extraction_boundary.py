import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.llm import MLXProvider, MemoryExtractionError
from app.main import app, get_service
from app.schemas import ImportMessage, ImportMessagesRequest
from app.service import MemoryService
from app.settings import Settings


VALID = dict(type="interest", content="I enjoy cello music.", confidence=0.8,
             source_type="user_statement", importance=0.5)


def extract(raw):
    provider = MLXProvider("unused")
    with patch.object(provider, "_generate", return_value=raw):
        return provider.extract_memories("I enjoy cello music.")


@pytest.mark.parametrize("raw", [
    'Example: ' + json.dumps([VALID]),
    '```json\n' + json.dumps([VALID]) + '\n```',
    json.dumps([VALID]) + ' extra explanation',
    json.dumps([VALID])[:-1],
    '[{"type":"fact","type":"interest","content":"cello","confidence":0.8,"source_type":"user_statement","importance":0.5}]',
])
def test_ambiguous_or_incomplete_output_is_not_salvaged(raw):
    with pytest.raises(MemoryExtractionError):
        extract(raw)


@pytest.mark.parametrize("changes", [
    {"source_type": "friend_seed"}, {"source_type": "conversation_import"},
    {"content": "   "}, {"confidence": True}, {"importance": "0.5"},
    {"confidence": float("nan")}, {"importance": float("inf")},
    {"status": "confirmed"}, {"subject": "invented speaker"},
])
def test_model_cannot_forge_metadata_or_invalid_values(changes):
    with pytest.raises(MemoryExtractionError):
        extract(json.dumps([{**VALID, **changes}]))


def test_invalid_record_rejects_batch_and_empty_array_is_valid():
    incomplete = {k: v for k, v in VALID.items() if k != "source_type"}
    with pytest.raises(MemoryExtractionError):
        extract(json.dumps([VALID, None, incomplete]))
    assert extract("[]") == []


def test_model_extraction_stays_unconfirmed_and_keeps_original_source(tmp_path):
    service = MemoryService(Settings(
        db_path=tmp_path / "memory.db", vector_path=tmp_path / "vectors",
        llm_provider="mlx", embedding_provider="none",
        friend_seed_path=tmp_path / "seed.json",
        friend_seed_feedback_path=tmp_path / "feedback.json",
    ))
    original = "I enjoy cello music."
    with patch.object(service.llm, "_generate", return_value=json.dumps([VALID])):
        response = service.ingest_message(original)
    memory = response.candidate_memories[0]
    assert memory.status == "unconfirmed"
    assert service.retrieve("cello") == []
    source = service.db.get_memory_evidence(memory.id)[0]
    assert (source.source_id, source.evidence_text) == (response.message_id, original)
    service.confirm_memory(memory.id)
    assert [m.id for m in service.retrieve("cello")] == [memory.id]


def test_failed_import_resumes_without_skipping_failed_message(tmp_path):
    service = MemoryService(Settings(db_path=tmp_path / "test.db",
                                    embedding_provider="none", llm_provider="heuristic"))
    request = ImportMessagesRequest(source_name="synthetic", subject_speakers=["Alex"], messages=[
        ImportMessage(speaker="Ray", content="Hello!", external_id="1"),
        ImportMessage(speaker="Alex", content="I enjoy cello music.", external_id="2"),
    ])
    with patch.object(service.importer, "extract_candidates", side_effect=MemoryExtractionError("retry")):
        with pytest.raises(MemoryExtractionError):
            service.import_messages(request)
    with service.db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM imported_messages").fetchone()[0] == 1
    with patch.object(service.importer, "extract_candidates", return_value=extract(json.dumps([VALID]))) as infer:
        result = service.import_messages(request)
        assert result.duplicate_messages_skipped == 1
        assert result.messages_stored == 1
        assert len(result.candidate_memories) == 1
        infer.assert_called_once_with("I enjoy cello music.")
    with patch.object(service.importer, "extract_candidates", side_effect=AssertionError("No repeated inference")):
        again = service.import_messages(request)
        assert again.duplicate_messages_skipped == 2


def test_failed_message_returns_retry_error_without_database_write(tmp_path):
    service = MemoryService(Settings(db_path=tmp_path / "test.db",
                                    embedding_provider="none", llm_provider="heuristic"))
    app.dependency_overrides[get_service] = lambda: service
    try:
        with patch.object(service, "_extract_candidates", side_effect=MemoryExtractionError("Please retry.")):
            with TestClient(app) as client:
                response = client.post("/api/v1/messages", json={"content": "I enjoy cello music."})
        assert response.status_code == 503
        assert response.json() == {"detail": "Please retry."}
        with service.db.connect() as con:
            assert con.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
            assert con.execute("SELECT COUNT(*) FROM memories").fetchone()[0] == 0
    finally:
        app.dependency_overrides.pop(get_service, None)
