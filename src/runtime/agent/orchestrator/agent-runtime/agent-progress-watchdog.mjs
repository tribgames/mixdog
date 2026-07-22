/**
 * Unified agent progress / stale watchdog policy for agent-tool spawns and
 * agent-dispatch internal roles. Activity heartbeats (session manager) refresh
 * lastProgressAt during long tool work; this module decides when to abort.
 */

import { appendAgentTrace } from '../agent-trace-io.mjs';
import { getHiddenAgent } from '../internal-agents.mjs';
import {
    resolveAgentStallThresholds,
    resolveAgentToolThresholdSeconds,
} from '../stall-policy.mjs';

const WATCHDOG_ABORT_RE = /^agent (?:first (?:transport|semantic response|response) stale|task stale|tool running stale)\s*\(/;

/**
 * Typed abort error for the agent progress watchdog. Carrying a stable `name`
 * lets the retry-classifier and the WS/SSE abort handlers distinguish a
 * watchdog stall from a user cancel: it is classified as `agent_stall` (a
 * retryable stream failure), NOT a user abort (null classification). The abort
 * signal reason surfaces as this error's `name`, so both the classifier's
 * `err.name` check and the provider abort handlers' `reason.name` check match.
 */
export class AgentStallAbortError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AgentStallAbortError';
    }
}

function isAgentProgressWatchdogAbortError(err) {
    const msg = err?.message;
    return typeof msg === 'string' && WATCHDOG_ABORT_RE.test(msg);
}

// Tools that enforce their own execution deadline: 'shell' kills the process
// at its configured timeout; 'task' wait is bounded by its own wait budget.
// These are NOT blanket-exempted from the tool-running watchdog — if their own
// deadline timer dies the session would otherwise hang forever. Instead the
// watchdog raises the tool-running ceiling to their self-deadline + a grace
// window (below), so normal long runs are allowed but a dead timer is still
// caught. Unknown/missing self-deadline falls back to the plain toolRunningMs.
const SELF_DEADLINE_TOOLS = new Set(['shell', 'task']);
// Grace added on top of a tool's own deadline before the watchdog steps in, so
// the tool's in-process kill always fires first under normal operation.
const TOOL_SELF_DEADLINE_GRACE_MS = 60_000;
// Fallback deadlines matching the tool implementations (bash-tool.mjs default
// 120s foreground timeout; task/shell-job wait default 30s budget).
const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
const TASK_DEFAULT_WAIT_MS = 30_000;

function bareToolName(toolName) {
    if (typeof toolName !== 'string' || !toolName) return '';
    // Strip any MCP/server prefix (e.g. 'server__shell' or 'server.shell').
    return toolName.split(/[.]|__/).pop();
}

function isSelfDeadlineTool(toolName) {
    const bare = bareToolName(toolName);
    return SELF_DEADLINE_TOOLS.has(bare) || SELF_DEADLINE_TOOLS.has(toolName);
}

/**
 * Resolve the self-enforced deadline (ms) for a tool call from its arguments,
 * recorded into the progress snapshot at dispatch time. Returns a positive
 * number when the tool enforces its own deadline, or null when unknown/missing
 * (caller then falls back to the plain toolRunningMs ceiling).
 *   - shell: explicit `timeout` (ms) if positive, else the 120s default.
 *   - task:  explicit `timeout_ms` if positive, else 30s for the `wait` action
 *            (other actions carry no wait budget -> null).
 */
export function resolveToolSelfDeadlineMs(toolName, args) {
    if (!isSelfDeadlineTool(toolName)) return null;
    const bare = bareToolName(toolName);
    const a = (args && typeof args === 'object') ? args : {};
    if (bare === 'shell') {
        const t = Number(a.timeout);
        if (Number.isFinite(t) && t > 0) return t;
        const envDefault = parseInt(process.env.BASH_DEFAULT_TIMEOUT_MS ?? '', 10);
        return envDefault > 0 ? envDefault : SHELL_DEFAULT_TIMEOUT_MS;
    }
    if (bare === 'task') {
        const t = Number(a.timeout_ms);
        if (Number.isFinite(t) && t > 0) return t;
        const action = typeof a.action === 'string' ? a.action : '';
        if (action === 'wait') return TASK_DEFAULT_WAIT_MS;
        return null;
    }
    return null;
}

function assistantMessageText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((b) => b && (b.type === 'text' || b.type === 'output_text'))
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
        .join('\n');
}

/** Message index at askSession start — salvage only assistant rows appended this run. */
export function resolveHandoffMessageStartIndex(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    return messages.length;
}

