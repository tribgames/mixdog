#!/usr/bin/env node
import {
    bumpUsageMetricsEpoch,
    bumpUsageMetricsTurnId,
    resolveUsageMetricsEpoch,
    usageMetricsIdempotencyKey,
    applyAskTerminalUsageTotals,
} from '../src/runtime/agent/orchestrator/session/manager.mjs';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function applyDelta(sessionId, session, delta, seen) {
    const epoch = resolveUsageMetricsEpoch(session, delta);
    session.usageMetricsEpoch = epoch;
    const ikey = usageMetricsIdempotencyKey(sessionId, session, delta);
    const isReplay = seen.has(ikey);
    seen.add(ikey);
    if (!isReplay) {
        session.totalInputTokens = (session.totalInputTokens || 0) + (delta.deltaInput || 0);
    }
    session.lastIterationIndex = delta.iterationIndex;
    return isReplay;
}

const sessionId = 'smoke-sess';
const session = { usageMetricsEpoch: 0, lastIterationIndex: null, totalInputTokens: 0 };
const seen = new Set();

assert(
    applyDelta(sessionId, session, { iterationIndex: 1, deltaInput: 100 }, seen) === false,
    'first iteration should count',
);
assert(session.totalInputTokens === 100, 'first iteration tokens');

bumpUsageMetricsEpoch(session);
assert(session.usageMetricsEpoch === 1, 'compact reset should bump epoch');

const replay = applyDelta(sessionId, session, {
    iterationIndex: 1,
    usageMetricsEpoch: session.usageMetricsEpoch,
    deltaInput: 50,
}, seen);
assert(replay === false, 'equal index after compact reset must not be treated as replay');
assert(session.totalInputTokens === 150, 'post-compact iteration must add tokens');

assert(
    applyDelta(sessionId, session, {
        iterationIndex: 1,
        usageMetricsEpoch: 1,
        deltaInput: 999,
    }, seen) === true,
    'retry of same epoch+index should replay',
);
assert(session.totalInputTokens === 150, 'replay must not double-count');

// Semantic compact + provider send at same iteration/epoch (no_change compact path)
const collisionSeen = new Set();
const collisionSession = { usageMetricsEpoch: 0, lastIterationIndex: null, totalInputTokens: 0 };
assert(
    applyDelta(sessionId, collisionSession, {
        iterationIndex: 1,
        source: 'semantic_compact',
        deltaInput: 20,
    }, collisionSeen) === false,
    'semantic compact usage should count',
);
assert(
    applyDelta(sessionId, collisionSession, {
        iterationIndex: 1,
        source: 'provider_send',
        deltaInput: 80,
    }, collisionSeen) === false,
    'provider send at same iteration must not replay semantic compact key',
);
assert(collisionSession.totalInputTokens === 100, 'semantic + provider usage both counted');

// Integrated incremental + terminal: totals applied once when incremental flag set
const integrated = { totalInputTokens: 1000, totalOutputTokens: 0, tokensCumulative: 1000 };
integrated.totalInputTokens += 40;
integrated.totalOutputTokens += 6;
integrated.tokensCumulative += 46;
applyAskTerminalUsageTotals(integrated, {
    usage: { inputTokens: 40, outputTokens: 6 },
    lastTurnUsage: { inputTokens: 40, outputTokens: 6 },
}, { skipTotalsIfIncremental: true });
assert(integrated.totalInputTokens === 1040, 'terminal must not double-count incremental turn totals');
assert(integrated.totalOutputTokens === 6, 'terminal must not double-count output');
assert(integrated.lastInputTokens === 40, 'terminal still updates last-turn window snapshot');

// Cross-ask collision (reviewer07): ask #2 reuses iteration indices 1-2
const crossSeen = new Set();
const crossSession = { usageMetricsEpoch: 0, usageMetricsTurnId: 0, lastIterationIndex: null, totalInputTokens: 0 };
bumpUsageMetricsTurnId(crossSession);
assert(crossSession.usageMetricsTurnId === 1, 'ask #1 turn id');
assert(applyDelta(sessionId, crossSession, { iterationIndex: 1, source: 'provider_send', deltaInput: 100 }, crossSeen) === false);
assert(applyDelta(sessionId, crossSession, { iterationIndex: 2, source: 'provider_send', deltaInput: 200 }, crossSeen) === false);
assert(crossSession.totalInputTokens === 300, 'ask #1 iterations counted');
bumpUsageMetricsTurnId(crossSession);
assert(crossSession.usageMetricsTurnId === 2, 'ask #2 turn id');
assert(
    applyDelta(sessionId, crossSession, { iterationIndex: 1, source: 'provider_send', deltaInput: 10 }, crossSeen) === false,
    'ask #2 iteration 1 must not replay ask #1 key',
);
assert(
    applyDelta(sessionId, crossSession, { iterationIndex: 2, source: 'provider_send', deltaInput: 20 }, crossSeen) === false,
    'ask #2 iteration 2 must not replay ask #1 key',
);
assert(applyDelta(sessionId, crossSession, { iterationIndex: 3, source: 'provider_send', deltaInput: 30 }, crossSeen) === false);
assert(crossSession.totalInputTokens === 360, 'ask #2 tokens must include iter 1-3 without undercount');

process.stdout.write('usage-metrics-epoch-smoke: ok\n');

