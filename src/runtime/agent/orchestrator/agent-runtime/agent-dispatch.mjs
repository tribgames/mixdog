/**
 * Agent Runtime — Internal LLM Helper (session-based).
 *
 * Every one-shot LLM dispatch from internal callers (memory-cycle,
 * scheduler, webhook) now flows through the SAME session pipeline as the
 * MCP `agent` tool. No more parallel `provider.send()` helper — one code
 * path = one message shape = one usage log = "agent single path".
 *
 * The returned function uses the existing caller signature, so call sites
 * do not need changes:
 *
 *   const llm = makeAgentDispatch({ role: 'maintenance', preset: 'haiku' });
 *   const text = await llm({ prompt });
 *
 * Internally it:
 *   1. Resolves the preset (explicit arg > opts.preset > hidden-role config)
 *   2. Creates or reuses a session via the session manager
 *   3. Applies stateless-reset for stateless profiles so the prefix handle
 *      stays warm while per-dispatch transcripts never leak
 *   4. Calls `askSession` → provider.send() → usage logged via
 *      `session/manager.mjs` (mode='active')
 */

import { loadConfig } from '../config.mjs';
import { resolveRuntimeSpec } from '../config.mjs';
import { getHiddenRole, resolveAgentSessionPermission } from '../internal-roles.mjs';
import { prepareAgentSession } from './session-builder.mjs';
import {
    askSession,
    updateSessionStatus,
    closeSession,
} from '../session/manager.mjs';
import {
    agentWatchdogPolicyActive,
    evaluateAgentWatchdogAbort,
    resolveAgentWatchdogPolicy,
} from './agent-progress-watchdog.mjs';

// Cap agent role synthesis to ~3000 tokens (~12 KB at the 4 B/tok
// working average). Pool B explore/recall/search answers occasionally land
// 8-10k-token walls that then ride in the Lead context for the rest of the
// turn; the cap keeps those outliers bounded without touching the 95%+ of
// answers already under the threshold.
const BRIEF_CAP_BYTES = 12 * 1024;
function applyBriefCap(text) {
    if (typeof text !== 'string') return text;
    if (text.length <= BRIEF_CAP_BYTES) return text;
    const head = text.slice(0, BRIEF_CAP_BYTES);
    const approxTokens = Math.round(text.length / 4);
    return `${head}\n\n... [TRUNCATED — full answer was ~${approxTokens} tokens / ${Math.round(text.length / 1024)} KB. Re-run with brief:false for the complete synthesis]`;
}

// Unified-shard policy — most agent sessions (Pool B + Pool C) share the
// same tool schema so BP_1 is bit-identical across roles and one provider-side
// cache shard serves every caller. Per-role behaviour is steered by:
//   1. role-scoped BP2 instructions from agents/<role>.md and
//      rules/agent/<role>.md
//   2. call-time guards (loop.mjs write-block + ai-wrapped-dispatch
//      recursion break)
// Hidden-role exceptions are declarative: defaults/hidden-roles.json may set
// toolSchemaProfile when first-turn routing quality is worth a separate tool
// prefix. Standard profiles are none/read/full/read-write-search; legacy names
// stay as aliases.
// See manager.mjs resolveSessionTools for the single source of truth;
// agent visibility is declared via annotations.agentHidden on each tool def.
const HIDDEN_ROLE_TOOL_SCHEMA_PROFILES = Object.freeze({
    full: null,
    none: Object.freeze([]),
    read: Object.freeze([
        'code_graph',
        'find',
        'glob',
        'list',
        'grep',
        'read',
    ]),
    'read-write-search': Object.freeze([
        'code_graph',
        'find',
        'glob',
        'list',
        'grep',
        'read',
        'apply_patch',
        'search',
        'web_fetch',
    ]),
    // Backward-compatible aliases for older hidden-role definitions.
    unified: null,
    'llm-only': Object.freeze([]),
    'filesystem-read': Object.freeze([
        'code_graph',
        'find',
        'glob',
        'list',
        'grep',
        'read',
    ]),
});

