"use client";

import { useEffect, useState } from "react";
import { browserAiModelConfigured, browserAiModelName, ensureBrowserLocalAiCapabilities } from "@/lib/browser-ai";
import { DeviceCapabilities } from "@/lib/device-capabilities";
import { useUiLocale } from "@/lib/ui-locale";

function formatBytes(value: number | null) {
  if (value == null) return "unknown";
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default function DeviceReadiness() {
  const { t } = useUiLocale();
  const [result, setResult] = useState<DeviceCapabilities | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);

  async function run(force = true) {
    setChecking(true);
    try { setResult(await ensureBrowserLocalAiCapabilities(force)); }
    finally { setChecking(false); }
  }

  useEffect(() => {
    let active = true;
    setChecking(true);
    ensureBrowserLocalAiCapabilities().then(next => { if (active) setResult(next); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  const label = checking ? t("Checking local AI…", "正在检查本地 AI…") : !result ? t("Local AI check", "本地 AI 检查") : result.localAiReady ? `${t("Local AI", "本地 AI")} · ${result.aiMode.toUpperCase()}` : result.modelConfigured ? t("Local AI needs attention", "本地 AI 需要检查") : result.runtimeSmoke ? t("AI runtime only", "仅 AI 运行环境") : t("Device needs attention", "设备需要检查");
  return <div className="deviceReadiness">
    <button className={`readinessPill ${result?.localAiReady ? "ready" : ""}`} onClick={() => setOpen(value => !value)} aria-expanded={open}>{label}</button>
    {open && <section className="readinessCard" aria-label={t("Device readiness", "设备就绪状态")}>
      <div><strong>{t("Device readiness", "设备就绪状态")}</strong><small>{t("Checked locally. Nothing here is uploaded.", "仅在本地检查，不会上传任何内容。")}</small></div>
      <dl>
        <div><dt>{t("Private local storage", "私有本地存储")}</dt><dd>{result?.indexedDb && result?.webCrypto ? t("Ready", "就绪") : t("Unavailable", "不可用")}</dd></div>
        <div><dt>{t("Offline app cache", "离线应用缓存")}</dt><dd>{result?.cacheStorage && result?.serviceWorker ? t("Ready", "就绪") : t("Unavailable", "不可用")}</dd></div>
        <div><dt>{t("Local AI runtime", "本地 AI 运行环境")}</dt><dd>{result?.runtimeSmoke ? `${t("Ready", "就绪")} · ${result.localAiProfile}` : checking ? t("Testing…", "测试中…") : t("Unavailable", "不可用")}</dd></div>
        <div><dt>{t("Local model inference", "本地模型推理")}</dt><dd>{result?.modelInference === true ? t("Ready", "就绪") : result?.modelConfigured ? result?.modelInference === false ? t("Failed", "失败") : t("Testing…", "测试中…") : t("Not installed", "未安装")}</dd></div>
        <div><dt>{t("Acceleration", "加速")}</dt><dd>{result?.webGpu ? "WebGPU" : "CPU / WebAssembly"}</dd></div>
        <div><dt>{t("Storage quota", "存储配额")}</dt><dd>{formatBytes(result?.storageQuotaBytes ?? null)}</dd></div>
        <div><dt>{t("CPU threads exposed", "可用 CPU 线程")}</dt><dd>{result?.hardwareConcurrency ?? t("unknown", "未知")}</dd></div>
      </dl>
      <p className="readinessModel">{t("Model profile", "模型配置")}: {browserAiModelConfigured() ? browserAiModelName() : t("not bundled in this development build", "此开发版本未内置模型")}</p>
      {result?.runtimeError && <p className="readinessError">{result.runtimeError}</p>}
      {result?.modelError && <p className="readinessError">{result.modelError}</p>}
      <button disabled={checking} onClick={() => void run(true)}>{checking ? t("Running…", "检查中…") : t("Run check again", "重新检查")}</button>
    </section>}
  </div>;
}
