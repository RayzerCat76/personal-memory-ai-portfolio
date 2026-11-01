import type { EncryptedAttachment } from "@/lib/study-peer-sync";

export type StudyTask = { id: string; title: string; done: boolean; due: string };
export type StudyReminderStatus = "scheduled" | "cancelled";
export type StudyReminder = { id: string; title: string; scheduledFor: string; status: StudyReminderStatus };
export type StudyMilestoneStatus = "" | "planned" | "in-progress" | "complete";
export type StudyAttachmentRef = {
  id: string; name: string; mediaType: string; size: number; keyEpoch: number; addedAt: string;
};
export type StoredStudyAttachment = StudyAttachmentRef & { bytes: ArrayBuffer; encrypted: EncryptedAttachment };
export type StudyBackupAttachment = Omit<StudyAttachmentRef, "keyEpoch"> & { dataBase64: string };
export const maxStudyAttachmentBytes = 25 * 1024 * 1024;
export const maxStudyBackupAttachmentBytes = 100 * 1024 * 1024;

export type StudyMilestone = {
  id: string;
  title: string;
  due: string;
  status: StudyMilestoneStatus;
  tasks: StudyTask[];
};
export type StudyRecord = { id: string; revision: number; updatedAt: string; kind: "note" | "project";
  title: string; body: string; subject: string; unit: string; pinned: boolean; tasks: StudyTask[]; archived?: boolean;
  nextAction?: string; milestones?: StudyMilestone[]; linkedNoteIds?: string[]; reminders?: StudyReminder[]; attachments?: StudyAttachmentRef[] };
