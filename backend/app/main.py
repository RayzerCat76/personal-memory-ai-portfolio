from functools import lru_cache
from threading import Lock

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

from .backup import MemoryBackupPayload, MemoryBackupRestoreResponse
from .llm import MemoryExtractionError
from .peer_sync import PeerApplyRequest, PeerApplyResponse, PeerOutboxAck, PeerOutboxResponse, PeerVaultBinding

from .schemas import (
    ChatRequest,
    ChatResponse,
    FriendSeedFeedbackResponse,
    FriendSeedImportResponse,
    ImportMessagesRequest,
    ImportMessagesResponse,
    MemoryCalibrationRequest,
    MemoryCalibrationResponse,
    MemoryContextNoteRequest,
    MemoryContextReviewResponse,
    MemoryRead,
    MemoryCorrection,
    MemoryReviewResponse,
    MemoryCandidate,
    SourceReviewDraft,
    MemoryStatusResponse,
    MessageCreate,
    MessageResponse,
    OpenLoopRead,
    OpenLoopStatusResponse,
    ResolutionProposalStatusResponse,
)
from .service import MemoryService
from .settings import Settings, get_settings

app = FastAPI(
    title="Personal Memory AI",
    version="0.4.0",
    description="Private, inspectable personal-memory backend.",
)


@app.exception_handler(MemoryExtractionError)
async def extraction_failed(request, exc):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


_service_lock = Lock()


@lru_cache
def _cached_service() -> MemoryService:
    return MemoryService(get_settings())


def get_service() -> MemoryService:
    # lru_cache alone allows duplicate construction on concurrent cache misses.
    # Keep one SQLite/service instance and one local Qdrant owner per process.
    with _service_lock:
        return _cached_service()


@app.get("/health")
def health(
    settings: Settings = Depends(get_settings),
    service: MemoryService = Depends(get_service),
):
    return {
        "status": "ok",
        "step": "7-of-9-birthday-experience",
        "llm_provider": settings.llm_provider,
        "mlx_extraction_thinking": settings.mlx_extraction_thinking if settings.llm_provider.lower() == "mlx" else None,
        "embedding_provider": settings.embedding_provider,
        "embedding_model": settings.embedding_model if settings.embedding_provider != "none" else None,
        "semantic_error": service.semantic_error,
    }


@app.post("/api/v1/messages", response_model=MessageResponse)
def ingest_message(payload: MessageCreate, service: MemoryService = Depends(get_service)):
    return service.ingest_message(payload.content)


@app.post("/api/v1/imports/messages", response_model=ImportMessagesResponse)
def import_messages(
    payload: ImportMessagesRequest,
    service: MemoryService = Depends(get_service),
):
    return service.import_messages(payload)


@app.post("/api/v1/source-review/drafts", response_model=MemoryStatusResponse)
def save_source_review(payload: SourceReviewDraft, service: MemoryService = Depends(get_service)):
    content = payload.content.strip()
    if not content or len({b.message_id for b in payload.source_blocks}) != len(payload.source_blocks):
        raise HTTPException(status_code=422, detail="Write a memory and supply distinct source messages")
    if not any(b.text.strip() and not b.text.strip().startswith(("[voice]", "[image]", "[video", "[media:", "[emoji]")) for b in payload.source_blocks):
        raise HTTPException(status_code=422, detail="This source needs media or transcript review first")
    import json
    if any(not any(c.term in b.text for b in payload.source_blocks) for c in payload.clarifications):
        raise HTTPException(status_code=422, detail="Clarification must reference a term in the selected source messages")
    evidence_record = {"kind": "user_reviewed_import", "unit_id": payload.unit_id,
                       "source_blocks": [b.model_dump() for b in payload.source_blocks]}
    if payload.clarifications:
        evidence_record["human_clarifications"] = [c.model_dump() for c in payload.clarifications]
    evidence = json.dumps(evidence_record, ensure_ascii=False)
    try:
        memory = service.db.add_candidate(MemoryCandidate(type=payload.type, content=content,
            confidence=0.5, source_type="conversation_import"),
            source_id="source-review:" + payload.unit_id, evidence=evidence, source_review=True)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return MemoryStatusResponse(memory=memory)


