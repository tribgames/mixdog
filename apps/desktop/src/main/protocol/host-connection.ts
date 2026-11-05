// The host role's `HostConnection` (main/host/connection.ts) over the one protocol connection: core→host server
// requests are answered through `respond`, core→host notifications and the connection's liveness come from its
// events. A request the core abandons (`serverRequest/resolved`) or loses with the socket aborts its handler.
import { HostRpcError } from '../host/connection';
import type { HostConnection } from '../host/connection';
import type { ProtocolConnection } from './connection';

type Source = Pick<ProtocolConnection, 'call' | 'notify' | 'respond' | 'sendBinary' | 'onEvent'>;

export function createHostConnection(source: Source): HostConnection {
  const requestHandlers = new Map<string, (params: unknown, signal: AbortSignal) => Promise<unknown>>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const closeListeners = new Set<() => void>();
  const inflight = new Map<string, AbortController>();

  source.onEvent((event) => {
    if (event.type === 'serverRequest') {
      const { id, method, params } = (event as { request: { id: string | number; method: string; params: unknown } }).request;
      const handler = requestHandlers.get(method);
      if (!handler) return;
      const key = JSON.stringify(id);
      const abort = new AbortController();
      inflight.set(key, abort);
      handler(params, abort.signal).then(
        (result) => {
          if (!abort.signal.aborted) source.respond(id, { result });
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          const rpc = error instanceof HostRpcError ? error : null;
          source.respond(id, {
            error: {
              code: rpc?.code ?? -32000,
              message: error instanceof Error ? error.message : String(error),
              ...(rpc?.data !== undefined ? { data: rpc.data } : {}),
            },
          });
        }
      ).finally(() => inflight.delete(key));
    } else if (event.type === 'serverRequestResolved') {
      const id = (event as { params: { requestId?: string | number } }).params.requestId;
      if (id !== undefined) inflight.get(JSON.stringify(id))?.abort();
    } else if (event.type === 'notification') {
      const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
      notificationHandlers.get(method)?.(params);
    } else if (event.type === 'status') {
      const state = (event as { status: { state: string } }).status.state;
      if (state === 'ready') return;
      for (const abort of inflight.values()) abort.abort();
      for (const listener of [...closeListeners]) listener();
    }
  });

  return {
    request: (method, params) => source.call(method, params),
    // A notification is an event of the moment: with no link it is dropped (state is re-sent at the next claim).
    notify(method, params) {
      try {
        source.notify(method, params);
      } catch {
        /* connection not ready */
      }
    },
    sendBinary: (frame) => source.sendBinary(frame),
    handleRequest: (method, handler) => void requestHandlers.set(method, handler),
    handleNotification: (method, handler) => void notificationHandlers.set(method, handler),
    onClose: (listener) => void closeListeners.add(listener),
  };
}
