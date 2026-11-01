import { access } from "node:fs/promises";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function localWsBase(): string | null {
  const value = process.env.PMA_VOICE_WS_BASE?.trim() || "ws://127.0.0.1:22710";
  return /^ws:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(value) ? value : null;
}

export async function GET() {
  const enRef = process.env.PMA_VOICE_REF_AUDIO_EN_F32?.trim() || process.env.PMA_VOICE_REF_AUDIO_F32?.trim();
  const zhRef = process.env.PMA_VOICE_REF_AUDIO_ZH_F32?.trim() || process.env.PMA_VOICE_REF_AUDIO_F32?.trim();
  const wsBase = localWsBase();
  if (!enRef || !zhRef || !wsBase) return NextResponse.json({ configured: false, ready: false });
  try { await Promise.all([access(enRef), access(zhRef)]); } catch { return NextResponse.json({ configured: false, ready: false }); }
  const healthUrl = `${wsBase.replace(/^ws:/, "http:")}/health`;
  try {
    const response = await fetch(healthUrl, { cache: "no-store", signal: AbortSignal.timeout(1200) });
    const body = response.ok ? await response.json() as { status?: string; model_loaded?: boolean; engine?: string } : {};
    const nativeReady = body.status === "ok" && body.engine === "comni";
    const legacyReady = body.status === "healthy" && body.model_loaded === true;
    return NextResponse.json({ configured: true, ready: response.ok && (nativeReady || legacyReady), wsBase });
  } catch {
    return NextResponse.json({ configured: true, ready: false, wsBase });
  }
}
