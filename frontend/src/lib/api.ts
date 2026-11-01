const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/backend";
export const browserMemoryEnabled = process.env.NEXT_PUBLIC_BROWSER_MEMORY_ENABLED === "1";
const browserMemory = () => import("@/lib/browser-memory");

export type CalibrationVerdict = "accurate" | "sort_of" | "slander";

export type Memory = {
  id: string;
  type: string;
  content: string;
  status: "unconfirmed" | "confirmed" | "rejected" | "superseded";
  confidence: number;
  confidence_label: string;
  source_type: string;
  source_id?: string | null;
  importance: number;
  subject?: string | null;
  calibration?: CalibrationVerdict | null;
  created_at: string;
  updated_at: string;
  evidence_text?: string | null;
  evidence_count: number;
  active_context_note?: string | null;
  context_revision: number;
};

export type OpenLoop = {
  id: string;
  memory_id: string;
  kind: "goal" | "commitment";
  content: string;
  status: "active" | "completed" | "cancelled";
  created_at: string;
  resolved_at?: string | null;
  resolution_message_id?: string | null;
};

export type Evidence = {
  memory_id: string;
  content: string;
  type: string;
  confidence_label: string;
  source_type: string;
  sources?: MemoryReview["sources"];
};

export type ChatFileContext = {
  name: string;
  mediaType: string;
  size: number;
  text: string;
  truncated: boolean;
};

export type ChatMode = "general" | "memory" | "memory-miss" | "files" | "memory+files" | "web" | "memory+web" | "files+web" | "memory+files+web";

export type WebSource = { title: string; url: string; snippet: string; provider: string };

export type StudyActionProposal =
  | { kind: "create-note"; locale: "en" | "zh"; title: string; body: string }
  | { kind: "add-project-task"; locale: "en" | "zh"; project_id: string; project_title: string; expected_revision: number; task_title: string; due: string }
  | { kind: "complete-project-task"; locale: "en" | "zh"; project_id: string; project_title: string; expected_revision: number; task_id: string; task_title: string }
  | { kind: "schedule-project-reminder"; locale: "en" | "zh"; project_id: string; project_title: string; expected_revision: number; reminder_title: string; scheduled_for: string }
  | { kind: "cancel-project-reminder"; locale: "en" | "zh"; project_id: string; project_title: string; expected_revision: number; reminder_id: string; reminder_title: string };

export type StudySource = {
  id: string;
  kind: "note" | "project";
  title: string;
  subject: string;
  unit: string;
  excerpt: string;
  next_action?: string;
  tasks?: { title: string; done: boolean; due: string }[];
  reminders?: { title: string; scheduled_for: string; status: "scheduled" | "cancelled" }[];
};

export type ChatResponse = {
  answer: string;
  evidence: Evidence[];
  file_context_used?: boolean;
  mode?: ChatMode;
  language?: "en" | "zh";
  web_sources?: WebSource[];
  study_sources?: StudySource[];
  study_action_proposal?: StudyActionProposal;
};

export type MemoryReview = {
  memory: Memory;
  sources: { source_id: string | null; evidence_text: string; created_at: string }[];
};

export type MemoryContextNote = {
  id: string;
  memory_id: string;
  note: string | null;
  status: "active" | "superseded" | "cleared";
  revision: number;
  created_at: string;
};

export type MemoryContextReview = {
  active: MemoryContextNote | null;
  current_revision: number;
  history: MemoryContextNote[];
};

export type MemoryBackupRestoreResponse = {
  inserted: Record<string, number>;
  identical_kept: Record<string, number>;
  friend_seed_feedback_added: number;
};

export type MemoryPeerEntityKind = "memory" | "evidence" | "context" | "relation" | "open_loop" | "resolution" | "calibration";
export type MemoryPeerRecord = {
  kind: "memory-peer";
  entity_kind: MemoryPeerEntityKind;
  entity_id: string;
  value: Record<string, unknown>;
  origin_event_id?: string | null;
};
export type MemoryPeerOutboxEvent = {
  sequence: number; event_id: string; record_id: string; operation: "put" | "delete"; record?: MemoryPeerRecord | null;
};
export type MemoryPeerApplyItem = { record_id: string; operation: "put" | "delete"; record?: MemoryPeerRecord | null };

