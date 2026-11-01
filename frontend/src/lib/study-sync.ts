import { openStudyDatabase, StudyRecord, validStudyRecord } from "@/lib/study-store";

export type StudySyncPutMutation = { id: string; operation: "put"; record: StudyRecord; baseServerRevision?: number };
export type StudySyncDeleteMutation = { id: string; operation: "delete"; recordId: string; revision: number; updatedAt: string; baseServerRevision?: number };
export type StudySyncMutation = StudySyncPutMutation | StudySyncDeleteMutation;
export type StudyRemoteChange = {
  serverRevision: number;
  recordId: string;
  operation: "put" | "delete";
  record?: StudyRecord;
  updatedAt: string;
  sourceMutationId?: string;
};
export type StudySyncAccepted = { mutationId: string; recordId: string; serverRevision: number };
export type StudySyncRejected = { mutationId: string; current: StudyRemoteChange };
export type StudySyncRequest = { clientId: string; cursor: string; mutations: StudySyncMutation[] };
export type StudySyncResponse = { cursor: string; accepted: StudySyncAccepted[]; rejected: StudySyncRejected[]; changes: StudyRemoteChange[] };
export type StudySyncPhase = "saved-offline" | "syncing" | "up-to-date" | "needs-review";
export type StudySyncState = { id: "state"; clientId: string; cursor: string; phase: StudySyncPhase; lastSyncedAt: string; lastError: string };
export type StudySyncMeta = { id: string; serverRevision: number; needsReview: boolean };
export type StudySyncConflict = {
  id: string;
  recordId: string;
  createdAt: string;
  localRecord: StudyRecord | null;
  localMutation: StudySyncMutation | null;
  remoteChange: StudyRemoteChange;
};
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("Study sync transaction aborted"));
    tx.onerror = () => reject(tx.error);
  });
}

function mutationRecordId(mutation: StudySyncMutation): string {
  return mutation.operation === "put" ? mutation.record.id : mutation.recordId;
}

function mutationRevision(mutation: StudySyncMutation): number {
  return mutation.operation === "put" ? mutation.record.revision : mutation.revision;
}

function announceSyncState() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("personal-study-sync-state"));
}

function announceRemoteStudyChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("personal-study-changed"));
  window.dispatchEvent(new Event("personal-study-sync-applied"));
}
export async function getStudySyncState(): Promise<StudySyncState> {
  const db = await openStudyDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("syncState", "readwrite");
    const store = tx.objectStore("syncState");
    let state: StudySyncState;
    const request = store.get("state");
    request.onsuccess = () => {
      state = request.result as StudySyncState | undefined ?? { id: "state", clientId: crypto.randomUUID(), cursor: "0", phase: "saved-offline", lastSyncedAt: "", lastError: "" };
      if (!request.result) store.put(state);
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => { db.close(); resolve(state); };
    tx.onabort = () => { const error = tx.error || new Error("Could not initialize study sync state"); db.close(); reject(error); };
    tx.onerror = () => undefined;
  });
}

async function putStudySyncState(state: StudySyncState): Promise<void> {
  const db = await openStudyDatabase();
  try {
    const tx = db.transaction("syncState", "readwrite");
    tx.objectStore("syncState").put(state);
    await transactionDone(tx);
  } finally { db.close(); }
  announceSyncState();
}

export async function markStudySyncOffline(lastError = ""): Promise<StudySyncState> {
  const state = await getStudySyncState();
  if (state.phase === "needs-review") return state;
  const next = { ...state, phase: "saved-offline" as const, lastError };
  await putStudySyncState(next);
  return next;
}

export async function listStudySyncConflicts(): Promise<StudySyncConflict[]> {
  const db = await openStudyDatabase();
  try {
    return (await requestResult(db.transaction("syncConflicts").objectStore("syncConflicts").getAll()) as StudySyncConflict[])
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } finally { db.close(); }
}

