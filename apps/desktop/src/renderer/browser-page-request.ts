// A page the transcript asks the session's browser pane to show. The request
// crosses two owners that never meet: the app shell reveals the pane (it owns
// the dock), and the pane itself loads the address (it owns the guest). The
// address waits here until a pane for that session takes it, so a card works
// whether the pane is already open, folded, or not mounted yet.

type RevealListener = (sessionId: string) => void;
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
  const listeners = addressListeners.get(sessionId);
  if (listeners?.size) {
    for (const listener of listeners) listener(url);
  } else {
    pendingAddress.set(sessionId, url);
  }
  for (const listener of revealListeners) listener(sessionId);
}

export function onBrowserPageRevealRequested(listener: RevealListener): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}

/** Subscribe a session's pane to addresses; one that was requested before the
 *  pane existed is delivered at once. */
export function onBrowserPageAddressRequested(sessionId: string, listener: AddressListener): () => void {
  let listeners = addressListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    addressListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  const pending = pendingAddress.get(sessionId);
  if (pending) {
    pendingAddress.delete(sessionId);
    listener(pending);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) addressListeners.delete(sessionId);
  };
}