export function resolveHiddenRoleSchemaAllowedTools(hidden) {
    if (!hidden) return null;
    if (Array.isArray(hidden.schemaAllowedTools)) {
        return hidden.schemaAllowedTools.map((name) => String(name || '').trim()).filter(Boolean);
    }
    const profile = String(hidden.toolSchemaProfile || 'full').trim() || 'full';
    if (Object.prototype.hasOwnProperty.call(HIDDEN_ROLE_TOOL_SCHEMA_PROFILES, profile)) {
        return HIDDEN_ROLE_TOOL_SCHEMA_PROFILES[profile];
    }
    process.stderr.write(`[agent-dispatch] unknown hidden-role toolSchemaProfile="${profile}" role="${hidden.name || 'unknown'}"; using full schema\n`);
    return null;
}

/**
 * Resolve the maintenance ROUTE (or legacy preset name) for a dispatch.
 *
 * Returns one of:
 *   - a route object `{ provider, model, effort?, fast? }` — the preferred
 *     shape: a maintenance slot now stores its model directly (parity with
 *     `agents.<role>`), so no preset-array name lookup is needed.
 *   - a string — a legacy preset NAME still stored in a maintenance slot, or an
 *     explicit `preset`/`opts.preset` override. The caller resolves the name
 *     against config.presets for backward compatibility.
 *   - null — unresolved.
 *
 * Hidden roles read their slot from `maint[maintKey || slot]`; the cycle1/2/3
 * agents share one knob via the `maintKey: 'memory'` override.
 */
export function resolveMaintenanceRoute({ preset, optsPreset, role, config: cfgIn = null }) {
    if (preset) return preset;
    if (optsPreset) return optsPreset;
    if (!role) return null;
    const hidden = getHiddenRole(role);
    if (hidden) {
        try {
            const config = cfgIn || loadConfig({ secrets: false });
            const maint = config?.maintenance || {};
            return maint[hidden.maintKey || hidden.slot] ?? null;
        } catch { return null; }
    }
    return null;
}

// Back-compat alias: older callers/tests import resolvePresetName. It now
// returns whatever resolveMaintenanceRoute does (route object OR name string).
export const resolvePresetName = resolveMaintenanceRoute;

// A maintenance slot value is a direct route when it carries provider+model.
function maintenanceRouteToPreset(routeOrName, role) {
    if (!routeOrName || typeof routeOrName !== 'object') return null;
    const provider = String(routeOrName.provider || '').trim();
    const model = String(routeOrName.model || '').trim();
    if (!provider || !model) return null;
    const out = {
        id: `maint-${role}`,
        name: `MAINT ${String(role || '').toUpperCase()}`,
        type: 'agent',
        provider,
        model,
        tools: 'full',
    };
    const effort = String(routeOrName.effort || '').trim();
    if (effort) out.effort = effort;
    if (routeOrName.fast === true) out.fast = true;
    return out;
}

/**
 * Build an agent-backed dispatch callback.
 *
 * @param {object} opts
 * @param {string} opts.role        — REQUIRED; canonical role name (worker, cycle1-agent, scheduler-task, ...)
 * @param {string} [opts.taskType]  — optional internal classification stamped on the session
 * @param {string} [opts.preset]    — explicit preset override (bypasses role → preset lookup)
 * @param {string} [opts.parentSessionId] — parent agent session for trace aggregation
 * @param {string|null} [opts.ownerSessionId] — owning Mixdog session for statusline isolation
 * @param {AbortSignal} [opts.parentSignal] — optional AbortSignal from the fan-out coordinator;
 *   when aborted the agent role session's own controller is also aborted so the
 *   provider call tears down promptly (parent→child cascade).
 * @returns {(args: { prompt, preset?, sourceName? }) => Promise<string>}
 */
