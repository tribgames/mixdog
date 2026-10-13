import { useSyncExternalStore } from 'react';

/** A request for the session diff pane to open on one file. The requester
 *  (a transcript turn-changes card) posts it, then opens the pane through the
 *  same route as the composer's files segment; the pane consumes it once its
 *  diff has been re-read. */
export type SessionDiffFileRequest = { sessionId: string; path: string; root?: string; seq: number };

let current: SessionDiffFileRequest | null = null;
let sequence = 0;
const listeners = new Set<() => void>();

function publish(next: SessionDiffFileRequest | null) {
  current = next;
  for (const listener of listeners) listener();
}

/** `path: null` cancels a pending request (the pane opens as it was). */
export function requestSessionDiffFile(sessionId: string, path: string | null, root?: string) {
  if (!path) {
    publish(null);
    return;
  }
  const request: SessionDiffFileRequest = { sessionId, path, seq: ++sequence };
  if (root) request.root = root;
  publish(request);
}

/** The pane keys a file by the path the diff lists: absolute when roots are
 *  mixed. A request carrying its root names the file by root + path first, and
 *  only then by the bare relative path. */
export function sessionDiffRequestPaths(request: { path: string; root?: string }): string[] {
  const clean = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
  const path = clean(request.path);
  const root = request.root ? clean(request.root).replace(/\/+$/, '') : '';
  return root && !/^(?:\/|[A-Za-z]:\/)/.test(path) ? [`${root}/${path}`, path] : [path];
}

/** Asks the pane to land on the list of every changed file (the island's
 *  files segment), even if it is already open on one file's diff. An empty
 *  `path` marks the request as the list. */
export function requestSessionDiffList(sessionId: string) {
  publish({ sessionId, path: '', seq: ++sequence });
}

/** The request still waiting for this session's pane, read outside React
 *  (what is opening the pane right now). */
export function pendingSessionDiffFileRequest(sessionId: string): SessionDiffFileRequest | null {
  return requestFor(current, sessionId);
}

function requestFor(request: SessionDiffFileRequest | null, sessionId: string): SessionDiffFileRequest | null {
  return request && sessionId && request.sessionId === sessionId ? request : null;
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
  return requestFor(request, sessionId);
}
