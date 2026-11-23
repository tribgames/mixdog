// Opening a session at a record of its history (a search hit): the pane that shows the session takes the record as its
// reader's place (transcript-list-reader-place.ts), which is how a reader comes back to any place: the rows around
// the record are read if they are not held, and the reader is put on its row before the pane presents it.
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { usePaneKey } from './pane-key-context';
import { useSurfaceActive } from './surface-activity';
import { openReaderPlace } from './transcript-list-reader-place';

interface Jump {
  readonly position: string;
}

const jumps = new Map<string, Jump>();
const listeners = new Set<() => void>();
const changed = (): void => {
  for (const listener of [...listeners]) listener();
};

/** The session's pane opens at `position` (the next pane of the session to show rows takes it). A jump belongs to the
 *  navigation that made it, which shows the session in a pane right after: it ends when that pane takes it, when a
 *  later jump takes its place, or when a pane goes on to show another session instead (the reader navigated on, and
 *  a later visit of the session is not that jump's). No time ends it. */
export function requestTranscriptJump(sessionId: string, position: string): void {
  if (!sessionId || !position) return;
  jumps.clear();
  jumps.set(sessionId, { position });
  changed();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** A pane's part in a jump of its session: the one on screen takes the jump's record as its reader's place and leaves
 *  the live tail, in the commit it learns of the jump, so no frame of the session's end is presented first. */
export function useTranscriptJump({ sessionId, leaveTail }: { sessionId: string; leaveTail: () => void }): void {
  const pane = usePaneKey();
  const active = useSurfaceActive();
  const jump = useSyncExternalStore(subscribe, () => (sessionId ? jumps.get(sessionId) : undefined));
  // This pane has come to show the session: a jump still waiting for another one is of a navigation that is over.
  useLayoutEffect(() => {
    if (!active || !sessionId) return;
    let ended = false;
    for (const waiting of [...jumps.keys()]) {
      if (waiting === sessionId) continue;
      jumps.delete(waiting);
      ended = true;
    }
    if (ended) changed();
  }, [active, sessionId]);
  useLayoutEffect(() => {
    if (!jump || !active || !pane) return;
    jumps.delete(sessionId);
    changed();
    leaveTail();
    openReaderPlace(pane, sessionId, { position: jump.position, top: 'center' });
  }, [active, jump, leaveTail, pane, sessionId]);
}
