import assert from 'node:assert/strict';
import test from 'node:test';

import {
    rememberCompactTelemetry,
    resolveWorkerCompactPolicy,
} from './loop/compact-policy.mjs';

test('Cursor main sessions preserve the configured 200k compact boundary', () => {
    const session = {
        provider: 'cursor-oauth',
        model: 'gemini-3.7-flash',
        contextWindow: 200_000,
        compactBoundaryTokens: 200_000,
        compaction: { auto: true },
    };

    const policy = resolveWorkerCompactPolicy(session, []);
    assert.equal(policy.boundaryTokens, 200_000);
    assert.equal(policy.triggerTokens, 200_000);
    assert.equal(policy.bufferTokens, 0);
});

test('successful compaction publishes post-compact pressure and invalidates the old baseline', () => {
    const session = {
        provider: 'cursor-oauth',
        model: 'gemini-3.7-flash',
        contextWindow: 200_000,
        compactBoundaryTokens: 200_000,
        contextPressureBaselineTokens: 225_000,
        contextPressureBaselineUpdatedAt: Date.now(),
        lastContextTokensStaleAfterCompact: false,
        compaction: { auto: true },
    };
    const policy = resolveWorkerCompactPolicy(session, []);

    rememberCompactTelemetry(session, policy, {
        stage: 'pre_send',
        beforeTokens: 225_000,
        afterTokens: 20_000,
        pressureTokens: 225_000,
        compactChanged: true,
    });

    assert.equal(session.compaction.currentEstimatedTokens, 20_000);
    assert.equal(session.contextPressureBaselineTokens, null);
    assert.equal(session.lastContextTokensStaleAfterCompact, true);
});
