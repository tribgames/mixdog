import type { DesktopApi } from '../../shared/contract';
import type { DesktopTerminalRunRequest } from '../../shared/terminal-command';
import type { DirectKey } from '../../shared/desktop-api-split';
import { routeDesktopNotification, routeDesktopOperation } from '../../shared/core-lanes/desktop-operation-route';
import { termActivity } from '../../shared/core-lanes/section-reads';
import { readTerminalActivityEvent, type TerminalActivityEvent } from '../../shared/terminal-activity';
import { terminalActivityChanges, terminalReply, terminalSizeOwnerChanges } from '../../shared/terminal-protocol';
import { requiredString } from '../../shared/scm-input';
import type { TerminalSizeOwner, TerminalSizeOwnerEvent } from '../../shared/terminal-size-owner';
import type { TerminalDataEvent } from './terminal-data-buffer';
import {
  createTerminalFeed,
  isTerminalAttachCancelled,
  sessionOf,
  TerminalAttachCancelledError,
  type TerminalSession,
} from './terminal-feed';
import type { DirectContext } from './context';

/** The notification that tells the core the pane showing a run's terminal claimed its reveal. */
const TERMINAL_RUN_CLAIMED = 'ui/terminalRun/claimed';
/** Maximum time a deferred termDetach waits for an in-flight ensure/attach before detaching anyway. */
export const DEFERRED_DETACH_TIMEOUT_MS = 10_000;

const isAbortSignal = (value: unknown): value is AbortSignal =>
  value != null &&
  typeof value === 'object' &&
  'aborted' in value &&
  typeof (value as AbortSignal).addEventListener === 'function';

