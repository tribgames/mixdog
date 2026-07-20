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
 *   const llm = makeAgentDispatch({ agent: 'maintenance', preset: 'haiku' });
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
import { getHiddenAgent, resolveAgentSessionPermission } from '../internal-agents.mjs';
import { isKnownProvider } from '../../../../standalone/provider-admin.mjs';
import { prepareAgentSession } from './session-builder.mjs';
import {
    askSession,
    updateSessionStatus,
    closeSession,
    getSession,
} from '../session/manager.mjs';
import {
    abortAgentProgressWatchdog,
    agentWatchdogPolicyActive,
    evaluateAgentWatchdogAbort,
    resolveAgentWatchdogPolicy,
    resolveHandoffMessageStartIndex,
    watchdogPartialHandoffFromError,
    AgentStallAbortError,
} from './agent-progress-watchdog.mjs';
import { resourceAdmission } from '../../../shared/resource-admission.mjs';

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

function formatCompactElapsedSeconds(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value <= 0) return '';
    return `${Math.max(1, Math.ceil(value / 1000))}s`;
}

function agentCompactEventLabel(event = {}) {
    const status = String(event.status || '').toLowerCase();
    const reactive = String(event.trigger || '').toLowerCase() === 'reactive';
    if (status === 'failed') return reactive ? 'Compact failed (overflow retry)' : 'Compact failed';
    if (status === 'skipped') return 'Compact skipped';
    if (status === 'no_change') return 'Compact checked';
    return reactive ? 'Compact complete (overflow recovery)' : 'Compact complete';
}

function agentCompactEventDetail(event = {}) {
    const parts = [];
    const elapsed = formatCompactElapsedSeconds(Number(event.durationMs ?? event.elapsedMs ?? 0));
    if (elapsed) parts.push(elapsed);
    const type = String(event.compactType || event.type || '').trim();
    if (type && type !== 'semantic') parts.push(type);
    const trigger = String(event.trigger || '').toLowerCase();
    if (trigger === 'reactive') parts.push('reactive');
    else if (trigger === 'manual') parts.push('manual');
    const before = Number(event.beforeTokens ?? event.pressureTokens ?? 0);
    const after = Number(event.afterTokens ?? 0);
    const fmtTok = (n) => {
        const v = Number(n) || 0;
        if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
        return `${Math.round(v)}`;
    };
    if (before > 0 && after > 0 && after !== before) parts.push(`${fmtTok(before)}→${fmtTok(after)}`);
    return parts.join(' · ');
}

// Unified-shard policy — most agent sessions (Pool B + Pool C) share the
// same tool schema so BP_1 is bit-identical across roles and one provider-side
// cache shard serves every caller. Per-role behaviour is steered by:
//   1. role-scoped BP2 instructions from agents/<role>.md and
//      rules/agent/<role>.md
//   2. call-time guards (loop.mjs write-block + ai-wrapped-dispatch
//      recursion break)
// Hidden-agent exceptions are declarative: defaults/agents.json may set
// toolSchemaProfile when first-turn routing quality is worth a separate tool
// prefix. Standard profiles are none/read/full/read-write-search.
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
    process.stderr.write(`[agent-dispatch] unknown hidden-agent toolSchemaProfile="${profile}" agent="${hidden.agent || 'unknown'}"; using full schema\n`);
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
 * Explore and memory hidden roles mirror public spawning precedence:
 * `agents.<role>` (including legacy `agents.maintenance`) → workflow route →
 * maintenance route → Main. The cycle1/2/3 agents share the memory knob via
 * their `maintKey: 'memory'` override. Scheduler and webhook are unchanged.
 */
const DEFAULT_AGENT_ROUTE_PROVIDER = 'anthropic-oauth';

function normalizeMaintenanceCandidate(candidate, config) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate || null;
    const configuredProvider = String(config?.defaultProvider || '').trim();
    const fallbackProvider = isKnownProvider(configuredProvider)
        ? configuredProvider
        : DEFAULT_AGENT_ROUTE_PROVIDER;
    const provider = String(candidate.provider || fallbackProvider).trim();
    const model = String(candidate.model || '').trim();
    if (!provider || !model) return null;
    return {
        provider,
        model,
        effort: String(candidate.effort || '').trim() || undefined,
        fast: candidate.fast === true,
    };
}

