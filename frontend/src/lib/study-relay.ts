import { AttachmentChunk, EncryptedAttachment, HttpPeerRelay, PeerDeviceManifest, PeerEnvelope, PeerRelay, PeerReplica, VersionVector, vectorDominates } from "@/lib/study-peer-sync";
import {
  EpochKeyGrant,
  PairingApproval,
  PairingJoinRequest,
  StudyPairingHttpRelay,
} from "@/lib/study-peer-pairing";


export interface StudyDeviceManifestRelay {
  putManifest(manifest: PeerDeviceManifest): Promise<void>;
  listManifests(vaultId: string): Promise<PeerDeviceManifest[]>;
}

export interface StudyPairingRelay {
  putRequest(request: PairingJoinRequest): Promise<void>;
  getRequest(pairingId: string): Promise<PairingJoinRequest | null>;
  putApproval(approval: PairingApproval): Promise<void>;
  getApproval(pairingId: string): Promise<PairingApproval | null>;
  putKeyGrant(grant: EpochKeyGrant): Promise<void>;
  listKeyGrants(vaultId: string, deviceId: string): Promise<EpochKeyGrant[]>;
}

export type AttachmentChunkDescriptor = Omit<AttachmentChunk, "ciphertext"> & { ciphertextBytes: number };
export type EncryptedAttachmentManifest = Omit<EncryptedAttachment, "chunks"> & { chunks: AttachmentChunkDescriptor[] };

export interface StudyAttachmentRelay {
  putManifest(vaultId: string, manifest: EncryptedAttachmentManifest): Promise<void>;
  getManifest(vaultId: string, attachmentId: string): Promise<EncryptedAttachmentManifest | null>;
  putChunk(vaultId: string, chunk: AttachmentChunk): Promise<void>;
  listChunks(vaultId: string, attachmentId: string): Promise<AttachmentChunk[]>;
}

export type StudyRelay = {
  kind: "http" | "jihu";
  peer: PeerRelay;
  pairing: StudyPairingRelay;
  attachments?: StudyAttachmentRelay;
  manifests?: StudyDeviceManifestRelay;
};
export type StudyRelaySource = string | StudyRelay;

export function resolveStudyRelay(source: StudyRelaySource): StudyRelay {
  if (typeof source !== "string") return source;
  return {
    kind: "http",
    peer: new HttpPeerRelay(source),
    pairing: new StudyPairingHttpRelay(source),
  };
}

export function attachmentManifestFromEncrypted(encrypted: EncryptedAttachment): EncryptedAttachmentManifest {
  return {
    attachmentId: encrypted.attachmentId,
    keyWrapIv: encrypted.keyWrapIv,
    wrappedKey: encrypted.wrappedKey,
    chunks: encrypted.chunks.map(chunk => ({
      attachmentId: chunk.attachmentId,
      index: chunk.index,
      total: chunk.total,
      iv: chunk.iv,
      sha256: chunk.sha256,
      ciphertextBytes: atob(chunk.ciphertext).length,
    })),
  };
}

export function encryptedAttachmentFromRelay(
  manifest: EncryptedAttachmentManifest,
  chunks: AttachmentChunk[],
): EncryptedAttachment {
  const descriptors = new Map(manifest.chunks.map(item => [item.index, item]));
  if (descriptors.size !== manifest.chunks.length) throw new Error("Attachment manifest repeats a chunk index.");
  if (chunks.length !== manifest.chunks.length) throw new Error("Attachment is incomplete at the relay.");
  const seen = new Set<number>();
  for (const chunk of chunks) {
    const descriptor = descriptors.get(chunk.index);
    if (!descriptor || seen.has(chunk.index)) throw new Error("Attachment relay returned an unexpected chunk.");
    seen.add(chunk.index);
    if (chunk.attachmentId !== manifest.attachmentId || chunk.total !== descriptor.total
        || chunk.iv !== descriptor.iv || chunk.sha256 !== descriptor.sha256
        || atob(chunk.ciphertext).length !== descriptor.ciphertextBytes) {
      throw new Error("Attachment relay chunk does not match its manifest.");
    }
  }
  return { ...manifest, chunks: [...chunks].sort((a, b) => a.index - b.index) };
}
export async function uploadEncryptedAttachment(
  relaySource: StudyRelaySource,
  vaultId: string,
  encrypted: EncryptedAttachment,
  chunkIndexes: number[] = encrypted.chunks.map(chunk => chunk.index),
): Promise<number> {
  const relay = resolveStudyRelay(relaySource).attachments;
  if (!relay) throw new Error("This Study relay does not support attachment chunks.");
  const manifest = attachmentManifestFromEncrypted(encrypted);
  await relay.putManifest(vaultId, manifest);
  const wanted = new Set(chunkIndexes);
  let uploaded = 0;
  for (const chunk of encrypted.chunks) {
    if (!wanted.has(chunk.index)) continue;
    await relay.putChunk(vaultId, chunk);
    uploaded += 1;
  }
  return uploaded;
}

export async function downloadEncryptedAttachment(
  relaySource: StudyRelaySource,
  vaultId: string,
  attachmentId: string,
): Promise<EncryptedAttachment> {
  const relay = resolveStudyRelay(relaySource).attachments;
  if (!relay) throw new Error("This Study relay does not support attachment chunks.");
  const manifest = await relay.getManifest(vaultId, attachmentId);
  if (!manifest) throw new Error("Attachment manifest was not found at the relay.");
  const chunks = await relay.listChunks(vaultId, attachmentId);
  return encryptedAttachmentFromRelay(manifest, chunks);
}


