export type VersionVector = Record<string, number>;
export type PeerOperation = "put" | "delete";
export type PeerEnvelopeKind = "mutation" | "membership" | "checkpoint";

export type PeerCheckpointAcknowledgement = {
  objectId: string;
  keyEpoch: number;
  acknowledgementVector: VersionVector;
};

export type PeerDeviceManifest = {
  protocol: 1;
  vaultId: string;
  deviceId: string;
  manifestSequence: number;
  deviceSequenceHighWater: number;
  currentEpoch: number;
  acknowledgementVector: VersionVector;
  acknowledgedCheckpoint?: PeerCheckpointAcknowledgement;
  publishedAt: string;
  signature: string;
};

export type PeerMutation<T = unknown> = {
  protocol: 1;
  vaultId: string;
  keyEpoch: number;
  mutationId: string;
  deviceId: string;
  deviceSequence: number;
  recordId: string;
  operation: PeerOperation;
  causalContext: VersionVector;
  parentHeads: string[];
  resolutionOf?: string[];
  createdAt: string;
  record?: T;
};

export type PeerEnvelopeHeader = {
  protocol: 1;
  kind: PeerEnvelopeKind;
  vaultId: string;
  keyEpoch: number;
  deviceId: string;
  deviceSequence: number;
  objectId: string;
};

export type PeerEnvelope = {
  header: PeerEnvelopeHeader;
  iv: string;
  ciphertext: string;
  signature: string;
};

export type TrustedDevice = {
  deviceId: string;
  publicSigningKey: JsonWebKey;
  publicPairingKey?: JsonWebKey;
  admin: boolean;
  revokedAfterSequence?: number;
};

export type MembershipEnrollment = {
  type: "enrol";
  vaultId: string;
  eventId: string;
  adminDeviceId: string;
  trustedDevice: TrustedDevice;
  createdAt: string;
};

export type MembershipRevocation = {
  type: "revoke";
  vaultId: string;
  eventId: string;
  adminDeviceId: string;
  targetDeviceId: string;
  revokedAfterSequence: number;
  newKeyEpoch: number;
  createdAt: string;
};

export type MembershipEvent = MembershipEnrollment | MembershipRevocation;

export type ReplicaRecordState<T = unknown> = {
  recordId: string;
  heads: string[];
  status: "missing" | "value" | "deleted" | "conflict";
  value?: T;
  variants: Array<{ mutationId: string; operation: PeerOperation; record?: T }>;
};

export type PeerCheckpoint<T = unknown> = {
  protocol: 1;
  vaultId: string;
  keyEpoch: number;
  createdAt: string;
  acknowledgementVector?: VersionVector;
  heads: Record<string, string[]>;
  headMutations: PeerMutation<T>[];
  trustedDevices: TrustedDevice[];
};

export type PeerReplicaSnapshot<T = unknown> = {
  currentEpoch: number;
  deviceSequence: number;
  trustedDevices: TrustedDevice[];
  mutations: PeerMutation<T>[];
  heads: Record<string, string[]>;
  outgoing: PeerEnvelope[];
};

export type PeerRelay = {
  put(envelope: PeerEnvelope): Promise<void>;
  list(vaultId: string, options?: { reverse?: boolean; duplicate?: boolean }): Promise<PeerEnvelope[]>;
};

export type AttachmentChunk = {
  attachmentId: string;
  index: number;
  total: number;
  iv: string;
  ciphertext: string;
  sha256: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function cloneVector(vector: VersionVector): VersionVector {
  return Object.fromEntries(Object.entries(vector).filter(([, n]) => Number.isInteger(n) && n > 0));
}

export function mergeVectors(...vectors: VersionVector[]): VersionVector {
  const merged: VersionVector = {};
  for (const vector of vectors) {
    for (const [deviceId, sequence] of Object.entries(vector)) merged[deviceId] = Math.max(merged[deviceId] ?? 0, sequence);
  }
  return merged;
}

export function mutationVector(mutation: PeerMutation): VersionVector {
  return mergeVectors(mutation.causalContext, { [mutation.deviceId]: mutation.deviceSequence });
}

export function vectorDominates(a: VersionVector, b: VersionVector): boolean {
  return Object.entries(b).every(([deviceId, sequence]) => (a[deviceId] ?? 0) >= sequence);
}

function strictlyDominates(a: VersionVector, b: VersionVector): boolean {
  return vectorDominates(a, b) && !vectorDominates(b, a);
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function generateSigningKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
}

export async function exportPublicSigningKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

export async function importPublicSigningKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
}

export async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

async function signEnvelope(header: PeerEnvelopeHeader, iv: string, ciphertext: string, key: CryptoKey): Promise<string> {
  const bytes = encoder.encode(canonical({ header, iv, ciphertext }));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buffer(bytes));
  return bytesToBase64(new Uint8Array(signature));
}

async function signCanonical(value: unknown, key: CryptoKey): Promise<string> {
  const bytes = encoder.encode(canonical(value));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buffer(bytes));
  return bytesToBase64(new Uint8Array(signature));
}

