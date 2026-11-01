import { api, type MemoryPeerApplyItem, type MemoryPeerOutboxEvent, type MemoryPeerRecord } from "@/lib/api";
import { maxStudyAttachmentBytes, openStudyDatabase, StudyAttachmentRef, StudyBackupAttachment, StudyRecord, StoredStudyAttachment, validStudyRecord } from "@/lib/study-store";
import {
  decryptAttachment,
  encryptAttachment,
  exportPublicSigningKey,
  generateVaultKey,
  PeerEnvelope,
  PeerReplica,
  PeerReplicaSnapshot,
  ReplicaRecordState,
  syncPeerReplica,
  TrustedDevice,
} from "@/lib/study-peer-sync";
import {
  createEpochKeyGrant,
  createPairingJoinRequest,
  createPairingOffer,
  createRecoverySecret,
  decodePairingOffer,
  derivePairingShortCode,
  derivePairingWrapKey,
  encodePairingOffer,
  EpochKeyGrant,
  exportAesKey,
  exportPairingPublicKey,
  generatePairingKeys,
  importAesKey,
  openEpochKeyGrant,
  openPairingApproval,
  PairingJoinRequest,
  PairingOffer,
  recoveryKeyFromSecret,
  sealPairingApproval,
  StudyRecoveryKit,
  unwrapRecoveryVaultKey,
  verifyPairingJoinRequest,
  wrapRecoveryVaultKey,
} from "@/lib/study-peer-pairing";
import { downloadEncryptedAttachment, planStudyRelayCompaction, resolveStudyRelay, StudyRelayCompactionPlan, StudyRelaySource, uploadEncryptedAttachment } from "@/lib/study-relay";

type PersonalPeerRecord = StudyRecord | MemoryPeerRecord;

function isMemoryPeerRecord(value: unknown): value is MemoryPeerRecord {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "memory-peer");
}

const memoryPeerSyncEnabled = process.env.NEXT_PUBLIC_MEMORY_PEER_SYNC_ENABLED === "1";

export type StudyPeerPhase = "saved-offline" | "syncing" | "up-to-date" | "needs-review" | "revoked";
export type StudyPeerStatus = {
  phase: StudyPeerPhase;
  lastSyncedAt: string;
  lastError: string;
  deviceId: string;
  vaultId: string;
};

export type StudyPeerConflict = {
  id: string;
  recordId: string;
  kind: "note" | "project";
  createdAt: string;
  variants: Array<{ mutationId: string; operation: "put" | "delete"; record?: StudyRecord }>;
};

type StoredPeerState = {
  id: "state";
  stateRevision: number;
  initializedAt: string;
  phase: StudyPeerPhase;
  lastSyncedAt: string;
  lastError: string;
  vaultId: string;
  deviceId: string;
  signingKeys: CryptoKeyPair;
  pairingKeys?: CryptoKeyPair;
  epochKeys: Array<{ epoch: number; key: CryptoKey }>;
  pendingKeyGrants?: EpochKeyGrant[];
  manifestSequence?: number;
  snapshot: PeerReplicaSnapshot<PersonalPeerRecord>;
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
    tx.onabort = () => reject(tx.error || new Error("Study peer transaction aborted."));
    tx.onerror = () => reject(tx.error);
  });
}

async function withPeerWriteLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request("personal-study-peer-write-v1", work);
  }
  return work();
}

function announcePeerChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("personal-study-changed"));
  window.dispatchEvent(new Event("personal-study-sync-applied"));
  window.dispatchEvent(new Event("personal-study-sync-state"));
}

function announceSyncNeeded() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("personal-study-changed"));
  window.dispatchEvent(new Event("personal-study-sync-needed"));
  window.dispatchEvent(new Event("personal-study-sync-state"));
}

function replicaFromStored(state: StoredPeerState): PeerReplica<PersonalPeerRecord> {
  return PeerReplica.restore<PersonalPeerRecord>({
    vaultId: state.vaultId,
    deviceId: state.deviceId,
    signingKeys: state.signingKeys,
    epochKeys: state.epochKeys,
    snapshot: state.snapshot,
  });
}

function storedFromReplica(
  previous: StoredPeerState,
  replica: PeerReplica<PersonalPeerRecord>,
  updates: Partial<Pick<StoredPeerState, "phase" | "lastSyncedAt" | "lastError">> = {},
): StoredPeerState {
  return {
    ...previous,
    ...updates,
    stateRevision: previous.stateRevision + 1,
    epochKeys: replica.getEpochKeys(),
    snapshot: replica.exportSnapshot(),
  };
}

async function readStoredPeerState(): Promise<StoredPeerState | undefined> {
  const db = await openStudyDatabase();
  try {
    return await requestResult(db.transaction("peerState").objectStore("peerState").get("state")) as StoredPeerState | undefined;
  } finally { db.close(); }
}

async function createInitialPeerState(): Promise<StoredPeerState> {
  const db = await openStudyDatabase();
  let records: StudyRecord[];
  try {
    records = await requestResult(db.transaction("records").objectStore("records").getAll()) as StudyRecord[];
  } finally { db.close(); }
  const replica = await PeerReplica.create<PersonalPeerRecord>();
  const pairingKeys = await generatePairingKeys();
  const self = (await replica.descriptor(true));
  replica.trustDevice({ ...self, publicPairingKey: await exportPairingPublicKey(pairingKeys.publicKey) });
  for (const record of [...records].sort((a, b) => a.id.localeCompare(b.id))) {
    await replica.createMutation(record.id, "put", record);
  }
  return {
    id: "state",
    stateRevision: 1,
    initializedAt: new Date().toISOString(),
    phase: "saved-offline",
    lastSyncedAt: "",
    lastError: "",
    vaultId: replica.vaultId,
    deviceId: replica.deviceId,
    signingKeys: replica.signingKeys,
    pairingKeys,
    epochKeys: replica.getEpochKeys(),
    pendingKeyGrants: [],
    manifestSequence: 0,
    snapshot: replica.exportSnapshot(),
  };
}

export async function ensureStudyPeerState(): Promise<StoredPeerState> {
  const existing = await readStoredPeerState();
  if (existing) return existing;
  const candidate = await createInitialPeerState();
  const db = await openStudyDatabase();
  try {
    const tx = db.transaction("peerState", "readwrite");
    const store = tx.objectStore("peerState");
    const current = await requestResult(store.get("state")) as StoredPeerState | undefined;
    if (!current) store.put(candidate);
    await transactionDone(tx);
    return current ?? candidate;
  } finally { db.close(); }
}

async function commitPut(
  original: StudyRecord,
  next: StudyRecord,
  expectedState: StoredPeerState,
  nextState: StoredPeerState,
): Promise<void> {
  const db = await openStudyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["records", "peerState"], "readwrite");
      const records = tx.objectStore("records");
      const peerState = tx.objectStore("peerState");
      let currentRecord: StudyRecord | undefined;
      let currentState: StoredPeerState | undefined;
      let ready = 0;
      let stale = false;
      const check = () => {
        if (++ready !== 2) return;
        if ((currentRecord?.revision ?? 0) !== original.revision || currentState?.stateRevision !== expectedState.stateRevision) {
          stale = true; tx.abort(); return;
        }
        records.put(next);
        peerState.put(nextState);
      };
      const recordRequest = records.get(original.id);
      recordRequest.onsuccess = () => { currentRecord = recordRequest.result; check(); };
      recordRequest.onerror = () => tx.abort();
      const stateRequest = peerState.get("state");
      stateRequest.onsuccess = () => { currentState = stateRequest.result; check(); };
      stateRequest.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(stale
        ? new Error("This item changed in another tab. Reopen it before editing; your current text has not been saved.")
        : tx.error || new Error("Local peer save aborted."));
      tx.onerror = () => undefined;
    });
  } finally { db.close(); }
}

