import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from test_friend_seed import build_service


def concurrent_import(service, monkeypatch):
    original = service.db.list_memories
    barrier = Barrier(2)
    def simultaneous_snapshot(*args, **kwargs):
        result = original(*args, **kwargs)
        barrier.wait(timeout=5)
        return result
    with monkeypatch.context() as patch:
        patch.setattr(service.db, 'list_memories', simultaneous_snapshot)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(service.import_friend_seed) for _ in range(2)]
            return [f.result(timeout=10) for f in futures]


def test_concurrent_seed_import_is_once(tmp_path, monkeypatch):
    service = build_service(tmp_path)
    service.settings.friend_seed_path.write_text(json.dumps([
        {'id':'tea','type':'preference','content':'Prefers tea','note':'Original seed evidence'}]))
    results = concurrent_import(service, monkeypatch)
    assert sum(r.imported for r in results) == 1
    assert sum(r.skipped for r in results) == 1
    memory, = service.db.list_memories()
    assert memory.evidence_count == 1
    service.db.correct_memory(memory.id, 'Prefers herbal tea', memory.content)
    service.confirm_memory(memory.id)
    repeated = concurrent_import(service, monkeypatch)
    assert all(r.imported == 0 for r in repeated)
    memory, = service.db.list_memories()
    assert memory.content == 'Prefers herbal tea'
    assert memory.status == 'confirmed'
    assert memory.evidence_count == 1
    assert memory.evidence_text == 'Original seed evidence'
    service.reject_memory(memory.id)
    assert service.import_friend_seed().imported == 0