async function verifyCanonical(value: unknown, signature: string, key: CryptoKey): Promise<boolean> {
  const bytes = encoder.encode(canonical(value));
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, buffer(base64ToBytes(signature)), buffer(bytes));
}

async function verifyEnvelopeSignature(envelope: PeerEnvelope, key: CryptoKey): Promise<boolean> {
  const bytes = encoder.encode(canonical({ header: envelope.header, iv: envelope.iv, ciphertext: envelope.ciphertext }));
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, buffer(base64ToBytes(envelope.signature)), buffer(bytes));
}

export async function sealEnvelope(
  header: PeerEnvelopeHeader,
  payload: unknown,
  vaultKey: CryptoKey,
  signingKey: CryptoKey,
): Promise<PeerEnvelope> {
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(canonical(header));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buffer(ivBytes), additionalData: buffer(aad) },
    vaultKey,
    buffer(plaintext),
  );
  const envelope: PeerEnvelope = {
    header,
    iv: bytesToBase64(ivBytes),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    signature: "",
  };
  envelope.signature = await signEnvelope(header, envelope.iv, envelope.ciphertext, signingKey);
  return envelope;
}

export async function openEnvelope<T>(
  envelope: PeerEnvelope,
  vaultKey: CryptoKey,
  trustedDevice: TrustedDevice,
): Promise<T> {
  if (trustedDevice.deviceId !== envelope.header.deviceId) throw new Error("Envelope device identity mismatch.");
  if (trustedDevice.revokedAfterSequence !== undefined && envelope.header.deviceSequence > trustedDevice.revokedAfterSequence) {
    throw new Error("Envelope was signed after device revocation.");
  }
  const publicKey = await importPublicSigningKey(trustedDevice.publicSigningKey);
  if (!(await verifyEnvelopeSignature(envelope, publicKey))) throw new Error("Envelope signature is invalid.");
  const aad = encoder.encode(canonical(envelope.header));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buffer(base64ToBytes(envelope.iv)), additionalData: buffer(aad) },
    vaultKey,
    buffer(base64ToBytes(envelope.ciphertext)),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export class PeerReplica<T = unknown> {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly signingKeys: CryptoKeyPair;
  private trusted = new Map<string, TrustedDevice>();
  private epochKeys = new Map<number, CryptoKey>();
  private currentEpoch = 1;
  private deviceSequence = 0;
  private mutations = new Map<string, PeerMutation<T>>();
  private heads = new Map<string, Set<string>>();
  private outgoing = new Map<string, PeerEnvelope>();
  private sequenceOwners = new Map<string, string>();

  private constructor(vaultId: string, deviceId: string, signingKeys: CryptoKeyPair) {
    this.vaultId = vaultId;
    this.deviceId = deviceId;
    this.signingKeys = signingKeys;
  }

  static async create<T = unknown>(options: {
    vaultId?: string;
    deviceId?: string;
    vaultKey?: CryptoKey;
    admin?: boolean;
  } = {}): Promise<PeerReplica<T>> {
    const vaultId = options.vaultId ?? crypto.randomUUID();
    const deviceId = options.deviceId ?? crypto.randomUUID();
    const signingKeys = await generateSigningKeys();
    const replica = new PeerReplica<T>(vaultId, deviceId, signingKeys);
    replica.epochKeys.set(1, options.vaultKey ?? await generateVaultKey());
    replica.trusted.set(deviceId, {
      deviceId,
      publicSigningKey: await exportPublicSigningKey(signingKeys.publicKey),
      admin: options.admin ?? true,
    });
    return replica;
  }

  static restore<T = unknown>(options: {
    vaultId: string;
    deviceId: string;
    signingKeys: CryptoKeyPair;
    epochKeys: Array<{ epoch: number; key: CryptoKey }>;
    snapshot: PeerReplicaSnapshot<T>;
  }): PeerReplica<T> {
    const replica = new PeerReplica<T>(options.vaultId, options.deviceId, options.signingKeys);
    replica.currentEpoch = options.snapshot.currentEpoch;
    replica.deviceSequence = options.snapshot.deviceSequence;
    for (const item of options.epochKeys) replica.epochKeys.set(item.epoch, item.key);
    for (const device of options.snapshot.trustedDevices) replica.trusted.set(device.deviceId, structuredClone(device));
    for (const mutation of options.snapshot.mutations) {
      replica.mutations.set(mutation.mutationId, structuredClone(mutation));
      replica.sequenceOwners.set(`${mutation.deviceId}:${mutation.deviceSequence}`, mutation.mutationId);
    }
    replica.heads = new Map(Object.entries(options.snapshot.heads).map(([recordId, ids]) => [recordId, new Set(ids)]));
    for (const envelope of options.snapshot.outgoing) replica.outgoing.set(envelope.header.objectId, structuredClone(envelope));
    if (!replica.epochKeys.has(replica.currentEpoch)) throw new Error('Persisted replica is missing its current epoch key.');
    return replica;
  }

  exportSnapshot(): PeerReplicaSnapshot<T> {
    return {
      currentEpoch: this.currentEpoch,
      deviceSequence: this.deviceSequence,
      trustedDevices: this.getTrustedDevices(),
      mutations: [...this.mutations.values()].map(item => structuredClone(item)),
      heads: Object.fromEntries([...this.heads].map(([recordId, ids]) => [recordId, [...ids].sort()])),
      outgoing: this.pendingEnvelopes(),
    };
  }

  listRecordStates(): ReplicaRecordState<T>[] {
    return [...this.heads.keys()].sort().map(recordId => this.getRecordState(recordId));
  }

  hasMutationHistory(): boolean { return this.mutations.size > 0 || this.heads.size > 0; }

  getAcknowledgementVector(): VersionVector {
    return mergeVectors(...[...this.mutations.values()].map(mutationVector));
  }

  coversCheckpoint(payload: PeerCheckpoint<T>): boolean {
    const checkpointMutations = new Map(payload.headMutations.map(mutation => [mutation.mutationId, mutation]));
    for (const [recordId, checkpointHeads] of Object.entries(payload.heads)) {
      const localHeads = [...(this.heads.get(recordId) ?? [])];
      if (!localHeads.length && checkpointHeads.length) return false;
      for (const checkpointHead of checkpointHeads) {
        const checkpointMutation = checkpointMutations.get(checkpointHead);
        if (!checkpointMutation) return false;
        if (this.mutations.has(checkpointHead)) continue;
        const covered = localHeads.some(localHead => {
          const localMutation = this.mutations.get(localHead);
          return Boolean(localMutation && vectorDominates(mutationVector(localMutation), mutationVector(checkpointMutation)));
        });
        if (!covered) return false;
      }
    }
    return true;
  }

  async createDeviceManifest(manifestSequence: number, acknowledgedCheckpoint?: PeerEnvelope | null): Promise<PeerDeviceManifest> {
    if (!Number.isInteger(manifestSequence) || manifestSequence < 1) throw new Error("Invalid device manifest sequence.");
    const self = this.trusted.get(this.deviceId);
    if (!self || self.revokedAfterSequence !== undefined) throw new Error("A revoked or untrusted device cannot publish a manifest.");
    let checkpointAcknowledgement: PeerCheckpointAcknowledgement | undefined;
    if (acknowledgedCheckpoint) {
      const payload = await this.inspectCheckpoint(acknowledgedCheckpoint);
      if (!this.coversCheckpoint(payload)) throw new Error("This device cannot acknowledge a checkpoint it does not causally cover.");
      checkpointAcknowledgement = {
        objectId: acknowledgedCheckpoint.header.objectId,
        keyEpoch: acknowledgedCheckpoint.header.keyEpoch,
        acknowledgementVector: cloneVector(payload.acknowledgementVector ?? {}),
      };
    }
    const unsigned = {
      protocol: 1 as const,
      vaultId: this.vaultId,
      deviceId: this.deviceId,
      manifestSequence,
      deviceSequenceHighWater: this.deviceSequence,
      currentEpoch: this.currentEpoch,
      acknowledgementVector: this.getAcknowledgementVector(),
      ...(checkpointAcknowledgement ? { acknowledgedCheckpoint: checkpointAcknowledgement } : {}),
      publishedAt: new Date().toISOString(),
    };
    return { ...unsigned, signature: await signCanonical(unsigned, this.signingKeys.privateKey) };
  }

  async verifyDeviceManifest(manifest: PeerDeviceManifest): Promise<void> {
    if (manifest.protocol !== 1 || manifest.vaultId !== this.vaultId || !manifest.deviceId
        || !Number.isInteger(manifest.manifestSequence) || manifest.manifestSequence < 1
        || !Number.isInteger(manifest.deviceSequenceHighWater) || manifest.deviceSequenceHighWater < 0
        || !Number.isInteger(manifest.currentEpoch) || manifest.currentEpoch < 1) {
      throw new Error("Device manifest is invalid.");
    }
    const device = this.trusted.get(manifest.deviceId);
    if (!device) throw new Error("Device manifest came from an unknown device.");
    const { signature, ...unsigned } = manifest;
    const publicKey = await importPublicSigningKey(device.publicSigningKey);
    if (!signature || !(await verifyCanonical(unsigned, signature, publicKey))) throw new Error("Device manifest signature is invalid.");
  }

  async descriptor(admin = false): Promise<TrustedDevice> {
    const existing = this.trusted.get(this.deviceId);
    return {
      deviceId: this.deviceId,
      publicSigningKey: await exportPublicSigningKey(this.signingKeys.publicKey),
      admin: admin || existing?.admin === true,
      revokedAfterSequence: existing?.revokedAfterSequence,
    };
  }

  trustDevice(device: TrustedDevice): void {
    const current = this.trusted.get(device.deviceId);
    if (current?.revokedAfterSequence !== undefined && device.revokedAfterSequence === undefined) {
      throw new Error("A revoked device identity cannot be resurrected.");
    }
    this.trusted.set(device.deviceId, structuredClone(device));
  }

  installEpochKey(epoch: number, key: CryptoKey, makeCurrent = false): void {
    if (!Number.isInteger(epoch) || epoch < 1) throw new Error("Invalid key epoch.");
    this.epochKeys.set(epoch, key);
    if (makeCurrent) this.currentEpoch = epoch;
  }

  setCurrentEpoch(epoch: number): void {
    if (!this.epochKeys.has(epoch)) throw new Error("Missing vault key for epoch.");
    this.currentEpoch = epoch;
  }

  getCurrentEpoch(): number { return this.currentEpoch; }
  getSequence(): number { return this.deviceSequence; }
  getEpochKey(epoch = this.currentEpoch): CryptoKey | undefined { return this.epochKeys.get(epoch); }
  getEpochKeys(): Array<{ epoch: number; key: CryptoKey }> { return [...this.epochKeys].map(([epoch, key]) => ({ epoch, key })); }
  getTrustedDevices(): TrustedDevice[] { return [...this.trusted.values()].map(item => structuredClone(item)); }

  private nextSequence(): number {
    const self = this.trusted.get(this.deviceId);
    if (self?.revokedAfterSequence !== undefined && this.deviceSequence >= self.revokedAfterSequence) {
      throw new Error("This device identity has been revoked.");
    }
    this.deviceSequence += 1;
    return this.deviceSequence;
  }

  private vectorForHeads(recordId: string): VersionVector {
    const heads = [...(this.heads.get(recordId) ?? [])];
    return mergeVectors(...heads.map(id => mutationVector(this.mutations.get(id)!)));
  }

  async createMutation(recordId: string, operation: PeerOperation, record?: T, resolveConflict = false): Promise<PeerEnvelope> {
    const currentHeads = [...(this.heads.get(recordId) ?? [])].sort();
    if (currentHeads.length > 1 && !resolveConflict) throw new Error("Resolve the concurrent versions before editing this record.");
    const sequence = this.nextSequence();
    const mutationId = `pm:${this.deviceId}:${sequence}:${crypto.randomUUID()}`;
    const mutation: PeerMutation<T> = {
      protocol: 1,
      vaultId: this.vaultId,
      keyEpoch: this.currentEpoch,
      mutationId,
      deviceId: this.deviceId,
      deviceSequence: sequence,
      recordId,
      operation,
      causalContext: this.vectorForHeads(recordId),
      parentHeads: currentHeads,
      ...(resolveConflict ? { resolutionOf: currentHeads } : {}),
      createdAt: new Date().toISOString(),
      ...(operation === "put" ? { record: structuredClone(record as T) } : {}),
    };
    const key = this.epochKeys.get(this.currentEpoch);
    if (!key) throw new Error("Missing current vault key.");
    const header: PeerEnvelopeHeader = {
      protocol: 1, kind: "mutation", vaultId: this.vaultId, keyEpoch: this.currentEpoch,
      deviceId: this.deviceId, deviceSequence: sequence, objectId: mutationId,
    };
    const envelope = await sealEnvelope(header, mutation, key, this.signingKeys.privateKey);
    this.applyMutation(mutation);
    this.outgoing.set(mutationId, envelope);
    return envelope;
  }

  private applyMutation(mutation: PeerMutation<T>): void {
    if (mutation.protocol !== 1 || mutation.vaultId !== this.vaultId) throw new Error("Mutation belongs to a different vault.");
    const sequenceKey = `${mutation.deviceId}:${mutation.deviceSequence}`;
    const priorAtSequence = this.sequenceOwners.get(sequenceKey);
    if (priorAtSequence && priorAtSequence !== mutation.mutationId) throw new Error("Device sequence was reused by a different mutation.");
    if (this.mutations.has(mutation.mutationId)) return;
    this.sequenceOwners.set(sequenceKey, mutation.mutationId);
    this.mutations.set(mutation.mutationId, structuredClone(mutation));

    const incomingVector = mutationVector(mutation);
    const current = [...(this.heads.get(mutation.recordId) ?? [])];
    if (current.some(id => strictlyDominates(mutationVector(this.mutations.get(id)!), incomingVector))) return;

    const next = current.filter(id => !strictlyDominates(incomingVector, mutationVector(this.mutations.get(id)!)));
    if (!next.includes(mutation.mutationId)) next.push(mutation.mutationId);
    this.heads.set(mutation.recordId, new Set(next));
  }

  async ingestEnvelope(envelope: PeerEnvelope): Promise<"applied" | "duplicate" | "membership"> {
    if (envelope.header.protocol !== 1 || envelope.header.vaultId !== this.vaultId) throw new Error("Envelope belongs to a different vault.");
    const device = this.trusted.get(envelope.header.deviceId);
    if (!device) throw new Error("Envelope came from an unknown device.");
    const key = this.epochKeys.get(envelope.header.keyEpoch);
    if (!key) throw new Error("No key is available for this envelope epoch.");

    if (envelope.header.kind === "mutation") {
      if (this.mutations.has(envelope.header.objectId)) return "duplicate";
      const mutation = await openEnvelope<PeerMutation<T>>(envelope, key, device);
      if (mutation.mutationId !== envelope.header.objectId || mutation.deviceId !== envelope.header.deviceId
        || mutation.deviceSequence !== envelope.header.deviceSequence || mutation.keyEpoch !== envelope.header.keyEpoch) {
        throw new Error("Mutation header does not match its encrypted payload.");
      }
      this.applyMutation(mutation);
      return "applied";
    }

    if (envelope.header.kind === "membership") {
      const event = await openEnvelope<MembershipEvent>(envelope, key, device);
      if (!device.admin) throw new Error("Only an admin device may change trusted membership.");
      if (event.vaultId !== this.vaultId || event.adminDeviceId !== device.deviceId
        || event.eventId !== envelope.header.objectId) throw new Error("Invalid membership event.");
      if (event.type === "enrol") {
        if (!event.trustedDevice?.deviceId || event.trustedDevice.revokedAfterSequence !== undefined) {
          throw new Error("Invalid enrolment event.");
        }
        const current = this.trusted.get(event.trustedDevice.deviceId);
        if (current?.revokedAfterSequence !== undefined) return "membership";
        if (current) {
          if (JSON.stringify(current) !== JSON.stringify(event.trustedDevice)) throw new Error("An active device identity cannot be replaced by enrolment.");
          return "membership";
        }
        this.trustDevice(event.trustedDevice);
        return "membership";
      }
      if (event.type !== "revoke" || event.newKeyEpoch <= envelope.header.keyEpoch) throw new Error("Invalid membership event.");
      const target = this.trusted.get(event.targetDeviceId);
      if (!target) throw new Error("Cannot revoke an unknown device.");
      const previous = target.revokedAfterSequence;
      const revokedAfterSequence = previous === undefined
        ? event.revokedAfterSequence
        : Math.min(previous, event.revokedAfterSequence);
      this.trusted.set(target.deviceId, { ...target, revokedAfterSequence });
      return "membership";
    }
    throw new Error("Checkpoint envelopes must be imported explicitly.");
  }

  async createEnrollmentEnvelope(trustedDevice: TrustedDevice): Promise<PeerEnvelope> {
    const self = this.trusted.get(this.deviceId);
    if (!self?.admin) throw new Error("Only an admin device may enrol another device.");
    if (!trustedDevice.deviceId || trustedDevice.deviceId === this.deviceId || trustedDevice.revokedAfterSequence !== undefined) {
      throw new Error("Invalid device enrolment.");
    }
    const existing = this.trusted.get(trustedDevice.deviceId);
    if (existing?.revokedAfterSequence !== undefined) throw new Error("A revoked device identity cannot be re-enrolled.");
    if (existing) throw new Error("This device identity is already trusted.");
    const sequence = this.nextSequence();
    const eventId = `membership:${this.deviceId}:${sequence}:${crypto.randomUUID()}`;
    const event: MembershipEnrollment = {
      type: "enrol", vaultId: this.vaultId, eventId, adminDeviceId: this.deviceId,
      trustedDevice: structuredClone(trustedDevice), createdAt: new Date().toISOString(),
    };
    const key = this.epochKeys.get(this.currentEpoch)!;
    const header: PeerEnvelopeHeader = {
      protocol: 1, kind: "membership", vaultId: this.vaultId, keyEpoch: this.currentEpoch,
      deviceId: this.deviceId, deviceSequence: sequence, objectId: eventId,
    };
    const envelope = await sealEnvelope(header, event, key, this.signingKeys.privateKey);
    this.outgoing.set(eventId, envelope);
    await this.ingestEnvelope(envelope);
    return envelope;
  }

  async createRevocationEnvelope(targetDeviceId: string, revokedAfterSequence: number, newKeyEpoch: number): Promise<PeerEnvelope> {
    const self = this.trusted.get(this.deviceId);
    if (!self?.admin) throw new Error("Only an admin device may revoke another device.");
    if (!this.trusted.has(targetDeviceId)) throw new Error("Cannot revoke an unknown device.");
    if (!Number.isInteger(revokedAfterSequence) || revokedAfterSequence < 0) throw new Error("Invalid revocation sequence.");
    if (newKeyEpoch <= this.currentEpoch) throw new Error("Revocation must advance the key epoch.");
    const sequence = this.nextSequence();
    const eventId = `membership:${this.deviceId}:${sequence}:${crypto.randomUUID()}`;
    const event: MembershipRevocation = {
      type: "revoke", vaultId: this.vaultId, eventId, adminDeviceId: this.deviceId,
      targetDeviceId, revokedAfterSequence, newKeyEpoch, createdAt: new Date().toISOString(),
    };
    const key = this.epochKeys.get(this.currentEpoch)!;
    const header: PeerEnvelopeHeader = {
      protocol: 1, kind: "membership", vaultId: this.vaultId, keyEpoch: this.currentEpoch,
      deviceId: this.deviceId, deviceSequence: sequence, objectId: eventId,
    };
    const envelope = await sealEnvelope(header, event, key, this.signingKeys.privateKey);
    this.outgoing.set(eventId, envelope);
    await this.ingestEnvelope(envelope);
    return envelope;
  }

  getRecordState(recordId: string): ReplicaRecordState<T> {
    const headIds = [...(this.heads.get(recordId) ?? [])].sort();
    if (!headIds.length) return { recordId, heads: [], status: "missing", variants: [] };
    const variants = headIds.map(id => {
      const mutation = this.mutations.get(id)!;
      return { mutationId: id, operation: mutation.operation, ...(mutation.operation === "put" ? { record: structuredClone(mutation.record as T) } : {}) };
    });
    if (variants.length > 1) return { recordId, heads: headIds, status: "conflict", variants };
    if (variants[0].operation === "delete") return { recordId, heads: headIds, status: "deleted", variants };
    return { recordId, heads: headIds, status: "value", value: structuredClone(variants[0].record as T), variants };
  }

  async resolveConflict(recordId: string, record?: T): Promise<PeerEnvelope> {
    const state = this.getRecordState(recordId);
    if (state.status !== "conflict") throw new Error("This record does not have a conflict to resolve.");
    return this.createMutation(recordId, record === undefined ? "delete" : "put", record, true);
  }

  pendingEnvelopes(): PeerEnvelope[] { return [...this.outgoing.values()].map(item => structuredClone(item)); }
  markRelayStored(objectIds: string[]): void { for (const id of objectIds) this.outgoing.delete(id); }

  async createCheckpoint(): Promise<PeerEnvelope> {
    if (!this.trusted.get(this.deviceId)?.admin) throw new Error("Only an admin device may create a recovery checkpoint.");
    const sequence = this.nextSequence();
    const objectId = `checkpoint:${this.deviceId}:${sequence}:${crypto.randomUUID()}`;
    const headIds = new Set([...this.heads.values()].flatMap(set => [...set]));
    const payload: PeerCheckpoint<T> = {
      protocol: 1,
      vaultId: this.vaultId,
      keyEpoch: this.currentEpoch,
      createdAt: new Date().toISOString(),
      acknowledgementVector: this.getAcknowledgementVector(),
      heads: Object.fromEntries([...this.heads].map(([recordId, ids]) => [recordId, [...ids].sort()])),
      headMutations: [...headIds].map(id => structuredClone(this.mutations.get(id)!)),
      trustedDevices: this.getTrustedDevices(),
    };
    const key = this.epochKeys.get(this.currentEpoch)!;
    return sealEnvelope({
      protocol: 1, kind: "checkpoint", vaultId: this.vaultId, keyEpoch: this.currentEpoch,
      deviceId: this.deviceId, deviceSequence: sequence, objectId,
    }, payload, key, this.signingKeys.privateKey);
  }

  async inspectCheckpoint(envelope: PeerEnvelope): Promise<PeerCheckpoint<T>> {
    if (envelope.header.kind !== "checkpoint" || envelope.header.vaultId !== this.vaultId) throw new Error("Invalid checkpoint envelope.");
    const signer = this.trusted.get(envelope.header.deviceId);
    if (!signer) throw new Error("Checkpoint signer is not trusted.");
    if (!signer.admin) throw new Error("Checkpoint signer is not an admin device.");
    const key = this.epochKeys.get(envelope.header.keyEpoch);
    if (!key) throw new Error("No key is available for this checkpoint epoch.");
    const payload = await openEnvelope<PeerCheckpoint<T>>(envelope, key, signer);
    if (payload.protocol !== 1 || payload.vaultId !== this.vaultId || payload.keyEpoch !== envelope.header.keyEpoch) {
      throw new Error("Checkpoint payload does not match its envelope.");
    }
    const derived = mergeVectors(...payload.headMutations.map(mutationVector));
    if (payload.acknowledgementVector
        && !(vectorDominates(payload.acknowledgementVector, derived) && vectorDominates(derived, payload.acknowledgementVector))) {
      throw new Error("Checkpoint acknowledgement vector does not match its causal head coverage.");
    }
    return { ...payload, acknowledgementVector: payload.acknowledgementVector ?? derived };
  }

  async importCheckpoint(envelope: PeerEnvelope): Promise<void> {
    const payload = await this.inspectCheckpoint(envelope);
    const stagedMutations = new Map<string, PeerMutation<T>>();
    for (const mutation of payload.headMutations) {
      if (mutation.vaultId !== this.vaultId || mutation.protocol !== 1) throw new Error("Checkpoint contains an invalid mutation.");
      stagedMutations.set(mutation.mutationId, structuredClone(mutation));
    }
    for (const ids of Object.values(payload.heads)) {
      for (const id of ids) if (!stagedMutations.has(id)) throw new Error("Checkpoint is missing a head mutation.");
    }
    for (const device of payload.trustedDevices) this.trustDevice(device);
    this.mutations = stagedMutations;
    this.sequenceOwners.clear();
    for (const mutation of this.mutations.values()) {
      const keyValue = `${mutation.deviceId}:${mutation.deviceSequence}`;
      const previous = this.sequenceOwners.get(keyValue);
      if (previous && previous !== mutation.mutationId) throw new Error("Checkpoint reuses a device sequence.");
      this.sequenceOwners.set(keyValue, mutation.mutationId);
    }
    this.heads = new Map(Object.entries(payload.heads).map(([recordId, ids]) => [recordId, new Set(ids)]));
    this.currentEpoch = Math.max(this.currentEpoch, payload.keyEpoch);
  }

  debugSnapshot(): unknown {
    const records = [...this.heads.keys()].sort().map(recordId => this.getRecordState(recordId));
    return {
      vaultId: this.vaultId,
      currentEpoch: this.currentEpoch,
      records,
      trustedDevices: this.getTrustedDevices().sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
    };
  }
}

