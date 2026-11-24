import { useSyncExternalStore } from 'react';

import type { CorePortBridge } from './core-direct/port-connector';
import { isRemoteHostRenderer } from './remote-ui-projection';

/** The window's own link to its local core, as the first screen needs it: the cover's end belongs to it. `failed`: the first open
 *  ended for good (the client's first-connect ladder gave up) before the link ever opened. */
export type LocalCoreLink = 'none' | 'opening' | 'open' | 'failed';

export interface LocalCoreLinkStore {
  get(): LocalCoreLink;
  /** Why the first open failed, while the link is `failed`. */
  reason(): string;
  subscribe(listener: () => void): () => void;
  /** Follows `connection`: the link is open while its status is `ready`. */
  watch(connection: {
    readonly status: string;
    onState(listener: () => void): () => void;
    link?(): { closed: { message: string } | null };
  }): void;
}

/** A window with a port bridge (the desktop app's) has a local core link to wait for: until a connection is watched it is opening.
 *  One without (a paired phone, a plain browser) has none. */
function createLocalCoreLinkStore(bridge: unknown): LocalCoreLinkStore {
  let link: LocalCoreLink = bridge ? 'opening' : 'none';
  let why = '';
  let everOpen = false;
  const listeners = new Set<() => void>();
  const set = (next: LocalCoreLink, reason = ''): void => {
    if (next === link && reason === why) return;
    link = next;
    why = reason;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => link,
    reason: () => why,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch: (connection) => {
      if (!bridge) return;
      const follow = (): void => {
        if (connection.status === 'ready') {
          everOpen = true;
          set('open');
        } else if (!everOpen && connection.status === 'closed') {
          set('failed', connection.link?.().closed?.message ?? '');
        } else {
          set('opening');
        }
      };
      connection.onState(follow);
      follow();
    },
  };
}

let shared: LocalCoreLinkStore | undefined;
function store(): LocalCoreLinkStore {
  shared ??= createLocalCoreLinkStore(
    typeof window === 'undefined' ? undefined : (window as { mixdogCorePort?: CorePortBridge }).mixdogCorePort
  );
  return shared;
}

/** Called where the window's connection to its core is made (core-direct/install.ts). */
export function watchLocalCoreLink(connection: Parameters<LocalCoreLinkStore['watch']>[0]): void {
  store().watch(connection);
}

/** The link now, and every change of it, outside React. */
export function localCoreLink(): LocalCoreLink {
  return store().get();
}
export function subscribeLocalCoreLink(listener: () => void): () => void {
  return store().subscribe(listener);
}

/** Why the window's first open to its core failed (the client's last error), while the link is `failed`. */
export function useLocalCoreLinkFailure(): string {
  const current = store();
  return useSyncExternalStore(current.subscribe, current.reason, () => '');
}

export function useLocalCoreLink(): LocalCoreLink {
  const remote = isRemoteHostRenderer();
  const current = store();
  return useSyncExternalStore(
    current.subscribe,
    () => (remote ? 'none' : current.get()),
    () => 'none'
  );
}
