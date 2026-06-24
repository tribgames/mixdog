/**
 * Smart Bridge — shared session builder.
 *
 * Single source of truth for bridge session creation + role/preset
 * telemetry. Both entry points route through this helper:
 *
 *   - `smart-bridge/bridge-llm.mjs` — internal callers
 *     (memory-cycle, scheduler, webhook) dispatching via
 *     `makeBridgeLlm`.
 *   - `src/agent/index.mjs` `case 'bridge'` — Lead-originated MCP
 *     bridge dispatches into user-workflow roles.
 *
 * Before this helper, the two paths carried separate `createSession` +
 * `traceBridgePreset` blocks. Lead-direct dispatches silently skipped
 * the trace so cache-hit analysis missed every user-workflow role call.
 *
 * Preset resolution stays with each caller since they read from
 * different sources (MCP: user-workflow.json only; Smart Bridge:
 * hidden-role map first, then user-workflow.json). The helper takes
 * already-resolved primitives.
 */

import { createSession } from '../session/manager.mjs';
import { traceBridgePreset } from '../bridge-trace.mjs';
import { resolveBridgeSessionPermission } from '../internal-roles.mjs';

/**
 * @param {object} opts
 * @param {string}  opts.role          — canonical role name ('worker', 'explorer', ...)
 * @param {string}  opts.presetName    — resolved preset identifier
 * @param {object}  opts.preset        — resolved preset object from agent-config
 * @param {object}  opts.runtimeSpec   — resolveRuntimeSpec output; must carry .scopeKey / .lane
 * @param {string}  [opts.permission]  — 'read' | 'read-write' | null (preset/full default when unset)
 * @param {string|null} [opts.cwd]     — absolute working dir; null is the fixed bridge sentinel meaning "no caller workspace context"
 * @param {string}  [opts.owner='bridge']
 * @param {string}  [opts.permissionMode] — Claude Code permissionMode forwarded from the MCP payload ('bypassPermissions', 'acceptEdits', 'plan', 'dontAsk', 'default')
 * @param {string[]} [opts.schemaAllowedTools] — schema-level allowlist from a hidden-role toolSchemaProfile
 * @param {string}  [opts.sourceType]
 * @param {string}  [opts.sourceName]
 * @param {string}  [opts.taskType]
 * @param {number}  [opts.maxLoopIterations]
 * @param {string}  [opts.parentSessionId]
 * @param {string|null} [opts.ownerSessionId] - owning Mixdog MCP instance id for statusline isolation
 * @param {boolean} [opts.skipRoleReminder=false] — Pool C suppresses Tier 3 reminder
 * @returns {{ session: object, effectiveCwd: string|null }}
 */
export function prepareBridgeSession({
    role,
    presetName,
    preset,
    runtimeSpec,
    permission,
    cwd,
    owner = 'bridge',
    permissionMode,
    sourceType,
    sourceName,
    taskType,
    maxLoopIterations,
    parentSessionId,
    ownerSessionId,
    clientHostPid,
    bridgeTag,
    skipRoleReminder = false,
    cacheKeyOverride,
    schemaAllowedTools,
}) {
    const effectivePermission = resolveBridgeSessionPermission(role, permission);
    // Pass cwd through verbatim — null is the fixed bridge sentinel meaning
    // "no caller workspace context" (cycle1-agent shards, etc). Upgrading
    // null → process.cwd() here would defeat cache-shard fork suppression.
    // Downstream collectors (collect.mjs) handle null as "no project cwd".
    const effectiveCwd = cwd == null ? null : cwd;
    const effectiveOwnerSessionId = ownerSessionId === undefined
        ? (process.env.MIXDOG_OWNER_SESSION_ID || null)
        : ownerSessionId;
    const sessionOpts = {
        preset,
        owner,
        scopeKey: runtimeSpec.scopeKey,
        lane: runtimeSpec.lane,
        cwd: effectiveCwd,
        role: role || undefined,
        taskType: taskType || undefined,
        maxLoopIterations: Number.isFinite(maxLoopIterations) ? maxLoopIterations : undefined,
        sourceType: sourceType || undefined,
        sourceName: sourceName || undefined,
        ownerSessionId: effectiveOwnerSessionId || null,
        clientHostPid: clientHostPid || null,
    };
    if (bridgeTag) sessionOpts.bridgeTag = bridgeTag;
    if (effectivePermission) sessionOpts.permission = effectivePermission;
    if (permissionMode) sessionOpts.permissionMode = permissionMode;
    if (skipRoleReminder) sessionOpts.skipRoleReminder = true;
    if (cacheKeyOverride) sessionOpts.cacheKeyOverride = cacheKeyOverride;
    if (Array.isArray(schemaAllowedTools)) {
        sessionOpts.schemaAllowedTools = schemaAllowedTools;
    }
    const session = createSession(sessionOpts);
    try {
        traceBridgePreset({
            sessionId: session.id,
            role: role || null,
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
