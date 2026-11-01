export type JihuRelayConfig = {
  baseUrl: string;
  projectId: string;
  clientId: string;
  branch: string;
};

export type JihuAuthStatus = {
  configured: boolean;
  connected: boolean;
  projectId: string;
  lastError: string;
};

type JihuOAuthTokens = {
  id: "tokens";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

type PendingPkce = {
  state: string;
  verifier: string;
  redirectUri: string;
};

const AUTH_DB = "personal-study-jihu-auth";
const AUTH_STORE = "credentials";
const PKCE_KEY = "personal-study-jihu-pkce";
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("JihuLab auth storage failed."));
  });
}

function openAuthDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AUTH_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUTH_STORE)) db.createObjectStore(AUTH_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("JihuLab auth storage failed."));
  });
}

async function readTokens(): Promise<JihuOAuthTokens | null> {
  const db = await openAuthDb();
  try {
    return (await requestResult(db.transaction(AUTH_STORE).objectStore(AUTH_STORE).get("tokens")) as JihuOAuthTokens | undefined) ?? null;
  } finally { db.close(); }
}

async function writeTokens(tokens: JihuOAuthTokens): Promise<void> {
  const db = await openAuthDb();
  try { await requestResult(db.transaction(AUTH_STORE, "readwrite").objectStore(AUTH_STORE).put(tokens)); }
  finally { db.close(); }
}
async function deleteTokens(): Promise<void> {
  const db = await openAuthDb();
  try { await requestResult(db.transaction(AUTH_STORE, "readwrite").objectStore(AUTH_STORE).delete("tokens")); }
  finally { db.close(); }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomVerifier(bytes = 48): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

function redirectUri(): string {
  if (typeof window === "undefined") throw new Error("JihuLab OAuth requires a browser.");
  return `${window.location.origin}/relay/oauth/callback`;
}

export function getJihuRelayConfig(): JihuRelayConfig | null {
  const projectId = process.env.NEXT_PUBLIC_STUDY_JIHU_PROJECT_ID?.trim() ?? "";
  const clientId = process.env.NEXT_PUBLIC_STUDY_JIHU_OAUTH_CLIENT_ID?.trim() ?? "";
  if (!projectId || !clientId) return null;
  return {
    baseUrl: process.env.NEXT_PUBLIC_STUDY_JIHU_BASE_URL?.trim() || "https://jihulab.com",
    projectId,
    clientId,
    branch: process.env.NEXT_PUBLIC_STUDY_JIHU_BRANCH?.trim() || "main",
  };
}
type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at?: number;
};

async function exchangeToken(config: JihuRelayConfig, params: URLSearchParams): Promise<JihuOAuthTokens> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!response.ok) throw new Error(`JihuLab OAuth failed (${response.status}).`);
  const value = await response.json() as Partial<TokenResponse>;
  if (!value.access_token || !value.refresh_token || !Number.isFinite(value.expires_in)) {
    throw new Error("JihuLab returned an invalid OAuth token response.");
  }
  const createdAt = Number.isFinite(value.created_at) ? Number(value.created_at) * 1000 : Date.now();
  return {
    id: "tokens",
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: createdAt + Number(value.expires_in) * 1000,
  };
}

export async function beginJihuAuthorization(): Promise<void> {
  const config = getJihuRelayConfig();
  if (!config) throw new Error("JihuLab relay is not configured yet.");
  const verifier = randomVerifier();
  const state = randomVerifier(24);
  const pending: PendingPkce = { state, verifier, redirectUri: redirectUri() };
  sessionStorage.setItem(PKCE_KEY, JSON.stringify(pending));
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: pending.redirectUri,
    response_type: "code",
    state,
    scope: "api",
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });
  window.location.assign(`${config.baseUrl.replace(/\/$/, "")}/oauth/authorize?${params}`);
}
export async function completeJihuAuthorization(code: string, returnedState: string): Promise<void> {
  const config = getJihuRelayConfig();
  if (!config) throw new Error("JihuLab relay is not configured yet.");
  const raw = sessionStorage.getItem(PKCE_KEY);
  if (!raw) throw new Error("JihuLab sign-in session was not found. Start the connection again.");
  const pending = JSON.parse(raw) as PendingPkce;
  if (!pending.state || pending.state !== returnedState || !pending.verifier || pending.redirectUri !== redirectUri()) {
    throw new Error("JihuLab OAuth state did not match. Nothing was connected.");
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    code,
    grant_type: "authorization_code",
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  });
  const tokens = await exchangeToken(config, params);
  await writeTokens(tokens);
  sessionStorage.removeItem(PKCE_KEY);
}

async function refreshTokens(config: JihuRelayConfig, current: JihuOAuthTokens): Promise<JihuOAuthTokens> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    refresh_token: current.refreshToken,
    grant_type: "refresh_token",
    redirect_uri: redirectUri(),
  });
  const next = await exchangeToken(config, params);
  await writeTokens(next);
  return next;
}

export async function getJihuAccessToken(): Promise<string> {
  const config = getJihuRelayConfig();
  if (!config) throw new Error("JihuLab relay is not configured yet.");
  let tokens = await readTokens();
  if (!tokens) throw new Error("Connect JihuLab in Devices before syncing.");
  if (tokens.expiresAt <= Date.now() + 60_000) tokens = await refreshTokens(config, tokens);
  return tokens.accessToken;
}
export async function getJihuAuthStatus(): Promise<JihuAuthStatus> {
  const config = getJihuRelayConfig();
  if (!config) return { configured: false, connected: false, projectId: "", lastError: "" };
  try {
    const tokens = await readTokens();
    return { configured: true, connected: Boolean(tokens), projectId: config.projectId, lastError: "" };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      projectId: config.projectId,
      lastError: error instanceof Error ? error.message : "Could not read JihuLab connection state.",
    };
  }
}

export async function disconnectJihu(): Promise<void> {
  await deleteTokens();
  if (typeof window !== "undefined") window.dispatchEvent(new Event("personal-study-relay-auth"));
}

export function announceJihuConnected(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("personal-study-relay-auth"));
}
