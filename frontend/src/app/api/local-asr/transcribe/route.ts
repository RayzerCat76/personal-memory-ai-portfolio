import { NextResponse } from "next/server";
import { transcribeLocalPcm } from "@/lib/local-asr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { base64?: unknown; sampleRate?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "Invalid local ASR request." }, { status: 400 }); }
  if (typeof body.base64 !== "string" || body.base64.length > 6 * 1024 * 1024 || body.sampleRate !== 16000) {
    return NextResponse.json({ error: "Invalid microphone audio." }, { status: 400 });
  }
  try { return NextResponse.json(await transcribeLocalPcm(body.base64, 16000)); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Local speech recognition failed.";
    return NextResponse.json({ error: message }, { status: message.includes("not ready") ? 503 : 422 });
  }
}
