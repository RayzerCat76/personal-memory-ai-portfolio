import { readFile, stat } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const lang = request.nextUrl.searchParams.get("lang") === "zh" ? "zh" : "en";
  const persona = request.nextUrl.searchParams.get("persona") ?? "neutral";
  const characterPersonas = new Set(["starrail-march7", "genshin-furina", "arknights-amiya"]);
  if (persona !== "neutral" && !characterPersonas.has(persona)) {
    return NextResponse.json({ error: "Unknown local character voice." }, { status: 400 });
  }
  const personaRef = persona === "starrail-march7"
    ? (lang === "zh" ? process.env.PMA_VOICE_REF_MARCH7_ZH_F32 : process.env.PMA_VOICE_REF_MARCH7_EN_F32)?.trim()
    : persona === "genshin-furina"
      ? (lang === "zh" ? process.env.PMA_VOICE_REF_FURINA_ZH_F32 : process.env.PMA_VOICE_REF_FURINA_EN_F32)?.trim()
      : persona === "arknights-amiya"
        ? (lang === "zh" ? process.env.PMA_VOICE_REF_AMIYA_ZH_F32 : process.env.PMA_VOICE_REF_AMIYA_EN_F32)?.trim()
        : undefined;
  if (characterPersonas.has(persona) && !personaRef) {
    return NextResponse.json({ error: "The selected character voice reference is unavailable; no fallback voice was substituted." }, { status: 503 });
  }
  const refFile = personaRef
    || (lang === "zh" ? process.env.PMA_VOICE_REF_AUDIO_ZH_F32 : process.env.PMA_VOICE_REF_AUDIO_EN_F32)?.trim()
    || process.env.PMA_VOICE_REF_AUDIO_F32?.trim();
  if (!refFile) return NextResponse.json({ error: "Local voice reference is unavailable." }, { status: 404 });
  try {
    const info = await stat(refFile);
    if (!info.isFile() || info.size <= 0 || info.size > 4 * 1024 * 1024 || info.size % 4 !== 0) throw new Error("invalid reference audio");
    const data = await readFile(refFile);
    return NextResponse.json({ base64: data.toString("base64"), sampleRate: 16000, samples: data.length / 4 }, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch {
    return NextResponse.json({ error: "Local voice reference is unavailable." }, { status: 404 });
  }
}
