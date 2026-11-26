import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { subscribeFramedSessionStates } from '../../../../packages/protocol-client/src/index.ts';
import type {
  DesktopSessionLaneEnd,
  DesktopSessionStateUpdate,
  DesktopStreamPosition,
  SessionSnapshot,
} from '../shared/contract';
import { advanceSnapshotRevision, snapshotRevisionFor } from '../shared/core-lanes/snapshot-revision';

type Client = ProtocolClient<SessionFold>;

export interface SessionStateFollower {
  /** The thread was deleted (the answer to this client's own delete): its lane ends as gone, shown or released. */
  gone(threadId: string): void;
  /** The view settled: each shown thread the client no longer follows ends as unloaded. */
  sweep(): void;
  /** Publishes the thread's current state again (the feed has nothing new to publish); false when the client does not fold it. */
  republish(threadId: string): boolean;
  /** This client is replaced or the page closes: nothing of it is published after this. */
  stop(): void;
}

export function followSessionStates(
  client: Client,
  options: {
    publish(update: DesktopSessionStateUpdate): void;
    /** The state as the page is shown it (the remote channel's session laid over it). */
    decorate(state: unknown): SessionSnapshot;
    /** The current state of a thread this client folds (`sessionStateOf`). */
    stateOf(threadId: string): unknown;
  }
): SessionStateFollower {
  // The library's own record of what it follows (client.ts `threadSubscription`, not on the `ProtocolClient` interface): a control
  // thread it only holds is no session of the page's.
  const library = client as unknown as {
    threadSubscription(threadId: string): {
      readonly followed: boolean;
      readonly snapshotPending?: boolean;
      readonly replayPending?: boolean;
    };
  };
  // Threads whose lane is live on the page, and threads the page was shown and that ended as unloaded (their baseline is kept).
  const shown = new Set<string>();
  const released = new Set<string>();
  let stopped = false;
  const end = (threadId: string, laneEnd: DesktopSessionLaneEnd): void => {
    options.publish({
      sessionId: threadId,
      snapshot: null as unknown as SessionSnapshot,
      frameSource: 'live',
      laneEnd,
    });
  };
  /** The page's snapshot of each heard state, keyed by authoritative revision and replay state so a state heard current
   *  at a later position keeps the same object while replay transitions and post-replay syncs emit fresh snapshots. */
  const decorated = new WeakMap<
    object,
    { revision: number | undefined; replayPending: boolean; snapshot: SessionSnapshot }
  >();
  const fallbackRevisions = new Map<string, number>();
  const pendingReplayPublish = new Set<string>();
  const positionOf = (threadId: string): DesktopStreamPosition | undefined => {
    const entry = client.store.thread(threadId);
    return entry ? { epoch: entry.feed.epoch, seq: entry.feed.seq, order: entry.order } : undefined;
  };
  const revisionOf = (threadId: string): number | undefined => {
    const origin = client.store.thread(threadId)?.state.origin;
    return origin ? snapshotRevisionFor(origin) : fallbackRevisions.get(threadId);
  };
  const show = (threadId: string, state: unknown, streamPosition?: DesktopStreamPosition): void => {
    shown.add(threadId);
    released.delete(threadId);
    pendingReplayPublish.delete(threadId);
    const snapshotRevision = revisionOf(threadId);
    const replayPending = library.threadSubscription(threadId).replayPending === true;
    const cached = state && typeof state === 'object' ? decorated.get(state) : undefined;
    let snapshot =
      cached && cached.revision === snapshotRevision && cached.replayPending === replayPending
        ? cached.snapshot
        : undefined;
    if (!snapshot) {
      const base = options.decorate(state);
      snapshot = base
        ? ({
            ...base,
            ...(snapshotRevision !== undefined ? { snapshotRevision } : {}),
            ...(replayPending ? { replayPending: true as const } : {}),
          } as SessionSnapshot)
        : base;
      if (state && typeof state === 'object') {
        decorated.set(state, { revision: snapshotRevision, replayPending, snapshot });
      }
    }
    options.publish({
      sessionId: threadId,
      snapshot,
      frameSource: 'live',
      ...(streamPosition ? { streamPosition } : {}),
    });
  };
  const unload = (threadId: string): void => {
    if (!shown.delete(threadId)) return;
    released.add(threadId);
    end(threadId, 'unloaded');
  };
  const gone = (threadId: string): void => {
    if (stopped) return;
    const known = shown.delete(threadId);
    if (!released.delete(threadId) && !known) return;
    end(threadId, 'gone');
  };
  const heard = (threadId: string, state: unknown, position: DesktopStreamPosition): void => {
    if (!stopped && library.threadSubscription(threadId).followed) show(threadId, state, position);
  };
  // Advance the authoritative revision before `subscribeFramedSessionStates` runs so any post-replay frame carries it.
  const offReplayBefore = client.store.subscribe((change) => {
    if (stopped || change.type !== 'thread' || !change.replayComplete) return;
    const origin = client.store.thread(change.threadId)?.state.origin;
    const nextRev = advanceSnapshotRevision(origin);
    if (!origin) fallbackRevisions.set(change.threadId, nextRev);
    if (library.threadSubscription(change.threadId).followed) {
      pendingReplayPublish.add(change.threadId);
    }
  });
  const offFrames = subscribeFramedSessionStates(client, () => undefined, heard, heard);
  const offLost = client.store.subscribe((change) => {
    if (change.type === 'subscription' && change.state === 'lost' && change.feedId !== 'app') {
      gone(change.feedId);
      return;
    }
    if (
      !stopped &&
      change.type === 'subscription' &&
      change.state === 'restored' &&
      change.feedId &&
      change.feedId !== 'app'
    ) {
      const sub = library.threadSubscription(change.feedId);
      if (sub.followed && !sub.snapshotPending && !sub.replayPending) {
        const origin = client.store.thread(change.feedId)?.state.origin;
        const nextRev = advanceSnapshotRevision(origin);
        if (!origin) fallbackRevisions.set(change.feedId, nextRev);
        const state = options.stateOf(change.feedId);
        if (state !== undefined) show(change.feedId, state, positionOf(change.feedId));
      }
      return;
    }
    if (
      !stopped &&
      change.type === 'thread' &&
      change.replayComplete &&
      pendingReplayPublish.delete(change.threadId) &&
      library.threadSubscription(change.threadId).followed
    ) {
      const state = options.stateOf(change.threadId);
      if (state !== undefined) show(change.threadId, state, positionOf(change.threadId));
    }
  });
  const offDeleted = client.on((event) => {
    const note = event.type === 'notification' ? event.notification : undefined;
    const threadId = (note?.params as { threadId?: unknown } | undefined)?.threadId;
    if (note?.method === 'thread/deleted' && typeof threadId === 'string') gone(threadId);
  });
  return {
    gone,
    sweep() {
      if (stopped) return;
      for (const threadId of [...shown]) if (!library.threadSubscription(threadId).followed) unload(threadId);
    },
    republish(threadId) {
      const state = options.stateOf(threadId);
      if (stopped || state === undefined) return false;
      show(threadId, state, positionOf(threadId));
      return true;
    },
    stop() {
      stopped = true;
      shown.clear();
      released.clear();
      pendingReplayPublish.clear();
      fallbackRevisions.clear();
      offReplayBefore();
      offFrames();
      offLost();
      offDeleted();
    },
  };
}