export class SyntheticEncryptedRelay {
  online = true;
  private objects = new Map<string, PeerEnvelope>();

  async put(envelope: PeerEnvelope): Promise<void> {
    if (!this.online) throw new Error("Synthetic relay is offline.");
    const key = `${envelope.header.vaultId}/${envelope.header.objectId}`;
    const existing = this.objects.get(key);
    if (existing && canonical(existing) !== canonical(envelope)) throw new Error("Relay object ID collision.");
    if (!existing) this.objects.set(key, structuredClone(envelope));
  }

  async list(vaultId: string, options: { reverse?: boolean; duplicate?: boolean } = {}): Promise<PeerEnvelope[]> {
    if (!this.online) throw new Error("Synthetic relay is offline.");
    let values = [...this.objects.values()].filter(item => item.header.vaultId === vaultId).map(item => structuredClone(item));
    values.sort((a, b) => a.header.objectId.localeCompare(b.header.objectId));
    if (options.reverse) values.reverse();
    if (options.duplicate) values = values.flatMap(item => [structuredClone(item), structuredClone(item)]);
    return values;
  }

  async deleteObjects(vaultId: string, objectIds: string[]): Promise<number> {
    if (!this.online) throw new Error("Synthetic relay is offline.");
    let deleted = 0;
    for (const objectId of new Set(objectIds)) {
      if (this.objects.delete(`${vaultId}/${objectId}`)) deleted += 1;
    }
    return deleted;
  }

