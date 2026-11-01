import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

export type ManagedVoiceConfig = {
  server: string;
  model: string;
  cwd: string;
  wsBase: string;
};

type ManagedVoiceState = {
  pid: number | null;
  lock: Promise<void>;
};

const stateKey = "__personalMemoryManagedVoiceRuntimeV1";

function managedState(): ManagedVoiceState {
  const root = globalThis as typeof globalThis & { [stateKey]?: ManagedVoiceState };
  if (!root[stateKey]) {
    const initial = Number(process.env.PMA_VOICE_SERVER_PID || "");
    root[stateKey] = { pid: Number.isInteger(initial) && initial > 1 ? initial : null, lock: Promise.resolve() };
  }
  return root[stateKey]!;
}
function managedConfig(): ManagedVoiceConfig | null {
  if (process.env.PMA_VOICE_MANAGED !== "1") return null;
  const server = process.env.PMA_VOICE_SERVER_BIN?.trim();
  const model = process.env.PMA_VOICE_MODEL_FILE?.trim();
  const cwd = process.env.PMA_VOICE_SERVER_CWD?.trim();
  const wsBase = process.env.PMA_VOICE_WS_BASE?.trim() || "ws://127.0.0.1:22710";
  if (!server || !model || !cwd || !/^ws:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(wsBase)) return null;
  return { server, model, cwd, wsBase };
}

async function voiceHealthy(config: ManagedVoiceConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.wsBase.replace(/^ws:/, "http:")}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { status?: string; engine?: string };
    return body.status === "ok" && body.engine === "comni";
  } catch { return false; }
}

async function waitForVoice(config: ManagedVoiceConfig, ready: boolean, attempts = 60): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await voiceHealthy(config)) === ready) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function releaseManagedVoice(config: ManagedVoiceConfig, state: ManagedVoiceState): Promise<void> {
  const pid = state.pid;
  if (!pid) {
    if (await voiceHealthy(config)) throw new Error("The managed local speech runtime is active but its process identity is unavailable.");
    return;
  }
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!pidAlive(pid) && !(await voiceHealthy(config))) { state.pid = null; return; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("The local speech runtime did not stop cleanly.");
}

async function ensureManagedVoice(config: ManagedVoiceConfig, state: ManagedVoiceState): Promise<void> {
  if (await voiceHealthy(config)) return;
  await Promise.all([access(config.server), access(config.model)]);
  const child = spawn(config.server, [
    "--host", "127.0.0.1", "--port", "22710",
    "--model", config.model, "--ctx-size", "1024",
    "--n-gpu-layers", "99", "--temp", "0.55",
  ], { cwd: config.cwd, env: { ...process.env }, detached: true, stdio: "ignore" });
  child.unref();
  if (!child.pid) throw new Error("The local speech runtime could not restart.");
  state.pid = child.pid;
  if (!(await waitForVoice(config, true, 100))) {
    try { process.kill(child.pid, "SIGTERM"); } catch { /* already stopped */ }
    state.pid = null;
    throw new Error("The local speech runtime did not become ready.");
  }
}
async function withManagedLock<T>(work: () => Promise<T>): Promise<T> {
  const state = managedState();
  const previous = state.lock;
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  state.lock = previous.then(() => current);
  await previous;
  try { return await work(); }
  finally { release(); }
}

export async function withVoiceRuntimeReleasedForAsr<T>(work: () => Promise<T>): Promise<T> {
  const config = managedConfig();
  if (!config) return work();
  return withManagedLock(async () => {
    await releaseManagedVoice(config, managedState());
    return work();
  });
}

export async function prepareManagedVoiceRuntime(): Promise<{ managed: boolean; wsBase: string | null }> {
  const config = managedConfig();
  if (!config) return { managed: false, wsBase: process.env.PMA_VOICE_WS_BASE?.trim() || null };
  return withManagedLock(async () => {
    await ensureManagedVoice(config, managedState());
    return { managed: true, wsBase: config.wsBase };
  });
}

export async function releaseManagedVoiceRuntime(): Promise<{ managed: boolean }> {
  const config = managedConfig();
  if (!config) return { managed: false };
  return withManagedLock(async () => {
    await releaseManagedVoice(config, managedState());
    return { managed: true };
  });
}
