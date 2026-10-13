// IPC of a server window's Ports panel. Every call resolves the sender's
// connection; this PC's window has no Ports panel and is refused, so nothing is
// ever forwarded from it. The browser opens only the loopback URL of a forward
// main itself runs.
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract-ipc';
import type { DesktopConnection } from './desktop-connection';
import { ConnectionError } from './errors';
import type { ConnectionPool } from './pool';
import { resolveWindowConnection } from './routing';
import type { ServerPortForwards } from './server-port-forwards';
import type { WindowRouteRegistry } from './window-routes';

type PortsConnection = Pick<DesktopConnection, 'id' | 'kind' | 'ports'>;

export interface ServerPortsIpcDeps<T extends PortsConnection> {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  routes: WindowRouteRegistry;
  pool: ConnectionPool<T>;
  /** This PC's default browser. */
  openExternal(url: string): Promise<void>;
}

const portArg = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN);

export function registerServerPortsIpc<T extends PortsConnection>(deps: ServerPortsIpcDeps<T>): () => void {
  const portsOf = (event: IpcMainInvokeEvent): ServerPortForwards => {
    const connection = resolveWindowConnection(deps.routes, deps.pool, event.sender.id);
    if (connection.kind !== 'ssh' || !connection.ports) {
      throw new ConnectionError('ssh-unsupported', 'Port forwarding belongs to server windows.');
    }
    return connection.ports;
  };
  const handlers: Array<[string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]> = [
    [
      DESKTOP_IPC.serverPortsList,
      (event, rescan) => (rescan === false ? portsOf(event).view() : portsOf(event).refresh()),
    ],
    [
      DESKTOP_IPC.serverPortForward,
      (event, remotePort, localPort) =>
        portsOf(event).forward(
          portArg(remotePort),
          localPort === null || localPort === undefined ? null : portArg(localPort)
        ),
    ],
    [DESKTOP_IPC.serverPortStop, (event, remotePort) => portsOf(event).stop(portArg(remotePort))],
    [DESKTOP_IPC.serverPortDismiss, (event, port) => portsOf(event).dismiss(portArg(port))],
    [
      DESKTOP_IPC.serverPortOpen,
      (event, remotePort) => deps.openExternal(portsOf(event).browserUrl(portArg(remotePort))),
    ],
  ];
  for (const [channel, handler] of handlers) {
    deps.ipcMain.handle(channel, async (event, ...args) => handler(event, ...args));
  }
  return () => {
    for (const [channel] of handlers) deps.ipcMain.removeHandler(channel);
  };
}