export const studyDatabaseName = "personal-study-v1";
export const studyDatabaseVersion = 5;
export function openStudyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(studyDatabaseName, studyDatabaseVersion);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
      if (!db.objectStoreNames.contains("syncMeta")) db.createObjectStore("syncMeta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("syncConflicts")) db.createObjectStore("syncConflicts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("syncState")) db.createObjectStore("syncState", { keyPath: "id" });
      if (!db.objectStoreNames.contains("peerState")) db.createObjectStore("peerState", { keyPath: "id" });
      if (!db.objectStoreNames.contains("peerConflicts")) db.createObjectStore("peerConflicts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("attachments")) db.createObjectStore("attachments", { keyPath: "id" });
      if (event.oldVersion < 3) {
        const outbox = request.transaction!.objectStore("outbox");
        const cursorRequest = outbox.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const value = cursor.value as { id?: string };
          if (typeof value.id === "string" && !value.id.startsWith("m:")) {
            outbox.put({ ...value, id: `m:${crypto.randomUUID()}` });
            cursor.delete();
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function validTask(value: unknown): value is StudyTask {
  if (!value || typeof value !== "object") return false;
  const task = value as StudyTask;
  return typeof task.id === "string" && !!task.id
    && typeof task.title === "string" && !!task.title.trim() && task.title.length <= 10000
    && typeof task.done === "boolean" && typeof task.due === "string"
    && (!task.due || /^\d{4}-\d{2}-\d{2}$/.test(task.due));
}
function validReminder(value: unknown): value is StudyReminder {
  if (!value || typeof value !== "object") return false;
  const reminder = value as StudyReminder;
  return typeof reminder.id === "string" && !!reminder.id
    && typeof reminder.title === "string" && !!reminder.title.trim() && reminder.title.length <= 10000
    && typeof reminder.scheduledFor === "string" && Number.isFinite(Date.parse(reminder.scheduledFor))
    && ["scheduled", "cancelled"].includes(reminder.status);
}
function validMilestone(value: unknown): value is StudyMilestone {
  if (!value || typeof value !== "object") return false;
  const milestone = value as StudyMilestone;
  return typeof milestone.id === "string" && !!milestone.id
    && typeof milestone.title === "string" && !!milestone.title.trim() && milestone.title.length <= 10000
    && typeof milestone.due === "string" && (!milestone.due || /^\d{4}-\d{2}-\d{2}$/.test(milestone.due))
    && ["", "planned", "in-progress", "complete"].includes(milestone.status)
    && Array.isArray(milestone.tasks) && milestone.tasks.length <= 1000
    && new Set(milestone.tasks.map(t => t.id)).size === milestone.tasks.length
    && milestone.tasks.every(validTask);
}
function validAttachmentRef(value: unknown): value is StudyAttachmentRef {
  if (!value || typeof value !== "object") return false;
  const attachment = value as StudyAttachmentRef;
  return typeof attachment.id === "string" && !!attachment.id
    && typeof attachment.name === "string" && !!attachment.name.trim() && attachment.name.length <= 500
    && typeof attachment.mediaType === "string" && attachment.mediaType.length <= 200
    && Number.isInteger(attachment.size) && attachment.size >= 0 && attachment.size <= maxStudyAttachmentBytes
    && Number.isInteger(attachment.keyEpoch) && attachment.keyEpoch >= 1
    && typeof attachment.addedAt === "string" && Number.isFinite(Date.parse(attachment.addedAt));
}

export function validStudyRecord(value: unknown): value is StudyRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as StudyRecord;
  return typeof r.id === "string" && !!r.id && Number.isInteger(r.revision) && r.revision > 0
    && typeof r.updatedAt === "string" && Number.isFinite(Date.parse(r.updatedAt))
    && ["note", "project"].includes(r.kind) && typeof r.title === "string" && !!r.title.trim()
    && [r.title, r.body, r.subject, r.unit].every(s => typeof s === "string" && s.length <= 100000)
    && typeof r.pinned === "boolean" && (r.archived === undefined || typeof r.archived === "boolean")
    && (r.nextAction === undefined || (typeof r.nextAction === "string" && r.nextAction.length <= 10000))
    && (r.milestones === undefined || (Array.isArray(r.milestones) && r.milestones.length <= 250
      && new Set(r.milestones.map(m => m.id)).size === r.milestones.length && r.milestones.every(validMilestone)))
    && (r.linkedNoteIds === undefined || (r.kind === "project" && Array.isArray(r.linkedNoteIds) && r.linkedNoteIds.length <= 1000
      && new Set(r.linkedNoteIds).size === r.linkedNoteIds.length
      && r.linkedNoteIds.every(id => typeof id === "string" && !!id)))
    && (r.reminders === undefined || (r.kind === "project" && Array.isArray(r.reminders) && r.reminders.length <= 1000
      && new Set(r.reminders.map(reminder => reminder.id)).size === r.reminders.length
      && r.reminders.every(validReminder)))
    && (r.attachments === undefined || (Array.isArray(r.attachments) && r.attachments.length <= 50
      && new Set(r.attachments.map(attachment => attachment.id)).size === r.attachments.length
      && r.attachments.every(validAttachmentRef)))
    && Array.isArray(r.tasks) && r.tasks.length <= 1000
    && new Set(r.tasks.map(t => t.id)).size === r.tasks.length
    && r.tasks.every(validTask);
}
export async function listStudy(): Promise<StudyRecord[]> {
  const db = await openStudyDatabase();
  try { return await result(db.transaction("records").objectStore("records").getAll()); } finally { db.close(); }
}
export async function saveStudy(record: StudyRecord): Promise<StudyRecord> {
  const projectFields = record.kind === "project"
    ? { nextAction: record.nextAction ?? "", milestones: record.milestones ?? [], linkedNoteIds: record.linkedNoteIds ?? [], reminders: record.reminders ?? [] }
    : {};
  const next = { ...record, ...projectFields, archived: !!record.archived, revision: record.revision + 1, updatedAt: new Date().toISOString() };
  if (!validStudyRecord(next)) throw new Error("Add a title and check the note, task, milestone, reminder, or next-action fields.");
  const { saveStudyWithPeer } = await import("@/lib/study-peer-persistence");
  return saveStudyWithPeer(record, next);
}
export async function deleteStudy(record: StudyRecord): Promise<void> {
  const { deleteStudyWithPeer } = await import("@/lib/study-peer-persistence");
  await deleteStudyWithPeer(record);
}

export async function attachStudyFile(record: StudyRecord, file: File): Promise<StudyRecord> {
  const { attachStudyFileWithPeer } = await import("@/lib/study-peer-persistence");
  return attachStudyFileWithPeer(record, file);
}

export async function readStudyAttachment(ref: StudyAttachmentRef): Promise<Blob> {
  const { readStudyAttachmentBlob } = await import("@/lib/study-peer-persistence");
  return readStudyAttachmentBlob(ref);
}
export async function getStoredStudyAttachment(id: string): Promise<StoredStudyAttachment | undefined> {
  const db = await openStudyDatabase();
  try { return await result(db.transaction("attachments").objectStore("attachments").get(id)) as StoredStudyAttachment | undefined; }
  finally { db.close(); }
}

export async function listStoredStudyAttachments(): Promise<StoredStudyAttachment[]> {
  const db = await openStudyDatabase();
  try { return await result(db.transaction("attachments").objectStore("attachments").getAll()) as StoredStudyAttachment[]; }
  finally { db.close(); }
}

function bytesToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function base64ByteLength(value: string): number {
  try { return atob(value).length; } catch { return -1; }
}

function validBackupAttachment(value: unknown): value is StudyBackupAttachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as StudyBackupAttachment;
  return typeof attachment.id === "string" && !!attachment.id
    && typeof attachment.name === "string" && !!attachment.name.trim() && attachment.name.length <= 500
    && typeof attachment.mediaType === "string" && attachment.mediaType.length <= 200
    && Number.isInteger(attachment.size) && attachment.size >= 0 && attachment.size <= maxStudyAttachmentBytes
    && typeof attachment.addedAt === "string" && Number.isFinite(Date.parse(attachment.addedAt))
    && typeof attachment.dataBase64 === "string" && base64ByteLength(attachment.dataBase64) === attachment.size;
}

export async function exportStudy(): Promise<string> {
  const records = await listStudy();
  const referenced = new Map(records.flatMap(record => (record.attachments ?? []).map(ref => [ref.id, ref] as const)));
  const stored = new Map((await listStoredStudyAttachments()).map(item => [item.id, item]));
  let totalBytes = 0;
  const attachments: StudyBackupAttachment[] = [];
  for (const [id, ref] of [...referenced].sort(([a], [b]) => a.localeCompare(b))) {
    const local = stored.get(id);
    if (!local || local.bytes.byteLength !== ref.size || local.name !== ref.name || local.mediaType !== ref.mediaType) {
      throw new Error(`Attachment ${ref.name} is not available locally. Sync it before exporting a complete backup.`);
    }
    totalBytes += local.bytes.byteLength;
    if (totalBytes > maxStudyBackupAttachmentBytes) throw new Error("Study attachments exceed the 100 MB backup limit.");
    attachments.push({ id, name: ref.name, mediaType: ref.mediaType, size: ref.size, addedAt: ref.addedAt, dataBase64: bytesToBase64(local.bytes) });
  }
  return JSON.stringify({ format: "personal-study-backup-v1", records, ...(attachments.length ? { attachments } : {}) }, null, 2);
}

export async function restoreStudy(text: string): Promise<number> {
  const backup = JSON.parse(text);
  const recordsOk = backup.format === "personal-study-backup-v1" && Array.isArray(backup.records) && backup.records.length <= 10000
    && backup.records.every(validStudyRecord) && new Set(backup.records.map((r: StudyRecord) => r.id)).size === backup.records.length;
  const attachments = backup.attachments === undefined ? [] : backup.attachments;
  const attachmentsOk = Array.isArray(attachments) && attachments.length <= 500
    && attachments.every(validBackupAttachment) && new Set(attachments.map((item: StudyBackupAttachment) => item.id)).size === attachments.length
    && attachments.reduce((sum: number, item: StudyBackupAttachment) => sum + item.size, 0) <= maxStudyBackupAttachmentBytes;
  if (!recordsOk || !attachmentsOk) throw new Error("This is not a valid study backup.");
  const refs = new Set((backup.records as StudyRecord[]).flatMap(record => (record.attachments ?? []).map(ref => ref.id)));
  const attachmentIds = new Set((attachments as StudyBackupAttachment[]).map(item => item.id));
  if (refs.size !== attachmentIds.size || [...refs].some(id => !attachmentIds.has(id))) {
    throw new Error("This study backup is missing an attachment or contains an unreferenced attachment.");
  }
  const { restoreStudyWithPeer } = await import("@/lib/study-peer-persistence");
  return restoreStudyWithPeer(backup.records as StudyRecord[], attachments as StudyBackupAttachment[]);
}