export async function saveStudyWithPeer(original: StudyRecord, next: StudyRecord): Promise<StudyRecord> {
  return withPeerWriteLock(async () => {
    const state = await ensureStudyPeerState();
    const replica = replicaFromStored(state);
    await replica.createMutation(next.id, "put", next);
    const nextState = storedFromReplica(state, replica, { phase: "saved-offline", lastError: "" });
    await commitPut(original, next, state, nextState);
    announceSyncNeeded();
    return next;
  });
}

function epochKey(state: StoredPeerState, epoch: number): CryptoKey {
  const found = state.epochKeys.find(item => item.epoch === epoch);
  if (!found) throw new Error(`This device does not have attachment encryption epoch ${epoch}.`);
  return found.key;
}

async function commitPutWithAttachment(
  original: StudyRecord, next: StudyRecord, attachment: StoredStudyAttachment,
  expectedState: StoredPeerState, nextState: StoredPeerState,
): Promise<void> {
  const db = await openStudyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["records", "peerState", "attachments"], "readwrite");
      const records = tx.objectStore("records"); const peerState = tx.objectStore("peerState"); const attachments = tx.objectStore("attachments");
      let currentRecord: StudyRecord | undefined; let currentState: StoredPeerState | undefined; let ready = 0; let stale = false;
      const check = () => {
        if (++ready !== 2) return;
        if ((currentRecord?.revision ?? 0) !== original.revision || currentState?.stateRevision !== expectedState.stateRevision) { stale = true; tx.abort(); return; }
        records.put(next); attachments.put(attachment); peerState.put(nextState);
      };
      const recordRequest = records.get(original.id);
      recordRequest.onsuccess = () => { currentRecord = recordRequest.result; check(); }; recordRequest.onerror = () => tx.abort();
      const stateRequest = peerState.get("state");
      stateRequest.onsuccess = () => { currentState = stateRequest.result; check(); }; stateRequest.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(stale ? new Error("This item changed before the attachment could be saved. Reopen it and try again.") : tx.error || new Error("Attachment save aborted."));
      tx.onerror = () => undefined;
    });
  } finally { db.close(); }
}

export async function attachStudyFileWithPeer(record: StudyRecord, file: File): Promise<StudyRecord> {
  if (record.revision < 1) throw new Error("Save this item before attaching a file.");
  if (!file.name.trim()) throw new Error("Attachment name is missing.");
  if (file.size > maxStudyAttachmentBytes) throw new Error("Attachments are limited to 25 MB each.");
  return withPeerWriteLock(async () => {
    const state = await ensureStudyPeerState();
    const keyEpoch = state.snapshot.currentEpoch;
    const attachmentId = crypto.randomUUID(); const addedAt = new Date().toISOString();
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size) throw new Error("Attachment size changed while it was being read.");
    const encrypted = await encryptAttachment(new Uint8Array(bytes), epochKey(state, keyEpoch), attachmentId);
    const ref: StudyAttachmentRef = { id: attachmentId, name: file.name, mediaType: file.type || "application/octet-stream", size: file.size, keyEpoch, addedAt };
    const next: StudyRecord = { ...record, attachments: [...(record.attachments ?? []), ref], revision: record.revision + 1, updatedAt: new Date().toISOString() };
    if (!validStudyRecord(next)) throw new Error("This attachment would make the Study item invalid.");
    const replica = replicaFromStored(state); await replica.createMutation(next.id, "put", next);
    const nextState = storedFromReplica(state, replica, { phase: "saved-offline", lastError: "" });
    const stored: StoredStudyAttachment = { ...ref, bytes, encrypted };
    await commitPutWithAttachment(record, next, stored, state, nextState);
    announceSyncNeeded();
    return next;
  });
}

export async function readStudyAttachmentBlob(ref: StudyAttachmentRef): Promise<Blob> {
  const db = await openStudyDatabase();
  try {
    const stored = await requestResult(db.transaction("attachments").objectStore("attachments").get(ref.id)) as StoredStudyAttachment | undefined;
    if (!stored || stored.bytes.byteLength !== ref.size) throw new Error("This attachment is not available locally yet. Sync this device and try again.");
    return new Blob([stored.bytes], { type: ref.mediaType || "application/octet-stream" });
  } finally { db.close(); }
}

async function commitDelete(
  record: StudyRecord,
  expectedState: StoredPeerState,
  nextState: StoredPeerState,
): Promise<void> {
  const db = await openStudyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["records", "peerState"], "readwrite");
      const records = tx.objectStore("records");
      const peerState = tx.objectStore("peerState");
      let currentRecord: StudyRecord | undefined;
      let currentState: StoredPeerState | undefined;
      let ready = 0;
      let stale = false;
      const check = () => {
        if (++ready !== 2) return;
        if (!currentRecord || currentRecord.revision !== record.revision || currentState?.stateRevision !== expectedState.stateRevision) {
          stale = true; tx.abort(); return;
        }
        records.delete(record.id);
        peerState.put(nextState);
      };
      const recordRequest = records.get(record.id);
      recordRequest.onsuccess = () => { currentRecord = recordRequest.result; check(); };
      recordRequest.onerror = () => tx.abort();
      const stateRequest = peerState.get("state");
      stateRequest.onsuccess = () => { currentState = stateRequest.result; check(); };
      stateRequest.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(stale
        ? new Error("This item changed in another tab. Reopen it before deleting; nothing was deleted.")
        : tx.error || new Error("Local peer delete aborted."));
      tx.onerror = () => undefined;
    });
  } finally { db.close(); }
}

export async function deleteStudyWithPeer(record: StudyRecord): Promise<void> {
  return withPeerWriteLock(async () => {
    const state = await ensureStudyPeerState();
    const replica = replicaFromStored(state);
    await replica.createMutation(record.id, "delete");
    const nextState = storedFromReplica(state, replica, { phase: "saved-offline", lastError: "" });
    await commitDelete(record, state, nextState);
    announceSyncNeeded();
  });
}

