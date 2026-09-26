export const TRANSCRIPT_HISTORY_PAGE_ITEMS = 512;
/** Older items loaded per scroll-to-top when the host serves tail windows. */
export const TRANSCRIPT_TAIL_PAGE_ITEMS = 64;
const TRANSCRIPT_HISTORY_MAX_ITEMS = 2_048;

/** Next window for a host that serves tail windows and says whether older
 * history exists (`transcriptHasOlder`). `pagedFrom` is the item count the
 * last page was asked from (-1 before any): until that page lands and the
 * count grows past it, the next page waits. The host bounds each page by
 * bytes, so a landed page can hold fewer than TRANSCRIPT_TAIL_PAGE_ITEMS. */
export function nextTranscriptTailLimit(
  itemCount: number,
  pagedFrom: number,
  hasOlder: boolean,
  maxItems = TRANSCRIPT_HISTORY_MAX_ITEMS
): number | null {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  if (!hasOlder || count <= pagedFrom || count >= maxItems) return null;
  return Math.min(maxItems, count + TRANSCRIPT_TAIL_PAGE_ITEMS);
}

/** Next durable transcript window requested when the reader reaches the top.
 * Short sessions are already complete; long sessions grow one page at a time
 * and remain bounded even under repeated scroll events. This count-based rule
 * serves hosts that predate `transcriptHasOlder`. */
export function nextTranscriptHistoryLimit(
  itemCount: number,
  currentLimit: number,
  {
    pageItems = TRANSCRIPT_HISTORY_PAGE_ITEMS,
    maxItems = TRANSCRIPT_HISTORY_MAX_ITEMS,
  }: { pageItems?: number; maxItems?: number } = {}
): number | null {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  const page = Math.max(1, Math.floor(Number(pageItems) || TRANSCRIPT_HISTORY_PAGE_ITEMS));
  const maximum = Math.max(page, Math.floor(Number(maxItems) || TRANSCRIPT_HISTORY_MAX_ITEMS));
  const retained = Math.max(page, Math.floor(Number(currentLimit) || page), count);
  // A successful read can be acknowledged before its larger page arrives.
  // Do not issue the next page until that requested window is actually full.
  if (count < Math.max(page, Number(currentLimit) || page) || retained >= maximum) return null;
  return Math.min(maximum, retained + page);
}
