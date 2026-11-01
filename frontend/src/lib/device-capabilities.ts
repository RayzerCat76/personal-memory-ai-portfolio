export type LocalAiMode = "webgpu" | "wasm" | "unavailable";
export type LocalAiProfileId = "webgpu-balanced" | "webgpu-constrained" | "wasm-balanced" | "wasm-constrained" | "unavailable";

export type LocalAiProfile = { id: LocalAiProfileId; nCtx: number; nThreads: number; nGpuLayers: number };

export type DeviceCapabilities = {
  checkedAt: string;
  secureContext: boolean;
  indexedDb: boolean;
  webCrypto: boolean;
  cacheStorage: boolean;
  opfs: boolean;
  serviceWorker: boolean;
  webAssembly: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
  webGpu: boolean;
  storageQuotaBytes: number | null;
  storageUsageBytes: number | null;
  persistentStorage: boolean | null;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  runtimeSmoke: boolean;
  runtimeError: string | null;
  modelConfigured: boolean;
  modelInference: boolean | null;
  modelError: string | null;
  aiMode: LocalAiMode;
  localAiProfile: LocalAiProfileId;
  localAiReady: boolean;
};

export const DEVICE_CAPABILITIES_KEY = "personal-memory-ai-device-capabilities-v2";

export function selectLocalAiProfile(
  capabilities: Pick<DeviceCapabilities, "runtimeSmoke" | "indexedDb" | "webCrypto" | "cacheStorage" | "webGpu" | "hardwareConcurrency" | "deviceMemoryGb">,
  options: { forceWasm?: boolean } = {},
): LocalAiProfile {
  if (!capabilities.runtimeSmoke || !capabilities.indexedDb || !capabilities.webCrypto || !capabilities.cacheStorage) {
    return { id: "unavailable", nCtx: 0, nThreads: 0, nGpuLayers: 0 };
  }
  const constrained = (capabilities.deviceMemoryGb != null && capabilities.deviceMemoryGb <= 4)
    || (capabilities.hardwareConcurrency != null && capabilities.hardwareConcurrency <= 4);
  const nThreads = Math.max(1, Math.min(capabilities.hardwareConcurrency ?? 2, constrained ? 2 : 4));
  if (capabilities.webGpu && !options.forceWasm) {
    return { id: constrained ? "webgpu-constrained" : "webgpu-balanced", nCtx: constrained ? 1024 : 2048, nThreads, nGpuLayers: 99999 };
  }
  return { id: constrained ? "wasm-constrained" : "wasm-balanced", nCtx: constrained ? 1024 : 2048, nThreads, nGpuLayers: 0 };
}

export function shouldUseConservativeWasmProfile(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /AppleWebKit/i.test(ua) && !/(Chrome|Chromium|Edg|OPR|Android)/i.test(ua);
}

async function probeIndexedDb(): Promise<boolean> {
  if (!("indexedDB" in globalThis)) return false;
  return new Promise(resolve => {
    const name = `pmai-capability-${crypto.randomUUID()}`;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("probe");
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("probe", "readwrite");
      tx.objectStore("probe").put("ok", "key");
      tx.oncomplete = () => {
        db.close();
        const check = indexedDB.open(name);
        check.onsuccess = () => {
          const checkDb = check.result;
          const read = checkDb.transaction("probe").objectStore("probe").get("key");
          read.onsuccess = () => { const ok = read.result === "ok"; checkDb.close(); indexedDB.deleteDatabase(name); resolve(ok); };
          read.onerror = () => { checkDb.close(); indexedDB.deleteDatabase(name); resolve(false); };
        };
        check.onerror = () => resolve(false);
      };
      tx.onerror = () => { db.close(); indexedDB.deleteDatabase(name); resolve(false); };
    };
  });
}

async function probeWebCrypto(): Promise<boolean> {
  try {
    if (!crypto?.subtle) return false;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const input = new TextEncoder().encode("pmai-capability");
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, input);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
    return new TextDecoder().decode(decrypted) === "pmai-capability";
  } catch { return false; }
}

