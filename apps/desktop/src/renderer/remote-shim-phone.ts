// The phone's DesktopApi switch: the relay web app's `window.mixdogDesktop` is built here over the protocol client
// (apps/mobile/src/phone-boot.ts). `createRemoteApi` keeps naming calls the way the Node core did; the context's `call`/`fire`
// answer them through the adapters (remote-shim-protocol.ts) instead of a socket.
import { bootPhone, type PhoneEnv } from '../../../mobile/src/phone-boot';
import { createPhoneSections } from '../../../mobile/src/phone-sections';
import type { DesktopApi, SessionSnapshot } from '../shared/contract';
import { createProtocolRouter, type PhoneProtocolAdapter, type PhoneProtocolHost } from './remote-shim-protocol';
import { createRemoteApi } from './remote-shim-api';
import { sectionsSourceFromFoldStore } from './section-store';
import type { RemoteShimContext } from './remote-shim-state';

const REMOTE_STATE_GAP_EVENT = 'mixdog:remote-state-gap';

export function createPhoneApi(ctx: RemoteShimContext, adapters: readonly PhoneProtocolAdapter[], env: PhoneEnv): DesktopApi {
  // The router is made below, before any connection; the flags are first read once a connection is up.
  const boot = bootPhone(ctx, { ...env, claims: (method) => router.claims(method) });
  const host: PhoneProtocolHost = {
    ctx,
    client: () => {
      const client = boot.client();
      if (!client) throw new Error('phone: the protocol client is not up');
      return client;
    },
    declareLane: boot.declareLane,
    onClient: boot.onClient,
  };
  const router = createProtocolRouter(adapters, {
    host,
    started: boot.start,
    synced: boot.synced,
    probe: boot.wakeProbe,
    silentSince: boot.silentSince,
  });

  const fanOut = <T>(listeners: Set<(value: T) => void>, value: T): void => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch {
        /* renderer listener fault */
      }
    }
  };
  const publishLanes = (): void => boot.useLanes(ctx.activeLanes);
  Object.assign(ctx, {
    phone: {
      start: boot.start,
      synced: boot.synced,
      setVisibleSessions: boot.setVisibleSessions,
      refreshScreen: boot.refreshScreen,
      recycle: () => boot.link?.wake(),
      prefetchBootReads: router.prefetch,
    },
    fanOut,
    dispatchState: (snapshot: SessionSnapshot) => fanOut(ctx.stateListeners, snapshot),
    requestResync: () => window.dispatchEvent(new Event(REMOTE_STATE_GAP_EVENT)),
    resetDeltaState: () => {
      ctx.sessionsCatalog.reset();
      ctx.agentsCatalog.reset();
      ctx.sessionInbox.reset();
    },
    publishLanes,
    laneSubscription: <T>(lane: string, listeners: Set<T>, listener: T): (() => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        ctx.activeLanes.add(lane);
        publishLanes();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          ctx.activeLanes.delete(lane);
          publishLanes();
        }
      };
    },
    connect: boot.start,
    invoke: router.call,
    call: router.call,
    readCatalog: (_catalog: unknown, method: string) => router.call(method, []),
    fire: router.fire,
  });
  router.install();
  const api = createRemoteApi(ctx);
  Object.defineProperty(api, 'sections', { value: createPhoneSections(boot, sectionsSourceFromFoldStore), enumerable: true });
  return api;
}
