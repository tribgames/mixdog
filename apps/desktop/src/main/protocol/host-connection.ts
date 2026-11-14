// The host role's `HostConnection` (main/host/connection.ts) over the one protocol connection: core→host server
// requests are answered through `respond`, core→host notifications and the connection's liveness come from its
// events. A request the core abandons (`serverRequest/resolved`) or loses with the socket aborts its handler.
import { HostRpcError } from '../host/connection';
import type { HostConnection } from '../host/connection';
import type { ProtocolConnection } from './connection';

/** JSON-RPC method not found: a core→host request this desktop registered no handler for. */
export const HOST_METHOD_NOT_FOUND = -32601;

type Source = Pick<ProtocolConnection, 'call' | 'notify' | 'respond' | 'sendBinary' | 'onEvent' | 'client' | 'onReplaced'>;

export function createHostConnection(source: Source): HostConnection {
  const requestHandlers = new Map<string, (params: unknown, signal: AbortSignal) => Promise<unknown>>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const closeListeners = new Set<() => void>();
  // The running requests of one connection by id: the client that asked them (`asker`), until its link goes down or a reopen
  // replaces it. The core numbers its requests per process (`host-1`, ...), so a restarted core asks under the ids of the one
  // before. A connection's requests end with it, aborted and forgotten here: a `serverRequest/resolved` of the next connection
  // reaches only that connection's requests, and an old request that settles late neither answers the next connection nor
  // removes the entry of a new request under its id.
  const inflight = new Map<string, AbortController>();
  let asker: unknown = null;
  const endInflight = (): void => {
    for (const abort of inflight.values()) abort.abort();
    inflight.clear();
  };
  /** The client serving now; the requests of one it replaced end. A reopen drops the old client and its events, its status
   *  included, so this runs once the reopen has attached the new client and at every event (the new client's first ones may
   *  come before the reopen settles). */
  const serving = (): unknown => {
    const live = source.client();
    if (live !== asker) {
      endInflight();
      asker = live;
    }
    return live;
  };
  source.onReplaced(() => void serving());

  source.onEvent((event) => {
    const live = serving();
    if (event.type === 'serverRequest') {
      const { id, method, params } = (event as { request: { id: string | number; method: string; params: unknown } }).request;
      const handler = requestHandlers.get(method);
      // A host request nobody here serves is answered, on the connection that asked it (`live`, read just now), rather than
      // left to time out in the core. Other server requests on this connection (approval cards, the takeover feed) are not
      // the host role's: their own consumers answer them.
      if (!handler) {
        if (method.startsWith('host/')) {
          source.respond(id, { error: { code: HOST_METHOD_NOT_FOUND, message: `${method} is not served by this desktop` } });
        }
        return;
      }
      const key = JSON.stringify(id);
      const abort = new AbortController();
      inflight.set(key, abort);
      // Answered only on the connection that asked, while the request still runs there.
      const answering = (): boolean => !abort.signal.aborted && source.client() === live;
      handler(params, abort.signal).then(
        (result) => {
          if (answering()) source.respond(id, { result });
        },
        (error: unknown) => {
          if (!answering()) return;
          const rpc = error instanceof HostRpcError ? error : null;
          source.respond(id, {
            error: {
              code: rpc?.code ?? -32000,
              message: error instanceof Error ? error.message : String(error),
              ...(rpc?.data !== undefined ? { data: rpc.data } : {}),
            },
          });
        }
      ).finally(() => {
        if (inflight.get(key) === abort) inflight.delete(key);
      });
    } else if (event.type === 'serverRequestResolved') {
      const id = (event as { params: { requestId?: string | number } }).params.requestId;
      if (id !== undefined) inflight.get(JSON.stringify(id))?.abort();
    } else if (event.type === 'notification') {
      const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
      notificationHandlers.get(method)?.(params);
    } else if (event.type === 'status') {
      const state = (event as { status: { state: string } }).status.state;
      if (state === 'ready') return;
      endInflight();
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
    handleRequest(method, handler) {
      if (requestHandlers.has(method)) throw new Error(`host request ${method} is already served`);
      requestHandlers.set(method, handler);
    },
    handleNotification: (method, handler) => void notificationHandlers.set(method, handler),
    servedMethods: () => [...new Set([...requestHandlers.keys(), ...notificationHandlers.keys()])].sort(),
    onClose: (listener) => void closeListeners.add(listener),
  };
}
