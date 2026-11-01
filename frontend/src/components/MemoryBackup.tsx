"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useUiLocale } from "@/lib/ui-locale";

export default function MemoryBackup({ onRestored }: { onRestored: () => Promise<void> }) {
  const { locale, t } = useUiLocale();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function exportBackup() {
    setBusy(true);
    setNotice("");
    try {
      const backup = await api.memoryBackup();
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `memory-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(t("Memory backup exported. The raw chat archive is not included.", "记忆备份已导出；不包含原始聊天归档。"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Could not export the memory backup.", "无法导出记忆备份。"));
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup(file: File) {
    if (file.size > 50_000_000) {
      setNotice(t("Choose a memory backup smaller than 50 MB.", "请选择小于 50 MB 的记忆备份。"));
      return;
    }
    if (!window.confirm(t("Restore this memory backup? Existing identical records are kept. A conflict stops the restore; existing data is never overwritten.", "恢复此记忆备份吗？相同记录会保留；如遇冲突会停止恢复，不会覆盖现有数据。"))) return;

    setBusy(true);
    setNotice("");
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = await api.restoreMemoryBackup(parsed);
      await onRestored();
      const added = Object.values(result.inserted).reduce((sum, value) => sum + value, 0);
      setNotice(added
        ? locale === "zh" ? `已恢复 ${added} 条记录；相同的现有记录已保留。` : `Restored ${added} stored records. Existing identical records were kept.`
        : t("Backup already matches this memory store. Nothing was changed.", "备份已与当前记忆库一致，没有更改任何内容。"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Could not restore the memory backup.", "无法恢复记忆备份。"));
    } finally {
      setBusy(false);
    }
  }

  return <details className="sourceReview">
    <summary>{t("Memory backup and restore", "记忆备份与恢复")}</summary>
    <p>{t("Export app memories with their evidence, review status, relationships, open loops and local birthday calibration feedback.", "导出应用中的记忆及其证据、审核状态、关系、待办线索和本地生日校准反馈。")}</p>
    <p>{t("The separate raw WeChat archive is not part of this backup. Restore is additive: identical records are kept, and conflicting records stop without being overwritten.", "单独的原始微信归档不包含在此备份中。恢复采用增量方式：相同记录会保留，冲突记录会停止恢复且不会被覆盖。")}</p>
    <div className="reviewActions">
      <button disabled={busy} onClick={() => void exportBackup()}>{busy ? t("Working…", "处理中…") : t("Export memory backup", "导出记忆备份")}</button>
      <label>{t("Restore memory backup", "恢复记忆备份")}
        <input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
          const file = event.target.files?.[0];
          if (file) void restoreBackup(file);
          event.target.value = "";
        }} />
      </label>
    </div>
    {notice && <p role="status">{notice}</p>}
  </details>;
}
