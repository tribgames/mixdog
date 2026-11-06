// The model proxy of a server core (desktop-services.md §12.4): the server sends `model/proxy/execute` to this
// connection, which runs the call on this PC's own core (`modelProxy/run`), streams its events back as
// `model/proxy/event` and answers with the result. The server's `model/proxy/cancel { requestId }` is relayed to the
// local core as `modelProxy/cancel { runId }` for the run that request started, as Node's host aborts the running
// call it keeps under the request id (model-proxy-host.ts `abortCancelled`).
//
// Shapes are the Rust ones (mixdog-app-protocol `v2/host.rs`, `v2/model_proxy.rs`) until the regenerated TS types
// carry the run and cancel params.
import type { ConnectionClientEvent, ProtocolConnection } from './connection';

const EXECUTE = 'model/proxy/execute';
const EVENT = 'model/proxy/event';
const CANCEL = 'model/proxy/cancel';
const RUN = 'modelProxy/run';
const RUN_EVENT = 'modelProxy/run/event';
const RUN_CANCEL = 'modelProxy/cancel';

type RequestId = string | number;

interface ExecuteParams {
  call: unknown;
}
interface RunResult {
  result: { result?: string; failure?: unknown } & Record<string, unknown>;
}

/** Run ids are scoped by the local core's asking connection, which every server relay shares. */
let relays = 0;

/** Starts serving `server`'s proxied model calls on `local`. Returns the stop; runs in flight are left to finish. */
export function relayModelProxy(
  server: Pick<ProtocolConnection, 'onEvent' | 'respond' | 'notify'>,
  local: Pick<ProtocolConnection, 'call' | 'notify' | 'onEvent'>
): () => void {
  const prefix = `proxy${relays++}:`;
  // The run each server request started, and the request each run belongs to.
  const runs = new Map<string, string>();
  const requests = new Map<string, RequestId>();

  const stopServer = server.onEvent((event: ConnectionClientEvent) => {
    if (event.type === 'serverRequest') {
      const { id, method, params } = (event as { request: { id: RequestId; method: string; params: unknown } }).request;
      if (method === EXECUTE) execute(id, params as ExecuteParams);
    } else if (event.type === 'notification') {
      const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
      if (method !== CANCEL) return;
      const requestId = (params as { requestId?: RequestId } | undefined)?.requestId;
      const runId = requestId === undefined ? undefined : runs.get(JSON.stringify(requestId));
      // A call that is over, or never was, has nothing to stop.
      if (runId !== undefined) local.notify(RUN_CANCEL, { runId });
    }
  });

  const stopLocal = local.onEvent((event: ConnectionClientEvent) => {
    if (event.type !== 'notification') return;
    const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
    if (method !== RUN_EVENT) return;
    const { runId, event: runEvent } = params as { runId: string; event: unknown };
    const requestId = requests.get(runId);
    if (requestId !== undefined) server.notify(EVENT, { requestId, event: runEvent });
  });

  function execute(id: RequestId, params: ExecuteParams): void {
    const key = JSON.stringify(id);
    const runId = `${prefix}${key}`;
    runs.set(key, runId);
    requests.set(runId, id);
    local
      .call(RUN, { runId, call: params.call })
      .then(
        (answer) => {
          const { result } = answer as RunResult;
          // The error vocabulary of the server has no place for a failure: it is the data of the error.
          if (result.result === 'failed') {
            const failure = result.failure as { message?: string } | undefined;
            server.respond(id, { error: { code: -32000, message: failure?.message ?? 'The model call failed.', data: result.failure } });
          } else {
            server.respond(id, { result: answer });
          }
        },
        (error: unknown) => {
          server.respond(id, { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        }
      )
      .finally(() => {
        runs.delete(key);
        requests.delete(runId);
      });
  }

  return () => {
    stopServer();
    stopLocal();
  };
}
