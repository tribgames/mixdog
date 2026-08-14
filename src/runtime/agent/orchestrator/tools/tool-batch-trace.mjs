import { traceAgentBatch } from '../agent-trace.mjs';

export function recordToolBatch(sessionId, toolCallCount) {
    const n = Number(toolCallCount);
    if (!sessionId || !Number.isFinite(n) || n <= 0) return;
    try { traceAgentBatch({ sessionId, toolCallCount: n }); } catch { /* trace best-effort */ }
}
