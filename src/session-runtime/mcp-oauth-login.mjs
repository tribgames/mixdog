// Explicit MCP OAuth sign-in flows: the only interactive MCP connect. A flow
// reconnects one configured server with browser login allowed, hands the
// authorization URL back to the caller (opening the host browser only when
// asked), and is then polled until the reconnect settles.
import { randomUUID } from 'node:crypto';
import { openInBrowser } from '../runtime/shared/open-url.mjs';

// Settled flows stay readable long enough for a poller to observe the result.
const SETTLED_FLOW_TTL_MS = 10 * 60_000;
const NOT_COMPLETED = 'MCP OAuth sign-in was not completed';
export const MCP_OAUTH_LOGIN_TIMED_OUT = 'MCP OAuth sign-in timed out';
// A sign-in nobody finishes ends here, ahead of the OAuth layer's own 5-minute
// abort, so its failure is reported as the timeout it is.
const LOGIN_DEADLINE_MS = 5 * 60_000 - 10_000;
// The longest a status read waits for a change (local callers only).
const MAX_STATUS_WAIT_MS = 15_000;
// How a sign-in treats the account (mcp/oauth-account.mjs): a normal
// authorization, a repair of the same connection, or a transactional switch.
const MODES = new Set(['connect', 'reauth', 'switch']);

const NOT_PENDING = 'MCP OAuth sign-in is no longer pending';

// flowId -> flow, shared by every session runtime of this process. A caller
// is not bound to the runtime that began a flow (the desktop's control
// session is replaced after a failed call, and an idle one is evicted), so
// status / complete / cancel reach the flow from any runtime; each flow keeps
// the handlers of the runtime that began it (its MCP scope and connect).
const flows = new Map();

// A pending flow keeps its authorization URL readable: a client polling the
// status (remote sign-in) still shows the page to open. `step` names what a
// pending flow waits for: `browser` (the sign-in page), `connecting` (the
// callback arrived; tokens are exchanged), `tools` (signed in; the server
// connects and lists its tools).
const view = (flow) => ({
  flowId: flow.flowId,
  state: flow.state,
  ...(flow.state === 'pending' ? { step: flow.step } : {}),
  ...(flow.state === 'pending' && flow.url ? { url: flow.url } : {}),
  ...(flow.error ? { error: flow.error } : {}),
  ...(flow.reason ? { reason: flow.reason } : {}),
});
const versionOf = (flow) => `${flow.state}:${flow.step}`;
// Wake every status read waiting on this flow.
function changed(flow) {
  const waiters = flow.waiters;
  flow.waiters = [];
  for (const wake of waiters) wake();
}
function setStep(flow, step) {
  if (flow.state !== 'pending' || flow.step === step) return;
  flow.step = step;
  changed(flow);
}
function settle(flow, state, error = null) {
  if (flow.state !== 'pending') return;
  flow.state = state;
  if (state === 'failed') flow.error = error || NOT_COMPLETED;
  clearTimeout(flow.deadline);
  changed(flow);
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
    flow.abort();
    await flow.done;
  }
  return view(flow);
}

/**
 * `connect(name, launch)` reconnects the server interactively, calling
 * `launch(url)` when a login starts, and resolves `{ connected, error }`.
 * `cancel(name)` aborts that server's pending login. `completeCallback(name,
 * callbackUrl)` answers it with a pasted redirect URL (throws a fixed message
 * for an invalid one). `switchAccount(name, launch, attempt)` runs an account
 * switch instead (mode `switch`): it registers `attempt.abort` / `attempt.answer`
 * and resolves `{ connected, error }` only after committing (or rolling back)
 * the new sign-in. `launch` carries `accountMode` and the progress hooks
 * `onCallback` / `onAuthorized` the OAuth layer calls. `onComplete(name)` runs
 * after a successful sign-in, once the flow already reports complete.
 */