async function probeCacheStorage(): Promise<boolean> {
  try {
    if (!("caches" in globalThis)) return false;
    const name = `pmai-capability-${crypto.randomUUID()}`;
    const cache = await caches.open(name);
    const request = new Request(`${location.origin}/__pmai_capability_probe__`);
    await cache.put(request, new Response("ok"));
    const hit = await cache.match(request);
    await caches.delete(name);
    return (await hit?.text()) === "ok";
  } catch { return false; }
}

async function probeOpfs(): Promise<boolean> {
  try {
    const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    if (!storage?.getDirectory) return false;
    const root = await storage.getDirectory();
    const name = `pmai-capability-${crypto.randomUUID()}`;
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array([1, 2, 3]));
    await writable.close();
    const file = await handle.getFile();
    await root.removeEntry(name);
    return file.size === 3;
  } catch { return false; }
}

async function probeWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch { return false; }
}

export async function readStoredCapabilities(): Promise<DeviceCapabilities | null> {
  try {
    const raw = localStorage.getItem(DEVICE_CAPABILITIES_KEY);
    return raw ? JSON.parse(raw) as DeviceCapabilities : null;
  } catch { return null; }
}

export async function probeDeviceCapabilities(
  runtimeSmoke: () => Promise<void>,
  modelConfigured: boolean,
  modelSmoke?: (capabilities: DeviceCapabilities) => Promise<void>,
): Promise<DeviceCapabilities> {
  const [indexedDb, webCrypto, cacheStorage, opfs, webGpu] = await Promise.all([
    probeIndexedDb(), probeWebCrypto(), probeCacheStorage(), probeOpfs(), probeWebGpu(),
  ]);
  let storageQuotaBytes: number | null = null;
  let storageUsageBytes: number | null = null;
  let persistentStorage: boolean | null = null;
  try {
    const estimate = await navigator.storage?.estimate?.();
    storageQuotaBytes = estimate?.quota ?? null;
    storageUsageBytes = estimate?.usage ?? null;
    persistentStorage = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  } catch { /* capability remains unknown */ }

  let runtimeOk = false; let runtimeError: string | null = null;
  if (typeof WebAssembly !== "undefined") {
    try { await runtimeSmoke(); runtimeOk = true; }
    catch (error) { runtimeError = error instanceof Error ? error.message : "Local AI runtime failed."; }
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  const forceWasm = shouldUseConservativeWasmProfile();
  const aiMode: LocalAiMode = runtimeOk ? (webGpu && !forceWasm ? "webgpu" : "wasm") : "unavailable";
  const result: DeviceCapabilities = {
    checkedAt: new Date().toISOString(), secureContext: globalThis.isSecureContext,
    indexedDb, webCrypto, cacheStorage, opfs, serviceWorker: "serviceWorker" in navigator,
    webAssembly: typeof WebAssembly !== "undefined",
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    webGpu, storageQuotaBytes, storageUsageBytes, persistentStorage,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemoryGb: nav.deviceMemory ?? null,
    runtimeSmoke: runtimeOk, runtimeError, modelConfigured, modelInference: null, modelError: null, aiMode,
    localAiProfile: "unavailable", localAiReady: false,
  };
  result.localAiProfile = selectLocalAiProfile(result, { forceWasm }).id;
  if (modelConfigured && runtimeOk && modelSmoke) {
    try { await modelSmoke(result); result.modelInference = true; }
    catch (error) { result.modelInference = false; result.modelError = error instanceof Error ? error.message : "Local model inference failed."; }
  }
  result.localAiReady = indexedDb && webCrypto && cacheStorage && runtimeOk && result.modelInference === true;
  try { localStorage.setItem(DEVICE_CAPABILITIES_KEY, JSON.stringify(result)); } catch { /* non-fatal */ }
  return result;
}