export type StudyRelayCompactionPlan = {
  eligible: boolean;
  reason: string;
  vaultId: string;
  requiredDeviceIds: string[];
  acknowledgedDeviceIds: string[];
  checkpointObjectId?: string;
  checkpointAcknowledgementVector?: VersionVector;
  removableMutationObjectIds: string[];
};

function vectorsEqual(a: VersionVector, b: VersionVector): boolean {
  return vectorDominates(a, b) && vectorDominates(b, a);
}

function mutationCoveredByVector(envelope: PeerEnvelope, vector: VersionVector): boolean {
  return envelope.header.kind === "mutation"
    && envelope.header.deviceSequence <= (vector[envelope.header.deviceId] ?? 0);
}

export async function planStudyRelayCompaction<T>(
  relaySource: StudyRelaySource,
  replica: PeerReplica<T>,
): Promise<StudyRelayCompactionPlan> {
  const relay = resolveStudyRelay(relaySource);
  const requiredDeviceIds = replica.getTrustedDevices()
    .filter(device => device.revokedAfterSequence === undefined)
    .map(device => device.deviceId)
    .sort();
  const base = { vaultId: replica.vaultId, requiredDeviceIds, acknowledgedDeviceIds: [] as string[], removableMutationObjectIds: [] as string[] };
  if (!relay.manifests) return { ...base, eligible: false, reason: "This relay does not support signed device manifests." };

  const [envelopes, manifestRows] = await Promise.all([relay.peer.list(replica.vaultId), relay.manifests.listManifests(replica.vaultId)]);
  const latest = new Map<string, PeerDeviceManifest>();
  for (const deviceId of requiredDeviceIds) {
    const valid: PeerDeviceManifest[] = [];
    for (const manifest of manifestRows.filter(item => item.deviceId === deviceId && item.vaultId === replica.vaultId)) {
      try { await replica.verifyDeviceManifest(manifest); valid.push(manifest); } catch { /* Invalid statements cannot authorize compaction. */ }
    }
    if (!valid.length) continue;
    const maxSequence = Math.max(...valid.map(item => item.manifestSequence));
    const maximal = valid.filter(item => item.manifestSequence === maxSequence);
    const uniqueMaximal = [...new Map(maximal.map(item => [item.signature, item])).values()];
    if (uniqueMaximal.length !== 1) {
      return { ...base, eligible: false, reason: `Device ${deviceId.slice(0, 8)} has ambiguous latest manifests.` };
    }
    latest.set(deviceId, uniqueMaximal[0]);
  }
  const missing = requiredDeviceIds.filter(deviceId => !latest.has(deviceId));
  if (missing.length) {
    return { ...base, eligible: false, reason: `Waiting for active device acknowledgement: ${missing.map(id => id.slice(0, 8)).join(", ")}.` };
  }

  const checkpoints = new Map<string, { envelope: PeerEnvelope; vector: VersionVector }>();
  for (const envelope of envelopes.filter(item => item.header.kind === "checkpoint")) {
    try {
      const payload = await replica.inspectCheckpoint(envelope);
      checkpoints.set(envelope.header.objectId, { envelope, vector: payload.acknowledgementVector ?? {} });
    } catch { /* Invalid checkpoints are never compaction anchors. */ }
  }
  const acknowledgementVectors = new Map<string, VersionVector>();
  for (const deviceId of requiredDeviceIds) {
    const manifest = latest.get(deviceId)!;
    const acknowledgement = manifest.acknowledgedCheckpoint;
    if (!acknowledgement) continue;
    const checkpoint = checkpoints.get(acknowledgement.objectId);
    if (!checkpoint || acknowledgement.keyEpoch !== checkpoint.envelope.header.keyEpoch
        || !vectorsEqual(acknowledgement.acknowledgementVector, checkpoint.vector)
        || !vectorDominates(manifest.acknowledgementVector, checkpoint.vector)) continue;
    acknowledgementVectors.set(deviceId, checkpoint.vector);
  }
  const acknowledgedDeviceIds = requiredDeviceIds.filter(deviceId => acknowledgementVectors.has(deviceId));
  if (acknowledgedDeviceIds.length !== requiredDeviceIds.length) {
    return { ...base, acknowledgedDeviceIds, eligible: false, reason: "Every active device must acknowledge a valid signed checkpoint before compaction." };
  }

  const safe = [...checkpoints.values()].filter(checkpoint => requiredDeviceIds.every(deviceId =>
    vectorDominates(acknowledgementVectors.get(deviceId)!, checkpoint.vector)));
  if (!safe.length) return { ...base, acknowledgedDeviceIds, eligible: false, reason: "No checkpoint is acknowledged by every active device." };
  const maximal = safe.filter(candidate => !safe.some(other => other !== candidate
    && vectorDominates(other.vector, candidate.vector) && !vectorDominates(candidate.vector, other.vector)));
  if (maximal.length > 1) {
    const first = maximal[0];
    if (!maximal.every(candidate => vectorsEqual(candidate.vector, first.vector))) {
      return { ...base, acknowledgedDeviceIds, eligible: false, reason: "Acknowledged checkpoints are concurrent; compaction is blocked." };
    }
  }
  const selected = [...maximal].sort((a, b) => a.envelope.header.objectId.localeCompare(b.envelope.header.objectId)).at(-1)!;
  const removableMutationObjectIds = envelopes.filter(envelope => mutationCoveredByVector(envelope, selected.vector))
    .map(envelope => envelope.header.objectId).sort();
  return {
    ...base, acknowledgedDeviceIds, eligible: true, reason: "Every active device has acknowledged checkpoint-covered state.",
    checkpointObjectId: selected.envelope.header.objectId,
    checkpointAcknowledgementVector: selected.vector, removableMutationObjectIds,
  };
}
