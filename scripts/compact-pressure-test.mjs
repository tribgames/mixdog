import test from 'node:test';
import assert from 'node:assert/strict';
import {
    estimateMessagesTokens,
    estimateRequestReserveTokens,
    estimateToolSchemaTokens,
    estimateTokens,
    IMAGE_VISUAL_TOKEN_ALLOWANCE,
    summarizeContextMessages,
} from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import { createContextStatus } from '../src/session-runtime/context-status.mjs';
import {
    compactionTelemetryPressureTokens,
    recordProviderContextBaseline,
    resolveCompactionPressureTokens,
    rememberCompactTelemetry,
    compactTargetBudget,
    resolveWorkerCompactPolicy,
    shouldCompactForSession,
} from '../src/runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import { initialCompactionConfig } from '../src/runtime/agent/orchestrator/session/manager/session-lifecycle.mjs';
import { resolveSessionCompactionPolicy } from '../src/runtime/agent/orchestrator/session/manager/compaction-runner.mjs';
import { sendWithRecovery } from '../src/runtime/agent/orchestrator/session/send-with-recovery.mjs';
import { recallFastTrackCompactMessages } from '../src/runtime/agent/orchestrator/session/compact/engine.mjs';

function policyFor(session) {
    return resolveWorkerCompactPolicy(session, []);
}

