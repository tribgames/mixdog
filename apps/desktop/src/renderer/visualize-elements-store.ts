// A click on a row of the panel's Elements list asks the Comment layer of that
// pane to start a pin on the row's element. The request is a single pending
// slot that only the panel itself fills (from a trusted click) and only the
// matching Comment layer takes, once and while still fresh.
import { useSyncExternalStore } from 'react';

export interface VisualizeElementPinRequest {
  tabId: string;
  pane: number;
  selector: string;
}

/** A request nobody took (Comment mode never came on) is dropped after this. */
export const VISUALIZE_ELEMENT_PIN_TTL_MS = 5_000;

let pending: (VisualizeElementPinRequest & { at: number }) | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function requestVisualizeElementPin(request: VisualizeElementPinRequest, now = performance.now()): void {
  pending = { ...request, at: now };
  notify();
}

/** The pending request, once, if it is for this pane and still fresh. */
export function takeVisualizeElementPin(
  tabId: string,
  pane: number,
  now = performance.now()
): VisualizeElementPinRequest | null {
  const request = pending;
  if (!request || request.tabId !== tabId || request.pane !== pane) return null;
  pending = null;
  notify();
  return now - request.at <= VISUALIZE_ELEMENT_PIN_TTL_MS
    ? { tabId: request.tabId, pane: request.pane, selector: request.selector }
    : null;
}

/** Re-renders a Comment layer when a request for its pane arrives. */
export function useVisualizeElementPinPending(tabId: string, pane: number): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => pending !== null && pending.tabId === tabId && pending.pane === pane,
    () => false
  );
}

/** Test seam. */
export function resetVisualizeElementPins(): void {
  pending = null;
  notify();
}