export function resolveMaintenanceRoute({ preset, optsPreset, agent, config: cfgIn = null }) {
    if (preset) return preset;
    if (optsPreset) return optsPreset;
    if (!agent) return null;
    const hidden = getHiddenAgent(agent);
    if (hidden) {
        try {
            const config = cfgIn || loadConfig({ secrets: false });
            const maint = config?.maintenance || {};
            const key = hidden.maintKey || hidden.slot;
            const role = key === 'explore' ? 'explore' : (key === 'memory' ? 'maintainer' : '');
            const workflowSlot = key === 'explore' ? 'explorer' : (key === 'memory' ? 'memory' : '');
            if (!role) return maint[key] ?? null;
            const candidates = [
                role ? config?.agents?.[role] : null,
                key === 'memory' ? config?.agents?.maintenance : null,
                workflowSlot ? config?.workflowRoutes?.[workflowSlot] : null,
                maint[key],
                role ? config?.default : null,
            ];
            for (const candidate of candidates) {
                const route = normalizeMaintenanceCandidate(candidate, config);
                if (route) return route;
            }
            return null;
        } catch { return null; }
    }
    return null;
}

// Back-compat alias: older callers/tests import resolvePresetName. It now
// returns whatever resolveMaintenanceRoute does (route object OR name string).
export const resolvePresetName = resolveMaintenanceRoute;

