import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMessagesTokens } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import {
    compactionTelemetryPressureTokens,
    recordProviderContextBaseline,
    rememberCompactTelemetry,
    resolveWorkerCompactPolicy,
    shouldCompactForSession,
} from '../src/runtime/agent/orchestrator/session/loop/compact-policy.mjs';

function policyFor(session) {
    return resolveWorkerCompactPolicy(session, []);
}

test('Lead/main auto-compaction triggers at 95% of the effective boundary', () => {
    const leadPolicy = policyFor({ contextWindow: 100_000, compaction: {} });
    assert.equal(leadPolicy.triggerTokens, 95_000);
    assert.equal(leadPolicy.bufferTokens, 5_000);

    const noReserve = { ...leadPolicy, reserveTokens: 0 };
    assert.equal(shouldCompactForSession(94_999, noReserve), false);
    assert.equal(shouldCompactForSession(95_000, noReserve), true);

    const agentPolicy = policyFor({ owner: 'agent', contextWindow: 100_000, compaction: {} });
    assert.equal(agentPolicy.triggerTokens, 90_000, 'agent default 10% headroom must remain unchanged');
});

test('provider callback usage counts assistant output once and estimates only later tool results', () => {
    const session = { provider: 'anthropic', contextWindow: 100_000, compaction: {} };
    const policy = { ...policyFor(session), reserveTokens: 0 };
    const messages = [{ role: 'user', content: 'production-shaped tool request' }];
    const onProviderUsage = d => recordProviderContextBaseline(session, messages, {
        inputTokens: d.deltaInput,
        outputTokens: d.deltaOutput,
        promptTokens: d.deltaPrompt,
        cachedTokens: d.deltaCachedRead,
        cacheWriteTokens: d.deltaCacheWrite,
    }, { boundary: 'request' });
    assert.equal(onProviderUsage({
        source: 'provider_send',
        deltaInput: 5_000,
        deltaOutput: 800,
        deltaPrompt: 0,
        deltaCachedRead: 88_000,
        deltaCacheWrite: 1_000,
    }), true);
    messages.push({
        role: 'assistant',
        content: 'Calling the requested tool.',
        reasoningItems: [{ type: 'reasoning', encrypted_content: 'opaque-provider-reasoning' }],
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"large.txt"}' }],
    });
    const laterToolResult = { role: 'tool', toolCallId: 'call_1', content: 'x'.repeat(4_000) };
    messages.push(laterToolResult);

    const wholeEstimate = estimateMessagesTokens(messages);
    assert.ok(wholeEstimate < policy.triggerTokens, 'fixture must reproduce local estimator undercount');
    const pressure = compactionTelemetryPressureTokens(wholeEstimate, policy, { messages, sessionRef: session });
    const expectedPressure = 94_800 + estimateMessagesTokens([laterToolResult]);
    assert.equal(pressure, expectedPressure, 'assistant output/reasoning must stay in actual usage, not be estimated again');
    assert.ok(pressure >= 95_000, `actual usage plus later tool growth should cross trigger, got ${pressure}`);
    assert.equal(shouldCompactForSession(wholeEstimate, policy, {
        messages,
        sessionRef: session,
        pressureTokens: pressure,
    }), true);
});

test('thinking-only continuation without assistant replay excludes provider output and estimates the nudge', () => {
    const session = { provider: 'anthropic', contextWindow: 100_000, compaction: {} };
    const policy = { ...policyFor(session), reserveTokens: 0 };
    const messages = [{ role: 'user', content: 'request that returns thinking but no replayable assistant message' }];
    recordProviderContextBaseline(session, messages, {
        inputTokens: 5_000,
        outputTokens: 2_000,
        cachedTokens: 88_000,
        cacheWriteTokens: 1_000,
    }, { boundary: 'request' });
    const nudge = {
        role: 'user',
        content: '[mixdog-runtime] Previous response was empty. Continue with a final answer or tool call.',
    };
    messages.push(nudge);

    const wholeEstimate = estimateMessagesTokens(messages);
    const pressure = compactionTelemetryPressureTokens(wholeEstimate, policy, { messages, sessionRef: session });
    const expectedPressure = 94_000 + estimateMessagesTokens([nudge]);
    assert.equal(pressure, expectedPressure, 'unreplayed output must be removed while the later nudge is estimated');
    assert.equal(shouldCompactForSession(wholeEstimate, policy, {
        messages,
        sessionRef: session,
        pressureTokens: pressure,
    }), false, 'unreplayed thinking output must not cause an early compact');
});

test('successful compact invalidates stale usage and cannot immediately compact again', () => {
    const session = { provider: 'openai', contextWindow: 100_000, compaction: {} };
    const policy = { ...policyFor(session), reserveTokens: 0 };
    const before = [{ role: 'user', content: 'old context' }];
    recordProviderContextBaseline(session, before, { inputTokens: 99_000, outputTokens: 500 });
    assert.equal(shouldCompactForSession(estimateMessagesTokens(before), policy, {
        messages: before,
        sessionRef: session,
    }), true);

    rememberCompactTelemetry(session, policy, {
        compactChanged: true,
        beforeTokens: 99_500,
        afterTokens: 20,
        pressureTokens: 99_500,
    });
    const compacted = [{ role: 'user', content: 'short summary' }];
    const compactedEstimate = estimateMessagesTokens(compacted);
    assert.equal(session.contextPressureBaselineTokens, null);
    assert.equal(session.lastContextTokensStaleAfterCompact, true);
    assert.equal(shouldCompactForSession(compactedEstimate, policy, {
        messages: compacted,
        sessionRef: session,
    }), false, 'stale pre-compact usage must not trigger a consecutive compact');

    recordProviderContextBaseline(session, compacted, { inputTokens: 10_000, outputTokens: 100 });
    assert.equal(session.lastContextTokensStaleAfterCompact, false);
    assert.equal(shouldCompactForSession(compactedEstimate, policy, {
        messages: compacted,
        sessionRef: session,
    }), false, 'fresh post-compact usage may be reused safely');
});