async function readPendingMutations(): Promise<StudySyncMutation[]> {
  const db = await openStudyDatabase();
  try {
    const tx = db.transaction(["outbox", "syncMeta"]);
    const [all, meta] = await Promise.all([
      requestResult(tx.objectStore("outbox").getAll()) as Promise<StudySyncMutation[]>,
      requestResult(tx.objectStore("syncMeta").getAll()) as Promise<StudySyncMeta[]>,
    ]);
    const blocked = new Set(meta.filter(item => item.needsReview).map(item => item.id));
    const latest = new Map<string, StudySyncMutation>();
    for (const mutation of all) {
      const recordId = mutationRecordId(mutation);
      if (blocked.has(recordId)) continue;
      const current = latest.get(recordId);
      if (!current || mutationRevision(mutation) > mutationRevision(current)) latest.set(recordId, mutation);
    }
    return [...latest.values()].sort((a, b) => mutationRecordId(a).localeCompare(mutationRecordId(b)));
  } finally { db.close(); }
}
function validRemoteChange(change: StudyRemoteChange): boolean {
  return Number.isInteger(change.serverRevision) && change.serverRevision > 0
    && typeof change.recordId === "string" && !!change.recordId
    && ["put", "delete"].includes(change.operation)
    && typeof change.updatedAt === "string" && Number.isFinite(Date.parse(change.updatedAt))
    && (change.operation === "delete" || (!!change.record && change.record.id === change.recordId && validStudyRecord(change.record)));
}

function validateResponse(response: StudySyncResponse): void {
  if (!response || typeof response.cursor !== "string" || !Array.isArray(response.accepted)
    || !Array.isArray(response.rejected) || !Array.isArray(response.changes)) throw new Error("Invalid study sync response.");
  if (!response.accepted.every(item => typeof item.mutationId === "string" && typeof item.recordId === "string"
      && Number.isInteger(item.serverRevision) && item.serverRevision > 0)) throw new Error("Invalid sync acknowledgement.");
  if (!response.rejected.every(item => typeof item.mutationId === "string" && validRemoteChange(item.current))
      || !response.changes.every(validRemoteChange)) throw new Error("Invalid remote study change.");
}

function localizeRemoteRecord(remote: StudyRecord, current?: StudyRecord): StudyRecord {
  return { ...structuredClone(remote), revision: (current?.revision ?? 0) + 1 };
}

