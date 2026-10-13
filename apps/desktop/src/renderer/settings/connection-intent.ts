// A request from outside Settings → Connection (the title-bar PC menu, the
// "device is asking to connect" notice) to land on the page with one of its
// dialogs open. The panel may not be mounted yet, so the request waits here
// until it is.
export type ConnectionDialogRequest = 'connect' | 'open-pc' | 'ssh' | 'ssh-host';

/** The saved SSH server a 'ssh-host' request connects to. */
export interface SshHostRequest {
  id: string;
  name: string;
  target: string;
}

const EVENT = 'mixdog:connection-dialog-request';
let pending: ConnectionDialogRequest | null = null;
let pendingSshHost: SshHostRequest | null = null;

export function requestConnectionDialog(dialog: ConnectionDialogRequest, sshHost?: SshHostRequest): void {
  pending = dialog;
  pendingSshHost = sshHost ?? null;
  window.dispatchEvent(new Event(EVENT));
}

/** The server of the waiting 'ssh-host' request, once. */
export function takeSshHostRequest(): SshHostRequest | null {
  const host = pendingSshHost;
  pendingSshHost = null;
  return host;
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