function backupAttachmentBytes(item: StudyBackupAttachment): ArrayBuffer {
  const binary = atob(item.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a); const right = new Uint8Array(b);
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

export async function restoreStudyWithPeer(
  recordsToRestore: StudyRecord[],
  backupAttachments: StudyBackupAttachment[] = [],
): Promise<number> {
  return withPeerWriteLock(async () => {
    const state = await ensureStudyPeerState();
    const db = await openStudyDatabase();
    let currentRecords: StudyRecord[]; let currentAttachments: StoredStudyAttachment[];
    try {
      const tx = db.transaction(["records", "attachments"]);
      [currentRecords, currentAttachments] = await Promise.all([
        requestResult(tx.objectStore("records").getAll()) as Promise<StudyRecord[]>,
        requestResult(tx.objectStore("attachments").getAll()) as Promise<StoredStudyAttachment[]>,
      ]);
    } finally { db.close(); }
    const currentMap = new Map(currentRecords.map(record => [record.id, record]));
    const attachmentMap = new Map(currentAttachments.map(item => [item.id, item]));
    const backupMap = new Map(backupAttachments.map(item => [item.id, item]));
    for (const record of recordsToRestore) {
      const current = currentMap.get(record.id);
      if (current && JSON.stringify(current) !== JSON.stringify(record)) {
        throw new Error("Backup conflicts with a local item. Nothing was imported; both versions remain in the local store and backup file.");
      }
    }

    const missingOriginal = recordsToRestore.filter(record => !currentMap.has(record.id));
    const targetEpoch = new Map<string, number>();
    for (const record of recordsToRestore) {
      const current = currentMap.get(record.id);
      for (const ref of current?.attachments ?? []) targetEpoch.set(ref.id, ref.keyEpoch);
    }
    for (const local of currentAttachments) if (!targetEpoch.has(local.id)) targetEpoch.set(local.id, local.keyEpoch);
    for (const record of missingOriginal) {
      for (const ref of record.attachments ?? []) if (!targetEpoch.has(ref.id)) targetEpoch.set(ref.id, state.snapshot.currentEpoch);
    }

    const prepared: StoredStudyAttachment[] = [];
    for (const [id, keyEpoch] of targetEpoch) {
      const backup = backupMap.get(id); if (!backup) continue;
      const bytes = backupAttachmentBytes(backup);
      const local = attachmentMap.get(id);
      if (local) {
        if (local.name !== backup.name || local.mediaType !== backup.mediaType || local.size !== backup.size
            || local.addedAt !== backup.addedAt || !sameBytes(local.bytes, bytes)) {
          throw new Error(`Backup attachment ${backup.name} conflicts with a local attachment of the same ID.`);
        }
        continue;
      }
      const encrypted = await encryptAttachment(new Uint8Array(bytes), epochKey(state, keyEpoch), id);
      prepared.push({ id, name: backup.name, mediaType: backup.mediaType, size: backup.size, addedAt: backup.addedAt, keyEpoch, bytes, encrypted });
    }

    const missing = missingOriginal.map(record => {
      const attachments = (record.attachments ?? []).map(ref => ({ ...ref, keyEpoch: targetEpoch.get(ref.id) ?? state.snapshot.currentEpoch }));
      const adjusted = { ...record, ...(record.attachments ? { attachments } : {}) };
      if (!validStudyRecord(adjusted)) throw new Error("Backup contains an invalid Study item after attachment recovery.");
      return adjusted;
    });
    if (!missing.length && !prepared.length) return 0;

    const replica = replicaFromStored(state);
    for (const record of [...missing].sort((a, b) => a.id.localeCompare(b.id))) await replica.createMutation(record.id, "put", record);
    const nextState = missing.length ? storedFromReplica(state, replica, { phase: "saved-offline", lastError: "" }) : state;
    const commitDb = await openStudyDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = commitDb.transaction(["records", "peerState", "attachments"], "readwrite");
        const recordStore = tx.objectStore("records"); const stateStore = tx.objectStore("peerState"); const attachmentStore = tx.objectStore("attachments");
        let latestRecords: StudyRecord[] = []; let latestState: StoredPeerState | undefined; let ready = 0; let stale = false;
        const check = () => {
          if (++ready !== 2) return;
          if (latestState?.stateRevision !== state.stateRevision || JSON.stringify(latestRecords) !== JSON.stringify(currentRecords)) {
            stale = true; tx.abort(); return;
          }
          for (const record of missing) recordStore.put(record);
          for (const attachment of prepared) attachmentStore.put(attachment);
          if (missing.length) stateStore.put(nextState);
        };
        const recordsRequest = recordStore.getAll();
        recordsRequest.onsuccess = () => { latestRecords = recordsRequest.result; check(); }; recordsRequest.onerror = () => tx.abort();
        const stateRequest = stateStore.get("state");
        stateRequest.onsuccess = () => { latestState = stateRequest.result; check(); }; stateRequest.onerror = () => tx.abort();
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(stale ? new Error("Study data changed while the backup was being restored. Nothing was imported.") : tx.error || new Error("Study restore aborted."));
        tx.onerror = () => undefined;
      });
    } finally { commitDb.close(); }
    if (missing.length) announceSyncNeeded();
    return missing.length;
  });
}

async function persistStateOnly(expected: StoredPeerState, next: StoredPeerState): Promise<void> {
  const db = await openStudyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("peerState", "readwrite");
      const store = tx.objectStore("peerState");
      let stale = false;
      const request = store.get("state");
      request.onsuccess = () => {
        const current = request.result as StoredPeerState | undefined;
        if (current?.stateRevision !== expected.stateRevision) { stale = true; tx.abort(); return; }
        store.put(next);
      };
      request.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(stale ? new Error("Peer state changed concurrently.") : tx.error || new Error("Peer state update aborted."));
      tx.onerror = () => undefined;
    });
  } finally { db.close(); }
}

function sameStudyPayload(a: StudyRecord, b: StudyRecord): boolean {
  return JSON.stringify({ ...a, revision: 0 }) === JSON.stringify({ ...b, revision: 0 });
}

function localizedRecord(remote: StudyRecord, current?: StudyRecord): StudyRecord {
  return { ...structuredClone(remote), revision: (current?.revision ?? 0) + 1 };
}

async function materializeReplica(
  expected: StoredPeerState,
  nextState: StoredPeerState,
  replica: PeerReplica<PersonalPeerRecord>,
): Promise<number> {
  const readDb = await openStudyDatabase();
  let currentRecords: StudyRecord[] = []; let existingConflicts: StudyPeerConflict[] = [];
  try {
    const tx = readDb.transaction(["records", "peerConflicts"]);
    [currentRecords, existingConflicts] = await Promise.all([
      requestResult(tx.objectStore("records").getAll()) as Promise<StudyRecord[]>,
      requestResult(tx.objectStore("peerConflicts").getAll()) as Promise<StudyPeerConflict[]>,
    ]);
  } finally { readDb.close(); }

  const recordMap = new Map(currentRecords.map(record => [record.id, record]));
  const conflictMap = new Map(existingConflicts.map(conflict => [conflict.recordId, conflict]));
  const nextConflicts = new Map<string, StudyPeerConflict>();
  for (const state of replica.listRecordStates()) {
    if (state.recordId.startsWith("memory-peer:")) continue;
    const current = recordMap.get(state.recordId);
    if (state.status === "value") {
      if (!state.value || !validStudyRecord(state.value)) throw new Error("Synced Study record is invalid.");
      const studyValue = state.value as StudyRecord;
      if (!current || !sameStudyPayload(current, studyValue)) recordMap.set(state.recordId, localizedRecord(studyValue, current));
      continue;
    }
    if (state.status === "deleted") { recordMap.delete(state.recordId); continue; }
    if (state.status !== "conflict") continue;
    if (state.variants.every(variant => variant.operation === "delete")) { recordMap.delete(state.recordId); continue; }
    for (const variant of state.variants) {
      if (variant.operation === "put" && (!variant.record || !validStudyRecord(variant.record))) throw new Error("Synced conflict contains an invalid Study record.");
    }
    const peerPreview = state.variants.find(variant => variant.operation === "put")?.record;
    const preview = current ?? (peerPreview as StudyRecord | undefined);
    if (!preview) throw new Error("Could not determine the Study item type for a sync conflict.");
    if (!current) recordMap.set(state.recordId, localizedRecord(preview));
    nextConflicts.set(state.recordId, {
      id: state.recordId, recordId: state.recordId, kind: preview.kind,
      createdAt: conflictMap.get(state.recordId)?.createdAt ?? new Date().toISOString(),
      variants: state.variants.map(variant => ({
        mutationId: variant.mutationId, operation: variant.operation,
        ...(variant.operation === "put" ? { record: variant.record as StudyRecord } : {}),
      })),
    });
  }

  const db = await openStudyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["records", "peerState", "peerConflicts"], "readwrite");
      const records = tx.objectStore("records"); const peerState = tx.objectStore("peerState"); const conflicts = tx.objectStore("peerConflicts");
      let stale = false;
      const stateRequest = peerState.get("state");
      stateRequest.onsuccess = () => {
        const currentState = stateRequest.result as StoredPeerState | undefined;
        if (currentState?.stateRevision !== expected.stateRevision) { stale = true; tx.abort(); return; }
        const clearRequest = records.clear();
        clearRequest.onsuccess = () => {
          for (const record of recordMap.values()) records.put(record);
          conflicts.clear();
          for (const conflict of nextConflicts.values()) conflicts.put(conflict);
          peerState.put(nextState);
        };
        clearRequest.onerror = () => tx.abort();
      };
      stateRequest.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(stale ? new Error("Peer state changed while sync results were being applied.") : tx.error || new Error("Peer sync apply aborted."));
      tx.onerror = () => undefined;
    });
  } finally { db.close(); }
  return nextConflicts.size;
}


