import pytest
from fastapi.testclient import TestClient

from app.main import app, get_service
from app.schemas import MemoryCandidate
from app.service import MemoryService
from app.settings import Settings


@pytest.fixture
def review(tmp_path):
    service = MemoryService(Settings(db_path=tmp_path / "test.db", llm_provider="heuristic", embedding_provider="none"))
    app.dependency_overrides[get_service] = lambda: service
    try:
        with TestClient(app) as client:
            yield service, client
    finally:
        app.dependency_overrides.pop(get_service, None)


def add(service, content="Finished music project", kind="event", source="source-1", evidence="I plan to finish my music project next Friday."):
    return service.db.add_candidate(MemoryCandidate(type=kind, content=content, confidence=0.8), source, evidence)


def test_review_correct_category_then_confirm_retains_all_sources(review):
    service, client = review
    memory = add(service)
    add(service, source="source-2", evidence="It is not finished yet.")
    url = f"/api/v1/memories/{memory.id}"
    response = client.get(url + "/review")
    assert response.status_code == 200
    packet = response.json()
    assert packet["memory"]["status"] == "unconfirmed"
    assert [s["source_id"] for s in packet["sources"]] == ["source-1", "source-2"]
    corrected = "I plan to finish my music project next Friday; it is not finished yet."
    response = client.patch(url, json={"content": corrected, "original_content": memory.content,
                                      "type": "goal", "original_type": "event"})
    assert response.status_code == 200
    assert response.json()["memory"]["status"] == "unconfirmed"
    assert client.get(url + "/review").json()["sources"] == packet["sources"]
    assert service.retrieve("music") == []
    assert service.db.list_open_loops() == []
    assert client.post(url + "/confirm").status_code == 200
    result = service.chat("music")
    assert result.evidence[0].content == corrected
    assert result.evidence[0].type == "goal"
    assert len(result.evidence[0].sources) == 2
    assert service.db.list_open_loops()[0].content == corrected


def test_stale_category_edit_rejected_and_confirmed_memory_locked(review):
    service, client = review
    memory = add(service, content="Music project")
    url = f"/api/v1/memories/{memory.id}"
    edit = dict(content=memory.content, original_content=memory.content, type="goal", original_type="event")
    assert client.patch(url, json=edit).status_code == 200
    assert client.patch(url, json={**edit, "type": "idea"}).status_code == 409
    assert service.db.get_memory(memory.id).type == "goal"
    client.post(url + "/confirm")
    assert client.patch(url, json={**edit, "original_type": "goal"}).status_code == 409


def test_category_change_checks_duplicate_fingerprint(review):
    service, client = review
    memory = add(service, content="Music project")
    add(service, content="Music project", kind="goal", source="other")
    response = client.patch(f"/api/v1/memories/{memory.id}", json={
        "content": memory.content, "original_content": memory.content, "type": "goal", "original_type": "event"})
    assert response.status_code == 409
    assert service.db.get_memory(memory.id).type == "event"


def test_invalid_category_missing_original_and_missing_memory(review):
    service, client = review
    memory = add(service)
    url = f"/api/v1/memories/{memory.id}"
    edit = dict(content=memory.content, original_content=memory.content)
    assert client.patch(url, json={**edit, "type": "invalid", "original_type": "event"}).status_code == 422
    assert client.patch(url, json={**edit, "type": "goal"}).status_code == 409
    assert client.get("/api/v1/memories/missing/review").status_code == 404
