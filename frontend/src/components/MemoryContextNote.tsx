"use client";

import { useState } from "react";
import { api, browserMemoryEnabled, type Memory, type MemoryContextReview, type MemoryReview } from "@/lib/api";
import { useUiLocale } from "@/lib/ui-locale";

type ArchiveMessage = {
  source_index: number; message_id: string | null; selected: boolean; text: string;
  truncated: boolean; time: number | null; sender: string | null; is_target: boolean; context_only: boolean;
};
type ArchiveContextPacket = { anchor_message_id: string; messages: ArchiveMessage[]; trusted_memory: false };

function evidenceMessageIds(review: MemoryReview): string[] {
  const ids: string[] = [];
  for (const source of review.sources) {
    try {
      const parsed = JSON.parse(source.evidence_text) as { source_blocks?: { message_id?: unknown }[] };
      for (const block of parsed.source_blocks ?? []) {
        if (typeof block.message_id === "string" && block.message_id && !ids.includes(block.message_id)) ids.push(block.message_id);
      }
    } catch { /* Plain-text evidence has no archive identity to resolve. */ }
  }
  return ids;
}

export default function MemoryContextNote({ memory, onChanged }: { memory: Memory; onChanged?: () => void | Promise<void> }) {
  const { t } = useUiLocale();
  const [context, setContext] = useState<MemoryContextReview | null>(null);
  const [draft, setDraft] = useState(memory.active_context_note ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [archive, setArchive] = useState<ArchiveContextPacket[]>([]);
  const [archiveLoaded, setArchiveLoaded] = useState(false);

  async function loadContext() {
    if (context || busy) return;
    setBusy(true); setNotice("");
    try {
      const next = await api.memoryContext(memory.id);
      setContext(next); setDraft(next.active?.note ?? "");
    } catch (error) { setNotice(error instanceof Error ? error.message : t("Could not load context note.", "无法加载语境备注。")); }
    finally { setBusy(false); }
  }

  async function save(note: string) {
    const current = context ?? await api.memoryContext(memory.id);
    setBusy(true); setNotice("");
    try {
      const next = await api.saveMemoryContext(memory.id, note, current.current_revision);
      setContext(next); setDraft(next.active?.note ?? "");
      setNotice(note.trim() ? t("Context note saved. It is clarification, not evidence.", "语境备注已保存；它属于说明，不属于证据。") : t("Context note cleared. Earlier versions remain in history.", "语境备注已清除；早期版本仍保留在历史中。"));
      await onChanged?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Could not save context note.", "无法保存语境备注。"));
      try {
        const latest = await api.memoryContext(memory.id); setContext(latest); setDraft(latest.active?.note ?? "");
      } catch { /* Keep the visible error. */ }
    } finally { setBusy(false); }
  }

  async function loadArchive() {
    if (archiveLoaded || busy) return;
    setBusy(true); setNotice("");
    try {
      const review = await api.reviewMemory(memory.id);
      const ids = evidenceMessageIds(review).slice(0, 3);
      if (!ids.length) throw new Error(t("This memory does not have a resolvable original-chat message ID.", "这条记忆没有可解析的原始聊天消息 ID。"));
      const packets = await Promise.all(ids.map(async id => {
        const response = await fetch(`/api/archive/context-by-message?message_id=${encodeURIComponent(id)}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t("Could not load nearby conversation.", "无法加载附近的对话。"));
        return data as ArchiveContextPacket;
      }));
      setArchive(packets); setArchiveLoaded(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : t("Could not load nearby conversation.", "无法加载附近的对话。")); }
    finally { setBusy(false); }
  }

  const editable = memory.status === "unconfirmed" || memory.status === "confirmed";
  return <details className="memorySources" onToggle={event => { if (event.currentTarget.open) void loadContext(); }}>
    <summary>{memory.active_context_note ? t("Context note · added", "语境备注 · 已添加") : t("Add context note", "添加语境备注")}</summary>
    <p><strong>{t("Your clarification", "你的说明")}</strong> {t("helps distinguish similar memories. It does not count as evidence and cannot confirm a memory.", "可以帮助区分相似记忆；它不算作证据，也不能自行确认一条记忆。")}</p>
    {notice && <p role="status">{notice}</p>}
    {context && editable && <>
      <textarea aria-label={`Context note for ${memory.content}`} value={draft} maxLength={5000} disabled={busy}
        onChange={event => setDraft(event.target.value)} placeholder={t("Example: This was about Ray streaming Minecraft, not livestreams in general.", "例如：这里说的是 Ray 直播 Minecraft，不是泛指所有直播。")} />
      <div className="reviewActions">
        <button type="button" disabled={busy || !draft.trim() || draft.trim() === (context.active?.note ?? "")} onClick={() => void save(draft)}>{t("Save context", "保存语境")}</button>
        {context.active && <button type="button" disabled={busy} onClick={() => void save("")}>{t("Clear active note", "清除当前备注")}</button>}
      </div>
    </>}
    {context && !editable && <p>{t("This historical memory keeps its context history read-only.", "这条历史记忆的语境历史仅可查看。")}</p>}
    {!browserMemoryEnabled && <details onToggle={event => { if (event.currentTarget.open) void loadArchive(); }}>
      <summary>{t("Conversation context · not evidence", "对话语境 · 不属于证据")}</summary>
      <p>{t("Nearby original messages are shown only to help you interpret the source. They never become trusted evidence automatically.", "附近的原始消息只用于帮助理解来源，不会自动成为可信证据。")}</p>
      {busy && !archiveLoaded && <p>{t("Loading…", "加载中…")}</p>}
      {archive.map(packet => <div key={packet.anchor_message_id}>
        {packet.messages.map(message => <div key={`${packet.anchor_message_id}-${message.source_index}`}>
          <small>{message.selected ? t("Evidence anchor", "证据锚点") : t("Context only", "仅语境")}{message.sender ? ` · ${message.sender}` : ""}{message.time !== null ? ` · ${new Date(message.time * 1000).toLocaleString()}` : ""}</small>
          <p style={{ whiteSpace: "pre-wrap", fontWeight: message.selected ? 600 : 400 }}>{message.text}{message.truncated ? t(" … (shortened)", " …（已截短）") : ""}</p>
        </div>)}
      </div>)}
    </details>}
    {context && context.history.length > 0 && <details>
      <summary>{t("Context history", "语境历史")} · {context.history.length}</summary>
      {context.history.map(item => <div key={item.id}>
        <small>{t("Revision", "修订")} {item.revision} · {item.status} · {new Date(item.created_at).toLocaleString()}</small>
        <p>{item.note || t("Context note cleared.", "语境备注已清除。")}</p>
      </div>)}
    </details>}
  </details>;
}
