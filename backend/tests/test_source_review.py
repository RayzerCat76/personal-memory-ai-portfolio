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
            yield service, client
    finally:
        app.dependency_overrides.clear()

def payload():
    return dict(unit_id='synthetic-review', content='I plan to repair my bicycle tomorrow.', reviewed=True,
        source_blocks=[dict(message_id='test-1',speaker_role='target',speaker_display_name='Test sender',
            create_time=1700000000,source_chat_json='synthetic.json',text='Tomorrow I plan to repair my bicycle.')])

def test_draft_requires_separate_confirmation_and_preserves_evidence(review):
    service, client = review
    result = client.post('/api/v1/source-review/drafts',json=payload())
    assert result.status_code == 200
    memory = result.json()['memory']
    assert memory['status'] == 'unconfirmed'
    assert service.db.search_confirmed('bicycle',6) == []
    evidence = memory['evidence_text']
    assert 'test-1' in evidence and 'synthetic.json' in evidence
    corrected='I plan to repair my bicycle next week.'
    assert client.patch('/api/v1/memories/'+memory['id'],json=dict(content=corrected,original_content=memory['content'])).status_code==200
    assert service.db.get_memory(memory['id']).evidence_text==evidence
    assert client.post('/api/v1/memories/'+memory['id']+'/confirm').status_code==200
    assert service.db.search_confirmed('bicycle',6)[0].content==corrected

def test_retry_and_duplicate_do_not_change_existing_evidence(review):
    service,client=review
    first=client.post('/api/v1/source-review/drafts',json=payload()).json()['memory']
    assert client.post('/api/v1/source-review/drafts',json=payload()).json()['memory']['id']==first['id']
    assert service.db.get_memory(first['id']).evidence_count==1
    other=payload();other['unit_id']='other-source'
    assert client.post('/api/v1/source-review/drafts',json=other).status_code==409
    other=payload();other['content']='Different wording.'
    assert client.post('/api/v1/source-review/drafts',json=other).status_code==409
    assert service.db.get_memory(first['id']).evidence_count==1

def test_unreviewed_blank_media_and_wrong_author_rejected(review):
    service,client=review
    variants=[]
    for change in [dict(reviewed=False),dict(content='   '),dict(status='confirmed')]:
        body=payload();body.update(change);variants.append(body)
    for field,value in [('speaker_role','self'),('text','[voice]')]:
        body=payload();body['source_blocks'][0][field]=value;variants.append(body)
    body=payload();body['source_blocks']*=2;variants.append(body)
    for body in variants:
        assert client.post('/api/v1/source-review/drafts',json=body).status_code==422
    with service.db.connect() as con:
        assert con.execute('SELECT COUNT(*) FROM memories').fetchone()[0]==0
