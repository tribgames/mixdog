#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';

import { agentLoop } from '../src/runtime/agent/orchestrator/session/agent-loop.mjs';
import { HIDDEN_AGENT_NAMES } from '../src/runtime/agent/orchestrator/session/loop/hidden-agents.mjs';

function queuedProvider(responses, streamed = []) {
    const sent = [];
    let index = 0;
    return {
        sent,
        async send(messages, _model, _tools, opts = {}) {
            sent.push(structuredClone(messages));
            const response = responses[index++];
            assert.ok(response, `unexpected provider send ${index}`);
            if (response instanceof Error) {
                if (typeof response.partialContent === 'string') {
                    opts.onTextDelta?.(response.partialContent);
                    streamed.push(response.partialContent);
                }
                throw response;
            }
            if (typeof response.content === 'string') {
                opts.onTextDelta?.(response.content);
                streamed.push(response.content);
            }
            return {
                usage: { inputTokens: 1, outputTokens: 1 },
                ...response,
            };
        },
    };
}

async function run(provider, messages = [{ role: 'user', content: 'answer fully' }], options = {}) {
    return agentLoop(provider, messages, 'fake-model', [], options.onToolCall, process.cwd(), {
        onTextDelta: options.onTextDelta,
        session: options.session,
        providerState: options.providerState,
    });
}

function persistedAssistantText(messages, result) {
    const terminal = typeof result.historyContent === 'string' ? result.historyContent : result.content;
    return [
        ...messages.filter((message) => message.role === 'assistant').map((message) => message.content),
        terminal,
    ].join('');
}

test('one max-output continuation resumes from preserved partial and returns one complete text', async () => {
    const streamed = [];
    const provider = queuedProvider([
        { content: 'alpha ', stopReason: 'length', truncated: true },
        { content: 'omega', stopReason: 'end_turn' },
    ], streamed);
    const messages = [{ role: 'user', content: 'answer fully' }];

    const result = await run(provider, messages, { onTextDelta: () => {} });

    assert.equal(provider.sent.length, 2);
    assert.equal(result.content, 'alpha omega');
    assert.equal(streamed.join(''), result.content);
    assert.equal(result.historyContent, 'omega');
    assert.equal(result.maxOutputRecoveryAttempts, 1);
    assert.equal(result.terminationReason, undefined);
    assert.deepEqual(provider.sent[1].map((message) => message.role), ['user', 'assistant', 'user']);
    assert.equal(provider.sent[1][1].content, 'alpha ');
    assert.match(provider.sent[1][2].content, /Resume directly/);
    assert.match(provider.sent[1][2].content, /no apology, no recap/i);
    assert.equal(persistedAssistantText(messages, result), result.content);
    assert.equal(messages.some((message) => message.role === 'assistant' && message.content === result.content), false);
});

test('Gemini MAX_TOKENS ProviderIncompleteError enters the same bounded recovery and aggregates usage', async () => {
    const streamed = [];
    const geminiIncomplete = Object.assign(new Error('Gemini response incomplete: finishReason=MAX_TOKENS'), {
        name: 'ProviderIncompleteError',
        code: 'PROVIDER_INCOMPLETE',
        providerIncomplete: true,
        finishReason: 'MAX_TOKENS',
        partialContent: 'gemini ',
        partialToolCalls: undefined,
        model: 'gemini-test',
        rawUsage: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 1,
            cachedContentTokenCount: 3,
        },
    });
    const provider = queuedProvider([
        geminiIncomplete,
        {
            content: 'complete',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 1, promptTokens: 1 },
        },
    ], streamed);
    const messages = [{ role: 'user', content: 'answer fully' }];

    const result = await run(provider, messages, { onTextDelta: () => {} });

    assert.equal(provider.sent.length, 2);
    assert.equal(result.content, 'gemini complete');
    assert.equal(streamed.join(''), result.content, 'TUI-facing deltas and final aggregate contain each segment once');
    assert.deepEqual(
        {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedTokens: result.usage.cachedTokens,
            promptTokens: result.usage.promptTokens,
        },
        { inputTokens: 11, outputTokens: 7, cachedTokens: 4, promptTokens: 11 },
    );
    assert.equal(result.lastTurnUsage.outputTokens, 2);
    assert.equal(provider.sent[1][1].content, 'gemini ');
});

