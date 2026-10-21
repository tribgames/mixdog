/**
 * A session's bounded "All visuals" history: what was opened (files by the
 * targets the agent named, inline content by its source), whether or not the
 * tab is still open. Kept in memory with the session's tabs.
 */
import { createHash } from 'node:crypto';

import { MAX_VISUALIZE_HISTORY, type VisualizeHistoryItem, type VisualizeInlineContent } from '../../shared/visualize';

/** Inline sources kept across all of a session's closed entries. */
export const MAX_HISTORY_INLINE_BYTES = 4 * 1024 * 1024;

export interface HistoryEntry {
  id: string;
  /** The tab's reuse identity: an open tab with this key is this entry. */
  key: string;
  label: string;
  /** The label a remote client may see. */
  remoteLabel: string;
  kind: VisualizeHistoryItem['kind'];
  /** File targets as the agent named them; empty for inline content. */
  targets: string[];
  content?: VisualizeInlineContent;
  at: number;
  versions: number;
}

export const historyId = (key: string): string => createHash('sha1').update(key).digest('hex').slice(0, 16);

const inlineBytes = (entry: HistoryEntry): number => (entry.content ? Buffer.byteLength(entry.content.source) : 0);

/** `entries` (newest first) with `entry` at the front in place of any older
 *  one of the same key, then trimmed to MAX_VISUALIZE_HISTORY entries and
 *  MAX_HISTORY_INLINE_BYTES of inline source; the oldest fall out first. */
export function rememberHistory(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...entries.filter((candidate) => candidate.key !== entry.key)].slice(0, MAX_VISUALIZE_HISTORY);
  let bytes = 0;
  const kept: HistoryEntry[] = [];
  for (const candidate of next) {
    bytes += inlineBytes(candidate);
    // The newest entry always stays, whatever its size (one source is capped).
    if (kept.length && bytes > MAX_HISTORY_INLINE_BYTES) continue;
    kept.push(candidate);
  }
  return kept;
}

/** The list the panel draws; `open` maps an open tab's key to its version count. */
export function historyItems(
  entries: readonly HistoryEntry[],
  open: ReadonlyMap<string, number>,
  remote: boolean
): VisualizeHistoryItem[] {
  return entries.map((entry) => {
    const live = open.get(entry.key);
    return {
      id: entry.id,
      label: remote ? entry.remoteLabel : entry.label,
      kind: entry.kind,
      versions: live ?? entry.versions,
      at: entry.at,
      open: live !== undefined,
    };
  });
}
