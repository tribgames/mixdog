/** The browser nav row is the only width-adaptive row of the dock. Narrowing
 *  hides Forward first, then Import; Back, Reload and the address field always
 *  stay. */
export const BROWSER_NAV_SLOT_WIDTH = 30;
export const BROWSER_NAV_PADDING = 12;
export const BROWSER_NAV_ADDRESS_MIN_WIDTH = 120;

export function browserNavLayout(width: number, hasImport: boolean): { forward: boolean; import: boolean } {
  // Unmeasured row: show everything.
  if (width <= 0) return { forward: true, import: hasImport };
  // Back + Reload + the address field's floor are the fixed base.
  const base = BROWSER_NAV_PADDING + 2 * BROWSER_NAV_SLOT_WIDTH + BROWSER_NAV_ADDRESS_MIN_WIDTH;
  const importShown = hasImport && width >= base + BROWSER_NAV_SLOT_WIDTH;
  // Forward needs room beyond Import, so it goes first when the row narrows.
  const forwardShown = width >= base + BROWSER_NAV_SLOT_WIDTH * (hasImport ? 2 : 1);
  return { forward: forwardShown, import: importShown };
}
