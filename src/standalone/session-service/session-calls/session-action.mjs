// session-calls/session-action.mjs
// The generic runtime-action lane (read / configure allowlists) and the
// session catalog listing.
import { SESSION_CONFIGURE_ACTION_SET, SESSION_READ_ACTION_SET } from '../../session-protocol.mjs';
import { sanitizeForWire } from '../../session-wire-values.mjs';

/** One compact description of an action result for the daemon log, never the payload itself. */
function resultSummary(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object${Array.isArray(value.items) ? ` items=${value.items.length}` : ''}`;
  return String(value).replace(/\s+/g, ' ').slice(0, 160);
}

function requireSessionAction(action, allowed) {
  const name = String(action || '');
  if (!allowed.has(name)) throw new TypeError(`session action ${name || '(empty)'} is unavailable`);
  return name;
}

export function createSessionActionCalls(ctx) {
  const { isClosed, log, listSessions, getRemoteSessionState, loadProjectStore, advanceForCaller } = ctx;
  const { bodyForClient } = ctx.projection;
  const { retainUnwatched } = ctx.retention;
  const { assertAvailable, entryForSession } = ctx.entries;

  async function runSessionAction(
    { sessionId, action, args = [], open: openHints = {}, baseRevision = null } = {},
    allowedActions
  ) {
    assertAvailable();
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const name = requireSessionAction(action, allowedActions);
    const entry = await entryForSession(id, openHints || {});
    assertAvailable(entry);
    const target = entry.runtime[name];
    if (typeof target !== 'function') throw new TypeError(`session action ${name} is unavailable`);
    const value = await target.apply(entry.runtime, Array.isArray(args) ? args : []);
    if (name === 'setCwd' && value) {
      try {
        const projects = await loadProjectStore();
        projects.touchProjectSelected?.(value);
      } catch (error) {
        log(`project recency update failed (non-fatal): ${error?.message || error}`);
      }
    }
    assertAvailable(entry);
    // Keep one compact record that the action reached the service without
    // serializing transcripts/catalogs into the daemon log.
    log(`session action ${name} session=${id} result=${resultSummary(value)}`);
    const step = advanceForCaller(entry);
    // Still unwatched: keep it on the retention clock exactly like a runtime
    // released by its view, so an untouched load cannot leak past the idle window.
    retainUnwatched(entry);
    return {
      value: sanitizeForWire(value) ?? null,
      sessionId: String(entry.runtime.getState?.()?.sessionId || id),
      ...bodyForClient(step, Number.isInteger(baseRevision) ? baseRevision : null),
    };
  }

  async function listSessionCatalog(options = {}) {
    if (isClosed()) throw new Error('session service is closed');
    if (typeof listSessions !== 'function') {
      throw new Error('session catalog is unavailable');
    }
    const sessions = await listSessions({
      ...(options || {}),
      // Agent-only records are an internal ancestry/reuse source, never part
      // of the ordinary session catalog returned over the public transport.
      includeAgentOnly: false,
    });
    const remoteSession = typeof getRemoteSessionState === 'function' ? await getRemoteSessionState() : null;
    return {
      sessions: sanitizeForWire(Array.isArray(sessions) ? sessions : []),
      remoteSession: sanitizeForWire(remoteSession) ?? null,
    };
  }

  async function configureSession(params = {}, callCtx = null) {
    const revision = Math.max(0, Number(callCtx?.revision) || 0);
    const action = params?.action;
    // Revision 0 desktop adapters routed some reads through configure because
    // their local read list lagged the session surface. A newer daemon accepts
    // those reads without weakening the current revision's finite lanes.
    if (revision < 1 && SESSION_READ_ACTION_SET.has(String(action || ''))) {
      return runSessionAction({ ...params, action }, SESSION_READ_ACTION_SET);
    }
    return runSessionAction({ ...params, action }, SESSION_CONFIGURE_ACTION_SET);
  }

  return { runSessionAction, listSessionCatalog, configureSession };
}
