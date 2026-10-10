// A page the transcript asks the session's browser pane to show. The request
// crosses two owners that never meet: the app shell reveals the pane (it owns
// the dock), and the pane itself loads the address (it owns the guest). One
// request carries both. The latest address per session stays pending until a
// pane has actually started loading it, so a card works whether the pane is
// already open, folded, replaced, or not mounted yet.

export type BrowserPageRequest = { sessionId: string; url: string };
type RevealListener = (request: BrowserPageRequest) => void;
type AddressListener = (url: string) => void;

const revealListeners = new Set<RevealListener>();
const addressListeners = new Map<string, Set<AddressListener>>();
const pendingAddress = new Map<string, string>();

/** True while a shell that can reveal a browser pane is mounted. A surface
 *  without one (a paired phone) shows no "open" affordance. */
export function browserPageRequestsAvailable(): boolean {
  return revealListeners.size > 0;
}

export function requestBrowserPage(sessionId: string, url: string): void {
  if (!sessionId || !url) return;
  pendingAddress.set(sessionId, url);
  for (const listener of revealListeners) listener({ sessionId, url });
  const listeners = addressListeners.get(sessionId);
  if (listeners) for (const listener of [...listeners]) listener(url);
}

export function onBrowserPageRevealRequested(listener: RevealListener): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}

/** Subscribe a session's pane to addresses; one still pending (requested
 *  before the pane existed) is delivered at once. Delivery does not settle
 *  it: the pane settles it once the page is loading. */
export function onBrowserPageAddressRequested(sessionId: string, listener: AddressListener): () => void {
  let listeners = addressListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    addressListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  const pending = pendingAddress.get(sessionId);
  if (pending) listener(pending);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) addressListeners.delete(sessionId);
  };
}

type RequestedGuest = {
  getWebContentsId(): number;
  addEventListener(type: 'dom-ready', listener: () => void): void;
  removeEventListener(type: 'dom-ready', listener: () => void): void;
};

/** Loads a session's latest requested address into whichever guest element
 *  the pane has now. `navigate` returns false when it could not start the
 *  load; the address then stays pending. `sync` is cheap and idempotent: call
 *  it on every request and whenever the element may have been replaced. */
export function bindRequestedAddress<G extends RequestedGuest>(
  sessionId: string,
  currentGuest: () => G | null,
  navigate: (url: string) => boolean
): { sync(): void; dispose(): void } {
  let attached: G | null = null;
  const guestReady = (guest: G) => {
    try {
      return Number(guest.getWebContentsId()) > 0;
    } catch {
      return false;
    }
  };
  const load = () => {
    const url = pendingAddress.get(sessionId);
    const guest = currentGuest();
    if (!url || !guest || !guestReady(guest)) return;
    if (!navigate(url)) return;
    if (pendingAddress.get(sessionId) === url) pendingAddress.delete(sessionId);
  };
  const sync = () => {
    const guest = currentGuest();
    if (guest !== attached) {
      attached?.removeEventListener('dom-ready', load);
      attached = guest;
      attached?.addEventListener('dom-ready', load);
    }
    load();
  };
  const stop = onBrowserPageAddressRequested(sessionId, sync);
  return {
    sync,
    dispose() {
      stop();
      attached?.removeEventListener('dom-ready', load);
      attached = null;
    },
  };
}
