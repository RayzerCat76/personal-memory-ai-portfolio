"use client";
import { useRef, useState } from "react";
import { api, memoryTypes, type SourceClarification } from "@/lib/api";
import {
  ArchiveDraftConflictError,
  archiveDraftId,
  assertArchiveDraftCurrent,
  deleteArchiveDraft,
  loadArchiveDraft,
  saveArchiveDraft,
  type ArchiveDraftForm,
  type ArchiveDraftPacket,
} from "@/lib/archive-draft-store";

export type ArchivePacket = ArchiveDraftPacket;

const emptyClarification: SourceClarification = { term: "", meaning: "", reviewer: "Ray", verbatim_answer: "" };

function defaultForm(): ArchiveDraftForm {
  return { content: "", type: "fact", clarify: false, clarification: { ...emptyClarification }, checked: false };
}

export default function ArchiveDraft({ packet, onSaved, onReset }: { packet: ArchivePacket; onSaved: () => Promise<void>; onReset: () => void }) {
  const initial = useRef<{ form: ArchiveDraftForm; revision: number; warning: string } | null>(null);
  if (!initial.current) {
    try {
      const local = loadArchiveDraft(packet);
      initial.current = {
        form: local?.form ?? defaultForm(),
        revision: local?.revision ?? 0,
        warning: local ? "Recovered an unsaved local draft for this exact evidence selection." : "",
      };
    } catch (error) {
      initial.current = {
        form: defaultForm(),
        revision: 0,
        warning: error instanceof Error ? `${error.message} Your draft will remain in this tab only.` : "Local draft recovery is unavailable. Your draft will remain in this tab only.",
      };
    }
  }

  const [form, setForm] = useState<ArchiveDraftForm>(initial.current.form);
  const revision = useRef(initial.current.revision);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState(initial.current.warning);
  const [conflict, setConflict] = useState(false);
  const evidence = packet.evidence_scope.selected_target_evidence;
  const clarificationValid = !form.clarify || (Object.values(form.clarification).every(value => value.trim())
    && evidence.some(item => item.authored_text.includes(form.clarification.term)));

  function persist(next: ArchiveDraftForm) {
    setForm(next);
    if (saved) return;
    try {
      const snapshot = saveArchiveDraft(packet, next, revision.current);
      revision.current = snapshot.revision;
      setConflict(false);
      if (notice.startsWith("Local draft recovery") || notice.startsWith("A saved local draft")) setNotice("");
    } catch (error) {
      if (error instanceof ArchiveDraftConflictError) {
        setConflict(true);
        setNotice(error.message + " Your current text has not been overwritten.");
      } else {
        setNotice((error instanceof Error ? error.message : "Local draft recovery is unavailable.") + " Your current text is still in this tab.");
      }
    }
  }

  function update(patch: Partial<ArchiveDraftForm>) {
    const next = { ...form, ...patch };
    if (!Object.prototype.hasOwnProperty.call(patch, "checked")) next.checked = false;
    persist(next);
  }

  function updateClarification(key: keyof SourceClarification, value: string) {
    persist({ ...form, checked: false, clarification: { ...form.clarification, [key]: value } });
  }

  function reloadNewerLocalDraft() {
    try {
      const local = loadArchiveDraft(packet);
      if (!local) {
        revision.current = 0;
        setConflict(false);
        setNotice("The newer local draft no longer exists. Your current text is still in this tab.");
        return;
      }
      revision.current = local.revision;
      setForm(local.form);
      setConflict(false);
      setNotice("Loaded the newer local draft. Check the person, meaning and timing again before saving.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not reload the newer local draft.");
    }
  }

  async function save() {
    if (busy || saved || conflict || !form.checked || !form.content.trim() || !clarificationValid) return;
    setBusy(true); setNotice("");
    try {
      // Do not let a stale tab submit wording after another tab has changed this same local draft.
      assertArchiveDraftCurrent(packet, revision.current);
      const result = await api.saveSourceDraft(packet.unit_id, form.content.trim(), evidence.map(item => ({
        message_id: item.message_id, speaker_role: "target", speaker_display_name: item.sender,
        create_time: item.time, source_chat_json: packet.source, text: item.authored_text,
      })), form.type, form.clarify ? [form.clarification] : []);
      setSaved(true);

      let cleanupNotice = "";
      try {
        deleteArchiveDraft(packet, revision.current);
        revision.current = 0;
      } catch (error) {
        cleanupNotice = error instanceof ArchiveDraftConflictError
          ? " A newer local version exists in another tab, so it was not deleted."
          : " The server save succeeded, but local recovery storage could not be cleaned up.";
      }

      setNotice((result.memory.status === "unconfirmed" ? "Saved. Review it in Today and confirm when accurate."
        : `This selection already has a ${result.memory.status} memory. No new draft was created.`) + cleanupNotice);
      try { await onSaved(); }
      catch { setNotice(old => `${old} The list could not refresh; reload Today to see the memory.`); }
    } catch (error) {
      if (error instanceof ArchiveDraftConflictError) {
        setConflict(true);
        setNotice(error.message + " Nothing was sent to the memory API.");
      } else {
        setNotice(error instanceof Error ? error.message : "Could not save. Your draft is still here.");
      }
    } finally { setBusy(false); }
  }

  function discard() {
    if (!saved) {
      try {
        deleteArchiveDraft(packet, revision.current);
        revision.current = 0;
      } catch (error) {
        // If another tab has a newer revision, leave that newer copy intact and only close this in-memory view.
        if (!(error instanceof ArchiveDraftConflictError)) {
          setNotice(error instanceof Error ? error.message : "Could not clear local recovery storage.");
          return;
        }
      }
    }
    onReset();
  }

  return <section aria-label="Draft from selected messages" data-archive-draft-id={archiveDraftId(packet)}>
    <h3>Review selected evidence</h3>
    {evidence.map(item => <blockquote key={item.message_id}>
      <small>{item.sender || "Gift recipient"} · {new Date(item.time * 1000).toLocaleString()}</small>
      <p style={{ whiteSpace: "pre-wrap" }}>{item.authored_text}</p>
    </blockquote>)}
    <details><summary>Context only</summary>
      {packet.evidence_scope.context_only.map((item, index) => <p key={index} style={{ whiteSpace: "pre-wrap" }}>{item.role}: {item.text}</p>)}
    </details>
    <p>Write who did what, keeping requests, plans and completed events distinct. Selected quotes are preserved exactly.</p>
    <fieldset disabled={busy || saved}>
      <legend>Memory draft</legend>
      <label>Category <select value={form.type} onChange={event => update({ type: event.target.value })}>
        {memoryTypes.map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
      </select></label>
      <label>Memory in your own words <textarea value={form.content} maxLength={20000}
        onChange={event => update({ content: event.target.value })} /></label>
      <label><input type="checkbox" checked={form.clarify} onChange={event => update({ clarify: event.target.checked })} /> Add a separate clarification</label>
      {form.clarify && <div>
        <p>Clarifications record what you know separately from the original messages.</p>
        {([ ["term", "Exact term in the selected messages", 500], ["meaning", "Meaning", 2000],
          ["reviewer", "Clarified by", 200], ["verbatim_answer", "Your explanation, in your own words", 5000] ] as const).map(([key, label, limit]) =>
          <label key={key}>{label} <input value={form.clarification[key]} maxLength={limit}
            onChange={event => updateClarification(key, event.target.value)} /></label>)}
      </div>}
      <label><input type="checkbox" checked={form.checked} onChange={event => update({ checked: event.target.checked })} /> I checked the person, meaning and timing against this evidence.</label>
      <button disabled={conflict || !form.checked || !form.content.trim() || !clarificationValid} onClick={() => void save()}>Save for confirmation</button>
    </fieldset>
    {notice && <p role="status">{notice}</p>}
    {conflict && !saved && <button disabled={busy} onClick={reloadNewerLocalDraft}>Load newer local draft</button>}
    <button disabled={busy} onClick={discard}>{saved ? "Choose another selection" : "Discard draft and change selection"}</button>
  </section>;
}
