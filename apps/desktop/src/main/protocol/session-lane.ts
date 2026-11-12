// The sessions of a core connection as this process's windows are told of them (ipc-state-bridge.ts): the sidebar
// catalog, each followed thread's state, and the chat calls whose answer is more than the core's reply. Node's host
// pushed all three; over the core they are made here from the client library's folds and the app feed.
//
// Nothing is converted a second way: the catalog is the phone's roster feed (`createRosterFeed`) over the same row
// projection (`summariesOfThreadRows`), the chat calls are the phone's adapter (`createChatApi`, `createChatHostApi`)
// built on this connection's client, and a thread's state is the library's own (`sessionStateOf`).
import {
  desktopSessionState,
  sessionReducer,
  sessionStateOf,
  type ProtocolClient,
  type SessionFold,
} from '../../../../../packages/protocol-client/src/index.ts';
import type { DesktopSessionStateUpdate, DesktopSessionSummary, SessionSnapshot } from '../../shared/contract';
import { remoteSessionIdOf, withRemoteSession } from '../../shared/blank-snapshot';
import { createChatHostApi, type ChatHostApi } from '../../renderer/remote-chat-host';
import { createChatApi, createRosterFeed, remoteSession, sharedFor, type ChatClient, type RosterClient } from '../../renderer/remote-protocol-chat';
import { DESKTOP_TRANSCRIPT_TAIL_ITEMS } from '../desktop-support';
import type { ProtocolConnection } from './connection';
import { coreErrorForWindow } from './core-error';
import { summariesOfThreadRows } from './thread-rows';

type Client = ProtocolClient<SessionFold>;

/** The rows one `thread/items/list` page of a whole-conversation read asks for (ipc-validation.ts: a history page). */
const HISTORY_PAGE_ITEMS = 512;

export interface SessionLane {
  /** The chat calls as Node's host answered them, over the client that is open now. */
  chat(): Promise<ChatHostApi>;
  listSessions(): Promise<DesktopSessionSummary[]>;
  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  /** Node's `prefetchSession`: the session's transcript tail is published as a state frame (`readTraceId` names it). */
  prefetchSession(sessionId: string, itemLimit?: number, readTraceId?: string): Promise<boolean>;
  /** The transcript window this process holds of the session, read when it follows none. */
  readSessionTranscript(sessionId: string): Promise<SessionSnapshot>;
  /** The whole stored conversation. */
  readSessionHistory(sessionId: string): Promise<SessionSnapshot | null>;
  /** The followed thread's state is published again, whole. */
  requestSessionStateResync(sessionId: string): void;
  dispose(): void;
}

export function createSessionLane({
  protocol,
}: {
  protocol: Pick<ProtocolConnection, 'call' | 'client' | 'whenSynced' | 'onEvent' | 'onStoreChange' | 'onReplaced' | 'resumeThread'>;
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
  // Node's host stamped every session snapshot it answered with the remote channel's session (`snapshotWithRemoteSession`).
  const decorated = (client: Client, state: unknown): SessionSnapshot =>
    withRemoteSession(state, remoteSessionIdOf(remoteSession(client as unknown as ChatClient))) as unknown as SessionSnapshot;
  const stateOf = (threadId: string): SessionSnapshot | undefined => {
    const client = held();
    const state = client ? sessionStateOf(client, threadId) : undefined;
    return client && state ? decorated(client, state) : undefined;
  };
  const emit = (update: DesktopSessionStateUpdate): void => {
    for (const listener of [...stateListeners]) listener(update);
  };
  // The read a frame answers: a prefetch names its frame by trace id (ipc-state-bridge.ts admits it by that id).
  const pendingTraces = new Map<string, string>();
  const publish = (threadId: string): boolean => {
    const snapshot = stateOf(threadId);
    if (!snapshot) return false;
    const readTraceId = pendingTraces.get(threadId);
    pendingTraces.delete(threadId);
    emit({ sessionId: threadId, snapshot, frameSource: 'live', ...(readTraceId ? { readTraceId } : {}) });
    return true;
  };
  // The threads a state was published of: a state also changes with what is not the thread's own (the host's shell jobs,
  // the remote channel's session).
  const shown = new Set<string>();
  const republishShown = (): void => {
    for (const threadId of [...shown]) if (!publish(threadId)) shown.delete(threadId);
  };
  const offStore = protocol.onStoreChange((change) => {
    if (change.type === 'thread' && change.threadId) {
      shown.add(change.threadId);
      publish(change.threadId);
    } else if (change.type === 'section' && (change.section === 'hostShellJobs' || (change.section === 'hostState' && change.key === 'remoteSession'))) {
      republishShown();
    } else if (change.type === 'subscription' && change.state === 'lost' && change.feedId && change.feedId !== 'app') {
      // The core no longer has the thread for this connection (deleted, or it refused to restore the subscription).
      shown.delete(change.feedId);
      emit({ sessionId: change.feedId, snapshot: null as unknown as SessionSnapshot, frameSource: 'live', laneEnd: 'gone' });
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
      return createChatHostApi(client, shared, createChatApi(client, shared), { remoteSession: () => remoteSession(client) });
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
    async prefetchSession(sessionId, itemLimit, readTraceId) {
      const client = await live();
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
      else await folded(sessionId, () => protocol.resumeThread(sessionId, { lastItems })).catch((error: unknown) => {
        pendingTraces.delete(sessionId);
        throw coreErrorForWindow(error);
      });
      return true;
    },
    async readSessionTranscript(sessionId) {
      const client = await live();
      return stateOf(sessionId) ?? readOnce(client, sessionId, HISTORY_PAGE_ITEMS);
    },
    async readSessionHistory(sessionId) {
      const client = (await live()) as unknown as ChatClient;
      const { foldRows } = sharedFor(client);
      let items: unknown[] = [];
      for (let anchor: string | undefined; ; ) {
        const page = (await call('thread/items/list', {
          threadId: sessionId,
          limit: HISTORY_PAGE_ITEMS,
          sortDirection: 'desc',
          ...(anchor ? { cursor: { type: 'item', itemId: anchor } } : {}),
        })) as { data?: unknown[]; hasOlder?: boolean; nextCursor?: string };
        items = [...foldRows(page.data ?? []), ...items];
        if (page.hasOlder !== true || !page.nextCursor) break;
        anchor = page.nextCursor;
      }
      return { sessionId, items } as unknown as SessionSnapshot;
    },
    requestSessionStateResync(sessionId) {
      publish(sessionId);
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
