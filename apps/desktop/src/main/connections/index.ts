// Several daemon connections in one desktop process: this PC (`local`) plus any
// number of ssh servers, one window each. Every renderer request is answered
// by the connection of the window it came from.
export {
  LOCAL_CONNECTION_ID,
  type ConnectionIdentity,
  type ConnectionKind,
  type ConnectionManager,
  type ConnectionOpenOptions,
  type ConnectionProgress,
  type SshConnectionSpec,
} from './contract';
export { ConnectionError, type ConnectionErrorCode } from './errors';
export { ConnectionPool, type PooledConnection } from './pool';
export { WindowRouteRegistry, type RoutableWebContents } from './window-routes';
export { resolveWindowConnection } from './routing';
export { createConnectionIpcRouter, type ConnectionIpcRouter, type WindowIpcScope } from './ipc-router';
export { SSH_UNSUPPORTED_CHANNELS, connectionFeatureGate, remotePickerRequired } from './feature-gates';
export {
  REMOTE_STARTUP_TIMEOUT_MS,
  REMOTE_TUNNEL_READY_TIMEOUT_MS,
  createDesktopConnection,
  type DesktopConnection,
  type DesktopConnectionDependencies,
  type DesktopConnectionSpec,
} from './desktop-connection';
export { createConnectionManager, type ConnectionManagerDependencies } from './manager';
export { createServiceTerminalHost } from './terminal-host';
export { createConnectionWindowOpener, type ConnectionWindowOpenerDependencies } from './window-opener';
export {
  ConnectionLink,
  ReconnectLadder,
  hostGraceMs,
  reconnectDelayCapMs,
  remoteClientGraceMs,
} from './connection-link';
export { createPortForwardStore, type PortForwardStore } from './port-forward-store';
export { createServerPortForwards, type ServerPortForwards } from './server-port-forwards';
export { registerServerPortsIpc } from './ports-ipc';
export { createReattachReport } from './reattach-report';
export { createServerNotifier, type ServerNotifier } from './server-notifier';
export { createServerWindowRestore, type ServerWindowRestore } from './window-restore';
export { forwardConnectionLink, registerConnectionLinkIpc } from './link-ipc';
