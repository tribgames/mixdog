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

const WATCHDOG_ABORT_RE = /^agent (?:first response stale|task stale|tool running stale)\s*\(/;

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

export function isAgentProgressWatchdogAbortError(err) {
    const msg = err?.message;
    return typeof msg === 'string' && WATCHDOG_ABORT_RE.test(msg);
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

export function collectSessionAssistantHandoffText(session, messageStartIndex = 0) {
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

export function recordAgentWatchdogAbort({
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

export const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = envTimeoutMs(
    'MIXDOG_AGENT_FIRST_RESPONSE_TIMEOUT_MS',
    120_000,
);
export const DEFAULT_STALE_TIMEOUT_MS = envTimeoutMs(
    'MIXDOG_AGENT_STALE_TIMEOUT_MS',
    30 * 60_000,
);

function resolveExplicitMs(value, fallback) {
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    return fallback;
}

export function resolveAgentWatchdogPolicy(agent, overrides = {}) {
    const firstResponseMs = resolveExplicitMs(
        overrides.firstResponseTimeoutMs,
        DEFAULT_FIRST_RESPONSE_TIMEOUT_MS,
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
        firstResponseMs,
        idleStaleMs,
        toolRunningMs,
    };
}

export function evaluateAgentWatchdogAbort(snapshot, now, policy) {
    if (!snapshot || !policy) return null;

    if (snapshot.waitingForFirstActivity) {
        const startedAt = snapshot.modelRequestStartedAt || snapshot.askStartedAt;
        if (policy.firstResponseMs > 0 && startedAt && now - startedAt > policy.firstResponseMs) {
            return new AgentStallAbortError(`agent first response stale (${policy.firstResponseMs}ms)`);
        }
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
        return new AgentStallAbortError(`agent tool running stale (${policy.toolRunningMs}ms)`);
    }

    return null;
}

export function agentWatchdogPolicyActive(policy) {
    if (!policy) return false;
    return (policy.firstResponseMs > 0)
        || (policy.idleStaleMs > 0)
        || (policy.toolRunningMs > 0);
}
