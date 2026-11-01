import assert from "node:assert/strict";
import {
  decryptAttachment,
  encryptAttachment,
  generateVaultKey,
  PeerReplica,
  syncPeerReplica,
  SyntheticEncryptedRelay,
} from "../src/lib/study-peer-sync";
import type { PeerEnvelope } from "../src/lib/study-peer-sync";

type RecordValue = { title: string; body: string };

async function peers(names: string[]) {
  const vaultId = "synthetic-vault";
  const vaultKey = await generateVaultKey();
  const replicas = await Promise.all(names.map((deviceId, index) => PeerReplica.create<RecordValue>({
    vaultId, deviceId, vaultKey, admin: index === 0,
  })));
  const descriptors = await Promise.all(replicas.map((replica, index) => replica.descriptor(index === 0)));
  for (const replica of replicas) for (const descriptor of descriptors) replica.trustDevice(descriptor);
  return { replicas, vaultKey, vaultId };
}

function recordSummary(replica: PeerReplica<RecordValue>, recordId: string) {
  const state = replica.getRecordState(recordId);
  return {
    status: state.status,
    variants: state.variants.map(item => `${item.operation}:${item.record?.title ?? ""}`).sort(),
  };
}

async function expectRejects(action: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(action, pattern);
}

async function main() {
  const { replicas: [a, b, c], vaultKey } = await peers(["A", "B", "C"]);
  const relay = new SyntheticEncryptedRelay();

  await a.createMutation("shared", "put", { title: "Base", body: "seed" });
  await syncPeerReplica(a, relay);
  await syncPeerReplica(b, relay);
  await syncPeerReplica(c, relay);
  assert.equal(b.getRecordState("shared").value?.title, "Base");

  await a.createMutation("shared", "put", { title: "From A", body: "offline A" });
  await b.createMutation("shared", "put", { title: "From B", body: "offline B" });
  await syncPeerReplica(a, relay);
  await syncPeerReplica(b, relay, { reverseDownload: true, duplicateDownload: true });
  await syncPeerReplica(a, relay, { duplicateDownload: true });
  assert.deepEqual(recordSummary(a, "shared"), recordSummary(b, "shared"));
  assert.deepEqual(recordSummary(a, "shared"), {
    status: "conflict",
    variants: ["put:From A", "put:From B"],
  });

  await expectRejects(
    () => a.createMutation("shared", "put", { title: "Unsafe", body: "must not overwrite" }),
    /Resolve the concurrent versions/,
  );
  await a.resolveConflict("shared", { title: "Resolved", body: "explicit choice" });
  await syncPeerReplica(a, relay);
  await syncPeerReplica(b, relay, { reverseDownload: true });
  assert.equal(a.getRecordState("shared").status, "value");
  assert.equal(b.getRecordState("shared").value?.title, "Resolved");

  const retryEnvelope = await a.createMutation("retry", "put", { title: "Retry", body: "lost ack" });
  const relaySizeBefore = relay.size();
  await syncPeerReplica(a, relay, { loseAcknowledgementFor: new Set([retryEnvelope.header.objectId]) });
  assert.equal(a.pendingEnvelopes().some(item => item.header.objectId === retryEnvelope.header.objectId), true);
  const relaySizeAfterLostAck = relay.size();
  await syncPeerReplica(a, relay);
  assert.equal(relay.size(), relaySizeAfterLostAck);
  assert.equal(relaySizeAfterLostAck, relaySizeBefore + 1);
  assert.equal(a.pendingEnvelopes().some(item => item.header.objectId === retryEnvelope.header.objectId), false);

  await a.createMutation("delete-edit", "put", { title: "Common", body: "base" });
  await syncPeerReplica(a, relay);
  await syncPeerReplica(b, relay);
  await a.createMutation("delete-edit", "delete");
  await b.createMutation("delete-edit", "put", { title: "Edited", body: "kept" });
  await syncPeerReplica(b, relay);
  await syncPeerReplica(a, relay, { reverseDownload: true });
  await syncPeerReplica(b, relay, { duplicateDownload: true });
  assert.deepEqual(recordSummary(a, "delete-edit"), recordSummary(b, "delete-edit"));
  assert.deepEqual(recordSummary(a, "delete-edit"), {
    status: "conflict",
    variants: ["delete:", "put:Edited"],
  });

  await a.createMutation("three-way", "put", { title: "Three Base", body: "base" });
  await syncPeerReplica(a, relay);
  await syncPeerReplica(b, relay);
  await syncPeerReplica(c, relay);
  await a.createMutation("three-way", "put", { title: "A3", body: "a" });
  await b.createMutation("three-way", "put", { title: "B3", body: "b" });
  await c.createMutation("three-way", "put", { title: "C3", body: "c" });
  await syncPeerReplica(c, relay);
  await syncPeerReplica(a, relay, { reverseDownload: true });
  await syncPeerReplica(b, relay, { duplicateDownload: true });
  await syncPeerReplica(c, relay, { reverseDownload: true, duplicateDownload: true });
  await syncPeerReplica(a, relay, { duplicateDownload: true });
  await syncPeerReplica(b, relay, { reverseDownload: true });
  await syncPeerReplica(c, relay);
  const three = recordSummary(a, "three-way");
  assert.deepEqual(three, recordSummary(b, "three-way"));
  assert.deepEqual(three, recordSummary(c, "three-way"));
  assert.deepEqual(three.variants, ["put:A3", "put:B3", "put:C3"]);

  relay.online = false;
  const queued = await a.createMutation("outage", "put", { title: "Queued Offline", body: "relay down" });
  await expectRejects(() => syncPeerReplica(a, relay), /offline/);
  assert.equal(a.pendingEnvelopes().some(item => item.header.objectId === queued.header.objectId), true);
  relay.online = true;
  await syncPeerReplica(a, relay);
  await syncPeerReplica(b, relay);
  assert.equal(b.getRecordState("outage").value?.title, "Queued Offline");

  const revokedAt = c.getSequence();
  const revocation = await a.createRevocationEnvelope(c.deviceId, revokedAt, 2);
  await syncPeerReplica(a, relay);
  await syncPeerReplica(b, relay);
  await syncPeerReplica(c, relay);
  assert.equal(revocation.header.kind, "membership");
  await expectRejects(
    () => c.createMutation("after-revoke", "put", { title: "Should Fail", body: "revoked" }),
    /revoked/,
  );

  const epoch2Key = await generateVaultKey();
  a.installEpochKey(2, epoch2Key, true);
  b.installEpochKey(2, epoch2Key, true);
  const epoch2Envelope = await a.createMutation("epoch-two", "put", { title: "Future", body: "new epoch" });
  await syncPeerReplica(a, relay);
  await syncPeerReplica(b, relay);
  assert.equal(b.getRecordState("epoch-two").value?.title, "Future");
  await expectRejects(() => syncPeerReplica(c, relay), /No key is available for this envelope epoch/);

  const tamperSource = await a.createMutation("tamper", "put", { title: "Integrity", body: "signed" });
  const tampered = structuredClone(tamperSource) as PeerEnvelope;
  tampered.ciphertext = `${tampered.ciphertext.slice(0, -2)}AA`;
  await expectRejects(() => b.ingestEnvelope(tampered), /signature is invalid/);

  const outsider = await PeerReplica.create<RecordValue>({ vaultId: a.vaultId, deviceId: "OUTSIDER", vaultKey, admin: false });
  outsider.installEpochKey(2, epoch2Key, true);
  const outsiderEnvelope = await outsider.createMutation("outsider", "put", { title: "Unknown", body: "not trusted" });
  await expectRejects(() => b.ingestEnvelope(outsiderEnvelope), /unknown device/);

  await syncPeerReplica(a, relay);
  await syncPeerReplica(b, relay);
  const checkpoint = await a.createCheckpoint();
  await expectRejects(() => b.createCheckpoint(), /admin device/);
  await relay.put(checkpoint);
  const fresh = await PeerReplica.create<RecordValue>({ vaultId: a.vaultId, deviceId: "FRESH", vaultKey, admin: false });
  fresh.installEpochKey(2, epoch2Key, true);
  fresh.trustDevice(await a.descriptor(true));
  await fresh.importCheckpoint(checkpoint);
  for (const recordId of ["shared", "retry", "delete-edit", "three-way", "outage", "epoch-two", "tamper"]) {
    assert.deepEqual(recordSummary(fresh, recordId), recordSummary(a, recordId));
  }

  fresh.trustDevice(await b.descriptor(false));
  const postCheckpointRelay = new SyntheticEncryptedRelay();
  const later = await a.createMutation("later", "put", { title: "After Checkpoint", body: "catch up" });
  await postCheckpointRelay.put(later);
  await syncPeerReplica(fresh, postCheckpointRelay);
  assert.equal(fresh.getRecordState("later").value?.title, "After Checkpoint");

  const bytes = new TextEncoder().encode("attachment bytes that must survive chunked encrypted resume exactly");
  const encryptedAttachment = await encryptAttachment(bytes, epoch2Key, "synthetic-attachment", 9);
  await expectRejects(
    () => decryptAttachment(encryptedAttachment, epoch2Key, encryptedAttachment.chunks.slice(0, -1)),
    /incomplete/,
  );
  const resumed = await decryptAttachment(encryptedAttachment, epoch2Key, [...encryptedAttachment.chunks].reverse());
  assert.deepEqual([...resumed], [...bytes]);
  const damagedAttachment = structuredClone(encryptedAttachment);
  damagedAttachment.chunks[0].ciphertext = `${damagedAttachment.chunks[0].ciphertext.slice(0, -2)}AA`;
  await expectRejects(() => decryptAttachment(damagedAttachment, epoch2Key), /(hash mismatch|operation failed|decrypt)/i);

  const relayDump = relay.opaqueDump();
  for (const plaintext of ["From A", "From B", "Resolved", "Queued Offline", "Future", "Integrity", "explicit choice"]) {
    assert.equal(relayDump.includes(plaintext), false, `relay leaked plaintext: ${plaintext}`);
  }

  const stableBefore = JSON.stringify(recordSummary(b, "shared"));
  await syncPeerReplica(b, relay, { reverseDownload: true, duplicateDownload: true });
  assert.equal(JSON.stringify(recordSummary(b, "shared")), stableBefore);

  console.log(JSON.stringify({
    checks: 19,
    conflictOrderInvariant: true,
    explicitResolution: true,
    lostAckIdempotent: true,
    duplicateReorderSafe: true,
    deleteEditConflict: true,
    threeDeviceConvergence: true,
    revocationEpoch: true,
    outageRecovery: true,
    checkpointCatchup: true,
    attachmentResume: true,
    tamperRejected: true,
    unknownDeviceRejected: true,
    relayPlaintextLeak: false,
  }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
