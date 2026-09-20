/**
 * agent-tool/spawn-flow/spawn-prep.mjs — spawn preparation: the validated
 * spawn plan (agent / preset / tag / cwd / prompt), the in-process session
 * spec, session creation through the canonical surface or the local
 * builder, tag binding + statusline route, and the transport prewarm.
 */
import { resolve } from 'node:path';
import {
  agentDefinitionExists,
  clean,
  normalizeAgentName,
  presetKey,
  readAgentFrontmatterPermission,
  resolvePrompt,
  terminalPidForContext,
  writeAgentStatuslineRoute,
} from '../helpers.mjs';
import { isAgentDisabled } from '../../../runtime/shared/agent-route-config.mjs';
import { normalizeAgentPermission } from '../../../runtime/shared/markdown-frontmatter.mjs';
import { resolveAgentSpawnPreset } from '../spawn-preset.mjs';
import { resolveAgentWatchdogPolicy } from '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import { prepareAgentSession } from '../../../runtime/agent/orchestrator/agent-runtime/session-builder.mjs';
import { AGENT_OWNER } from '../../../runtime/agent/orchestrator/agent-owner.mjs';
import { getProvider } from '../../../runtime/agent/orchestrator/providers/registry.mjs';

/** The route fields every worker-row and tag record carries. */
export function presetDescriptor(agent, preset, presetName) {
  return {
    agent,
    preset: presetKey(preset) || presetName,
    provider: preset.provider,
    model: preset.model,
    effort: preset.effort || null,
    fast: preset.fast === true,
  };
}

// Spawn prewarm builds the materialized stable prompt and keeps the resulting
// Codex-style client handle reserved for the first turn. Fire-and-forget:
// failures fall back to the lazy per-send handshake.
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
  cancelReap,
  ensureProvider,
  sessionSurface = null,
  refreshTagsFromSessions,
}) {
  /** Shared spawn-prep validations (agent/preset/tag/cwd/prompt). */
  async function resolveSpawnPlan(args, callerCwd, context, prepState) {
    const config = cfgMod.loadConfig();
    const agent = normalizeAgentName(args.agent);
    if (!agent) throw new Error('agent spawn: agent is required');
    // Deleted/unknown agents fail here: settings-deleted custom roles would
    // otherwise still spawn as role-less generic agents by remembered name.
    if (!agentDefinitionExists(agent, dataDir, STANDALONE_SOURCE_ROOT)) {
      throw new Error(`agent spawn: unknown agent "${agent}"`);
    }
    // Switched off in settings: the role is dropped from the Lead prompt, so a
    // spawn can only arrive from a stale name. Refuse instead of running it.
    if (isAgentDisabled(config, agent)) {
      throw new Error(`agent spawn: agent "${agent}" is turned off`);
    }
    const agentPermission = readAgentFrontmatterPermission(agent, dataDir, STANDALONE_SOURCE_ROOT);
    const agentPerm = normalizeAgentPermission(agentPermission) || null;
    const { presetName, preset } = resolveAgentSpawnPreset(config, args);
    const tag = clean(args.tag) || nextTag(agent, context);
    // Any resolved same-tag binding in this terminal (live or lingering trace)
    // blocks a fresh spawn. execute() routes live reuse before prepareSpawn.
    if (resolveTag(tag, context, { scanSessions: wantsSessionScan(args) })) {
      throw new Error(`agent spawn: tag "${tag}" already exists`);
    }
    const baseCwd = resolve(callerCwd || defaultCwd || process.cwd());
    const workerCwd = clean(args.cwd) ? resolve(baseCwd, args.cwd) : baseCwd;
    const prompt = await resolvePrompt(args, workerCwd);
    if (prepState?.timedOut) {
      throw new Error('agent spawn prep timed out before session bind');
    }
    return { config, agent, agentPerm, presetName, preset, tag, workerCwd, prompt };
  }

  /** Build the normalized in-process agent session spec. */
  function spawnSessionSpec(plan, args, context) {
    const { agent, agentPerm, presetName, preset, tag, workerCwd } = plan;
    return {
      agent,
      presetName,
      preset,
      runtimeSpec: cfgMod.resolveRuntimeSpec(preset, { lane: 'agent', agentId: tag }),
      owner: AGENT_OWNER,
      cwd: workerCwd,
      sourceType: 'cli',
      sourceName: agent,
      parentSessionId: clean(context?.callerSessionId || context?.sessionId) || null,
      ownerSessionId: clean(context?.ownerSessionId) || clean(context?.callerSessionId || context?.sessionId) || null,
      visibility: 'agent-only',
      clientHostPid: terminalPidForContext(context) || null,
      agentTag: tag,
      taskType: clean(args.taskType) || clean(args.typeHint) || undefined,
      permission: agentPerm || undefined,
      cacheKeyOverride: args.cacheKey || undefined,
      mcpScopeId,
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
    cancelReap(session.id);
  }

  async function createSpawnedSession(plan, spec, prepState) {
    if (sessionSurface?.canonical === true && typeof sessionSurface.createChild === 'function') {
      return sessionSurface.createChild({ spec, prompt: plan.prompt, tag: plan.tag });
    }
    await ensureProvider(plan.config, plan.preset.provider);
    if (prepState?.timedOut) {
      throw new Error('agent spawn prep timed out before session bind');
    }
    return prepareAgentSession(spec);
  }

  async function prepareSpawnInProcess(args, callerCwd = null, context = {}, prepState = null) {
    const plan = await resolveSpawnPlan(args, callerCwd, context, prepState);
    const spec = spawnSessionSpec(plan, args, context);
    const { session, effectiveCwd } = await createSpawnedSession(plan, spec, prepState);
    bindSpawnedSession(session, plan);
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
      watchdogPolicy: resolveAgentWatchdogPolicy(plan.agent),
    };
  }

  async function prepareSpawn(args, callerCwd = null, context = {}, prepState = null) {
    refreshTagsFromSessions({ context });
    return prepareSpawnInProcess(args, callerCwd, context, prepState);
  }

  return { prepareSpawn, prepareSpawnInProcess };
}
