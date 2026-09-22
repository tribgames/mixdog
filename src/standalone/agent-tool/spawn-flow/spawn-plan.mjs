/**
 * agent-tool/spawn-flow/spawn-plan.mjs — what a spawn WILL be, before anything
 * is created: the validated plan (agent / preset / tag / cwd / prompt) and the
 * normalized in-process session spec derived from it. Creating, binding and
 * prewarming that session is ../spawn-prep.mjs's job.
 */
import { resolve } from 'node:path';
import {
  agentDefinitionExists,
  clean,
  normalizeAgentName,
  readAgentFrontmatterPermission,
  resolvePrompt,
  terminalPidForContext,
} from '../helpers.mjs';
import { isAgentDisabled } from '../../../runtime/shared/agent-route-config.mjs';
import { normalizeAgentPermission } from '../../../runtime/shared/markdown-frontmatter.mjs';
import { resolveAgentSpawnPreset } from '../spawn-preset.mjs';
import { AGENT_OWNER } from '../../../runtime/agent/orchestrator/agent-owner.mjs';

export function createSpawnPlanner({
  cfgMod,
  dataDir,
  STANDALONE_SOURCE_ROOT,
  defaultCwd,
  mcpScopeId = null,
  nextTag,
  resolveTag,
  wantsSessionScan,
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

  return { resolveSpawnPlan, spawnSessionSpec };
}
