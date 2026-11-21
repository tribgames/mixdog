export interface NewTabWatch {
  /** The new page's id, or null when this request got no tab of its own. */
  readonly page: Promise<string | null>;
  /** Stop waiting (the request failed before asking the pane). */
  cancel(): void;
}

/** How long a request waits for the pane to create its tab. */
const NEW_TAB_WAIT_MS = 3_000;

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
