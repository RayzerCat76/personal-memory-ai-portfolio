from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

MemoryStatus = Literal["unconfirmed", "confirmed", "rejected", "superseded"]
MemoryCalibration = Literal["accurate", "sort_of", "slander"]
MemoryType = Literal[
    "fact",
    "preference",
    "interest",
    "person",
    "relationship",
    "event",
    "project",
    "goal",
    "idea",
    "decision",
    "commitment",
    "opinion",
    "experience",
    "routine",
    "inside_joke",
]
SourceType = Literal[
    "user_statement",
    "user_confirmed",
    "conversation_import",
    "friend_seed",
    "system_inference",
    "document",
    "manual_entry",
]
OpenLoopStatus = Literal["active", "completed", "cancelled"]
ResolutionProposalStatus = Literal["pending", "accepted", "rejected"]
MemoryContextNoteStatus = Literal["active", "superseded", "cleared"]


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)


class MemoryCorrection(BaseModel):
    model_config = {"extra": "forbid"}
    content: str = Field(min_length=1, max_length=20_000)
    original_content: str = Field(min_length=1, max_length=20_000)
    type: MemoryType | None = None
    original_type: MemoryType | None = None


class SourceReviewBlock(BaseModel):
    model_config = {"extra": "forbid"}
    message_id: str = Field(min_length=1, max_length=200)
    speaker_role: Literal["target"]
    speaker_display_name: str | None = Field(default=None, max_length=500)
    create_time: int
    source_chat_json: str = Field(min_length=1, max_length=2000)
    text: str = Field(min_length=1, max_length=20_000)


class SourceClarification(BaseModel):
    model_config = {"extra": "forbid"}
    term: str = Field(min_length=1, max_length=500)
    meaning: str = Field(min_length=1, max_length=2000)
    reviewer: str = Field(min_length=1, max_length=200)
    verbatim_answer: str = Field(min_length=1, max_length=5000)

    @field_validator("term", "meaning", "reviewer", "verbatim_answer")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Clarification fields cannot be blank")
        return value


class SourceReviewDraft(BaseModel):
    model_config = {"extra": "forbid"}
    unit_id: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000)
    reviewed: Literal[True]
    source_blocks: list[SourceReviewBlock] = Field(min_length=1, max_length=40)
    type: MemoryType = "fact"
    clarifications: list[SourceClarification] = Field(default_factory=list, max_length=10)


class MemoryCandidate(BaseModel):
    type: MemoryType
    content: str
    confidence: float = Field(ge=0.0, le=1.0)
    source_type: SourceType = "system_inference"
    importance: float = Field(default=0.5, ge=0.0, le=1.0)
    subject: str | None = None


class MemoryRead(BaseModel):
    id: str
    type: MemoryType
    content: str
    status: MemoryStatus
    confidence: float
    confidence_label: str
    source_type: SourceType
    source_id: str | None = None
    importance: float
    subject: str | None = None
    calibration: MemoryCalibration | None = None
    created_at: datetime
    updated_at: datetime
    evidence_text: str | None = None
    evidence_count: int = 1
    active_context_note: str | None = None
    context_revision: int = 0


class OpenLoopRead(BaseModel):
    id: str
    memory_id: str
    kind: Literal["goal", "commitment"]
    content: str
    status: OpenLoopStatus
    created_at: datetime
    resolved_at: datetime | None = None
    resolution_message_id: str | None = None


class ResolutionCandidate(BaseModel):
    target_text: str
    proposed_status: Literal["completed", "cancelled"]
    confidence: float = Field(ge=0.0, le=1.0)


class ResolutionProposalRead(BaseModel):
    id: str
    open_loop_id: str
    message_id: str
    proposed_status: Literal["completed", "cancelled"]
    confidence: float
    evidence_text: str
    status: ResolutionProposalStatus
    created_at: datetime
    updated_at: datetime


class MessageResponse(BaseModel):
    message_id: str
    candidate_memories: list[MemoryRead]
    resolution_proposals: list[ResolutionProposalRead] = Field(default_factory=list)


class MemoryEvidenceRead(BaseModel):
    source_id: str | None
    evidence_text: str
    created_at: datetime


class MemoryContextNoteRequest(BaseModel):
    model_config = {"extra": "forbid"}
    note: str = Field(default="", max_length=5000)
    expected_revision: int = Field(ge=0)


class MemoryContextNoteRead(BaseModel):
    id: str
    memory_id: str
    note: str | None = None
    status: MemoryContextNoteStatus
    revision: int
    created_at: datetime


class MemoryContextReviewResponse(BaseModel):
    active: MemoryContextNoteRead | None = None
    current_revision: int = 0
    history: list[MemoryContextNoteRead] = Field(default_factory=list)


class MemoryReviewResponse(BaseModel):
    memory: MemoryRead
    sources: list[MemoryEvidenceRead]


class EvidenceItem(BaseModel):
    memory_id: str
    content: str
    type: MemoryType
    confidence_label: str
    source_type: SourceType
    sources: list[MemoryEvidenceRead] = Field(default_factory=list)


class ChatResponse(BaseModel):
    answer: str
    evidence: list[EvidenceItem]


class MemoryStatusResponse(BaseModel):
    memory: MemoryRead


class MemoryCalibrationRequest(BaseModel):
    verdict: MemoryCalibration


class MemoryCalibrationResponse(BaseModel):
    verdict: MemoryCalibration
    memory: MemoryRead


class FriendSeedFeedbackResponse(BaseModel):
    feedback: dict[str, MemoryCalibration]


class OpenLoopStatusResponse(BaseModel):
    open_loop: OpenLoopRead


class ResolutionProposalStatusResponse(BaseModel):
    proposal: ResolutionProposalRead
    open_loop: OpenLoopRead | None = None


class ImportMessage(BaseModel):
    speaker: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000)
    timestamp: datetime | None = None
    external_id: str | None = Field(default=None, max_length=500)


class ImportMessagesRequest(BaseModel):
    source_name: str = Field(min_length=1, max_length=200)
    subject_speakers: list[str] = Field(min_length=1, max_length=20)
    messages: list[ImportMessage] = Field(min_length=1, max_length=10_000)


class ImportMessagesResponse(BaseModel):
    import_id: str
    source_name: str
    messages_received: int
    messages_stored: int
    duplicate_messages_skipped: int
    subject_messages_processed: int
    candidate_memories: list[MemoryRead]


class FriendSeedItem(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    type: MemoryType
    content: str = Field(min_length=1, max_length=20_000)
    note: str | None = Field(default=None, max_length=20_000)
    confidence: float = Field(default=0.45, ge=0.0, le=1.0)
    importance: float = Field(default=0.65, ge=0.0, le=1.0)
    subject: str | None = Field(default=None, max_length=500)


class FriendSeedImportResponse(BaseModel):
    file_found: bool
    imported: int
    skipped: int
    memories: list[MemoryRead]