export type StudyTrustedDeviceInfo = {
  deviceId: string;
  admin: boolean;
  revoked: boolean;
  current: boolean;
  currentEpoch: number;
};

export type StudyPairingOfferSession = {
  offer: PairingOffer;
  payload: string;
};

export type StudyPairingJoinSession = {
  offer: PairingOffer;
  request: PairingJoinRequest;
  shortCode: string;
  wrapKey: CryptoKey;
};

export type StudyPairingAdminRequest = {
  request: PairingJoinRequest;
  shortCode: string;
};

export type StudyRecoveryMaterial = {
  kit: string;
  secret: string;
};

async function ensurePairingMaterial(state: StoredPeerState): Promise<StoredPeerState> {
  const replica = replicaFromStored(state);
  const currentSelf = replica.getTrustedDevices().find(device => device.deviceId === state.deviceId);
  if (!currentSelf) throw new Error("Current device is missing from trusted membership.");
  const pendingKeyGrants = state.pendingKeyGrants ?? [];
  if (state.pairingKeys && currentSelf.publicPairingKey && state.pendingKeyGrants) return state;
  const pairingKeys = state.pairingKeys ?? await generatePairingKeys();
  replica.trustDevice({ ...currentSelf, publicPairingKey: currentSelf.publicPairingKey ?? await exportPairingPublicKey(pairingKeys.publicKey) });
  const next: StoredPeerState = {
    ...state,
    stateRevision: state.stateRevision + 1,
    pairingKeys,
    pendingKeyGrants,
    snapshot: replica.exportSnapshot(),
  };
  await persistStateOnly(state, next);
  return next;
}

async function assertEmptyStudyStore(): Promise<void> {
  const db = await openStudyDatabase();
  try {
    const count = await requestResult(db.transaction("records").objectStore("records").count());
    if (count !== 0) throw new Error("This device already has local Notes or Projects. Export or move them before joining a different vault.");
  } finally { db.close(); }
}

async function assertEmptyPersonalJoinStore(): Promise<void> {
  await assertEmptyStudyStore();
  if (!memoryPeerSyncEnabled) return;
  const state = await api.memoryPeerLocalState();
  if (state.has_syncable_data) {
    throw new Error("This device already has local Memory or Open Loop data. Export or move it before joining a different vault.");
  }
}

export async function getStudyTrustedDevices(): Promise<StudyTrustedDeviceInfo[]> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    return state.snapshot.trustedDevices
      .map(device => ({
        deviceId: device.deviceId,
        admin: device.admin,
        revoked: device.revokedAfterSequence !== undefined,
        current: device.deviceId === state.deviceId,
        currentEpoch: state.snapshot.currentEpoch,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || Number(b.admin) - Number(a.admin) || a.deviceId.localeCompare(b.deviceId));
  });
}

export async function beginStudyDevicePairing(): Promise<StudyPairingOfferSession> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const self = state.snapshot.trustedDevices.find(device => device.deviceId === state.deviceId);
    if (!self?.admin) throw new Error("Only an admin device can add another device.");
    const offer = await createPairingOffer({
      vaultId: state.vaultId,
      adminDeviceId: state.deviceId,
      adminSigningPublicKey: await exportPublicSigningKey(state.signingKeys.publicKey),
      adminPairingPublicKey: await exportPairingPublicKey(state.pairingKeys!.publicKey),
    });
    return { offer, payload: encodePairingOffer(offer) };
  });
}

export async function requestStudyDevicePairing(payload: string, label: string, relaySource: StudyRelaySource): Promise<StudyPairingJoinSession> {
  return withPeerWriteLock(async () => {
    await assertEmptyPersonalJoinStore();
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const offer = decodePairingOffer(payload);
    if (offer.vaultId === state.vaultId && offer.adminDeviceId === state.deviceId) throw new Error("Use this pairing payload on the other device.");
    const request = await createPairingJoinRequest({
      offer,
      candidateDeviceId: state.deviceId,
      candidateSigningPublicKey: await exportPublicSigningKey(state.signingKeys.publicKey),
      candidatePairingPublicKey: await exportPairingPublicKey(state.pairingKeys!.publicKey),
      label,
      signingPrivateKey: state.signingKeys.privateKey,
    });
    const context = `${offer.pairingId}:${offer.vaultId}:${state.deviceId}`;
    const shortCode = await derivePairingShortCode(state.pairingKeys!.privateKey, offer.adminPairingPublicKey, offer.salt, context);
    const wrapKey = await derivePairingWrapKey(state.pairingKeys!.privateKey, offer.adminPairingPublicKey, offer.salt, context);
    await resolveStudyRelay(relaySource).pairing.putRequest(request);
    return { offer, request, shortCode, wrapKey };
  });
}

export async function inspectStudyPairingRequest(payload: string, relaySource: StudyRelaySource): Promise<StudyPairingAdminRequest | null> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const offer = decodePairingOffer(payload);
    if (offer.vaultId !== state.vaultId || offer.adminDeviceId !== state.deviceId) throw new Error("This pairing offer was not created by this device.");
    const self = state.snapshot.trustedDevices.find(device => device.deviceId === state.deviceId);
    if (!self?.admin) throw new Error("Only an admin device can approve another device.");
    const request = await resolveStudyRelay(relaySource).pairing.getRequest(offer.pairingId);
    if (!request) return null;
    await verifyPairingJoinRequest(request, offer);
    const context = `${offer.pairingId}:${offer.vaultId}:${request.candidateDeviceId}`;
    const shortCode = await derivePairingShortCode(state.pairingKeys!.privateKey, request.candidatePairingPublicKey, offer.salt, context);
    return { request, shortCode };
  });
}

