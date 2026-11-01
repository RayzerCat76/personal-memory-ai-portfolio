import { EpochKeyGrant, PairingApproval, PairingJoinRequest } from "@/lib/study-peer-pairing";
import { AttachmentChunk, PeerDeviceManifest, PeerEnvelope, PeerRelay } from "@/lib/study-peer-sync";
import { EncryptedAttachmentManifest, StudyAttachmentRelay, StudyDeviceManifestRelay, StudyPairingRelay, StudyRelay } from "@/lib/study-relay";
import { getJihuAccessToken, getJihuRelayConfig, JihuRelayConfig } from "@/lib/study-jihu-auth";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function safeSegment(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

type TreeItem = { path: string; type: string };
type FileResponse = { content?: string; encoding?: string };
class JihuRepositoryClient {
  constructor(private readonly config: JihuRelayConfig) {}

  private apiUrl(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}/api/v4${path}`;
  }

  private projectPath(path: string): string {
    return `/projects/${encodeURIComponent(this.config.projectId)}${path}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await getJihuAccessToken();
    return fetch(this.apiUrl(path), {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
  }

  async validatePrivateProject(): Promise<void> {
    const response = await this.request(this.projectPath(""));
    if (!response.ok) throw new Error(`JihuLab project is unavailable (${response.status}).`);
    const value = await response.json() as { visibility?: string; default_branch?: string | null };
    if (value.visibility !== "private") throw new Error("JihuLab relay project must be private.");
    if (!value.default_branch) throw new Error("JihuLab relay project needs an initialized default branch.");
  }
  async getJson<T>(filePath: string): Promise<T | null> {
    const path = this.projectPath(`/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(this.config.branch)}`);
    const response = await this.request(path);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`JihuLab relay read failed (${response.status}).`);
    const value = await response.json() as FileResponse;
    if (value.encoding !== "base64" || !value.content) throw new Error("JihuLab returned an invalid relay file.");
    const binary = atob(value.content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return JSON.parse(decoder.decode(bytes)) as T;
  }

  async putJsonImmutable(filePath: string, value: unknown): Promise<void> {
    const content = JSON.stringify(value);
    const path = this.projectPath(`/repository/files/${encodeURIComponent(filePath)}`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.request(path, {
        method: "POST",
        body: JSON.stringify({ branch: this.config.branch, content, commit_message: "Store encrypted relay object" }),
      });
      if (response.ok) return;
      const existing = await this.getJson<unknown>(filePath).catch(() => null);
      if (existing !== null) {
        if (canonical(existing) === canonical(value)) return;
        throw new Error("JihuLab relay object path already contains different data.");
      }
      if (attempt === 2) throw new Error(`JihuLab relay write failed (${response.status}).`);
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  async listJson<T>(prefix: string): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        path: prefix,
        ref: this.config.branch,
        recursive: "true",
        per_page: "100",
        page: String(page),
      });
      const response = await this.request(this.projectPath(`/repository/tree?${query}`));
      // GitLab-compatible repository tree APIs return 404 when the requested
      // path does not exist yet. A brand-new relay vault therefore has no
      // objects rather than a transport failure. Project/branch availability
      // is validated separately and immutable writes still fail closed.
      if (response.status === 404) return values;
      if (!response.ok) throw new Error(`JihuLab relay listing failed (${response.status}).`);
      const items = await response.json() as TreeItem[];
      const files = items.filter(item => item.type === "blob" && item.path.endsWith(".json"));
      for (let offset = 0; offset < files.length; offset += 8) {
        const batch = files.slice(offset, offset + 8);
        const batchValues = await Promise.all(batch.map(item => this.getJson<T>(item.path)));
        for (const value of batchValues) if (value !== null) values.push(value);
      }
      if (items.length < 100) break;
      if (page >= 1000) throw new Error("JihuLab relay listing exceeded the bounded page limit.");
    }
    return values;
  }
}

function envelopePath(envelope: PeerEnvelope): string {
  return [
    "relay/v1/vaults", safeSegment(envelope.header.vaultId), "objects",
    safeSegment(envelope.header.deviceId),
    `${String(envelope.header.deviceSequence).padStart(12, "0")}-${safeSegment(envelope.header.objectId)}.json`,
  ].join("/");
}
class JihuPeerRelay implements PeerRelay {
  constructor(private readonly client: JihuRepositoryClient) {}

  async put(envelope: PeerEnvelope): Promise<void> {
    await this.client.putJsonImmutable(envelopePath(envelope), envelope);
  }

  async list(vaultId: string): Promise<PeerEnvelope[]> {
    return this.client.listJson<PeerEnvelope>(`relay/v1/vaults/${safeSegment(vaultId)}/objects`);
  }
}