// A maintenance slot value is a direct route when it carries provider+model.
function maintenanceRouteToPreset(routeOrName, agent) {
    if (!routeOrName || typeof routeOrName !== 'object') return null;
    const provider = String(routeOrName.provider || '').trim();
    const model = String(routeOrName.model || '').trim();
    if (!provider || !model) return null;
    const out = {
        id: `maint-${agent}`,
        name: `MAINT ${String(agent || '').toUpperCase()}`,
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
 * @param {string} opts.agent       — REQUIRED; canonical agent name (worker, cycle1-agent, scheduler-task, ...)
 * @param {string} [opts.taskType]  — optional internal classification stamped on the session
 * @param {string} [opts.preset]    — explicit preset override (bypasses agent → preset lookup)
 * @param {string} [opts.parentSessionId] — parent agent session for trace aggregation
 * @param {string|null} [opts.ownerSessionId] — owning Mixdog session for statusline isolation
 * @param {AbortSignal} [opts.parentSignal] — optional AbortSignal from the fan-out coordinator;
 *   when aborted the agent session's own controller is also aborted so the
 *   provider call tears down promptly (parent→child cascade).
 * @returns {(args: { prompt, preset?, sourceName? }) => Promise<string>}
 */
// runtime-liveness keeps one parent link per session because askSession swaps
// its controller at turn start.  Agent dispatch can have several independent
// cancellation sources, so collapse them before installing that one link.
// The first already-aborted source wins (in declaration order), retaining its
// original reason instead of replacing it with a generic AbortError.
export function composeAgentDispatchAbortSignal(signals) {
    const sources = (Array.isArray(signals) ? signals : [])
        .filter((signal) => signal instanceof AbortSignal);
    if (sources.length === 0) return { signal: null, dispose: () => {} };
    const controller = new AbortController();
    const listeners = [];
    const abortFrom = (signal) => {
        if (controller.signal.aborted) return;
        try { controller.abort(signal.reason); } catch { try { controller.abort(); } catch { /* ignore */ } }
    };
    for (const signal of sources) {
        if (signal.aborted) {
            abortFrom(signal);
            break;
        }
        const listener = () => abortFrom(signal);
        signal.addEventListener('abort', listener, { once: true });
        listeners.push([signal, listener]);
    }
    return {
        signal: controller.signal,
        dispose: () => {
            for (const [signal, listener] of listeners) {
                try { signal.removeEventListener('abort', listener); } catch { /* ignore */ }
            }
        },
    };
}

export function makeAgentDispatch(opts = {}) {
    if (!opts.agent || typeof opts.agent !== 'string') {
        throw new Error('[agent-dispatch] opts.agent is required');
    }
    const agent = opts.agent;

    return async function agentDispatch({ prompt, preset: presetArg, sourceName: sourceNameArg, parentSignal: callParentSignal, idleTimeoutMs: callIdleTimeoutMs, cwd: callCwd }) {
        if (typeof prompt !== 'string' || !prompt) {
            throw new Error(`[agent-dispatch] prompt required for agent "${agent}"`);
        }
        const admission = opts.resourceAdmission || resourceAdmission;
        const admissionAbortLink = composeAgentDispatchAbortSignal([
            opts.parentSignal,
            callParentSignal,
        ]);
        let lease;
        try {
            lease = await admission.acquire('agent', {
                signal: admissionAbortLink.signal,
                label: agent,
            });
        } catch (error) {
            admissionAbortLink.dispose();
            throw error;
        }
        try {

        const runAdmitted = (task) => typeof admission.runWithLease === 'function'
            ? admission.runWithLease(lease, task)
            : task();
        return await runAdmitted(async () => {
        const config = opts.config || loadConfig({ secrets: false });
        const routeOrName = resolveMaintenanceRoute({
            preset: presetArg,
            optsPreset: opts.preset,
            agent,
            config,
        });
        if (!routeOrName) {
            throw new Error(
                `[agent-dispatch] maintenance route unresolved for agent "${agent}" `
                + `(preset="${presetArg || opts.preset || ''}")`,
            );
        }
        // Preferred path: a maintenance slot that stores its model directly
        // (route object). Legacy path: a slot still holding a preset NAME —
        // resolve it against config.presets for backward compatibility.
        let preset = maintenanceRouteToPreset(routeOrName, agent);
        if (!preset) {
            const legacyName = String(routeOrName || '').trim();
            preset = config.presets?.find((p) => p.id === legacyName || p.name === legacyName) || null;
            if (!preset) {
                throw new Error(
                    `[agent-dispatch] maintenance route for agent "${agent}" is neither a `
                    + `{provider,model} route nor a known preset name ("${legacyName}")`,
                );
            }
        }
        // Stable label for traces / session metadata, derived from the resolved
        // preset object regardless of whether it came from a direct route or a
        // legacy preset name.
        const presetName = preset.id || preset.name || `maint-${agent}`;

        const runtimeSpec = resolveRuntimeSpec(preset, {
            lane: 'agent',
            agentId: agent,
        });

        // Callers (e.g. aiWrapped explore dispatch) may pass an explicit
        // `cwd` to scope the agent's filesystem view. Absolute path expected
        // (aiWrapped already expands `~` and resolves relatives). When unset
        // we pass `null` through instead of falling back to `process.cwd()`
        // — the MCP server's launch dir is not deterministic across callers,
        // and the downstream skill-discovery path tolerates null. Combined
        // with the frozen agent skill meta-tools (collect.mjs) this keeps
        // every caller on the same provider cache shard.
        const cwd = (typeof callCwd === 'string' && callCwd)
            ? callCwd
            : ((typeof opts.cwd === 'string' && opts.cwd) ? opts.cwd : null);

        // Unified dispatch: Pool B/C share bit-identical tools + system prompt
        // unless a hidden role declares a narrow toolSchemaProfile. Per-role
        // differentiation lives in scoped role rules / stable session context;
        // raw role and permission labels are not repeated in the prompt.
        // Runtime permission enforcement was removed (every tool call is
        // trusted); schema profiles remain a routing-efficiency layer that
        // narrows the advertised tool list, not a runtime safety gate.
        const hidden = getHiddenAgent(agent);
        const isPoolC = Boolean(hidden);
        // Permission: read-declared hidden roles are locked in
        // resolveAgentSessionPermission (prepareAgentSession applies the same).
        const permission = resolveAgentSessionPermission(
            agent,
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
            agent,
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
            process.stderr.write(`[agent-dispatch] agent=${agent} tool-list (${_toolNames.length}): ${_toolNames.join(',')}\n`);
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
        const _getSession = _managerMod?.getSession || getSession;
        // Watchdog policy is split:
        // - firstResponseTimeoutMs cuts quickly only when the model produces no
        //   first stream/tool activity at all.
        // - idle/tool-running caps come from role stallCap (hidden roles) or env defaults.
        const _watchdogPolicy = resolveAgentWatchdogPolicy(agent, {
            idleTimeoutMs: Number.isFinite(callIdleTimeoutMs)
                ? callIdleTimeoutMs
                : opts.idleTimeoutMs,
            firstResponseTimeoutMs: opts.firstResponseTimeoutMs,
        });
        const _idleController = (agentWatchdogPolicyActive(_watchdogPolicy) && _linkSignal)
            ? new AbortController()
            : null;
        // Do not link factory parent, per-call explore cancellation, and the
        // watchdog one at a time: each link replaces the previous listener in
        // runtime-liveness.  One composite survives askSession's controller
        // swap and makes every source reach the provider call.
        const _abortLink = composeAgentDispatchAbortSignal([
            opts.parentSignal,
            callParentSignal,
            _idleController?.signal,
        ]);
        if (_linkSignal && _abortLink.signal) {
            try { _linkSignal(session.id, _abortLink.signal); } catch { /* ignore */ }
        }
        // Watchdog blind spot guard: when the runtime snapshot is missing AND
        // no progress timestamp exists (pre-liveness hang, swept runtime), the
        // dispatch start time anchors staleness so the abort still fires.
        const _watchdogAnchorTs = Date.now();
        const _idleTimer = (_idleController && (typeof _getProgressSnapshot === 'function' || typeof _getLastProgressAt === 'function'))
            ? setInterval(() => {
                if (_idleController.signal?.aborted) return;
                const now = Date.now();
                const snapshot = typeof _getProgressSnapshot === 'function' ? _getProgressSnapshot(session.id) : null;
                const abortErr = snapshot
                    ? evaluateAgentWatchdogAbort(snapshot, now, _watchdogPolicy)
                    : null;
                if (!abortErr && !snapshot) {
                    const reported = typeof _getLastProgressAt === 'function' ? _getLastProgressAt(session.id) : 0;
                    const last = reported || _watchdogAnchorTs;
                    if (_watchdogPolicy.idleStaleMs > 0 && now - last > _watchdogPolicy.idleStaleMs) {
                        const err = new AgentStallAbortError(`agent task stale (${_watchdogPolicy.idleStaleMs}ms without progress)`);
                        const sess = typeof _getSession === 'function' ? _getSession(session.id) : null;
                        abortAgentProgressWatchdog(_idleController, {
                            sessionId: session.id,
                            agent,
                            error: err,
                            policy: _watchdogPolicy,
                            now,
                            anchorTs: _watchdogAnchorTs,
                            lastProgressAt: reported,
                            iteration: typeof sess?.lastIterationIndex === 'number' ? sess.lastIterationIndex : null,
                        });
                    }
                    return;
                }
                if (abortErr) {
                    const sess = typeof _getSession === 'function' ? _getSession(session.id) : null;
                    abortAgentProgressWatchdog(_idleController, {
                        sessionId: session.id,
                        agent,
                        error: abortErr,
                        snapshot,
                        policy: _watchdogPolicy,
                        now,
                        anchorTs: _watchdogAnchorTs,
                        iteration: typeof sess?.lastIterationIndex === 'number' ? sess.lastIterationIndex : null,
                    });
                }
            }, 1000)
            : null;
        if (_idleTimer && typeof _idleTimer.unref === 'function') _idleTimer.unref();
        let terminalStatus = 'idle';
        process.stderr.write(`[agent-dispatch] agent=${agent} preset=${presetName} model=${preset.model} provider=${preset.provider} session=${session.id}\n`);
        const _agentDispatchT0 = Date.now();
        let _handoffMsgStart = 0;
        try {
            _handoffMsgStart = resolveHandoffMessageStartIndex(getSession(session.id));
            const result = await askSession(session.id, finalPrompt, null, null, cwd, undefined, {
                onCompactEvent: (event) => {
                    try {
                        const label = agentCompactEventLabel(event);
                        const detail = agentCompactEventDetail(event);
                        const suffix = detail ? ` (${detail})` : '';
                        process.stderr.write(
                            `[agent-dispatch] agent=${agent} session=${session.id} compact: ${label}${suffix}\n`,
                        );
                    } catch { /* best-effort compact visibility */ }
                },
            });
            process.stderr.write(`[agent-dispatch] agent=${agent} session=${session.id} elapsed=${Date.now() - _agentDispatchT0}ms\n`);
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
            const partial = watchdogPartialHandoffFromError(err, getSession(session.id), _handoffMsgStart);
            if (partial) {
                terminalStatus = 'idle';
                try { closeSession(session.id, 'ephemeral-done'); } catch { /* ignore */ }
                if (opts.brief === false) return partial;
                return applyBriefCap(partial);
            }
            terminalStatus = 'error';
            try { closeSession(session.id, 'ephemeral-error'); } catch { /* ignore */ }
            throw err;
        } finally {
            _abortLink.dispose();
            if (_idleTimer) {
                try { clearInterval(_idleTimer); } catch { /* ignore */ }
            }
            // Always flip out of 'running' before returning so the sweep never
            // leaves a stateless Pool C session stuck in 'running' when the
            // try/catch falls through in unexpected ways.
            try { await updateSessionStatus(session.id, terminalStatus); } catch { /* ignore */ }
        }
        });
        } finally {
            await lease.release();
            admissionAbortLink.dispose();
        }
    };
}
