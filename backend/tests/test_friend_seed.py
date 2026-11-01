import json
from pathlib import Path

from app.service import MemoryService
from app.settings import Settings


def build_service(tmp_path: Path) -> MemoryService:
    return MemoryService(
        Settings(
            db_path=tmp_path / "test.db",
            vector_path=tmp_path / "vectors",
            friend_seed_path=tmp_path / "friend_seed.json",
            friend_seed_feedback_path=tmp_path / "friend_seed_feedback.json",
            llm_provider="heuristic",
            embedding_provider="none",
        )
    )


def write_seed(path: Path) -> None:
    path.write_text(
        json.dumps(
            [
                {
                    "id": "robotics-role",
                    "type": "preference",
                    "content": "Prefers software roles over mechanical roles in robotics projects",
                    "note": "Ray's observation from working together.",
                    "importance": 0.8,
                },
                {
                    "id": "f1",
                    "type": "interest",
                    "content": "Likes Formula 1",
                    "note": "Ray remembers this coming up often.",
                },
            ]
        ),
        encoding="utf-8",
    )


def test_friend_seed_import_is_local_unconfirmed_and_idempotent(tmp_path: Path):
    service = build_service(tmp_path)
    write_seed(service.settings.friend_seed_path)

    first = service.import_friend_seed()
    second = service.import_friend_seed()

    assert first.file_found is True
    assert first.imported == 2
    assert first.skipped == 0
    assert all(memory.source_type == "friend_seed" for memory in first.memories)
    assert all(memory.status == "unconfirmed" for memory in first.memories)

    assert second.imported == 0
    assert second.skipped == 2
    assert len(service.db.list_memories()) == 2


def test_friend_seed_calibration_controls_retrieval(tmp_path: Path):
    service = build_service(tmp_path)
    write_seed(service.settings.friend_seed_path)
    imported = service.import_friend_seed().memories
    robotics = next(memory for memory in imported if "software roles" in memory.content)
    formula_one = next(memory for memory in imported if "Formula 1" in memory.content)

    # 'Sort of' is remembered as feedback but is still not trusted for answers.
    sort_of = service.calibrate_friend_seed(robotics.id, "sort_of")
    assert sort_of.status == "unconfirmed"
    assert service.friend_seed_feedback()[robotics.id] == "sort_of"
    assert service.chat("What kind of work do I prefer?").evidence == []

    accurate = service.calibrate_friend_seed(robotics.id, "accurate")
    assert accurate.status == "confirmed"
    assert service.friend_seed_feedback()[robotics.id] == "accurate"
    assert service.chat("Do I prefer software roles?").evidence

    slander = service.calibrate_friend_seed(formula_one.id, "slander")
    assert slander.status == "rejected"
    assert service.friend_seed_feedback()[formula_one.id] == "slander"
    assert service.chat("Do I like Formula 1?").evidence == []
