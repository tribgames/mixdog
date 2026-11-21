import type { DesktopSessionStateUpdate } from '../../shared/contract';
import { filterSessionIds, isSessionId, requiredSessionIds } from '../../shared/desktop-state';
import {
  createSessionReadWindow,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
} from '../../main/state-delta';
import { reportTranscriptRead } from '../../shared/transcript-read-diagnostics';
import type { SessionLanes } from './api-sessions.ts';
import type { DirectContext } from './context.ts';
import { withDirectErrors } from './errors.ts';

/** A read's frame travels the session feed while its reply travels the request, so the reply can land first and close the read
 *  window; the frame still carries the read's trace id and is admitted for this long. */
const REQUESTED_READ_FRAME_GRACE_MS = 10_000;
/** One in-flight resync per session; the next frame or this timeout ends it. */
const SESSION_RECOVERY_COALESCE_MS = 3_000;

type StateListener = (update: DesktopSessionStateUpdate) => void;

/** The session states this window is shown: the visible set, the reads it asked for and the resyncs in flight decide which
 *  frames of the session lane reach the page. */
export function createSessionStates(connection: DirectContext['connection'], lanes: SessionLanes) {
  const { service, session, onAttached } = lanes;
  const visible = new Set<string>();
  const reads = createSessionReadWindow();
  const readTraces = new Map<string, { sessionId: string; timer: ReturnType<typeof setTimeout> }>();
  const recoveries = new Map<string, ReturnType<typeof setTimeout>>();
  const latest = new Map<string, Omit<DesktopSessionStateUpdate, 'readTraceId'>>();
  const stateListeners = new Set<StateListener>();
  let visibleVersion = 0;

  const takeRecovery = (sessionId: string): boolean => {
    const timer = recoveries.get(sessionId);
    if (timer === undefined) return false;
    clearTimeout(timer);
    recoveries.delete(sessionId);
    return true;
  };
  /** True once for the frame answering a read this window requested. */
  const takeReadTrace = (sessionId: string, traceId: string | undefined): boolean => {
    if (!sessionId || !traceId) return false;
    const pending = readTraces.get(traceId);
    if (!pending || pending.sessionId !== sessionId) return false;
    clearTimeout(pending.timer);
    readTraces.delete(traceId);
    return true;
  };
  const rememberReadTrace = (traceId: string, sessionId: string): void => {
    const previous = readTraces.get(traceId);
    if (previous) clearTimeout(previous.timer);
    readTraces.set(traceId, {
      sessionId,
      timer: setTimeout(() => readTraces.delete(traceId), REQUESTED_READ_FRAME_GRACE_MS),
    });
  };
  const requestRecovery = (sessionId: string): void => {
    if (recoveries.has(sessionId)) return;
    recoveries.set(
      sessionId,
      setTimeout(() => recoveries.delete(sessionId), SESSION_RECOVERY_COALESCE_MS)
    );
    session.requestSessionStateResync(sessionId);
  };
  const emit = (update: DesktopSessionStateUpdate): void => {
    for (const listener of [...stateListeners]) listener(update);
  };
  const receive = (update: DesktopSessionStateUpdate): void => {
    const sessionId = String(update.sessionId || '');
    const answersRecovery = sessionId ? takeRecovery(sessionId) : false;
    const answersRead = takeReadTrace(sessionId, update.readTraceId) || answersRecovery;
    if (!sessionId || (!answersRead && !shouldPublishSessionState(sessionId, update.snapshot, visible, reads))) {
      reportTranscriptRead(sessionId, update.readTraceId, 'ipc-hidden');
      return;
    }
    if (update.snapshot && !answersRead && service.isReleasingThread(sessionId)) return;
    if (update.snapshot === null) {
      latest.delete(sessionId);
      emit(update);
      return;
    }
    const { readTraceId, ...baseline } = update;
    latest.set(sessionId, baseline);
    reportTranscriptRead(sessionId, readTraceId, 'ipc-send');
    emit(update);
  };
  session.subscribeSessionStates(receive);
  onAttached((id) => {
    if (!visible.has(id) || latest.get(id)?.frameSource === 'live') return;
    const client = connection.protocolClient();
    const subscription = client?.threadSubscription(id);
    if (subscription?.followed) {
      session.requestSessionStateResync(id);
    }
  });
  session.setInterest(
    (sessionId) =>
      visible.has(sessionId) ||
      reads.has(sessionId) ||
      recoveries.has(sessionId) ||
      [...readTraces.values()].some((pending) => pending.sessionId === sessionId)
  );

  return {
    subscribe(listener: StateListener): () => void {
      stateListeners.add(listener);
      return () => void stateListeners.delete(listener);
    },
    /** Runs a read the window asked for: the frame it publishes passes the visibility filter even when no pane shows the session yet. */
    read<T>(sessionId: string, traceId: string | undefined, run: () => Promise<T>): Promise<T> {
      if (traceId) rememberReadTrace(traceId, sessionId);
      return reads.run(sessionId, run);
    },
    async setVisible(sessionIds: unknown): Promise<boolean> {
      const ids = requiredSessionIds(sessionIds);
      visible.clear();
      for (const id of ids) visible.add(id);
      const released = releaseHiddenSessionStateEntries(visible, [latest], (sessionId) =>
        emit({ sessionId, snapshot: null } as unknown as DesktopSessionStateUpdate)
      );
      if (released.length > 0) {
        console.info(
          `[mixdog-lane] baseline released count=${released.length} visible=${ids.length} ids=${released
            .slice(0, 6)
            .map((sessionId) => sessionId.slice(-8))
            .join(',')}`
        );
      }
      return (
        (await withDirectErrors(
          service.call<unknown>('setVisibleSessions', [filterSessionIds(ids), ++visibleVersion])
        )) === true
      );
    },
    resync(sessionId: unknown, options?: { cachedOnly?: boolean; fresh?: boolean }): Promise<boolean> | undefined {
      const id = String(sessionId || '');
      if (!isSessionId(id) || session.transcriptPending(id)) return;
      const held = latest.get(id);
      if (options?.cachedOnly) {
        if (visible.has(id) && held?.frameSource === 'live') receive(held);
        return;
      }
      // `fresh`: the existing fold projected anew, with no transcript fetched (the held frame may show a request the client
      // no longer holds). Without a fold nothing is published; one bounded read is attempted, which no caller waits on.
      if (options?.fresh) {
        const before = latest.get(id);
        session.requestSessionStateResync(id);
        if (latest.get(id) !== before) return Promise.resolve(true);
        return Promise.race([
          session.prefetchSession(id).catch(() => false),
          new Promise<boolean>((resolve) => setTimeout(resolve, SESSION_RECOVERY_COALESCE_MS, false)),
        ]);
      }
      if (held) receive(held);
      else requestRecovery(id);
    },
  };
}