  opaqueDump(): string { return JSON.stringify([...this.objects.values()]); }
  size(): number { return this.objects.size; }
}

async function selectBootstrapCheckpoint<T>(replica: PeerReplica<T>, envelopes: PeerEnvelope[]): Promise<PeerEnvelope | null> {
  const checkpoints = envelopes.filter(envelope => envelope.header.kind === "checkpoint");
  if (!checkpoints.length) return null;
  const inspected = await Promise.all(checkpoints.map(async envelope => {
    const payload = await replica.inspectCheckpoint(envelope);
    const vector = payload.acknowledgementVector ?? {};
    const substantive = canonical({
      protocol: payload.protocol, vaultId: payload.vaultId, keyEpoch: payload.keyEpoch,
      acknowledgementVector: vector, heads: payload.heads, headMutations: payload.headMutations,
      trustedDevices: payload.trustedDevices,
    });
    return { envelope, vector, substantive };
  }));
  const maximal = inspected.filter(candidate => !inspected.some(other =>
    other !== candidate && strictlyDominates(other.vector, candidate.vector)));
  if (maximal.length === 1) return maximal[0].envelope;
  const first = maximal[0];
  const equivalent = maximal.every(candidate =>
    vectorDominates(candidate.vector, first.vector) && vectorDominates(first.vector, candidate.vector)
    && candidate.substantive === first.substantive);
  if (equivalent) return [...maximal].sort((a, b) => a.envelope.header.objectId.localeCompare(b.envelope.header.objectId)).at(-1)!.envelope;
  throw new Error("Relay contains concurrent checkpoints; bootstrap requires explicit recovery review.");
}

