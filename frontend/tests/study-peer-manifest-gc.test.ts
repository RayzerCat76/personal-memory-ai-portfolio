import assert from "node:assert/strict";
import {
  generateVaultKey,
  PeerDeviceManifest,
  PeerReplica,
  SyntheticEncryptedRelay,
  syncPeerReplica,
} from "../src/lib/study-peer-sync";
import {
  planStudyRelayCompaction,
  StudyDeviceManifestRelay,
  StudyRelay,
} from "../src/lib/study-relay";

type RecordValue = { title: string };

class MemoryManifestRelay implements StudyDeviceManifestRelay {
  rows: PeerDeviceManifest[] = [];
  async putManifest(manifest: PeerDeviceManifest) { this.rows.push(structuredClone(manifest)); }
  async listManifests(vaultId: string) {
    return this.rows.filter(item => item.vaultId === vaultId).map(item => structuredClone(item));
  }
}
async function basePeers() {
  const vaultId = "manifest-vault";
  const vaultKey = await generateVaultKey();
  const a = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "admin-a", vaultKey, admin: true });
  const b = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "peer-b", vaultKey, admin: false });
  const c = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "peer-c", vaultKey, admin: false });
  const descriptors = [await a.descriptor(true), await b.descriptor(false), await c.descriptor(false)];
  for (const replica of [a, b, c]) for (const descriptor of descriptors) replica.trustDevice(descriptor);
  const peer = new SyntheticEncryptedRelay();
  const manifests = new MemoryManifestRelay();
  const relay: StudyRelay = { kind: "jihu", peer, pairing: {} as StudyRelay["pairing"], manifests };
  return { vaultId, vaultKey, a, b, c, peer, manifests, relay };
}

async function publishAck(replica: PeerReplica<RecordValue>, relay: StudyRelay, sequence: number) {
  const result = await syncPeerReplica(replica, relay.peer);
  const manifest = await replica.createDeviceManifest(sequence, result.acknowledgedCheckpoint);
  await relay.manifests!.putManifest(manifest);
  return manifest;
}
async function missingActiveBlocks() {
  const { a, b, peer, manifests, relay } = await basePeers();
  const first = await a.createMutation("one", "put", { title: "one" });
  await syncPeerReplica(a, peer);
  await syncPeerReplica(b, peer);
  const checkpoint = await a.createCheckpoint();
  await peer.put(checkpoint);
  await publishAck(a, relay, 1);
  const plan = await planStudyRelayCompaction(relay, a);
  assert.equal(plan.eligible, false);
  assert.match(plan.reason, /waiting for active device acknowledgement/i);
  assert.ok(!plan.removableMutationObjectIds.includes(first.header.objectId));

  const tampered = structuredClone(await b.createDeviceManifest(1, checkpoint));
  tampered.signature = tampered.signature.slice(0, -4) + "AAAA";
  manifests.rows.push(tampered);
  const stillBlocked = await planStudyRelayCompaction(relay, a);
  assert.equal(stillBlocked.eligible, false);
}

async function staleAndUnknownCannotAuthorize() {
  const { a, b, c, peer, manifests, relay } = await basePeers();
  await a.createMutation("one", "put", { title: "one" });
  await syncPeerReplica(a, peer); await syncPeerReplica(b, peer); await syncPeerReplica(c, peer);
  const checkpoint = await a.createCheckpoint(); await peer.put(checkpoint);
  const stale = await b.createDeviceManifest(1, null);
  await manifests.putManifest(stale);
  await publishAck(a, relay, 1);
  await publishAck(b, relay, 2);
  const unknown = await c.createDeviceManifest(99, checkpoint);
  unknown.deviceId = "unknown-device";
  manifests.rows.push(unknown);
  const plan = await planStudyRelayCompaction(relay, a);
  assert.equal(plan.eligible, false);
  assert.ok(plan.requiredDeviceIds.includes("peer-c"));
  await publishAck(c, relay, 1);
  const eligible = await planStudyRelayCompaction(relay, a);
  assert.equal(eligible.eligible, true);
}

async function manifestOwnershipIsSigned() {
  const { a, b } = await basePeers();
  const manifest = await a.createDeviceManifest(1, null);
  await a.verifyDeviceManifest(manifest);
  const reassigned = { ...manifest, deviceId: b.deviceId };
  await assert.rejects(() => a.verifyDeviceManifest(reassigned), /signature is invalid/i);
}