export function createMcpOAuthLogins({
  connect,
  cancel,
  completeCallback = () => {
    throw new Error(NOT_PENDING);
  },
  switchAccount = async () => {
    throw new Error('Switching the account is not supported here');
  },
  onComplete = async () => {},
  openBrowser = openInBrowser,
  loginTimeoutMs = LOGIN_DEADLINE_MS,
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
    // `beside`: run any mode through `switchAccount` (a sign-in beside the
    // stored one, for an account that is not a server of its own).
    const { openBrowser: hostBrowser, mode = 'connect', beside = false } = options || {};
    if (hostBrowser !== undefined && typeof hostBrowser !== 'boolean') {
      throw new TypeError('openBrowser must be a boolean');
    }
    if (!MODES.has(mode)) throw new TypeError('mode must be connect, reauth or switch');
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
        mode,
        state: 'pending',
        step: 'starting',
        error: null,
        reason: null,
        cancelled: false,
        timedOut: false,
        url: null,
        waiters: [],
        abort: () => owner.cancel(name),
        answer: (callbackUrl) => owner.completeCallback(name, callbackUrl),
      };
      flows.set(flow.flowId, flow);
      const launch = async (url) => {
        // A login reached after its flow was cancelled (queued behind another
        // connect of this server) never opens anything.
        if (flow.cancelled) throw new Error('MCP OAuth login cancelled');
        flow.awaitingCallback = true;
        flow.url = url;
        setStep(flow, 'browser');
        announceUrl(url);
        if (hostBrowser !== false) openBrowser(url);
        // Nobody finished the sign-in page in time.
        flow.deadline = setTimeout(() => {
          if (flow.state !== 'pending' || flow.step !== 'browser') return;
          flow.timedOut = flow.cancelled = true;
          flow.abort();
        }, loginTimeoutMs);
        flow.deadline.unref?.();
      };
      launch.accountMode = mode;
      launch.onCallback = () => setStep(flow, 'connecting');
      launch.onAuthorized = () => setStep(flow, 'tools');
      flow.done = (async () => {
        try {
          const outcome =
            mode === 'switch' || beside === true
              ? await switchAccount(name, launch, {
                  set abort(fn) {
                    flow.abort = fn;
                  },
                  set answer(fn) {
                    flow.answer = fn;
                  },
                })
              : await connect(name, launch);
          if (flow.timedOut) {
            flow.reason = 'timeout';
            settle(flow, 'failed', MCP_OAUTH_LOGIN_TIMED_OUT);
          } else if (flow.cancelled) settle(flow, 'cancelled');
          else if (outcome?.connected) {
            settle(flow, 'complete');
            // The other runtimes reconnect after the flow already reports
            // complete: the caller never waits for every peer's reconnect, and
            // a failed follow-up never undoes the sign-in.
            void Promise.resolve()
              .then(() => onComplete(name))
              .catch(() => {});
          } else settle(flow, 'failed', outcome?.error);
        } catch (error) {
          if (flow.timedOut) {
            flow.reason = 'timeout';
            settle(flow, 'failed', MCP_OAUTH_LOGIN_TIMED_OUT);
          } else settle(flow, flow.cancelled ? 'cancelled' : 'failed', error?.message || String(error));
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
    /** The flow's view. With `{ since, waitMs }` (the `state:step` a caller
     *  last saw) the read resolves on the flow's next change, or after at most
     *  `waitMs` unchanged: the caller follows each step as it happens. */
    status(flowId, options = {}) {
      const flow = flowOf(flowId);
      const { since, waitMs } = options || {};
      if (since === undefined) return view(flow);
      if (typeof since !== 'string') throw new TypeError('since must be a string');
      if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError('waitMs must be a non-negative number');
      if (since !== versionOf(flow) || flow.state !== 'pending' || waitMs === 0) return view(flow);
      return new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          resolve(view(flow));
        };
        const timer = setTimeout(
          () => {
            flow.waiters = flow.waiters.filter((waiter) => waiter !== wake);
            resolve(view(flow));
          },
          Math.min(waitMs, MAX_STATUS_WAIT_MS)
        );
        flow.waiters.push(wake);
      });
    },
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
      flow.answer(callbackUrl);
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
