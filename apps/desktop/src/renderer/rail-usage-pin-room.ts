/** Layout constants of .rail-usage-pin-ring / -stack / .is-pinned in
 *  09-sidebar-chrome.css: one 26px ring per slot, two rings included. */
const PIN_ROW_HEIGHT = 26;
const PIN_ROW_GAP = 10;
const PIN_STACK_PADDING = 8 + 8;

export function usagePinStackHeight(rowCount: number): number {
  if (rowCount <= 0) return 0;
  return PIN_STACK_PADDING + rowCount * PIN_ROW_HEIGHT + (rowCount - 1) * PIN_ROW_GAP;
}

/** Layout height of one scroll chevron above or below the slots. */
const PIN_CHEVRON_HEIGHT = 12;

/** True when every rail part fits at its natural height with the stack shown. */
export function usagePinStackFits(input: {
  railHeight: number;
  navHeight: number;
  settingsHeight: number;
  rowCount: number;
  /** Height of the scroll chevrons, when the stack scrolls. */
  chevronHeight?: number;
}): boolean {
  if (input.rowCount <= 0) return true;
  const needed =
    input.navHeight + usagePinStackHeight(input.rowCount) + (input.chevronHeight ?? 0) + input.settingsHeight;
  return input.railHeight >= needed;
}

/** How many of `total` slots the rail shows: at most `limit`, fewer when the
 *  rail is short so the stack never reaches the destinations above or Settings
 *  below. Chevron room is reserved whenever slots are left out. 0 = not even
 *  one fits (the pie glyph). */
export function usagePinVisibleCount(
  input: Omit<Parameters<typeof usagePinStackFits>[0], 'rowCount' | 'chevronHeight'> & {
    total: number;
    limit: number;
  }
): number {
  for (let count = Math.min(input.total, input.limit); count > 0; count -= 1) {
    const fits = usagePinStackFits({
      ...input,
      rowCount: count,
      chevronHeight: count < input.total ? 2 * PIN_CHEVRON_HEIGHT : 0,
    });
    if (fits) return count;
  }
  return 0;
}
