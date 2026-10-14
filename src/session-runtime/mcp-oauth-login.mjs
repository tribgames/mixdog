// Explicit MCP OAuth sign-in flows: the only interactive MCP connect. A flow
// reconnects one configured server with browser login allowed, hands the
// authorization URL back to the caller (opening the host browser only when
// asked), and is then polled until the reconnect settles.
import { randomUUID } from 'node:crypto';
import { openInBrowser } from '../runtime/shared/open-url.mjs';

// Settled flows stay readable long enough for a poller to observe the result.
const SETTLED_FLOW_TTL_MS = 10 * 60_000;
const NOT_COMPLETED = 'MCP OAuth sign-in was not completed';

const NOT_PENDING = 'MCP OAuth sign-in is no longer pending';

// flowId -> flow, shared by every session runtime of this process. A caller
// is not bound to the runtime that began a flow (the desktop's control
// session is replaced after a failed call, and an idle one is evicted), so
// status / complete / cancel reach the flow from any runtime; each flow keeps
// the handlers of the runtime that began it (its MCP scope and connect).
const flows = new Map();

// A pending flow keeps its authorization URL readable: a client polling the
// status (remote sign-in) still shows the page to open.
const view = (flow) => ({
  flowId: flow.flowId,
  state: flow.state,
  ...(flow.state === 'pending' && flow.url ? { url: flow.url } : {}),
  ...(flow.error ? { error: flow.error } : {}),
});
function settle(flow, state, error = null) {
  if (flow.state !== 'pending') return;
  flow.state = state;
  if (state === 'failed') flow.error = error || NOT_COMPLETED;
  setTimeout(() => flows.delete(flow.flowId), SETTLED_FLOW_TTL_MS).unref?.();
}
function flowOf(flowId) {
  const flow = flows.get(String(flowId || ''));
  if (!flow) throw new Error('MCP OAuth login not found');
  return flow;
}
async function cancelFlow(flow) {
  if (flow.state === 'pending') {
    flow.cancelled = true;
    flow.owner.cancel(flow.name);
    await flow.done;
  }
  return view(flow);
}

/**
 * `connect(name, openBrowser)` reconnects the server interactively, calling
 * `openBrowser(url)` when a login starts, and resolves `{ connected, error }`.
 * `cancel(name)` aborts that server's pending login. `completeCallback(name,
 * callbackUrl)` answers it with a pasted redirect URL (throws a fixed message
 * for an invalid one). `onComplete(name)` runs after a successful sign-in,
 * before the flow reports complete.
 */
export function createMcpOAuthLogins({
  connect,
  cancel,
  completeCallback = () => {
    throw new Error(NOT_PENDING);
  },
  onComplete = async () => {},
  openBrowser = openInBrowser,
}) {
  // name -> tail of that server's serialized begin/cancel/sign-out steps, so
  // replacing a pending flow is atomic and exactly one can be pending.
  const lanes = new Map();
  function exclusive(name, step) {
    const run = (lanes.get(name) || Promise.resolve()).then(step);
    const tail = run.then(
      () => {},
      () => {}
    );
    lanes.set(name, tail);
    tail.then(() => {
      if (lanes.get(name) === tail) lanes.delete(name);
    });
    return run;
  }
  // This runtime's handlers, kept on each flow it begins.
  const owner = {
    exclusive,
    cancel,
    completeCallback,
  };
  // One sign-in per server of this runtime (its MCP scope).
  const cancelServerFlows = (name) =>
    Promise.all([...flows.values()].filter((flow) => flow.owner === owner && flow.name === name).map(cancelFlow));

  async function begin(name, options = {}) {
    const { openBrowser: hostBrowser } = options || {};
    if (hostBrowser !== undefined && typeof hostBrowser !== 'boolean') {
      throw new TypeError('openBrowser must be a boolean');
    }
    let announceUrl;
    const urlReady = new Promise((resolve) => {
      announceUrl = resolve;
    });
    // One sign-in per server: a new one replaces the pending one, and the
    // replacement is registered before the next queued step of this server.
    const flow = await exclusive(name, async () => {
      await cancelServerFlows(name);
      const flow = {
        flowId: `mcp_oauth_${randomUUID()}`,
        name,
        owner,
        state: 'pending',
        error: null,
        cancelled: false,
        url: null,
      };
      flows.set(flow.flowId, flow);
      const launch = async (url) => {
        // A login reached after its flow was cancelled (queued behind another
        // connect of this server) never opens anything.
        if (flow.cancelled) throw new Error('MCP OAuth login cancelled');
        flow.awaitingCallback = true;
        flow.url = url;
        announceUrl(url);
        if (hostBrowser !== false) openBrowser(url);
      };
      flow.done = (async () => {
        try {
          const outcome = await connect(name, launch);
          if (flow.cancelled) settle(flow, 'cancelled');
          else if (outcome?.connected) {
            // The sign-in itself succeeded; a failed follow-up never undoes it.
            await Promise.resolve()
              .then(() => onComplete(name))
              .catch(() => {});
            settle(flow, 'complete');
          } else settle(flow, 'failed', outcome?.error);
        } catch (error) {
          settle(flow, flow.cancelled ? 'cancelled' : 'failed', error?.message || String(error));
        }
      })();
      return flow;
    });
    const url = await Promise.race([urlReady, flow.done.then(() => null)]);
    if (url) return { flowId: flow.flowId, state: 'pending', url };
    // Settled without a login: stored credentials (or no challenge) sufficed.
    if (flow.state === 'complete') return view(flow);
    // A superseded or failed begin stays readable (cancelled / failed).
    throw new Error(flow.error || NOT_COMPLETED);
  }

  return {
    begin,
    status: (flowId) => view(flowOf(flowId)),
    cancel(flowId) {
      const flow = flowOf(flowId);
      return flow.owner.exclusive(flow.name, () => cancelFlow(flow));
    },
    /** Answer the pending flow with the redirect URL pasted from the browser
     *  and resolve once it settles: `{ flowId, state: 'complete' | 'failed',
     *  error? }`. An invalid paste throws and leaves the flow pending. */
    async complete(flowId, callbackUrl) {
      const flow = flowOf(flowId);
      if (flow.state !== 'pending' || flow.cancelled || !flow.awaitingCallback) throw new Error(NOT_PENDING);
      flow.owner.completeCallback(flow.name, callbackUrl);
      await flow.done;
      return view(flow);
    },
    /** Cancel every pending sign-in of one server, then run `after` (sign-out)
     *  before any later begin of that server starts; resolves its result. */
    cancelServer(name, after = async () => {}) {
      return exclusive(name, async () => {
        await cancelServerFlows(name);
        return after();
      });
    },
  };
}
