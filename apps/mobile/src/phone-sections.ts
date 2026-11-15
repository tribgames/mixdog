// `DesktopApi.sections` on the phone: the renderer's section store reads the client library's fold store directly, where the
// Electron window reads main's mirror of it. Everything is attached once the client is up, so a listener added at mount (before the
// first connection) still hears the first snapshot.
import type { ClientEvent, ProtocolClient, SessionFold } from '../../../packages/protocol-client/src/index.ts';
import type { PhoneBoot } from './phone-boot.ts';
import {
  EVENT_SECTIONS,
  SECTION_NAMES,
  type DesktopProtocolStatus,
  type DesktopSectionsApi,
  type DesktopSectionEntry,
  type DesktopSectionsPush,
  type RendererProtocolMethod,
} from '../../desktop/src/shared/contract-sections.ts';

type Client = ProtocolClient<SessionFold>;

/** The sections the page's store carries. Not `notice`: Node showed a phone a desktop notice only as it was raised, never one standing
 *  when it connected, so the phone's notices come from the notifications adapter (remote-protocol-notifications.ts) as raises the
 *  connected client hears, through `subscribeDesktopNotices`, not from held entries. */
const NAMES = SECTION_NAMES.filter((name) => name !== 'notice');

const statusOf = (client: Client): DesktopProtocolStatus => {
  const state = client.status.state;
  return state === 'ready' ? 'ready' : state === 'closed' ? 'closed' : 'reconnecting';
};

/** The renderer's adapter from a fold store to a pushes source (section-store.ts), passed in so this module needs none of the renderer. */
export type SectionsFromFoldStore = (
  store: Client['store'],
  names: readonly string[],
  status: () => DesktopProtocolStatus
) => { subscribe(listener: (push: DesktopSectionsPush) => void): () => void };

