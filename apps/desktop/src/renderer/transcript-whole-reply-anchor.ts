import { type TranscriptVirtualizer, viewportSize } from './transcript-list-geometry';
import type { TranscriptRowModel } from './transcript-rows';

/** A reply taller than this share of the viewport opens at its first line. */
export const WHOLE_REPLY_VIEWPORT_SHARE = 0.9;
/** Room left above the reply's first line. */
export const WHOLE_REPLY_TOP_GAP_PX = 12;
/** Rows at the end that can hold a reply that just landed (the reply, the
 *  turn gap and footer under it, a room's next typing bubble). */
const TAIL_ROWS = 6;

/**
 * An agent chat or room shows a reply only once it is complete
 * (agentReplyUnfinished), so a long reply lands in one frame. Pinned to the
 * end, the followed reader was carried to the reply's LAST line, its start
 * screens above. `take(max)` returns where a pinned viewport goes instead
 * when the end pin finds such a reply freshly measured: its first line. The
 * end pin then lets go of follow; reaching the bottom re-attaches it.
 *
 * A reply qualifies once: a row that arrived while follow held, after the
 * list mounted (rows restored on entry never move the reader), and that a
 * single pin step grew by at least WHOLE_REPLY_VIEWPORT_SHARE of the viewport
 * (a message landing whole, a caught-up burst). The same rule serves every
 * surface: a reply that settles in smaller steps (markdown parsing, an image
 * decoding) is followed to its end, as the reader's follow rules say, in a
 * bot's chat as in a session.
 */
export function createWholeReplyAnchor({
  getRows,
  getVirtualizer,
  getScrollInset,
}: {
  getRows(): readonly TranscriptRowModel[];
  getVirtualizer(): TranscriptVirtualizer;
  /** Where the rows start inside the scroll content (the thread's padding). */
  getScrollInset(): number;
}) {
  // Row keys present on the first pin with rows: what the reader opened.
  let mounted: Set<string> | null = null;
  // Measured size of each tail row at the previous pin.
  let previous = new Map<string, number>();
  const settled = new Set<string>();
  return {
    /** Follow let go: what lands meanwhile is the reader's to scroll to, so
     *  the rows present when follow returns count as already seen. */
    release() {
      mounted = null;
      previous = new Map();
    },
    take(max: number): number | null {
      const rows = getRows();
      if (!rows.length) return null;
      if (!mounted) {
        mounted = new Set(rows.map((row) => row.key));
        return null;
      }
      const instance = getVirtualizer();
      const threshold = viewportSize(instance) * WHOLE_REPLY_VIEWPORT_SHARE;
      const sizes = new Map<string, number>();
      let target: number | null = null;
      for (let index = Math.max(0, rows.length - TAIL_ROWS); index < rows.length; index += 1) {
        const row = rows[index] as TranscriptRowModel;
        const size = instance.itemSizeCache.get(row.key) ?? 0;
        sizes.set(row.key, size);
        if (target !== null || row._tag !== 'AssistantPart' || threshold <= 0) continue;
        if (mounted.has(row.key) || settled.has(row.key) || size < threshold) continue;
        // A reply is judged by every step of its growth.
        if (size - (previous.get(row.key) ?? 0) < threshold) continue;
        settled.add(row.key);
        const start = instance.measurementsCache[index]?.start;
        if (start === undefined) continue;
        target = Math.max(0, Math.min(max, getScrollInset() + start - WHOLE_REPLY_TOP_GAP_PX));
      }
      previous = sizes;
      return target;
    },
  };
}