test('Lead/main auto-compaction uses an independent configurable early buffer', () => {
    const leadPolicy = policyFor({ contextWindow: 100_000, compaction: {} });
    assert.equal(leadPolicy.triggerTokens, 95_000);
    assert.equal(leadPolicy.bufferTokens, 5_000);
    assert.equal(leadPolicy.bufferRatio, 0.05);

    const noReserve = { ...leadPolicy, reserveTokens: 0 };
    assert.equal(shouldCompactForSession(94_999, noReserve), false);
    assert.equal(shouldCompactForSession(95_000, noReserve), true);

    const agentPolicy = policyFor({ owner: 'agent', contextWindow: 100_000, compaction: {} });
    assert.equal(agentPolicy.triggerTokens, 90_000, 'agent default 10% headroom must remain unchanged');
    assert.equal(agentPolicy.bufferTokens, 10_000);
    assert.equal(agentPolicy.bufferRatio, 0.1);

    const configured = policyFor({ contextWindow: 100_000, compaction: { mainBufferPercent: 15 } });
    assert.equal(configured.triggerTokens, 85_000);
    assert.equal(configured.bufferTokens, 15_000);
    assert.equal(configured.bufferRatio, 0.15);

    const oldEnv = {
        tokens: process.env.MIXDOG_MAIN_COMPACT_BUFFER_TOKENS,
        percent: process.env.MIXDOG_MAIN_COMPACT_BUFFER_PERCENT,
        ratio: process.env.MIXDOG_MAIN_COMPACT_BUFFER_RATIO,
    };
    try {
        process.env.MIXDOG_MAIN_COMPACT_BUFFER_PERCENT = '20';
        const envConfigured = policyFor({ contextWindow: 100_000, compaction: {} });
        assert.equal(envConfigured.triggerTokens, 80_000);
        assert.equal(envConfigured.bufferTokens, 20_000);
        assert.equal(envConfigured.bufferRatio, 0.2);

        delete process.env.MIXDOG_MAIN_COMPACT_BUFFER_PERCENT;
        process.env.MIXDOG_MAIN_COMPACT_BUFFER_RATIO = '0.1';
        const envRatioConfigured = policyFor({ contextWindow: 100_000, compaction: {} });
        assert.equal(envRatioConfigured.bufferTokens, 10_000, 'env ratio must configure the main buffer');

        process.env.MIXDOG_MAIN_COMPACT_BUFFER_TOKENS = '10000';
        process.env.MIXDOG_MAIN_COMPACT_BUFFER_RATIO = '0.1';
        const envTokenConfigured = policyFor({ contextWindow: 100_000, compaction: {} });
        assert.equal(envTokenConfigured.bufferTokens, 10_000, 'env tokens must beat env percent/ratio');
        assert.equal(envTokenConfigured.triggerTokens, 90_000);

        const configBeatsEnv = policyFor({
            contextWindow: 100_000,
            compaction: { mainBufferRatio: 0.15 },
        });
        assert.equal(configBeatsEnv.bufferTokens, 15_000, 'config ratio must beat all env units');

        const configTokenWins = policyFor({
            contextWindow: 100_000,
            compaction: { mainBufferTokens: 12_000, mainBufferPercent: 15, mainBufferRatio: 0.1 },
        });
        assert.equal(configTokenWins.bufferTokens, 12_000, 'config tokens must beat config percent/ratio');

        const clamped = policyFor({
            contextWindow: 100_000,
            compaction: { mainBufferPercent: 250, mainBufferRatio: 0.1 },
        });
        assert.equal(clamped.bufferTokens, 25_000, 'buffer percent must cap at the configured 25% maximum');
    } finally {
        for (const [name, value] of Object.entries({
            MIXDOG_MAIN_COMPACT_BUFFER_TOKENS: oldEnv.tokens,
            MIXDOG_MAIN_COMPACT_BUFFER_PERCENT: oldEnv.percent,
            MIXDOG_MAIN_COMPACT_BUFFER_RATIO: oldEnv.ratio,
        })) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('fresh session compaction config preserves main buffer fields', () => {
    const config = initialCompactionConfig({
        mainBufferTokens: 12_000,
        mainBufferPercent: 15,
        mainBufferRatio: 0.2,
        mainBufferFraction: 0.1,
    }, { compactBoundaryTokens: 80_000 });
    assert.equal(config.mainBufferTokens, 12_000);
    assert.equal(config.mainBufferPercent, 15);
    assert.equal(config.mainBufferRatio, 0.2);
    assert.equal(config.mainBufferFraction, 0.1);
    assert.equal(config.boundaryTokens, 80_000);
});

test('small main boundary leaves a margin above the post-compact target', () => {
    const session = {
        contextWindow: 8_000,
        compaction: { reservedTokens: 2_000 },
        tools: [],
        messages: [],
    };
    const policy = policyFor(session);
    const target = compactTargetBudget(policy);
    assert.ok(policy.triggerTokens > target,
        `trigger ${policy.triggerTokens} must exceed post-compact target ${target}`);
    assert.equal(shouldCompactForSession(target - policy.reserveTokens, policy), false,
        'reaching the post-compact target must not immediately re-trigger compaction');
    const { contextStatus } = createContextStatus({
        getSession: () => session,
        getRoute: () => ({ provider: 'openai', model: 'test-model' }),
        getCurrentCwd: () => '',
        getMode: () => 'default',
    });
    const statusCompact = contextStatus().compaction;
    assert.equal(statusCompact.triggerTokens, policy.triggerTokens);
    assert.equal(statusCompact.bufferTokens, policy.bufferTokens);
    assert.equal(statusCompact.bufferRatio, policy.bufferRatio);
    const manualPolicy = resolveSessionCompactionPolicy(session);
    assert.equal(manualPolicy.triggerTokens, policy.triggerTokens);
    assert.equal(compactTargetBudget(manualPolicy), target);
});

test('degenerate main budgets use a documented single-shot fallback', () => {
    const reserveAtTrigger = {
        contextWindow: 100_000,
        // Explicit sub-boundary limit fixes the trigger at 90k while reserve
        // remains below the context boundary.
        autoCompactTokenLimit: 90_000,
        compaction: { reservedTokens: 91_000 },
        tools: [],
    };
    const reserveAtTriggerPolicy = policyFor(reserveAtTrigger);
    assert.equal(reserveAtTriggerPolicy.singleShot, true,
        'reserve at/above the actual trigger must be single-shot even below the boundary');
    assert.equal(compactTargetBudget(reserveAtTriggerPolicy), reserveAtTriggerPolicy.boundaryTokens,
        'automatic single-shot keeps the legacy target budget');
    assert.equal(compactTargetBudget({ ...reserveAtTriggerPolicy, force: true }), reserveAtTriggerPolicy.boundaryTokens,
        'forced manual compaction must retain the viable legacy target budget');

    const overReserved = {
        contextWindow: 8_000,
        compaction: { reservedTokens: 20_000 },
        tools: [],
    };
    const overReservedPolicy = policyFor(overReserved);
    assert.equal(overReservedPolicy.singleShot, true);
    assert.equal(compactTargetBudget(overReservedPolicy), 8_000,
        'reserve at or above the boundary must retain the legacy bounded target');
    assert.equal(shouldCompactForSession(0, overReservedPolicy, { sessionRef: overReserved }), true);
    rememberCompactTelemetry(overReserved, overReservedPolicy, { stage: 'compacting' });
    assert.equal(shouldCompactForSession(0, overReservedPolicy, { sessionRef: overReserved }), false,
        'single-shot fallback must suppress automatic repeats');

    const oneToken = { contextWindow: 1, compaction: {}, tools: [] };
    const oneTokenPolicy = policyFor(oneToken);
    assert.ok(oneTokenPolicy.reserveTokens >= oneTokenPolicy.triggerTokens);
    assert.equal(oneTokenPolicy.singleShot, true,
        'the request reserve, not the one-token boundary itself, makes this degenerate');
    assert.equal(oneTokenPolicy.triggerTokens, 1);
    assert.equal(compactTargetBudget(oneTokenPolicy), 1);

    // The reactive retry is explicitly bounded by send-with-recovery's
    // contextOverflowRetryUsed flag: forceReactive may admit this one retry
    // after the consumed one-shot, but no second retry is scheduled.
    assert.equal(shouldCompactForSession(0, reserveAtTriggerPolicy, {
        sessionRef: { compaction: { singleShotConsumed: true } },
        forceReactive: true,
    }), true, 'the one bounded reactive retry remains available after one-shot consumption');
});

test('a one-shot overflow receives only one reactive compact retry', async () => {
    const overflow = new Error('context length exceeded');
    const ctx = {
        provider: { send: async () => { throw overflow; } },
        messages: [{ role: 'user', content: 'overflowing prompt' }],
        model: 'test-model',
        sendTools: [],
        tools: [],
        opts: {},
        sessionId: 'single-shot-reactive-test',
        sessionRef: {
            contextWindow: 100_000,
            autoCompactTokenLimit: 90_000,
            compaction: { reservedTokens: 91_000 },
        },
        nextIteration: 1,
    };
    assert.deepEqual(await sendWithRecovery({
        ...ctx,
        contextOverflowRetryUsed: false,
    }), { action: 'retry' });
    await assert.rejects(
        sendWithRecovery({ ...ctx, contextOverflowRetryUsed: true }),
        err => err?.code === 'AGENT_CONTEXT_OVERFLOW',
        'a second overflow after the reactive compact must surface instead of retrying again',
    );
});

test('image payload bytes do not inflate live gauge or fallback compaction estimates', () => {
    const text = 'Please describe the attached image.';
    const imageData = 'A'.repeat(400_000);
    const imagePart = { type: 'image', data: imageData, mimeType: 'image/png' };
    const messages = [{
        role: 'user',
        content: [{ type: 'text', text }, imagePart],
    }];
    const plainTextEstimate = estimateTokens(text) + 4;
    const fallbackEstimate = estimateMessagesTokens(messages);
    const summaryEstimate = summarizeContextMessages(messages).estimatedTokens;

    assert.equal(estimateMessagesTokens([{ role: 'user', content: text }]), plainTextEstimate,
        'ordinary string estimates must remain unchanged');
    assert.equal(fallbackEstimate, plainTextEstimate + IMAGE_VISUAL_TOKEN_ALLOWANCE,
        'fallback compaction estimate must count text plus a visual image allowance');
    const largerPayloadEstimate = estimateMessagesTokens([{
        role: 'user',
        content: [{ type: 'text', text }, { ...imagePart, data: imageData.repeat(2) }],
    }]);
    assert.equal(largerPayloadEstimate, fallbackEstimate,
        'raw image byte length must not affect the visual allowance');
    assert.equal(summaryEstimate, fallbackEstimate,
        'display and fallback compaction must share the image-aware message estimate');

    const session = {
        id: 'image-context-test',
        provider: 'openai',
        contextWindow: 100_000,
        rawContextWindow: 100_000,
        compactBoundaryTokens: 100_000,
        messages: [],
        liveTurnMessages: messages,
        tools: [],
        compaction: {},
    };
    const { contextStatus } = createContextStatus({
        getSession: () => session,
        getRoute: () => ({ provider: 'openai', model: 'test-model' }),
        getCurrentCwd: () => '',
        getMode: () => 'default',
    });
    const status = contextStatus();
    assert.ok(status.usedTokens < status.compaction.triggerTokens,
        `image-aware live gauge must remain below compaction threshold, got ${status.usedTokens}`);
    assert.ok(status.usedTokens < status.contextWindow,
        `raw base64 must not pin the live gauge at 100%, got ${status.usedTokens}/${status.contextWindow}`);
    assert.equal(status.compaction.bufferRatio, 0.05,
        'context status buffer ratio must match the shared compaction policy');

    recordProviderContextBaseline(session, messages, { inputTokens: 70_000, outputTokens: 0 });
    const policy = { ...policyFor(session), reserveTokens: 0 };
    assert.equal(
        shouldCompactForSession(fallbackEstimate, policy, { messages, sessionRef: session }),
        false,
        'provider-backed pressure below threshold must remain below threshold',
    );
    assert.equal(imagePart.data, imageData,
        'estimating live context must not sanitize or remove image content');
});

test('dense ASCII, encoded, and minified payloads do not retain the prose chars/4 estimate', () => {
    for (const text of [
        'A1b2C3d4E5f6G7h8'.repeat(100),
        '%7B%22path%22%3A%22very%2Flong%2Fencoded%2Fvalue%22%7D'.repeat(40),
        JSON.stringify({ rows: Array.from({ length: 100 }, (_, i) => ({ id: i, value: `item_${i}_abcdef` })) }),
    ]) {
        assert.ok(estimateTokens(text) >= Math.ceil(text.length * 0.7),
            `dense ASCII estimate must be conservative (${estimateTokens(text)}/${text.length})`);
    }
    const shortJsonl = Array.from({ length: 200 }, (_, i) => `{"i":${i}}`).join('\n');
    assert.ok(estimateTokens(shortJsonl) >= shortJsonl.replace(/\s/g, '').length * 0.7,
        'short JSONL records must receive the structured multiline floor');
    const spacedShortIdentifiers = 'A1b2C3d4E5 F6G7H8I9J0 '.repeat(100);
    assert.ok(estimateTokens(spacedShortIdentifiers) >= spacedShortIdentifiers.length * 0.7,
        'space-separated encoded identifiers below the long-run threshold must receive the dense floor');
});

test('assistantBlocks and reasoningItems count provider-visible data but not image bytes', () => {
    const base = { role: 'assistant', content: '' };
    const assistantBlocks = [
        { type: 'text', text: 'native assistant replay' },
        { type: 'tool_use', id: 'call_native', name: 'read', input: '{"path":"x"}' },
        { type: 'image', data: 'Z'.repeat(300_000), mimeType: 'image/png' },
    ];
    const reasoningItems = [{ type: 'reasoning', encrypted_content: 'enc_'.repeat(2_000) }];
    const estimated = estimateMessagesTokens([{ ...base, assistantBlocks, reasoningItems }]);
    const noNativeReplay = estimateMessagesTokens([base]);
    assert.ok(estimated > noNativeReplay + IMAGE_VISUAL_TOKEN_ALLOWANCE,
        'native assistant blocks and opaque reasoning must contribute tokens');
    assert.equal(
        estimateMessagesTokens([{ ...base, assistantBlocks: assistantBlocks.map(block => (
            block.type === 'image' ? { ...block, data: 'Z'.repeat(600_000) } : block
        )), reasoningItems }]),
        estimated,
        'native replay image bytes must not be tokenized',
    );
});

test('image allowance handles identity, detail, dimensions, and multiple accepted forms', () => {
    const low = { type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'low' } };
    const tiled = {
        type: 'input_image',
        image_url: { url: 'https://example.test/b.png', detail: 'high' },
        dimensions: { width: 2_048, height: 1_024 },
    };
    const inline = { inlineData: { data: 'A'.repeat(1_000), mimeType: 'image/png' }, width: 512, height: 512 };
    const lowEstimate = estimateMessagesTokens([{ role: 'user', content: [low] }]);
    const tiledEstimate = estimateMessagesTokens([{ role: 'user', content: [tiled] }]);
    const multiEstimate = estimateMessagesTokens([{ role: 'user', content: [low, tiled, inline] }]);
    assert.ok(tiledEstimate > lowEstimate, 'high-detail multi-tile image must reserve more than low detail');
    assert.ok(lowEstimate >= IMAGE_VISUAL_TOKEN_ALLOWANCE + 4,
        'unverified low-detail metadata must not reduce the conservative image fallback');
    const unverifiedSmallDimensions = estimateMessagesTokens([{
        role: 'user',
        content: [{ type: 'image', data: 'A'.repeat(1_000), width: 1, height: 1, detail: 'low' }],
    }]);
    assert.ok(unverifiedSmallDimensions >= IMAGE_VISUAL_TOKEN_ALLOWANCE + 4,
        'unverified tiny dimensions must not reduce the conservative image fallback');
    assert.ok(multiEstimate > tiledEstimate + lowEstimate, 'every accepted image form must add visual allowance');

    const session = { provider: 'openai', model: 'm', tools: [], contextWindow: 100_000, compaction: {} };
    const messages = [{ role: 'user', content: [{ type: 'image', data: 'A'.repeat(1_000), mimeType: 'image/png' }] }];
    const policy = policyFor(session);
    recordProviderContextBaseline(session, messages, { inputTokens: 80_000 }, { sendTools: [] });
    messages[0].content[0].data = 'B'.repeat(1_000);
    assert.equal(
        resolveCompactionPressureTokens(estimateMessagesTokens(messages), policy, { messages, sessionRef: session }),
        estimateMessagesTokens(messages) + policy.reserveTokens,
        'same-size image replacement must invalidate the measured prefix',
    );
});

test('tool reserve and status cache detect nested schema mutation', () => {
    const tools = [{ name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
    const beforeSchema = estimateToolSchemaTokens(tools);
    const beforeReserve = estimateRequestReserveTokens(tools);
    tools[0].parameters.properties.path.description = 'dense_nested_schema_description_'.repeat(200);
    assert.ok(estimateToolSchemaTokens(tools) > beforeSchema);
    assert.ok(estimateRequestReserveTokens(tools) > beforeReserve);

    const session = { id: 'tool-cache', contextWindow: 100_000, messages: [{ role: 'user', content: 'x' }], tools, compaction: {} };
    const { contextStatus } = createContextStatus({
        getSession: () => session,
        getRoute: () => ({ provider: 'openai', model: 'm' }),
        getCurrentCwd: () => '',
        getMode: () => 'default',
    });
    const statusBefore = contextStatus();
    tools[0].parameters.properties.path.description += 'more_'.repeat(500);
    const statusAfter = contextStatus();
    assert.notEqual(statusAfter, statusBefore);
    assert.ok(statusAfter.request.toolSchemaTokens > statusBefore.request.toolSchemaTokens);
});

test('native replay fingerprint detects encrypted reasoning and provider metadata mutation', () => {
    const message = {
        role: 'assistant',
        content: '',
        reasoningItems: [{ type: 'reasoning', encrypted_content: 'short' }],
        assistantBlocks: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' }, cache_control: { type: 'ephemeral' } }],
        providerMetadata: { gemini: { thoughtParts: [{ text: 'short', thoughtSignature: 'sig' }] } },
    };
    const messages = [message];
    const first = summarizeContextMessages(messages).estimatedTokens;
    message.reasoningItems[0].encrypted_content = 'encrypted_'.repeat(1_000);
    const second = summarizeContextMessages(messages).estimatedTokens;
    assert.ok(second > first, 'in-place encrypted_content mutation must invalidate the message memo');
    message.assistantBlocks[0].cache_control.mode = 'metadata_'.repeat(1_000);
    const third = summarizeContextMessages(messages).estimatedTokens;
    assert.ok(third > second, 'in-place assistant-block metadata mutation must invalidate the message memo');
    message.providerMetadata.gemini.thoughtParts[0].text = 'gemini_private_thought_'.repeat(1_000);
    const fourth = summarizeContextMessages(messages).estimatedTokens;
    assert.ok(fourth > third, 'in-place Gemini replay metadata mutation must invalidate the message memo');
});

test('recall compaction preserves provider-scoped Gemini replay metadata on the live tail', () => {
    const providerMetadata = {
        gemini: {
            textParts: [{ text: 'signed answer', thoughtSignature: 'sig-tail' }],
        },
    };
    const result = recallFastTrackCompactMessages([
        { role: 'user', content: `old request ${'x'.repeat(20_000)}` },
        { role: 'assistant', content: `old answer ${'y'.repeat(20_000)}` },
        { role: 'user', content: 'recent request' },
        { role: 'assistant', content: 'signed answer', providerMetadata },
    ], 8_000, {
        force: true,
        recallText: 'Older history summary.',
        recallTailMaxUsers: 1,
        recallTailTokenCap: 4_000,
    });
    const tail = result.messages.find((message) => message?.content === 'signed answer');
    assert.deepEqual(tail?.providerMetadata, providerMetadata);
});

test('recall tail cap drops oversized replay metadata instead of raising the budget', () => {
    const result = recallFastTrackCompactMessages([
        { role: 'user', content: `old request ${'x'.repeat(20_000)}` },
        { role: 'assistant', content: `old answer ${'y'.repeat(20_000)}` },
        { role: 'user', content: 'recent request' },
        {
            role: 'assistant',
            content: 'recent answer',
            providerMetadata: {
                gemini: {
                    thoughtParts: [{
                        text: 'private_'.repeat(20_000),
                        thoughtSignature: 'sig',
                    }],
                },
            },
        },
    ], 8_000, {
        force: true,
        recallText: 'Older history summary.',
        recallTailMaxUsers: 1,
        recallTailTokenCap: 200,
    });
    assert.ok(result.diagnostics.tailTokens <= 200, `tail tokens ${result.diagnostics.tailTokens}`);
    const recent = result.messages.find((message) => message?.content === 'recent answer');
    assert.equal(recent?.providerMetadata, undefined);
});

test('provider baseline pressure includes only the configured extra reserve', () => {
    const session = { provider: 'openai', model: 'm', tools: [], contextWindow: 100_000, compaction: {} };
    const messages = [{ role: 'user', content: 'baseline' }];
    recordProviderContextBaseline(session, messages, { inputTokens: 80_000, outputTokens: 0 });
    const policy = { ...policyFor(session), reserveTokens: 7_512, requestReserveTokens: 512, configuredReserveTokens: 7_000 };
    assert.equal(resolveCompactionPressureTokens(1, policy, { messages, sessionRef: session }), 87_000);
});

test('context status uses the automatic compaction pressure numerator and trigger', () => {
    const session = {
        id: 'status-pressure',
        provider: 'openai',
        model: 'm',
        tools: [],
        contextWindow: 100_000,
        messages: [{ role: 'user', content: 'small local estimate' }],
        compaction: {},
    };
    recordProviderContextBaseline(session, session.messages, {
        inputTokens: 80_000,
        outputTokens: 2_000,
    });
    const policy = policyFor(session);
    const expectedPressure = resolveCompactionPressureTokens(
        estimateMessagesTokens(session.messages),
        policy,
        { messages: session.messages, sessionRef: session },
    );
    const { contextStatus } = createContextStatus({
        getSession: () => session,
        getRoute: () => ({ provider: 'openai', model: 'm' }),
        getCurrentCwd: () => '',
        getMode: () => 'default',
    });

    const status = contextStatus();
    assert.equal(status.usedTokens, expectedPressure);
    assert.equal(status.currentEstimatedTokens, expectedPressure);
    assert.equal(status.compaction.triggerTokens, policy.triggerTokens);
    assert.equal(
        shouldCompactForSession(estimateMessagesTokens(session.messages), policy, {
            messages: session.messages,
            sessionRef: session,
        }),
        status.usedTokens >= status.compaction.triggerTokens,
    );
});

test('provider baselines fingerprint actual sendTools and reject provider, model, tool-schema, and prefix changes', () => {
    const make = () => ({
        provider: 'openai',
        model: 'm1',
        tools: [{ name: 'read', parameters: { type: 'object' } }],
        contextWindow: 100_000,
        compaction: {},
    });
    const fallbackForMutation = (mutate) => {
        const session = make();
        const messages = [{ role: 'user', content: 'original prefix' }];
        recordProviderContextBaseline(session, messages, { inputTokens: 80_000, outputTokens: 0 }, { sendTools: session.tools });
        mutate(session, messages);
        const policy = { ...resolveWorkerCompactPolicy(session, session.tools), reserveTokens: 0 };
        return {
            pressure: resolveCompactionPressureTokens(estimateMessagesTokens(messages), policy, { messages, sessionRef: session }),
            fallback: estimateMessagesTokens(messages),
        };
    };
    for (const mutate of [
        session => { session.provider = 'anthropic'; },
        session => { session.model = 'm2'; },
        session => { session.tools[0].parameters.properties = { path: { type: 'string' } }; },
        (_session, messages) => { messages[0].content = 'mutated earlier prefix'; },
    ]) {
        const result = fallbackForMutation(mutate);
        assert.equal(result.pressure, result.fallback);
    }
    const session = make();
    const messages = [{ role: 'user', content: 'forced tool request' }];
    const actualSendTools = [session.tools[0]];
    const matchingPolicy = resolveWorkerCompactPolicy(session, actualSendTools);
    recordProviderContextBaseline(session, messages, { inputTokens: 80_000 }, { sendTools: actualSendTools });
    session.tools = [{ name: 'different-session-tool', parameters: { type: 'object' } }];
    assert.equal(
        resolveCompactionPressureTokens(1, matchingPolicy, { messages, sessionRef: session }),
        80_000,
        'baseline must remain aligned to actual sendTools rather than mutable sessionRef.tools',
    );
    const changedSendPolicy = resolveWorkerCompactPolicy(session, session.tools);
    assert.notEqual(
        resolveCompactionPressureTokens(1, changedSendPolicy, { messages, sessionRef: session }),
        80_000,
        'a different next-send schema must invalidate the baseline',
    );
});

test('context status cache notices mutation of an earlier message', () => {
    const session = {
        id: 'status-mutation',
        contextWindow: 100_000,
        messages: [{ role: 'user', content: 'short' }, { role: 'assistant', content: 'tail' }],
        tools: [],
        compaction: {},
    };
    const { contextStatus } = createContextStatus({
        getSession: () => session,
        getRoute: () => ({ provider: 'openai', model: 'm' }),
        getCurrentCwd: () => '',
        getMode: () => 'default',
    });
    const before = contextStatus();
    session.messages[0].content = 'dense_earlier_message_'.repeat(1_000);
    const after = contextStatus();
    assert.notEqual(after, before);
    assert.ok(after.usedTokens > before.usedTokens);
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
        cachedTokens: 68_000,
        cacheWriteTokens: 1_000,
    }, { boundary: 'request' });
    const nudge = {
        role: 'user',
        content: '[mixdog-runtime] Previous response was empty. Continue with a final answer or tool call.',
    };
    messages.push(nudge);

    const wholeEstimate = estimateMessagesTokens(messages);
    const pressure = compactionTelemetryPressureTokens(wholeEstimate, policy, { messages, sessionRef: session });
    const expectedPressure = 74_000 + estimateMessagesTokens([nudge]);
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