@app.get("/api/v1/backups/memory", response_model=MemoryBackupPayload)
def export_memory_backup(service: MemoryService = Depends(get_service)):
    return service.export_memory_backup()


@app.post("/api/v1/backups/memory/restore", response_model=MemoryBackupRestoreResponse)
def restore_memory_backup(
    payload: MemoryBackupPayload,
    service: MemoryService = Depends(get_service),
):
    try:
        return service.restore_memory_backup(payload)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.get("/api/v1/peer-sync/memory/local-state")
def memory_peer_local_state(service: MemoryService = Depends(get_service)):
    return service.memory_peer_local_state()


@app.post("/api/v1/peer-sync/memory/bind")
def memory_peer_bind(payload: PeerVaultBinding, service: MemoryService = Depends(get_service)):
    try:
        return {"vault_id": service.bind_memory_peer_vault(payload.vault_id)}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.get("/api/v1/peer-sync/memory/outbox", response_model=PeerOutboxResponse)
def memory_peer_outbox(vault_id: str = Query(min_length=1, max_length=500), service: MemoryService = Depends(get_service)):
    try:
        return service.memory_peer_outbox(vault_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.post("/api/v1/peer-sync/memory/ack")
def memory_peer_ack(payload: PeerOutboxAck, service: MemoryService = Depends(get_service)):
    try:
        return {"acknowledged": service.acknowledge_memory_peer_outbox(payload.vault_id, payload.event_ids)}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.post("/api/v1/peer-sync/memory/apply", response_model=PeerApplyResponse)
def memory_peer_apply(payload: PeerApplyRequest, service: MemoryService = Depends(get_service)):
    try:
        return service.apply_memory_peer_records(payload.vault_id, payload.items)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.post("/api/v1/gift/seed/import", response_model=FriendSeedImportResponse)
def import_friend_seed(service: MemoryService = Depends(get_service)):
    return service.import_friend_seed()


@app.get("/api/v1/gift/seed/feedback", response_model=FriendSeedFeedbackResponse)
def friend_seed_feedback(service: MemoryService = Depends(get_service)):
    return FriendSeedFeedbackResponse(feedback=service.friend_seed_feedback())


@app.post(
    "/api/v1/memories/{memory_id}/calibrate",
    response_model=MemoryCalibrationResponse,
)
def calibrate_memory(
    memory_id: str,
    payload: MemoryCalibrationRequest,
    service: MemoryService = Depends(get_service),
):
    try:
        memory = service.calibrate_friend_seed(memory_id, payload.verdict)
    except KeyError:
        raise HTTPException(status_code=404, detail="Memory not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return MemoryCalibrationResponse(verdict=payload.verdict, memory=memory)


@app.get("/api/v1/memories", response_model=list[MemoryRead])
def list_memories(
    status: str | None = Query(default=None),
    service: MemoryService = Depends(get_service),
):
    if status not in {None, "unconfirmed", "confirmed", "rejected", "superseded"}:
        raise HTTPException(status_code=400, detail="Invalid memory status")
    return service.db.list_memories(status=status, limit=5000)


@app.get("/api/v1/memories/{memory_id}/review", response_model=MemoryReviewResponse)
def review_memory(memory_id: str, service: MemoryService = Depends(get_service)):
    try:
        memory = service.db.get_memory(memory_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Memory not found")
    return MemoryReviewResponse(memory=memory, sources=service.db.get_memory_evidence(memory_id))


@app.get("/api/v1/memories/{memory_id}/context", response_model=MemoryContextReviewResponse)
def get_memory_context(memory_id: str, service: MemoryService = Depends(get_service)):
    try:
        active, revision, history = service.db.get_memory_context(memory_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Memory not found")
    return MemoryContextReviewResponse(active=active, current_revision=revision, history=history)


@app.put("/api/v1/memories/{memory_id}/context", response_model=MemoryContextReviewResponse)
def set_memory_context(memory_id: str, payload: MemoryContextNoteRequest, service: MemoryService = Depends(get_service)):
    try:
        active, revision, history = service.db.set_memory_context(memory_id, payload.note, payload.expected_revision)
    except KeyError:
        raise HTTPException(status_code=404, detail="Memory not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return MemoryContextReviewResponse(active=active, current_revision=revision, history=history)


@app.patch("/api/v1/memories/{memory_id}", response_model=MemoryStatusResponse)
def correct_memory(memory_id: str, payload: MemoryCorrection, service: MemoryService = Depends(get_service)):
    if not payload.content.strip():
        raise HTTPException(status_code=422, detail="Correction cannot be blank")
    try:
        memory = service.db.correct_memory(memory_id, payload.content, payload.original_content,
                                          memory_type=payload.type, original_type=payload.original_type)
    except KeyError:
        raise HTTPException(status_code=404, detail="Memory not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return MemoryStatusResponse(memory=memory)


@app.post("/api/v1/memories/{memory_id}/confirm", response_model=MemoryStatusResponse)
def confirm_memory(memory_id: str, service: MemoryService = Depends(get_service)):
    try:
        memory = service.confirm_memory(memory_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Memory not found")
    return MemoryStatusResponse(memory=memory)


@app.post("/api/v1/memories/{memory_id}/reject", response_model=MemoryStatusResponse)
def reject_memory(memory_id: str, service: MemoryService = Depends(get_service)):
    try:
        memory = service.reject_memory(memory_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Memory not found")
    return MemoryStatusResponse(memory=memory)


@app.get("/api/v1/open-loops", response_model=list[OpenLoopRead])
def list_open_loops(
    status: str = Query(default="active"),
    service: MemoryService = Depends(get_service),
):
    if status not in {"active", "completed", "cancelled"}:
        raise HTTPException(status_code=400, detail="Invalid open-loop status")
    return service.db.list_open_loops(status=status)


@app.post("/api/v1/open-loops/{loop_id}/complete", response_model=OpenLoopStatusResponse)
def complete_open_loop(loop_id: str, service: MemoryService = Depends(get_service)):
    try:
        loop = service.db.set_open_loop_status(loop_id, "completed")
    except KeyError:
        raise HTTPException(status_code=404, detail="Open loop not found")
    return OpenLoopStatusResponse(open_loop=loop)


@app.post("/api/v1/open-loops/{loop_id}/cancel", response_model=OpenLoopStatusResponse)
def cancel_open_loop(loop_id: str, service: MemoryService = Depends(get_service)):
    try:
        loop = service.db.set_open_loop_status(loop_id, "cancelled")
    except KeyError:
        raise HTTPException(status_code=404, detail="Open loop not found")
    return OpenLoopStatusResponse(open_loop=loop)


@app.post(
    "/api/v1/resolution-proposals/{proposal_id}/accept",
    response_model=ResolutionProposalStatusResponse,
)
def accept_resolution_proposal(
    proposal_id: str,
    service: MemoryService = Depends(get_service),
):
    try:
        proposal, loop = service.db.resolve_proposal(proposal_id, accept=True)
    except KeyError:
        raise HTTPException(status_code=404, detail="Resolution proposal not found")
    return ResolutionProposalStatusResponse(proposal=proposal, open_loop=loop)


@app.post(
    "/api/v1/resolution-proposals/{proposal_id}/reject",
    response_model=ResolutionProposalStatusResponse,
)
def reject_resolution_proposal(
    proposal_id: str,
    service: MemoryService = Depends(get_service),
):
    try:
        proposal, loop = service.db.resolve_proposal(proposal_id, accept=False)
    except KeyError:
        raise HTTPException(status_code=404, detail="Resolution proposal not found")
    return ResolutionProposalStatusResponse(proposal=proposal, open_loop=loop)


@app.post("/api/v1/chat", response_model=ChatResponse)
def chat(payload: ChatRequest, service: MemoryService = Depends(get_service)):
    return service.chat(payload.message)
