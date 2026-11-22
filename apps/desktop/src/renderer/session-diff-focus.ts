import { useEffect, useSyncExternalStore } from 'react';

/** A request for the session diff pane to open on one file. The requester
 *  (a transcript turn-changes card) posts it, then opens the pane through the
 *  same route as the composer's files segment; the pane consumes it once its
 *  diff has been re-read. */
export type SessionDiffFileRequest = { sessionId: string; path: string; root?: string; seq: number };

/** One turn's own changes, shown by the session's pane in place of its
 *  Changes source until the pane leaves it. Each open of the turn is a new
 *  `seq`. */
export type SessionDiffTurnTarget = {
  sessionId: string;
  checkpointId: string;
  /** The end the turn's card stands on: the pane reads the record the card read. */
  boundary: string;
  /** The file this open lands on ('' = the list of the turn's files). */
  path: string;
  /** Set (even empty) when `path` is a tool call's: relative to that call's
   *  folder, '' meaning the session's. Unset: `path` is the record's own. */
  cwd?: string;
  /** The files the turn's card leaves out as shown by its visualize cards. */
  visualized?: readonly string[];
  seq: number;
};

let current: SessionDiffFileRequest | null = null;
let turn: SessionDiffTurnTarget | null = null;
let sequence = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** A request to the Changes source ends the session's turn view. */
function publish(next: SessionDiffFileRequest | null) {
  current = next;
  if (next && turn?.sessionId === next.sessionId) turn = null;
  notify();
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

/** Shows one turn's own changes (what its changes card lists) in the session's
 *  pane, on `path` or, with an empty `path`, on the list of its files. The
 *  pane serves the latest thing asked of it: a request to the Changes source
 *  still waiting for this session is dropped. */
export function requestSessionDiffTurn(
  sessionId: string,
  { checkpointId, boundary }: { checkpointId: string; boundary: string },
  path: string,
  { cwd, visualized }: { cwd?: string; visualized?: readonly string[] } = {}
) {
  turn = { sessionId, checkpointId, boundary, path, seq: ++sequence };
  if (cwd !== undefined) turn.cwd = cwd;
  if (visualized?.length) turn.visualized = visualized;
  if (current?.sessionId === sessionId) current = null;
  notify();
}

/** Ends the session's turn view: its pane shows its Changes source again. */
export function closeSessionDiffTurn(sessionId: string) {
  if (turn?.sessionId !== sessionId) return;
  turn = null;
  notify();
}

/** A turn is shown for one session while its pane shows: another session, or
 *  hiding or closing the pane, ends it. Held by the pane and by the host that
 *  stands in for the pane while its module loads, so a turn asked for and left
 *  before the pane mounted is ended too. */
export function useSessionDiffTurnLifetime(sessionId: string, active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    return () => closeSessionDiffTurn(sessionId);
  }, [sessionId, active]);
}

/** The turn the session's pane shows, read outside React. */
export function sessionDiffTurnTarget(sessionId: string): SessionDiffTurnTarget | null {
  return turn && sessionId && turn.sessionId === sessionId ? turn : null;
}

export function useSessionDiffTurnTarget(sessionId: string): SessionDiffTurnTarget | null {
  const target = useSyncExternalStore(
    subscribe,
    () => turn,
    () => turn
  );
  return target && sessionId && target.sessionId === sessionId ? target : null;
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
