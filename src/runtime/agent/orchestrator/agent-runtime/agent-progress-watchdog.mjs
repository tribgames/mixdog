/**
 * Unified agent progress / stale watchdog policy for agent-tool spawns and
 * agent-dispatch internal roles. Activity heartbeats (session manager) refresh
 * lastProgressAt during long tool work; this module decides when to abort.
 */

import { getHiddenAgent } from '../internal-agents.mjs';
import {
    resolveAgentStallThresholds,
    resolveAgentToolThresholdSeconds,
} from '../stall-policy.mjs';

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
        idleStaleMs = DEFAULT_STALE_TIMEOUT_MS;
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
            return new Error(`agent first response stale (${policy.firstResponseMs}ms)`);
        }
        return null;
    }

    const last = snapshot.lastProgressAt || snapshot.firstActivityAt;
    if (policy.idleStaleMs > 0 && last && now - last > policy.idleStaleMs) {
        return new Error(`agent task stale (${policy.idleStaleMs}ms without stream/tool progress)`);
    }

    if (
        snapshot.stage === 'tool_running'
        && snapshot.toolStartedAt
        && policy.toolRunningMs > 0
        && now - snapshot.toolStartedAt > policy.toolRunningMs
    ) {
        return new Error(`agent tool running stale (${policy.toolRunningMs}ms)`);
    }

    return null;
}

export function agentWatchdogPolicyActive(policy) {
    if (!policy) return false;
    return (policy.firstResponseMs > 0)
        || (policy.idleStaleMs > 0)
        || (policy.toolRunningMs > 0);
}
