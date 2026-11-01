"use client";

import { useMemo, useState } from "react";
import MemoryContextNote from "@/components/MemoryContextNote";
import type { Memory } from "@/lib/api";
import { useUiLocale } from "@/lib/ui-locale";

type Filter = "all" | "missing" | "has" | "multi";

export default function ContextReview({ memories, onChanged }: { memories: Memory[]; onChanged: () => Promise<void> }) {
  const { t } = useUiLocale();
  const [filter, setFilter] = useState<Filter>("missing");
  const [query, setQuery] = useState("");
  const active = useMemo(() => memories.filter(m => m.status === "confirmed" || m.status === "unconfirmed"), [memories]);
  const visible = useMemo(() => active.filter(memory => {
    if (filter === "missing" && memory.active_context_note) return false;
    if (filter === "has" && !memory.active_context_note) return false;
    if (filter === "multi" && memory.evidence_count < 2) return false;
    const q = query.trim().toLowerCase();
    return !q || memory.content.toLowerCase().includes(q) || (memory.active_context_note ?? "").toLowerCase().includes(q);
  }), [active, filter, query]);

  return <section className="memoryLedger">
    <div className="sectionHeading"><div><p className="eyebrow">{t("CONTEXT REVIEW", "语境审核")}</p><h2>{t("Clarify what each memory was about", "说明每段记忆的具体语境")}</h2></div></div>
    <p>{t("Context notes are your interpretation layer. They can help recall choose between similar confirmed memories, but they never become evidence or confirmation by themselves.", "语境备注是你的解释层。它可以帮助在相似的已确认记忆之间做区分，但本身不会成为证据或确认。")}</p>
    <div className="reviewActions" role="group" aria-label="Context filters">
      <button className={filter === "missing" ? "approve" : ""} onClick={() => setFilter("missing")}>{t("Missing context", "缺少语境")}</button>
      <button className={filter === "has" ? "approve" : ""} onClick={() => setFilter("has")}>{t("Has note", "已有备注")}</button>
      <button className={filter === "multi" ? "approve" : ""} onClick={() => setFilter("multi")}>{t("Multiple evidence", "多条证据")}</button>
      <button className={filter === "all" ? "approve" : ""} onClick={() => setFilter("all")}>{t("All active", "全部有效")}</button>
    </div>
    <label>{t("Search memories or context notes", "搜索记忆或语境备注")}<input value={query} onChange={event => setQuery(event.target.value)} /></label>
    <p><strong>{visible.length}</strong> shown · {active.filter(m => !!m.active_context_note).length} with context notes</p>
    {visible.map(memory => <article className="memoryEntry" key={memory.id}>
      <div className="memoryMeta"><span>{memory.type}</span><span>{memory.status}</span><span>{memory.evidence_count} evidence</span></div>
      <h3>{memory.content}</h3>
      <MemoryContextNote memory={memory} onChanged={onChanged} />
    </article>)}
    {!visible.length && <p className="emptyState">{t("No memories match this context filter.", "没有符合此语境筛选条件的记忆。")}</p>}
  </section>;
}
