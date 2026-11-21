import { useEffect, useRef, useState } from 'react';
import type { DesktopModelSelection, DesktopStreamPosition } from '../shared/contract';
import { mergeRoutePreference } from './app-route-preference';
import { defaultSessionLaneStore, useSessionLaneStreamPosition } from './session-lane-store';

type SessionLaneStoreApi = typeof defaultSessionLaneStore;

type PendingSelection = {
  token: number;
  sessionId: string;
  selection: DesktopModelSelection;
  /** Set once the call answered: the stream position that ends the preview. */
  mark: DesktopStreamPosition | null;
};

/** What a call that just answered waits for on the session's stream: the position its connection has received on the feed,
 *  measured as the lane measures what it shows (the protocol client's positions: nothing of the lane's own history is read, so
 *  a publication between the answer and this read cannot make it unreachable). Null without a followed session. */
export async function streamMarkAfterCall(sessionId: string | undefined): Promise<DesktopStreamPosition | null> {
  if (!sessionId) return null;
  return window.mixdogDesktop.sessionStreamPosition(sessionId);
}

export function useModelSelection(
  sessionId: string,
  authoritative: DesktopModelSelection,
  store: SessionLaneStoreApi = defaultSessionLaneStore
) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const sequence = useRef(0);
  // Heard only while an answered pick waits for its mark.
  const position = useSessionLaneStreamPosition(pending?.mark ? sessionId : '', store);
  const active = pending?.sessionId === sessionId ? pending : null;
  const selection = active?.selection || authoritative;
  // biome-ignore lint/correctness/useExhaustiveDependencies: position is the trigger: a publication that moves it may reach the mark.
  useEffect(() => {
    if (
      pending &&
      (pending.sessionId !== sessionId || (pending.mark && store.streamReached(sessionId, pending.mark)))
    ) {
      setPending(null);
    }
  }, [pending, position, sessionId, store]);
  return {
    selection,
    pending: active !== null && !active.mark,
    begin(next: DesktopModelSelection) {
      const token = ++sequence.current;
      setPending({
        token,
        sessionId,
        selection: mergeRoutePreference(selection, next),
        mark: null,
      });
      return token;
    },
    /** The call answered (`mark`: what the stream must reach), or failed or had no stream to wait for (null). */
    settle(token: number, mark: DesktopStreamPosition | null) {
      setPending((current) => {
        if (!current || current.token !== token || current.sessionId !== sessionId) return current;
        return mark ? { ...current, mark } : null;
      });
    },
  };
}
