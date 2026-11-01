"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { topics, functions, emptyTags, validTags, toggleTag, confirmTags, type SourceTags } from "@/lib/source-review-tags";

type Block = { message_id: string; speaker_role: "target"; speaker_display_name: string | null;
  create_time: number; source_chat_json: string; text: string };
type Packet = { unit_id: string; source_blocks: Block[]; context_only: { role: string; text: string }[] };
type Item = { packet: Packet; draft: string; state: "active" | "deferred" | "dismissed" | "saved"; tags?: SourceTags };
const storageKey = "source-review-batch-v1";

export default function SourceReview({ onSaved }: { onSaved: () => Promise<void> }) {
  const [items, setItems] = useState<Item[]>([]);
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [exportText, setExportText] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [functionFilter, setFunctionFilter] = useState("");
  const current = items.findIndex(item => item.state === "active");
  const item = items[current];

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const restored = JSON.parse(saved);
        if (!Array.isArray(restored) || restored.length > 5 || restored.some(i =>
          !i?.packet || !Array.isArray(i.packet.source_blocks) || !Array.isArray(i.packet.context_only)
          || typeof i.draft !== "string" || !["active", "deferred", "dismissed", "saved"].includes(i.state))) {
          throw new Error("Invalid saved batch");
        }
        if (restored.some((i: Item) => i.tags !== undefined && !validTags(i.tags))) throw new Error("Invalid saved tags");
        setItems(restored);
      }
    } catch { setNotice("Could not restore the local batch. Load the source file again."); }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(storageKey, JSON.stringify(items)); }
    catch { setNotice("Browser storage is unavailable. Keep this page open to retain progress."); }
  }, [items, ready]);

  function update(patch: Partial<Item>) {
    setExportText("");
    setItems(old => old.map((value, i) => i === current ? { ...value, ...patch } : value));
    setChecked(false);
  }
  function changeTag(axis: "topics" | "functions", label: string) {
    if (!item) return;
    try { update({ tags: toggleTag(item.tags ?? emptyTags(), axis, label) }); setNotice(""); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not change tag."); }
  }
  function finishTags() {
    if (!item) return;
    try {
      update({ tags: confirmTags(item.tags ?? emptyTags()), state: "deferred" });
      setNotice("Tags confirmed locally. Export reviewed tags to keep a separate copy.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not confirm tags."); }
  }
  function exportTags() {
    const reviewed = items.filter(i => i.tags?.reviewed && validTags(i.tags));
    const text = reviewed.map(i => JSON.stringify({ version: "source_tags_review_v1", unit_id: i.packet.unit_id,
      source_packet: i.packet, tags: i.tags, review_method: "manual", trusted_memory: false })).join("\n") + "\n";
    setExportText(text);
    const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
    const link = document.createElement("a"); link.href = url; link.download = "reviewed-source-tags.jsonl";
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function load(file: File) {
    try {
      if (file.size > 1_000_000) throw new Error("Choose a source batch smaller than 1 MB.");
      const records = (await file.text()).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      const packets = records.map(record => {
        if (record.version !== "source_tags_review_v1") return record;
        if (record.review_method !== "manual" || record.trusted_memory !== false || !validTags(record.tags)
          || !record.tags.reviewed || record.unit_id !== record.source_packet?.unit_id) {
          throw new Error("The reviewed-tag file is invalid.");
        }
        return record.source_packet;
      });
      if (!packets.length || packets.length > 5) throw new Error("Choose a batch containing one to five source packets.");
      const ids = new Set<string>();
      for (const p of packets) {
        if (p.version !== "extractive_review_v1" || p.kind !== "source_review_packet" || typeof p.unit_id !== "string" || ids.has(p.unit_id)
          || !Array.isArray(p.source_blocks) || !p.source_blocks.length || p.source_blocks.length > 40
          || !Array.isArray(p.context_only) || p.context_only.some((b: { role?: unknown; text?: unknown }) => typeof b.role !== "string" || typeof b.text !== "string")
          || p.source_blocks.some((b: Block) => b.speaker_role !== "target" || typeof b.text !== "string" || !b.text.trim()
            || typeof b.message_id !== "string" || !b.message_id || typeof b.source_chat_json !== "string" || !b.source_chat_json
            || !Number.isInteger(b.create_time))) throw new Error("The batch has invalid or missing source information.");
        ids.add(p.unit_id);
      }
      setItems(packets.map((packet, index) => ({ packet, draft: "", state: "active",
        ...(records[index].version === "source_tags_review_v1" ? { tags: records[index].tags as SourceTags } : {}) })));
      setExportText("");
      setChecked(false); setNotice("Loaded locally. Nothing has been saved to memory.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not load this file."); }
  }
  async function save() {
    if (!item || !item.draft.trim() || !checked) return;
    setBusy(true); setNotice("");
    try {
      await api.saveSourceDraft(item.packet.unit_id, item.draft.trim(), item.packet.source_blocks.map(b => ({
        message_id: b.message_id, speaker_role: b.speaker_role, speaker_display_name: b.speaker_display_name ?? null,
        create_time: b.create_time, source_chat_json: b.source_chat_json, text: b.text,
      })));
      update({ state: "saved" });
      setNotice("Saved. Review the wording below, then choose Keep to confirm.");
      await onSaved();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save the draft."); }
    finally { setBusy(false); }
  }
  return <details className="sourceReview">
    <summary>Review original chats</summary>
    <p>Load up to five source excerpts or restore a reviewed-tag export. Write only what they support, including who did what and whether it happened or was a plan.</p>
    <label>Load or replace local batch <input type="file" accept=".jsonl" disabled={!ready || busy || items.some(i => i.state === "active" || i.state === "deferred")}
      onChange={event => { const file = event.target.files?.[0]; if (file) void load(file); event.target.value = ""; }} /></label>
    <p>{items.filter(i => i.state === "saved").length} saved · {items.filter(i => i.state === "deferred").length} later · {items.filter(i => i.state === "dismissed").length} dismissed</p>
    <p>{items.filter(i => i.tags?.reviewed).length} excerpts with confirmed tags. <button disabled={busy || !items.some(i => i.tags?.reviewed)} onClick={exportTags}>Export reviewed tags</button></p>
    {exportText && <details open><summary>Export copy</summary>
      <p>A file download has been requested. You can also copy the text below to keep your reviewed tags and sources.</p>
      <label htmlFor="source-tags-export">Reviewed tags and sources</label>
      <textarea id="source-tags-export" readOnly rows={6} value={exportText} />
    </details>}
    {items.some(i => i.tags?.reviewed) && <details><summary>Browse confirmed tags</summary>
      <label>Filter topic <select value={topicFilter} onChange={event => setTopicFilter(event.target.value)}>
        <option value="">Any topic</option>{topics.map(t => <option key={t} value={t}>{t}</option>)}
      </select></label>{" "}
      <label>Filter message type <select value={functionFilter} onChange={event => setFunctionFilter(event.target.value)}>
        <option value="">Any message type</option>{functions.map(t => <option key={t} value={t}>{t}</option>)}
      </select></label>
      <p>Showing confirmed tags in this local batch. Choosing both filters requires both tags.</p>
      {items.filter(i => i.tags?.reviewed && (!topicFilter || i.tags.topics.includes(topicFilter))
        && (!functionFilter || i.tags.functions.includes(functionFilter))).map(i => <details key={i.packet.unit_id}>
          <summary>{i.tags!.topics.join(", ")} · {i.tags!.functions.join(", ")}</summary>
          {i.packet.source_blocks.map(b => <blockquote key={b.message_id}>
            <p style={{ whiteSpace: "pre-wrap" }}>{b.text}</p>
            <small>{b.source_chat_json} · {b.message_id}</small>
          </blockquote>)}
        </details>)}
      {!items.some(i => i.tags?.reviewed && (!topicFilter || i.tags.topics.includes(topicFilter))
        && (!functionFilter || i.tags.functions.includes(functionFilter))) && <p>No confirmed excerpts match these filters.</p>}
    </details>}
    {notice && <p role="status">{notice}</p>}
    {item && <div>
      <p>Excerpt {current + 1} of {items.length}</p>
      {item.packet.source_blocks.map(b => <blockquote key={b.message_id}>
        <small>{b.speaker_display_name || "Original sender"} · {new Date(b.create_time * 1000).toLocaleString()}</small>
        <p style={{ whiteSpace: "pre-wrap" }}>{b.text}</p>
        <details><summary>Source</summary>{b.source_chat_json} · {b.message_id}</details>
      </blockquote>)}
      <details><summary>Surrounding conversation</summary>
        <p>Context may help explain references; it is not evidence for a new personal fact.</p>
        {item.packet.context_only.map((b, i) => <p key={i}>{b.role}: {b.text}</p>)}
      </details>
      <details><summary>Organize this excerpt</summary>
        <p>Choose up to three topics and message types. For example: Games + Thanks. Choose Unknown when the connection is unclear.</p>
        {(["topics", "functions"] as const).map(axis => <fieldset key={axis} disabled={busy}>
          <legend>{axis === "topics" ? "Topics" : "Message types"}</legend>
          {(axis === "topics" ? topics : functions).map(label => <label key={label} style={{ display: "inline-block", marginRight: "1rem" }}>
            <input type="checkbox" checked={item.tags?.[axis].includes(label) ?? false} onChange={() => changeTag(axis, label)} /> {label === "unknown" ? "Unknown" : label[0].toUpperCase() + label.slice(1)}
          </label>)}
        </fieldset>)}
        <p>{item.tags?.reviewed ? "Tags confirmed. Changing a tag requires confirmation again." : "Tags are not confirmed yet."}</p>
        <button disabled={busy} onClick={finishTags}>Confirm tags and continue</button>
        <p>Tags organize the original excerpt. They do not save or confirm a personal memory.</p>
      </details>
      <label htmlFor="source-memory-draft">Memory in your own words</label>
      <textarea id="source-memory-draft" value={item.draft} maxLength={20000} disabled={busy}
        onChange={event => update({ draft: event.target.value })} />
      <label><input type="checkbox" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)} /> I checked the person, meaning and timing against these messages.</label>
      <div className="reviewActions">
        <button disabled={busy || !checked || !item.draft.trim()} onClick={() => void save()}>Save for confirmation</button>
        <button disabled={busy} onClick={() => update({ state: "deferred" })}>Later</button>
        <button disabled={busy} onClick={() => update({ state: "dismissed" })}>Dismiss</button>
      </div>
    </div>}
    {!item && items.some(i => i.state === "deferred" || i.state === "dismissed") && <button disabled={busy}
      onClick={() => { setItems(old => old.map(i => i.state === "saved" ? i : { ...i, state: "active" })); setChecked(false); }}>Reopen unsaved excerpts</button>}
    <small>This batch and your progress stay in this browser. Saving sends the reviewed wording and its sources to your memory service; confirmation is separate.</small>
  </details>;
}
