import { traceTurnTiming } from '../../../runtime/agent/orchestrator/agent-trace.mjs';

// TTFT telemetry for one turn: emitted once (first visible progress or
// settlement), to the in-process event and the durable trace row.
export function createTurnTimingFactory({ getSession, awaitInitialMcpConnect, mcpTurnGraceMs }) {
  return function createTurnTiming(options) {
    const startedAt = performance.now();
    const startedAtEpoch = Date.now();
    const submittedAt = Number(options.submittedAt);
    const hasSubmittedAt = Number.isFinite(submittedAt) && submittedAt > 0;
    const timing = { routeWaitMs: 0, mcpWaitMs: 0, providerStartedAt: 0, status: 'error', emitted: false };
    timing.emit = (status, snapshotSessionId) => {
      if (timing.emitted) return;
      timing.emitted = true;
      const now = performance.now();
      const row = {
        status,
        sessionId: String(getSession()?.id || snapshotSessionId || ''),
        requestId: String(options.id || ''),
        ttftMs: now - startedAt,
        endToEndTtftMs: hasSubmittedAt ? Math.max(0, Date.now() - submittedAt) : null,
        queueMs: hasSubmittedAt ? Math.max(0, startedAtEpoch - submittedAt) : null,
        routeMs: timing.routeWaitMs,
        preflightMs: (timing.providerStartedAt || now) - startedAt,
        mcpMs: timing.mcpWaitMs,
        providerMs: timing.providerStartedAt ? now - timing.providerStartedAt : null,
      };
      try {
        process.emit('mixdog:turn-timing', row);
      } catch {
        /* timing telemetry must never affect a turn */
      }
      // Durable sink: the process event only reaches an in-process listener
      // (the daemon log). The trace row is what session-bench aggregates.
      try {
        traceTurnTiming(row);
      } catch {
        /* timing telemetry must never affect a turn */
      }
    };
    // Give an in-flight MCP connect only a short TTFT grace.
    timing.awaitMcpGrace = async () => {
      const graceStartedAt = performance.now();
      try {
        await awaitInitialMcpConnect?.(mcpTurnGraceMs);
      } finally {
        timing.mcpWaitMs += performance.now() - graceStartedAt;
      }
    };
    return timing;
  };
}
