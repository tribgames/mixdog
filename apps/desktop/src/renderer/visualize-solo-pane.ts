// A split visualize tab (2-3 panes side by side) can show one pane alone at
// full size: a click on a pane (or its hover name chip) picks it, the zoom
// pill's ‹ / › and the ←/→ keys step through the panes, and Esc or the pill's
// split button returns to the split. Remembered per tab for this renderer
// only (never persisted): another tab, or a reload, starts in the split.
import { useSyncExternalStore } from 'react';

const shown = new Map<string, number>();
const listeners = new Set<() => void>();

const keyOf = (sessionId: string, tabId: string) => `${sessionId}\0${tabId}`;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The pane shown alone in a tab of `count` panes, or null for the split
 *  (also when the tab has one pane, or fewer panes than the remembered one). */
export function visualizeSoloPane(sessionId: string, tabId: string, count: number): number | null {
  const index = shown.get(keyOf(sessionId, tabId));
  return count > 1 && index !== undefined && index < count ? index : null;
}

/** Show pane `index` alone; null returns the tab to the split. */
export function setVisualizeSoloPane(sessionId: string, tabId: string, index: number | null): void {
  const key = keyOf(sessionId, tabId);
  if ((shown.get(key) ?? null) === index) return;
  if (index === null) shown.delete(key);
  else shown.set(key, index);
  emit();
}

/** The pane one step (`-1` back, `1` on) from `index`, wrapping around. */
export function visualizeSoloStep(index: number, count: number, direction: -1 | 1): number {
  return (index + direction + count) % count;
}

export function useVisualizeSoloPane(sessionId: string, tabId: string, count: number): number | null {
  return useSyncExternalStore(
    subscribe,
    () => visualizeSoloPane(sessionId, tabId, count),
    () => null
  );
}