test('Gemini MAX_TOKENS recovery derives missing prompt usage from total minus output', async () => {
    const incomplete = Object.assign(new Error('Gemini response incomplete: finishReason=MAX_TOKENS'), {
        code: 'PROVIDER_INCOMPLETE',
        providerIncomplete: true,
        finishReason: 'MAX_TOKENS',
        partialContent: 'gemini ',
        rawUsage: {
            total_token_count: 20,
            candidates_token_count: 4,
            thoughts_token_count: 1,
        },
    });
    const result = await run(queuedProvider([
        incomplete,
        {
            content: 'complete',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 2, promptTokens: 1 },
        },
    ]), undefined, { onTextDelta: () => {} });

    assert.deepEqual(
        {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            promptTokens: result.usage.promptTokens,
        },
        { inputTokens: 16, outputTokens: 7, promptTokens: 16 },
    );
});

test('Gemini MAX_TOKENS continuation preserves provider-scoped replay metadata', async () => {
    const providerMetadata = {
        gemini: { thoughtParts: [{ text: 'signed thought', thoughtSignature: 'sig-gemini' }] },
    };
    const incomplete = Object.assign(new Error('MAX_TOKENS'), {
        code: 'PROVIDER_INCOMPLETE',
        providerIncomplete: true,
        finishReason: 'MAX_TOKENS',
        partialContent: 'first ',
        providerMetadata,
    });
    const provider = queuedProvider([
        incomplete,
        { content: 'second', stopReason: 'end_turn' },
    ]);
    await run(provider);
    assert.deepEqual(provider.sent[1][1].providerMetadata, providerMetadata);
});

test('Gemini partial-final stall commits signed provider metadata with partial text', async () => {
    const providerMetadata = {
        gemini: {
            thoughtParts: [{ text: 'private', thoughtSignature: 'sig-private' }],
            textParts: [{ text: 'partial answer', thoughtSignature: 'sig-text' }],
        },
    };
    const stalled = Object.assign(new Error('stalled'), {
        streamStalled: true,
        pendingToolUse: false,
        emittedToolCall: false,
        partialContent: 'partial answer',
        providerMetadata,
    });
    const messages = [{ role: 'user', content: 'answer' }];
    const result = await run(queuedProvider([stalled]), messages);
    assert.equal(result.content, 'partial answer');
    assert.deepEqual(result.providerMetadata, providerMetadata);
});

test('pause_turn and Gemini OTHER preserve prior non-empty semantics and do not recover', async () => {
    for (const stopReason of ['pause_turn', 'OTHER']) {
        const provider = queuedProvider([{ content: `partial-${stopReason}`, stopReason }]);
        const result = await run(provider);
        assert.equal(provider.sent.length, 1, stopReason);
        assert.equal(result.content, `partial-${stopReason}`, stopReason);
        assert.equal(result.terminationReason, undefined, stopReason);
        assert.equal(Object.hasOwn(result, 'historyContent'), false, stopReason);
    }
});

