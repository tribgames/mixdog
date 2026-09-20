// session-create/materialize.mjs — adopting the provider session and
// publishing it: initial tool surface, hooks, statusline, lead pool, the
// session:create event, and the optional WS transport prewarm.
import { deferredSurfaceModeForLead } from '../effort.mjs';
import { filterMcpToolsForSession } from '../extension-scopes.mjs';
import { attachSessionHooks } from '../session-hooks.mjs';
import { applyDeferredToolSurface } from '../tool-catalog.mjs';
import { writeStatuslineRoute } from '../statusline-route.mjs';
import { sessionOptions } from './session-options.mjs';

/** Every-create MCP fold (NO blocking): seed the INITIAL provider-visible
 *  surface (and native BP2 manifest) from MCP servers connected at create
 *  time. A boot connect still mid-handshake is caught on the first user
 *  turn by refreshInitialDeferredMcpSurface (session-turn-api), which
 *  re-folds the live registry before the prompt renders. */
function seedToolSurface(deps, reason) {
  const { rt, mcpClient, modelStandaloneTools, applyPreSessionToolSelection } = deps;
  let connectedMcpTools = [];
  try {
    connectedMcpTools = filterMcpToolsForSession(
      mcpClient.getMcpTools?.(rt.mcpScopeId) || [],
      rt.currentCwd,
      rt.config
    );
  } catch {
    connectedMcpTools = [];
  }
  applyDeferredToolSurface(
    rt.session,
    deferredSurfaceModeForLead(rt.mode),
    connectedMcpTools.length ? [...modelStandaloneTools(), ...connectedMcpTools] : modelStandaloneTools(),
    { provider: rt.route.provider }
  );
  // Session-local one-shot: mark this FRESH session eligible for the
  // first-turn deferred-surface refresh (session-turn-api). A resumed
  // session (prior transcript) is NEVER marked, so its already-baked BP2 is
  // never rebuilt or re-announced — the gate is per-session, not the
  // process-wide firstTurnCompleted.
  rt.session.deferredInitialRefreshPending = !/resume/i.test(String(reason || ''));
  applyPreSessionToolSelection();
}

/** Adopt the provider session and publish it to hooks, statusline and the
 *  lead pool. */
export function materializeSession(deps, reason, coreMemoryContext) {
  const { rt, adoptSession, mgr, hooks, hookCommonPayload, statusRoutes, agentTool } = deps;
  adoptSession(mgr.createSession(sessionOptions(deps, coreMemoryContext)));
  rt.reservedSessionId = null;
  attachSessionHooks(rt.session, { hooks, hookCommonPayload, getCwd: () => rt.currentCwd });
  seedToolSurface(deps, reason);
  writeStatuslineRoute(statusRoutes, rt.session, rt.route);
  try {
    agentTool?.upsertLeadSession?.(rt.session, { status: 'idle', stage: 'idle' });
  } catch {
    /* lead pool must never break session create */
  }
  hooks.emit('session:create', {
    sessionId: rt.session.id,
    provider: rt.route.provider,
    model: rt.route.model,
    toolMode: rt.mode,
    cwd: rt.currentCwd,
  });
}

export function prewarmWsTransport(rt, providerImpl) {
  if (
    rt.session.provider === 'openai-oauth' &&
    Number(rt.session.totalInputTokens || 0) === 0 &&
    !rt.session.providerState &&
    typeof providerImpl.prewarmWsTransportForSession === 'function'
  ) {
    void Promise.resolve(
      providerImpl.prewarmWsTransportForSession({ sessionId: rt.session.id, session: rt.session })
    ).catch(() => {});
  }
}
