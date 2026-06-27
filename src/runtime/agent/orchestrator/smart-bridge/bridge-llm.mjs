/**
 * Smart Bridge — Internal LLM Helper (session-based).
 *
 * Every one-shot LLM dispatch from internal callers (memory-cycle,
 * scheduler, webhook) now flows through the SAME session pipeline as the
 * MCP `bridge` tool. No more parallel `provider.send()` helper — one code
 * path = one message shape = one usage log = "bridge single path".
 *
 * The returned function uses the existing caller signature, so call sites
 * do not need changes:
 *
 *   const llm = makeBridgeLlm({ role: 'maintenance', preset: 'haiku' });
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
import { getHiddenRole, resolveBridgeSessionPermission } from '../internal-roles.mjs';
import { prepareBridgeSession } from './session-builder.mjs';
import {
    askSession,
    updateSessionStatus,
    closeSession,
} from '../session/manager.mjs';

// Cap bridge role synthesis to ~3000 tokens (~12 KB at the 4 B/tok
// working average). Pool B explore/recall/search answers occasionally land
// 8-10k-token walls that then ride in the Lead context for the rest of the
// turn; the cap keeps those outliers bounded without touching the 95%+ of
// answers already under the threshold.
const BRIEF_CAP_BYTES = 12 * 1024;
function envTimeoutMs(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = envTimeoutMs('MIXDOG_BRIDGE_FIRST_RESPONSE_TIMEOUT_MS', 120_000);
const DEFAULT_STALE_TIMEOUT_MS = envTimeoutMs('MIXDOG_BRIDGE_STALE_TIMEOUT_MS', 30 * 60_000);
function applyBriefCap(text) {
    if (typeof text !== 'string') return text;
    if (text.length <= BRIEF_CAP_BYTES) return text;
    const head = text.slice(0, BRIEF_CAP_BYTES);
    const approxTokens = Math.round(text.length / 4);
    return `${head}\n\n... [TRUNCATED — full answer was ~${approxTokens} tokens / ${Math.round(text.length / 1024)} KB. Re-run with brief:false for the complete synthesis]`;
}

// Unified-shard policy — most bridge sessions (Pool B + Pool C) share the
// same tool schema so BP_1 is bit-identical across roles and one provider-side
// cache shard serves every caller. Per-role behaviour is steered by:
//   1. rules/bridge/*.md concatenated into BP2 roleCatalog (via
//      loadScopedRoleCatalog — every bridge session carries the full
//      hidden-role catalog so the shard stays bit-identical across roles)
//   2. call-time guards (loop.mjs write-block + ai-wrapped-dispatch
//      recursion break)
// Hidden-role exceptions are declarative: defaults/hidden-roles.json may set
// toolSchemaProfile when first-turn routing quality is worth a separate tool
// prefix. Standard profiles are none/read/full; legacy names stay as aliases.
// See manager.mjs resolveSessionTools for the single source of truth;
// bridge visibility is declared via annotations.bridgeHidden on each tool def.
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
    process.stderr.write(`[bridge-llm] unknown hidden-role toolSchemaProfile="${profile}" role="${hidden.name || 'unknown'}"; using full schema\n`);
    return null;
}

/**
 * Resolve a preset name from (preset arg | opts.preset | hidden-role config).
 */
export function resolvePresetName({ preset, optsPreset, role, config: cfgIn = null }) {
    if (preset) return preset;
    if (optsPreset) return optsPreset;
    if (!role) return null;
    // Hidden roles resolve their maintenance preset by SLOT. Every slot carries
    // a concrete default in DEFAULT_MAINTENANCE, so `maint[slot]` resolves
    // directly; the Setup panel can still tune each slot independently.
    // (explorer.slot = 'explore', cycle1-agent.slot = 'cycle1', …). A hidden
    // role may override which maintenance key it reads via `maintKey`
    // (e.g. the cycle1/2/3 agents all read `maint.memory` instead of their
    // own slot) so several agents can share one model knob while keeping
    // distinct slots/identity.
    const hidden = getHiddenRole(role);
    if (hidden) {
        try {
            const config = cfgIn || loadConfig({ secrets: false });
            const maint = config?.maintenance || {};
            return maint[hidden.maintKey || hidden.slot] || null;
        } catch { return null; }
    }
    return null;
}

/**
 * Build a bridge-backed LLM callback.
 *
 * @param {object} opts
 * @param {string} opts.role        — REQUIRED; canonical role name (worker, cycle1-agent, scheduler-task, ...)
 * @param {string} [opts.taskType]  — optional internal classification stamped on the session
 * @param {string} [opts.preset]    — explicit preset override (bypasses role → preset lookup)
 * @param {string} [opts.parentSessionId] — parent bridge session for trace aggregation
 * @param {string|null} [opts.ownerSessionId] — owning Mixdog session for statusline isolation
 * @param {AbortSignal} [opts.parentSignal] — optional AbortSignal from the fan-out coordinator;
 *   when aborted the bridge role session's own controller is also aborted so the
 *   provider call tears down promptly (parent→child cascade).
 * @returns {(args: { prompt, preset?, sourceName? }) => Promise<string>}
 */