test('empty safety refusal gets one context-changing retry, then terminates as refusal', async () => {
    const provider = queuedProvider([
        { content: '', stopReason: 'refusal', stopDetails: { category: 'safety' } },
        { content: '', stopReason: 'refusal', stopDetails: { category: 'safety' } },
    ]);
    const messages = [{ role: 'user', content: 'answer fully' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 2);
    assert.equal(result.terminationReason, 'refusal');
    assert.equal(messages.filter((message) => message?.meta?.source === 'refusal-recovery').length, 1);
    assert.match(provider.sent[1].at(-1).content, /safety classifier/);
    assert.match(provider.sent[1].at(-1).content, /within policy/);
});

test('one refusal retry can recover to a normal answer', async () => {
    const provider = queuedProvider([
        { content: '', stopReason: 'refusal' },
        { content: 'compliant answer', stopReason: 'end_turn' },
    ]);

    const result = await run(provider);

    assert.equal(provider.sent.length, 2);
    assert.equal(result.content, 'compliant answer');
    assert.equal(result.terminationReason, undefined);
});

test('hidden-agent empty refusal gets one retry, then terminates as refusal', async () => {
    const hiddenAgent = HIDDEN_AGENT_NAMES.values().next().value;
    assert.ok(hiddenAgent, 'expected at least one configured hidden agent');
    const provider = queuedProvider([
        { content: '', stopReason: 'refusal' },
        { content: '', stopReason: 'refusal' },
    ]);
    const messages = [{ role: 'user', content: 'complete the assigned output' }];

    const result = await run(provider, messages, { session: { agent: hiddenAgent } });

    assert.equal(provider.sent.length, 2);
    assert.equal(result.terminationReason, 'refusal');
    assert.equal(messages.filter((message) => message?.meta?.source === 'refusal-recovery').length, 1);
    assert.match(provider.sent[1].at(-1).content, /assigned output within policy/);
    assert.doesNotMatch(provider.sent[1].at(-1).content, /answer the user/i);
});

test('non-output ProviderIncompleteError remains an error', async () => {
    const other = Object.assign(new Error('Gemini response incomplete: finishReason=OTHER'), {
        code: 'PROVIDER_INCOMPLETE',
        providerIncomplete: true,
        finishReason: 'OTHER',
        partialContent: 'unsafe partial',
        partialToolCalls: undefined,
    });
    await assert.rejects(run(queuedProvider([other])), (error) => error === other);
});

test('adaptive-thinking replay state is preserved on the partial assistant history turn', async () => {
    const thinkingBlocks = [{ type: 'thinking', thinking: 'signed thought', signature: 'sig-123' }];
    const reasoningItems = [{ type: 'reasoning', encrypted_content: 'enc-1' }];
    const provider = queuedProvider([
        {
            content: 'first ',
            stopReason: 'max_tokens',
            truncated: true,
            thinkingBlocks,
            reasoningItems,
            reasoningContent: 'display thought',
        },
        { content: 'second', stopReason: 'end_turn' },
    ]);

    const result = await run(provider);

    assert.equal(result.content, 'first second');
    assert.deepEqual(provider.sent[1][1].thinkingBlocks, thinkingBlocks);
    assert.deepEqual(provider.sent[1][1].reasoningItems, reasoningItems);
    assert.equal(provider.sent[1][1].reasoningContent, 'display thought');
});

test('max-output recovery stops after three continuations and surfaces explicit truncation', async () => {
    const provider = queuedProvider([
        { content: 'A', stopReason: 'max_tokens', truncated: true },
        { content: 'B', stopReason: 'max_tokens', truncated: true },
        { content: 'C', stopReason: 'max_tokens', truncated: true },
        { content: 'D', stopReason: 'max_tokens', truncated: true },
    ]);
    const messages = [{ role: 'user', content: 'answer fully' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 4);
    assert.equal(result.maxOutputRecoveryAttempts, 3);
    assert.equal(result.terminationReason, 'truncated');
    assert.match(result.content, /^ABCD/);
    assert.match(result.content, /remained truncated after 3 continuation attempts/);
    assert.equal(messages.filter((message) => message?.meta?.source === 'max-output-recovery').length, 3);
    assert.equal(messages.filter((message) => message.role === 'assistant').length, 3);
    assert.equal(persistedAssistantText(messages, result), result.content);
});

test('clean end_turn is unchanged and does not enter recovery', async () => {
    const provider = queuedProvider([
        { content: 'clean answer', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'answer fully' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 1);
    assert.equal(result.content, 'clean answer');
    assert.equal(result.terminationReason, undefined);
    assert.equal(Object.hasOwn(result, 'historyContent'), false);
    assert.deepEqual(messages, [{ role: 'user', content: 'answer fully' }]);
});

test('providerState distinguishes no update from an explicit clear for other providers', async () => {
    const initial = { otherProvider: { continuation: 'keep' } };
    const noUpdate = await run(queuedProvider([
        { content: 'done', stopReason: 'end_turn' },
    ]), undefined, { providerState: initial });
    assert.deepEqual(noUpdate.providerState, initial);
    assert.equal(noUpdate.providerStateUpdated, false);

    const cleared = await run(queuedProvider([
        { content: 'done', stopReason: 'end_turn', providerState: null },
    ]), undefined, { providerState: initial });
    assert.equal(cleared.providerState, null);
    assert.equal(cleared.providerStateUpdated, true);
});

test('tool-call turns keep the normal tool execution path', async () => {
    const provider = queuedProvider([
        {
            content: '',
            stopReason: 'tool_use',
            toolCalls: [{ id: 'call-1', name: 'unknown_test_tool', arguments: {} }],
        },
        { content: 'done', stopReason: 'end_turn' },
    ]);
    const batches = [];
    const messages = [{ role: 'user', content: 'use a tool' }];

    const result = await run(provider, messages, {
        onToolCall: (_iteration, calls) => batches.push(calls),
    });

    assert.equal(provider.sent.length, 2);
    assert.equal(result.content, 'done');
    assert.equal(result.toolCallsTotal, 1);
    assert.equal(result.terminationReason, undefined);
    assert.equal(Object.hasOwn(result, 'historyContent'), false);
    assert.equal(batches.length, 1);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'tool']);
});
