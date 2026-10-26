// Opens the whole-PC screen view on a paired phone. Two entries share it: the
// takeover card's "Open" (a Computer Use hand-off) and the ⋯ menu's "View
// entire PC screen". The app shell mounts one host that reads this store, so
// a request works whether or not the view was open before.
import { useSyncExternalStore } from 'react';

import type { DesktopApi } from '../shared/contract';
import { remoteWebrtcHost } from './remote-webrtc-bridge';

let open = false;
const listeners = new Set<() => void>();

const set = (next: boolean): void => {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
};

export const openRemoteScreen = (): void => set(true);
export const closeRemoteScreen = (): void => set(false);
export const remoteScreenOpen = (): boolean => open;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useRemoteScreenOpen(): boolean {
  return useSyncExternalStore(subscribe, remoteScreenOpen, remoteScreenOpen);
}

/** The view is offered on a phone whose connected host serves the live-view
 *  contract (the screen source rides the same capability). Read per use: a
 *  reconnect may reach another host. */
export function remoteScreenAvailable(api: DesktopApi | undefined, phone: boolean): boolean {
  return phone && remoteWebrtcHost(api) && typeof api.remoteScreenDisplays === 'function';
}
