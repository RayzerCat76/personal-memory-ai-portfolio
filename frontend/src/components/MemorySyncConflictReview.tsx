"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listMemoryPeerConflicts,
  resolveMemoryPeerConflict,
  type MemoryPeerConflict,
} from "@/lib/study-peer-persistence";

function summary(conflict: MemoryPeerConflict, index: number): string {
  const variant = conflict.variants[index];
  if (variant.operation === "delete") return "Deleted on this replica";
  const value = variant.record?.value ?? {};
  const parts = [value.content, value.note, value.verdict, value.status]
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  const description = [...new Set(parts)].join(" · ");
  return description ? description.slice(0, 240) : `${conflict.entityKind.replaceAll("_", " ")} version`;
}

export default function MemorySyncConflictReview({ onResolved }: { onResolved?: () => void | Promise<void> }) {
  const [conflicts, setConflicts] = useState<MemoryPeerConflict[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try { setConflicts(await listMemoryPeerConflicts()); } catch { setConflicts([]); }
  }, []);

  useEffect(() => {
    void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener("personal-study-sync-applied", changed);
    window.addEventListener("personal-memory-peer-applied", changed);
    return () => {
      window.removeEventListener("personal-study-sync-applied", changed);
      window.removeEventListener("personal-memory-peer-applied", changed);
    };
  }, [refresh]);

  if (!conflicts.length) return notice ? <p role="status">{notice}</p> : null;

  async function choose(conflict: MemoryPeerConflict, mutationId: string) {
    setBusy(true); setNotice("");
    try {
      await resolveMemoryPeerConflict(conflict.recordId, mutationId);
      setNotice("Conflict resolved locally. The signed resolution will sync to your other devices.");
      await refresh();
      await onResolved?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not resolve the Memory sync conflict.");
    } finally { setBusy(false); }
  }

  return <section className="flowSection" aria-label="Memory sync conflicts">
    <div className="sectionHeading"><div>
      <p className="eyebrow">SYNC REVIEW</p>
      <h2>{conflicts.length} concurrent {conflicts.length === 1 ? "change needs" : "changes need"} your choice</h2>
    </div></div>
    <p>Nothing was overwritten. Choose the version that should become the next signed Memory state.</p>
    {notice && <p role="status">{notice}</p>}
    {conflicts.map(conflict => <article className="memoryEntry" key={conflict.recordId}>
      <div className="memoryMeta"><span>{conflict.entityKind.replaceAll("_", " ")}</span><span>conflict</span></div>
      <div className="reviewActions">
        {conflict.variants.map((variant, index) => <button key={variant.mutationId} disabled={busy}
          onClick={() => void choose(conflict, variant.mutationId)}>
          Keep version {index + 1}: {summary(conflict, index)}
        </button>)}
      </div>
    </article>)}
  </section>;
}
