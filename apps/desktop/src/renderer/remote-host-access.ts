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

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

/** Re-renders when the connected host's access level is learned or changes. */
export function useRemoteHostOpenAccess(): boolean {
  return useSyncExternalStore(subscribe, isRemoteHostOpenAccess, () => false);
}
