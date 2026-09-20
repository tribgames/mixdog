/** Focus-trap step for Tab / Shift+Tab over `count` focusables, wrapping at both ends. */
export function trappedTabIndex(current: number, count: number, backward: boolean): number {
  if (backward) return current <= 0 ? count - 1 : current - 1;
  return current < 0 || current === count - 1 ? 0 : current + 1;
}

/** Wrapping index for Home/End/arrow list navigation; `delta` is the arrow step (±1). */
export function wrappedNavigationIndex(key: string, current: number, count: number, delta: number): number {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return (current + delta + count) % count;
}
