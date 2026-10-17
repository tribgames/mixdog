// A page the transcript asks the session's browser pane to show. The request
// crosses two owners that never meet: the app shell reveals the pane (it owns
// the dock), and the pane itself loads the address (it owns the guest). One
// request carries both. The latest address per session stays pending until a
// pane has actually started loading it, so a card works whether the pane is
// already open, folded, replaced, or not mounted yet.

/** `agent`: an agent tool asked (visualize), not the user, so a browser panel
 *  the user closed stays closed; the address still waits for the pane. */
export type BrowserPageRequest = { sessionId: string; url: string; agent?: boolean };
type RevealListener = (request: BrowserPageRequest) => void;
type AddressListener = (url: string) => void;

const revealListeners = new Set<RevealListener>();
const addressListeners = new Map<string, Set<AddressListener>>();
const pendingAddress = new Map<string, { url: string; newTab: boolean }>();

/** True while a shell that can reveal a browser pane is mounted. A paired
 *  phone mounts one too: its pane streams the host's browser, so a requested
 *  address is navigated on the PC (see onBrowserPageAddressTaken). */
export function browserPageRequestsAvailable(): boolean {
  return revealListeners.size > 0;
}

/** `newTab` asks the pane to open the address in a freshly created tab
 *  instead of the current one. */
export function requestBrowserPage(
  sessionId: string,
  url: string,
  options?: { newTab?: boolean; agent?: boolean }
): void {
  if (!sessionId || !url) return;
  pendingAddress.set(sessionId, { url, newTab: options?.newTab === true });
  const request: BrowserPageRequest = options?.agent ? { sessionId, url, agent: true } : { sessionId, url };
  for (const listener of revealListeners) listener(request);
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
  if (pending) listener(pending.url);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) addressListeners.delete(sessionId);
  };
}

/** A pane without a local guest (a paired phone streaming the host's page)
 *  takes each requested address as it arrives, settling it at once: its
 *  navigation is a host command that cannot fail to start locally. */
export function onBrowserPageAddressTaken(
  sessionId: string,
  take: (request: { url: string; newTab: boolean }) => void
): () => void {
  return onBrowserPageAddressRequested(sessionId, () => {
    const request = pendingAddress.get(sessionId);
    if (!request) return;
    pendingAddress.delete(sessionId);
    take(request);
  });
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
  navigate: (url: string, newTab?: boolean) => boolean
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
    const request = pendingAddress.get(sessionId);
    const guest = currentGuest();
    if (!request || !guest || !guestReady(guest)) return;
    // Settle before navigating: a new-tab request must never run twice.
    if (!navigate(request.url, request.newTab)) return;
    if (pendingAddress.get(sessionId) === request) pendingAddress.delete(sessionId);
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
