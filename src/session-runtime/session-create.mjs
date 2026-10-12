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
import { SessionClosedError } from '../runtime/agent/orchestrator/session/manager/session-errors.mjs';
import {
  SessionAddressError,
  addressedRecord,
  assertAdmissionOpen,
  closedAddressError,
  isAddressedTo,
  missingAddressError,
} from './session-address.mjs';

export function createSessionCreator(deps, routes) {
  const { rt, mgr } = deps;

  /** A still-open live session short-circuits creation. For an addressed
   *  runtime a closed/missing record is terminal/explicit failure — never
   *  "no session, so create one". */
  function liveSession() {
    if (!rt.session?.id) return null;
    const live = mgr.getSession(rt.session.id);
    if (live && live.closed !== true && live.status !== 'closed') {
      rt.session = live;
      return live;
    }
    if (isAddressedTo(rt, rt.session.id)) {
      if (live) throw closedAddressError(rt);
      throw missingAddressError(rt);
    }
    rt.session = null;
    return null;
  }

  /** Same-id recovery of an OPEN durable conversation (idle eviction, manager
   *  unload, load-on-demand, crash restore) through the lifecycle resume. */
  async function resumeAddressed(signal) {
    if (typeof deps.resumeAddressedSession !== 'function') {
      throw new SessionAddressError('addressed session resume is unavailable', rt.addressedSessionId);
    }
    const id = rt.addressedSessionId;
    await runAbortable(signal, () => deps.resumeAddressedSession(id), 'Session creation aborted');
    assertAdmissionOpen(rt);
    if (rt.session?.id === id) return rt.session;
    const { state } = addressedRecord(rt, mgr);
    if (state === 'closed') throw closedAddressError(rt);
    throw new SessionAddressError(`session ${id} could not be resumed; refusing to create another`, id);
  }

  /** Decide, from the durable record under the address, whether this runtime
   *  may materialize (first time, reserved) or must resume. Synchronous so no
   *  await sits between the decision and the adoption. */
  function addressDecision() {
    if (!rt.addressedSessionId) return 'create';
    const { state } = addressedRecord(rt, mgr);
    if (state === 'closed') throw closedAddressError(rt);
    if (state === 'open') return 'resume';
    if (rt.reservedSessionId === rt.addressedSessionId) return 'create';
    throw missingAddressError(rt);
  }

  async function buildSession(reason, signal, startedAt) {
    const { coreMemoryContext, providerImpl } = await prepareRoute(deps, routes, signal, startedAt);
    // The fence/record may have changed during the awaits above (close during
    // reservation prewarm): re-validate synchronously right before adoption.
    assertAdmissionOpen(rt);
    if (addressDecision() === 'resume') return await resumeAddressed(signal);
    materializeSession(deps, reason, coreMemoryContext);
    await dispatchSessionStart(deps, reason, signal);
    assertAdmissionOpen(rt);
    if (!rt.session)
      throw new SessionClosedError(
        rt.addressedSessionId || 'unknown',
        'session closed during creation',
        'canonical-close'
      );
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
    assertAdmissionOpen(rt);
    if (rt.sessionCreatePromise) {
      return await runAbortable(signal, () => rt.sessionCreatePromise, 'Session creation aborted');
    }
    const live = liveSession();
    if (live) return live;
    const decision = addressDecision();

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
    const promise = decision === 'resume' ? resumeAddressed(signal) : buildSession(reason, signal, startedAt);
    rt.sessionCreatePromise = promise;
    try {
      return await promise;
    } finally {
      if (rt.sessionCreatePromise === promise) rt.sessionCreatePromise = null;
    }
  };
}
