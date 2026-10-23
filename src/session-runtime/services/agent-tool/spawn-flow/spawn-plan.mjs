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
  readAgentFrontmatterKind,
  readAgentFrontmatterPermission,
  resolvePrompt,
  terminalPidForContext,
} from '../helpers.mjs';
import { isAgentDisabled } from '../../../../runtime/shared/agent-route-config.mjs';
import { normalizeAgentPermission } from '../../../../runtime/shared/markdown-frontmatter.mjs';
import { resolveAgentSpawnPreset } from '../spawn-preset.mjs';
import { AGENT_OWNER } from '../../../../runtime/agent/orchestrator/agent-owner.mjs';
import { workspaceCwdLock } from '../../../workspace/admission-gate.mjs';
import { isContactAgentId } from '../../../../runtime/agent/orchestrator/runtime-core/workflow-ids.mjs';
import { resolveSessionMode } from '../../../../runtime/agent/orchestrator/session/agent-mode.mjs';

export function createSpawnPlanner({
  mgr = null,
  cfgMod,
  dataDir,
  STANDALONE_SOURCE_ROOT,
  defaultCwd,
  mcpScopeId = null,
  nextTag,
  resolveTag,
  wantsSessionScan,
}) {
  /** The agents from the chain's origin down to the caller, walking
   *  parentSessionId/ownerSessionId up from the caller session (a Lead acts as
   *  its agent-mode agent, a delegated worker as its role). The visited set
   *  ends a malformed cycle; chain length is bounded by the existing limit
   *  that workers have no `agent` tool, so only Leads delegate. */
  function delegationChainOf(callerId) {
    const chain = [];
    const seen = new Set();
    for (let id = callerId; id && !seen.has(id); ) {
      seen.add(id);
      const session = mgr?.getSession?.(id) || null;
      const { agentId } = resolveSessionMode({ session, sessionId: id });
      const acting = clean(agentId || session?.agent);
      if (acting) chain.unshift(acting);
      id = clean(session?.parentSessionId || session?.ownerSessionId);
    }
    return chain;
  }

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
    // Any agent-mode Lead (Mixy or a bot) may hand work to a contact agent,
    // never to one already in its delegation chain (itself included).
    if (isContactAgentId(agent, readAgentFrontmatterKind(agent, dataDir, STANDALONE_SOURCE_ROOT))) {
      const chain = delegationChainOf(clean(context?.callerSessionId || context?.sessionId));
      if (chain.at(-1) === agent) {
        throw new Error(
          `agent spawn: the contact agent "${agent}" cannot hand work to itself; do it yourself or delegate to a sub-agent`
        );
      }
      if (chain.includes(agent)) {
        throw new Error(
          `agent spawn: the contact agent "${agent}" is already in this delegation chain (${[...chain, agent].join(' → ')}); do not hand the work back, answer or delegate to a sub-agent instead`
        );
      }
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
    // Workers share their Lead's execution root. While the Lead runs in its
    // worktree, that root is locked: neither args.cwd nor an inherited
    // (pre-transition) cwd can send a worker elsewhere.
    const lockedCwd = workspaceCwdLock([context?.ownerSessionId, context?.callerSessionId || context?.sessionId]);
    const baseCwd = resolve(lockedCwd || callerCwd || defaultCwd || process.cwd());
    const workerCwd = !lockedCwd && clean(args.cwd) ? resolve(baseCwd, args.cwd) : baseCwd;
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
