"use client";

import { useState } from "react";
import { api, readableEvidence, type MemoryReview } from "@/lib/api";
import { useUiLocale } from "@/lib/ui-locale";

export default function MemoryEvidence({ memoryId }: { memoryId: string }) {
  const { t } = useUiLocale();
  const [review, setReview] = useState<MemoryReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setReview(await api.reviewMemory(memoryId));
    } catch {
      setError(t("Couldn't load the original evidence.", "无法加载原始证据。"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <details className="memorySources" onToggle={(event) => {
      if (event.currentTarget.open && !review && !loading) void load();
    }}>
      <summary>{t("Original evidence", "原始证据")}</summary>
      {loading && <p role="status">{t("Loading evidence…", "正在加载证据…")}</p>}
      {error && <p role="alert">{error} <button type="button" onClick={() => void load()} disabled={loading}>{t("Retry evidence", "重试加载证据")}</button></p>}
      {review && (review.sources.length ? review.sources.map((source, index) => (
        <div key={`${source.source_id}-${index}`}>
          <small>{t("Source", "来源")} {index + 1}</small>
          <blockquote>{readableEvidence(source.evidence_text)}</blockquote>
        </div>
      )) : <p>{t("No original evidence is stored for this memory.", "这条记忆没有保存原始证据。")}</p>)}
    </details>
  );
}
