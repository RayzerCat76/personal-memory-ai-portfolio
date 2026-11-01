from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import time

import app.main as main
from app.db import Database
from app.service import MemoryService
from app.settings import Settings


def test_concurrent_first_requests_share_one_service_and_vector_owner(tmp_path, monkeypatch):
    settings = Settings(_env_file=None, db_path=tmp_path/'memory.db',
        vector_path=tmp_path/'vectors', friend_seed_path=tmp_path/'seed.json',
        friend_seed_feedback_path=tmp_path/'feedback.json',
        llm_provider='heuristic', embedding_provider='hash')
    Database(settings.db_path)
    created = []
    def construct(config):
        time.sleep(0.1)  # Keep initial construction in flight for the other request.
        service = MemoryService(config)
        created.append(service)
        return service
    cache = getattr(main, '_cached_service', main.get_service)
    cache.cache_clear()
    monkeypatch.setattr(main, 'get_settings', lambda: settings)
    monkeypatch.setattr(main, 'MemoryService', construct)
    start = Barrier(2)
    def request():
        start.wait()
        return main.get_service()
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = list(pool.map(lambda _: request(), range(2)))
        assert first is second, [s.semantic_error for s in created]
        assert len(created) == 1
        assert first.semantic is not None
        assert first.semantic_error is None
    finally:
        cache.cache_clear()
        for service in created:
            if service.semantic is not None:
                service.semantic.client.close()
