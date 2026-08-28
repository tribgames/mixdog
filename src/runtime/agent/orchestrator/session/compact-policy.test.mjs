import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compactionTelemetryPressureTokens,
    currentContextEstimateTokens,
    recordProviderContextBaseline,
    rememberCompactTelemetry,
    resolveCompactionPressureTokens,
    resolveContextTokens,
    resolveGaugeContextTokens,
    resolveWorkerCompactPolicy,
    shouldCompactForSession,
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
        contextPressureBaselineRequestReserveTokens: 800,
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
    assert.equal(session.contextPressureBaselineRequestReserveTokens, null);
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
    assert.equal(
        resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef: session }),
        gauged,
    );
    assert.equal(
        shouldCompactForSession(messageTokensEst, policy, { messages, sessionRef: session }),
        false,
    );
    assert.ok(gauged > currentContextEstimateTokens(messageTokensEst, policy) * 10);
});

test('provider baseline plus trailing growth is the only display and compaction value', () => {
    const prefix = [
        { role: 'user', content: 'large provider-aligned prefix '.repeat(5_000) },
    ];
    const trailing = { role: 'user', content: 'new trailing message' };
    const messages = [...prefix, trailing];
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
    const providerTokens = 1_000;
    Object.assign(session, {
        contextPressureBaselineTokens: providerTokens,
        contextPressureBaselineOutputTokens: 0,
        contextPressureBaselineMessageCount: prefix.length,
        contextPressureBaselinePrefixSignature: contextMessagesSignature(messages, prefix.length),
        contextPressureBaselineProvider: session.provider,
        contextPressureBaselineModel: session.model,
        contextPressureBaselineToolSignature: policy.toolSchemaSignature,
        contextPressureBaselineBoundary: 'complete',
        contextPressureBaselineUpdatedAt: Date.now(),
        lastContextTokensStaleAfterCompact: false,
    });

    const expected = providerTokens + Math.round(
        estimateMessagesTokens([trailing]) * policy.tokenCalibration,
    );
    const contextTokens = resolveContextTokens(messageTokensEst, policy, { messages, sessionRef: session });
    assert.equal(contextTokens, expected);
    assert.equal(
        resolveGaugeContextTokens(messageTokensEst, policy, { messages, sessionRef: session }),
        contextTokens,
    );
    assert.equal(
        resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef: session }),
        contextTokens,
    );
    assert.ok(currentContextEstimateTokens(messageTokensEst, policy) > contextTokens * 2);

    const decisionPolicy = { ...policy, triggerTokens: contextTokens + 1 };
    assert.equal(
        shouldCompactForSession(messageTokensEst, decisionPolicy, { messages, sessionRef: session }),
        false,
    );
    assert.equal(
        compactionTelemetryPressureTokens(messageTokensEst, decisionPolicy, {
            messages,
            sessionRef: session,
        }),
        contextTokens,
    );
    assert.equal(
        compactionTelemetryPressureTokens(messageTokensEst, decisionPolicy, {
            reactivePending: true,
            messages,
            sessionRef: session,
        }),
        decisionPolicy.triggerTokens,
    );
});

test('a restarted tool surface adjusts only schema reserve instead of discarding provider usage', () => {
    const messages = [{ role: 'user', content: 'durable provider-aligned history' }];
    const previousTools = [
        { name: 'read', description: 'Read files', inputSchema: { type: 'object' } },
        { name: 'recall', description: 'Recall stored context '.repeat(40), inputSchema: { type: 'object' } },
        { name: 'goal', description: 'Manage the durable checklist '.repeat(40), inputSchema: { type: 'object' } },
    ];
    const restartedTools = [
        { name: 'read', description: 'Read files', inputSchema: { type: 'object' } },
    ];
    const session = {
        provider: 'openai-oauth',
        model: 'gpt-5.6-sol',
        contextWindow: 272_000,
        compactBoundaryTokens: 272_000,
        compaction: { auto: true },
        tools: previousTools,
    };
    assert.equal(recordProviderContextBaseline(
        session,
        messages,
        { promptTokens: 75_000, outputTokens: 0 },
        { sendTools: previousTools },
    ), true);

    const policy = resolveWorkerCompactPolicy(session, restartedTools);
    const wholeTranscriptEstimate = 302_000;
    const currentReserve = Math.round(policy.requestReserveTokens * policy.tokenCalibration);
    const expected = 75_000 - session.contextPressureBaselineRequestReserveTokens + currentReserve;
    assert.notEqual(session.contextPressureBaselineToolSignature, policy.toolSchemaSignature);
    assert.ok(currentContextEstimateTokens(wholeTranscriptEstimate, policy) > policy.triggerTokens);
    assert.equal(
        resolveCompactionPressureTokens(wholeTranscriptEstimate, policy, {
            messages,
            sessionRef: session,
        }),
        expected,
    );
    assert.equal(
        shouldCompactForSession(wholeTranscriptEstimate, policy, {
            messages,
            sessionRef: session,
        }),
        false,
    );

    delete session.contextPressureBaselineRequestReserveTokens;
    assert.equal(
        resolveCompactionPressureTokens(wholeTranscriptEstimate, policy, {
            messages,
            sessionRef: session,
        }),
        75_000 + currentReserve,
    );

    session.contextPressureBaselineModel = 'different-model';
    assert.equal(
        resolveCompactionPressureTokens(wholeTranscriptEstimate, policy, {
            messages,
            sessionRef: session,
        }),
        currentContextEstimateTokens(wholeTranscriptEstimate, policy),
    );
});