export function createTerminalApi(
  ctx: DirectContext,
  options?: { deferredDetachTimeoutMs?: number }
): Pick<DesktopApi, DirectKey<'terminal'>> & {
  isTerminalAttached(id: unknown): boolean;
  terminalFeedGeneration(id: unknown): number | null;
  terminalSessionGeneration(session: unknown): number | null;
  subscribeTabTermData(id: unknown, listener: (event: TerminalDataEvent, gen?: number) => void): () => void;
} {
  const { connection } = ctx;
  const deferredDetachTimeoutMs = options?.deferredDetachTimeoutMs ?? DEFERRED_DETACH_TIMEOUT_MS;
  const dataListeners = new Set<(event: TerminalDataEvent, gen?: number) => void>();
  const tabDataListeners = new Map<string, Set<(event: TerminalDataEvent, gen?: number) => void>>();
  const activityListeners = new Set<(event: TerminalActivityEvent) => void>();
  const sizeOwnerListeners = new Set<(event: TerminalSizeOwnerEvent) => void>();
  const runListeners = new Set<(request: DesktopTerminalRunRequest) => void>();
  const listen = <T>(listeners: Set<T>, listener: T): (() => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const hasDataConsumer = (id: string): boolean => dataListeners.size > 0 || (tabDataListeners.get(id)?.size ?? 0) > 0;

  type InflightEntry = { cancel(): void };
  // Active in-flight ensure/attach entries per tab id so a late termDetach from an unmounted
  // consumer cannot tear down a feed while a reopened mount is attaching it.
  const inflightAttaches = new Map<string, Set<InflightEntry>>();
  const deferredDetaches = new Map<string, ReturnType<typeof setTimeout>>();
  // Tabs where one shared attach caller aborted while another caller stayed active: never flushed on reconnect/timeout
  // (so the live caller is never cancelled), only detached if no surviving consumer claims the tab.
  const detachIfAllFail = new Set<string>();
  // Tabs claimed by a live consumer that resolved cleanly (including a termEnsure link-loss fallback awaiting reconnect),
  // cleared on termDetach or termDispose so a sibling abort can never strip reconnect recovery from a live pane.
  const activeConsumers = new Set<string>();
  let feed!: ReturnType<typeof createTerminalFeed>;

  const clearDeferredDetach = (id: string): boolean => {
    const timer = deferredDetaches.get(id);
    if (timer === undefined) return false;
    clearTimeout(timer);
    deferredDetaches.delete(id);
    return true;
  };
  const evictInflight = (id: string): void => {
    const entries = inflightAttaches.get(id);
    inflightAttaches.delete(id);
    if (!entries) return;
    for (const entry of entries) entry.cancel();
  };
  const flushDeferredDetach = (id: string): void => {
    if (!clearDeferredDetach(id)) return;
    detachIfAllFail.delete(id);
    activeConsumers.delete(id);
    evictInflight(id);
    feed.detach(id);
  };
  const flushAllDeferredDetaches = (): void => {
    for (const id of [...deferredDetaches.keys()]) flushDeferredDetach(id);
  };
  const scheduleDeferredDetach = (id: string): void => {
    if (deferredDetaches.has(id)) return;
    const timer = setTimeout(() => {
      flushDeferredDetach(id);
    }, deferredDetachTimeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    deferredDetaches.set(id, timer);
  };
  const retainInflight = (id: string, entry: InflightEntry): void => {
    let entries = inflightAttaches.get(id);
    if (!entries) {
      entries = new Set();
      inflightAttaches.set(id, entries);
    }
    entries.add(entry);
  };
  const releaseInflight = (id: string, entry: InflightEntry, attached: boolean, keepConsumer = attached): void => {
    const entries = inflightAttaches.get(id);
    const active = entries?.delete(entry) ?? false;
    if (entries && entries.size === 0) inflightAttaches.delete(id);
    if (!active) return;
    if (attached) {
      clearDeferredDetach(id);
      detachIfAllFail.delete(id);
      if (keepConsumer) activeConsumers.add(id);
      return;
    }
    if (keepConsumer) detachIfAllFail.delete(id);
    if (!inflightAttaches.has(id)) {
      const hadDeferred = clearDeferredDetach(id);
      const hadAborted = detachIfAllFail.delete(id);
      if (hadDeferred) {
        activeConsumers.delete(id);
        feed.detach(id);
      } else if (keepConsumer) {
        activeConsumers.add(id);
      } else if (hadAborted && !activeConsumers.has(id)) {
        feed.detach(id);
      }
    } else if (keepConsumer) {
      activeConsumers.add(id);
    }
  };

  // Register before createTerminalFeed so pending detaches flush before link-replace reattach runs.
  connection.onReplaced(flushAllDeferredDetaches);
  let ready = false;
  connection.onEvent((event) => {
    if (event.type === 'status') {
      const next = (event as { status: { state: string } }).status.state === 'ready';
      if (!next || !ready) flushAllDeferredDetaches();
      ready = next;
      return;
    }
    if (event.type !== 'notification') return;
    const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
    if (method !== 'ui/openRequested') return;
    const open = params as ({ kind?: unknown; sessionId?: unknown } & Record<string, unknown>) | undefined;
    if (open?.kind !== 'terminal' || typeof open.sessionId !== 'string' || !open.sessionId) return;
    const { kind: _kind, ...request } = open;
    for (const listener of [...runListeners]) listener(request as unknown as DesktopTerminalRunRequest);
  });

  feed = createTerminalFeed(
    ctx,
    (event, gen) => {
      for (const listener of [...dataListeners]) listener(event, gen);
      const scoped = tabDataListeners.get(event.id);
      if (scoped) {
        for (const listener of [...scoped]) listener(event, gen);
      }
    },
    hasDataConsumer
  );

  // The activity and size owner are read from the sections the connection holds each time one changes.
  const sectionValue = (name: 'terminalActivity' | 'terminalTabs'): unknown =>
    connection.protocolClient()?.store.section(name, null)?.value;
  const activity = new Map<string, unknown>();
  const owners = new Map<string, TerminalSizeOwner>();
  connection.onStoreChange((change) => {
    const snapshot = change.type === 'appSnapshot';
    if (snapshot || (change.type === 'section' && change.section === 'terminalActivity')) {
      for (const event of terminalActivityChanges(activity, sectionValue('terminalActivity'))) {
        for (const listener of [...activityListeners]) listener(event);
      }
    }
    if (snapshot || (change.type === 'section' && change.section === 'terminalTabs')) {
      // A window never claims a size ('' owns nothing): a phone's grid is followed.
      for (const event of terminalSizeOwnerChanges(owners, sectionValue('terminalTabs'), '')) {
        for (const listener of [...sizeOwnerListeners]) listener(event);
      }
    }
  });

  const api: Pick<DesktopApi, DirectKey<'terminal'>> & {
    isTerminalAttached(id: unknown): boolean;
    terminalFeedGeneration(id: unknown): number | null;
    terminalSessionGeneration(session: unknown): number | null;
    subscribeTabTermData(id: unknown, listener: (event: TerminalDataEvent, gen?: number) => void): () => void;
  } = {
    isTerminalAttached(id: unknown): boolean {
      return typeof id === 'string' && id.length > 0 && feed.isAttached(id);
    },
    terminalFeedGeneration(id: unknown): number | null {
      return typeof id === 'string' && id.length > 0 ? feed.generation(id) : null;
    },
    terminalSessionGeneration(session: unknown): number | null {
      return session && typeof session === 'object' ? feed.sessionGeneration(session as TerminalSession) : null;
    },
    async termEnsure(id: unknown, cwd: unknown, profile: unknown, signalArg?: unknown): Promise<TerminalSession> {
      const signal = isAbortSignal(signalArg) ? signalArg : undefined;
      const requestedId = typeof id === 'string' && id ? id : null;
      let cancelled = false;
      let ensuredId: string | null = null;
      let joinedFeedId: string | null = null;
      let attached = false;
      let keepConsumer = false;
      const entry: InflightEntry = {
        cancel: () => {
          cancelled = true;
        },
      };
      const onAbort = (): void => {
        if (ensuredId) releaseInflight(ensuredId, entry, false, false);
        if (requestedId) releaseInflight(requestedId, entry, false, false);
        if (joinedFeedId && !activeConsumers.has(joinedFeedId)) {
          if (inflightAttaches.has(joinedFeedId)) {
            detachIfAllFail.add(joinedFeedId);
          } else {
            clearDeferredDetach(joinedFeedId);
            detachIfAllFail.delete(joinedFeedId);
            feed.detach(joinedFeedId);
          }
        }
      };
      if (signal) {
        if (signal.aborted) throw new TerminalAttachCancelledError(requestedId ?? '');
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (requestedId) retainInflight(requestedId, entry);
      try {
        const { method, params } = routeDesktopOperation('termEnsure', [
          requestedId,
          typeof cwd === 'string' && cwd ? cwd : null,
          typeof profile === 'string' && profile ? profile : null,
        ]);
        const value = await ctx.call(method, params);
        if (!value || typeof value !== 'object') {
          throw new Error('The service terminal did not return a session.');
        }
        if (cancelled) {
          throw new TerminalAttachCancelledError(requestedId ?? '');
        }
        const ensured = sessionOf(terminalReply(value));
        if (signal?.aborted) {
          // Consumer unmounted before feed attach started: return the ensured id for cleanup without subscribing or marking wanted.
          return ensured;
        }
        if (ensured.id && ensured.id !== requestedId) {
          ensuredId = ensured.id;
          retainInflight(ensuredId, entry);
        }
        // A tab this connection does not read yet, or reads for an earlier terminal of the id, is attached: its output streams from the
        // attach's position, and the attach's replay is the screen up to there; an attach in flight answers for it. A tab already read
        // for this terminal streams as it is.
        joinedFeedId = ensured.id || null;
        const pending = feed.joinOrAttach(ensured.id, ensured.terminal);
        if (!pending) {
          const currentGen = feed.generation(ensured.id);
          if (currentGen !== null) feed.tagSession(ensured, currentGen);
          attached = true;
          keepConsumer = !signal?.aborted && !cancelled;
          return ensured;
        }
        // The shell runs whatever the attach answers, so the ensure answers it: a shell already gone has nothing to stream, and an
        // attach lost with the link leaves the tab to the next link's (a retried ensure without an id would spawn a second shell).
        // A detach/dispose cancellation invalidates the attach and must never return a dead unsubscribed session as a live success.
        const attachedSession = await pending.catch((error: unknown) => {
          if (isTerminalAttachCancelled(error)) throw error;
          return null;
        });
        if (cancelled) {
          throw new TerminalAttachCancelledError(ensured.id);
        }
        attached = attachedSession !== null;
        keepConsumer = !signal?.aborted && !cancelled;
        if (
          !attached &&
          signal?.aborted &&
          ensured.id &&
          !inflightAttaches.has(ensured.id) &&
          !activeConsumers.has(ensured.id)
        ) {
          feed.detach(ensured.id);
        }
        return attachedSession ?? ensured;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (ensuredId) releaseInflight(ensuredId, entry, attached, keepConsumer);
        if (requestedId)
          releaseInflight(requestedId, entry, ensuredId ? false : attached, ensuredId ? false : keepConsumer);
      }
    },
    async termAttach(id: unknown, signalArg?: unknown): Promise<TerminalSession | null> {
      const signal = isAbortSignal(signalArg) ? signalArg : undefined;
      const tab = typeof id === 'string' && id ? id : '';
      let cancelled = false;
      let attached = false;
      const entry: InflightEntry = {
        cancel: () => {
          cancelled = true;
        },
      };
      const onAbort = (): void => {
        if (!tab) return;
        releaseInflight(tab, entry, false, false);
        if (!activeConsumers.has(tab)) {
          if (inflightAttaches.has(tab)) {
            detachIfAllFail.add(tab);
          } else {
            clearDeferredDetach(tab);
            detachIfAllFail.delete(tab);
            feed.detach(tab);
          }
        }
      };
      if (signal) {
        if (signal.aborted) throw new TerminalAttachCancelledError(tab);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (tab) retainInflight(tab, entry);
      try {
        const session = await feed.attach(id as string);
        if (cancelled || signal?.aborted) {
          throw new TerminalAttachCancelledError(tab);
        }
        attached = session !== null;
        return session;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (tab) releaseInflight(tab, entry, attached, attached);
      }
    },
    termDetach(id: unknown): void {
      if (typeof id !== 'string' || !id) return;
      if ((inflightAttaches.get(id)?.size ?? 0) > 0) {
        scheduleDeferredDetach(id);
        return;
      }
      clearDeferredDetach(id);
      detachIfAllFail.delete(id);
      activeConsumers.delete(id);
      feed.detach(id);
    },
    termProfiles: async () => {
      const { method, params } = routeDesktopOperation('termProfiles', []);
      // The profile list is the core's answer as Node gave it.
      return (await ctx.call(method, params)) as Awaited<ReturnType<NonNullable<DesktopApi['termProfiles']>>>;
    },
    termWrite(id: unknown, data: unknown): void {
      // Keystrokes take the fire-and-forget lane, and one sent while the link is down is dropped.
      const route = routeDesktopNotification('termWrite', [id, data]);
      try {
        if (route) connection.notify(route.method, route.params);
      } catch {
        // dropped
      }
    },
    termResize(id: unknown, cols: unknown, rows: unknown): void {
      const route = routeDesktopNotification('termResize', [id, cols, rows]);
      try {
        if (route) connection.notify(route.method, route.params);
      } catch {
        // dropped
      }
    },
    termAcknowledge(id: unknown, charCount: unknown, gen?: unknown): void {
      feed.acknowledge(String(id || ''), Number(charCount), typeof gen === 'number' ? gen : undefined);
    },
    async termDispose(id: unknown): Promise<void> {
      const tab = id as string;
      clearDeferredDetach(tab);
      detachIfAllFail.delete(tab);
      activeConsumers.delete(tab);
      evictInflight(tab);
      // A new tab under this id has a feed of its own, which its ensure attaches; an attach in flight is the old tab's.
      feed.dispose(tab);
      const { method, params } = routeDesktopOperation('termDispose', [tab]);
      await ctx.call(method, params).catch(() => {});
    },
    termFocus(id: unknown, focused: unknown): void {
      if (typeof id !== 'string' || !id) return;
      const { method, params } = routeDesktopOperation('termFocus', [id, focused === true]);
      void ctx.call(method, params).catch(() => {});
    },
    async termActivity(): Promise<TerminalActivityEvent[]> {
      await connection.whenSynced();
      return termActivity(connection.snapshot())
        .map(readTerminalActivityEvent)
        .filter((event): event is TerminalActivityEvent => event !== null);
    },
    claimTerminalRun: async (requestId: unknown): Promise<boolean> => {
      const claimed = { requestId: requiredString(requestId, 'terminal run request id', 128) };
      // No open link to the core: nothing is sent and the pane is told the claim did not go (the page ignores the answer).
      try {
        connection.notify(TERMINAL_RUN_CLAIMED, claimed);
      } catch {
        return false;
      }
      return true;
    },
    subscribeTermData: (listener: (event: TerminalDataEvent, gen?: number) => void) => {
      const unsubscribe = listen(dataListeners, listener);
      feed.flushPending();
      return unsubscribe;
    },
    subscribeTabTermData: (id: unknown, listener: (event: TerminalDataEvent, gen?: number) => void) => {
      const tab = typeof id === 'string' && id ? id : '';
      if (!tab) {
        const unsubscribe = listen(dataListeners, listener);
        feed.flushPending();
        return unsubscribe;
      }
      let scoped = tabDataListeners.get(tab);
      if (!scoped) {
        scoped = new Set();
        tabDataListeners.set(tab, scoped);
      }
      scoped.add(listener);
      feed.flushPending(tab);
      return () => {
        scoped.delete(listener);
        if (scoped.size === 0 && tabDataListeners.get(tab) === scoped) tabDataListeners.delete(tab);
      };
    },
    subscribeTermSizeOwner: (listener: (event: TerminalSizeOwnerEvent) => void) => listen(sizeOwnerListeners, listener),
    subscribeTermActivity: (listener: (event: TerminalActivityEvent) => void) => listen(activityListeners, listener),
    onTerminalRunRequested: (listener: (request: DesktopTerminalRunRequest) => void) => listen(runListeners, listener),
  };
  return api;
}
