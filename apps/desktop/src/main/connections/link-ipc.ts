// What a window still asks of main about its connection: close this window (a server window detaches when it closes) and
// show Settings → Connection in this PC's window. The link state, retry, the Ports panel and the reopen setting are the
// core's (`connections/*`), read by the window over its own port. Each call needs the sender to be a routed window.
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

import { onHostListsChanged } from '../host-lists-changed';
import { DESKTOP_IPC } from '../../shared/contract-ipc';
import { ConnectionError } from './errors';
import type { WindowRouteRegistry } from './window-routes';

export interface ConnectionLinkIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  routes: WindowRouteRegistry;
  /** Closes the sender's window (a server window detaches when it closes). */
  closeWindow(sender: WebContents): void;
  /** Shows Settings → Connection in this PC's window. */
  showConnectionSettings(): void;
}

export function registerConnectionLinkIpc(deps: ConnectionLinkIpcDeps): () => void {
  const routed = (event: IpcMainInvokeEvent): void => {
    if (deps.routes.connectionIdFor(event.sender.id) === undefined) {
      throw new ConnectionError('connection-route-missing', 'This window is not attached to a Mixdog connection.');
    }
  };
  const handlers: Array<[string, (event: IpcMainInvokeEvent) => void]> = [
    [
      DESKTOP_IPC.connectionCloseWindow,
      (event) => {
        routed(event);
        deps.closeWindow(event.sender);
      },
    ],
    [
      DESKTOP_IPC.connectionOpenSettings,
      (event) => {
        routed(event);
        deps.showConnectionSettings();
      },
    ],
  ];
  for (const [channel, handler] of handlers) {
    deps.ipcMain.handle(channel, async (event) => handler(event));
  }
  return () => {
    for (const [channel] of handlers) deps.ipcMain.removeHandler(channel);
  };
}

/** Tells one window the saved servers and PCs it lists changed (it reads them again, no timer), until the returned
 *  disposer runs (the window closed). */
export function forwardConnectionLink(target: Pick<WebContents, 'send' | 'isDestroyed'>): () => void {
  return onHostListsChanged(() => {
    if (!target.isDestroyed()) target.send(DESKTOP_IPC.hostListsChanged, null);
  });
}
