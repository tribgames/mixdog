// A request from outside Settings → Connection (the title-bar PC menu, the
// "device is asking to connect" notice) to land on the page with one of its
// dialogs open. The panel may not be mounted yet, so the request waits here
// until it is.
export type ConnectionDialogRequest = 'connect' | 'open-pc';

const EVENT = 'mixdog:connection-dialog-request';
let pending: ConnectionDialogRequest | null = null;

export function requestConnectionDialog(dialog: ConnectionDialogRequest): void {
  pending = dialog;
  window.dispatchEvent(new Event(EVENT));
}

/** The waiting request, once. */
export function takeConnectionDialogRequest(): ConnectionDialogRequest | null {
  const dialog = pending;
  pending = null;
  return dialog;
}

export function subscribeConnectionDialogRequests(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