export async function approveStudyDevicePairing(
  payload: string,
  request: PairingJoinRequest,
  enteredShortCode: string,
  relaySource: StudyRelaySource,
): Promise<void> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const offer = decodePairingOffer(payload);
    if (offer.vaultId !== state.vaultId || offer.adminDeviceId !== state.deviceId) throw new Error("This pairing offer was not created by this device.");
    await verifyPairingJoinRequest(request, offer);
    const context = `${offer.pairingId}:${offer.vaultId}:${request.candidateDeviceId}`;
    const expectedCode = await derivePairingShortCode(state.pairingKeys!.privateKey, request.candidatePairingPublicKey, offer.salt, context);
    if (enteredShortCode.trim() !== expectedCode) throw new Error("The verification code does not match. Nothing was approved.");
    const wrapKey = await derivePairingWrapKey(state.pairingKeys!.privateKey, request.candidatePairingPublicKey, offer.salt, context);
    const replica = replicaFromStored(state);
    const candidate: TrustedDevice = {
      deviceId: request.candidateDeviceId,
      publicSigningKey: structuredClone(request.candidateSigningPublicKey),
      publicPairingKey: structuredClone(request.candidatePairingPublicKey),
      admin: false,
    };
    await replica.createEnrollmentEnvelope(candidate);
    const currentKey = replica.getEpochKey();
    if (!currentKey) throw new Error("Current vault key is unavailable.");
    const bundle = {
      protocol: 1 as const,
      pairingId: offer.pairingId,
      vaultId: offer.vaultId,
      currentEpoch: replica.getCurrentEpoch(),
      epochKeys: await Promise.all(replica.getEpochKeys().map(async item => ({ epoch: item.epoch, key: await exportAesKey(item.key) }))),
      trustedDevices: replica.getTrustedDevices(),
      approvedDeviceId: request.candidateDeviceId,
      approvedAt: new Date().toISOString(),
    };
    const approval = await sealPairingApproval({ offer, request, wrapKey, bundle, adminSigningPrivateKey: state.signingKeys.privateKey });
    const next = storedFromReplica(state, replica, { phase: "saved-offline", lastError: "" });
    await persistStateOnly(state, next);
    await resolveStudyRelay(relaySource).pairing.putApproval(approval);
    announceSyncNeeded();
  });
}

export async function completeStudyDevicePairing(session: StudyPairingJoinSession, relaySource: StudyRelaySource): Promise<boolean> {
  return withPeerWriteLock(async () => {
    await assertEmptyPersonalJoinStore();
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    if (state.deviceId !== session.request.candidateDeviceId) throw new Error("This pairing session belongs to a different device.");
    const approval = await resolveStudyRelay(relaySource).pairing.getApproval(session.offer.pairingId);
    if (!approval) return false;
    const bundle = await openPairingApproval({ approval, offer: session.offer, candidateDeviceId: state.deviceId, wrapKey: session.wrapKey });
    const epochKeys = await Promise.all(bundle.epochKeys.map(async item => ({ epoch: item.epoch, key: await importAesKey(item.key) })));
    if (!epochKeys.some(item => item.epoch === bundle.currentEpoch)) throw new Error("The pairing bundle is missing its current epoch key.");
    const ownDescriptor: TrustedDevice = {
      deviceId: state.deviceId,
      publicSigningKey: await exportPublicSigningKey(state.signingKeys.publicKey),
      publicPairingKey: await exportPairingPublicKey(state.pairingKeys!.publicKey),
      admin: false,
    };
    const trusted = [...bundle.trustedDevices.filter(device => device.deviceId !== state.deviceId), ownDescriptor];
    const snapshot: PeerReplicaSnapshot<PersonalPeerRecord> = {
      currentEpoch: bundle.currentEpoch,
      deviceSequence: 0,
      trustedDevices: trusted,
      mutations: [],
      heads: {},
      outgoing: [],
    };
    const next: StoredPeerState = {
      ...state,
      stateRevision: state.stateRevision + 1,
      initializedAt: new Date().toISOString(),
      phase: "saved-offline",
      lastSyncedAt: "",
      lastError: "",
      vaultId: bundle.vaultId,
      pairingKeys: state.pairingKeys,
      epochKeys,
      pendingKeyGrants: [],
      manifestSequence: 0,
      snapshot,
    };
    await persistStateOnly(state, next);
    announceSyncNeeded();
    return true;
  });
}

async function flushPendingKeyGrants(state: StoredPeerState, relaySource: StudyRelaySource): Promise<StoredPeerState> {
  const pending = state.pendingKeyGrants ?? [];
  if (!pending.length) return state;
  const relay = resolveStudyRelay(relaySource).pairing;
  for (const grant of pending) await relay.putKeyGrant(grant);
  const next: StoredPeerState = { ...state, stateRevision: state.stateRevision + 1, pendingKeyGrants: [] };
  await persistStateOnly(state, next);
  return next;
}

async function installAvailableKeyGrants(state: StoredPeerState, relaySource: StudyRelaySource): Promise<StoredPeerState> {
  if (!state.pairingKeys) return state;
  const grants = await resolveStudyRelay(relaySource).pairing.listKeyGrants(state.vaultId, state.deviceId);
  if (!grants.length) return state;
  const replica = replicaFromStored(state);
  let changed = false;
  for (const grant of grants.sort((a, b) => a.epoch - b.epoch || a.grantId.localeCompare(b.grantId))) {
    if (grant.vaultId !== state.vaultId || replica.getEpochKey(grant.epoch)) continue;
    const admin = replica.getTrustedDevices().find(device => device.deviceId === grant.adminDeviceId);
    if (!admin) continue;
    const key = await openEpochKeyGrant({
      grant,
      ownDeviceId: state.deviceId,
      ownPairingPrivateKey: state.pairingKeys.privateKey,
      adminDevice: admin,
    });
    replica.installEpochKey(grant.epoch, key, grant.epoch > replica.getCurrentEpoch());
    changed = true;
  }
  if (!changed) return state;
  const next = storedFromReplica(state, replica, { phase: "saved-offline", lastError: "" });
  await persistStateOnly(state, next);
  return next;
}

export async function revokeStudyPeerDevice(targetDeviceId: string): Promise<void> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    if (targetDeviceId === state.deviceId) throw new Error("Use recovery or transfer administration before retiring this device.");
    const replica = replicaFromStored(state);
    const self = replica.getTrustedDevices().find(device => device.deviceId === state.deviceId);
    const target = replica.getTrustedDevices().find(device => device.deviceId === targetDeviceId);
    if (!self?.admin) throw new Error("Only an admin device can revoke another device.");
    if (!target || target.revokedAfterSequence !== undefined) throw new Error("That device is not an active trusted device.");
    const revokedAfterSequence = Math.max(0, ...state.snapshot.mutations
      .filter(mutation => mutation.deviceId === targetDeviceId)
      .map(mutation => mutation.deviceSequence));
    const newEpoch = replica.getCurrentEpoch() + 1;
    const newKey = await generateVaultKey();
    const revocationEnvelope = await replica.createRevocationEnvelope(targetDeviceId, revokedAfterSequence, newEpoch);
    replica.installEpochKey(newEpoch, newKey, true);
    const grants: EpochKeyGrant[] = [];
    for (const device of replica.getTrustedDevices()) {
      if (device.deviceId === state.deviceId || device.deviceId === targetDeviceId || device.revokedAfterSequence !== undefined) continue;
      if (!device.publicPairingKey) throw new Error(`Trusted device ${device.deviceId.slice(0, 8)} is missing a pairing key; revocation cannot safely rotate the vault key.`);
      grants.push(await createEpochKeyGrant({
        vaultId: state.vaultId,
        epoch: newEpoch,
        adminDeviceId: state.deviceId,
        adminDeviceSequence: revocationEnvelope.header.deviceSequence,
        targetDeviceId: device.deviceId,
        adminPairingPrivateKey: state.pairingKeys!.privateKey,
        targetPairingPublicKey: device.publicPairingKey,
        adminSigningPrivateKey: state.signingKeys.privateKey,
        vaultKey: newKey,
      }));
    }
    const next = {
      ...storedFromReplica(state, replica, { phase: "saved-offline", lastError: "" }),
      pendingKeyGrants: [...(state.pendingKeyGrants ?? []), ...grants],
    };
    await persistStateOnly(state, next);
    announceSyncNeeded();
  });
}

