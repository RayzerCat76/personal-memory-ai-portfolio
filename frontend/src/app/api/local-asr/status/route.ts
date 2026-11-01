import { NextResponse } from "next/server";
import { resolveLocalAsrRuntime } from "@/lib/local-asr-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const runtimeInfo = await resolveLocalAsrRuntime();
  return NextResponse.json({ configured: !!runtimeInfo, ready: !!runtimeInfo });
}
