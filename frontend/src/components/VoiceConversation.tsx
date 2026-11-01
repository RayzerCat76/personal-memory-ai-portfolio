"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { activePersona, detectPersonaLocale } from "@/lib/persona";
import { buildVoiceRenderPrompt, type VoiceLang } from "@/lib/voice-system-prompt";
import { comparableSpeechText } from "@/lib/voice-pipeline";
import { useUiLocale } from "@/lib/ui-locale";

type VoiceState = "idle" | "recording" | "understanding" | "speaking" | "error";
type VoiceRuntime = { configured: boolean; ready: boolean; wsBase?: string; asrReady: boolean };
type RefAudio = { base64: string; sampleRate: number; samples: number };
export type VoiceSpeakRequest = { id: number; text: string };

type Props = {
  disabled?: boolean;
  onVoiceText: (text: string) => void | Promise<void>;
  speakRequest?: VoiceSpeakRequest | null;
  onNotice?: (message: string) => void;
};

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const RESPONSE_IDLE_TIMEOUT_MS = 120000;
function float32ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + stride, bytes.length)));
  return btoa(binary);
}
function base64ToFloat32(value: string): Float32Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return merged;
}
function resampleMono(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const outputLength = Math.max(1, Math.round(input.length * toRate / fromRate));
  const output = new Float32Array(outputLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}
export default function VoiceConversation({ disabled = false, onVoiceText, speakRequest = null, onNotice }: Props) {
  const { t } = useUiLocale();
  const [runtime, setRuntime] = useState<VoiceRuntime | null>(null);
  const [state, setState] = useState<VoiceState>("idle");
  const [status, setStatus] = useState("");
  const inputContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const recordedChunksRef = useRef<Float32Array[]>([]);
  const inputRateRef = useRef(INPUT_RATE);
  const lastSpeakIdRef = useRef<number | null>(null);

  const refreshRuntime = useCallback(async () => {
    try {
      const [voiceResponse, asrResponse] = await Promise.all([
        fetch("/api/local-voice/status", { cache: "no-store" }),
        fetch("/api/local-asr/status", { cache: "no-store" }),
      ]);
      if (!voiceResponse.ok || !asrResponse.ok) throw new Error("Local speech status unavailable.");
      const voice = await voiceResponse.json() as Omit<VoiceRuntime, "asrReady">;
      const asr = await asrResponse.json() as { ready?: boolean };
      setRuntime({ ...voice, asrReady: asr.ready === true });
    } catch { setRuntime({ configured: false, ready: false, asrReady: false }); }
  }, []);

  function stopCapture() {
    processorRef.current?.disconnect(); sourceRef.current?.disconnect(); gainRef.current?.disconnect();
    processorRef.current = null; sourceRef.current = null; gainRef.current = null;
    mediaRef.current?.getTracks().forEach(track => track.stop()); mediaRef.current = null;
    void inputContextRef.current?.close(); inputContextRef.current = null;
  }

  async function playAudioChunks(chunks: Float32Array[]): Promise<void> {
    const samples = concatFloat32(chunks.filter(chunk => chunk.length));
    if (!samples.length) return;
    let context = outputContextRef.current;
    if (!context || context.state === "closed") { context = new AudioContext(); outputContextRef.current = context; }
    if (context.state === "suspended") {
      await Promise.race([
        context.resume(),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Local audio playback could not start.")), 3000)),
      ]);
    }
    const buffer = context.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    const expectedMs = Math.ceil(samples.length / OUTPUT_RATE * 1000);
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; window.clearTimeout(watchdog); resolve(); };
      const watchdog = window.setTimeout(finish, Math.max(1500, expectedMs + 2000));
      source.onended = finish;
      try { source.start(); }
      catch (error) { window.clearTimeout(watchdog); finished = true; reject(error); }
    });
  }

  async function openSession(wsBase: string, systemPrompt: string, refAudio?: RefAudio, useTts = true): Promise<WebSocket> {
    return await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/backend`);
      let created = false;
      const timeout = window.setTimeout(() => { if (!created) { ws.close(); reject(new Error("Local speech engine took too long to prepare.")); } }, 45000);
      ws.onopen = () => ws.send(JSON.stringify({
        type: "session.init",
        payload: {
          mode: "turn_based",
          use_tts: useTts,
          ...(refAudio ? { voice: { ref_audio: refAudio.base64, tts_ref_audio: refAudio.base64 } } : {}),
          system_prompt: systemPrompt,
          config: useTts
            ? { temperature: 0.4, top_p: 0.85, top_k: 30 }
            : { temperature: 0, top_p: 0.8, top_k: 20 },
        },
      }));
      ws.onmessage = event => {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        if (msg.type === "session.created") { created = true; window.clearTimeout(timeout); resolve(ws); }
        else if (msg.type === "session.closed" && !created) { window.clearTimeout(timeout); reject(new Error("Local speech session could not start.")); }
      };
      ws.onerror = () => { window.clearTimeout(timeout); if (!created) reject(new Error("Local speech engine connection failed.")); };
      ws.onclose = () => { window.clearTimeout(timeout); if (!created) reject(new Error("Local speech engine closed before it was ready.")); };
    });
  }

  async function runTurn(ws: WebSocket, content: Array<{ type: "audio"; data: string } | { type: "text"; text: string }> | { type: "audio"; data: string } | { type: "text"; text: string }, speak: boolean) {
    return await new Promise<{ text: string; audio: Float32Array[] }>((resolve, reject) => {
      let timeout = 0;
      let text = "";
      const audio: Float32Array[] = [];
      const armTimeout = () => {
        window.clearTimeout(timeout);
        timeout = window.setTimeout(() => { cleanup(); reject(new Error("The local speech response stopped making progress.")); }, RESPONSE_IDLE_TIMEOUT_MS);
      };
      const cleanup = () => { window.clearTimeout(timeout); ws.removeEventListener("message", onMessage); ws.removeEventListener("close", onClose); };
      const onClose = () => { cleanup(); reject(new Error("The local speech engine disconnected.")); };
      const onMessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        if (msg.type === "response.output.delta" && msg.kind === "text") {
          armTimeout(); const fragment = typeof msg.text === "string" ? msg.text : ""; if (fragment) text += fragment;
        } else if (msg.type === "response.output.delta" && msg.kind === "audio") {
          armTimeout(); const data = typeof msg.audio === "string" ? msg.audio : ""; if (data) audio.push(base64ToFloat32(data));
        } else if (msg.type === "response.done") {
          cleanup();
          const finalText = typeof msg.text === "string" && msg.text ? msg.text : text;
          const finalAudio = typeof msg.audio === "string" ? msg.audio : ""; if (finalAudio && !audio.length) audio.push(base64ToFloat32(finalAudio));
          resolve({ text: finalText, audio });
        } else if (msg.type === "session.closed") { cleanup(); reject(new Error("The local speech session ended unexpectedly.")); }
      };
      ws.addEventListener("message", onMessage); ws.addEventListener("close", onClose); armTimeout();
      ws.send(JSON.stringify({
        type: "input.append",
        input: {
          messages: [{ role: "user", content: Array.isArray(content) ? content : [content] }],
          streaming: true,
          generation: { max_new_tokens: speak ? 256 : 128, length_penalty: 1.0 },
          tts: { enabled: speak },
          use_tts_template: speak,
          omni_mode: false,
          enable_thinking: false,
        },
      }));
    });
  }

  async function fetchPersonaRef(language: VoiceLang): Promise<RefAudio> {
    const persona = activePersona();
    const response = await fetch(`/api/local-voice/ref-audio?lang=${language}&persona=${encodeURIComponent(persona.id)}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({})) as Partial<RefAudio> & { error?: unknown };
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Local reference voice is unavailable.");
    if (body.sampleRate !== INPUT_RATE || !body.base64 || typeof body.samples !== "number") throw new Error("Local reference voice is invalid.");
    return body as RefAudio;
  }

  async function understandAudio(samples: Float32Array): Promise<{ text: string; language: VoiceLang }> {
    const response = await fetch("/api/local-asr/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64: float32ToBase64(samples), sampleRate: INPUT_RATE }),
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({})) as { text?: unknown; language?: unknown; error?: unknown };
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Local speech recognition failed.");
    if (typeof body.text !== "string" || (body.language !== "en" && body.language !== "zh")) throw new Error("Local speech recognition returned an invalid result.");
    return { text: body.text, language: body.language };
  }

  async function speakApprovedAnswer(answer: string): Promise<void> {
    const prepareResponse = await fetch("/api/local-voice/prepare", { method: "POST", cache: "no-store" });
    const prepared = await prepareResponse.json().catch(() => ({})) as { wsBase?: unknown; error?: unknown };
    if (!prepareResponse.ok || typeof prepared.wsBase !== "string") throw new Error(typeof prepared.error === "string" ? prepared.error : "Local speech engine could not start.");
    const language = detectPersonaLocale(answer);
    const persona = activePersona();
    const refAudio = await fetchPersonaRef(language);
    const ws = await openSession(prepared.wsBase, buildVoiceRenderPrompt(persona.id, language), refAudio);
    let releasePromise: Promise<Response> | null = null;
    try {
      const result = await runTurn(ws, { type: "text", text: answer }, true);
      if (comparableSpeechText(result.text) !== comparableSpeechText(answer)) throw new Error("Voice rendering changed the approved answer, so audio was not played.");
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      releasePromise = fetch("/api/local-voice/release", { method: "POST", cache: "no-store" });
      await playAudioChunks(result.audio);
    } finally {
      if (ws.readyState < WebSocket.CLOSING) ws.close();
      releasePromise ??= fetch("/api/local-voice/release", { method: "POST", cache: "no-store" });
      await releasePromise.catch(() => undefined);
      void refreshRuntime();
    }
  }

  async function startRecording() {
    onNotice?.(""); setStatus(""); recordedChunksRef.current = [];
    const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const context = new AudioContext(); const source = context.createMediaStreamSource(media); const processor = context.createScriptProcessor(4096, 1, 1); const gain = context.createGain(); gain.gain.value = 0;
    processor.onaudioprocess = event => recordedChunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(processor); processor.connect(gain); gain.connect(context.destination);
    mediaRef.current = media; inputContextRef.current = context; sourceRef.current = source; processorRef.current = processor; gainRef.current = gain; inputRateRef.current = context.sampleRate;
    setState("recording"); setStatus(t("Recording locally", "正在本地录音"));
  }

  async function finishRecording() {
    const chunks = recordedChunksRef.current; const fromRate = inputRateRef.current; stopCapture();
    const captured = concatFloat32(chunks); recordedChunksRef.current = [];
    if (captured.length < fromRate * 0.15) { setState("idle"); setStatus(""); onNotice?.(t("That recording was too short. Try again.", "录音太短，请再试一次。")); return; }
    setState("understanding"); setStatus(t("Understanding speech locally…", "正在本地识别语音…"));
    try {
      const understood = await understandAudio(resampleMono(captured, fromRate, INPUT_RATE));
      setStatus(`${t("Heard", "已听到")} (${understood.language.toUpperCase()}): ${understood.text}`); setState("idle"); await onVoiceText(understood.text);
    } catch (error) {
      setState("error"); const message = error instanceof Error ? error.message : t("Local speech understanding failed.", "本地语音识别失败。"); setStatus(message); onNotice?.(message); void refreshRuntime();
    }
  }

  useEffect(() => {
    void refreshRuntime(); const timer = window.setInterval(() => { void refreshRuntime(); }, 5000); return () => window.clearInterval(timer);
  }, [refreshRuntime]);

  useEffect(() => {
    if (!speakRequest || speakRequest.id === lastSpeakIdRef.current || !runtime?.configured) return;
    lastSpeakIdRef.current = speakRequest.id;
    setState("speaking"); setStatus(t("Rendering approved reply locally…", "正在本地生成语音回复…"));
    void speakApprovedAnswer(speakRequest.text).then(() => { setState("idle"); setStatus(t("Reply spoken", "语音回复已播放")); }).catch(error => {
      setState("error"); const message = error instanceof Error ? error.message : t("Local voice output failed.", "本地语音输出失败。"); setStatus(message); onNotice?.(message); void refreshRuntime();
    });
  }, [speakRequest, runtime?.ready]);

  useEffect(() => () => { stopCapture(); void outputContextRef.current?.close(); outputContextRef.current = null; }, []);

  if (!runtime?.configured && !runtime?.asrReady) return null;
  const busy = disabled || state === "understanding" || state === "speaking";
  const inputReady = runtime?.asrReady === true;
  const buttonLabel = state === "recording" ? t("Send voice", "发送语音") : state === "understanding" ? t("Listening…", "识别中…") : state === "speaking" ? t("Speaking…", "播放中…") : t("Talk", "语音");
  return <div className="askVoiceControl">
    <button type="button" disabled={!inputReady || busy} onClick={() => {
      if (state === "recording") void finishRecording();
      else void startRecording().catch(error => { const message = error instanceof Error ? error.message : t("Microphone access failed.", "无法访问麦克风。"); setState("error"); setStatus(message); onNotice?.(message); });
    }}>{buttonLabel}</button>
    <span className={`askVoiceStatus askVoiceStatus-${state}`} aria-live="polite">{!inputReady ? t("Mic starting…", "麦克风启动中…") : status || (runtime?.ready ? t("Text or voice · EN/中文 auto", "文字或语音 · 自动识别中英文") : t("Voice input ready · speech output starts on demand", "语音输入已就绪 · 语音输出按需启动"))}</span>
  </div>;
}
