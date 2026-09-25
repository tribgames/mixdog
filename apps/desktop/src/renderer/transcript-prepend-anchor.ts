/**
 * Scroll compensation for rows inserted ABOVE the reader: older transcript
 * history loads into the head of the list while the reader looks at rows
 * below it. With end anchoring off (the reader scrolled up), the virtual core
 * keeps the raw offset, so every older page would push the visible rows down
 * by the page's height. The rows that were already laid out keep their sizes;
 * only their starts move, so the shift is where the first surviving previous
 * row starts now minus where it started before.
 */
export const MAX_SURVIVOR_PROBE = 8;

export function prependedRowsShift<K>({
  previousKeys,
  indexOfKey,
  startOf,
  sizeOfKey,
  paddingStart,
}: {
  /** Row keys of the previous commit, first rows first. */
  previousKeys: readonly K[];
  /** Index of a key in the current rows, or -1. */
  indexOfKey(key: K): number;
  /** Start offset of a current row. */
  startOf(index: number): number | undefined;
  /** Laid-out size of a previous row. */
  sizeOfKey(key: K): number;
  paddingStart: number;
}): number {
  let previousStart = paddingStart;
  for (let index = 0; index < Math.min(previousKeys.length, MAX_SURVIVOR_PROBE); index += 1) {
    const key = previousKeys[index];
    const current = indexOfKey(key);
    if (current >= 0) {
      const start = startOf(current);
      return start === undefined ? 0 : start - previousStart;
    }
    previousStart += sizeOfKey(key);
  }
  return 0;
}