function collectSessionAssistantHandoffText(session, messageStartIndex = 0) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const start = Math.max(0, Math.floor(Number(messageStartIndex) || 0));
    const parts = [];
    for (let i = start; i < messages.length; i += 1) {
        const m = messages[i];
        if (m?.role !== 'assistant') continue;
        const t = assistantMessageText(m.content).trim();
        if (t && t !== '.') parts.push(t);
    }
    return parts.length ? parts.join('\n\n') : '';
}

export function watchdogPartialHandoffFromError(error, session, messageStartIndex = 0) {
    if (!isAgentProgressWatchdogAbortError(error)) return null;
    const text = collectSessionAssistantHandoffText(session, messageStartIndex);
    return text.trim() ? text : null;
}

function resolveWatchdogAbortElapsedMs({ error, snapshot, policy, now, anchorTs, lastProgressAt }) {
    if (snapshot && policy) {
        if (snapshot.waitingForFirstActivity) {
            const startedAt = snapshot.modelRequestStartedAt || snapshot.askStartedAt;
            if (startedAt) return Math.max(0, now - startedAt);
        }
        if (snapshot.stage === 'tool_running' && snapshot.toolStartedAt
            && typeof error?.message === 'string' && error.message.includes('tool running stale')) {
            return Math.max(0, now - snapshot.toolStartedAt);
        }
        const last = snapshot.lastProgressAt || snapshot.firstActivityAt;
        if (last) return Math.max(0, now - last);
    }
    const last = lastProgressAt || anchorTs;
    if (last) return Math.max(0, now - last);
    return null;
}

function recordAgentWatchdogAbort({
    sessionId,
    agent = null,
    error,
    snapshot = null,
    policy = null,
    now = Date.now(),
    anchorTs = 0,
    lastProgressAt = 0,
    iteration = null,
}) {
    if (!sessionId || !error) return;
    const elapsed = resolveWatchdogAbortElapsedMs({
        error,
        snapshot,
        policy,
        now,
        anchorTs,
        lastProgressAt,
    });
    try {
        appendAgentTrace({
            sessionId,
            iteration: iteration ?? null,
            kind: 'stall_abort',
            agent: agent || null,
            payload: {
                elapsed_ms: elapsed,
                message: typeof error.message === 'string' ? error.message : String(error),
                stage: snapshot?.stage ?? null,
            },
        });
    } catch { /* best-effort */ }
}

export function abortAgentProgressWatchdog(controller, ctx) {
    if (!controller || !ctx?.error) return;
    if (controller.signal?.aborted) return;
    recordAgentWatchdogAbort(ctx);
    try { controller.abort(ctx.error); } catch { /* ignore */ }
}

