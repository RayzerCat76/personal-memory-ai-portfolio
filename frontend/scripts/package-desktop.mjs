import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.PMA_DESKTOP_OUTPUT?.trim();
const model = process.env.PMA_MODEL_FILE?.trim();
const recoveryKit = process.env.PMA_RECOVERY_KIT_FILE?.trim();
const runtimeRoot = process.env.PMA_NODE_RUNTIME_ROOT?.trim();
const voiceNativeRuntimeDir = process.env.PMA_VOICE_NATIVE_RUNTIME_DIR?.trim();
const voiceModelDir = process.env.PMA_VOICE_MODEL_DIR?.trim();
const voiceRefEn = process.env.PMA_VOICE_REF_AUDIO_EN_F32?.trim();
const voiceRefZh = process.env.PMA_VOICE_REF_AUDIO_ZH_F32?.trim();
const voiceRefMarch7En = process.env.PMA_VOICE_REF_MARCH7_EN_F32?.trim();
const voiceRefMarch7Zh = process.env.PMA_VOICE_REF_MARCH7_ZH_F32?.trim();
const voiceRefFurinaEn = process.env.PMA_VOICE_REF_FURINA_EN_F32?.trim();
const voiceRefFurinaZh = process.env.PMA_VOICE_REF_FURINA_ZH_F32?.trim();
const voiceRefAmiyaEn = process.env.PMA_VOICE_REF_AMIYA_EN_F32?.trim();
const voiceRefAmiyaZh = process.env.PMA_VOICE_REF_AMIYA_ZH_F32?.trim();
const asrRuntimeDir = process.env.PMA_ASR_RUNTIME_DIR?.trim();
const asrModelFile = process.env.PMA_ASR_MODEL_FILE?.trim();
const asrMmprojFile = process.env.PMA_ASR_MMPROJ_FILE?.trim();
const voiceValues = [voiceNativeRuntimeDir, voiceModelDir, voiceRefEn, voiceRefZh];
const voiceBundled = voiceValues.every(Boolean);
const asrValues = [asrRuntimeDir, asrModelFile, asrMmprojFile];
const asrBundled = asrValues.every(Boolean);
if (voiceValues.some(Boolean) && !voiceBundled) throw new Error("Voice packaging requires PMA_VOICE_NATIVE_RUNTIME_DIR, PMA_VOICE_MODEL_DIR, PMA_VOICE_REF_AUDIO_EN_F32 and PMA_VOICE_REF_AUDIO_ZH_F32 together.");
if (asrValues.some(Boolean) && !asrBundled) throw new Error("Local ASR packaging requires PMA_ASR_RUNTIME_DIR, PMA_ASR_MODEL_FILE and PMA_ASR_MMPROJ_FILE together.");
if (Boolean(voiceRefMarch7En) !== Boolean(voiceRefMarch7Zh)) throw new Error("March 7th voice packaging requires both PMA_VOICE_REF_MARCH7_EN_F32 and PMA_VOICE_REF_MARCH7_ZH_F32.");
if (Boolean(voiceRefFurinaEn) !== Boolean(voiceRefFurinaZh)) throw new Error("Furina voice packaging requires both persona references.");
if (Boolean(voiceRefAmiyaEn) !== Boolean(voiceRefAmiyaZh)) throw new Error("Amiya voice packaging requires both persona references.");
if (!output) throw new Error("PMA_DESKTOP_OUTPUT is required.");
if (!model) throw new Error("PMA_MODEL_FILE is required.");
if (!runtimeRoot) throw new Error("PMA_NODE_RUNTIME_ROOT is required.");

const appDir = path.join(output, "app");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(FRONTEND, ".next", "standalone"), appDir, { recursive: true });
await rm(path.join(appDir, "node_modules", "sharp"), { recursive: true, force: true });
await rm(path.join(appDir, "node_modules", "@img"), { recursive: true, force: true });
await mkdir(path.join(appDir, ".next"), { recursive: true });
await cp(path.join(FRONTEND, ".next", "static"), path.join(appDir, ".next", "static"), { recursive: true });
await cp(path.join(FRONTEND, "public"), path.join(appDir, "public"), { recursive: true });

