import copy
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app, get_service
from app.service import MemoryService
from app.settings import Settings


@pytest.fixture
def review(tmp_path):
    service = MemoryService(Settings(db_path=tmp_path/'test.db', embedding_provider='none', llm_provider='heuristic'))
    app.dependency_overrides[get_service] = lambda: service
    payload = dict(unit_id='synthetic-vex', type='event', reviewed=True,
                   content='The recipient asked Ray to reassemble the VEX arena.',
                   source_blocks=[dict(message_id='1', speaker_role='target', create_time=100,
                                       source_chat_json='synthetic.json', text='把场地拼回来')],
                   clarifications=[dict(term='场地', meaning='VEX arena', reviewer='Ray', verbatim_answer='VEX arena')])
    try:
        with TestClient(app) as client:
            yield service, client, payload
    finally:
        app.dependency_overrides.pop(get_service, None)


def test_clarification_survives_review_confirmation_and_retrieval(review):
    service, client, payload = review
    response = client.post('/api/v1/source-review/drafts', json=payload)
    assert response.status_code == 200
    memory = response.json()['memory']
    assert memory['type'] == 'event' and memory['status'] == 'unconfirmed'
    assert service.retrieve('VEX') == []
    assert client.post('/api/v1/source-review/drafts', json=payload).json()['memory']['id'] == memory['id']
    assert service.db.get_memory(memory['id']).evidence_count == 1
    assert client.post(f"/api/v1/memories/{memory['id']}/confirm").status_code == 200
    result = service.chat('VEX')
    evidence = json.loads(result.evidence[0].sources[0].evidence_text)
    assert evidence['human_clarifications'] == payload['clarifications']
    assert evidence['source_blocks'][0]['text'] == '把场地拼回来'
    assert 'VEX' not in evidence['source_blocks'][0]['text']
    assert service.db.list_open_loops() == []


def test_retry_cannot_silently_replace_clarification_or_category(review):
    service, client, payload = review
    first = client.post('/api/v1/source-review/drafts', json=payload).json()['memory']
    for field in ('type', 'clarifications'):
        changed = copy.deepcopy(payload)
        if field == 'type': changed['type'] = 'goal'
        else: changed['clarifications'][0]['meaning'] = 'different arena'
        assert client.post('/api/v1/source-review/drafts', json=changed).status_code == 409
    memory = service.db.get_memory(first['id'])
    assert memory.type == 'event' and memory.evidence_count == 1
    assert json.loads(memory.evidence_text)['human_clarifications'] == payload['clarifications']


def test_unrelated_or_blank_clarification_is_rejected(review):
    service, client, payload = review
    for changes in ({'term':'不存在的词'}, {'meaning':'   '}, {'reviewer':' '}):
        changed = copy.deepcopy(payload)
        changed['clarifications'][0].update(changes)
        assert client.post('/api/v1/source-review/drafts', json=changed).status_code == 422
    assert service.db.list_memories() == []