export function createPhoneSections(boot: Pick<PhoneBoot, 'start' | 'client' | 'onClient'>, sectionsSourceFromFoldStore: SectionsFromFoldStore): DesktopSectionsApi {
  // The installed phone removes its pairing overlay without reloading the page. Its API and listeners survive, but its
  // ProtocolClient does not. Never adopt the result of an old start promise after onClient has handed over to a new one.
  const upWith = (attach: (client: Client, current: () => boolean) => () => void): (() => void) => {
    let off: (() => void) | undefined;
    let stopped = false;
    let generation = 0;
    let held: Client | undefined;
    const offClient = boot.onClient((client) => {
      if (stopped || held === client) return;
      const turn = ++generation;
      off?.();
      held = client;
      const attached = attach(client, () => !stopped && generation === turn && boot.client() === client);
      if (!stopped && generation === turn) off = attached;
      else attached();
    });
    void boot.start().catch(() => undefined);
    return () => {
      stopped = true;
      generation++;
      offClient();
      off?.();
    };
  };
  const notifications = (client: Client, current: () => boolean, method: string, listener: (params: Record<string, unknown>) => void): (() => void) =>
    client.on((event: ClientEvent) => {
      if (current() && event.type === 'notification' && event.notification.method === method) {
        listener((event.notification.params ?? {}) as Record<string, unknown>);
      }
    });
  // A tell is not state: a phone whose leg was down is not told what was pushed meanwhile (the relay does not replay it), so the
  // state it hands out holds none; its page reads again on its own reconnect.
  const entriesOf = (client: Client): DesktopSectionEntry[] =>
    NAMES.filter((name) => !EVENT_SECTIONS.includes(name)).flatMap((name) => [...client.store.sections(name)]);
  // The last state of each sign-in flow's feed, and the flows whose feed was lost.
  const flows = new Map<string, unknown>();
  const lostFlows = new Set<string>();
  const loginListeners = new Set<(update: { flowId: string; state: unknown }) => void>();
  const lostListeners = new Set<(update: { flowId: string }) => void>();
  let stopTracking: (() => void) | undefined;
  const lose = (flowId: string): void => {
    if (lostFlows.has(flowId)) return;
    lostFlows.add(flowId);
    for (const listener of [...lostListeners]) listener({ flowId });
  };
  const track = (): void => {
    if (stopTracking) return;
    stopTracking = upWith((client, current) => {
      // A sign-in feed is connection-bound. Keep its last state for a reader, but never present an old flow as live.
      for (const flowId of flows.keys()) lose(flowId);
      const offs = [
        notifications(client, current, 'login/updated', (params) => {
          if (typeof params.flowId !== 'string') return;
          flows.set(params.flowId, params.state);
          lostFlows.delete(params.flowId);
          for (const listener of [...loginListeners]) listener({ flowId: params.flowId, state: params.state });
        }),
        client.on((event) => {
          if (current() && event.type === 'status' && event.status.state !== 'ready') {
            for (const flowId of flows.keys()) lose(flowId);
          }
        }),
        client.store.subscribe((change) => {
          if (current() && change.type === 'subscription' && change.state === 'lost' && change.feedId.startsWith('login:')) {
            lose(change.feedId.slice('login:'.length));
          }
        }),
      ];
      return () => offs.forEach((off) => off());
    });
  };
  const stopIdleTracking = (): void => {
    if (loginListeners.size || lostListeners.size) return;
    stopTracking?.();
    stopTracking = undefined;
    flows.clear();
    lostFlows.clear();
  };

  const rawCall = async (client: Client, method: string, params: unknown): Promise<unknown> =>
    (client.call as (method: string, params: unknown) => Promise<unknown>)(method, params);
  const currentClient = async (): Promise<Client> => {
    const started = await boot.start();
    return boot.client() ?? started.client;
  };
  // Only successful watches are replayed. A pending first call still belongs to its caller and must retain its result/error.
  // Unlike the desktop's window registry, this adapter has one page owner; fs/unwatch releases that owner's desired watch.
  type Watch = { params: Record<string, unknown>; active: boolean; epoch: number; wake?: () => void };
  const watches = new Map<string, Watch>();
  const pushListeners = new Set<(push: DesktopSectionsPush) => void>();
  let watchEpoch = 0;
  let watchClient: Client | undefined;
  let stopWatches: (() => void) | undefined;
  const stopIdleWatches = (): void => {
    if (watches.size) return;
    stopWatches?.();
    stopWatches = undefined;
    watchClient = undefined;
  };
  const cleanupReleased = (client: Client, watchId: string): void => {
    // Never park cleanup on a dead connection (call would wait for its next ready). Its server already releases its watches.
    if (client.status.state === 'ready') void rawCall(client, 'fs/unwatch', { watchId }).catch(() => undefined);
  };
  const replay = (watchId: string, watch: Watch): void => {
    const client = watchClient;
    if (!client || client.status.state !== 'ready' || !watch.active || watch.epoch === watchEpoch) return;
    const epoch = watch.epoch = watchEpoch;
    void rawCall(client, 'fs/watch', watch.params).then(() => {
      if (!watches.has(watchId)) cleanupReleased(client, watchId);
    }, (error: unknown) => {
      if (watches.get(watchId) !== watch || watchEpoch !== epoch || watchClient !== client) return;
      for (const listener of [...pushListeners]) listener({ kind: 'feedError', feedId: `fs:${watchId}`, message: error instanceof Error ? error.message : String(error) });
    });
  };
  const followWatches = (): void => {
    if (stopWatches) return;
    stopWatches = upWith((client, current) => {
      watchClient = client;
      watchEpoch++;
      for (const watch of watches.values()) watch.wake?.();
      let ready = client.status.state === 'ready';
      if (ready) for (const [id, watch] of watches) replay(id, watch);
      const off = client.on((event) => {
        if (!current() || event.type !== 'status') return;
        const next = event.status.state === 'ready';
        if (next && !ready) {
          watchEpoch++;
          for (const [id, watch] of watches) replay(id, watch);
        }
        for (const watch of watches.values()) watch.wake?.();
        ready = next;
      });
      return off;
    });
  };
  const call = async (method: RendererProtocolMethod, params: unknown): Promise<unknown> => {
    const input = params && typeof params === 'object' ? params as Record<string, unknown> : undefined;
    const watchId = typeof input?.watchId === 'string' ? input.watchId : undefined;
    if (method === 'fs/unwatch' && watchId !== undefined) {
      const released = watches.get(watchId);
      watches.delete(watchId);
      released?.wake?.();
      stopIdleWatches();
    }
    if (method !== 'fs/watch' || watchId === undefined) return rawCall(await currentClient(), method, params);
    const watch: Watch = { params: { ...input }, active: false, epoch: -1 };
    const replaced = watches.get(watchId);
    watches.set(watchId, watch);
    // A pending first call may be waiting for ready on the entry this one replaces. It no longer owns the id, but it
    // must still settle: future ready/unwatch events only visit the new entry. A request already sent keeps its own result.
    replaced?.wake?.();
    followWatches();
    try {
      let client = await currentClient();
      // Do not enqueue the first watch inside a disconnected client's ready wait. Its eventual send would be on the next
      // transport while carrying this one's epoch, and a successful answer would cause a duplicate replay.
      while (watches.get(watchId) === watch && client.status.state === 'reconnecting') {
        await new Promise<void>((resolve) => { watch.wake = resolve; });
        watch.wake = undefined;
        client = await currentClient();
      }
      if (watches.get(watchId) !== watch) return undefined;
      const epoch = watch.epoch = watchEpoch;
      const result = await rawCall(client, method, params);
      if (watches.get(watchId) !== watch) {
        if (!watches.has(watchId)) cleanupReleased(client, watchId);
        return result;
      }
      watch.active = true;
      // A late success on the old transport does not establish a watch on the replacement.
      if (watchClient !== client || watchEpoch !== epoch) replay(watchId, watch);
      return result;
    } catch (error) {
      if (watches.get(watchId) === watch) watches.delete(watchId);
      stopIdleWatches();
      throw error;
    }
  };

  return {
    core: async () => true,
    snapshot: async () => {
      const client = await currentClient();
      return { status: statusOf(client), entries: entriesOf(client), epoch: client.store.appFeed()?.epoch };
    },
    subscribe: (listener) => {
      pushListeners.add(listener);
      const stop = upWith((client, current) => {
        const push = (value: DesktopSectionsPush): void => { if (current()) listener(value); };
        const replace = (): void => {
          push({ kind: 'replace', stage: 'begin' });
          push({ kind: 'replace', stage: 'chunk', entries: entriesOf(client) });
          push({ kind: 'replace', stage: 'commit', epoch: client.store.appFeed()?.epoch });
        };
        const source = sectionsSourceFromFoldStore(client.store, NAMES, () => statusOf(client));
        const offs = [
          source.subscribe(push),
          client.on((event) => {
            if (event.type === 'status') push({ kind: 'status', status: statusOf(client) });
          }),
          // A whole app snapshot was folded after a reconnect: the held store is swapped for it at once.
          client.store.subscribe((change) => {
            if (current() && change.type === 'appSnapshot') replace();
          }),
        ];
        replace();
        push({ kind: 'status', status: statusOf(client) });
        return () => offs.forEach((off) => off());
      });
      return () => { pushListeners.delete(listener); stop(); };
    },
    call,
    subscribeFsChanged: (listener) =>
      upWith((client, current) =>
        notifications(client, current, 'fs/changed', (params) =>
          listener({
            watchId: String(params.watchId ?? ''),
            changedPaths: Array.isArray(params.changedPaths) ? params.changedPaths.map(String) : [],
            ...(typeof params.kind === 'string' ? { kind: params.kind } : {}),
          })
        )
      ),
    subscribeLoginUpdated: (listener) => {
      loginListeners.add(listener);
      track();
      return () => { loginListeners.delete(listener); stopIdleTracking(); };
    },
    subscribeLoginFeedLost: (listener) => {
      lostListeners.add(listener);
      track();
      return () => { lostListeners.delete(listener); stopIdleTracking(); };
    },
    loginFeed: async (flowId) => {
      await boot.start();
      return { state: flows.get(flowId), lost: lostFlows.has(flowId) || !flows.has(flowId) };
    },
  };
}
