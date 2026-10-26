/**
 * Who asked for a session's new tab. The visualize tool opens a URL by asking
 * the pane to create a tab and names the request; the pane's `new-tab`
 * control carries that name to the session tab strip, which reports the page
 * it made. Only the waiter with that request id gets the page, so a tab
 * nobody named (the user's "+") and an older page at the same address are
 * never mistaken for the one this request created.
 *
 * Another request's tab says nothing about this one: its tab may still be on
 * its way through a slower pane, so it never settles this waiter. A waiter
 * settles with null only when its wait times out, it is cancelled, a new watch
 * reuses its request id, or its session is released (or the host disposed).
 * The pane gives no acknowledgement when it drops or replaces a request (it
 * keeps only its latest pending address), so such a request also ends by the
 * timeout.
 */
export interface NewTabWatch {
  /** The new page's id, or null when this request got no tab of its own. */
  readonly page: Promise<string | null>;
  /** Stop waiting (the request failed before asking the pane). */
  cancel(): void;
}

/** How long a request waits for the pane to create its tab. */
export const NEW_TAB_WAIT_MS = 3_000;

interface Waiter {
  sessionId: string;
  settle(pageId: string | null): void;
}

export function createNewTabWaiters(waitMs = NEW_TAB_WAIT_MS) {
  const waiting = new Map<string, Waiter>();

  function watch(sessionId: string, requestId: string): NewTabWatch {
    waiting.get(requestId)?.settle(null);
    let settle: (pageId: string | null) => void = () => {};
    const page = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => settle(null), waitMs);
      settle = (pageId) => {
        clearTimeout(timer);
        if (waiting.get(requestId)?.settle === settle) waiting.delete(requestId);
        resolve(pageId);
      };
      waiting.set(requestId, { sessionId, settle });
    });
    return { page, cancel: () => settle(null) };
  }

  /** The session's strip made `pageId` for a new tab (`requestId`: who asked). */
  function created(sessionId: string, pageId: string, requestId?: string): void {
    if (!requestId) return;
    const waiter = waiting.get(requestId);
    if (!waiter || waiter.sessionId !== sessionId) return;
    waiter.settle(pageId);
  }

  /** The session's browser is released: nothing it asked for will arrive. */
  function cancelSession(sessionId: string): void {
    for (const waiter of [...waiting.values()]) if (waiter.sessionId === sessionId) waiter.settle(null);
  }

  function cancelAll(): void {
    for (const waiter of [...waiting.values()]) waiter.settle(null);
  }

  return { watch, created, cancelSession, cancelAll };
}
