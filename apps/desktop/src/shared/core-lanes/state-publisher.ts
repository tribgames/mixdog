import {
  approvalSurface,
  desktopSessionState,
  streamPositionReached,
  type ProtocolClient,
  type SessionFold,
} from '../../../../../packages/protocol-client/src/index.ts';
import type { DesktopSessionStateUpdate, DesktopStreamPosition, SessionSnapshot } from '../contract';
import type { ProtocolConnection } from '../../main/protocol/connection';
import { advanceSnapshotRevision, snapshotRevisionFor } from './snapshot-revision';

type Client = ProtocolClient<SessionFold>;

export interface StatePublisher {
  subscribe(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  emit(update: DesktopSessionStateUpdate): void;
  publish(threadId: string): boolean;
  transcriptPending(threadId: string): boolean;
  /** The next frame published for the thread answers the read named by `readTraceId`. */
  expectRead(threadId: string, readTraceId: string): void;
  forgetRead(threadId: string): void;
  setInterest(next: ((threadId: string) => boolean) | null): void;
  dispose(): void;
}

/** The fold fields a projection reads; `frames` and `framedRevision` only count the core's frames. */
function sameProjectionInputs(before: SessionFold, after: SessionFold): boolean {
  if (before === after) return true;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === 'frames' || key === 'framedRevision') continue;
    if (
      !Object.is(
        (before as unknown as Record<string, unknown>)[key],
        (after as unknown as Record<string, unknown>)[key]
      )
    )
      return false;
  }
  return true;
}

