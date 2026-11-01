"use client";

import { Wllama } from "@wllama/wllama/esm/index.js";
import { probeDeviceCapabilities, readStoredCapabilities, selectLocalAiProfile, shouldUseConservativeWasmProfile, type DeviceCapabilities } from "./device-capabilities";

const MODEL_URL = process.env.NEXT_PUBLIC_BROWSER_AI_MODEL_URL?.trim() || "";
const MODEL_NAME = process.env.NEXT_PUBLIC_BROWSER_AI_MODEL_NAME?.trim() || "Local GGUF model";
const MODEL_CACHE_DB = "personal-memory-ai-model-cache-v1";
const MODEL_CACHE_STORE = "models";
const MODEL_CAPABILITY_IDENTITY_KEY = "personal-memory-ai-browser-model-capability-identity-v1";
let capabilityProbe: Promise<DeviceCapabilities> | null = null;

function idbResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local model cache failed."));
  });
}

function openModelCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MODEL_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MODEL_CACHE_STORE)) db.createObjectStore(MODEL_CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Local model cache failed."));
  });
}

async function readCachedModelBuffer(cacheKey: string): Promise<ArrayBuffer | null> {
  const db = await openModelCache();
  try {
    return (await idbResult(db.transaction(MODEL_CACHE_STORE).objectStore(MODEL_CACHE_STORE).get(cacheKey)) as ArrayBuffer | undefined) ?? null;
  } finally { db.close(); }
}

async function writeCachedModelBuffer(cacheKey: string, buffer: ArrayBuffer): Promise<void> {
  const db = await openModelCache();
  try {
    const tx = db.transaction(MODEL_CACHE_STORE, "readwrite");
    tx.objectStore(MODEL_CACHE_STORE).put(buffer, cacheKey);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Local model cache failed."));
      tx.onabort = () => reject(tx.error ?? new Error("Local model cache was aborted."));
    });
  } finally { db.close(); }
}

async function modelBlobForIndexedDbFallback(): Promise<Blob> {
  const url = resolvedSameOriginModelUrl();
  const cacheKey = `${url}::${MODEL_NAME}`;
  const cached = await readCachedModelBuffer(cacheKey);
  if (cached?.byteLength) return new Blob([cached], { type: "application/octet-stream" });
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Local model download failed (HTTP ${response.status}).`);
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error("The local model download was empty.");
  await writeCachedModelBuffer(cacheKey, buffer);
  return new Blob([buffer], { type: "application/octet-stream" });
}

function createRuntime() {
  const runtime = new Wllama({ default: "/wllama/wllama.wasm" }, { allowOffline: true, suppressNativeLog: true });
  runtime.setCompat({ wasm: "/wllama-compat/wllama.wasm", worker: "/wllama-compat/wllama.js" });
  return runtime;
}

export async function smokeBrowserAiRuntime(): Promise<void> {
  const failures: string[] = [];
  for (const url of ["/wllama/wllama.wasm", "/wllama-compat/wllama.wasm"]) {
    try {
      const response = await fetch(url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await WebAssembly.compile(await response.arrayBuffer());
      return;
    } catch (error) { failures.push(`${url}: ${error instanceof Error ? error.message : "compile failed"}`); }
  }
  throw new Error(`No bundled local-AI WASM build is compatible. ${failures.join(" | ")}`);
}

export function browserAiModelConfigured(): boolean { return Boolean(MODEL_URL); }
export function browserAiModelName(): string { return MODEL_NAME; }

function browserAiModelIdentity(): string {
  return MODEL_URL ? `${MODEL_URL}::${MODEL_NAME}` : "unconfigured";
}

function storedModelIdentity(): string | null {
  try { return localStorage.getItem(MODEL_CAPABILITY_IDENTITY_KEY); }
  catch { return null; }
}

function storeModelIdentity(identity: string): void {
  try { localStorage.setItem(MODEL_CAPABILITY_IDENTITY_KEY, identity); }
  catch { /* Capability probing still works when preference storage is unavailable. */ }
}

export async function ensureBrowserLocalAiCapabilities(force = false): Promise<DeviceCapabilities> {
  const configured = browserAiModelConfigured();
  const identity = browserAiModelIdentity();
  const stored = await readStoredCapabilities();
  const identityMatches = storedModelIdentity() === identity;
  const reusable = !force && stored && stored.modelConfigured === configured && identityMatches;
  if (reusable) return stored;
  if (capabilityProbe) return capabilityProbe;
  capabilityProbe = probeDeviceCapabilities(
    smokeBrowserAiRuntime,
    configured,
    configured ? qualifyBrowserLocalAi : undefined,
  ).then(result => { storeModelIdentity(identity); return result; })
    .finally(() => { capabilityProbe = null; });
  return capabilityProbe;
}

function resolvedSameOriginModelUrl(): string {
  if (!MODEL_URL) throw new Error("No local browser model is configured for this build.");
  const resolved = new URL(MODEL_URL, window.location.origin);
  if (resolved.origin !== window.location.origin) {
    throw new Error("The browser-local model must be served from the same approved app origin.");
  }
  return resolved.toString();
}

export async function qualifyBrowserLocalAi(capabilities: DeviceCapabilities): Promise<void> {
  const output = await runBrowserLocalChat({ ...capabilities, localAiReady: true }, "Reply with the single word READY.");
  if (!output.trim()) throw new Error("The local model returned no text.");
}

export type BrowserChatOptions = { systemPrompt?: string; maxTokens?: number; temperature?: number };

export async function runBrowserLocalChat(capabilities: DeviceCapabilities, message: string, options: BrowserChatOptions = {}): Promise<string> {
  if (!MODEL_URL) throw new Error("No local browser model is configured for this build.");
  if (!capabilities.runtimeSmoke || !capabilities.indexedDb || !capabilities.webCrypto) throw new Error("This browser did not pass the local runtime readiness check.");
  const runtime = createRuntime();
  try {
    const profile = selectLocalAiProfile(capabilities, { forceWasm: shouldUseConservativeWasmProfile() });
    if (profile.id === "unavailable") throw new Error("No compatible local AI profile is available on this device.");
    const loadOptions = {
      n_ctx: profile.nCtx,
      n_threads: profile.nThreads,
      n_gpu_layers: profile.nGpuLayers,
    };
    if (capabilities.opfs === false) {
      await runtime.loadModel([await modelBlobForIndexedDbFallback()], loadOptions);
    } else {
      await runtime.loadModelFromUrl(resolvedSameOriginModelUrl(), { ...loadOptions, useCache: true });
    }
    const response = await runtime.createChatCompletion({
      messages: [
        { role: "system", content: options.systemPrompt ?? "Answer briefly and accurately. Do not invent personal facts." },
        { role: "user", content: message },
      ],
      max_tokens: options.maxTokens ?? 48,
      temperature: options.temperature ?? 0,
    });
    return response.choices[0]?.message?.content?.trim() || "";
  } finally { await runtime.exit().catch(() => undefined); }
}