class JihuDeviceManifestRelay implements StudyDeviceManifestRelay {
  constructor(private readonly client: JihuRepositoryClient) {}

  async putManifest(manifest: PeerDeviceManifest): Promise<void> {
    const path = [
      "relay/v1/vaults", safeSegment(manifest.vaultId), "device-manifests",
      safeSegment(manifest.deviceId), `${String(manifest.manifestSequence).padStart(12, "0")}.json`,
    ].join("/");
    await this.client.putJsonImmutable(path, manifest);
  }

  async listManifests(vaultId: string): Promise<PeerDeviceManifest[]> {
    return this.client.listJson<PeerDeviceManifest>(
      `relay/v1/vaults/${safeSegment(vaultId)}/device-manifests`,
    );
  }
}

class JihuAttachmentRelay implements StudyAttachmentRelay {
  constructor(private readonly client: JihuRepositoryClient) {}

  private prefix(vaultId: string, attachmentId: string): string {
    return ["relay/v1/vaults", safeSegment(vaultId), "attachments", safeSegment(attachmentId)].join("/");
  }

  async putManifest(vaultId: string, manifest: EncryptedAttachmentManifest): Promise<void> {
    if (manifest.attachmentId.length === 0) throw new Error("Attachment manifest is missing its ID.");
    await this.client.putJsonImmutable(`${this.prefix(vaultId, manifest.attachmentId)}/manifest.json`, manifest);
  }

  async getManifest(vaultId: string, attachmentId: string): Promise<EncryptedAttachmentManifest | null> {
    return this.client.getJson<EncryptedAttachmentManifest>(`${this.prefix(vaultId, attachmentId)}/manifest.json`);
  }

  async putChunk(vaultId: string, chunk: AttachmentChunk): Promise<void> {
    const path = `${this.prefix(vaultId, chunk.attachmentId)}/chunks/${String(chunk.index).padStart(8, "0")}.json`;
    await this.client.putJsonImmutable(path, chunk);
  }

  async listChunks(vaultId: string, attachmentId: string): Promise<AttachmentChunk[]> {
    return this.client.listJson<AttachmentChunk>(`${this.prefix(vaultId, attachmentId)}/chunks`);
  }
}

class JihuPairingRelay implements StudyPairingRelay {
  constructor(private readonly client: JihuRepositoryClient) {}

  async putRequest(request: PairingJoinRequest): Promise<void> {
    const path = `relay/v1/pairing/${safeSegment(request.pairingId)}/request.json`;
    await this.client.putJsonImmutable(path, request);
  }

  async getRequest(pairingId: string): Promise<PairingJoinRequest | null> {
    return this.client.getJson<PairingJoinRequest>(`relay/v1/pairing/${safeSegment(pairingId)}/request.json`);
  }

  async putApproval(approval: PairingApproval): Promise<void> {
    const path = `relay/v1/pairing/${safeSegment(approval.pairingId)}/approval.json`;
    await this.client.putJsonImmutable(path, approval);
  }
  async getApproval(pairingId: string): Promise<PairingApproval | null> {
    return this.client.getJson<PairingApproval>(`relay/v1/pairing/${safeSegment(pairingId)}/approval.json`);
  }

  async putKeyGrant(grant: EpochKeyGrant): Promise<void> {
    const path = [
      "relay/v1/vaults", safeSegment(grant.vaultId), "key-grants",
      safeSegment(grant.targetDeviceId), `${safeSegment(grant.grantId)}.json`,
    ].join("/");
    await this.client.putJsonImmutable(path, grant);
  }

  async listKeyGrants(vaultId: string, deviceId: string): Promise<EpochKeyGrant[]> {
    const prefix = [
      "relay/v1/vaults", safeSegment(vaultId), "key-grants", safeSegment(deviceId),
    ].join("/");
    return this.client.listJson<EpochKeyGrant>(prefix);
  }
}

export function getJihuStudyRelay(): StudyRelay {
  const config = getJihuRelayConfig();
  if (!config) throw new Error("JihuLab relay is not configured yet.");
  const client = new JihuRepositoryClient(config);
  return {
    kind: "jihu",
    peer: new JihuPeerRelay(client),
    pairing: new JihuPairingRelay(client),
    attachments: new JihuAttachmentRelay(client),
    manifests: new JihuDeviceManifestRelay(client),
  };
}

export async function validateJihuStudyRelay(): Promise<void> {
  const config = getJihuRelayConfig();
  if (!config) throw new Error("JihuLab relay is not configured yet.");
  await new JihuRepositoryClient(config).validatePrivateProject();
}
