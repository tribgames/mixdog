import assert from 'node:assert/strict';
import test from 'node:test';

import {
    currentContextEstimateTokens,
    rememberCompactTelemetry,
    resolveGaugeContextTokens,
    resolveWorkerCompactPolicy,
} from './loop/compact-policy.mjs';
import { contextMessagesSignature, estimateMessagesTokens } from './context-utils.mjs';

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

// Reported compaction numbers must share ONE scale with the context gauge
// (user: 게이지는 499k인데 압축 알림은 131k→23k). The pre-compact side follows
// the provider-billed prompt; the post-compact side is the same calibrated
// estimate the gauge falls back to once compaction drops the baseline.
test('gauge and post-compact estimate are one scale', () => {
    const messages = [
        { role: 'user', content: 'hello world '.repeat(200) },
        { role: 'assistant', content: 'reply text '.repeat(200) },
    ];
    const session = {
        provider: 'anthropic-oauth',
        model: 'claude-opus-5',
        contextWindow: 500_000,
        compactBoundaryTokens: 500_000,
        compaction: { auto: true },
        tools: [],
    };
    const policy = resolveWorkerCompactPolicy(session, []);
    const messageTokensEst = estimateMessagesTokens(messages);

    // No baseline: both ends resolve through the identical calibrated formula.
    assert.equal(
        resolveGaugeContextTokens(messageTokensEst, policy, { messages, sessionRef: session }),
        currentContextEstimateTokens(messageTokensEst, policy),
    );

    // Live baseline: the reported "before" follows the provider-billed prompt
    // instead of the much smaller raw transcript estimate.
    Object.assign(session, {
        contextPressureBaselineTokens: 499_000,
        contextPressureBaselineOutputTokens: 0,
        contextPressureBaselineMessageCount: messages.length,
        contextPressureBaselinePrefixSignature: contextMessagesSignature(messages),
        contextPressureBaselineProvider: session.provider,
        contextPressureBaselineModel: session.model,
        contextPressureBaselineToolSignature: policy.toolSchemaSignature,
        contextPressureBaselineBoundary: 'complete',
        contextPressureBaselineUpdatedAt: Date.now(),
        lastContextTokensStaleAfterCompact: false,
    });

    const gauged = resolveGaugeContextTokens(messageTokensEst, policy, { messages, sessionRef: session });
    assert.equal(gauged, 499_000);
    assert.ok(gauged > currentContextEstimateTokens(messageTokensEst, policy) * 10);
});