function conflictId(recordId: string, serverRevision: number, mutationId = "pull"): string {
  return `${recordId}:${serverRevision}:${mutationId}`;
}
async function applyStudySyncResponse(response: StudySyncResponse): Promise<number> {
  validateResponse(response);
  const db = await openStudyDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["records", "outbox", "syncMeta", "syncConflicts"], "readwrite");
    const recordsStore = tx.objectStore("records");
    const outboxStore = tx.objectStore("outbox");
    const metaStore = tx.objectStore("syncMeta");
    const conflictsStore = tx.objectStore("syncConflicts");
    let records: StudyRecord[] = []; let outbox: StudySyncMutation[] = [];
    let metas: StudySyncMeta[] = []; let conflicts: StudySyncConflict[] = []; let ready = 0; let conflictCount = 0;
    const done = () => { if (++ready === 4) process(); };
    const reads = [
      [recordsStore.getAll(), (value: unknown) => { records = value as StudyRecord[]; }],
      [outboxStore.getAll(), (value: unknown) => { outbox = value as StudySyncMutation[]; }],
      [metaStore.getAll(), (value: unknown) => { metas = value as StudySyncMeta[]; }],
      [conflictsStore.getAll(), (value: unknown) => { conflicts = value as StudySyncConflict[]; }],
    ] as const;
    for (const [request, assign] of reads) {
      request.onsuccess = () => { assign(request.result); done(); };
      request.onerror = () => tx.abort();
    }
    tx.oncomplete = () => { db.close(); resolve(conflictCount); };
    tx.onabort = () => { const error = tx.error || new Error("Study sync apply aborted"); db.close(); reject(error); };
    tx.onerror = () => undefined;
    function process() {
      const recordMap = new Map(records.map(record => [record.id, record]));
      const metaMap = new Map(metas.map(meta => [meta.id, meta]));
      const outboxById = new Map(outbox.map(mutation => [mutation.id, mutation]));
      const conflictKeys = new Set(conflicts.map(conflict => conflict.id));
      let remaining = [...outbox];
      const acceptedIds = new Set(response.accepted.map(item => item.mutationId));

      for (const accepted of response.accepted) {
        const mutation = outboxById.get(accepted.mutationId);
        if (mutation) {
          const acceptedRevision = mutationRevision(mutation);
          remaining = remaining.filter(item => {
            const remove = mutationRecordId(item) === accepted.recordId && mutationRevision(item) <= acceptedRevision;
            if (remove) outboxStore.delete(item.id);
            return !remove;
          });
          for (const item of remaining) {
            if (mutationRecordId(item) === accepted.recordId && mutationRevision(item) > acceptedRevision) {
              outboxStore.put({ ...item, baseServerRevision: accepted.serverRevision });
            }
          }
        }
        const currentMeta = metaMap.get(accepted.recordId) ?? { id: accepted.recordId, serverRevision: 0, needsReview: false };
        const nextMeta = { ...currentMeta, serverRevision: Math.max(currentMeta.serverRevision, accepted.serverRevision) };
        metaMap.set(accepted.recordId, nextMeta); metaStore.put(nextMeta);
      }

      const addConflict = (remote: StudyRemoteChange, mutation: StudySyncMutation | null) => {
        const id = conflictId(remote.recordId, remote.serverRevision, mutation?.id);
        if (!conflictKeys.has(id)) {
          conflictsStore.put({ id, recordId: remote.recordId, createdAt: new Date().toISOString(), localRecord: recordMap.get(remote.recordId) ?? null, localMutation: mutation, remoteChange: remote });
          conflictKeys.add(id);
        }
        const currentMeta = metaMap.get(remote.recordId) ?? { id: remote.recordId, serverRevision: 0, needsReview: false };
        const nextMeta = { ...currentMeta, serverRevision: Math.max(currentMeta.serverRevision, remote.serverRevision), needsReview: true };
        metaMap.set(remote.recordId, nextMeta); metaStore.put(nextMeta);
      };
      for (const rejected of response.rejected) {
        const mutation = outboxById.get(rejected.mutationId) ?? null;
        if (mutation) addConflict(rejected.current, mutation);
      }

      for (const remote of [...response.changes].sort((a, b) => a.serverRevision - b.serverRevision)) {
        const currentMeta = metaMap.get(remote.recordId) ?? { id: remote.recordId, serverRevision: 0, needsReview: false };
        if (remote.serverRevision <= currentMeta.serverRevision) continue;
        if (remote.sourceMutationId && acceptedIds.has(remote.sourceMutationId)) {
          const nextMeta = { ...currentMeta, serverRevision: remote.serverRevision };
          metaMap.set(remote.recordId, nextMeta); metaStore.put(nextMeta);
          continue;
        }
        const pending = remaining.filter(item => mutationRecordId(item) === remote.recordId);
        if (currentMeta.needsReview) { addConflict(remote, pending.at(-1) ?? null); continue; }
        if (pending.length) {
          const knownRevision = Math.max(...pending.map(item => item.baseServerRevision ?? 0));
          if (remote.serverRevision > knownRevision) { addConflict(remote, pending.at(-1) ?? null); continue; }
          const nextMeta = { ...currentMeta, serverRevision: Math.max(currentMeta.serverRevision, remote.serverRevision) };
          metaMap.set(remote.recordId, nextMeta); metaStore.put(nextMeta);
          continue;
        }
        if (remote.operation === "put" && remote.record) {
          const localized = localizeRemoteRecord(remote.record, recordMap.get(remote.recordId));
          recordsStore.put(localized); recordMap.set(remote.recordId, localized);
        } else {
          recordsStore.delete(remote.recordId); recordMap.delete(remote.recordId);
        }
        const nextMeta = { id: remote.recordId, serverRevision: remote.serverRevision, needsReview: false };
        metaMap.set(remote.recordId, nextMeta); metaStore.put(nextMeta);
      }
      conflictCount = conflictKeys.size;
    }
  });
}
export async function runStudySync(exchange: (request: StudySyncRequest) => Promise<StudySyncResponse>): Promise<StudySyncState> {
  const initial = await getStudySyncState();
  await putStudySyncState({ ...initial, phase: "syncing", lastError: "" });
  try {
    const request: StudySyncRequest = { clientId: initial.clientId, cursor: initial.cursor, mutations: await readPendingMutations() };
    const response = await exchange(request);
    const conflictCount = await applyStudySyncResponse(response);
    const next: StudySyncState = {
      ...initial,
      cursor: response.cursor,
      phase: conflictCount ? "needs-review" : "up-to-date",
      lastSyncedAt: new Date().toISOString(),
      lastError: "",
    };
    await putStudySyncState(next);
    announceRemoteStudyChange();
    return next;
  } catch (error) {
    const next: StudySyncState = {
      ...initial,
      phase: "saved-offline",
      lastError: error instanceof Error ? error.message : "Study sync failed.",
    };
    await putStudySyncState(next);
    throw error;
  }
}