export async function createStudyRecoveryKit(): Promise<StudyRecoveryMaterial> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const replica = replicaFromStored(state);
    const self = replica.getTrustedDevices().find(device => device.deviceId === state.deviceId);
    if (!self?.admin) throw new Error("Only an admin device can create a recovery kit.");
    const secret = createRecoverySecret();
    const recoveryKey = await recoveryKeyFromSecret(secret);
    const checkpoint = await replica.createCheckpoint();
    const vaultKey = replica.getEpochKey();
    if (!vaultKey) throw new Error("Current vault key is unavailable.");
    const wrappedEpochKeys = await Promise.all(replica.getEpochKeys().map(async item => ({
      epoch: item.epoch,
      ...await wrapRecoveryVaultKey({ vaultKey: item.key, recoveryKey, vaultId: state.vaultId, epoch: item.epoch }),
    })));
    const signer = replica.getTrustedDevices().find(device => device.deviceId === state.deviceId)!;
    const kit: StudyRecoveryKit = {
      format: "personal-study-recovery-v1",
      vaultId: state.vaultId,
      currentEpoch: replica.getCurrentEpoch(),
      signer,
      wrappedEpochKeys,
      checkpoint: checkpoint as PeerEnvelope,
      createdAt: new Date().toISOString(),
    };
    const next = storedFromReplica(state, replica);
    await persistStateOnly(state, next);
    return { kit: JSON.stringify(kit, null, 2), secret };
  });
}

export async function recoverStudyPeerFromKit(kitText: string, secret: string): Promise<void> {
  return withPeerWriteLock(async () => {
    await assertEmptyPersonalJoinStore();
    const kit = JSON.parse(kitText) as StudyRecoveryKit;
    if (kit.format !== "personal-study-recovery-v1" || !kit.vaultId || !Number.isInteger(kit.currentEpoch)
        || kit.currentEpoch < 1 || !kit.signer?.deviceId || !kit.signer.admin || !kit.checkpoint
        || !Array.isArray(kit.wrappedEpochKeys) || !kit.wrappedEpochKeys.length) {
      throw new Error("This recovery kit is invalid.");
    }
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const recoveryKey = await recoveryKeyFromSecret(secret);
    const epochKeys = await Promise.all(kit.wrappedEpochKeys.map(async item => ({
      epoch: item.epoch,
      key: await unwrapRecoveryVaultKey({ vaultId: kit.vaultId, epoch: item.epoch, wrapIv: item.wrapIv, wrappedVaultKey: item.wrappedVaultKey, recoveryKey }),
    })));
    if (!epochKeys.some(item => item.epoch === kit.currentEpoch)) throw new Error("Recovery kit is missing its current epoch key.");
    const own: TrustedDevice = {
      deviceId: state.deviceId,
      publicSigningKey: await exportPublicSigningKey(state.signingKeys.publicKey),
      publicPairingKey: await exportPairingPublicKey(state.pairingKeys!.publicKey),
      admin: true,
    };
    const replica = PeerReplica.restore<PersonalPeerRecord>({
      vaultId: kit.vaultId,
      deviceId: state.deviceId,
      signingKeys: state.signingKeys,
      epochKeys,
      snapshot: {
        currentEpoch: kit.currentEpoch,
        deviceSequence: 0,
        trustedDevices: [structuredClone(kit.signer), own],
        mutations: [], heads: {}, outgoing: [],
      },
    });
    await replica.importCheckpoint(kit.checkpoint as PeerEnvelope);
    replica.trustDevice(own);
    const next: StoredPeerState = {
      ...state,
      stateRevision: state.stateRevision + 1,
      initializedAt: new Date().toISOString(),
      phase: "saved-offline",
      lastSyncedAt: "",
      lastError: "",
      vaultId: kit.vaultId,
      pairingKeys: state.pairingKeys,
      epochKeys: replica.getEpochKeys(),
      pendingKeyGrants: [],
      manifestSequence: 0,
      snapshot: replica.exportSnapshot(),
    };
    await materializeReplica(state, next, replica);
    announceSyncNeeded();
  });
}

export async function getStudyPeerStatus(): Promise<StudyPeerStatus> {
  const state = await ensureStudyPeerState();
  return {
    phase: state.phase,
    lastSyncedAt: state.lastSyncedAt,
    lastError: state.lastError,
    deviceId: state.deviceId,
    vaultId: state.vaultId,
  };
}

export async function markStudyPeerOffline(lastError = ""): Promise<StudyPeerStatus> {
  return withPeerWriteLock(async () => {
    const state = await ensureStudyPeerState();
    const next = { ...state, stateRevision: state.stateRevision + 1, phase: "saved-offline" as const, lastError };
    await persistStateOnly(state, next);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("personal-study-sync-state"));
    return getStudyPeerStatus();
  });
}

export async function listStudyPeerConflicts(): Promise<StudyPeerConflict[]> {
  const db = await openStudyDatabase();
  try {
    return (await requestResult(db.transaction("peerConflicts").objectStore("peerConflicts").getAll()) as StudyPeerConflict[])
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } finally { db.close(); }
}

export type MemoryPeerConflict = {
  recordId: string;
  entityKind: MemoryPeerRecord["entity_kind"];
  variants: Array<{ mutationId: string; operation: "put" | "delete"; record?: MemoryPeerRecord }>;
};

async function flushMemoryPeerOutbox(state: StoredPeerState, replica: PeerReplica<PersonalPeerRecord>): Promise<StoredPeerState> {
  if (!memoryPeerSyncEnabled) return state;
  await api.bindMemoryPeerVault(state.vaultId);
  const response = await api.memoryPeerOutbox(state.vaultId);
  if (!response.events.length) return state;
  const knownOrigins = new Set(replica.exportSnapshot().mutations.flatMap(mutation =>
    isMemoryPeerRecord(mutation.record) && mutation.record.origin_event_id ? [mutation.record.origin_event_id] : []));
  const acknowledgements: string[] = [];
  let created = false;
  for (const event of [...response.events].sort((a, b) => a.sequence - b.sequence)) {
    if (!event.record_id.startsWith("memory-peer:")) throw new Error("Memory peer outbox returned an invalid record ID.");
    if (knownOrigins.has(event.event_id)) { acknowledgements.push(event.event_id); continue; }
    if (event.operation === "put" && (!event.record || !isMemoryPeerRecord(event.record))) throw new Error("Memory peer outbox returned an invalid put.");
    const record = event.operation === "put" ? { ...event.record!, origin_event_id: event.event_id } : undefined;
    await replica.createMutation(event.record_id, event.operation, record);
    knownOrigins.add(event.event_id);
    acknowledgements.push(event.event_id);
    created = true;
  }
  let durable = state;
  if (created) {
    durable = storedFromReplica(state, replica, { phase: "syncing", lastError: "" });
    await persistStateOnly(state, durable);
  }
  if (acknowledgements.length) await api.acknowledgeMemoryPeerOutbox(state.vaultId, acknowledgements);
  return durable;
}