async function selectAcknowledgableCheckpoint<T>(replica: PeerReplica<T>, envelopes: PeerEnvelope[]): Promise<PeerEnvelope | null> {
  const inspected: Array<{ envelope: PeerEnvelope; vector: VersionVector; substantive: string }> = [];
  for (const envelope of envelopes.filter(item => item.header.kind === "checkpoint")) {
    try {
      const payload = await replica.inspectCheckpoint(envelope);
      if (!replica.coversCheckpoint(payload)) continue;
      const vector = payload.acknowledgementVector ?? {};
      inspected.push({
        envelope,
        vector,
        substantive: canonical({
          protocol: payload.protocol, vaultId: payload.vaultId, keyEpoch: payload.keyEpoch,
          acknowledgementVector: vector, heads: payload.heads, headMutations: payload.headMutations,
          trustedDevices: payload.trustedDevices,
        }),
      });
    } catch {
      // Invalid or unavailable checkpoints cannot be acknowledged and do not block ordinary record sync.
    }
  }
  if (!inspected.length) return null;
  const maximal = inspected.filter(candidate => !inspected.some(other =>
    other !== candidate && strictlyDominates(other.vector, candidate.vector)));
  if (maximal.length === 1) return maximal[0].envelope;
  const first = maximal[0];
  const equivalent = maximal.every(candidate =>
    vectorDominates(candidate.vector, first.vector) && vectorDominates(first.vector, candidate.vector)
    && candidate.substantive === first.substantive);
  if (!equivalent) return null;
  return [...maximal].sort((a, b) => a.envelope.header.objectId.localeCompare(b.envelope.header.objectId)).at(-1)!.envelope;
}

