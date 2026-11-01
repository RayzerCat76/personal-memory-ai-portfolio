import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(ROOT, "app");
const ORIGIN = "http://127.0.0.1:13013";
const MANIFEST = `${ORIGIN}/manifest.webmanifest`;
const VOICE_DIR = path.join(ROOT, "voice");
const VOICE_MODEL = path.join(VOICE_DIR, "model");
const VOICE_MODEL_FILE = path.join(VOICE_MODEL, "MiniCPM-o-4_5-Q4_K_M.gguf");
const VOICE_NATIVE_DIR = path.join(VOICE_DIR, "native");
const VOICE_NATIVE_SERVER = path.join(VOICE_NATIVE_DIR, "llama-omni-server");
const VOICE_REF_EN = path.join(VOICE_DIR, "ref-en.f32");
const VOICE_REF_ZH = path.join(VOICE_DIR, "ref-zh.f32");
const VOICE_REF_MARCH7_EN = path.join(VOICE_DIR, "personas", "march7-en.f32");
const VOICE_REF_MARCH7_ZH = path.join(VOICE_DIR, "personas", "march7-zh.f32");
const VOICE_REF_FURINA_EN = path.join(VOICE_DIR, "personas", "furina-en.f32");
const VOICE_REF_FURINA_ZH = path.join(VOICE_DIR, "personas", "furina-zh.f32");
const VOICE_REF_AMIYA_EN = path.join(VOICE_DIR, "personas", "amiya-en.f32");
const VOICE_REF_AMIYA_ZH = path.join(VOICE_DIR, "personas", "amiya-zh.f32");
const ASR_DIR = path.join(ROOT, "asr");
const ASR_RUNTIME_DIR = path.join(ASR_DIR, "runtime");
const ASR_CLI = path.join(ASR_RUNTIME_DIR, "llama-cli");
const ASR_MODEL = path.join(ASR_DIR, "model", "Qwen3-ASR-0.6B-Q8_0.gguf");
const ASR_MMPROJ = path.join(ASR_DIR, "model", "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf");

async function probe() {
  try {
    const response = await fetch(MANIFEST, { signal: AbortSignal.timeout(900), cache: "no-store" });
    if (!response.ok) return "wrong";
    const text = await response.text();
    return text.includes("Personal Memory") ? "ready" : "wrong";
  } catch { return "down"; }
}

async function voiceHealthy() {
  try {
    const response = await fetch("http://127.0.0.1:22710/health", {
      signal: AbortSignal.timeout(1000), cache: "no-store",
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === "ok" && body?.engine === "comni";
  } catch { return false; }
}

function detached(command, args, options = {}) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", ...options });
  child.unref();
  return child;
}

function voiceAssetsPresent() {
  return [VOICE_NATIVE_SERVER, VOICE_MODEL_FILE, VOICE_REF_EN, VOICE_REF_ZH].every(existsSync);
}

function asrAssetsPresent() {
  return [ASR_CLI, ASR_MODEL, ASR_MMPROJ].every(existsSync);
}

function prepareAsr() {
  if (process.platform !== "darwin" || process.arch !== "arm64" || !asrAssetsPresent()) return {};
  return {
    PMA_ASR_CLI: ASR_CLI,
    PMA_ASR_MODEL: ASR_MODEL,
    PMA_ASR_MMPROJ: ASR_MMPROJ,
  };
}

async function prepareVoice() {
  if (process.platform !== "darwin" || process.arch !== "arm64" || !voiceAssetsPresent()) return {};
  const externalVoiceReady = await voiceHealthy();
  return {
    PMA_VOICE_WS_BASE: "ws://127.0.0.1:22710",
    PMA_VOICE_MANAGED: externalVoiceReady ? "0" : "1",
    PMA_VOICE_SERVER_PID: "",
    PMA_VOICE_SERVER_BIN: VOICE_NATIVE_SERVER,
    PMA_VOICE_MODEL_FILE: VOICE_MODEL_FILE,
    PMA_VOICE_SERVER_CWD: VOICE_DIR,
    PMA_VOICE_PROTOCOL: "native-backend-v1",
    PMA_VOICE_REF_AUDIO_EN_F32: VOICE_REF_EN,
    PMA_VOICE_REF_AUDIO_ZH_F32: VOICE_REF_ZH,
    ...(existsSync(VOICE_REF_MARCH7_EN) && existsSync(VOICE_REF_MARCH7_ZH) ? {
      PMA_VOICE_REF_MARCH7_EN_F32: VOICE_REF_MARCH7_EN,
      PMA_VOICE_REF_MARCH7_ZH_F32: VOICE_REF_MARCH7_ZH,
    } : {}),
    ...(existsSync(VOICE_REF_FURINA_EN) && existsSync(VOICE_REF_FURINA_ZH) ? {
      PMA_VOICE_REF_FURINA_EN_F32: VOICE_REF_FURINA_EN,
      PMA_VOICE_REF_FURINA_ZH_F32: VOICE_REF_FURINA_ZH,
    } : {}),
    ...(existsSync(VOICE_REF_AMIYA_EN) && existsSync(VOICE_REF_AMIYA_ZH) ? {
      PMA_VOICE_REF_AMIYA_EN_F32: VOICE_REF_AMIYA_EN,
      PMA_VOICE_REF_AMIYA_ZH_F32: VOICE_REF_AMIYA_ZH,
    } : {}),
  };
}

function showError(message) {
  if (process.platform === "darwin") {
    detached("osascript", ["-e", `display alert \"Personal Memory AI\" message ${JSON.stringify(message)}`]);
  } else if (process.platform === "win32") {
    const escaped = message.replaceAll("'", "''");
    detached("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName PresentationFramework;[System.Windows.MessageBox]::Show('${escaped}','Personal Memory AI')`]);
  } else console.error(message);
}
function openBrowser() {
  if (process.platform === "darwin") detached("open", [ORIGIN]);
  else if (process.platform === "win32") detached("cmd.exe", ["/c", "start", "", ORIGIN]);
  else detached("xdg-open", [ORIGIN]);
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await probe() === "ready") return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  const voiceEnv = await prepareVoice();
  const asrEnv = prepareAsr();
  const initial = await probe();
  if (initial === "wrong") throw new Error("Port 13013 is already being used by another app. Close that app and try again.");
  if (initial !== "ready") {
    const server = spawn(process.execPath, ["server.js"], {
      cwd: APP_DIR,
      env: { ...process.env, ...voiceEnv, ...asrEnv, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: "13013" },
      detached: true,
      stdio: "ignore",
    });
    server.unref();
    if (!(await waitUntilReady())) throw new Error("The local app could not start. Restart the computer and try again.");
  }
  openBrowser();
}
main().catch(error => {
  showError(error instanceof Error ? error.message : "The local app could not start.");
  process.exitCode = 1;
});