export const memoryTypes = ["fact", "preference", "interest", "person", "relationship", "event", "project", "goal", "idea", "decision", "commitment", "opinion", "experience", "routine", "inside_joke"] as const;
export type SourceClarification = { term: string; meaning: string; reviewer: string; verbatim_answer: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function memoryMutation<T>(path: string, init?: RequestInit): Promise<T> {
  const value = await request<T>(path, init);
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_MEMORY_PEER_SYNC_ENABLED === "1") {
    window.dispatchEvent(new Event("personal-study-sync-needed"));
  }
  return value;
}

export const api = {
  saveSourceDraft: async (unit_id: string, content: string, source_blocks: { message_id: string; speaker_role: "target"; speaker_display_name: string | null; create_time: number; source_chat_json: string; text: string }[], type = "fact", clarifications: SourceClarification[] = []) => {
    if (browserMemoryEnabled) throw new Error("Original archive review stays on the private import workstation and is not available in browser-native mode.");
    return memoryMutation<{ memory: Memory }>("/api/v1/source-review/drafts", { method: "POST", body: JSON.stringify({ unit_id, content, source_blocks, type, clarifications, reviewed: true }) });
  },
  health: async () => browserMemoryEnabled ? { status: "ok", storage: "browser-local" } : request<Record<string, unknown>>("/health"),
  memories: async (status?: Memory["status"]) => browserMemoryEnabled ? (await browserMemory()).listBrowserMemories(status) : request<Memory[]>(`/api/v1/memories${status ? `?status=${status}` : ""}`),
  openLoops: async () => browserMemoryEnabled ? (await browserMemory()).listBrowserOpenLoops("active") : request<OpenLoop[]>("/api/v1/open-loops?status=active"),
  memoryPeerLocalState: async () => browserMemoryEnabled ? (await browserMemory()).browserMemoryLocalState() : request<{ has_syncable_data: boolean; syncable_rows: number }>("/api/v1/peer-sync/memory/local-state"),
  bindMemoryPeerVault: async (vault_id: string) => browserMemoryEnabled ? (await browserMemory()).bindBrowserMemoryVault(vault_id) : request<{ vault_id: string }>("/api/v1/peer-sync/memory/bind", { method: "POST", body: JSON.stringify({ vault_id }) }),
  memoryPeerOutbox: async (vault_id: string) => browserMemoryEnabled ? (await browserMemory()).listBrowserMemoryOutbox(vault_id) : request<{ events: MemoryPeerOutboxEvent[] }>(`/api/v1/peer-sync/memory/outbox?vault_id=${encodeURIComponent(vault_id)}`),
  acknowledgeMemoryPeerOutbox: async (vault_id: string, event_ids: string[]) => browserMemoryEnabled ? (await browserMemory()).acknowledgeBrowserMemoryOutbox(vault_id, event_ids) : request<{ acknowledged: number }>("/api/v1/peer-sync/memory/ack", { method: "POST", body: JSON.stringify({ vault_id, event_ids }) }),
  applyMemoryPeerRecords: async (vault_id: string, items: MemoryPeerApplyItem[]) => browserMemoryEnabled ? (await browserMemory()).applyBrowserMemoryPeerRecords(vault_id, items) : request<{ applied: number; unchanged: number }>("/api/v1/peer-sync/memory/apply", { method: "POST", body: JSON.stringify({ vault_id, items }) }),
  memoryBackup: async () => browserMemoryEnabled ? (await browserMemory()).exportBrowserMemoryBackup() : request<Record<string, unknown>>("/api/v1/backups/memory"),
  restoreMemoryBackup: async (backup: unknown) => browserMemoryEnabled ? (await browserMemory()).restoreBrowserMemoryBackup(backup) : memoryMutation<MemoryBackupRestoreResponse>("/api/v1/backups/memory/restore", { method: "POST", body: JSON.stringify(backup) }),
  chat: async (message: string, files: ChatFileContext[] = []) => {
    if (browserMemoryEnabled) return (await browserMemory()).browserMemoryChat(message, files);
    if (files.length) throw new Error("Ask file context is available in the browser-native gift build; this backend mode does not ingest transient files.");
    return request<ChatResponse>("/api/v1/chat", { method: "POST", body: JSON.stringify({ message }) });
  },
  ingest: async (content: string) => browserMemoryEnabled ? (await browserMemory()).ingestBrowserStatement(content) : memoryMutation<{ message_id: string; candidate_memories: Memory[] }>("/api/v1/messages", { method: "POST", body: JSON.stringify({ content }) }),
  importFriendSeed: async () => browserMemoryEnabled ? { file_found: false, imported: 0, skipped: 0, memories: [] as Memory[] } : memoryMutation<{ file_found: boolean; imported: number; skipped: number; memories: Memory[] }>("/api/v1/gift/seed/import", { method: "POST" }),
  friendSeedFeedback: async () => browserMemoryEnabled ? { feedback: await (await browserMemory()).browserFriendSeedFeedback() } : request<{ feedback: Record<string, CalibrationVerdict> }>("/api/v1/gift/seed/feedback"),
  calibrateMemory: async (id: string, verdict: CalibrationVerdict) => browserMemoryEnabled ? { verdict, memory: await (await browserMemory()).calibrateBrowserMemory(id, verdict) } : memoryMutation<{ verdict: CalibrationVerdict; memory: Memory }>(`/api/v1/memories/${id}/calibrate`, { method: "POST", body: JSON.stringify({ verdict }) }),
  confirmMemory: async (id: string) => browserMemoryEnabled ? { memory: await (await browserMemory()).confirmBrowserMemory(id) } : memoryMutation<{ memory: Memory }>(`/api/v1/memories/${id}/confirm`, { method: "POST" }),
  reviewMemory: async (id: string) => browserMemoryEnabled ? (await browserMemory()).reviewBrowserMemory(id) : request<MemoryReview>(`/api/v1/memories/${id}/review`),
  memoryContext: async (id: string) => browserMemoryEnabled ? (await browserMemory()).browserMemoryContext(id) : request<MemoryContextReview>(`/api/v1/memories/${id}/context`),
  saveMemoryContext: async (id: string, note: string, expectedRevision: number) => browserMemoryEnabled ? (await browserMemory()).saveBrowserMemoryContext(id, note, expectedRevision) : memoryMutation<MemoryContextReview>(`/api/v1/memories/${id}/context`, { method: "PUT", body: JSON.stringify({ note, expected_revision: expectedRevision }) }),
  correctMemory: async (id: string, content: string, originalContent: string, type?: string, originalType?: string) => browserMemoryEnabled ? { memory: await (await browserMemory()).correctBrowserMemory(id, content, originalContent, type, originalType) } : memoryMutation<{ memory: Memory }>(`/api/v1/memories/${id}`, { method: "PATCH", body: JSON.stringify({ content, original_content: originalContent, type, original_type: originalType }) }),
  rejectMemory: async (id: string) => browserMemoryEnabled ? { memory: await (await browserMemory()).rejectBrowserMemory(id) } : memoryMutation<{ memory: Memory }>(`/api/v1/memories/${id}/reject`, { method: "POST" }),
  completeLoop: async (id: string) => browserMemoryEnabled ? { open_loop: await (await browserMemory()).completeBrowserOpenLoop(id) } : memoryMutation<{ open_loop: OpenLoop }>(`/api/v1/open-loops/${id}/complete`, { method: "POST" }),
};

// Imported provenance stays structured in storage; show readable source excerpts.
export function readableEvidence(text: string): string {
  try {
    const value = JSON.parse(text);
    if ((value.kind === "user_reviewed_import" || value.kind === "bulk_unconfirmed_import") && Array.isArray(value.source_blocks) && value.source_blocks.every((b: {text?: unknown}) => typeof b.text === "string")) {
      const originals = value.source_blocks.map((b: {speaker_display_name?: string; create_time?: number; text: string}) =>
        `${b.speaker_display_name || "Original sender"}${typeof b.create_time === "number" ? ` · ${new Date(b.create_time * 1000).toLocaleString()}` : ""}: ${b.text}`).join("\n");
      const clarifications = Array.isArray(value.human_clarifications) ? value.human_clarifications.map((c: {reviewer: string; term: string; meaning: string; verbatim_answer: string}) =>
        `Clarification from ${c.reviewer}: “${c.term}” means ${c.meaning}.\nTheir answer: “${c.verbatim_answer}”`).join("\n\n") : "";
      return originals + (clarifications ? `\n\nSeparate human clarification\n${clarifications}` : "");
    }
  } catch { /* Older evidence is plain text. */ }
  return text;
}