export type PeerSyncResult = { acknowledgedCheckpoint: PeerEnvelope | null };

export async function syncPeerReplica<T>(
  replica: PeerReplica<T>,
  relay: PeerRelay,
  options: { reverseDownload?: boolean; duplicateDownload?: boolean; loseAcknowledgementFor?: Set<string>; allowRevokedMissingEpoch?: boolean } = {},
): Promise<PeerSyncResult> {
  const stored: string[] = [];
  for (const envelope of replica.pendingEnvelopes()) {
    await relay.put(envelope);
    if (!options.loseAcknowledgementFor?.has(envelope.header.objectId)) stored.push(envelope.header.objectId);
  }
  replica.markRelayStored(stored);
  const downloaded = await relay.list(replica.vaultId, { reverse: options.reverseDownload, duplicate: options.duplicateDownload });
  if (!replica.hasMutationHistory()) {
    const checkpoint = await selectBootstrapCheckpoint(replica, downloaded);
    if (checkpoint) await replica.importCheckpoint(checkpoint);
  }
  for (const envelope of downloaded) {
    if (envelope.header.kind === "checkpoint") continue;
    try {
      await replica.ingestEnvelope(envelope);
    } catch (error) {
      const self = replica.getTrustedDevices().find(device => device.deviceId === replica.deviceId);
      const missingFutureEpoch = error instanceof Error && error.message.includes("No key is available for this envelope epoch")
        && envelope.header.keyEpoch > replica.getCurrentEpoch();
      if (options.allowRevokedMissingEpoch && self?.revokedAfterSequence !== undefined && missingFutureEpoch) continue;
      throw error;
    }
  }
  return { acknowledgedCheckpoint: await selectAcknowledgableCheckpoint(replica, downloaded) };
}