async function revokedDeviceNoLongerBlocks() {
  const { a, b, c, peer, relay } = await basePeers();
  await a.createMutation("one", "put", { title: "one" });
  await syncPeerReplica(a, peer); await syncPeerReplica(b, peer);
  a.trustDevice({ ...(await c.descriptor(false)), revokedAfterSequence: c.getSequence() });
  const checkpoint = await a.createCheckpoint(); await peer.put(checkpoint);
  await publishAck(a, relay, 1); await publishAck(b, relay, 1);
  const plan = await planStudyRelayCompaction(relay, a);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.requiredDeviceIds, ["admin-a", "peer-b"]);
}

async function ambiguousLatestBlocks() {
  const { a, b, c, peer, manifests, relay } = await basePeers();
  await a.createMutation("one", "put", { title: "one" });
  await syncPeerReplica(a, peer); await syncPeerReplica(b, peer); await syncPeerReplica(c, peer);
  const checkpoint = await a.createCheckpoint(); await peer.put(checkpoint);
  await publishAck(a, relay, 1); await publishAck(c, relay, 1);
  const r = await syncPeerReplica(b, peer);
  await manifests.putManifest(await b.createDeviceManifest(2, r.acknowledgedCheckpoint));
  await manifests.putManifest(await b.createDeviceManifest(2, r.acknowledgedCheckpoint));
  const plan = await planStudyRelayCompaction(relay, a);
  assert.equal(plan.eligible, false);
  assert.match(plan.reason, /ambiguous latest manifests/i);
}
async function successfulSyntheticCompaction() {
  const { vaultId, vaultKey, a, b, c, peer, relay } = await basePeers();
  a.trustDevice({ ...(await c.descriptor(false)), revokedAfterSequence: c.getSequence() });
  const first = await a.createMutation("one", "put", { title: "before checkpoint one" });
  const second = await a.createMutation("two", "put", { title: "before checkpoint two" });
  await syncPeerReplica(a, peer); await syncPeerReplica(b, peer);
  const checkpoint = await a.createCheckpoint(); await peer.put(checkpoint);
  await publishAck(a, relay, 1); await publishAck(b, relay, 1);
  const later = await a.createMutation("later", "put", { title: "after checkpoint" });
  await syncPeerReplica(a, peer);

  const plan = await planStudyRelayCompaction(relay, a);
  assert.equal(plan.eligible, true);
  assert.equal(plan.checkpointObjectId, checkpoint.header.objectId);
  assert.ok(plan.removableMutationObjectIds.includes(first.header.objectId));
  assert.ok(plan.removableMutationObjectIds.includes(second.header.objectId));
  assert.ok(!plan.removableMutationObjectIds.includes(later.header.objectId));
  const deleted = await peer.deleteObjects(vaultId, plan.removableMutationObjectIds);
  assert.equal(deleted, plan.removableMutationObjectIds.length);

  const remaining = await peer.list(vaultId);
  assert.ok(remaining.some(item => item.header.objectId === checkpoint.header.objectId));
  assert.ok(remaining.some(item => item.header.objectId === later.header.objectId));
  const fresh = await PeerReplica.create<RecordValue>({ vaultId, deviceId: "fresh-d", vaultKey, admin: false });
  fresh.trustDevice(await a.descriptor(true));
  await syncPeerReplica(fresh, peer);
  assert.equal(fresh.getRecordState("one").value?.title, "before checkpoint one");
  assert.equal(fresh.getRecordState("two").value?.title, "before checkpoint two");
  assert.equal(fresh.getRecordState("later").value?.title, "after checkpoint");
}

async function main() {
  await missingActiveBlocks();
  await staleAndUnknownCannotAuthorize();
  await manifestOwnershipIsSigned();
  await revokedDeviceNoLongerBlocks();
  await ambiguousLatestBlocks();
  await successfulSyntheticCompaction();
  console.log(JSON.stringify({
    checks: 11,
    missingActiveBlocks: true,
    tamperedManifestCannotAuthorize: true,
    staleManifestCannotOverrideNewer: true,
    unknownManifestCannotAuthorize: true,
    manifestOwnershipSigned: true,
    revokedDeviceExcluded: true,
    ambiguousSameSequenceBlocks: true,
    checkpointAcknowledgementsGateGc: true,
    coveredMutationsRemovedSyntheticOnly: true,
    checkpointAndLaterMutationPreserved: true,
    freshCatchupAfterSyntheticGc: true,
  }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
