import { useSyncExternalStore } from 'react';

// Whether the connected host lets every paired client use the provider, MCP
// and developer lanes (`remoteOpenAccess` in its challenge). An older host
// still refuses them, so those pages stay hidden until it says otherwise. This
// only drives what the UI offers; the host enforces on every call.
const CHANGED_EVENT = 'mixdog:remote-host-access-changed';
let openAccess = false;

export function isRemoteHostOpenAccess(): boolean {
  return openAccess;
}

export function setRemoteHostOpenAccess(next: boolean): void {
  if (openAccess === next) return;
  openAccess = next;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED_EVENT));
}

// The connected PC's own name, announced in the same handshake (`hostName`).
const NAME_CHANGED_EVENT = 'mixdog:remote-host-name-changed';
let hostName = '';

export function setRemoteHostName(next: string): void {
  const name = next.trim().slice(0, 80);
  if (name === hostName) return;
  hostName = name;
  if (typeof window !== 'undefined') window.dispatchEvent(new window.Event(NAME_CHANGED_EVENT));
}

/** Re-renders when the connected PC's name is learned; '' until then. */
export function useRemoteHostName(): string {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(NAME_CHANGED_EVENT, listener);
      return () => window.removeEventListener(NAME_CHANGED_EVENT, listener);
    },
    () => hostName,
    () => ''
  );
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

/** Re-renders when the connected host's access level is learned or changes. */
export function useRemoteHostOpenAccess(): boolean {
  return useSyncExternalStore(subscribe, isRemoteHostOpenAccess, () => false);
}
