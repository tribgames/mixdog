import {
  desktopSessionState,
  sessionReducer,
  type ProtocolClient,
  type SessionFold,
} from '../../../../../packages/protocol-client/src/index.ts';
import type { DesktopSessionStateUpdate, DesktopSessionSummary, SessionSnapshot } from '../contract';
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
      if (readTraceId) publisher.expectRead(sessionId, readTraceId);
      // The held window answers unless the read asks for more rows than it holds and the core has older ones.
      if (fold.items.length >= lastItems || fold.fields.transcriptHasOlder !== true) publish(sessionId);
      else
        await folded(sessionId, () => protocol.resumeThread(sessionId, { lastItems })).catch((error: unknown) => {
          publisher.forgetRead(sessionId);
          throw coreErrorForWindow(error);
        });
      return true;
    },
    requestSessionStateResync(sessionId) {
      publish(sessionId);
    },
    transcriptPending,
    setInterest: publisher.setInterest,
    dispose() {
      offRoster();
      offReplaced();
      publisher.dispose();
      sessionListeners.clear();
    },
  };
}
