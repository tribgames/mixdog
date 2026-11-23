import {
  desktopSessionState,
  keepTranscriptWindow,
  moveTranscriptWindow,
  sessionReducer,
  type ProtocolClient,
  type SessionFold,
} from '../../../../../packages/protocol-client/src/index.ts';
import type {
  DesktopRewindTarget,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  DesktopTranscriptMove,
  SessionSnapshot,
} from '../contract';
import { remoteSessionIdOf, withRemoteSession } from '../blank-snapshot';
import { createChatHostApi, type ChatHostApi } from '../../renderer/remote-chat-host';
import {
  createChatApi,
  createRosterFeed,
  pageLanded,
  pageWindow,
  remoteSession,
  sharedFor,
  type ChatClient,
  type RosterClient,
} from '../../renderer/remote-protocol-chat';
import { DESKTOP_TRANSCRIPT_TAIL_BYTES, DESKTOP_TRANSCRIPT_TAIL_ITEMS } from './transcript-support';
import type { ProtocolConnection } from '../../main/protocol/connection';
import { coreErrorForWindow } from './core-error';
import { createStatePublisher } from './state-publisher';
import { summariesOfThreadRows } from './thread-rows';

type Client = ProtocolClient<SessionFold>;

export interface SessionLane {
  /** The chat calls, over the client that is open now. */
  chat(): Promise<ChatHostApi>;
  listSessions(): Promise<DesktopSessionSummary[]>;
  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  /** The stored tail for a paint preview, without starting a runtime or publishing a state frame;
   *  null when the thread is already followed or has no stored items. */
  previewSession(sessionId: string): Promise<SessionSnapshot | null>;
  /** Prefetch: the session's transcript tail is published as a state frame (`readTraceId` names it). While an attach still
   *  owes the transcript, the read first waits for it and its fold (rejecting when the thread cannot be followed), sending
   *  nothing; `retry`, the user's Retry, ends that attach as the thread's loss and opens the thread again instead. */
  prefetchSession(
    sessionId: string,
    itemLimit?: number,
    readTraceId?: string,
    options?: { retry?: boolean }
  ): Promise<boolean>;
  /** The followed thread's state is published again, whole. */
  requestSessionStateResync(sessionId: string): void;
  /** The window a positioned thread's subscription holds follows the reader (protocol-client `moveTranscriptWindow`). */
  moveTranscriptWindow(sessionId: string, move: DesktopTranscriptMove): Promise<boolean>;
  /** `thread/rewindTargets/list`: the prompts a rewind can name, newest first. */
  listRewindTargets(
    sessionId: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<{ data: DesktopRewindTarget[]; nextCursor?: string }>;
  /** Whether an attach still owes a usable transcript; held projections must not be delivered meanwhile. */
  transcriptPending(sessionId: string): boolean;
  /** The threads whose changes this lane's listeners use (a window's shown sessions and its reads): a change of any other
   *  thread is not projected. Without one, every followed thread is. */
  setInterest(interested: ((threadId: string) => boolean) | null): void;
  dispose(): void;
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

  // Every session snapshot answered is stamped with the remote channel's session.
  const decorated = (client: Client, state: unknown): SessionSnapshot =>
    withRemoteSession(
      state,
      remoteSessionIdOf(remoteSession(client as unknown as ChatClient))
    ) as unknown as SessionSnapshot;
  const publisher = createStatePublisher({ protocol, held, decorated });
  const { emit, publish, transcriptPending } = publisher;
  const stateOf = (client: Client, fold: SessionFold): SessionSnapshot =>
    decorated(
      client,
      desktopSessionState(fold, client.pendingServerRequests(), client.store.section('hostShellJobs')?.value)
    );

  // A state this lane published is owed again while the client restores its thread after a reconnect. The window is told so
  // (the state it holds, with `restoreOwed`: a fact of its own that only the pane's watch reads), which puts the restore
  // under that watch, and it gets the restored state when the restore ends. A lost thread ends its lane as any loss does.
  const shownLive = new Set<string>();
  const owed = new Set<string>();
  let interest: ((threadId: string) => boolean) | null = null;
  publisher.subscribe((update) => {
    if (update.snapshot && update.frameSource !== 'live') return;
    owed.delete(update.sessionId);
    if (update.snapshot) shownLive.add(update.sessionId);
    else shownLive.delete(update.sessionId);
  });
  const markRestoring = (): void => {
    const client = held();
    if (!client) return;
    for (const threadId of [...shownLive]) {
      const fold = client.store.thread(threadId)?.state;
      if (!fold) shownLive.delete(threadId);
      else if (
        !owed.has(threadId) &&
        (interest === null || interest(threadId)) &&
        client.threadSubscription?.(threadId).restoring
      ) {
        owed.add(threadId);
        emit({
          sessionId: threadId,
          snapshot: { ...stateOf(client, fold), restoreOwed: true } as unknown as SessionSnapshot,
          frameSource: 'replay',
        });
      }
    }
  };
  const offReady = protocol.onEvent((event) => {
    // The client starts its restores in the turn it becomes ready, after this event.
    if (event.type === 'status' && (event as { status: { state: string } }).status.state === 'ready')
      queueMicrotask(markRestoring);
  });
  const offRestored = protocol.onStoreChange((change) => {
    if (change.type === 'subscription' && change.state === 'restored' && change.feedId && owed.has(change.feedId))
      publish(change.feedId);
  });

  // What a followed thread's window owes with no reader moving (a hole in its tail, a tail past its bound, a window the
  // core let go) is asked for as the thread changes, shown in a pane or not.
  const offGap = protocol.onStoreChange((change) => {
    const threadId = change.type === 'thread' ? change.threadId : undefined;
    const client = threadId ? held() : null;
    if (client && threadId) void keepTranscriptWindow(client, threadId);
  });
  // The readers this lane spoke for, by thread. The client is this window's own (a window that closes or reloads takes
  // its client, and so every reader of it, with it); a lane disposed while its client lives on withdraws them itself.
  const spokenFor = new Map<string, Set<string>>();

  /** The fold the snapshot of the page `resume` asks for brings (a fold of another `origin` than `before`: the fold follows
   *  the reply; client.ts `fold`), or undefined when the core answered with a replay, which brings none. An event folded
   *  meanwhile is not that page. Rejects when the thread is lost first. */
  const paged = async (
    threadId: string,
    before: SessionFold,
    resume: () => Promise<unknown>
  ): Promise<SessionFold | undefined> => {
    let off = (): void => undefined;
    const landed = new Promise<SessionFold>((resolve, reject) => {
      off = protocol.onStoreChange((change) => {
        if (change.type === 'thread' && change.threadId === threadId) {
          const next = held()?.store.thread(threadId)?.state;
          if (next && next.origin !== before.origin) resolve(next);
        } else if (change.type === 'subscription' && change.feedId === threadId && change.state === 'lost') {
          reject(new Error('The session is no longer available.'));
        }
      });
    });
    landed.catch(() => undefined);
    try {
      const reply = (await resume()) as { subscription?: { mode?: unknown } } | null | undefined;
      if (reply?.subscription?.mode === 'replay') return undefined;
      return await landed;
    } finally {
      off();
    }
  };
  /** A thread this connection does not follow, read once: its state as a snapshot of that read would fold. */
  const readOnce = async (client: Client, threadId: string, lastItems: number): Promise<SessionSnapshot> => {
    const read = await call('thread/read', { threadId, window: { lastItems } });
    return stateOf(client, sessionReducer.initial(read as Parameters<typeof sessionReducer.initial>[0]));
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
    subscribeSessionStates: publisher.subscribe,
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
    async prefetchSession(sessionId, itemLimit, readTraceId, options) {
      const client = await live();
      const lastItems = typeof itemLimit === 'number' ? itemLimit : DESKTOP_TRANSCRIPT_TAIL_ITEMS;
      if (transcriptPending(sessionId)) {
        // An attach still owes the transcript. The user's Retry, once the pane's watch gave up on that attach, ends it as
        // the thread's loss and opens the thread again; any other read waits for the attach and its fold, offering no
        // window of its own as grounds for another one. What the read asks beyond that is decided below, on the fold.
        let arrived: boolean;
        try {
          if (options?.retry === true) await client.reopenThread(sessionId, { lastItems });
          arrived = await client.whenThreadSettled(sessionId);
        } catch (error) {
          throw coreErrorForWindow(error);
        }
        // The thread was let go while the read waited: the read ends here. It sends nothing and publishes nothing (a read
        // answered later would land over the state of whoever opened the thread again), and it asks for no repeat.
        if (!arrived) return true;
      }
      const fold = client.store.thread(sessionId)?.state;
      if (!fold) {
        // Not followed: one read, published as the replay it is. Following it is `setVisibleSessions`' decision.
        const snapshot = await readOnce(client, sessionId, lastItems);
        // The thread was followed while the read was out: the window its subscription holds (the reader's, which may
        // lie far from these newest rows) answers the read, never the read's own rows over it.
        if (client.store.thread(sessionId)) {
          // While its attach still owes the transcript, the frame that attach publishes is the answer.
          if (readTraceId) publisher.expectRead(sessionId, readTraceId);
          publish(sessionId);
          return true;
        }
        emit({ sessionId, snapshot, frameSource: 'replay', ...(readTraceId ? { readTraceId } : {}) });
        return true;
      }
      if (readTraceId) publisher.expectRead(sessionId, readTraceId);
      // A read that names no rows is a read of the state: the state held answers it and no resume is sent. Filling the
      // screen is the renderer's own page request.
      // A positioned window grows by the reader's moves, never by a larger snapshot.
      if (typeof itemLimit !== 'number' || fold.held) {
        publish(sessionId);
        return true;
      }
      // A page answers whether older rows joined the window (false: the window is exhausted). The held window answers unless
      // the page asks for more rows than it shows and the core has older ones; it grows in core items (`pageWindow`), one
      // page at a time.
      const items = pageWindow(fold, (desktopSessionState(fold, []).items as unknown[]).length, lastItems);
      if (!items) {
        publish(sessionId);
        return items === 0;
      }
      let page: SessionFold | undefined;
      try {
        page = await paged(sessionId, fold, () => protocol.resumeThread(sessionId, { lastItems: items }));
      } catch (error) {
        publisher.forgetRead(sessionId);
        throw coreErrorForWindow(error);
      }
      // A page's fold publishes itself; without one the state held answers the read.
      if (!page) publish(sessionId);
      return pageLanded(fold, page, items);
    },
    requestSessionStateResync(sessionId) {
      publish(sessionId);
    },
    async moveTranscriptWindow(sessionId, move) {
      const client = held();
      if (!client) return false;
      const reader = move.reader ?? '';
      if (move.kind === 'follow') spokenFor.get(sessionId)?.delete(reader);
      else spokenFor.set(sessionId, (spokenFor.get(sessionId) ?? new Set()).add(reader));
      return moveTranscriptWindow(client, sessionId, move);
    },
    async listRewindTargets(sessionId, options) {
      const page = (await call('thread/rewindTargets/list', {
        threadId: sessionId,
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        ...(options?.limit ? { limit: options.limit } : {}),
      })) as { data?: DesktopRewindTarget[]; nextCursor?: string };
      return { data: page.data ?? [], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    transcriptPending,
    setInterest(next) {
      interest = next;
      publisher.setInterest(next);
    },
    dispose() {
      offRoster();
      offReplaced();
      offReady();
      offRestored();
      offGap();
      const client = held();
      if (client)
        for (const [threadId, readers] of spokenFor)
          for (const reader of readers) void moveTranscriptWindow(client, threadId, { kind: 'follow', reader });
      spokenFor.clear();
      shownLive.clear();
      owed.clear();
      publisher.dispose();
      sessionListeners.clear();
    },
  };
}
