// createCurrentSession: provider session construction with MCP wiring and
// reset handling, as a sequence of steps over the shared runtime record (rt).
// Steps live under session-create/: route-prep (config, memory, route,
// provider), session-options + materialize (adopt and publish), and
// session-start-hook.
import { bootProfile } from './boot-profile.mjs';
import { runAbortable, throwIfAborted } from '../runtime/shared/abort-race.mjs';
import { elapsedMs, prepareRoute } from './session-create/route-prep.mjs';
import { materializeSession, prewarmWsTransport } from './session-create/materialize.mjs';
import { dispatchSessionStart } from './session-create/session-start-hook.mjs';

export function createSessionCreator(deps, routes) {
  const { rt, mgr } = deps;

  /** A still-open live session short-circuits creation. */
  function liveSession() {
    if (!rt.session?.id) return null;
    const live = mgr.getSession(rt.session.id);
    if (live && live.closed !== true && live.status !== 'closed') {
      rt.session = live;
      return live;
    }
    rt.session = null;
    return null;
  }

  async function buildSession(reason, signal, startedAt) {
    const { coreMemoryContext, providerImpl } = await prepareRoute(deps, routes, signal, startedAt);
    materializeSession(deps, reason, coreMemoryContext);
    await dispatchSessionStart(deps, reason, signal);
    prewarmWsTransport(rt, providerImpl);
    throwIfAborted(signal);
    bootProfile('session:create:ready', {
      ms: elapsedMs(startedAt),
      reason,
      tools: Array.isArray(rt.session.tools) ? rt.session.tools.length : 0,
      catalog: Array.isArray(rt.session.deferredToolCatalog) ? rt.session.deferredToolCatalog.length : 0,
    });
    return rt.session;
  }

  return async function createCurrentSession(reason = 'demand', options = {}) {
    const signal = options?.signal || null;
    throwIfAborted(signal);
    if (rt.sessionCreatePromise) {
      return await runAbortable(signal, () => rt.sessionCreatePromise, 'Session creation aborted');
    }
    const live = liveSession();
    if (live) return live;

    const startedAt = performance.now();
    bootProfile('session:create:start', { mode: rt.mode, reason });
    // A daemon reservation is deliberate user-think-time prewarm. Start the
    // one-time agent-loop module load now so the first real prompt does not pay
    // its ~100ms dynamic-import graph immediately before provider.send.
    if (reason === 'reservation' && typeof mgr.prewarmAgentLoop === 'function') {
      void mgr.prewarmAgentLoop().catch((error) => {
        bootProfile('agent-loop:prewarm-failed', { error: error?.message || String(error) });
      });
    }
    const promise = buildSession(reason, signal, startedAt);
    rt.sessionCreatePromise = promise;
    try {
      return await promise;
    } finally {
      if (rt.sessionCreatePromise === promise) rt.sessionCreatePromise = null;
    }
  };
}
