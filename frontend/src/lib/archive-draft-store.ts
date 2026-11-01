"use client";

import type { SourceClarification } from "@/lib/api";

export type ArchiveDraftEvidence = {
  message_id: string;
  authored_text: string;
  sender: string | null;
  time: number;
};

export type ArchiveDraftPacket = {
  unit_id: string;
  source: string;
  evidence_scope: {
    selected_target_evidence: ArchiveDraftEvidence[];
    context_only: { role: string; text: string }[];
  };
};

export type ArchiveDraftForm = {
  content: string;
  type: string;
  clarify: boolean;
  clarification: SourceClarification;
  checked: boolean;
};

export type ArchiveDraftSnapshot = {
  version: 1;
  id: string;
  packet: ArchiveDraftPacket;
  form: ArchiveDraftForm;
  revision: number;
  updatedAt: string;
};

const PREFIX = "personal-archive-draft-v1:";

export class ArchiveDraftStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveDraftStorageError";
  }
}

export class ArchiveDraftConflictError extends Error {
  constructor(message = "This draft changed in another tab. Reload the newer local draft before editing or saving.") {
    super(message);
    this.name = "ArchiveDraftConflictError";
  }
}

function storage(): Storage {
  if (typeof window === "undefined") throw new ArchiveDraftStorageError("Local draft recovery is unavailable outside the browser.");
  try {
    return window.localStorage;
  } catch {
    throw new ArchiveDraftStorageError("Local draft recovery is unavailable in this browser.");
  }
}

function compact(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function packetIdentity(packet: ArchiveDraftPacket): string {
  const evidence = [...packet.evidence_scope.selected_target_evidence]
    .map(item => `${item.message_id}@${item.time}`)
    .sort()
    .join("|");
  return `${packet.unit_id}\n${packet.source}\n${evidence}`;
}

export function archiveDraftId(packet: ArchiveDraftPacket): string {
  return packetIdentity(packet);
}

function keyForId(id: string): string {
  return PREFIX + encodeURIComponent(id);
}

function validClarification(value: unknown): value is SourceClarification {
  if (!value || typeof value !== "object") return false;
  const c = value as SourceClarification;
  return [c.term, c.meaning, c.reviewer, c.verbatim_answer].every(v => typeof v === "string");
}

function validPacket(value: unknown): value is ArchiveDraftPacket {
  if (!value || typeof value !== "object") return false;
  const p = value as ArchiveDraftPacket;
  if (!compact(p.unit_id) || !compact(p.source) || !p.evidence_scope || typeof p.evidence_scope !== "object") return false;
  const evidence = p.evidence_scope.selected_target_evidence;
  const context = p.evidence_scope.context_only;
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > 100 || !Array.isArray(context) || context.length > 1000) return false;
  if (new Set(evidence.map(item => item?.message_id)).size !== evidence.length) return false;
  return evidence.every(item => !!item && typeof item.message_id === "string" && !!item.message_id
      && typeof item.authored_text === "string" && typeof item.time === "number" && Number.isFinite(item.time)
      && (item.sender === null || typeof item.sender === "string"))
    && context.every(item => !!item && typeof item.role === "string" && typeof item.text === "string");
}

function validForm(value: unknown): value is ArchiveDraftForm {
  if (!value || typeof value !== "object") return false;
  const f = value as ArchiveDraftForm;
  return typeof f.content === "string" && f.content.length <= 20000
    && typeof f.type === "string" && f.type.length <= 100
    && typeof f.clarify === "boolean" && validClarification(f.clarification)
    && typeof f.checked === "boolean";
}

function parse(raw: string | null): ArchiveDraftSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ArchiveDraftSnapshot;
    if (value.version !== 1 || typeof value.id !== "string" || !value.id
      || !validPacket(value.packet) || !validForm(value.form)
      || !Number.isInteger(value.revision) || value.revision < 1
      || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
      || archiveDraftId(value.packet) !== value.id) return null;
    return value;
  } catch {
    return null;
  }
}

function readById(id: string): ArchiveDraftSnapshot | null {
  const s = storage();
  let raw: string | null;
  try {
    raw = s.getItem(keyForId(id));
  } catch {
    throw new ArchiveDraftStorageError("Local draft recovery could not read browser storage.");
  }
  if (!raw) return null;
  const snapshot = parse(raw);
  if (!snapshot) throw new ArchiveDraftStorageError("A saved local draft is invalid and was not loaded or overwritten.");
  return snapshot;
}

export function loadArchiveDraft(packet: ArchiveDraftPacket): ArchiveDraftSnapshot | null {
  return readById(archiveDraftId(packet));
}

export function listArchiveDrafts(): ArchiveDraftSnapshot[] {
  const s = storage();
  const rows: ArchiveDraftSnapshot[] = [];
  try {
    for (let index = 0; index < s.length; index++) {
      const key = s.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      const parsed = parse(s.getItem(key));
      if (parsed) rows.push(parsed);
    }
  } catch {
    throw new ArchiveDraftStorageError("Local draft recovery could not read browser storage.");
  }
  return rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function saveArchiveDraft(packet: ArchiveDraftPacket, form: ArchiveDraftForm, expectedRevision: number): ArchiveDraftSnapshot {
  if (!validPacket(packet) || !validForm(form)) throw new ArchiveDraftStorageError("This draft cannot be stored safely.");
  const id = archiveDraftId(packet);
  const s = storage();
  let current: ArchiveDraftSnapshot | null = null;
  try {
    const raw = s.getItem(keyForId(id));
    if (raw) {
      current = parse(raw);
      if (!current) throw new ArchiveDraftStorageError("A saved local draft is invalid and was not overwritten.");
    }
  } catch (error) {
    if (error instanceof ArchiveDraftStorageError) throw error;
    throw new ArchiveDraftStorageError("Local draft recovery could not read browser storage.");
  }
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== expectedRevision) throw new ArchiveDraftConflictError();

  const next: ArchiveDraftSnapshot = {
    version: 1,
    id,
    packet,
    form,
    revision: currentRevision + 1,
    updatedAt: new Date().toISOString(),
  };
  const encoded = JSON.stringify(next);
  if (encoded.length > 750_000) throw new ArchiveDraftStorageError("This evidence packet is too large for local draft recovery.");

  try {
    s.setItem(keyForId(id), encoded);
  } catch {
    throw new ArchiveDraftStorageError("Local draft recovery could not write browser storage.");
  }
  return next;
}

export function assertArchiveDraftCurrent(packet: ArchiveDraftPacket, expectedRevision: number): void {
  const current = readById(archiveDraftId(packet));
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== expectedRevision) throw new ArchiveDraftConflictError();
}

export function deleteArchiveDraft(packet: ArchiveDraftPacket, expectedRevision: number): void {
  const id = archiveDraftId(packet);
  const s = storage();
  let current: ArchiveDraftSnapshot | null = null;
  try {
    const raw = s.getItem(keyForId(id));
    if (!raw) {
      if (expectedRevision !== 0) throw new ArchiveDraftConflictError();
      return;
    }
    current = parse(raw);
    if (!current) throw new ArchiveDraftStorageError("A saved local draft is invalid and was not deleted.");
  } catch (error) {
    if (error instanceof ArchiveDraftConflictError || error instanceof ArchiveDraftStorageError) throw error;
    throw new ArchiveDraftStorageError("Local draft recovery could not read browser storage.");
  }
  if (current.revision !== expectedRevision) throw new ArchiveDraftConflictError();
  try {
    s.removeItem(keyForId(id));
  } catch {
    throw new ArchiveDraftStorageError("Local draft recovery could not update browser storage.");
  }
}