export class HttpPeerRelay implements PeerRelay {
  constructor(private readonly baseUrl: string) {}

  async put(envelope: PeerEnvelope): Promise<void> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/put`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error(`Peer relay unavailable (${response.status}).`);
  }

  async list(vaultId: string): Promise<PeerEnvelope[]> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/list?vaultId=${encodeURIComponent(vaultId)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Peer relay unavailable (${response.status}).`);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error('Peer relay returned an invalid object list.');
    return value as PeerEnvelope[];
  }
}

export type EncryptedAttachment = {
  attachmentId: string;
  keyWrapIv: string;
  wrappedKey: string;
  chunks: AttachmentChunk[];
};

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer(bytes));
  return bytesToBase64(new Uint8Array(digest));
}

export async function encryptAttachment(
  bytes: Uint8Array,
  vaultKey: CryptoKey,
  attachmentId: string = crypto.randomUUID(),
  chunkSize = 64 * 1024,
): Promise<EncryptedAttachment> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("Invalid attachment chunk size.");
  const attachmentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", attachmentKey));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buffer(wrapIv), additionalData: buffer(encoder.encode(attachmentId)) },
    vaultKey,
    buffer(rawKey),
  );
  const total = Math.max(1, Math.ceil(bytes.length / chunkSize));
  const chunks: AttachmentChunk[] = [];
  for (let index = 0; index < total; index += 1) {
    const part = bytes.slice(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = encoder.encode(canonical({ attachmentId, index, total }));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buffer(iv), additionalData: buffer(aad) }, attachmentKey, buffer(part),
    ));
    chunks.push({ attachmentId, index, total, iv: bytesToBase64(iv), ciphertext: bytesToBase64(encrypted), sha256: await sha256Base64(encrypted) });
  }
  return { attachmentId, keyWrapIv: bytesToBase64(wrapIv), wrappedKey: bytesToBase64(new Uint8Array(wrapped)), chunks };
}

