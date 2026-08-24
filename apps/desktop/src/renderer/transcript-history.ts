export const TRANSCRIPT_HISTORY_PAGE_ITEMS = 512;
export const TRANSCRIPT_HISTORY_MAX_ITEMS = 2_048;

/** Next durable transcript window requested when the reader reaches the top.
 * Short sessions are already complete; long sessions grow one page at a time
 * and remain bounded even under repeated scroll events. */
export function nextTranscriptHistoryLimit(
  itemCount: number,
  currentLimit: number,
  {
    pageItems = TRANSCRIPT_HISTORY_PAGE_ITEMS,
    maxItems = TRANSCRIPT_HISTORY_MAX_ITEMS,
  }: { pageItems?: number; maxItems?: number } = {},
): number | null {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  const page = Math.max(1, Math.floor(Number(pageItems) || TRANSCRIPT_HISTORY_PAGE_ITEMS));
  const maximum = Math.max(page, Math.floor(Number(maxItems) || TRANSCRIPT_HISTORY_MAX_ITEMS));
  const retained = Math.max(page, Math.floor(Number(currentLimit) || page), count);
  if (count < page || retained >= maximum) return null;
  return Math.min(maximum, retained + page);
}
