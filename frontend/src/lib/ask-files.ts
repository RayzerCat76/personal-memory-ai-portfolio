"use client";

import type { ChatFileContext } from "@/lib/api";

const maxFiles = 4;
const maxFileBytes = 2 * 1024 * 1024;
const maxCharsPerFile = 4000;
const maxTotalChars = 6500;
const textExtensions = new Set([
  "txt", "md", "markdown", "json", "csv", "tsv", "js", "ts", "tsx", "jsx",
  "py", "html", "css", "xml", "yaml", "yml", "tex", "log",
]);

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isReadableText(file: File) {
  return file.type.startsWith("text/")
    || file.type === "application/json"
    || file.type === "application/xml"
    || textExtensions.has(extension(file.name));
}
export async function readAskFiles(files: File[]): Promise<ChatFileContext[]> {
  if (files.length > maxFiles) throw new Error(`Attach up to ${maxFiles} files at a time.`);
  let remaining = maxTotalChars;
  const output: ChatFileContext[] = [];
  for (const file of files) {
    if (!file.name.trim()) throw new Error("An attached file is missing its name.");
    if (file.size > maxFileBytes) throw new Error(`${file.name} is larger than the 2 MB Ask limit.`);
    if (!isReadableText(file)) {
      throw new Error(`${file.name} is not a supported Ask text file yet. Use text, Markdown, JSON, CSV, code, HTML/XML/YAML, or save it as a Study attachment.`);
    }
    const raw = await file.text();
    const take = Math.max(0, Math.min(raw.length, maxCharsPerFile, remaining));
    const truncated = take < raw.length;
    output.push({
      name: file.name,
      mediaType: file.type || "text/plain",
      size: file.size,
      text: raw.slice(0, take),
      truncated,
    });
    remaining -= take;
    if (remaining <= 0) break;
  }
  return output;
}

export type ArtifactFormat = "md" | "txt" | "json" | "csv";
function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "answer";
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function answerArtifact(answer: string, format: ArtifactFormat, stem = "memory-answer") {
  const base = safeName(stem);
  if (format === "json") {
    return { filename: `${base}.json`, blob: new Blob([JSON.stringify({ answer }, null, 2)], { type: "application/json;charset=utf-8" }) };
  }
  if (format === "csv") {
    return { filename: `${base}.csv`, blob: new Blob([`answer\r\n${csvCell(answer)}\r\n`], { type: "text/csv;charset=utf-8" }) };
  }
  if (format === "md") {
    return { filename: `${base}.md`, blob: new Blob([`# Answer\n\n${answer}\n`], { type: "text/markdown;charset=utf-8" }) };
  }
  return { filename: `${base}.txt`, blob: new Blob([`${answer}\n`], { type: "text/plain;charset=utf-8" }) };
}

export function downloadArtifact(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
