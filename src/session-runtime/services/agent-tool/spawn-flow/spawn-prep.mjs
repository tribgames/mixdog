/**
 * agent-tool/spawn-flow/spawn-prep.mjs — spawn preparation: session creation
 * through the canonical surface or the local builder, tag binding + statusline
 * route, and the transport prewarm. The validated spawn plan and the session
 * spec it produces live in ./spawn-plan.mjs.
 */
import { presetKey, readAgentFirstResponseTimeoutMs, writeAgentStatuslineRoute } from '../helpers.mjs';
import { resolveAgentWatchdogPolicy } from '../../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { prepareAgentSession } from '../../../../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import { getProvider } from '../../../../runtime/agent/orchestrator/providers/registry.mjs';
import { resolveRouteContextState } from '../../../route-state.mjs';
import { createSpawnPlanner } from './spawn-plan.mjs';
import { enterWorkerSpawn } from '../../../workspace/admission-gate.mjs';

/** The route fields every worker-row and tag record carries. */
export function presetDescriptor(agent, preset, presetName) {
  return {
    agent,
    preset: presetKey(preset) || presetName,
    provider: preset.provider,
    model: preset.model,
    effort: preset.effort || null,
    fast: preset.fast === true,
    ...(preset.autoEffort === false ? { autoEffort: false } : {}),
  };
}

// Spawn prewarm opens the session's pooled socket ahead of the first turn
// (connection only). Fire-and-forget: failures fall back to the lazy
// per-send handshake.
// MIXDOG_AGENT_SPAWN_WS_PREWARM=0 disables.
function maybePrewarmSpawnTransport(plan, session) {
  if (process.env.MIXDOG_AGENT_SPAWN_WS_PREWARM === '0') return;
  try {
    const provider = getProvider(plan?.preset?.provider);
    if (typeof provider?.prewarmWsTransportForSession !== 'function') return;
    void Promise.resolve(
      provider.prewarmWsTransportForSession({
        sessionId: session?.id || null,
        session,
      })
    ).catch(() => {});
  } catch {
    /* best-effort — the first send owns the lazy handshake */
  }
}

export function createSpawnPreparer({
  cfgMod,
  dataDir,
  STANDALONE_SOURCE_ROOT,
  defaultCwd,
  mcpScopeId = null,
  nextTag,
  resolveTag,
  wantsSessionScan,
  bindTag,
  ensureProvider,
  sessionSurface = null,
  refreshTagsFromSessions,
}) {
  const { resolveSpawnPlan, spawnSessionSpec } = createSpawnPlanner({
    cfgMod,
    dataDir,
    STANDALONE_SOURCE_ROOT,
    defaultCwd,
    mcpScopeId,
    nextTag,
    resolveTag,
    wantsSessionScan,
  });

  /** Watchdog inputs for one agent run: the agent definition's own
   *  first-response deadline and the provider's first-response budget for the
   *  routed model (headers, and first output), handed to
   *  resolveAgentWatchdogPolicy. A provider on the shared window names none. */
  function agentWatchdogOverrides({ agent, provider, model }) {
    const budget = getProvider(provider)?.firstResponseBudget?.(model);
    return {
      firstResponseTimeoutMs: readAgentFirstResponseTimeoutMs(agent, dataDir, STANDALONE_SOURCE_ROOT) ?? undefined,
      providerFirstByteTimeoutMs: budget?.transportMs,
      providerFirstOutputTimeoutMs: budget?.semanticMs,
    };
  }

  /** Shared post-create wiring. Lead sessions write a gateway-session route on
   *  create; agent sessions are built through prepareAgentSession()/the remote
   *  runtime, so mirror that registration here or the vendored L1/L2
   *  statusline cannot resolve the agent route/model. */
  function bindSpawnedSession(session, plan) {
    const { agent, presetName, preset, tag } = plan;
    writeAgentStatuslineRoute(session.id, preset);
    bindTag(tag, session, { ...presetDescriptor(agent, preset, presetName), status: 'idle', stage: 'idle' });
  }

  async function createSpawnedSession(plan, spec, prepState) {
    // A sub-100 context share needs the window it selects; a percent alone
    // keeps the full served window.
    const sessionSpec = { ...spec };
    if (plan.preset.contextPercent || plan.preset.contextTokens) {
      const { contextPercent, selectedContextWindow, contextTokens } = resolveRouteContextState(plan.preset, null);
      Object.assign(sessionSpec, { contextPercent, selectedContextWindow }, contextTokens ? { contextTokens } : {});
    }
    if (sessionSurface?.canonical === true && typeof sessionSurface.createChild === 'function') {
      return sessionSurface.createChild({ spec: sessionSpec, prompt: plan.prompt, tag: plan.tag });
    }
    await ensureProvider(plan.config, plan.preset.provider);
    if (prepState?.timedOut) {
      throw new Error('agent spawn prep timed out before session bind');
    }
    return prepareAgentSession(sessionSpec);
  }

  async function prepareSpawnInProcess(args, callerCwd = null, context = {}, prepState = null) {
    // Shared admission with Lead workspace transitions: no spawn is prepared
    // while the Lead's workspace changes, no transition starts mid-spawn.
    const leaveSpawn = enterWorkerSpawn([context?.ownerSessionId, context?.callerSessionId || context?.sessionId]);
    let plan;
    let session;
    let effectiveCwd;
    try {
      plan = await resolveSpawnPlan(args, callerCwd, context, prepState);
      const spec = spawnSessionSpec(plan, args, context);
      ({ session, effectiveCwd } = await createSpawnedSession(plan, spec, prepState));
      bindSpawnedSession(session, plan);
    } finally {
      leaveSpawn();
    }
    if (sessionSurface?.canonical !== true) {
      maybePrewarmSpawnTransport(plan, session);
    }
    return {
      args,
      tag: plan.tag,
      session,
      agent: plan.agent,
      preset: plan.preset,
      presetName: plan.presetName,
      workerCwd: effectiveCwd || plan.workerCwd,
      prompt: plan.prompt,
      watchdogPolicy: resolveAgentWatchdogPolicy(
        plan.agent,
        agentWatchdogOverrides({ agent: plan.agent, provider: plan.preset.provider, model: plan.preset.model })
      ),
    };
  }

  async function prepareSpawn(args, callerCwd = null, context = {}, prepState = null) {
    refreshTagsFromSessions({ context });
    return prepareSpawnInProcess(args, callerCwd, context, prepState);
  }

  return { prepareSpawn, prepareSpawnInProcess, createSpawnedSession, agentWatchdogOverrides };
}
