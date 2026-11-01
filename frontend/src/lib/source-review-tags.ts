export const topics = ["study", "projects", "games", "music", "sports", "health", "social", "logistics", "unknown"] as const;
export const functions = ["thanks", "question", "planning", "acknowledgment", "request", "statement", "joke", "unknown"] as const;
export type SourceTags = { topics: string[]; functions: string[]; reviewed: boolean };
export const emptyTags = (): SourceTags => ({ topics: [], functions: [], reviewed: false });

export function validTags(value: unknown): value is SourceTags {
  if (!value || typeof value !== "object") return false;
  const tags = value as SourceTags;
  if (typeof tags.reviewed !== "boolean") return false;
  return (["topics", "functions"] as const).every(axis => {
    const labels = tags[axis];
    const allowed: readonly string[] = axis === "topics" ? topics : functions;
    return Array.isArray(labels) && labels.length <= 3 && (!tags.reviewed || labels.length > 0)
      && labels.every(label => typeof label === "string" && allowed.includes(label))
      && new Set(labels).size === labels.length
      && (!labels.includes("unknown") || labels.length === 1);
  });
}

export function toggleTag(tags: SourceTags, axis: "topics" | "functions", label: string): SourceTags {
  const allowed: readonly string[] = axis === "topics" ? topics : functions;
  if (!allowed.includes(label)) throw new Error("Unknown tag");
  const current = tags[axis];
  const next = current.includes(label) ? current.filter(value => value !== label)
    : label === "unknown" ? [label] : [...current.filter(value => value !== "unknown"), label];
  if (next.length > 3) throw new Error("Choose up to three tags in each group.");
  return { ...tags, [axis]: next, reviewed: false };
}

export function confirmTags(tags: SourceTags): SourceTags {
  const confirmed = { ...tags, reviewed: true };
  if (!validTags(confirmed)) throw new Error("Choose a topic and a message type, or choose unknown.");
  return confirmed;
}
