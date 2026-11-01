import { TrustedDevice } from "@/lib/study-peer-sync";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - value.length % 4) % 4)}`;
  return Uint8Array.from(atob(padded), ch => ch.charCodeAt(0));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

export type PairingOffer = {
  protocol: 1;
  type: "study-peer-pairing-offer";
  pairingId: string;
  vaultId: string;
  adminDeviceId: string;
  adminSigningPublicKey: JsonWebKey;
  adminPairingPublicKey: JsonWebKey;
  salt: string;
  expiresAt: string;
};

export type PairingJoinRequest = {
  protocol: 1;
  pairingId: string;
  vaultId: string;
  candidateDeviceId: string;
  candidateSigningPublicKey: JsonWebKey;
  candidatePairingPublicKey: JsonWebKey;
  label: string;
  createdAt: string;
  signature: string;
};

export type PairingBundle = {
  protocol: 1;
  pairingId: string;
  vaultId: string;
  currentEpoch: number;
  epochKeys: Array<{ epoch: number; key: string }>;
  trustedDevices: TrustedDevice[];
  approvedDeviceId: string;
  approvedAt: string;
};

export type PairingApproval = {
  protocol: 1;
  pairingId: string;
  vaultId: string;
  adminDeviceId: string;
  candidateDeviceId: string;
  iv: string;
  ciphertext: string;
  signature: string;
};

export type EpochKeyGrant = {
  protocol: 1;
  type: "epoch-key-grant";
  grantId: string;
  vaultId: string;
  epoch: number;
  adminDeviceId: string;
  adminDeviceSequence: number;
  targetDeviceId: string;
  iv: string;
  ciphertext: string;
  signature: string;
};

export type StudyRecoveryKit = {
  format: "personal-study-recovery-v1";
  vaultId: string;
  currentEpoch: number;
  signer: TrustedDevice;
  wrappedEpochKeys: Array<{ epoch: number; wrapIv: string; wrappedVaultKey: string }>;
  checkpoint: unknown;
  createdAt: string;
};

export async function generatePairingKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
}

export async function exportPairingPublicKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

async function importPairingPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
}

async function ecdhBits(privateKey: CryptoKey, peerPublicKey: JsonWebKey): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits(
    { name: "ECDH", public: await importPairingPublicKey(peerPublicKey) },
    privateKey,
    256,
  );
}

async function hkdfBytes(secret: ArrayBuffer, salt: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: buffer(salt),
    info: buffer(encoder.encode(info)),
  }, key, length * 8);
  return new Uint8Array(bits);
}

export async function derivePairingWrapKey(
  privateKey: CryptoKey,
  peerPublicKey: JsonWebKey,
  salt: string,
  context: string,
): Promise<CryptoKey> {
  const raw = await hkdfBytes(await ecdhBits(privateKey, peerPublicKey), base64UrlToBytes(salt), `study-pairing-wrap:${context}`, 32);
  return crypto.subtle.importKey("raw", buffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function derivePairingShortCode(
  privateKey: CryptoKey,
  peerPublicKey: JsonWebKey,
  salt: string,
  context: string,
): Promise<string> {
  const bytes = await hkdfBytes(await ecdhBits(privateKey, peerPublicKey), base64UrlToBytes(salt), `study-pairing-code:${context}`, 4);
  const value = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  return String(value % 1_000_000).padStart(6, "0");
}

async function signObject(value: unknown, privateKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    buffer(encoder.encode(canonical(value))),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifyObject(value: unknown, signature: string, publicJwk: JsonWebKey): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    buffer(base64UrlToBytes(signature)),
    buffer(encoder.encode(canonical(value))),
  );
}

function randomToken(bytes = 18): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function encodePairingOffer(offer: PairingOffer): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(offer)));
}

export function decodePairingOffer(value: string): PairingOffer {
  const offer = JSON.parse(decoder.decode(base64UrlToBytes(value.trim()))) as PairingOffer;
  if (offer.protocol !== 1 || offer.type !== "study-peer-pairing-offer" || !offer.pairingId || !offer.vaultId
      || !offer.adminDeviceId || !offer.adminSigningPublicKey || !offer.adminPairingPublicKey
      || !Number.isFinite(Date.parse(offer.expiresAt))) throw new Error("This pairing payload is invalid.");
  if (Date.parse(offer.expiresAt) <= Date.now()) throw new Error("This pairing payload has expired. Create a new one on the admin device.");
  return offer;
}

export async function createPairingOffer(options: {
  vaultId: string;
  adminDeviceId: string;
  adminSigningPublicKey: JsonWebKey;
  adminPairingPublicKey: JsonWebKey;
  lifetimeMinutes?: number;
}): Promise<PairingOffer> {
  const lifetime = options.lifetimeMinutes ?? 15;
  return {
    protocol: 1,
    type: "study-peer-pairing-offer",
    pairingId: crypto.randomUUID(),
    vaultId: options.vaultId,
    adminDeviceId: options.adminDeviceId,
    adminSigningPublicKey: structuredClone(options.adminSigningPublicKey),
    adminPairingPublicKey: structuredClone(options.adminPairingPublicKey),
    salt: randomToken(24),
    expiresAt: new Date(Date.now() + lifetime * 60_000).toISOString(),
  };
}

function joinRequestUnsigned(request: PairingJoinRequest): Omit<PairingJoinRequest, "signature"> {
  const { signature: _signature, ...unsigned } = request;
  return unsigned;
}

export async function createPairingJoinRequest(options: {
  offer: PairingOffer;
  candidateDeviceId: string;
  candidateSigningPublicKey: JsonWebKey;
  candidatePairingPublicKey: JsonWebKey;
  label: string;
  signingPrivateKey: CryptoKey;
}): Promise<PairingJoinRequest> {
  const unsigned: Omit<PairingJoinRequest, "signature"> = {
    protocol: 1,
    pairingId: options.offer.pairingId,
    vaultId: options.offer.vaultId,
    candidateDeviceId: options.candidateDeviceId,
    candidateSigningPublicKey: structuredClone(options.candidateSigningPublicKey),
    candidatePairingPublicKey: structuredClone(options.candidatePairingPublicKey),
    label: options.label.trim().slice(0, 80) || "New device",
    createdAt: new Date().toISOString(),
  };
  return { ...unsigned, signature: await signObject(unsigned, options.signingPrivateKey) };
}

export async function verifyPairingJoinRequest(request: PairingJoinRequest, offer: PairingOffer): Promise<void> {
  if (request.protocol !== 1 || request.pairingId !== offer.pairingId || request.vaultId !== offer.vaultId
      || !request.candidateDeviceId || !request.candidateSigningPublicKey || !request.candidatePairingPublicKey) {
    throw new Error("The pairing request does not match this offer.");
  }
  if (!(await verifyObject(joinRequestUnsigned(request), request.signature, request.candidateSigningPublicKey))) {
    throw new Error("The new device pairing request signature is invalid.");
  }
}

export async function sealPairingApproval(options: {
  offer: PairingOffer;
  request: PairingJoinRequest;
  wrapKey: CryptoKey;
  bundle: PairingBundle;
  adminSigningPrivateKey: CryptoKey;
}): Promise<PairingApproval> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(canonical({ pairingId: options.offer.pairingId, candidateDeviceId: options.request.candidateDeviceId }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buffer(iv), additionalData: buffer(aad) },
    options.wrapKey,
    buffer(encoder.encode(JSON.stringify(options.bundle))),
  );
  const unsigned = {
    protocol: 1 as const,
    pairingId: options.offer.pairingId,
    vaultId: options.offer.vaultId,
    adminDeviceId: options.offer.adminDeviceId,
    candidateDeviceId: options.request.candidateDeviceId,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
  return { ...unsigned, signature: await signObject(unsigned, options.adminSigningPrivateKey) };
}

export async function openPairingApproval(options: {
  approval: PairingApproval;
  offer: PairingOffer;
  candidateDeviceId: string;
  wrapKey: CryptoKey;
}): Promise<PairingBundle> {
  const { signature, ...unsigned } = options.approval;
  if (unsigned.protocol !== 1 || unsigned.pairingId !== options.offer.pairingId || unsigned.vaultId !== options.offer.vaultId
      || unsigned.adminDeviceId !== options.offer.adminDeviceId || unsigned.candidateDeviceId !== options.candidateDeviceId) {
    throw new Error("The pairing approval does not match this device.");
  }
  if (!(await verifyObject(unsigned, signature, options.offer.adminSigningPublicKey))) throw new Error("The pairing approval signature is invalid.");
  const aad = encoder.encode(canonical({ pairingId: options.offer.pairingId, candidateDeviceId: options.candidateDeviceId }));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buffer(base64UrlToBytes(unsigned.iv)), additionalData: buffer(aad) },
    options.wrapKey,
    buffer(base64UrlToBytes(unsigned.ciphertext)),
  );
  const bundle = JSON.parse(decoder.decode(plaintext)) as PairingBundle;
  if (bundle.protocol !== 1 || bundle.pairingId !== options.offer.pairingId || bundle.vaultId !== options.offer.vaultId
      || bundle.approvedDeviceId !== options.candidateDeviceId || !Number.isInteger(bundle.currentEpoch) || bundle.currentEpoch < 1) {
    throw new Error("The approved pairing bundle is invalid.");
  }
  return bundle;
}

export async function exportAesKey(key: CryptoKey): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export async function importAesKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buffer(base64UrlToBytes(value)), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

function grantUnsigned(grant: EpochKeyGrant): Omit<EpochKeyGrant, "signature"> {
  const { signature: _signature, ...unsigned } = grant;
  return unsigned;
}

export async function createEpochKeyGrant(options: {
  vaultId: string;
  epoch: number;
  adminDeviceId: string;
  adminDeviceSequence: number;
  targetDeviceId: string;
  adminPairingPrivateKey: CryptoKey;
  targetPairingPublicKey: JsonWebKey;
  adminSigningPrivateKey: CryptoKey;
  vaultKey: CryptoKey;
}): Promise<EpochKeyGrant> {
  const salt = bytesToBase64Url(encoder.encode(`${options.vaultId}:${options.epoch}`));
  const context = `${options.adminDeviceId}:${options.targetDeviceId}:${options.epoch}`;
  const wrapKey = await derivePairingWrapKey(options.adminPairingPrivateKey, options.targetPairingPublicKey, salt, context);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(canonical({ vaultId: options.vaultId, epoch: options.epoch, targetDeviceId: options.targetDeviceId }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buffer(iv), additionalData: buffer(aad) }, wrapKey,
    buffer(base64UrlToBytes(await exportAesKey(options.vaultKey))),
  );
  const unsigned: Omit<EpochKeyGrant, "signature"> = {
    protocol: 1,
    type: "epoch-key-grant",
    grantId: `keygrant:${options.epoch}:${options.targetDeviceId}:${crypto.randomUUID()}`,
    vaultId: options.vaultId,
    epoch: options.epoch,
    adminDeviceId: options.adminDeviceId,
    adminDeviceSequence: options.adminDeviceSequence,
    targetDeviceId: options.targetDeviceId,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
  return { ...unsigned, signature: await signObject(unsigned, options.adminSigningPrivateKey) };
}

export async function openEpochKeyGrant(options: {
  grant: EpochKeyGrant;
  ownDeviceId: string;
  ownPairingPrivateKey: CryptoKey;
  adminDevice: TrustedDevice;
}): Promise<CryptoKey> {
  const grant = options.grant;
  if (grant.protocol !== 1 || grant.type !== "epoch-key-grant" || grant.targetDeviceId !== options.ownDeviceId
      || grant.adminDeviceId !== options.adminDevice.deviceId || !Number.isInteger(grant.adminDeviceSequence) || grant.adminDeviceSequence < 1
      || !options.adminDevice.admin || !options.adminDevice.publicPairingKey
      || (options.adminDevice.revokedAfterSequence !== undefined && grant.adminDeviceSequence > options.adminDevice.revokedAfterSequence)) {
    throw new Error("Invalid epoch-key grant.");
  }
  if (!(await verifyObject(grantUnsigned(grant), grant.signature, options.adminDevice.publicSigningKey))) {
    throw new Error("Epoch-key grant signature is invalid.");
  }
  const salt = bytesToBase64Url(encoder.encode(`${grant.vaultId}:${grant.epoch}`));
  const context = `${grant.adminDeviceId}:${grant.targetDeviceId}:${grant.epoch}`;
  const wrapKey = await derivePairingWrapKey(options.ownPairingPrivateKey, options.adminDevice.publicPairingKey, salt, context);
  const aad = encoder.encode(canonical({ vaultId: grant.vaultId, epoch: grant.epoch, targetDeviceId: grant.targetDeviceId }));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buffer(base64UrlToBytes(grant.iv)), additionalData: buffer(aad) }, wrapKey,
    buffer(base64UrlToBytes(grant.ciphertext)),
  );
  return crypto.subtle.importKey("raw", plaintext, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

export function createRecoverySecret(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function recoveryKeyFromSecret(secret: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(secret.trim());
  if (bytes.length !== 32) throw new Error("Recovery secret is invalid.");
  return crypto.subtle.importKey("raw", buffer(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function wrapRecoveryVaultKey(options: {
  vaultKey: CryptoKey;
  recoveryKey: CryptoKey;
  vaultId: string;
  epoch: number;
}): Promise<{ wrapIv: string; wrappedVaultKey: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(canonical({ vaultId: options.vaultId, epoch: options.epoch, purpose: "study-recovery" }));
  const plaintext = encoder.encode(await exportAesKey(options.vaultKey));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: buffer(iv), additionalData: buffer(aad) }, options.recoveryKey, buffer(plaintext),
  );
  return { wrapIv: bytesToBase64Url(iv), wrappedVaultKey: bytesToBase64Url(new Uint8Array(ciphertext)) };
}

export async function unwrapRecoveryVaultKey(options: {
  vaultId: string;
  epoch: number;
  wrapIv: string;
  wrappedVaultKey: string;
  recoveryKey: CryptoKey;
}): Promise<CryptoKey> {
  const aad = encoder.encode(canonical({ vaultId: options.vaultId, epoch: options.epoch, purpose: "study-recovery" }));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buffer(base64UrlToBytes(options.wrapIv)), additionalData: buffer(aad) },
    options.recoveryKey, buffer(base64UrlToBytes(options.wrappedVaultKey)),
  );
  return importAesKey(decoder.decode(plaintext));
}

export class StudyPairingHttpRelay {
  constructor(private readonly baseUrl: string) {}
  private url(path: string): string { return `${this.baseUrl.replace(/\/$/, "")}${path}`; }

  async putRequest(request: PairingJoinRequest): Promise<void> {
    const response = await fetch(this.url(`/pairing/${encodeURIComponent(request.pairingId)}/request`), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Pairing relay unavailable (${response.status}).`);
  }

  async getRequest(pairingId: string): Promise<PairingJoinRequest | null> {
    const response = await fetch(this.url(`/pairing/${encodeURIComponent(pairingId)}/request`), { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Pairing relay unavailable (${response.status}).`);
    return response.json();
  }

  async putApproval(approval: PairingApproval): Promise<void> {
    const response = await fetch(this.url(`/pairing/${encodeURIComponent(approval.pairingId)}/approval`), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(approval),
    });
    if (!response.ok) throw new Error(`Pairing relay unavailable (${response.status}).`);
  }

  async getApproval(pairingId: string): Promise<PairingApproval | null> {
    const response = await fetch(this.url(`/pairing/${encodeURIComponent(pairingId)}/approval`), { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Pairing relay unavailable (${response.status}).`);
    return response.json();
  }

  async putKeyGrant(grant: EpochKeyGrant): Promise<void> {
    const response = await fetch(this.url("/key-grant"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(grant),
    });
    if (!response.ok) throw new Error(`Pairing relay unavailable (${response.status}).`);
  }

  async listKeyGrants(vaultId: string, deviceId: string): Promise<EpochKeyGrant[]> {
    const response = await fetch(this.url(`/key-grant?vaultId=${encodeURIComponent(vaultId)}&deviceId=${encodeURIComponent(deviceId)}`), { cache: "no-store" });
    if (!response.ok) throw new Error(`Pairing relay unavailable (${response.status}).`);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error("Pairing relay returned invalid key grants.");
    return value;
  }
}
