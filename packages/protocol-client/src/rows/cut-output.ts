import type { Obj } from '../obj.ts';

/** What the core says of a row whose tool output it cut for a client that announced `toolOutput` (`meta.ext`, which `rowOf` copies
 *  onto the row): how long the output was, that the whole is read on request, the whole's line counts and where each text now ends. A
 *  card that merges rows (an aggregate's members) keeps them, or its member shows the cut text as the whole. */
export const CORE_CUT_FIELDS = [
  'remoteOutputTruncated',
  'remoteOutputOnRequest',
  'remoteOutputStats',
  'remoteOutputNotes',
] as const;

export interface CutOutputStats {
  lines: number;
  nonBlankLines: number;
}

/** The whole output's line counts a core-cut row states, or null. */
export function cutOutputStatsOf(row: Obj): CutOutputStats | null {
  const stats = row.remoteOutputStats;
  if (!stats || typeof stats !== 'object') return null;
  const { lines, nonBlankLines } = stats as Obj;
  return Number.isInteger(lines) && Number.isInteger(nonBlankLines)
    ? { lines: lines as number, nonBlankLines: nonBlankLines as number }
    : null;
}

/** The text with as many lines after it as the whole output had beyond it, as many of them not blank: what the card's facts read of
 *  the whole output, which is its head, its exit lines and these counts. */
export function paddedToWholeLines(text: string, stats: CutOutputStats): string {
  const held = text.split('\n');
  const missing = stats.lines - held.length;
  const missingNonBlank = stats.nonBlankLines - held.filter((line) => line.trim()).length;
  if (missing < 0 || missingNonBlank < 0 || missingNonBlank > missing) return text;
  // Blank lines first: the output ends on a line with text (its trailing blank space is not counted).
  return text + Array.from({ length: missing }, (_, index) => (index < missing - missingNonBlank ? '\n' : '\nx')).join('');
}
