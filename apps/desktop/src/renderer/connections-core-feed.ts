import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import type { DesktopConnectionIdentity } from '../shared/contract-workspace';

interface Notification {
  readonly method: string;
  readonly params?: unknown;
  readonly feed?: { readonly id?: string };
}
interface SectionChange {
  readonly key: string | null;
  readonly value?: unknown;
  readonly removed?: boolean;
}
export type LooseClient = { call(method: string, params: unknown): Promise<unknown> };

export interface CoreFeedHost {
  client(): ProtocolClient<SessionFold> | null;
  onClientChange?(listener: () => void): () => void;
  connection(): DesktopConnectionIdentity | undefined;
}

const CONNECTIONS_FEED = 'connections';
export const NO_CORE = 'This window has no connection to the core.';

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** The section updates a `connections` feed notification carries: one `connections/updated`, or the sections of a snapshot. */
function sectionChanges(note: Notification): SectionChange[] {
  const params = asRecord(note.params);
  let updates: unknown = [];
  if (note.method === 'feed/snapshot') updates = asRecord(params.state).sections;
  else if (note.method === 'connections/updated') updates = [params];
  if (!Array.isArray(updates)) return [];
  return updates
    .map(asRecord)
    .filter((u) => u.section === CONNECTIONS_FEED)
    .map((u) => ({
      key: typeof u.key === 'string' ? u.key : null,
      ...('value' in u ? { value: u.value } : {}),
      ...(u.removed === true ? { removed: true } : {}),
    }));
}

/** What the core pushes to this window: notifications by method and the `connections` feed's keys, over whichever
 *  client is open now. `pendingOpen` is the first open still in flight, which a listener waits for. */
export function createCoreFeed(host: CoreFeedHost, pendingOpen: () => Promise<unknown> | null) {
  const notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  const sectionListeners = new Set<(change: SectionChange) => void>();
  let attachedTo: ProtocolClient<SessionFold> | null = null;
  let detach: (() => void) | null = null;
  let feedSubscription: string | null = null;
  let feedChain: Promise<void> = Promise.resolve();
  let wasReady = true;
  let reportedNoCore = false;

  const syncFeed = (): void => {
    feedChain = feedChain
      .then(async () => {
        // The feed is the attached client's: its id and the completion of its request belong to that client alone.
        const owner = attachedTo;
        const client = owner as unknown as LooseClient | null;
        if (!client) return;
        if (sectionListeners.size > 0 && feedSubscription === null) {
          const identity = host.connection();
          const reply = (await client.call(
            'connections/subscribe',
            identity?.kind === 'ssh' ? { connectionId: identity.id } : {}
          )) as { id: string };
          if (attachedTo === owner) feedSubscription = reply.id;
        } else if (sectionListeners.size === 0 && feedSubscription !== null) {
          const subscriptionId = feedSubscription;
          feedSubscription = null;
          await client.call('connections/unsubscribe', { subscriptionId });
          // The service ends its own record; the server keeps pushing the feed until this ends the subscription.
          await client.call('feed/unsubscribe', { feedId: CONNECTIONS_FEED });
        }
      })
      .catch((error: unknown) => {
        console.error('connections feed:', error instanceof Error ? error.message : error);
      });
  };
  const onEvent = (event: { type: string; notification?: Notification; status?: { state: string } }): void => {
    if (event.type === 'status') {
      const ready = event.status?.state === 'ready';
      // A new connection to the core holds no feed: ask for it again.
      if (ready && !wasReady) {
        feedSubscription = null;
        if (sectionListeners.size > 0) syncFeed();
      }
      wasReady = ready;
      return;
    }
    const note = event.notification;
    if (event.type !== 'notification' || !note) return;
    if (note.feed?.id === CONNECTIONS_FEED || note.method === 'connections/updated') {
      for (const change of sectionChanges(note)) for (const listener of [...sectionListeners]) listener(change);
    }
    for (const listener of [...(notificationListeners.get(note.method) ?? [])]) listener(note.params);
  };
  /** The open client. One that closed is none: the registry names it until its replacement is accepted. */
  const liveClient = (): ProtocolClient<SessionFold> | null => {
    const client = host.client();
    return client && (client as { status?: { state?: string } }).status?.state !== 'closed' ? client : null;
  };
  /** Listens to the client that is open now (and to a replacement of it), and asks a new one for the feed its listeners
   *  need. False while there is none, said once when the window has no client at all. */
  const attach = (): boolean => {
    const client = liveClient();
    if (!client) {
      if (!host.client() && !reportedNoCore) {
        reportedNoCore = true;
        console.error(NO_CORE);
      }
      return false;
    }
    if (attachedTo !== client) {
      detach?.();
      attachedTo = client;
      feedSubscription = null;
      wasReady = true;
      detach = client.on((event) => onEvent(event as never));
      if (sectionListeners.size > 0) syncFeed();
    }
    return true;
  };
  /** attach(), or, while the first open is in flight, true now and attach() (then `opened`) once it settled. */
  const attachOrDefer = (opened: () => void): boolean => {
    const opening = pendingOpen();
    if (!opening) return attach();
    const later = (): void => {
      if (attach()) opened();
    };
    void opening.then(later, later);
    return true;
  };
  // The api lives as long as the page, so it must not keep a client that closed or was replaced: it lets go of it (listener,
  // feed state) by identity, and follows the open one if anyone is subscribed (also one who subscribed during the gap).
  const reconcile = (): void => {
    const live = liveClient();
    if (attachedTo !== null && attachedTo === live) return;
    if (attachedTo !== null) {
      detach?.();
      detach = null;
      attachedTo = null;
      feedSubscription = null;
      wasReady = true;
    }
    const subscribed = sectionListeners.size > 0 || [...notificationListeners.values()].some((set) => set.size > 0);
    if (live && subscribed) attach();
  };
  host.onClientChange?.(reconcile);
  const onNotification = (method: string, listener: (params: unknown) => void): (() => void) => {
    attachOrDefer(() => undefined);
    const set = notificationListeners.get(method) ?? new Set();
    notificationListeners.set(method, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const onSection = (listener: (change: SectionChange) => void): (() => void) => {
    attachOrDefer(syncFeed);
    sectionListeners.add(listener);
    syncFeed();
    return () => {
      sectionListeners.delete(listener);
      syncFeed();
    };
  };
  /** The value of one key of the `connections` feed, whenever it is written. */
  const onKey = <T>(key: string, listener: (value: T) => void): (() => void) =>
    onSection((change) => {
      if (change.key === key && !change.removed && 'value' in change) listener(change.value as T);
    });
  /** A connection-scoped notification reaches only the subscribers of the feed. */
  const onNotificationWithFeed = (method: string, listener: (params: unknown) => void): (() => void) => {
    const stopNotice = onNotification(method, listener);
    const stopFeed = onSection(() => undefined);
    return () => {
      stopNotice();
      stopFeed();
    };
  };
  return { onNotification, onKey, onNotificationWithFeed };
}
