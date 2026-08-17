// Daemon-owned provider OAuth flows. The provider runtime returns live
// promises/functions, so the session surface must retain them locally and
// expose only serializable status records to desktop clients.
const DEFAULT_FLOW_TTL_MS = 10 * 60 * 1_000;

export function oauthFlowStatus(flow) {
  return {
    flowId: flow.id,
    provider: flow.provider,
    url: flow.url,
    manualUrl: flow.manualUrl,
    state: flow.state,
    completed: flow.state === 'complete',
    error: flow.error,
    manualCodeSupported: typeof flow.completeCode === 'function',
  };
}

function requiredFlowId(value) {
  const id = String(value || '').trim();
  if (!/^oauth_[a-z0-9_]+$/i.test(id)) throw new TypeError('OAuth flow id is invalid.');
  return id;
}

function cancelFlow(flow, reason) {
  try {
    const result = flow.cancel?.();
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).catch((error) => {
        console.warn(`OAuth flow could not be ${reason}:`, error);
      });
    }
  } catch (error) {
    console.warn(`OAuth flow could not be ${reason}:`, error);
  }
}

export function createSessionOAuthFlowRegistry({ ttlMs = DEFAULT_FLOW_TTL_MS } = {}) {
  const flows = new Map();
  const activeByProvider = new Map();
  let sequence = 0;

  function finishFlow(flow, state, error = null, result = null) {
    if (!flow || flow.state !== 'pending') return false;
    flow.state = state;
    flow.error = error;
    flow.result = result;
    clearTimeout(flow.timeout);
    flow.timeout = null;
    if (activeByProvider.get(flow.provider) === flow.id) {
      activeByProvider.delete(flow.provider);
    }
    return true;
  }

  function requireFlow(id) {
    const key = requiredFlowId(id);
    const flow = flows.get(key);
    if (!flow) throw new Error('OAuth login flow is no longer available.');
    return flow;
  }

  function register(value) {
    const started = value && typeof value === 'object' ? value : null;
    if (!started) throw new Error('OAuth provider did not return a login flow.');
    const provider = String(started.provider || '').trim();
    if (!provider) throw new Error('OAuth provider login is missing its provider id.');
    const priorId = activeByProvider.get(provider);
    const prior = priorId ? flows.get(priorId) : null;
    if (prior?.state === 'pending') {
      finishFlow(prior, 'cancelled', 'Superseded by a newer OAuth login.');
      cancelFlow(prior, 'superseded');
    }
    const id = `oauth_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
    const flow = {
      id,
      provider,
      url: typeof started.url === 'string' ? started.url : null,
      manualUrl: typeof started.manualUrl === 'string' ? started.manualUrl : null,
      state: 'pending',
      result: null,
      error: null,
      completeCode: typeof started.completeCode === 'function' ? started.completeCode : undefined,
      cancel: typeof started.cancel === 'function' ? started.cancel : undefined,
      completing: false,
      timeout: null,
    };
    flow.timeout = setTimeout(() => {
      const current = flows.get(id);
      if (!current || current.state !== 'pending') return;
      finishFlow(current, 'expired', 'OAuth login expired.');
      cancelFlow(current, 'expired');
    }, Math.max(1, Number(ttlMs) || DEFAULT_FLOW_TTL_MS));
    flow.timeout.unref?.();
    flows.set(id, flow);
    activeByProvider.set(provider, id);
    if (started.waitForCallback && typeof started.waitForCallback.then === 'function') {
      void Promise.resolve(started.waitForCallback).then((result) => {
        const current = flows.get(id);
        if (!current || current.state !== 'pending') return;
        if (result) {
          finishFlow(current, 'complete', null, true);
        } else if (!current.completing) {
          finishFlow(current, 'failed', 'OAuth login did not complete.');
        }
      }).catch((error) => {
        const current = flows.get(id);
        if (!current || current.state !== 'pending' || current.completing) return;
        finishFlow(current, 'failed', error instanceof Error ? error.message : String(error));
      });
    }
    return oauthFlowStatus(flow);
  }

  function status(id) {
    return oauthFlowStatus(requireFlow(id));
  }

  async function complete(id, rawCode) {
    const flow = requireFlow(id);
    if (flow.state !== 'pending') {
      throw new Error('OAuth login flow is no longer pending.');
    }
    if (typeof flow.completeCode !== 'function') {
      throw new Error('This OAuth provider does not accept a manual code.');
    }
    const code = String(rawCode || '').trim();
    if (!code || code.length > 16_384) throw new TypeError('OAuth code is invalid.');
    if (flow.completing) {
      throw new Error('OAuth login flow is already being completed.');
    }
    flow.completing = true;
    try {
      const completed = await flow.completeCode(code);
      finishFlow(
        flow,
        completed ? 'complete' : 'failed',
        completed ? null : 'OAuth code did not complete the login.',
        Boolean(completed),
      );
    } catch (error) {
      finishFlow(flow, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      flow.completing = false;
    }
    return oauthFlowStatus(flow);
  }

  async function cancel(id) {
    const flow = requireFlow(id);
    if (flow.state !== 'pending') return oauthFlowStatus(flow);
    finishFlow(flow, 'cancelled');
    let failure = null;
    try {
      await flow.cancel?.();
    } catch (error) {
      failure = error;
    }
    if (failure) throw failure;
    return oauthFlowStatus(flow);
  }

  function cancelAll() {
    for (const flow of flows.values()) {
      clearTimeout(flow.timeout);
      if (flow.state === 'pending') {
        finishFlow(flow, 'cancelled');
        cancelFlow(flow, 'cancelled');
      }
    }
    activeByProvider.clear();
    flows.clear();
  }

  return Object.freeze({ register, status, complete, cancel, cancelAll });
}
