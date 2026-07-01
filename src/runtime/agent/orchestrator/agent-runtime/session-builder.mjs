/**
 * Agent Runtime — shared session builder.
 *
 * Single source of truth for agent session creation + role/preset
 * telemetry. Both entry points route through this helper:
 *
 *   - `agent-runtime/agent-dispatch.mjs` — internal callers
 *     (memory-cycle, scheduler, webhook) dispatching via
 *     `makeAgentDispatch`.
 *   - Lead-originated agent dispatches into configured workflow agents.
 *
 * Before this helper, the two paths carried separate `createSession` +
 * `traceAgentPreset` blocks. Lead-direct dispatches silently skipped
 * the trace so cache-hit analysis missed every public agent call.
 *
 * Preset resolution stays with each caller since they read from
 * different sources. The helper takes already-resolved primitives.
 */

import { createSession } from '../session/manager.mjs';
import { traceAgentPreset } from '../agent-trace.mjs';
import { getHiddenAgent, resolveAgentSessionPermission } from '../internal-agents.mjs';
import { loadConfig } from '../config.mjs';
import { AGENT_OWNER } from '../agent-owner.mjs';
import { resolvePublicAgentMaxLoopIterations } from './agent-loop-policy.mjs';

/**
 * @param {object} opts
 * @param {string}  opts.agent         — canonical agent name ('worker', 'explorer', ...)
 * @param {string}  opts.presetName    — resolved preset identifier
 * @param {object}  opts.preset        — resolved preset object from agent-config
 * @param {object}  opts.runtimeSpec   — resolveRuntimeSpec output; must carry .scopeKey / .lane
 * @param {string}  [opts.permission]  — 'none' | 'read' | 'read-write' | 'mcp' | 'full' | null
 * @param {string|null} [opts.cwd]     — absolute working dir; null is the fixed agent sentinel meaning "no caller workspace context"
 * @param {string}  [opts.owner='agent']
 * @param {string}  [opts.permissionMode] — permissionMode forwarded from the MCP payload ('bypassPermissions', 'acceptEdits', 'plan', 'dontAsk', 'default')
 * @param {string[]} [opts.schemaAllowedTools] — schema-level allowlist from a hidden-agent toolSchemaProfile
 * @param {string}  [opts.sourceType]
 * @param {string}  [opts.sourceName]
 * @param {string}  [opts.taskType]
 * @param {number}  [opts.maxLoopIterations]
 * @param {string}  [opts.parentSessionId]
 * @param {string|null} [opts.ownerSessionId] - owning Mixdog MCP instance id for statusline isolation
 * @returns {{ session: object, effectiveCwd: string|null }}
 */
export function prepareAgentSession({
    agent,
    presetName,
    preset,
    runtimeSpec,
    permission,
    cwd,
    owner = 'agent',
    permissionMode,
    sourceType,
    sourceName,
    taskType,
    maxLoopIterations,
    parentSessionId,
    ownerSessionId,
    clientHostPid,
    agentTag,
    cacheKeyOverride,
    schemaAllowedTools,
}) {
    const effectivePermission = resolveAgentSessionPermission(agent, permission);
    let effectiveMaxLoopIterations = maxLoopIterations;
    if (
        !Number.isFinite(effectiveMaxLoopIterations)
        && owner === AGENT_OWNER
        && agent
        && !getHiddenAgent(agent)
    ) {
        const agentCap = resolvePublicAgentMaxLoopIterations(agent, effectivePermission);
        if (Number.isFinite(agentCap) && agentCap > 0) {
            effectiveMaxLoopIterations = agentCap;
        }
    }
    // Pass cwd through verbatim — null is the fixed agent sentinel meaning
    // "no caller workspace context" (cycle1-agent shards, etc). Upgrading
    // null → process.cwd() here would defeat cache-shard fork suppression.
    // Downstream collectors (collect.mjs) handle null as "no project cwd".
    const effectiveCwd = cwd == null ? null : cwd;
    const effectiveOwnerSessionId = ownerSessionId === undefined
        ? (process.env.MIXDOG_OWNER_SESSION_ID || null)
        : ownerSessionId;
    let compaction = null;
    try {
        const cfg = loadConfig({ secrets: false });
        // Agent worker sessions should keep the higher-quality semantic compact
        // path even when the Lead session uses recall-fasttrack for cheap
        // auto-clear/auto-compact. Cycle maintenance prompts are small enough
        // that this normally only matters for long-lived worker conversations.
        const base = cfg?.compaction && typeof cfg.compaction === 'object' ? cfg.compaction : {};
        compaction = { ...base, type: '1', compactType: '1' };
    } catch { /* config is best-effort for agent compaction policy */ }
    const sessionOpts = {
        preset,
        owner,
        scopeKey: runtimeSpec.scopeKey,
        lane: runtimeSpec.lane,
        cwd: effectiveCwd,
        agent: agent || undefined,
        taskType: taskType || undefined,
        maxLoopIterations: Number.isFinite(effectiveMaxLoopIterations) ? effectiveMaxLoopIterations : undefined,
        sourceType: sourceType || undefined,
        sourceName: sourceName || undefined,
        ownerSessionId: effectiveOwnerSessionId || null,
        clientHostPid: clientHostPid || null,
        compaction: compaction || undefined,
    };
    if (agentTag) sessionOpts.agentTag = agentTag;
    if (effectivePermission) sessionOpts.permission = effectivePermission;
    if (permissionMode) sessionOpts.permissionMode = permissionMode;
    if (cacheKeyOverride) sessionOpts.cacheKeyOverride = cacheKeyOverride;
    if (Array.isArray(schemaAllowedTools)) {
        sessionOpts.schemaAllowedTools = schemaAllowedTools;
    }
    const session = createSession(sessionOpts);
    try {
        traceAgentPreset({
            sessionId: session.id,
            agent: agent || null,
            presetName: presetName || null,
            // runtimeSpec carries scopeKey/lane but resolveRuntimeSpec does not
            // populate model/provider — fall back to preset fields.
            model: runtimeSpec?.model || preset?.model || null,
            provider: runtimeSpec?.provider || preset?.provider || null,
            parentSessionId: parentSessionId || null,
            permission: effectivePermission || null,
            sourceName: sourceName || null,
            cacheKeyOverride: cacheKeyOverride || null,
        });
    } catch { /* telemetry best-effort */ }
    return { session, effectiveCwd };
}
