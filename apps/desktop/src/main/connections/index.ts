// The daemon connections of one desktop process: this PC's own (`local`) plus one service connection for each server
// window, which the core asked for. Every renderer request is answered by the connection of the window it came from.
export { LOCAL_CONNECTION_ID, type ConnectionIdentity, type ConnectionKind } from './contract';
export { ConnectionError, type ConnectionErrorCode } from './errors';
export { ConnectionPool, type PooledConnection } from './pool';
export { WindowRouteRegistry, type RoutableWebContents } from './window-routes';
export { resolveWindowConnection } from './routing';
export { createConnectionIpcRouter, type ConnectionIpcRouter, type WindowIpcScope } from './ipc-router';
export { SSH_UNSUPPORTED_CHANNELS, connectionFeatureGate, remotePickerRequired } from './feature-gates';
export {
  createDesktopConnection,
  type DesktopConnection,
  type DesktopConnectionDependencies,
  type DesktopConnectionSpec,
} from './desktop-connection';
export { createServiceTerminalHost } from './terminal-host';
export { createConnectionWindowOpener, type ConnectionWindowOpenerDependencies } from './window-opener';
export { forwardConnectionLink, registerConnectionLinkIpc } from './link-ipc';
