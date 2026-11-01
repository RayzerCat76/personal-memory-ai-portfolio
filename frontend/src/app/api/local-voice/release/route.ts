import { NextResponse } from "next/server";
import { releaseManagedVoiceRuntime } from "@/lib/local-voice-runtime-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try { return NextResponse.json(await releaseManagedVoiceRuntime()); }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Local speech runtime could not stop." }, { status: 503 });
  }
}
