"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./Study.module.css";
import {
  listStudyPeerConflicts,
  resolveStudyPeerConflict,
  StudyPeerConflict,
} from "@/lib/study-peer-persistence";
import { useUiLocale } from "@/lib/ui-locale";

export default function StudySyncConflictReview({ kind }: { kind: "note" | "project" }) {
  const { t } = useUiLocale();
  const [conflicts, setConflicts] = useState<StudyPeerConflict[]>([]);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = async () => setConflicts(await listStudyPeerConflicts());

  useEffect(() => {
    void refresh().catch(() => undefined);
    const onSync = () => { void refresh().catch(() => undefined); };
    window.addEventListener("personal-study-sync-applied", onSync);
    window.addEventListener("personal-study-sync-state", onSync);
    return () => {
      window.removeEventListener("personal-study-sync-applied", onSync);
      window.removeEventListener("personal-study-sync-state", onSync);
    };
  }, []);

  const visible = useMemo(() => conflicts.filter(conflict => conflict.kind === kind), [conflicts, kind]);

  async function resolve(conflict: StudyPeerConflict, mutationId: string) {
    setBusyId(conflict.id); setNotice("");
    try {
      await resolveStudyPeerConflict(conflict.recordId, mutationId);
      await refresh();
      setNotice(t("Conflict resolved. The chosen version is saved locally and queued for encrypted sync.", "冲突已解决。所选版本已保存到本地，并加入加密同步队列。"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Could not resolve this sync conflict.", "无法解决此同步冲突。"));
    } finally { setBusyId(""); }
  }

  if (!visible.length) return notice ? <p role="status">{notice}</p> : null;
  return <section className={styles.syncConflictReview} aria-label="Sync conflicts">
    <h3>{t("Sync needs review", "同步需要审核")}</h3>
    <p>{t("These edits happened independently. Every version was kept; choose deliberately and the resolution will causally cover all of them.", "这些编辑是在不同设备上独立发生的。所有版本都已保留；请明确选择一个版本来解决冲突。")}</p>
    {visible.map(conflict => {
      const title = conflict.variants.find(variant => variant.operation === "put")?.record?.title ?? t("Deleted item", "已删除项目");
      return <details key={conflict.id} open>
        <summary>{title}</summary>
        <div className={styles.syncConflictVersions}>
          {conflict.variants.map((variant, index) => <div key={variant.mutationId}>
            <strong>{t("Version", "版本")} {index + 1}</strong>
            {variant.operation === "put" && variant.record
              ? <><span>{variant.record.title}</span><p>{variant.record.body.slice(0, 240)}</p></>
              : <span>{t("Deleted on another replica", "已在另一副本上删除")}</span>}
            <button disabled={!!busyId} onClick={() => void resolve(conflict, variant.mutationId)}>
              {variant.operation === "delete" ? t("Keep deleted", "保持删除") : t("Use this version", "使用此版本")}
            </button>
          </div>)}
        </div>
      </details>;
    })}
    {notice && <p role="status">{notice}</p>}
  </section>;
}