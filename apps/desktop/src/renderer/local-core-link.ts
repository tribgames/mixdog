import { useSyncExternalStore } from 'react';

import type { CorePortBridge } from './core-direct/port-connector';
import { isRemoteHostRenderer } from './remote-ui-projection';

/** The window's own link to its local core, as the first screen needs it: the cover's end belongs to it. */
export type LocalCoreLink = 'none' | 'opening' | 'open';

export interface LocalCoreLinkStore {
  get(): LocalCoreLink;
  subscribe(listener: () => void): () => void;
  /** Follows `connection`: the link is open while its status is `ready`. */
  watch(connection: { readonly status: string; onState(listener: () => void): () => void }): void;
}

/** A window with a port bridge (the desktop app's) has a local core link to wait for: until a connection is watched it is opening.
 *  One without (a paired phone, a plain browser) has none. */
export function createLocalCoreLinkStore(bridge: unknown): LocalCoreLinkStore {
  let link: LocalCoreLink = bridge ? 'opening' : 'none';
  const listeners = new Set<() => void>();
  const set = (next: LocalCoreLink): void => {
    if (next === link) return;
    link = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => link,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch: (connection) => {
      if (!bridge) return;
      const follow = (): void => set(connection.status === 'ready' ? 'open' : 'opening');
      connection.onState(follow);
      follow();
    },
  };
}

let shared: LocalCoreLinkStore | undefined;
function store(): LocalCoreLinkStore {
  shared ??= createLocalCoreLinkStore(typeof window === 'undefined' ? undefined : (window as { mixdogCorePort?: CorePortBridge }).mixdogCorePort);
  return shared;
}

/** Called where the window's connection to its core is made (core-direct/install.ts). */
export function watchLocalCoreLink(connection: Parameters<LocalCoreLinkStore['watch']>[0]): void {
  store().watch(connection);
}

export function useLocalCoreLink(): LocalCoreLink {
  const remote = isRemoteHostRenderer();
  const current = store();
  return useSyncExternalStore(current.subscribe, () => (remote ? 'none' : current.get()), () => 'none');
}
