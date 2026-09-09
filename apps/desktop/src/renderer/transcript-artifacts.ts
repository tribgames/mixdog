import type { TranscriptItem } from "./desktop-types";
import { asRecord } from "./text-format";
import { desktopToolActivityCategory, flattenedToolActivityItems, toolItemDone } from "./transcript-tool-core";
import { toolActivityResultValue } from "./transcript-tool-result";

export interface TranscriptArtifact {
  key: string;
  kind: "image" | "video" | "document";
  name: string;
  path: string;
  assetId?: string;
}

const DOCUMENT = /\.(?:docx|xlsx|pptx|pdf|csv|tsv|rtf|odt|ods|odp)$/i;

// Only parse structured tool output, never paths guessed from prose or input args.
function resultRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 3) return [];
  if (typeof value === "string") {
    try { return resultRecords(JSON.parse(value), depth + 1); } catch { return []; }
  }
  const record = asRecord(value);
  if (!record || record.isError === true || record.ok === false) return [];
  if (record.structuredContent) return resultRecords(record.structuredContent, depth + 1);
  if (Array.isArray(record.content)) {
    return record.content.flatMap((entry) => {
      const part = asRecord(entry);
      return part?.type === "text" ? resultRecords(part.text, depth + 1) : [];
    });
  }
  return [record];
}

export function transcriptArtifacts(items: readonly TranscriptItem[]): TranscriptArtifact[] {
  const artifacts = new Map<string, TranscriptArtifact>();
  for (const item of flattenedToolActivityItems(items)) {
    if (!toolItemDone(item) || item.isError || Number(item.errorCount || 0) > 0
      || Number(item.callErrorCount || 0) > 0 || Number(item.exitErrorCount || 0) > 0) continue;
    const category = desktopToolActivityCategory(item.name, item.args);
    if (category !== "Media" && category !== "Office") continue;
    for (const result of resultRecords(toolActivityResultValue(item))) {
      if (["running", "failed", "canceled", "cancelled"].includes(String(result.status || ""))) continue;
      if (category === "Media" && result.ok === true && typeof result.assetId === "string"
        && result.assetId && (result.output || result.status === "done")) {
        const path = typeof result.output === "string" ? result.output : "";
        const args = asRecord(item.args);
        const kind = result.kind === "video" || args?.kind === "video" || /\.(mp4|webm|mov)$/i.test(path)
          ? "video" : "image";
        const key = `media:${result.assetId}`;
        artifacts.set(key, { key, kind, assetId: result.assetId, path,
          name: path.split(/[\\/]/).pop() || result.assetId });
      }
      if (category !== "Office") continue;
      const outputs = Array.isArray(result.artifacts) ? result.artifacts : [];
      for (const output of outputs) {
        const artifact = asRecord(output);
        const path = typeof artifact?.path === "string" ? artifact.path : "";
        if (!DOCUMENT.test(path) || !["create", "edit"].includes(String(artifact?.operation))) continue;
        const key = `file:${path.replace(/\\/g, "/")}`;
        artifacts.set(key, { key, kind: "document", path, name: path.split(/[\\/]/).pop() || path });
      }
    }
  }
  return [...artifacts.values()];
}
