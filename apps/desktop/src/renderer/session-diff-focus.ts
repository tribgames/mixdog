import { useSyncExternalStore } from 'react';

/** A request for the session diff pane to open on one file. The requester
 *  (a transcript turn-changes card) posts it, then opens the pane through the
 *  same route as the composer's files segment; the pane consumes it once its
 *  diff has been re-read. */
export type SessionDiffFileRequest = { sessionId: string; path: string; seq: number };

let current: SessionDiffFileRequest | null = null;
let sequence = 0;
const listeners = new Set<() => void>();

function publish(next: SessionDiffFileRequest | null) {
  current = next;
  for (const listener of listeners) listener();
}

/** `path: null` cancels a pending request (the pane opens as it was). */
export function requestSessionDiffFile(sessionId: string, path: string | null) {
  publish(path ? { sessionId, path, seq: ++sequence } : null);
}

export function consumeSessionDiffFileRequest(seq: number) {
  if (current?.seq === seq) publish(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionDiffFileRequest(sessionId: string): SessionDiffFileRequest | null {
  const request = useSyncExternalStore(
    subscribe,
    () => current,
    () => current
  );
  return request && sessionId && request.sessionId === sessionId ? request : null;
}
