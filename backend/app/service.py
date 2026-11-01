from __future__ import annotations

import re

from .backup import MemoryBackupPayload, MemoryBackupRestoreResponse, MemoryBackupStore
from .db import Database
from .extraction import HeuristicMemoryExtractor
from .gift_seed import FriendSeedStore
from .importer import ChatHistoryImporter
from .llm import MLXProvider
from .schemas import (
    ChatResponse,
    EvidenceItem,
    FriendSeedImportResponse,
    ImportMessagesRequest,
    ImportMessagesResponse,
    MemoryCalibration,
    MemoryCandidate,
    MemoryRead,
    MessageResponse,
)
from .semantic import SemanticMemoryIndex, build_embedding_provider
from .settings import Settings


class MemoryService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.db = Database(settings.db_path)
        self.heuristic = HeuristicMemoryExtractor()
        self.llm = None
        if settings.llm_provider.lower() == "mlx":
            self.llm = MLXProvider(settings.mlx_model, extraction_thinking=settings.mlx_extraction_thinking)

        self.semantic_error: str | None = None
        provider = build_embedding_provider(
            settings.embedding_provider,
            ollama_model=settings.embedding_model,
            ollama_url=settings.ollama_url,
        )
        self.semantic: SemanticMemoryIndex | None = None
        if provider is not None:
            try:
                self.semantic = SemanticMemoryIndex(settings.vector_path, provider)
            except Exception as exc:  # semantic search must never prevent app startup
                self.semantic_error = str(exc)

        self.importer = ChatHistoryImporter(self.db, self._extract_candidates)
        self.friend_seed = FriendSeedStore(
            self.db,
            settings.friend_seed_path,
            settings.friend_seed_feedback_path,
        )
        self.backup = MemoryBackupStore(self.db, self.friend_seed)
        self._memory_peer_store = None

    def _extract_candidates(self, content: str) -> list[MemoryCandidate]:
        if self.llm is not None:
            return self.llm.extract_memories(content)
        return self.heuristic.extract(content)

    def ingest_message(self, content: str) -> MessageResponse:
        candidates = self._extract_candidates(content)

        # Resolution detection deliberately remains deterministic for now.
        # It only creates proposals; the user still has to accept one before
        # an existing open loop is changed.
        resolution_candidates = self.heuristic.extract_resolutions(content)
        with self.db.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            message_id = self.db.add_message("user", content, connection=con)
            stored = [
                self.db.add_candidate(candidate, source_id=message_id, evidence=content, connection=con)
                for candidate in candidates
            ]
            proposals = self.db.propose_resolutions(
                message_id=message_id,
                evidence=content,
                candidates=resolution_candidates,
                connection=con,
            )

        return MessageResponse(
            message_id=message_id,
            candidate_memories=stored,
            resolution_proposals=proposals,
        )

    def import_messages(self, request: ImportMessagesRequest) -> ImportMessagesResponse:
        return self.importer.import_messages(request)

    def import_friend_seed(self) -> FriendSeedImportResponse:
        return self.friend_seed.import_seed()

    def friend_seed_feedback(self) -> dict[str, MemoryCalibration]:
        return self.friend_seed.load_feedback()

    def _peer_store(self):
        if self._memory_peer_store is None:
            from .peer_sync import MemoryPeerSyncStore
            self._memory_peer_store = MemoryPeerSyncStore(self.db)
        return self._memory_peer_store

    def memory_peer_local_state(self) -> dict[str, int | bool]:
        with self.db.connect() as con:
            total = sum(int(con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) for table in
                        ("memories", "memory_evidence", "memory_context_notes", "memory_relations", "open_loops", "resolution_proposals"))
            calibration_table = con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_peer_calibrations'").fetchone()
            if calibration_table:
                total += int(con.execute("SELECT COUNT(*) FROM memory_peer_calibrations").fetchone()[0])
        return {"has_syncable_data": total > 0, "syncable_rows": total}

    def bind_memory_peer_vault(self, vault_id: str) -> str:
        file_feedback = self.friend_seed._file_feedback()
        return self._peer_store().bind_vault(vault_id, file_feedback)

    def memory_peer_outbox(self, vault_id: str):
        return self._peer_store().list_outbox(vault_id)

    def acknowledge_memory_peer_outbox(self, vault_id: str, event_ids: list[str]) -> int:
        return self._peer_store().acknowledge(vault_id, event_ids)

    def apply_memory_peer_records(self, vault_id: str, items):
        result = self._peer_store().apply(vault_id, items)
        self.friend_seed.replace_feedback_cache(self._peer_store().calibrations())
        return result

    def export_memory_backup(self) -> MemoryBackupPayload:
        return self.backup.export()

    def restore_memory_backup(self, backup: MemoryBackupPayload) -> MemoryBackupRestoreResponse:
        # A backup exported from this exact store should always be a harmless
        # no-op, even if the local database contains legacy duplicate source
        # identities created by older versions. Compare the full logical payload
        # first; exported_at is metadata, not stored application state.
        # Lists retain export order (including evidence insertion order);
        # reordered lists use ordinary restore. Mapping key order is irrelevant.
        # No record fields or collections are omitted from equality.
        current = self.backup.export()
        current_data = current.model_dump(mode="json")
        backup_data = backup.model_dump(mode="json")
        current_data.pop("exported_at", None)
        backup_data.pop("exported_at", None)
        if current_data == backup_data:
            zero = {
                "messages": 0,
                "import_batches": 0,
                "imported_messages": 0,
                "memories": 0,
                "evidence": 0,
                "context_notes": 0,
                "relations": 0,
                "open_loops": 0,
                "resolution_proposals": 0,
            }
            identical = {
                "messages": len(backup.messages),
                "import_batches": len(backup.import_batches),
                "imported_messages": len(backup.imported_messages),
                "memories": len(backup.memories),
                "evidence": len(backup.evidence),
                "context_notes": len(backup.context_notes),
                "relations": len(backup.relations),
                "open_loops": len(backup.open_loops),
                "resolution_proposals": len(backup.resolution_proposals),
            }
            return MemoryBackupRestoreResponse(
                inserted=zero,
                identical_kept=identical,
                friend_seed_feedback_added=0,
            )
        return self.backup.restore(backup)

    def calibrate_friend_seed(self, memory_id: str, verdict: MemoryCalibration) -> MemoryRead:
        memory = self.db.get_memory(memory_id)
        if memory.source_type != "friend_seed":
            raise ValueError("Only friend-seeded memories use birthday calibration")

        self.friend_seed.save_feedback(memory_id, verdict)
        if verdict == "accurate":
            return self.confirm_memory(memory_id)
        if verdict == "slander":
            return self.reject_memory(memory_id)

        # 'Sort of' is useful feedback but is deliberately not trusted for
        # retrieval until the user later corrects it.
        memory = self.db.set_status(memory_id, "unconfirmed")
        if self.semantic is not None:
            try:
                self.semantic.delete(memory_id)
                self.semantic_error = None
            except Exception as exc:
                self.semantic_error = str(exc)
        return memory

    def confirm_memory(self, memory_id: str) -> MemoryRead:
        memory = self.db.set_status(memory_id, "confirmed")
        self._safe_semantic_upsert(memory)
        return memory

    def reject_memory(self, memory_id: str) -> MemoryRead:
        memory = self.db.set_status(memory_id, "rejected")
        if self.semantic is not None:
            try:
                self.semantic.delete(memory_id)
                self.semantic_error = None
            except Exception as exc:
                self.semantic_error = str(exc)
        return memory

    def _safe_semantic_upsert(self, memory: MemoryRead) -> None:
        if self.semantic is None:
            return
        try:
            self.semantic.upsert(memory)
            self.semantic_error = None
        except Exception as exc:
            # For example: Ollama is not running or the embedding model has not
            # been pulled. SQLite remains authoritative and lexical search still works.
            self.semantic_error = str(exc)

    def retrieve(self, question: str) -> list[MemoryRead]:
        lexical = self.db.search_confirmed(question, self.settings.max_retrieval)
        merged: list[MemoryRead] = []
        seen: set[str] = set()

        for memory in lexical:
            if memory.id not in seen:
                merged.append(memory)
                seen.add(memory.id)

        if self.semantic is not None:
            try:
                confirmed = self.db.list_memories(status="confirmed", limit=5000)
                self.semantic.ensure_indexed(confirmed)
                semantic_hits = self.semantic.search(
                    question,
                    limit=self.settings.semantic_retrieval,
                )
                for memory_id, _score in semantic_hits:
                    if memory_id in seen:
                        continue
                    try:
                        memory = self.db.get_memory(memory_id)
                    except KeyError:
                        continue
                    # Qdrant can contain a stale point if a memory was superseded
                    # while semantic search was disabled. SQLite always wins.
                    if memory.status != "confirmed":
                        continue
                    merged.append(memory)
                    seen.add(memory.id)
                self.semantic_error = None
            except Exception as exc:
                self.semantic_error = str(exc)

        return merged[: self.settings.max_retrieval]

    def _direct_fact(self, question: str) -> MemoryRead | None:
        # Only a single explicit possessive fact lookup; ambiguous/composite
        # questions retain the normal retrieval and reasoning path.
        match = re.fullmatch(r"what (?:is|are) my ([a-z][a-z0-9 -]{0,60})\??", question.strip(), re.I)
        if not match:
            return None
        field = match.group(1).strip()
        if re.search(r"\b(and|or|but|why|how)\b", field, re.I):
            return None
        pattern = re.compile(
            r"^(?:my|your|his|her|the recipient's)\s+" + re.escape(field)
            + r"\s+(?:is|are)\s+\S", re.I,
        )
        confirmed = self.db.list_memories(status="confirmed", limit=5000)
        if len(confirmed) >= 5000:
            return None  # Do not infer uniqueness from a truncated result set.
        matches = [m for m in confirmed if m.type == "fact" and pattern.search(m.content)]
        return matches[0] if len(matches) == 1 else None

    @staticmethod
    def _direct_tokens(text: str) -> set[str]:
        stop = {
            "a", "an", "the", "i", "me", "my", "mine", "our", "ours", "do", "does", "did",
            "is", "are", "was", "were", "am", "have", "has", "had", "what", "which", "who",
            "and", "or", "but",
            "when", "where", "kind", "of", "in", "on", "at", "to", "for", "about", "from",
        }
        tokens: set[str] = set()
        for token in re.findall(r"[a-z0-9]+", text.lower()):
            if token in stop:
                continue
            if len(token) > 4 and token.endswith("ing"):
                token = token[:-3]
            elif len(token) > 3 and token.endswith("ies"):
                token = token[:-3] + "y"
            elif len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
                token = token[:-1]
            tokens.add(token)
        return tokens

    def _direct_memory(self, question: str) -> MemoryRead | None:
        direct = self._direct_fact(question)
        if direct is not None:
            return direct
        text = question.strip()
        if len(text) > 140 or not re.match(r"^(?:what|which|who|when|where|do|does|did|is|are|was|were|have|has)\b", text, re.I):
            return None
        if re.search(r"\b(?:and|or|but|why|how|explain|compare|should|could|might|mean)\b", text, re.I):
            return None
        wanted = self._direct_tokens(text)
        if not wanted or len(wanted) > 8:
            return None
        confirmed = self.db.list_memories(status="confirmed", limit=5000)
        if len(confirmed) >= 5000:
            return None
        preference_words = {"prefer", "like", "enjoy", "favorite", "favourite"}
        interest_words = {"interest", "interested", "like", "enjoy"}
        matches = []
        for memory in confirmed:
            if memory.type == "fact":
                allowed = True
            elif memory.type == "preference":
                allowed = bool(wanted & preference_words)
            elif memory.type == "interest":
                allowed = bool(wanted & interest_words)
            else:
                allowed = False
            if allowed and wanted.issubset(self._direct_tokens(memory.content)):
                matches.append(memory)
        return matches[0] if len(matches) == 1 else None

    @staticmethod
    def _direct_fact_parts(question: str) -> list[str] | None:
        text = question.strip().rstrip("?")
        if len(text) > 180 or re.search(r"\b(?:or|but|why|how|explain|compare|should|could|might|mean)\b", text, re.I):
            return None
        clauses = re.split(
            r"\s*,?\s+and\s+(?=(?:what|which|who|when|where|is|are|was|were)\b)",
            text, flags=re.I,
        )
        if len(clauses) < 2:
            return None
        parts: list[str] = []
        for clause in clauses:
            clause = clause.strip()
            fields = re.fullmatch(r"what (?:is|are) my (.+)", clause, re.I)
            if fields and re.search(r"\band\b|,", fields.group(1), re.I):
                names = [name.strip() for name in re.split(r"\s*(?:,|\band\b)\s*", fields.group(1), flags=re.I) if name.strip()]
                if len(names) < 2:
                    return None
                parts.extend(f"What are my {name}" for name in names)
            else:
                parts.append(clause)
        return parts if 2 <= len(parts) <= 4 else None

    def _direct_memories(self, question: str) -> list[MemoryRead] | None:
        single = self._direct_memory(question)
        if single is not None:
            return [single]
        parts = self._direct_fact_parts(question)
        if not parts:
            return None
        matched: list[MemoryRead] = []
        seen: set[str] = set()
        for part in parts:
            memory = self._direct_memory(part)
            if memory is None or memory.type != "fact":
                return None
            if memory.id not in seen:
                matched.append(memory)
                seen.add(memory.id)
        return matched if len(matched) >= 2 else None

    @classmethod
    def _direct_answer(cls, question: str, memories: list[MemoryRead]) -> str:
        wanted = cls._direct_tokens(question)

        def requested_sentence(content: str) -> str:
            sentences = re.split(r"(?<=[.!?])\s+", content.strip())
            if len(sentences) <= 1:
                return content.strip()
            ranked = [(len(wanted & cls._direct_tokens(sentence)), -index, sentence) for index, sentence in enumerate(sentences)]
            score, _position, sentence = max(ranked)
            return sentence if score > 0 else content.strip()

        def second_person(content: str) -> str:
            sentence = requested_sentence(content)
            if re.match(r"^the recipient's\s+", sentence, re.I):
                sentence = re.sub(r"^the recipient's\s+", "Your ", sentence, flags=re.I)
            elif re.match(r"^(?:his|her)\s+", sentence, re.I):
                sentence = re.sub(r"^(?:his|her)\s+", "Your ", sentence, flags=re.I)
            elif re.match(r"^prefers\s+", sentence, re.I):
                sentence = re.sub(r"^prefers\s+", "You prefer ", sentence, flags=re.I)
            elif re.match(r"^likes\s+", sentence, re.I):
                sentence = re.sub(r"^likes\s+", "You like ", sentence, flags=re.I)
            elif re.match(r"^enjoys\s+", sentence, re.I):
                sentence = re.sub(r"^enjoys\s+", "You enjoy ", sentence, flags=re.I)
            return sentence

        return " ".join(second_person(memory.content) for memory in memories)

    def chat(self, question: str) -> ChatResponse:
        direct = self._direct_memories(question)
        memories = direct if direct is not None else self.retrieve(question)
        evidence = [
            EvidenceItem(
                memory_id=m.id,
                content=m.content,
                type=m.type,
                confidence_label=m.confidence_label,
                source_type=m.source_type,
                sources=self.db.get_memory_evidence(m.id),
            )
            for m in memories
        ]

        if direct is not None:
            answer = self._direct_answer(question, direct)
        elif self.llm is not None:
            answer = self.llm.answer(question, memories)
        elif memories:
            facts = "; ".join(m.content for m in memories)
            answer = f"Based on your confirmed memories: {facts}."
        else:
            answer = "I don't know that from the memories I currently have."

        if answer == "I don't know that from the confirmed memories I currently have.":
            evidence = []
        return ChatResponse(answer=answer, evidence=evidence)
