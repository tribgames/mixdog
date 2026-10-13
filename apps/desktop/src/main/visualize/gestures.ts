/**
 * Real user gestures inside visualize panes, observed by main from the main
 * window's input (outside any page's control). Each mouse release or
 * Enter/Space press that lands in one pane mints one short-lived token for
 * that (session, tab, pane); a `data-choice` pick from the pane's page is
 * accepted only by consuming one, so one gesture carries at most one choice
 * and a page cannot pick while the user works elsewhere.
 */

export interface VisualizeGestureTarget {
  sessionId: string;
  tabId: string;
  pane: number;
}

export const VISUALIZE_GESTURE_TTL_MS = 1_000;
const MAX_TOKENS = 8;

/** Renderer query: the pane whose own iframe element is the topmost element
 *  at `point` (window CSS px), or null. Panel UI drawn over a pane (the
 *  Comment layer, a confirm bar) is hit instead of the frame, so a click on
 *  it is never a gesture in the page. */
export function visualizePaneHitQuery(point: { x: number; y: number }): string {
  return `((x, y) => {
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit.tagName !== 'IFRAME') return null;
  const cell = hit.parentElement && hit.parentElement.closest('[data-visualize-pane]');
  const body = cell && cell.closest('[data-visualize-body]');
  if (!cell || !body || body.closest('[inert], [hidden], [aria-hidden="true"]')) return null;
  if (cell.querySelector('iframe') !== hit) return null;
  return {
    sessionId: body.dataset.visualizeSession || '',
    tabId: body.dataset.visualizeTab || '',
    pane: Number(cell.dataset.visualizePane),
  };
})(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)})`;
}

/** The renderer's answer to the hit query, checked; null when it names none. */
export function visualizeGestureTarget(value: unknown): VisualizeGestureTarget | null {
  if (!value || typeof value !== 'object') return null;
  const target = value as Partial<VisualizeGestureTarget>;
  if (typeof target.sessionId !== 'string' || !target.sessionId) return null;
  if (typeof target.tabId !== 'string' || !target.tabId) return null;
  if (!Number.isInteger(target.pane) || (target.pane as number) < 0) return null;
  return { sessionId: target.sessionId, tabId: target.tabId, pane: target.pane as number };
}

export function createVisualizeGestureTokens(now: () => number = Date.now) {
  let tokens: Array<VisualizeGestureTarget & { at: number }> = [];
  const pending = new Set<Promise<unknown>>();
  const prune = () => {
    const cutoff = now() - VISUALIZE_GESTURE_TTL_MS;
    tokens = tokens.filter((token) => token.at >= cutoff).slice(-MAX_TOKENS);
  };
  return {
    mint(target: VisualizeGestureTarget): void {
      tokens.push({ ...target, at: now() });
      prune();
    },
    /** A gesture whose pane is still being resolved: consumers wait for it. */
    track(lookup: Promise<unknown>): void {
      const settled = lookup.catch(() => {}).finally(() => pending.delete(settled));
      pending.add(settled);
    },
    /** Take one live token for this pane; false when there is none. */
    async consume(target: VisualizeGestureTarget): Promise<boolean> {
      if (pending.size) await Promise.all([...pending]);
      prune();
      const index = tokens.findIndex(
        (token) => token.sessionId === target.sessionId && token.tabId === target.tabId && token.pane === target.pane
      );
      if (index < 0) return false;
      tokens.splice(index, 1);
      return true;
    },
  };
}

export type VisualizeGestureTokens = ReturnType<typeof createVisualizeGestureTokens>;
