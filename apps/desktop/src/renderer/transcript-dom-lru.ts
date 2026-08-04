import type { TranscriptItem } from "./desktop-types";

export const TRANSCRIPT_MARKDOWN_DOM_LRU_LIMIT = 48;

export interface RetainedTranscriptMarkdownRow {
  key: string;
  index: number;
  item: TranscriptItem;
  completion?: TranscriptItem;
  attachedUser: boolean;
  disclosureScope: string;
}

export function isRetainableTranscriptMarkdownRow(item: TranscriptItem | undefined): boolean {
  return Boolean(
    item
    && item.kind === "assistant"
    && !item.streaming
    && String(item.text || "").trim(),
  );
}

function retainedRowsEqual(
  left: readonly RetainedTranscriptMarkdownRow[],
  right: readonly RetainedTranscriptMarkdownRow[],
): boolean {
  return left.length === right.length && left.every((row, index) => {
    const next = right[index];
    return row.key === next.key
      && row.index === next.index
      && row.item === next.item
      && row.completion === next.completion
      && row.attachedUser === next.attachedUser
      && row.disclosureScope === next.disclosureScope;
  });
}

export function refreshRetainedTranscriptMarkdownRows(
  current: readonly RetainedTranscriptMarkdownRow[],
  active: readonly RetainedTranscriptMarkdownRow[],
  limit = TRANSCRIPT_MARKDOWN_DOM_LRU_LIMIT,
): readonly RetainedTranscriptMarkdownRow[] {
  const boundedLimit = Math.max(0, Math.round(limit));
  const boundedActive = boundedLimit > 0 ? active.slice(-boundedLimit) : [];
  const next = new Map(current.map((row) => [row.key, row]));
  const activeKeys = new Set(boundedActive.map((row) => row.key));
  for (const row of boundedActive) {
    next.delete(row.key);
    next.set(row.key, row);
  }
  while (next.size > boundedLimit) {
    let oldestInactive: string | undefined;
    for (const key of next.keys()) {
      if (activeKeys.has(key)) continue;
      oldestInactive = key;
      break;
    }
    if (oldestInactive === undefined) break;
    next.delete(oldestInactive);
  }
  const rows = [...next.values()];
  return retainedRowsEqual(current, rows) ? current : rows;
}
