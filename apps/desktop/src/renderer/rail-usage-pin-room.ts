// Pinned usage stack vs. rail height (user: USAGE 공간이 위쪽 메뉴 침범하면
// 아이콘으로 자동 전환): the stack is one brand row per pinned provider, and
// on a short window it pushed the destination list into a scroller. The rail
// measures itself and folds the stack back to the pie glyph whenever the
// destinations, the stack and Settings cannot all keep whole cells.

/** Layout constants of .rail-usage-pin-brand / .is-pinned in 09-sidebar-chrome.css. */
const PIN_ROW_HEIGHT = 16 + 2 + 3 + 2 + 11;
const PIN_ROW_GAP = 10;
const PIN_STACK_PADDING = 9 + 8;

export function usagePinStackHeight(rowCount: number): number {
  if (rowCount <= 0) return 0;
  return PIN_STACK_PADDING + rowCount * PIN_ROW_HEIGHT + (rowCount - 1) * PIN_ROW_GAP;
}

/** True when every rail part fits at its natural height with the stack shown. */
export function usagePinStackFits(input: {
  railHeight: number;
  navHeight: number;
  settingsHeight: number;
  rowCount: number;
}): boolean {
  if (input.rowCount <= 0) return true;
  const needed = input.navHeight + usagePinStackHeight(input.rowCount) + input.settingsHeight;
  return input.railHeight >= needed;
}