export function makeAgentDispatch(opts = {}) {
    if (!opts.role || typeof opts.role !== 'string') {
        throw new Error('[agent-dispatch] opts.role is required');
    }
    const role = opts.role;

    return async function agentDispatch({ prompt, preset: presetArg, sourceName: sourceNameArg, parentSignal: callParentSignal, idleTimeoutMs: callIdleTimeoutMs }) {
        if (typeof prompt !== 'string' || !prompt) {
            throw new Error(`[agent-dispatch] prompt required for role "${role}"`);
        }

        const config = opts.config || loadConfig({ secrets: false });
        const routeOrName = resolveMaintenanceRoute({
            preset: presetArg,
            optsPreset: opts.preset,
            role,
            config,
        });
        if (!routeOrName) {
            throw new Error(
                `[agent-dispatch] maintenance route unresolved for role "${role}" `
                + `(preset="${presetArg || opts.preset || ''}")`,
            );
        }
        // Preferred path: a maintenance slot that stores its model directly
        // (route object). Legacy path: a slot still holding a preset NAME —
        // resolve it against config.presets for backward compatibility.
        let preset = maintenanceRouteToPreset(routeOrName, role);
        if (!preset) {
            const legacyName = String(routeOrName || '').trim();
            preset = config.presets?.find((p) => p.id === legacyName || p.name === legacyName) || null;
            if (!preset) {
                throw new Error(
                    `[agent-dispatch] maintenance route for role "${role}" is neither a `
                    + `{provider,model} route nor a known preset name ("${legacyName}")`,
                );
            }
        }
        // Stable label for traces / session metadata, derived from the resolved
        // preset object regardless of whether it came from a direct route or a
        // legacy preset name.
        const presetName = preset.id || preset.name || `maint-${role}`;

        const runtimeSpec = resolveRuntimeSpec(preset, {
            lane: 'agent',
            agentId: role,
        });

        // Callers (e.g. aiWrapped explore dispatch) may pass an explicit
        // `cwd` to scope the agent's filesystem view. Absolute path expected
        // (aiWrapped already expands `~` and resolves relatives). When unset
        // we pass `null` through instead of falling back to `process.cwd()`
        // — the MCP server's launch dir is not deterministic across callers,
        // and the downstream skill-discovery path tolerates null. Combined
        // with the frozen agent skill meta-tools (collect.mjs) this keeps
        // every caller on the same provider cache shard.
        const cwd = (typeof opts.cwd === 'string' && opts.cwd) ? opts.cwd : null;

        // Unified dispatch: Pool B/C share bit-identical tools + system prompt
        // unless a hidden role declares a narrow toolSchemaProfile. Per-role
        // differentiation lives in scoped role rules / stable session context;
        // raw role and permission labels are not repeated in the prompt.
        // Runtime permission enforcement was removed (every tool call is
        // trusted); schema profiles remain a routing-efficiency layer that
        // narrows the advertised tool list, not a runtime safety gate.
        const hidden = getHiddenRole(role);
        const isPoolC = Boolean(hidden);
        // Permission: read-declared hidden roles are locked in
        // resolveAgentSessionPermission (prepareAgentSession applies the same).
        const permission = resolveAgentSessionPermission(
            role,
            opts.permission ?? (isPoolC ? (hidden?.permission || 'read') : null),
        );
        // Pool C hidden-role instructions live in BP2 role-scoped context
        // (loaded by loadScopedRoleInstructions from rules/agent/*.md).
        //
        // User message = pure query. Stable role rules ride in BP2; stable
        // memory/meta rides in BP3; only the query varies per call, so
        // provider cache reuses the shared prefix.
        //
        // Stateless ephemeral session — created fresh per call, never
        // pooled or resumed. Cache prefix matching happens at the provider
        // layer (account-level), not the session level.
        const finalPrompt = prompt;
        const { session } = prepareAgentSession({
            role,
            presetName,
            preset,
            runtimeSpec,
            permission,
            cwd,
            sourceType: opts.sourceType,
            sourceName: sourceNameArg || opts.sourceName,
            parentSessionId: opts.parentSessionId || null,
            ownerSessionId: opts.ownerSessionId === undefined ? (opts.parentSessionId || null) : opts.ownerSessionId,
            clientHostPid: opts.clientHostPid,
            skipRoleReminder: isPoolC,
            schemaAllowedTools: resolveHiddenRoleSchemaAllowedTools(hidden),
            taskType: opts.taskType,
            maxLoopIterations: opts.maxLoopIterations,
        });
        // Diagnostic — dump the actual tool names exposed to this LLM call,
        // visible from the worker log instead of being hidden behind a
        // count-only "tools=N" line.
        try {
            const _toolNames = (session.tools || []).map((t) => t?.name).filter(Boolean);
            process.stderr.write(`[agent-dispatch] role=${role} tool-list (${_toolNames.length}): ${_toolNames.join(',')}\n`);
        } catch { /* best-effort diagnostic */ }

        await updateSessionStatus(session.id, 'running');
        // Parent→child abort cascade: when opts.parentSignal (factory) or
        // callParentSignal (per-call) fires, abort the sub-session's own
        // controller so the provider call tears down promptly. Best-effort:
        // if the session/manager import is unavailable we fall back silently.
        const _managerMod = await import('../session/manager.mjs').catch(() => null);
        const _linkSignal = _managerMod?.linkParentSignalToSession;
        const _getProgressSnapshot = _managerMod?.getSessionProgressSnapshot;
        const _getLastProgressAt = _managerMod?.getSessionLastProgressAt;
        if (_linkSignal) {
            if (opts.parentSignal instanceof AbortSignal) {
                try { _linkSignal(session.id, opts.parentSignal); } catch { /* ignore */ }
            }
            if (callParentSignal instanceof AbortSignal) {
                try { _linkSignal(session.id, callParentSignal); } catch { /* ignore */ }
            }
        }
        // Watchdog policy is split:
        // - firstResponseTimeoutMs cuts quickly only when the model produces no
        //   first stream/tool activity at all.
        // - idle/tool-running caps come from role stallCap (hidden roles) or env defaults.
        const _watchdogPolicy = resolveAgentWatchdogPolicy(role, {
            idleTimeoutMs: Number.isFinite(callIdleTimeoutMs)
                ? callIdleTimeoutMs
                : opts.idleTimeoutMs,
            firstResponseTimeoutMs: opts.firstResponseTimeoutMs,
        });
        const _idleController = (agentWatchdogPolicyActive(_watchdogPolicy) && _linkSignal)
            ? new AbortController()
            : null;
        if (_idleController) {
            try { _linkSignal(session.id, _idleController.signal); } catch { /* ignore */ }
        }
        const _idleTimer = (_idleController && (typeof _getProgressSnapshot === 'function' || typeof _getLastProgressAt === 'function'))
            ? setInterval(() => {
                const now = Date.now();
                const snapshot = typeof _getProgressSnapshot === 'function' ? _getProgressSnapshot(session.id) : null;
                const abortErr = snapshot
                    ? evaluateAgentWatchdogAbort(snapshot, now, _watchdogPolicy)
                    : null;
                if (!abortErr && !snapshot && typeof _getLastProgressAt === 'function') {
                    const last = _getLastProgressAt(session.id);
                    if (_watchdogPolicy.idleStaleMs > 0 && last && now - last > _watchdogPolicy.idleStaleMs) {
                        try { _idleController.abort(new Error(`agent task stale (${_watchdogPolicy.idleStaleMs}ms without progress)`)); } catch { /* ignore */ }
                    }
                    return;
                }
                if (abortErr) {
                    try { _idleController.abort(abortErr); } catch { /* ignore */ }
                }
            }, 1000)
            : null;
        if (_idleTimer && typeof _idleTimer.unref === 'function') _idleTimer.unref();
        let terminalStatus = 'idle';
        process.stderr.write(`[agent-dispatch] role=${role} preset=${presetName} model=${preset.model} provider=${preset.provider} session=${session.id}\n`);
        const _agentDispatchT0 = Date.now();
        try {
            const result = await askSession(session.id, finalPrompt, null, null, cwd);
            process.stderr.write(`[agent-dispatch] role=${role} session=${session.id} elapsed=${Date.now() - _agentDispatchT0}ms\n`);
            const raw = result?.content || '';
            // Brief cap. Agent role answers (explore/recall/search)
            // occasionally balloon to 8-10k token walls that then ride in the
            // parent Lead's context for the rest of the turn. A 3000-token
            // (~12 KB) ceiling trims the long tail while leaving the vast
            // majority of answers untouched. Opt-out via `brief:false` when
            // the caller explicitly wants the full synthesis.
            if (opts.brief === false) {
                try { closeSession(session.id, 'ephemeral-done'); } catch { /* ignore */ }
                return raw;
            }
            const out = applyBriefCap(raw);
            try { closeSession(session.id, 'ephemeral-done'); } catch { /* ignore */ }
            return out;
        } catch (err) {
            terminalStatus = 'error';
            try { closeSession(session.id, 'ephemeral-error'); } catch { /* ignore */ }
            throw err;
        } finally {
            if (_idleTimer) {
                try { clearInterval(_idleTimer); } catch { /* ignore */ }
            }
            // Always flip out of 'running' before returning so the sweep never
            // leaves a stateless Pool C session stuck in 'running' when the
            // try/catch falls through in unexpected ways.
            try { await updateSessionStatus(session.id, terminalStatus); } catch { /* ignore */ }
        }
    };
}