export function makeBridgeLlm(opts = {}) {
    if (!opts.role || typeof opts.role !== 'string') {
        throw new Error('[bridge-llm] opts.role is required');
    }
    const role = opts.role;

    return async function bridgeLlm({ prompt, preset: presetArg, sourceName: sourceNameArg, parentSignal: callParentSignal, idleTimeoutMs: callIdleTimeoutMs }) {
        if (typeof prompt !== 'string' || !prompt) {
            throw new Error(`[bridge-llm] prompt required for role "${role}"`);
        }

        const config = opts.config || loadConfig({ secrets: false });
        const presetName = resolvePresetName({
            preset: presetArg,
            optsPreset: opts.preset,
            role,
            config,
        });
        if (!presetName) {
            throw new Error(
                `[bridge-llm] preset unresolved for role "${role}" `
                + `(preset="${presetArg || opts.preset || ''}")`,
            );
        }

        const preset = config.presets?.find((p) => p.id === presetName || p.name === presetName);
        if (!preset) {
            throw new Error(`[bridge-llm] preset "${presetName}" not found in mixdog-config.json`);
        }

        const runtimeSpec = resolveRuntimeSpec(preset, {
            lane: 'bridge',
            agentId: role,
        });

        // Callers (e.g. aiWrapped explore dispatch) may pass an explicit
        // `cwd` to scope the agent's filesystem view. Absolute path expected
        // (aiWrapped already expands `~` and resolves relatives). When unset
        // we pass `null` through instead of falling back to `process.cwd()`
        // — the MCP server's launch dir is not deterministic across callers,
        // and the downstream skill-discovery path tolerates null. Combined
        // with the frozen bridge skill meta-tools (collect.mjs) this keeps
        // every caller on the same provider cache shard.
        const cwd = (typeof opts.cwd === 'string' && opts.cwd) ? opts.cwd : null;

        // Unified dispatch: Pool B/C share bit-identical tools + system prompt
        // unless a hidden role declares a narrow toolSchemaProfile. Per-role
        // differentiation rides in the user-message header (permission + role
        // line) plus an optional short Pool C snippet. The read-only contract
        // is still enforced at call time via loop.mjs's READ_BLOCKED_TOOLS
        // guard; schema profiles are a routing-efficiency layer, not safety.
        const hidden = getHiddenRole(role);
        const isPoolC = Boolean(hidden);
        // Permission: read-declared hidden roles are locked in
        // resolveBridgeSessionPermission (prepareBridgeSession applies the same).
        const permission = resolveBridgeSessionPermission(
            role,
            opts.permission ?? (isPoolC ? (hidden?.permission || 'read') : null),
        );
        // Pool C hidden-role instructions live in BP2 roleCatalog (loaded
        // by loadScopedRoleCatalog from rules/bridge/*.md) — the Tier 3
        // reminder is suppressed so the shard stays bit-identical across
        // every bridge role.
        //
        // User message = pure query. Permission / role ride in BP3
        // sessionMarker (composeSystemPrompt) — only the query varies per
        // call, so provider cache reuses the shared prefix.
        //
        // Stateless ephemeral session — created fresh per call, never
        // pooled or resumed. Cache prefix matching happens at the provider
        // layer (account-level), not the session level.
        const finalPrompt = prompt;
        const { session } = prepareBridgeSession({
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
            process.stderr.write(`[bridge-llm] role=${role} tool-list (${_toolNames.length}): ${_toolNames.join(',')}\n`);
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
        // - idleTimeoutMs is a stale watchdog after work has started.
        //   0 disables that stale abort; default is 30 minutes.
        const _staleMs = Number.isFinite(callIdleTimeoutMs)
            ? callIdleTimeoutMs
            : (Number.isFinite(opts.idleTimeoutMs) ? opts.idleTimeoutMs : DEFAULT_STALE_TIMEOUT_MS);
        const _firstMs = Number.isFinite(opts.firstResponseTimeoutMs)
            ? opts.firstResponseTimeoutMs
            : DEFAULT_FIRST_RESPONSE_TIMEOUT_MS;
        const _idleController = ((_staleMs > 0 || _firstMs > 0) && _linkSignal) ? new AbortController() : null;
        if (_idleController) {
            try { _linkSignal(session.id, _idleController.signal); } catch { /* ignore */ }
        }
        const _idleTimer = (_idleController && (typeof _getProgressSnapshot === 'function' || typeof _getLastProgressAt === 'function'))
            ? setInterval(() => {
                const now = Date.now();
                const snapshot = typeof _getProgressSnapshot === 'function' ? _getProgressSnapshot(session.id) : null;
                if (snapshot) {
                    if (snapshot.waitingForFirstActivity) {
                        const startedAt = snapshot.modelRequestStartedAt || snapshot.askStartedAt;
                        if (_firstMs > 0 && startedAt && now - startedAt > _firstMs) {
                            try { _idleController.abort(new Error(`first response stale (${_firstMs}ms)`)); } catch { /* ignore */ }
                        }
                        return;
                    }
                    const last = snapshot.lastProgressAt || snapshot.firstActivityAt;
                    if (_staleMs > 0 && last && now - last > _staleMs) {
                        try { _idleController.abort(new Error(`agent task stale (${_staleMs}ms without stream/tool progress)`)); } catch { /* ignore */ }
                    }
                    return;
                }
                const last = _getLastProgressAt?.(session.id);
                if (_staleMs > 0 && last && now - last > _staleMs) {
                    try { _idleController.abort(new Error(`agent task stale (${_staleMs}ms without progress)`)); } catch { /* ignore */ }
                }
            }, 1000)
            : null;
        if (_idleTimer && typeof _idleTimer.unref === 'function') _idleTimer.unref();
        let terminalStatus = 'idle';
        process.stderr.write(`[bridge-llm] role=${role} preset=${presetName} model=${preset.model} provider=${preset.provider} session=${session.id}\n`);
        const _bridgeT0 = Date.now();
        try {
            const result = await askSession(session.id, finalPrompt, null, null, cwd);
            process.stderr.write(`[bridge-llm] role=${role} session=${session.id} elapsed=${Date.now() - _bridgeT0}ms\n`);
            const raw = result?.content || '';
            // Brief cap. Bridge role answers (explore/recall/search)
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
