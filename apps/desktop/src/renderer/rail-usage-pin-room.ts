// Pinned usage stack vs. rail height (user: USAGE 공간이 위쪽 메뉴 침범하면
// 아이콘으로 자동 전환): the stack is one brand row per pinned provider, and
// on a short window it pushed the destination list into a scroller. The rail
// measures itself and folds the stack back to the pie glyph whenever the
// destinations, the stack and Settings cannot all keep whole cells.

/** Layout constants of .rail-usage-pin-brand / .is-pinned in 09-sidebar-chrome.css. */
const PIN_ROW_HEIGHT = 16 + 2 + 3 + 2 + 11;
const PIN_ROW_GAP = 10;
const PIN_STACK_PADDING = 9 + 8;

/** A second 3px meter plus its 2px gap. */
const PIN_EXTRA_BAR_HEIGHT = 3 + 2;

export function usagePinStackHeight(rowCount: number, doubleBarCount = 0): number {
  if (rowCount <= 0) return 0;
  return (
    PIN_STACK_PADDING +
    rowCount * PIN_ROW_HEIGHT +
    (rowCount - 1) * PIN_ROW_GAP +
    Math.min(doubleBarCount, rowCount) * PIN_EXTRA_BAR_HEIGHT
  );
}

/** Layout height of one scroll chevron above or below the slots. */
export const PIN_CHEVRON_HEIGHT = 12;

/** True when every rail part fits at its natural height with the stack shown. */
export function usagePinStackFits(input: {
  railHeight: number;
  navHeight: number;
  settingsHeight: number;
  rowCount: number;
  /** Rows drawing two meters (short + long mode). */
  doubleBarCount?: number;
  /** Height of the scroll chevrons, when the stack scrolls. */
  chevronHeight?: number;
}): boolean {
  if (input.rowCount <= 0) return true;
  const needed =
    input.navHeight +
    usagePinStackHeight(input.rowCount, input.doubleBarCount) +
    (input.chevronHeight ?? 0) +
    input.settingsHeight;
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
