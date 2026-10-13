import { ConnectionError } from './errors';
import type { ConnectionPool, PooledConnection } from './pool';
import type { WindowRouteRegistry } from './window-routes';

/** The one way main finds the connection a window drives. A window without a
 *  route, or whose connection is gone, is an error: nothing falls back to the
 *  local connection. */
export function resolveWindowConnection<T extends PooledConnection>(
  routes: WindowRouteRegistry,
  pool: ConnectionPool<T>,
  webContentsId: number
): T {
  const connectionId = routes.connectionIdFor(webContentsId);
  if (connectionId === undefined) {
    throw new ConnectionError('connection-route-missing', 'This window is not attached to a Mixdog connection.');
  }
  const connection = pool.get(connectionId);
  if (!connection) {
    throw new ConnectionError('connection-missing', `The connection "${connectionId}" for this window is not open.`);
  }
  return connection;
}
