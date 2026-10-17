// IPC of a window's link to its daemon: the state a server window shows and
// pushes, its reconnect / close actions, and this PC's window's "reopen server
// windows at launch" setting. Each call resolves the sender's connection; the
// pushes go to that connection's windows only.
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract-ipc';
import type { DesktopConnectionLinkView, DesktopConnectionNotice } from '../../shared/contract-connection-link';
import type { DesktopServerPortsView } from '../../shared/contract-server-ports';
import { LOCAL_CONNECTION_ID } from './contract';
import type { DesktopConnection } from './desktop-connection';
import type { ConnectionPool } from './pool';
import { resolveWindowConnection } from './routing';
import type { WindowRouteRegistry } from './window-routes';
import type { ServerWindowRestore } from './window-restore';

type LinkedConnection = Pick<DesktopConnection, 'id' | 'kind' | 'link' | 'reconnect'> &
  Partial<Pick<DesktopConnection, 'modelProxy'>>;

/** What this PC's window needs to run a user's connect attempt for a server. */
export interface ConnectionSignInRequest {
  id: string;
  name: string;
  target: string;
}

export interface ConnectionLinkIpcDeps<T extends LinkedConnection> {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  routes: WindowRouteRegistry;
  pool: ConnectionPool<T>;
  restore: Pick<ServerWindowRestore, 'isEnabled' | 'setEnabled' | 'progress'>;
  /** Closes the sender's window (a server window detaches when it closes). */
  closeWindow(sender: WebContents): void;
  /** Shows Settings → Connection in this PC's window. */
  showConnectionSettings(): void;
  /** A refused login or changed host key: this PC's window runs the user's
   *  connect attempt for the server (it may prompt), which reopens the
   *  stopped connection in place. */
  requestSignIn(connection: T): void;
}

export function registerConnectionLinkIpc<T extends LinkedConnection>(deps: ConnectionLinkIpcDeps<T>): () => void {
  const connectionOf = (event: IpcMainInvokeEvent): T =>
    resolveWindowConnection(deps.routes, deps.pool, event.sender.id);
  const localOnly = (event: IpcMainInvokeEvent): void => {
    if (deps.routes.connectionIdFor(event.sender.id) !== LOCAL_CONNECTION_ID) {
      throw new Error('This setting belongs to this PC’s window.');
    }
  };
  const handlers: Array<[string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]> = [
    [DESKTOP_IPC.connectionLinkGet, (event) => connectionOf(event).link?.view() ?? null],
    [
      DESKTOP_IPC.connectionRetry,
      async (event) => {
        const connection = connectionOf(event);
        const state = connection.link?.view().state;
        // Automatic attempts never prompt: what needs the user goes through
        // the connect flow of this PC's window.
        if (state?.status === 'lost' && state.settingsRequired) {
          deps.requestSignIn(connection);
          return;
        }
        // The outcome shows in the link state; a failed attempt is not an
        // error of the button.
        await connection.reconnect().catch(() => undefined);
      },
    ],
    [
      DESKTOP_IPC.connectionRetryNow,
      (event) => {
        // Only skips a pending countdown; a lost link goes through Reconnect.
        connectionOf(event).link?.attemptNow();
      },
    ],
    [
      DESKTOP_IPC.connectionCloseWindow,
      (event) => {
        connectionOf(event);
        deps.closeWindow(event.sender);
      },
    ],
    [
      DESKTOP_IPC.connectionOpenSettings,
      (event) => {
        connectionOf(event);
        deps.showConnectionSettings();
      },
    ],
    [
      DESKTOP_IPC.reopenServerWindowsGet,
      (event) => {
        localOnly(event);
        return deps.restore.isEnabled();
      },
    ],
    [
      DESKTOP_IPC.reopenServerWindowsSet,
      (event, enabled) => {
        localOnly(event);
        return deps.restore.setEnabled(enabled === true);
      },
    ],
    [
      DESKTOP_IPC.serverRestoreProgressGet,
      (event) => {
        localOnly(event);
        return deps.restore.progress();
      },
    ],
  ];
  for (const [channel, handler] of handlers) {
    deps.ipcMain.handle(channel, async (event, ...args) => handler(event, ...args));
  }
  return () => {
    for (const [channel] of handlers) deps.ipcMain.removeHandler(channel);
  };
}

/** Pushes one connection's link state and notices to one of its windows,
 *  until the returned disposer runs (the window closed). */
export function forwardConnectionLink(
  connection: Pick<DesktopConnection, 'link' | 'subscribeNotices'> & Partial<Pick<DesktopConnection, 'ports'>>,
  target: Pick<WebContents, 'send' | 'isDestroyed'>
): () => void {
  const send = (
    channel: string,
    value: DesktopConnectionLinkView | DesktopConnectionNotice | DesktopServerPortsView
  ): void => {
    if (!target.isDestroyed()) target.send(channel, value);
  };
  const unsubscribers = [
    connection.link?.subscribe((view) => send(DESKTOP_IPC.connectionLinkState, view)) ?? (() => {}),
    connection.subscribeNotices((notice) => send(DESKTOP_IPC.connectionNotice, notice)),
    connection.ports?.subscribe((view) => send(DESKTOP_IPC.serverPortsChanged, view)) ?? (() => {}),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
