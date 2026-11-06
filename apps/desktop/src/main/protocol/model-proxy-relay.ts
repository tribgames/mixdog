// The model proxy of a server core (desktop-services.md §12.4): the server sends `model/proxy/execute` to this
// connection, which runs the call on this PC's own core (`modelProxy/run`), streams its events back as
// `model/proxy/event` and answers with the result. The server's `model/proxy/cancel { requestId }` is relayed to the
// local core as `modelProxy/cancel { runId }` for the run that request started, as Node's host aborts the running
// call it keeps under the request id (model-proxy-host.ts `abortCancelled`).
//
import type {
  ModelProxyCancelParams,
  ModelProxyEventParams,
  ModelProxyExecuteParams,
  ModelProxyResult,
  ModelProxyRunCancelParams,
  ModelProxyRunEventParams,
  ModelProxyRunParams,
} from '../../../../../packages/protocol/src/index.ts';
import type { ConnectionClientEvent, ProtocolConnection } from './connection';

const EXECUTE = 'model/proxy/execute';
const EVENT = 'model/proxy/event';
const CANCEL = 'model/proxy/cancel';
const RUN = 'modelProxy/run';
const RUN_EVENT = 'modelProxy/run/event';
const RUN_CANCEL = 'modelProxy/cancel';

type RequestId = string | number;

type ExecuteParams = ModelProxyExecuteParams;
type RunResult = ModelProxyResult;

/** Run ids are scoped by the local core's asking connection, which every server relay shares; a request id of a
 *  later server connection may repeat one of an earlier, so every run gets its own. */
let runCount = 0;

/** Starts serving `server`'s proxied model calls on `local`. Returns the stop, which abandons the calls in flight
 *  as Node's `dispose` does (model-proxy-host.ts:1110-1114). */
export function relayModelProxy(
  server: Pick<ProtocolConnection, 'onEvent' | 'respond' | 'notify'>,
  local: Pick<ProtocolConnection, 'call' | 'notify' | 'onEvent'>
): () => void {
  // The run each server request started, and the request each run belongs to.
  const runs = new Map<string, string>();
  const requests = new Map<string, RequestId>();

  // The server has failed these calls once its link is gone (the lease of Node's host, replaced by connection
  // liveness, §12.4): finishing them would only spend for nothing. Stopped, forgotten and left unanswered, as
  // `abandonAll` does (model-proxy-host.ts:803-809, :814-822).
  const abandonAll = (): void => {
    const abandoned = [...runs.values()];
    runs.clear();
    requests.clear();
    for (const runId of abandoned) local.notify(RUN_CANCEL, { runId } satisfies ModelProxyRunCancelParams);
  };

  const stopServer = server.onEvent((event: ConnectionClientEvent) => {
    if (event.type === 'status') {
      if ((event as { status: { state: string } }).status.state !== 'ready') abandonAll();
    } else if (event.type === 'serverRequest') {
      const { id, method, params } = (event as { request: { id: RequestId; method: string; params: unknown } }).request;
      if (method === EXECUTE) execute(id, params as ExecuteParams);
    } else if (event.type === 'notification') {
      const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
      if (method !== CANCEL) return;
      const requestId = (params as Partial<ModelProxyCancelParams> | undefined)?.requestId;
      const runId = requestId === undefined ? undefined : runs.get(JSON.stringify(requestId));
      // A call that is over, or never was, has nothing to stop.
      if (runId !== undefined) local.notify(RUN_CANCEL, { runId } satisfies ModelProxyRunCancelParams);
    }
  });

  const stopLocal = local.onEvent((event: ConnectionClientEvent) => {
    if (event.type !== 'notification') return;
    const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
    if (method !== RUN_EVENT) return;
    const { runId, event: runEvent } = params as ModelProxyRunEventParams;
    const requestId = requests.get(runId);
    if (requestId !== undefined) server.notify(EVENT, { requestId, event: runEvent } satisfies ModelProxyEventParams);
  });

  function execute(id: RequestId, params: ExecuteParams): void {
    const key = JSON.stringify(id);
    const runId = `proxy${runCount++}`;
    runs.set(key, runId);
    requests.set(runId, id);
    // An abandoned run is no longer in `runs`: its answer is not sent.
    const live = (): boolean => runs.get(key) === runId;
    local
      .call(RUN, { runId, call: params.call } satisfies ModelProxyRunParams)
      .then(
        (answer) => {
          if (!live()) return;
          const { result } = answer as RunResult;
          // The error vocabulary of the server has no place for a failure: it is the data of the error. Node
          // answers a failed call with the error record (name, message, props) and no numeric code
          // (model-proxy-host.ts:896-910), so -32000 and the failure's message stand in.
          if (result.result === 'failed') {
            const { failure } = result;
            server.respond(id, { error: { code: -32000, message: failure.message, data: failure } });
          } else {
            server.respond(id, { result: answer });
          }
        },
        (error: unknown) => {
          if (!live()) return;
          server.respond(id, { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        }
      )
      .finally(() => {
        if (!live()) return;
        runs.delete(key);
        requests.delete(runId);
      });
  }

  return () => {
    stopServer();
    abandonAll();
    stopLocal();
  };
}