export async function decryptAttachment(
  encrypted: EncryptedAttachment,
  vaultKey: CryptoKey,
  availableChunks = encrypted.chunks,
): Promise<Uint8Array> {
  const wrapIv = base64ToBytes(encrypted.keyWrapIv);
  const rawKey = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buffer(wrapIv), additionalData: buffer(encoder.encode(encrypted.attachmentId)) },
    vaultKey,
    buffer(base64ToBytes(encrypted.wrappedKey)),
  );
  const attachmentKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  if (!availableChunks.length) throw new Error("No attachment chunks are available.");
  const total = availableChunks[0].total;
  const byIndex = new Map(availableChunks.map(chunk => [chunk.index, chunk]));
  if (byIndex.size !== total) throw new Error("Attachment is incomplete.");
  const plaintextParts: Uint8Array[] = [];
  for (let index = 0; index < total; index += 1) {
    const chunk = byIndex.get(index);
    if (!chunk || chunk.attachmentId !== encrypted.attachmentId || chunk.total !== total) throw new Error("Attachment chunk set is inconsistent.");
    const cipherBytes = base64ToBytes(chunk.ciphertext);
    if ((await sha256Base64(cipherBytes)) !== chunk.sha256) throw new Error("Attachment ciphertext hash mismatch.");
    const aad = encoder.encode(canonical({ attachmentId: encrypted.attachmentId, index, total }));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buffer(base64ToBytes(chunk.iv)), additionalData: buffer(aad) },
      attachmentKey,
      buffer(cipherBytes),
    );
    plaintextParts.push(new Uint8Array(plaintext));
  }
  const length = plaintextParts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of plaintextParts) { output.set(part, offset); offset += part.length; }
  return output;
}