export async function runStudySyncOverHttp(url: string): Promise<StudySyncState> {
  return runStudySync(async request => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Study sync unavailable (${response.status}).`);
    return await response.json() as StudySyncResponse;
  });
}
export async function resolveStudySyncConflict(conflictIdValue: string, choice: "local" | "remote"): Promise<void> {
  const db = await openStudyDatabase();
  let stale = false; let needsSync = false; let remoteApplied = false;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["records", "outbox", "syncMeta", "syncConflicts"], "readwrite");
    const recordsStore = tx.objectStore("records"); const outboxStore = tx.objectStore("outbox");
    const metaStore = tx.objectStore("syncMeta"); const conflictsStore = tx.objectStore("syncConflicts");
    let conflict: StudySyncConflict | undefined; let records: StudyRecord[] = []; let current: StudyRecord | undefined;
    let outbox: StudySyncMutation[] = []; let conflicts: StudySyncConflict[] = []; let ready = 0;
    const done = () => { if (++ready === 4) process(); };
    const reads = [
      [conflictsStore.get(conflictIdValue), (value: unknown) => { conflict = value as StudySyncConflict | undefined; }],
      [recordsStore.getAll(), (value: unknown) => { records = value as StudyRecord[]; }],
      [outboxStore.getAll(), (value: unknown) => { outbox = value as StudySyncMutation[]; }],
      [conflictsStore.getAll(), (value: unknown) => { conflicts = value as StudySyncConflict[]; }],
    ] as const;
    for (const [request, assign] of reads) { request.onsuccess = () => { assign(request.result); done(); }; request.onerror = () => tx.abort(); }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(stale ? new Error("This item changed after the sync conflict appeared. Reopen it before resolving.") : tx.error || new Error("Conflict resolution aborted"));
    tx.onerror = () => undefined;

    function process() {
      if (!conflict) { stale = true; tx.abort(); return; }
      current = records.find(record => record.id === conflict!.recordId);
      const recordConflicts = conflicts.filter(item => item.recordId === conflict!.recordId);
      const latest = recordConflicts.sort((a, b) => b.remoteChange.serverRevision - a.remoteChange.serverRevision)[0] ?? conflict;
      const pending = outbox.filter(item => mutationRecordId(item) === conflict!.recordId);
      if (choice === "remote") {
        if (JSON.stringify(current ?? null) !== JSON.stringify(latest.localRecord)) { stale = true; tx.abort(); return; }
        for (const mutation of pending) outboxStore.delete(mutation.id);
        if (latest.remoteChange.operation === "put" && latest.remoteChange.record) recordsStore.put(localizeRemoteRecord(latest.remoteChange.record, current));
        else recordsStore.delete(conflict!.recordId);
        remoteApplied = true;
      } else {
        if (!pending.length) { stale = true; tx.abort(); return; }
        for (const mutation of pending) outboxStore.put({ ...mutation, baseServerRevision: latest.remoteChange.serverRevision });
        needsSync = true;
      }
      for (const item of recordConflicts) conflictsStore.delete(item.id);
      metaStore.put({ id: conflict!.recordId, serverRevision: latest.remoteChange.serverRevision, needsReview: false });
    }
  }).finally(() => db.close());

  const remaining = await listStudySyncConflicts();
  const state = await getStudySyncState();
  await putStudySyncState({ ...state, phase: remaining.length ? "needs-review" : needsSync ? "saved-offline" : "up-to-date", lastError: "" });
  if (remoteApplied) announceRemoteStudyChange();
  if (needsSync && typeof window !== "undefined") window.dispatchEvent(new Event("personal-study-sync-needed"));
}