function envTimeoutMs(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = envTimeoutMs(
    'MIXDOG_AGENT_FIRST_RESPONSE_TIMEOUT_MS',
    120_000,
);
const DEFAULT_FIRST_VISIBLE_CEILING_MS = envTimeoutMs(
    'MIXDOG_AGENT_FIRST_VISIBLE_TIMEOUT_MS',
    600_000,
);
const DEFAULT_STALE_TIMEOUT_MS = envTimeoutMs(
    'MIXDOG_AGENT_STALE_TIMEOUT_MS',
    30 * 60_000,
);

function resolveExplicitMs(value, fallback) {
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    return fallback;
}

export function resolveAgentWatchdogPolicy(agent, overrides = {}) {
    const firstTransportMs = resolveExplicitMs(
        overrides.firstTransportTimeoutMs ?? overrides.firstResponseTimeoutMs,
        DEFAULT_FIRST_RESPONSE_TIMEOUT_MS,
    );
    const firstSemanticMs = resolveExplicitMs(
        overrides.firstSemanticTimeoutMs ?? overrides.firstVisibleTimeoutMs,
        DEFAULT_FIRST_VISIBLE_CEILING_MS,
    );

    let idleStaleMs;
    if (Number.isFinite(overrides.idleTimeoutMs) && overrides.idleTimeoutMs >= 0) {
        idleStaleMs = Math.floor(overrides.idleTimeoutMs);
    } else if (getHiddenAgent(agent)) {
        const { abort } = resolveAgentStallThresholds(agent);
        idleStaleMs = abort * 1000;
    } else {
        // Part B: the primary mid-stream stall catch is now the provider-level
        // SEMANTIC idle abort (~120s, ping-immune). This public-agent idle is a
        // BACKSTOP only, so it must not exceed the stall abort (600s default) —
        // the old 30-min value meant a ping-only wedge that slipped past the
        // provider layer would still hang the owner for half an hour. Cap it at
        // the stall abort while keeping 30 min as an absolute ceiling. The
        // tool-running heartbeat exemption (toolRunningMs, below) is unchanged,
        // so legitimately long tool calls still refresh progress and are safe.
        const { abort } = resolveAgentStallThresholds(agent);
        const backstopMs = Math.max(0, Math.floor(abort * 1000));
        idleStaleMs = backstopMs > 0
            ? Math.min(DEFAULT_STALE_TIMEOUT_MS, backstopMs)
            : DEFAULT_STALE_TIMEOUT_MS;
    }

    const idleSec = idleStaleMs / 1000;
    const toolRunningSec = resolveAgentToolThresholdSeconds(agent, idleSec);
    const toolRunningMs = Math.max(0, Math.floor(toolRunningSec * 1000));

    return {
        firstTransportMs,
        firstSemanticMs,
        // Compatibility aliases for persisted/background metadata and callers
        // using the previous option names.
        firstResponseMs: firstTransportMs,
        firstVisibleCeilingMs: firstSemanticMs,
        idleStaleMs,
        toolRunningMs,
    };
}

export function evaluateAgentWatchdogAbort(snapshot, now, policy) {
    if (!snapshot || !policy) return null;

    const startedAt = snapshot.modelRequestStartedAt || 0;
    // stage=connecting with no request timestamp means the provider request is
    // still in the admission queue. Queue wait is outside every watchdog.
    if (!startedAt && snapshot.stage === 'connecting') return null;
    const firstTransportMs = policy.firstTransportMs ?? policy.firstResponseMs ?? 0;
    const firstSemanticMs = policy.firstSemanticMs ?? policy.firstVisibleCeilingMs ?? 0;
    // Independent fixed deadlines from request start. Transport can satisfy
    // only the transport deadline; it never switches, extends, or resets the
    // semantic-response deadline.
    if (snapshot.waitingForTransport && firstTransportMs > 0 && startedAt
        && now - startedAt > firstTransportMs) {
        return new AgentStallAbortError(`agent first transport stale (${firstTransportMs}ms)`);
    }
    if ((snapshot.waitingForFirstSemantic ?? snapshot.waitingForFirstActivity)
        && firstSemanticMs > 0 && startedAt && now - startedAt > firstSemanticMs) {
        return new AgentStallAbortError(`agent first semantic response stale (${firstSemanticMs}ms)`);
    }
    if (snapshot.waitingForFirstSemantic ?? snapshot.waitingForFirstActivity) {
        return null;
    }

    const last = snapshot.lastProgressAt || snapshot.firstActivityAt;
    if (policy.idleStaleMs > 0 && last && now - last > policy.idleStaleMs) {
        return new AgentStallAbortError(`agent task stale (${policy.idleStaleMs}ms without stream/tool progress)`);
    }

    if (
        snapshot.stage === 'tool_running'
        && snapshot.toolStartedAt
        && policy.toolRunningMs > 0
        && now - snapshot.toolStartedAt > policy.toolRunningMs
    ) {
        // Deadline-aware ceiling for tools that self-enforce their own deadline
        // ('shell'/'task'). Rather than a blanket exemption (which would hang
        // forever if the tool's own timer died), raise the tool-running ceiling
        // to max(toolRunningMs, selfDeadlineMs + grace): normal long runs are
        // allowed because the tool kills itself first, but a dead deadline timer
        // is still caught after the grace window. Unknown/missing self-deadline
        // (selfDeadlineMs <= 0) keeps the plain toolRunningMs behavior. All
        // other tools are unaffected.
        const ceilingMs = resolveEffectiveToolRunningCeilingMs(snapshot, policy);
        if (now - snapshot.toolStartedAt > ceilingMs) {
            return new AgentStallAbortError(`agent tool running stale (${ceilingMs}ms)`);
        }
    }

    return null;
}

/** The exact tool ceiling enforced by evaluateAgentWatchdogAbort. */
export function resolveEffectiveToolRunningCeilingMs(snapshot, policy) {
    const policyMs = Number(policy?.toolRunningMs);
    let ceilingMs = Number.isFinite(policyMs) && policyMs > 0 ? policyMs : 0;
    const selfDeadlineMs = Number(snapshot?.toolSelfDeadlineMs);
    if (
        isSelfDeadlineTool(snapshot?.currentTool)
        && Number.isFinite(selfDeadlineMs)
        && selfDeadlineMs > 0
    ) {
        ceilingMs = Math.max(ceilingMs, selfDeadlineMs + TOOL_SELF_DEADLINE_GRACE_MS);
    }
    return ceilingMs;
}

export function agentWatchdogPolicyActive(policy) {
    if (!policy) return false;
    return ((policy.firstTransportMs ?? policy.firstResponseMs) > 0)
        || ((policy.firstSemanticMs ?? policy.firstVisibleCeilingMs) > 0)
        || (policy.idleStaleMs > 0)
        || (policy.toolRunningMs > 0);
}
