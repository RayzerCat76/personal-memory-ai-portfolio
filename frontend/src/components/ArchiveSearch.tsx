"use client";
import { useEffect, useState } from "react";
import ArchiveContext from "@/components/ArchiveContext";
import ArchiveDraft from "@/components/ArchiveDraft";
import { listArchiveDrafts, type ArchiveDraftSnapshot } from "@/lib/archive-draft-store";

type Result = { source: string; source_index: number; message_id: string | null; text: string;
  time: number | null; sender: string | null; is_target: boolean; trusted_memory: false };

export default function ArchiveSearch({ onSaved }: { onSaved: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [targetOnly, setTargetOnly] = useState(false);
  const [submitted, setSubmitted] = useState<{ query: string; targetOnly: boolean } | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [recoveries, setRecoveries] = useState<ArchiveDraftSnapshot[]>([]);
  const [recoveryOpenId, setRecoveryOpenId] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState("");

  function refreshRecoveries() {
    try {
      const local = listArchiveDrafts();
      setRecoveries(local);
      if (recoveryOpenId && !local.some(item => item.id === recoveryOpenId)) setRecoveryOpenId(null);
      setRecoveryNotice("");
    } catch (error) {
      setRecoveryNotice((error instanceof Error ? error.message : "Local draft recovery is unavailable.") + " Search and server saves still work.");
    }
  }

  useEffect(() => { refreshRecoveries(); }, []);

  async function search(nextOffset = 0, criteria = { query: query.trim(), targetOnly }) {
    // Current ArchiveDraft inputs are persisted synchronously on change, so refresh
    // the recovery list before search results unmount.
    refreshRecoveries();
    setBusy(true); setNotice(""); setResults([]);
    setHasMore(false);
    try {
      const response = await fetch(`/api/archive?q=${encodeURIComponent(criteria.query)}&offset=${nextOffset}&target=${criteria.targetOnly ? "1" : "0"}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not search the archive.");
      setResults(data.results);
      setSubmitted(criteria); setOffset(data.offset); setHasMore(data.has_more);
      setNotice(data.results.length ? `Messages ${data.offset + 1}–${data.offset + data.results.length} of ${data.total} matches for “${criteria.query}”${criteria.targetOnly ? " (gift recipient only)" : ""}.` : "No matching text found.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not search the archive."); }
    finally { setBusy(false); }
  }

  return <details className="sourceReview"><summary>Search original chats</summary>
    <p>Search the local archive by words or an exact phrase. Results are original messages, not approved memories. Untranscribed media is not searched.</p>

    {recoveries.length > 0 && <section aria-label="Unsaved local archive drafts">
      <h3>Unsaved local drafts</h3>
      <p>These are browser-local review drafts only. Reopening one does not create or confirm a memory.</p>
      {recoveries.map(item => <article key={item.id}>
        <small>Updated {new Date(item.updatedAt).toLocaleString()} · {item.packet.evidence_scope.selected_target_evidence.length} selected evidence message{item.packet.evidence_scope.selected_target_evidence.length === 1 ? "" : "s"}</small>
        <p>{item.form.content.trim() ? item.form.content.trim().slice(0, 180) : "Prepared evidence with no memory wording yet."}</p>
        <button onClick={() => setRecoveryOpenId(old => old === item.id ? null : item.id)}>
          {recoveryOpenId === item.id ? "Hide recovered draft" : "Reopen draft"}
        </button>
        {recoveryOpenId === item.id && <ArchiveDraft key={item.id} packet={item.packet}
          onSaved={async () => { try { await onSaved(); } finally { refreshRecoveries(); } }}
          onReset={() => refreshRecoveries()} />}
      </article>)}
    </section>}
    {recoveryNotice && <p role="status">{recoveryNotice}</p>}

    <form onSubmit={event => { event.preventDefault(); if (!busy && query.trim()) void search(); }}>
      <label>Words to find <input value={query} onChange={event => setQuery(event.target.value)} maxLength={200} disabled={busy} /></label>
      <label><input type="checkbox" checked={targetOnly} onChange={event => setTargetOnly(event.target.checked)} disabled={busy} /> Gift recipient only</label>
      <button disabled={busy || !query.trim()}>{busy ? "Searching…" : "Search chats"}</button>
    </form>
    {notice && <p role="status">{notice}</p>}
    {submitted && <div>
      <button disabled={busy || offset === 0} onClick={() => void search(Math.max(0, offset - 20), submitted)}>Previous matches</button>{" "}
      <button disabled={busy || !hasMore} onClick={() => void search(offset + 20, submitted)}>Next matches</button>
    </div>}
    {results.map(r => <blockquote key={`${r.source}:${r.source_index}`}>
      <small>{r.sender || "Original sender"}{r.is_target ? " · Gift recipient" : ""}{r.time !== null ? ` · ${new Date(r.time * 1000).toLocaleString()}` : ""}</small>
      <p style={{ whiteSpace: "pre-wrap" }}>{r.text}</p>
      <details><summary>Source</summary>{r.source} · {r.message_id ?? r.source_index}</details>
      <ArchiveContext source={r.source} position={r.source_index} onSaved={onSaved} />
    </blockquote>)}
  </details>;
}
