import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { withVoiceRuntimeReleasedForAsr } from "@/lib/local-voice-runtime-server";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MODEL_NAME = "Qwen3-ASR-0.6B-Q8_0.gguf";
const MMPROJ_NAME = "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf";
const HF_ROOT = path.join(homedir(), ".cache", "huggingface", "hub", "models--ggml-org--Qwen3-ASR-0.6B-GGUF", "snapshots");

export type LocalAsrRuntime = { cli: string; model: string; mmproj: string };

async function findCachedFile(name: string): Promise<string | null> {
  try {
    const revisions = await readdir(HF_ROOT);
    for (const revision of revisions.sort().reverse()) {
      const candidate = path.join(HF_ROOT, revision, name);
      try { await access(candidate); return candidate; } catch { /* continue */ }
    }
  } catch { /* no cache */ }
  return null;
}

export async function resolveLocalAsrRuntime(): Promise<LocalAsrRuntime | null> {
  const cli = process.env.PMA_ASR_CLI?.trim() || "/opt/homebrew/bin/llama-cli";
  const model = process.env.PMA_ASR_MODEL?.trim() || await findCachedFile(MODEL_NAME);
  const mmproj = process.env.PMA_ASR_MMPROJ?.trim() || await findCachedFile(MMPROJ_NAME);
  if (!model || !mmproj) return null;
  try { await Promise.all([access(cli), access(model), access(mmproj)]); }
  catch { return null; }
  return { cli, model, mmproj };
}

function float32ToPcm16Wav(raw: Buffer, sampleRate: number): Buffer {
  if (raw.length % 4 !== 0) throw new Error("Invalid microphone audio.");
  const samples = raw.length / 4;
  const dataSize = samples * 2;
  const out = Buffer.allocUnsafe(44 + dataSize);
  out.write("RIFF", 0); out.writeUInt32LE(36 + dataSize, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.max(-1, Math.min(1, raw.readFloatLE(i * 4)));
    out.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return out;
}

async function transcribeLocalPcmUnmanaged(base64: string, sampleRate: number): Promise<{ text: string; language: "en" | "zh" }> {
  if (sampleRate !== 16000) throw new Error("Local ASR expects 16 kHz mono audio.");
  const raw = Buffer.from(base64, "base64");
  if (raw.length < 1600 || raw.length > 4 * 1024 * 1024) throw new Error("Microphone audio is outside the supported length.");
  const runtime = await resolveLocalAsrRuntime();
  if (!runtime) throw new Error("Local speech recognition is not ready.");
  const dir = await mkdtemp(path.join(tmpdir(), "pma-asr-"));
  const wav = path.join(dir, "input.wav");
  try {
    await writeFile(wav, float32ToPcm16Wav(raw, sampleRate));
    const childEnv = { ...process.env };
    const asrLibPath = process.env.PMA_ASR_DYLD_LIBRARY_PATH?.trim();
    if (asrLibPath) childEnv.DYLD_LIBRARY_PATH = asrLibPath;
    const args = [
      "-m", runtime.model, "--mmproj", runtime.mmproj, "--audio", wav,
      "-p", "Transcribe audio to text", "-n", "128", "--no-display-prompt", "--single-turn", "--simple-io",
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { stdout, stderr } = await execFileAsync(runtime.cli, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: childEnv });
      const output = `${stdout}\n${stderr}`;
      const match = output.match(/language\s+(English|Chinese)\s*<asr_text>([^\r\n]+)/i);
      if (!match) continue;
      const text = match[2].trim();
      if (!text || text.length > 4000) continue;
      return { text, language: match[1].toLowerCase() === "chinese" ? "zh" : "en" };
    }
    throw new Error("Local speech recognition returned no usable transcript.");
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function transcribeLocalPcm(base64: string, sampleRate: number): Promise<{ text: string; language: "en" | "zh" }> {
  return withVoiceRuntimeReleasedForAsr(() => transcribeLocalPcmUnmanaged(base64, sampleRate));
}
