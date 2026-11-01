import assert from "node:assert/strict";
import {
  decryptAttachment,
  encryptAttachment,
  generateVaultKey,
  PeerReplica,
  SyntheticEncryptedRelay,
  syncPeerReplica,
  type AttachmentChunk,
} from "../src/lib/study-peer-sync";
import {
  downloadEncryptedAttachment,
  type EncryptedAttachmentManifest,
  type StudyAttachmentRelay,
  type StudyRelay,
  uploadEncryptedAttachment,
} from "../src/lib/study-relay";

type RecordValue = { title: string; reminders?: Array<{ id: string; status: string }> };

class MemoryAttachmentRelay implements StudyAttachmentRelay {
  manifest: EncryptedAttachmentManifest | null = null;
  chunks = new Map<number, AttachmentChunk>();

  async putManifest(_vaultId: string, manifest: EncryptedAttachmentManifest) {
    if (this.manifest && JSON.stringify(this.manifest) !== JSON.stringify(manifest)) throw new Error("manifest collision");
    this.manifest = structuredClone(manifest);
  }
  async getManifest(_vaultId: string, attachmentId: string) {
    return this.manifest?.attachmentId === attachmentId ? structuredClone(this.manifest) : null;
  }

  async putChunk(_vaultId: string, chunk: AttachmentChunk) {
    const current = this.chunks.get(chunk.index);
    if (current && JSON.stringify(current) !== JSON.stringify(chunk)) throw new Error("chunk collision");
    this.chunks.set(chunk.index, structuredClone(chunk));
  }

  async listChunks(_vaultId: string, attachmentId: string) {
    return [...this.chunks.values()].filter(chunk => chunk.attachmentId === attachmentId).map(chunk => structuredClone(chunk));
  }

  opaqueDump() { return JSON.stringify({ manifest: this.manifest, chunks: [...this.chunks.values()] }); }
}

async function checkpointBootstrap() {
  const vaultId = "replacement-vault";
  const vaultKey = await generateVaultKey();
  const a = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "admin-a", vaultKey, admin: true });
  await a.createMutation("before", "put", { title: "before checkpoint" });
  const oldRelay = new SyntheticEncryptedRelay();
  await syncPeerReplica(a, oldRelay);
  const replacement = new SyntheticEncryptedRelay();
  await replacement.put(await a.createCheckpoint());
  await a.createMutation("after", "put", { title: "after checkpoint" });
  await syncPeerReplica(a, replacement);

  const fresh = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "fresh", vaultKey, admin: false });
  fresh.trustDevice(await a.descriptor(true));
  await syncPeerReplica(fresh, replacement);
  assert.equal(fresh.getRecordState("before").value?.title, "before checkpoint");
  assert.equal(fresh.getRecordState("after").value?.title, "after checkpoint");

  const local = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "local", vaultKey, admin: false });
  local.trustDevice(await a.descriptor(true));
  await local.createMutation("local-only", "put", { title: "must survive" });
  await syncPeerReplica(local, replacement);
  assert.equal(local.getRecordState("local-only").value?.title, "must survive");
}

async function concurrentCheckpointFailsClosed() {
  const vaultId = "concurrent-checkpoints";
  const vaultKey = await generateVaultKey();
  const a = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "admin-a", vaultKey, admin: true });
  const b = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "admin-b", vaultKey, admin: true });
  a.trustDevice(await b.descriptor(true));
  b.trustDevice(await a.descriptor(true));
  await a.createMutation("a", "put", { title: "A" });
  await b.createMutation("b", "put", { title: "B" });
  const relay = new SyntheticEncryptedRelay();
  await relay.put(await a.createCheckpoint());
  await relay.put(await b.createCheckpoint());
  const fresh = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "fresh", vaultKey, admin: false });
  fresh.trustDevice(await a.descriptor(true));
  fresh.trustDevice(await b.descriptor(true));
  await assert.rejects(() => syncPeerReplica(fresh, relay), /concurrent checkpoints/i);
}

async function attachmentResume() {
  const vaultId = "attachment-vault";
  const vaultKey = await generateVaultKey();
  const plaintext = new TextEncoder().encode("SYNTHETIC_ATTACHMENT_PLAINTEXT_8H::" + "chunk-data-".repeat(50));
  const encrypted = await encryptAttachment(plaintext, vaultKey, "attachment-8h", 47);
  assert.ok(encrypted.chunks.length > 2);

  const attachmentRelay = new MemoryAttachmentRelay();
  const relay: StudyRelay = {
    kind: "jihu",
    peer: new SyntheticEncryptedRelay(),
    pairing: {} as StudyRelay["pairing"],
    attachments: attachmentRelay,
  };
  await uploadEncryptedAttachment(relay, vaultId, encrypted, [0]);
  await assert.rejects(() => downloadEncryptedAttachment(relay, vaultId, encrypted.attachmentId), /incomplete/i);
  await uploadEncryptedAttachment(relay, vaultId, encrypted, encrypted.chunks.slice(1).map(chunk => chunk.index));
  const downloaded = await downloadEncryptedAttachment(relay, vaultId, encrypted.attachmentId);
  const restored = await decryptAttachment(downloaded, vaultKey);
  assert.deepEqual(restored, plaintext);
  assert.equal(attachmentRelay.opaqueDump().includes("SYNTHETIC_ATTACHMENT_PLAINTEXT_8H"), false);

  const damaged = structuredClone(downloaded);
  damaged.chunks[0].ciphertext = `${damaged.chunks[0].ciphertext.slice(0, -2)}AA`;
  attachmentRelay.chunks.set(damaged.chunks[0].index, damaged.chunks[0]);
  const tampered = await downloadEncryptedAttachment(relay, vaultId, encrypted.attachmentId);
  await assert.rejects(() => decryptAttachment(tampered, vaultKey), /hash mismatch|decrypt/i);
}

async function main() {
  await checkpointBootstrap();
  await concurrentCheckpointFailsClosed();
  await attachmentResume();
  console.log(JSON.stringify({
    checks: 6,
    replacementCheckpointCatchup: true,
    nonemptyReplicaPreserved: true,
    concurrentCheckpointRejected: true,
    attachmentPartialRejected: true,
    attachmentResumeExact: true,
    attachmentRelayPlaintextLeak: false,
  }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
