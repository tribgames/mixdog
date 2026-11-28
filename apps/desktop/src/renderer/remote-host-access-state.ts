// `remoteOpenAccess` in the host's challenge; an older host still refuses these lanes.
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

export function subscribeRemoteHostOpenAccess(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

// The connected PC's own name, announced in the same handshake (`hostName`).
const NAME_CHANGED_EVENT = 'mixdog:remote-host-name-changed';
let hostName = '';

/** The connected PC's name; '' until it is learned. */
export function remoteHostName(): string {
  return hostName;
}

export function setRemoteHostName(next: string): void {
  const name = next.trim().slice(0, 80);
  if (name === hostName) return;
  hostName = name;
  if (typeof window !== 'undefined') window.dispatchEvent(new window.Event(NAME_CHANGED_EVENT));
}

export function subscribeRemoteHostName(listener: () => void): () => void {
  window.addEventListener(NAME_CHANGED_EVENT, listener);
  return () => window.removeEventListener(NAME_CHANGED_EVENT, listener);
}
