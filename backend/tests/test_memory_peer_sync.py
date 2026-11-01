import sqlite3

from app.peer_sync import PeerApplyItem
from app.schemas import MemoryCandidate
from app.service import MemoryService
from app.settings import Settings


VAULT = "synthetic-memory-vault"


def service(tmp_path, name):
    return MemoryService(Settings(
        db_path=tmp_path / f"{name}.db",
        friend_seed_path=tmp_path / f"{name}-seed.json",
        friend_seed_feedback_path=tmp_path / f"{name}-feedback.json",
        llm_provider="heuristic",
        embedding_provider="none",
    ))


def table_exists(path, name):
    with sqlite3.connect(path) as con:
        return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def bind(target, vault=VAULT):
    target.bind_memory_peer_vault(vault)
    return target


def apply_events(target, events, vault=VAULT):
    bind(target, vault)
    items = [PeerApplyItem(record_id=e.record_id, operation=e.operation, record=e.record) for e in events]
    return target.apply_memory_peer_records(vault, items)


def test_peer_store_is_lazy_and_bootstrap_is_durable(tmp_path):
    a = service(tmp_path, "a")
    assert not table_exists(a.settings.db_path, "memory_peer_outbox")
    memory = a.db.add_candidate(MemoryCandidate(type="fact", content="Synthetic peer fact", confidence=0.8), "source-a", "Synthetic evidence")
    assert memory is not None
    bind(a)
    first = a.memory_peer_outbox(VAULT)
    assert table_exists(a.settings.db_path, "memory_peer_outbox")
    assert any(e.record and e.record.entity_kind == "memory" for e in first.events)
    assert any(e.record and e.record.entity_kind == "evidence" for e in first.events)
    reopened = service(tmp_path, "a")
    bind(reopened)
    second = reopened.memory_peer_outbox(VAULT)
    assert [e.event_id for e in second.events] == [e.event_id for e in first.events]


def test_memory_graph_round_trip_and_no_echo(tmp_path):
    a = service(tmp_path, "a")
    b = service(tmp_path, "b")
    seed = a.db.add_candidate(MemoryCandidate(
        type="goal", content="Finish synthetic peer project", confidence=0.9,
        source_type="friend_seed", subject="synthetic-project",
    ), "friend_seed:peer", "Synthetic source evidence")
    assert seed is not None
    a.db.set_memory_context(seed.id, "Synthetic context note", 0)
    confirmed = a.confirm_memory(seed.id)
    assert confirmed.status == "confirmed"
    loop = a.db.list_open_loops()[0]
    assert loop.id == f"loop_{seed.id}"

    bind(a)
    initial = a.memory_peer_outbox(VAULT)
    result = apply_events(b, initial.events)
    assert result.applied > 0
    a.acknowledge_memory_peer_outbox(VAULT, [e.event_id for e in initial.events])
    bind(a)
    assert a.memory_peer_outbox(VAULT).events == []
    assert b.memory_peer_outbox(VAULT).events == []

    remote = b.db.get_memory(seed.id)
    assert remote.status == "confirmed"
    assert remote.content == seed.content
    assert b.db.get_memory_evidence(seed.id)[0].evidence_text == "Synthetic source evidence"
    active, revision, _history = b.db.get_memory_context(seed.id)
    assert revision == 1 and active and active.note == "Synthetic context note"
    assert b.db.list_open_loops()[0].id == loop.id
    assert [m.id for m in b.retrieve("synthetic peer project")] == [seed.id]


def test_post_bootstrap_changes_are_atomic_and_calibration_syncs(tmp_path):
    a = service(tmp_path, "a")
    bind(a)
    assert a.memory_peer_outbox(VAULT).events == []
    seed = a.db.add_candidate(MemoryCandidate(
        type="preference", content="Synthetic calibration preference", confidence=0.7,
        source_type="friend_seed",
    ), "friend_seed:calibration", "Synthetic calibration evidence")
    assert seed is not None
    events = a.memory_peer_outbox(VAULT).events
    assert len(events) >= 2
    assert {e.record.entity_kind for e in events if e.record} >= {"memory", "evidence"}

    a.friend_seed.save_feedback(seed.id, "sort_of")
    calibration_events = [e for e in a.memory_peer_outbox(VAULT).events if e.record and e.record.entity_kind == "calibration"]
    assert calibration_events and calibration_events[-1].record.value["verdict"] == "sort_of"
    assert a.friend_seed.load_feedback()[seed.id] == "sort_of"

    b = service(tmp_path, "b")
    all_events = a.memory_peer_outbox(VAULT).events
    first = apply_events(b, all_events)
    second = apply_events(b, all_events)
    assert first.applied > 0
    assert second.applied == 0
    assert b.friend_seed.load_feedback()[seed.id] == "sort_of"
    assert b.memory_peer_outbox(VAULT).events == []


def test_rejected_remote_memory_is_never_retrieved(tmp_path):
    a = service(tmp_path, "a")
    b = service(tmp_path, "b")
    bind(a)
    assert a.memory_peer_outbox(VAULT).events == []
    memory = a.db.add_candidate(MemoryCandidate(type="fact", content="Synthetic rejected secret", confidence=0.9), "src", "Synthetic evidence")
    assert memory is not None
    a.reject_memory(memory.id)
    events = a.memory_peer_outbox(VAULT).events
    apply_events(b, events)
    assert b.db.get_memory(memory.id).status == "rejected"
    assert b.retrieve("synthetic rejected secret") == []


def test_vault_binding_allows_empty_rebind_and_blocks_nonempty_rebind(tmp_path):
    empty = service(tmp_path, "empty")
    assert empty.bind_memory_peer_vault("temporary-vault") == "temporary-vault"
    assert empty.bind_memory_peer_vault("joined-vault") == "joined-vault"
    assert empty.memory_peer_outbox("joined-vault").events == []

    occupied = service(tmp_path, "occupied")
    memory = occupied.db.add_candidate(MemoryCandidate(type="fact", content="Vault-bound synthetic fact", confidence=0.8), "source-vault", "evidence")
    assert memory is not None
    occupied.bind_memory_peer_vault("vault-a")
    import pytest
    with pytest.raises(ValueError, match="another peer vault"):
        occupied.bind_memory_peer_vault("vault-b")
    with pytest.raises(ValueError, match="does not match"):
        occupied.memory_peer_outbox("vault-b")
