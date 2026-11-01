import pytest
from fastapi.testclient import TestClient
from app.main import app, get_service
from app.service import MemoryService
from app.settings import Settings


@pytest.fixture
def review(tmp_path):
    settings = Settings(db_path=tmp_path/'test.db', vector_path=tmp_path/'vectors',
        friend_seed_path=tmp_path/'seed.json', friend_seed_feedback_path=tmp_path/'feedback.json',
        llm_provider='heuristic', embedding_provider='none')
    service = MemoryService(settings)
    app.dependency_overrides[get_service] = lambda: service
    try:
        with TestClient(app) as client:
            yield service, client, settings
    finally:
        app.dependency_overrides.clear()


def test_correct_then_explicitly_confirm(review):
    service, client, settings = review
    source = 'I prefer Python over Java for personal projects.'
    memory = service.ingest_message(source).candidate_memories[0]
    with service.db.connect() as con:
        evidence_before = [tuple(r) for r in con.execute('SELECT * FROM memory_evidence')]
    corrected = 'I prefer Rust over Java for personal projects.'
    response = client.patch(f'/api/v1/memories/{memory.id}', json={'content':corrected,'original_content':memory.content})
    assert response.status_code == 200
    result = response.json()['memory']
    assert result['content'] == corrected and result['status'] == 'unconfirmed'
    assert result['evidence_text'] == source and result['source_id'] == memory.source_id
    restarted = MemoryService(settings)
    assert restarted.db.get_memory(memory.id).content == corrected
    assert restarted.chat('Rust').evidence == []
    with restarted.db.connect() as con:
        assert [tuple(r) for r in con.execute('SELECT * FROM memory_evidence')] == evidence_before
    assert client.post(f'/api/v1/memories/{memory.id}/confirm').status_code == 200
    assert restarted.db.search_confirmed('Rust', 6)[0].id == memory.id
    assert restarted.db.search_confirmed('Python', 6) == []


def test_reject_invalid_stale_and_confirmed_edits(review):
    service, client, _ = review
    memory = service.ingest_message('I love Formula 1.').candidate_memories[0]
    url = f'/api/v1/memories/{memory.id}'
    for content in ('', '   ', 'x'*20001):
        assert client.patch(url,json={'content':content,'original_content':memory.content}).status_code == 422
    assert client.patch(url,json={'content':'New wording','original_content':memory.content,'evidence_text':'forged'}).status_code == 422
    assert client.patch(url,json={'content':'New wording','original_content':'stale'}).status_code == 409
    assert service.db.get_memory(memory.id).content == memory.content
    assert client.patch('/api/v1/memories/missing',json={'content':'New','original_content':'Old'}).status_code == 404
    service.confirm_memory(memory.id)
    assert client.patch(url,json={'content':'New wording','original_content':memory.content}).status_code == 409


def test_duplicate_correction_does_not_merge_evidence(review):
    service, client, _ = review
    first = service.ingest_message('I prefer tea over coffee.').candidate_memories[0]
    second = service.ingest_message('I prefer Python over Java.').candidate_memories[0]
    assert client.patch(f'/api/v1/memories/{second.id}',json={'content':first.content,'original_content':second.content}).status_code == 409
    assert service.db.get_memory(second.id).content == second.content


def test_sort_of_seed_can_be_corrected_before_confirmation(review):
    from test_friend_seed import write_seed
    service, client, settings = review
    write_seed(settings.friend_seed_path)
    seed = service.import_friend_seed().memories[0]
    service.calibrate_friend_seed(seed.id, 'sort_of')
    response = client.patch(f'/api/v1/memories/{seed.id}', json={
        'content':'Prefers design tasks in robotics projects', 'original_content':seed.content})
    assert response.status_code == 200
    assert response.json()['memory']['status'] == 'unconfirmed'
    assert service.chat('robotics design').evidence == []
    service.calibrate_friend_seed(seed.id, 'accurate')
    assert service.db.get_memory(seed.id).status == 'confirmed'
    assert service.db.get_memory(seed.id).content == 'Prefers design tasks in robotics projects'