export function createStatePublisher({
  protocol,
  held,
  decorated,
}: {
  protocol: Pick<ProtocolConnection, 'onStoreChange'>;
  held: () => Client | null;
  decorated: (client: Client, state: unknown) => SessionSnapshot;
}): StatePublisher {
  const stateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  const emit = (update: DesktopSessionStateUpdate): void => {
    for (const listener of [...stateListeners]) listener(update);
  };
  let interest: ((threadId: string) => boolean) | null = null;
  const interested = (threadId: string): boolean => interest === null || interest(threadId);
  /** The pending server requests a thread's state shows (its approval card), by id. */
  const requestsOf = (client: Client, threadId: string): string =>
    client
      .pendingServerRequests()
      .filter((request) => approvalSurface(request) === threadId)
      .map((request) => JSON.stringify(request.id))
      .join('\n');
  /** What each thread's last published state was projected from, keyed by the snapshot its fold grew from (`origin`). The
   *  client's folds of a subscribed thread all hold that key; once the subscription ends, by whatever path, the client drops
   *  them and the entry goes with them: nothing of a session is kept past its subscription. */
  const projected = new WeakMap<
    object,
    { fold: SessionFold; requests: string; snapshot: SessionSnapshot; position: DesktopStreamPosition | undefined }
  >();
  /** The feed position the thread's held fold was folded up to, every note counted (those that schedule no frame too). */
  const positionOf = (client: Client, threadId: string): DesktopStreamPosition | undefined => {
    const entry = client.store.thread(threadId);
    return entry ? { epoch: entry.feed.epoch, seq: entry.feed.seq, order: entry.order } : undefined;
  };
  const projectionOf = (fold: SessionFold) => (fold.origin ? projected.get(fold.origin) : undefined);
  const transcriptPending = (threadId: string): boolean => {
    const client = held();
    const subscription = client?.threadSubscription?.(threadId);
    return Boolean(
      subscription &&
        (subscription.snapshotPending ||
          subscription.replayPending ||
          (subscription.followed && !client?.feedPosition(threadId)))
    );
  };
  const due = (threadId: string): boolean => {
    const client = held();
    const fold = client?.store.thread(threadId)?.state;
    const last = fold && projectionOf(fold);
    if (!client || !fold || !last) return true;
    // A server request (an approval card) arriving or resolving publishes as it lands, whatever the frame state.
    const requests = requestsOf(client, threadId);
    if (requests !== last.requests) return true;
    // What the state shows changed: it is published by the frame that closes the change.
    if (!sameProjectionInputs(last.fold, fold)) return (fold.frames ?? 0) !== (last.fold.frames ?? 0);
    // Nothing the state shows changed (a frame that closes nothing new, or a note that schedules no frame: stage, model-request
    // and tool-batch telemetry): the state already published is current at this fold's position too. It is handed on again
    // with that position (no new projection), so what a call waits for (`feedPosition`, measured alike) is always reached.
    const streamPosition = positionOf(client, threadId);
    if (!streamPosition || (last.position && streamPositionReached(last.position, streamPosition))) return false;
    if (fold.origin) projected.set(fold.origin, { ...last, fold, requests, position: streamPosition });
    emit({ sessionId: threadId, snapshot: last.snapshot, frameSource: 'live', streamPosition });
    return false;
  };
  // The read a frame answers: a prefetch names its frame by trace id (ipc-state-bridge.ts admits it by that id).
  const pendingTraces = new Map<string, string>();
  const publish = (threadId: string): boolean => {
    const client = held();
    const fold = client?.store.thread(threadId)?.state;
    if (!client || !fold || transcriptPending(threadId)) return false;
    // Every publication of a thread, whatever asked for it, makes it one of the threads a host change republishes.
    shown.add(threadId);
    const baseSnapshot = decorated(
      client,
      desktopSessionState(fold, client.pendingServerRequests(), client.store.section('hostShellJobs')?.value)
    );
    const snapshotRevision = snapshotRevisionFor(fold.origin);
    const snapshot =
      snapshotRevision !== undefined && baseSnapshot
        ? ({ ...baseSnapshot, snapshotRevision } as SessionSnapshot)
        : baseSnapshot;
    const streamPosition = positionOf(client, threadId);
    if (fold.origin)
      projected.set(fold.origin, { fold, requests: requestsOf(client, threadId), snapshot, position: streamPosition });
    const readTraceId = pendingTraces.get(threadId);
    pendingTraces.delete(threadId);
    emit({
      sessionId: threadId,
      snapshot,
      frameSource: 'live',
      ...(readTraceId ? { readTraceId } : {}),
      ...(streamPosition ? { streamPosition } : {}),
    });
    return true;
  };
  // The threads a state was published of: a state also changes with what is not the thread's own (the host's shell jobs,
  // the remote channel's session).
  const shown = new Set<string>();
  const republishShown = (): void => {
    for (const threadId of [...shown]) {
      // Membership ends with the subscription: a thread the client no longer folds leaves, shown or not.
      if (!held()?.store.thread(threadId)) shown.delete(threadId);
      else if (interested(threadId)) publish(threadId);
    }
  };
  const offStore = protocol.onStoreChange((change) => {
    if (change.type === 'thread' && change.threadId) {
      // Approval updates share this signal with transcript folds. The request stays in the client and is
      // projected with the usable transcript, not with the old or partly replayed fold.
      if (!interested(change.threadId) || transcriptPending(change.threadId)) return;
      if (change.replayComplete) {
        const origin = held()?.store.thread(change.threadId)?.state.origin;
        if (origin) advanceSnapshotRevision(origin);
      }
      if (!change.replayComplete && !due(change.threadId)) return;
      publish(change.threadId);
    } else if (
      change.type === 'subscription' &&
      change.state === 'restored' &&
      change.feedId &&
      change.feedId !== 'app' &&
      !transcriptPending(change.feedId)
    ) {
      const origin = held()?.store.thread(change.feedId)?.state.origin;
      if (origin) advanceSnapshotRevision(origin);
    } else if (
      change.type === 'section' &&
      (change.section === 'hostShellJobs' || (change.section === 'hostState' && change.key === 'remoteSession'))
    ) {
      republishShown();
    } else if (change.type === 'subscription' && change.state === 'lost' && change.feedId && change.feedId !== 'app') {
      // The core no longer has the thread for this connection (deleted, or it refused to restore the subscription).
      shown.delete(change.feedId);
      emit({
        sessionId: change.feedId,
        snapshot: null as unknown as SessionSnapshot,
        frameSource: 'live',
        laneEnd: 'gone',
      });
    }
  });
  return {
    subscribe(listener) {
      stateListeners.add(listener);
      return () => void stateListeners.delete(listener);
    },
    emit,
    publish,
    transcriptPending,
    expectRead: (threadId, readTraceId) => void pendingTraces.set(threadId, readTraceId),
    forgetRead: (threadId) => void pendingTraces.delete(threadId),
    setInterest(next) {
      interest = next;
    },
    dispose() {
      offStore();
      stateListeners.clear();
      pendingTraces.clear();
      shown.clear();
    },
  };
}
