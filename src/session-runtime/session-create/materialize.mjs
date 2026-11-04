// session-create/materialize.mjs — adopting the provider session and
// publishing it: initial tool surface, hooks, statusline, the session:create
// event, and the optional WS transport prewarm.
import { deferredSurfaceModeForLead } from '../../runtime/agent/orchestrator/runtime-core/effort.mjs';
import { filterMcpToolsForSession } from '../../runtime/agent/orchestrator/runtime-core/extension-scopes.mjs';
import { applyDeferredToolSurface } from '../../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { loadInstructionFilesContextAsync } from '../../runtime/agent/orchestrator/context/instruction-files.mjs';
import { describeCwdStartupEntriesAsync } from '../../runtime/agent/orchestrator/tools/builtin/runtime-capabilities.mjs';
import { promptConfigSlice } from '../../runtime/agent/orchestrator/session/manager/prompt-settings.mjs';
import { writeStatuslineRoute } from '../statusline-route.mjs';
import { sessionOptions } from './session-options.mjs';

/** Every-create MCP fold (NO blocking): seed the INITIAL provider-visible
 *  surface (and native BP2 manifest) from MCP servers connected at create
 *  time. A boot connect still mid-handshake is caught on the first user
 *  turn by refreshInitialDeferredMcpSurface (session-turn-api), which
 *  re-folds the live registry before the prompt renders. */
function seedToolSurface(deps, reason, coreMemoryContext) {
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
  // Built from the settings as they stand: its first turn need not rebuild it.
  deps.noteToolAvailability?.(rt.session, coreMemoryContext);
}

/** The files session composition reads from the cwd, read without blocking the
 *  event loop: the instruction files block and the cwd entry listing. */
export async function readStartupFiles(rt) {
  const [instructionFilesContext, cwdStartupEntries] = await Promise.all([
    loadInstructionFilesContextAsync({ mode: promptConfigSlice(rt.config)?.instructionFiles, cwd: rt.currentCwd }),
    rt.currentCwd ? describeCwdStartupEntriesAsync({ cwd: rt.currentCwd }) : '',
  ]);
  return { instructionFilesContext, cwdStartupEntries };
}

/** Adopt the provider session and publish it to hooks and statusline. */
export function materializeSession(deps, reason, coreMemoryContext, startupFiles = null) {
  const { rt, adoptSession, mgr, hooks, statusRoutes } = deps;
  // adoptSession attaches the hook bridge (boot/infrastructure.mjs sessionAdopter).
  adoptSession(mgr.createSession(sessionOptions(deps, coreMemoryContext, startupFiles)));
  rt.reservedSessionId = null;
  seedToolSurface(deps, reason, coreMemoryContext);
  writeStatuslineRoute(statusRoutes, rt.session, rt.route);
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
