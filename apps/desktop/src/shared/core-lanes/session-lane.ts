// The sessions of a core connection as this process's windows are told of them (ipc-state-bridge.ts): the sidebar
// catalog, each followed thread's state, and the chat calls whose answer is more than the core's reply. All three
// are made here from the client library's folds and the app feed.
//
// Nothing is converted a second way: the catalog is the phone's roster feed (`createRosterFeed`) over the same row
// projection (`summariesOfThreadRows`), the chat calls are the phone's adapter (`createChatApi`, `createChatHostApi`)
// built on this connection's client, and a thread's state is the library's own (`sessionStateOf`).
import {
  approvalSurface,
  desktopSessionState,
  sessionReducer,
  streamPositionReached,
  type ProtocolClient,
  type SessionFold,
} from '../../../../../packages/protocol-client/src/index.ts';
import type {
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  DesktopStreamPosition,
  SessionSnapshot,
} from '../contract';
import { remoteSessionIdOf, withRemoteSession } from '../blank-snapshot';
import { createChatHostApi, type ChatHostApi } from '../../renderer/remote-chat-host';
import {
  createChatApi,
  createRosterFeed,
  remoteSession,
  sharedFor,
  type ChatClient,
  type RosterClient,
} from '../../renderer/remote-protocol-chat';
import { DESKTOP_TRANSCRIPT_TAIL_BYTES, DESKTOP_TRANSCRIPT_TAIL_ITEMS } from './transcript-support';
import type { ProtocolConnection } from '../../main/protocol/connection';
import { coreErrorForWindow } from './core-error';
import { summariesOfThreadRows } from './thread-rows';

type Client = ProtocolClient<SessionFold>;