function memoryPeerApplyItems(replica: PeerReplica<PersonalPeerRecord>): MemoryPeerApplyItem[] {
  const items: MemoryPeerApplyItem[] = [];
  for (const state of replica.listRecordStates()) {
    if (!state.recordId.startsWith("memory-peer:")) continue;
    if (state.status === "value") {
      if (!state.value || !isMemoryPeerRecord(state.value)) throw new Error("Peer memory record is invalid.");
      items.push({ record_id: state.recordId, operation: "put", record: state.value });
    } else if (state.status === "deleted" || (state.status === "conflict" && state.variants.every(variant => variant.operation === "delete"))) {
      items.push({ record_id: state.recordId, operation: "delete" });
    }
  }
  return items;
}

async function applyMemoryPeerReplica(replica: PeerReplica<PersonalPeerRecord>): Promise<void> {
  if (!memoryPeerSyncEnabled) return;
  const items = memoryPeerApplyItems(replica);
  await api.bindMemoryPeerVault(replica.vaultId);
  if (items.length) await api.applyMemoryPeerRecords(replica.vaultId, items);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("personal-memory-peer-applied"));
}

export async function listMemoryPeerConflicts(): Promise<MemoryPeerConflict[]> {
  if (!memoryPeerSyncEnabled) return [];
  const state = await ensureStudyPeerState();
  const replica = replicaFromStored(state);
  const out: MemoryPeerConflict[] = [];
  for (const recordState of replica.listRecordStates()) {
    if (!recordState.recordId.startsWith("memory-peer:") || recordState.status !== "conflict") continue;
    const putRecords = recordState.variants.filter(v => v.operation === "put").map(v => v.record).filter(isMemoryPeerRecord);
    if (!putRecords.length) continue;
    out.push({
      recordId: recordState.recordId, entityKind: putRecords[0].entity_kind,
      variants: recordState.variants.map(v => ({ mutationId: v.mutationId, operation: v.operation, ...(v.operation === "put" && isMemoryPeerRecord(v.record) ? { record: v.record } : {}) })),
    });
  }
  return out.sort((a, b) => a.recordId.localeCompare(b.recordId));
}

export async function resolveMemoryPeerConflict(recordId: string, mutationId: string): Promise<void> {
  if (!memoryPeerSyncEnabled) throw new Error("Memory peer sync is not enabled on this installation.");
  return withPeerWriteLock(async () => {
    const state = await ensureStudyPeerState();
    const replica = replicaFromStored(state);
    const conflict = replica.getRecordState(recordId);
    if (conflict.status !== "conflict") throw new Error("This Memory sync conflict is no longer active.");
    const selected = conflict.variants.find(variant => variant.mutationId === mutationId);
    if (!selected) throw new Error("That Memory conflict version is no longer available.");
    await replica.resolveConflict(recordId, selected.operation === "put" ? selected.record : undefined);
    const next = storedFromReplica(state, replica, { phase: "saved-offline", lastError: "" });
    await persistStateOnly(state, next);
    await applyMemoryPeerReplica(replica);
    announceSyncNeeded();
  });
}

function studyAttachmentRefs(replica: PeerReplica<PersonalPeerRecord>): StudyAttachmentRef[] {
  const refs = new Map<string, StudyAttachmentRef>();
  const add = (record: PersonalPeerRecord | undefined) => {
    if (!record || isMemoryPeerRecord(record) || !validStudyRecord(record)) return;
    for (const ref of record.attachments ?? []) {
      const existing = refs.get(ref.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(ref)) {
        throw new Error("Concurrent Study versions disagree about attachment metadata for the same attachment ID.");
      }
      refs.set(ref.id, ref);
    }
  };
  for (const state of replica.listRecordStates()) {
    if (state.status === "value") add(state.value);
    else if (state.status === "conflict") for (const variant of state.variants) if (variant.operation === "put") add(variant.record);
  }
  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function readLocalAttachment(id: string): Promise<StoredStudyAttachment | undefined> {
  const db = await openStudyDatabase();
  try { return await requestResult(db.transaction("attachments").objectStore("attachments").get(id)) as StoredStudyAttachment | undefined; }
  finally { db.close(); }
}

async function storeDownloadedAttachment(ref: StudyAttachmentRef, bytes: Uint8Array, encrypted: Awaited<ReturnType<typeof downloadEncryptedAttachment>>): Promise<void> {
  if (bytes.byteLength !== ref.size) throw new Error(`Attachment ${ref.name} did not match its recorded size.`);
  const stored: StoredStudyAttachment = {
    ...ref,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    encrypted,
  };
  const db = await openStudyDatabase();
  try {
    const tx = db.transaction("attachments", "readwrite"); const store = tx.objectStore("attachments");
    const current = await requestResult(store.get(ref.id)) as StoredStudyAttachment | undefined;
    if (current) {
      if (current.name !== ref.name || current.mediaType !== ref.mediaType || current.size !== ref.size || current.keyEpoch !== ref.keyEpoch) {
        tx.abort(); throw new Error("Local attachment metadata conflicts with the synchronized reference.");
      }
      return;
    }
    store.put(stored); await transactionDone(tx);
  } finally { db.close(); }
}

async function syncStudyAttachments(
  state: StoredPeerState,
  replica: PeerReplica<PersonalPeerRecord>,
  relaySource: StudyRelaySource,
): Promise<void> {
  const refs = studyAttachmentRefs(replica);
  if (!refs.length) return;
  for (const ref of refs) {
    const local = await readLocalAttachment(ref.id);
    if (local) {
      if (local.name !== ref.name || local.mediaType !== ref.mediaType || local.size !== ref.size || local.keyEpoch !== ref.keyEpoch) {
        throw new Error("Local attachment metadata conflicts with the synchronized Study record.");
      }
      await uploadEncryptedAttachment(relaySource, state.vaultId, local.encrypted);
      continue;
    }
    const encrypted = await downloadEncryptedAttachment(relaySource, state.vaultId, ref.id);
    const bytes = await decryptAttachment(encrypted, epochKey(state, ref.keyEpoch));
    await storeDownloadedAttachment(ref, bytes, encrypted);
  }
}

export async function runStudyPeerSync(relaySource: StudyRelaySource): Promise<StudyPeerStatus> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const syncing: StoredPeerState = {
      ...state,
      stateRevision: state.stateRevision + 1,
      phase: "syncing",
      lastError: "",
    };
    await persistStateOnly(state, syncing);
    state = syncing;
    try {
      state = await flushPendingKeyGrants(state, relaySource);
      state = await installAvailableKeyGrants(state, relaySource);
      const replica = replicaFromStored(state);
      state = await flushMemoryPeerOutbox(state, replica);
      const relay = resolveStudyRelay(relaySource);
      const syncResult = await syncPeerReplica(replica, relay.peer, { allowRevokedMissingEpoch: true });
      await syncStudyAttachments(state, replica, relaySource);
      const selfAfterSync = replica.getTrustedDevices().find(device => device.deviceId === state.deviceId);
      const conflictCount = replica.listRecordStates().filter(item => item.status === "conflict"
        && !item.variants.every(variant => variant.operation === "delete")).length;
      let nextManifestSequence = state.manifestSequence ?? 0;
      let deviceManifest = null;
      if (relay.manifests && selfAfterSync?.revokedAfterSequence === undefined) {
        nextManifestSequence += 1;
        deviceManifest = await replica.createDeviceManifest(nextManifestSequence, syncResult.acknowledgedCheckpoint);
      }
      const nextState = {
        ...storedFromReplica(state, replica, {
          phase: selfAfterSync?.revokedAfterSequence !== undefined ? "revoked" : conflictCount ? "needs-review" : "up-to-date",
          lastSyncedAt: new Date().toISOString(),
          lastError: selfAfterSync?.revokedAfterSequence !== undefined ? "This device was revoked and cannot receive future encryption keys." : "",
        }),
        ...(deviceManifest ? { manifestSequence: nextManifestSequence } : {}),
      };
      await materializeReplica(state, nextState, replica);
      await applyMemoryPeerReplica(replica);
      if (deviceManifest) await relay.manifests!.putManifest(deviceManifest);
      announcePeerChanged();
      return {
        phase: nextState.phase, lastSyncedAt: nextState.lastSyncedAt, lastError: "",
        deviceId: nextState.deviceId, vaultId: nextState.vaultId,
      };
    } catch (error) {
      const current = await readStoredPeerState() ?? state;
      const failed: StoredPeerState = {
        ...current,
        stateRevision: current.stateRevision + 1,
        phase: "saved-offline",
        lastError: error instanceof Error ? error.message : "Study peer sync failed.",
      };
      await persistStateOnly(current, failed);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("personal-study-sync-state"));
      throw error;
    }
  });
}

