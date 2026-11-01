"use client";
import { useState } from "react";
import ArchiveDraft, { type ArchivePacket } from "@/components/ArchiveDraft";
import { archiveDraftId } from "@/lib/archive-draft-store";

type Message = { source_index: number; message_id: string | null; selected: boolean; text: string;
  truncated: boolean; time: number | null; sender: string | null; is_target: boolean };
export default function ArchiveContext({ source, position, onSaved }: { source: string; position: number; onSaved: () => Promise<void> }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [packet, setPacket] = useState<ArchivePacket | null>(null);
  async function prepare() {
    if (busy || !selectedIds.length) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/archive/review", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, position, selected_ids: selectedIds }), cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not prepare selection.");
      setPacket(data);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not prepare selection."); }
    finally { setBusy(false); }
  }

  async function load() {
    if (messages || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/archive/context?source=${encodeURIComponent(source)}&position=${position}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Context unavailable.");
      setMessages(data.messages);
    } catch (e) { setError(e instanceof Error ? e.message : "Context unavailable."); }
    finally { setBusy(false); }
  }

  return <details onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary>Surrounding messages</summary>
    <p>Nearby messages from this chat, stopping at gaps over 30 minutes. Select the recipient’s messages that support one memory.</p>
    {busy && <p>Loading context…</p>}
    {error && <p role="status">{error} <button onClick={() => void load()}>Retry context</button></p>}
    {messages?.map(m => <div key={m.source_index}>
      <small>{m.selected ? "Search result · " : "Context · "}{m.sender || "Original sender"}{m.time !== null ? ` · ${new Date(m.time * 1000).toLocaleString()}` : ""}</small>
      <p style={{ whiteSpace: "pre-wrap", fontWeight: m.selected ? 600 : 400 }}>{m.text}{m.truncated ? " … (shortened)" : ""}</p>
      {m.is_target && m.message_id && m.time !== null && <label><input type="checkbox" disabled={busy || !!packet}
        checked={selectedIds.includes(m.message_id)} onChange={event => {
          const id = m.message_id!;
          setSelectedIds(old => event.target.checked ? [...old, id] : old.filter(value => value !== id));
        }} /> Use this message as evidence</label>}
    </div>)}
    {messages && !packet && <button disabled={busy || !selectedIds.length} onClick={() => void prepare()}>Prepare selected messages</button>}
    {packet && <ArchiveDraft key={archiveDraftId(packet)} packet={packet} onSaved={onSaved} onReset={() => { setPacket(null); setError(""); }} />}
  </details>;
}