export interface SessionLane {
  /** The chat calls, over the client that is open now. */
  chat(): Promise<ChatHostApi>;
  listSessions(): Promise<DesktopSessionSummary[]>;
  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  /** The stored tail for a paint preview, without starting a runtime or publishing a state frame. */
  previewSession(sessionId: string): Promise<SessionSnapshot>;
  /** Prefetch: the session's transcript tail is published as a state frame (`readTraceId` names it). */
  prefetchSession(sessionId: string, itemLimit?: number, readTraceId?: string): Promise<boolean>;
  /** The followed thread's state is published again, whole. */
  requestSessionStateResync(sessionId: string): void;
  /** Whether an attach still owes a usable transcript; held projections must not be delivered meanwhile. */
  transcriptPending(sessionId: string): boolean;
  /** The threads whose changes this lane's listeners use (a window's shown sessions and its reads): a change of any other
   *  thread is not projected. Without one, every followed thread is. */
  setInterest(interested: ((threadId: string) => boolean) | null): void;
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

export function createSessionLane({
  protocol,
}: {
  protocol: Pick<
    ProtocolConnection,
    'call' | 'client' | 'whenSynced' | 'onEvent' | 'onStoreChange' | 'onReplaced' | 'resumeThread'
  >;
}): SessionLane {
  const sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  const stateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  const held = (): Client | null => protocol.client() as unknown as Client | null;
  /** The open client; a call made before the first connection is up waits for it. */
  const live = async (): Promise<Client> => {
    await protocol.whenSynced();
    const client = held();
    if (!client) throw new Error('The core connection is not open.');
    return client;
  };
  const call = (method: string, params: unknown): Promise<unknown> =>
    protocol.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    });

  // ── the catalog ──
  const rosterClient: RosterClient = {
    call: (method, params) => protocol.call(method, params),
    on: (listener) => protocol.onEvent(listener as Parameters<ProtocolConnection['onEvent']>[0]),
    store: { subscribe: (listener) => protocol.onStoreChange(listener) },
  };
  const roster = createRosterFeed<DesktopSessionSummary>({
    summaries: (rows) => summariesOfThreadRows(rows),
    publish: (rows) => {
      for (const listener of [...sessionListeners]) listener(rows);
    },
  });
  const offRoster = roster.attach(rosterClient);
  // A reopened connection may be another core's: the catalog is read again, as after a reconnect.
  const offReplaced = protocol.onReplaced(() => void roster.list(rosterClient).catch(() => undefined));

  // ── the followed threads' states ──
  // Every session snapshot answered is stamped with the remote channel's session.
  const decorated = (client: Client, state: unknown): SessionSnapshot =>
    withRemoteSession(
      state,
      remoteSessionIdOf(remoteSession(client as unknown as ChatClient))
    ) as unknown as SessionSnapshot;
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
  /** A change of a thread the store announced: its state is published when the change ends one of the core's frames, or
   *  is a snapshot or a change of the thread's server requests, and only when what the state is made of changed.
   *
   *  The core announces each publication of a thread's state as `thread/frame`, after the notifications it carries (a
   *  streamed reply's deltas among them; the session actor marks a frame for every notification that changes the state,
   *  phone_frame.rs `mark_of`). A notification folded before its frame is published by that frame: the state is projected
   *  once per frame, not once per token. */
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
    const snapshot = decorated(
      client,
      desktopSessionState(fold, client.pendingServerRequests(), client.store.section('hostShellJobs')?.value)
    );
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
      if (!change.replayComplete && !due(change.threadId)) return;
      publish(change.threadId);
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

  /** Resolves once the library has folded the snapshot `resume` brings (the fold follows the reply; client.ts `fold`). */
  const folded = async (threadId: string, resume: () => Promise<unknown>): Promise<void> => {
    let off = (): void => undefined;
    const arrived = new Promise<void>((resolve) => {
      off = protocol.onStoreChange((change) => {
        if (change.type === 'thread' && change.threadId === threadId) resolve();
      });
    });
    try {
      await resume();
      await arrived;
    } finally {
      off();
    }
  };
  /** A thread this connection does not follow, read once: its state as a snapshot of that read would fold. */
  const readOnce = async (client: Client, threadId: string, lastItems: number): Promise<SessionSnapshot> => {
    const read = await call('thread/read', { threadId, window: { lastItems } });
    const state = desktopSessionState(
      sessionReducer.initial(read as Parameters<typeof sessionReducer.initial>[0]),
      client.pendingServerRequests(),
      client.store.section('hostShellJobs')?.value
    );
    return decorated(client, state);
  };

  return {
    async chat() {
      const client = (await live()) as unknown as ChatClient;
      const shared = sharedFor(client);
      return createChatHostApi(client, shared, createChatApi(client, shared), {
        remoteSession: () => remoteSession(client),
      });
    },
    listSessions: () => roster.list(rosterClient),
    subscribeSessions(listener) {
      sessionListeners.add(listener);
      return () => void sessionListeners.delete(listener);
    },
    subscribeSessionStates(listener) {
      stateListeners.add(listener);
      return () => void stateListeners.delete(listener);
    },
    async previewSession(sessionId) {
      const client = await live();
      if (client.store.thread(sessionId)) return null;
      const page = (await call('thread/items/list', {
        threadId: sessionId,
        limit: DESKTOP_TRANSCRIPT_TAIL_ITEMS,
        byteBudget: DESKTOP_TRANSCRIPT_TAIL_BYTES,
      })) as { data?: Parameters<typeof sessionReducer.initial>[0][] };
      if (!page.data?.length) return null;
      // The page is chronological. Do not expose scrollback or live state before the pane gets its real lane.
      const fold = sessionReducer.initial({ thread: { id: sessionId }, items: page.data, hasOlder: false });
      return decorated(client, desktopSessionState(fold, []));
    },
    async prefetchSession(sessionId, itemLimit, readTraceId) {
      const client = await live();
      if (transcriptPending(sessionId)) return true;
      const lastItems = typeof itemLimit === 'number' ? itemLimit : DESKTOP_TRANSCRIPT_TAIL_ITEMS;
      const fold = client.store.thread(sessionId)?.state;
      if (!fold) {
        // Not followed: one read, published as the replay it is. Following it is `setVisibleSessions`' decision.
        const snapshot = await readOnce(client, sessionId, lastItems);
        emit({ sessionId, snapshot, frameSource: 'replay', ...(readTraceId ? { readTraceId } : {}) });
        return true;
      }
      if (readTraceId) pendingTraces.set(sessionId, readTraceId);
      // The held window answers unless the read asks for more rows than it holds and the core has older ones.
      if (fold.items.length >= lastItems || fold.fields.transcriptHasOlder !== true) publish(sessionId);
      else
        await folded(sessionId, () => protocol.resumeThread(sessionId, { lastItems })).catch((error: unknown) => {
          pendingTraces.delete(sessionId);
          throw coreErrorForWindow(error);
        });
      return true;
    },
    requestSessionStateResync(sessionId) {
      publish(sessionId);
    },
    transcriptPending,
    setInterest(next) {
      interest = next;
    },
    dispose() {
      offRoster();
      offReplaced();
      offStore();
      sessionListeners.clear();
      stateListeners.clear();
      pendingTraces.clear();
      shown.clear();
    },
  };
}