export async function runStudyPeerSyncOverHttp(url: string): Promise<StudyPeerStatus> {
  return runStudyPeerSync(url);
}

export type StudyCompactionCheckpointResult = {
  checkpointObjectId: string;
  pendingEnvelopeCount: number;
  vaultId: string;
};

export async function publishStudyCompactionCheckpoint(relaySource: StudyRelaySource): Promise<StudyCompactionCheckpointResult> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const self = state.snapshot.trustedDevices.find(device => device.deviceId === state.deviceId);
    if (!self?.admin || self.revokedAfterSequence !== undefined) throw new Error("Only an active admin device can publish a compaction checkpoint.");
    state = await flushPendingKeyGrants(state, relaySource);
    const relay = resolveStudyRelay(relaySource);
    if (!relay.manifests) throw new Error("This relay does not support signed device manifests.");
    const replica = replicaFromStored(state);
    const checkpoint = await replica.createCheckpoint();
    const pending = replica.pendingEnvelopes();
    const nextManifestSequence = (state.manifestSequence ?? 0) + 1;
    const manifest = await replica.createDeviceManifest(nextManifestSequence, checkpoint);
    const sequenced: StoredPeerState = {
      ...storedFromReplica(state, replica, { phase: "syncing", lastError: "" }),
      manifestSequence: nextManifestSequence,
    };
    await persistStateOnly(state, sequenced);
    state = sequenced;
    try {
      await relay.peer.put(checkpoint);
      for (const envelope of pending) await relay.peer.put(envelope);
      await relay.manifests.putManifest(manifest);
      replica.markRelayStored(pending.map(envelope => envelope.header.objectId));
      const done = storedFromReplica(state, replica, { phase: "up-to-date", lastSyncedAt: new Date().toISOString(), lastError: "" });
      await persistStateOnly(state, done);
      announcePeerChanged();
      return { checkpointObjectId: checkpoint.header.objectId, pendingEnvelopeCount: pending.length, vaultId: state.vaultId };
    } catch (error) {
      const failed: StoredPeerState = {
        ...state, stateRevision: state.stateRevision + 1, phase: "saved-offline",
        lastError: error instanceof Error ? error.message : "Compaction checkpoint publication failed.",
      };
      await persistStateOnly(state, failed);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("personal-study-sync-state"));
      throw error;
    }
  });
}

export async function getStudyRelayCompactionPlan(relaySource: StudyRelaySource): Promise<StudyRelayCompactionPlan> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const replica = replicaFromStored(state);
    const self = replica.getTrustedDevices().find(device => device.deviceId === state.deviceId);
    if (!self?.admin || self.revokedAfterSequence !== undefined) throw new Error("Only an active admin device can review relay compaction readiness.");
    return planStudyRelayCompaction(relaySource, replica);
  });
}

export type StudyRelaySeedResult = {
  checkpointObjectId: string;
  pendingEnvelopeCount: number;
  vaultId: string;
};

export async function seedStudyReplacementRelay(relaySource: StudyRelaySource): Promise<StudyRelaySeedResult> {
  return withPeerWriteLock(async () => {
    let state = await ensureStudyPeerState();
    state = await ensurePairingMaterial(state);
    const self = state.snapshot.trustedDevices.find(device => device.deviceId === state.deviceId);
    if (!self?.admin || self.revokedAfterSequence !== undefined) {
      throw new Error("Only an active admin device can seed a replacement relay.");
    }
    state = await flushPendingKeyGrants(state, relaySource);
    const replica = replicaFromStored(state);
    const checkpoint = await replica.createCheckpoint();
    const sequenced = storedFromReplica(state, replica, { phase: "syncing", lastError: "" });
    await persistStateOnly(state, sequenced);
    state = sequenced;
    const pending = replica.pendingEnvelopes();
    try {
      const relay = resolveStudyRelay(relaySource).peer;
      await relay.put(checkpoint);
      for (const envelope of pending) await relay.put(envelope);
      replica.markRelayStored(pending.map(envelope => envelope.header.objectId));
      const conflictCount = replica.listRecordStates().filter(item => item.status === "conflict"
        && !item.variants.every(variant => variant.operation === "delete")).length;
      const done = storedFromReplica(state, replica, {
        phase: conflictCount ? "needs-review" : "up-to-date",
        lastSyncedAt: new Date().toISOString(),
        lastError: "",
      });
      await persistStateOnly(state, done);
      announcePeerChanged();
      return { checkpointObjectId: checkpoint.header.objectId, pendingEnvelopeCount: pending.length, vaultId: state.vaultId };
    } catch (error) {
      const failed: StoredPeerState = {
        ...state,
        stateRevision: state.stateRevision + 1,
        phase: "saved-offline",
        lastError: error instanceof Error ? error.message : "Replacement relay seed failed.",
      };
      await persistStateOnly(state, failed);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("personal-study-sync-state"));
      throw error;
    }
  });
}

export async function resolveStudyPeerConflict(recordId: string, mutationId: string): Promise<void> {
  return withPeerWriteLock(async () => {
    const state = await ensureStudyPeerState();
    const conflicts = await listStudyPeerConflicts();
    const conflict = conflicts.find(item => item.recordId === recordId);
    if (!conflict) throw new Error("This sync conflict is no longer active.");
    const selected = conflict.variants.find(variant => variant.mutationId === mutationId);
    if (!selected) throw new Error("That conflict version is no longer available.");
    const replica = replicaFromStored(state);
    await replica.resolveConflict(recordId, selected.operation === "put" ? selected.record : undefined);
    const nextState = storedFromReplica(state, replica, { phase: "saved-offline", lastError: "" });
    await materializeReplica(state, nextState, replica);
    announceSyncNeeded();
  });
}