import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProcessListenerHeadroom } from '../runtime/shared/process-listener-headroom.mjs';
import { AGENT_TOOL } from './agent-tool/tool-def.mjs';
import { agentScope, envTimeoutMs, callerSessionForContext, terminalPidForContext } from './agent-tool/helpers.mjs';
import { createTagRegistry } from './agent-tool/tag-registry.mjs';
import { createJobViews } from './agent-tool/job-views.mjs';
import { createSpawnFlow } from './agent-tool/spawn-flow.mjs';
import { createSendFlow } from './agent-tool/send-flow.mjs';
import { createCloseFlow } from './agent-tool/close-flow.mjs';
import { createTerminalTrace } from './agent-tool/terminal-trace.mjs';
import { createAgentExecute } from './agent-tool/execute.mjs';
import { createTurnReviewCollector } from './agent-tool/turn-review.mjs';
// Re-export the static tool descriptor so importers of this facade keep the
// identical public surface (`import { AGENT_TOOL } from './agent-tool.mjs'`).
export { AGENT_TOOL };
export { resolveAgentSpawnPreset } from './agent-tool/spawn-preset.mjs';

ensureProcessListenerHeadroom(64);

const STANDALONE_SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Independent hard cap for the spawn *prep* phase (ensureProvider /
// prepareAgentSession / catalog+rules load). Kept separate from the
// first-response watchdog so prep cannot hang a whole fanout before the model
// request starts. Set MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS=0 to fully disable the
// cap and restore strictly-unbounded prep.
const DEFAULT_SPAWN_PREP_TIMEOUT_MS = envTimeoutMs('MIXDOG_AGENT_SPAWN_PREP_TIMEOUT_MS', 120_000);

// The standalone agent tool: tag registry + job views + spawn/send/close flows
// composed under one dispatcher (agent-tool/execute.mjs).
export function createStandaloneAgent({
  cfgMod,
  reg,
  mgr,
  dataDir,
  cwd: defaultCwd,
  mcpScopeId = null,
  onSubagentEvent,
  notifySessionCompletion,
  sessionSurface = null,
  awaitKeychainPrewarm = async () => {},
  isKeychainPrewarmReady = () => true,
}) {
  const canUseSessionSurface = (session) =>
    typeof sessionSurface?.runTurn === 'function' && sessionSurface.canRun?.(session) !== false;
  const statusListeners = new Set();
  const notifyStatusChange = () => {
    for (const listener of [...statusListeners]) {
      try {
        listener();
      } catch {
        /* status observers never affect agent lifecycle */
      }
    }
  };
  // Optional bridge to the standard hook bus for SubagentStart / SubagentStop.
  // Best-effort: a hook error must never affect worker spawn/finish.
  function emitSubagentEvent(phase, agent, extra = {}) {
    if (typeof onSubagentEvent !== 'function') return;
    try {
      onSubagentEvent(phase, { agent_type: agent || null, ...extra });
    } catch {
      /* best-effort */
    }
  }

  const registry = createTagRegistry({ dataDir, cfgMod, mgr });
  const views = createJobViews({ ...registry, mgr, reg, cfgMod, DEFAULT_SPAWN_PREP_TIMEOUT_MS });
  const spawnFlow = createSpawnFlow({
    ...registry,
    ...views,
    mgr,
    defaultCwd,
    mcpScopeId,
    emitSubagentEvent,
    notifyStatusChange,
    notifySessionCompletion,
    sessionSurface,
    cfgMod,
    dataDir,
    STANDALONE_SOURCE_ROOT,
    DEFAULT_SPAWN_PREP_TIMEOUT_MS,
    createTurnReviewCollector,
  });
  const sendFlow = createSendFlow({
    mgr,
    defaultCwd,
    sessionSurface,
    canUseSessionSurface,
    registry,
    views,
    spawnFlow,
  });
  const closeFlow = createCloseFlow({ mgr, registry, views });
  const terminalTrace = createTerminalTrace({ registry });
  const execute = createAgentExecute({
    mgr,
    defaultCwd,
    awaitKeychainPrewarm,
    registry,
    views,
    spawnFlow,
    sendFlow,
    closeFlow,
    terminalTrace,
  });

  function getStatus(context = {}) {
    if (!isKeychainPrewarmReady()) {
      void awaitKeychainPrewarm();
      return { workers: [], jobs: [], scope: null };
    }
    const scopedContext = agentScope({}, context);
    const ownerSession = callerSessionForContext(scopedContext);
    const pid = terminalPidForContext(scopedContext);
    let scope = { allTerminals: true };
    if (ownerSession) scope = { sessionId: ownerSession };
    else if (pid) scope = { clientHostPid: pid };
    return {
      workers: views.list({ scanSessions: false, context: scopedContext }),
      jobs: views.listJobs(scopedContext),
      scope,
    };
  }

  function recoverWorkers(context = {}) {
    if (!isKeychainPrewarmReady()) {
      void awaitKeychainPrewarm();
      return [];
    }
    const scopedContext = agentScope({ recover: true }, context);
    registry.refreshTagsFromSessions({ scanSessions: true, context: scopedContext });
    return views.list({ scanSessions: false, context: scopedContext });
  }

  return {
    tools: [AGENT_TOOL],
    execute,
    onStatusChange: (listener) => {
      if (typeof listener !== 'function') return () => {};
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    getStatus,
    recoverWorkers,
    upsertLeadSession: registry.upsertLeadSession,
    closeAll: closeFlow.closeAll,
  };
}