await mkdir(path.join(appDir, "public", "models"), { recursive: true });
await copyFile(model, path.join(appDir, "public", "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf"));
if (recoveryKit) {
  await mkdir(path.join(appDir, "public", "setup"), { recursive: true });
  await copyFile(recoveryKit, path.join(appDir, "public", "setup", "recovery-kit.json"));
}
await copyFile(path.join(FRONTEND, "desktop", "launcher.mjs"), path.join(output, "launcher.mjs"));
if (asrBundled) {
  const asrDir = path.join(output, "asr");
  await mkdir(path.join(asrDir, "runtime"), { recursive: true });
  await mkdir(path.join(asrDir, "model"), { recursive: true });
  await cp(asrRuntimeDir, path.join(asrDir, "runtime"), { recursive: true });
  await copyFile(asrModelFile, path.join(asrDir, "model", "Qwen3-ASR-0.6B-Q8_0.gguf"));
  await copyFile(asrMmprojFile, path.join(asrDir, "model", "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"));
}
if (voiceBundled) {
  const voiceDir = path.join(output, "voice");
  await mkdir(voiceDir, { recursive: true });
  if (process.platform === "darwin") {
    execFileSync("/bin/cp", ["-cR", voiceNativeRuntimeDir, path.join(voiceDir, "native")]);
    execFileSync("/bin/cp", ["-cR", voiceModelDir, path.join(voiceDir, "model")]);
    execFileSync("/bin/cp", ["-c", voiceRefEn, path.join(voiceDir, "ref-en.f32")]);
    execFileSync("/bin/cp", ["-c", voiceRefZh, path.join(voiceDir, "ref-zh.f32")]);
    const packagedVoiceServer = path.join(voiceDir, "native", "llama-omni-server");
    const loadCommands = execFileSync("otool", ["-l", packagedVoiceServer], { encoding: "utf8" });
    const rpaths = [...loadCommands.matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (\S+) \(offset \d+\)/g)].map(match => match[1]);
    for (const rpath of rpaths) {
      if (rpath !== "@loader_path") execFileSync("install_name_tool", ["-delete_rpath", rpath, packagedVoiceServer]);
    }
    if (!rpaths.includes("@loader_path")) execFileSync("install_name_tool", ["-add_rpath", "@loader_path", packagedVoiceServer]);
    execFileSync("codesign", ["--force", "--sign", "-", packagedVoiceServer]);
  } else {
    await cp(voiceNativeRuntimeDir, path.join(voiceDir, "native"), { recursive: true });
    await cp(voiceModelDir, path.join(voiceDir, "model"), { recursive: true });
    await copyFile(voiceRefEn, path.join(voiceDir, "ref-en.f32"));
    await copyFile(voiceRefZh, path.join(voiceDir, "ref-zh.f32"));
  }
  for (const [en, zh, stem] of [
    [voiceRefMarch7En, voiceRefMarch7Zh, "march7"],
    [voiceRefFurinaEn, voiceRefFurinaZh, "furina"],
    [voiceRefAmiyaEn, voiceRefAmiyaZh, "amiya"],
  ]) {
    if (!en || !zh) continue;
    const personaDir = path.join(voiceDir, "personas");
    await mkdir(personaDir, { recursive: true });
    if (process.platform === "darwin") {
      execFileSync("/bin/cp", ["-c", en, path.join(personaDir, `${stem}-en.f32`)]);
      execFileSync("/bin/cp", ["-c", zh, path.join(personaDir, `${stem}-zh.f32`)]);
    } else {
      await copyFile(en, path.join(personaDir, `${stem}-en.f32`));
      await copyFile(zh, path.join(personaDir, `${stem}-zh.f32`));
    }
  }
}
for (const runtime of ["macos-arm64", "macos-x64", "windows-x64", "windows-arm64"]) {
  await cp(path.join(runtimeRoot, runtime), path.join(output, "runtime", runtime), { recursive: true });
}

const macCommand = `#!/bin/zsh\nset -eu\nROOT="$(cd "$(dirname "$0")" && pwd)"\nARCH="$(uname -m)"\nif [ "$ARCH" = "arm64" ]; then NODE="$ROOT/runtime/macos-arm64/bin/node"; else NODE="$ROOT/runtime/macos-x64/bin/node"; fi\nexec "$NODE" "$ROOT/launcher.mjs"\n`;
await writeFile(path.join(output, "Open Personal Memory AI.command"), macCommand);
await chmod(path.join(output, "Open Personal Memory AI.command"), 0o755);

const macApp = path.join(output, "Personal Memory AI.app", "Contents");
await mkdir(path.join(macApp, "MacOS"), { recursive: true });
const macExecutable = path.join(macApp, "MacOS", "Personal Memory AI");
execFileSync("clang", [
  "-O2", "-arch", "arm64", "-arch", "x86_64",
  path.join(FRONTEND, "desktop", "macos-launcher.c"), "-o", macExecutable,
]);
await chmod(macExecutable, 0o755);
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Personal Memory AI</string><key>CFBundleIdentifier</key><string>ai.personalmemory.gift</string><key>CFBundleName</key><string>Personal Memory AI</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.3</string><key>LSUIElement</key><true/></dict></plist>\n`;
await writeFile(path.join(macApp, "Info.plist"), plist);
execFileSync("codesign", ["--force", "--sign", "-", path.join(output, "Personal Memory AI.app")]);
const windowsCommand = `@echo off\r\nset ROOT=%~dp0\r\nset NODE=%ROOT%runtime\\windows-x64\\node.exe\r\nif /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set NODE=%ROOT%runtime\\windows-arm64\\node.exe\r\nstart "" /b "%NODE%" "%ROOT%launcher.mjs"\r\n`;
await writeFile(path.join(output, "Open Personal Memory AI.cmd"), windowsCommand);

const instructions = [
  "Personal Memory AI — private desktop copy",
  "",
  "Mac: double-click ‘Personal Memory AI.app’. If macOS blocks it, use ‘Open Personal Memory AI.command’ as the fallback.",
  "Windows: double-click ‘Open Personal Memory AI.cmd’.",
  "",
  "The app opens at http://127.0.0.1:13013 and keeps its working data in your browser on this device.",
  "The local AI model is included. Cross-device sync uses only the configured encrypted relay.",
  voiceBundled ? "On Apple-silicon Macs, the optional local character speech model starts automatically and stays on this computer." : "This package does not include the optional character speech bundle.",
  asrBundled ? "On Apple-silicon Macs, microphone input is transcribed by the bundled local Qwen3-ASR model; recorded audio stays on this computer." : "This package does not include the optional local microphone-ASR bundle.",
  recoveryKit ? "The encrypted recovery kit is included; the recovery code is intentionally stored separately." : "No recovery kit is included in this package.",
].join("\n");
await writeFile(path.join(output, "START HERE.txt"), instructions);
console.log(JSON.stringify({ output, modelBundled: true, recoveryKitBundled: Boolean(recoveryKit), voiceBundled, asrBundled, nativeVoiceRuntimeBundled: voiceBundled, march7VoiceBundled: Boolean(voiceRefMarch7En && voiceRefMarch7Zh), furinaVoiceBundled: Boolean(voiceRefFurinaEn && voiceRefFurinaZh), amiyaVoiceBundled: Boolean(voiceRefAmiyaEn && voiceRefAmiyaZh) }));
