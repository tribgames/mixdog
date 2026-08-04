#!/usr/bin/env node
// Deterministic agent-loop stop gate: structured provider continuation
// signals (Codex `end_turn=false`, Anthropic `stop_reason:'pause_turn'`) must
// commit the mid-turn assistant text exactly once and resume sampling in the
// same user turn. Providers that omit the signal keep terminal semantics.
import test from 'node:test';
import assert from 'node:assert/strict';

import { agentLoop } from '../src/runtime/agent/orchestrator/session/agent-loop.mjs';
import { providerContinuationSignal } from '../src/runtime/agent/orchestrator/session/loop/termination.mjs';
import { parseSSEStream } from '../src/runtime/agent/orchestrator/providers/anthropic-sse.mjs';
import { toAnthropicMessages } from '../src/runtime/agent/orchestrator/providers/anthropic-messages.mjs';

function queuedProvider(responses) {
    const sent = [];
    let index = 0;
    return {
        sent,
        async send(messages) {
            sent.push(structuredClone(messages));
            const response = responses[index++];
            assert.ok(response, `unexpected provider send ${index}`);
            return { usage: { inputTokens: 1, outputTokens: 1 }, ...response };
        },
    };
}

function repeatingProvider(response) {
    const sent = [];
    return {
        sent,
        async send(messages) {
            sent.push(structuredClone(messages));
            return { usage: { inputTokens: 1, outputTokens: 1 }, ...response };
        },
    };
}

async function run(provider, messages = [{ role: 'user', content: 'do the work' }], options = {}) {
    const result = await agentLoop(provider, messages, 'fake-model', [], options.onToolCall, process.cwd(), {
        session: options.session,
        onAssistantText: options.onAssistantText,
        onAssistantMessageCommitted: options.onAssistantMessageCommitted,
    });
    return result;
}

// --- Anthropic native server-tool fixtures (real wire block shapes) --------

// Wraps Anthropic SSE event objects in the minimal Response-like shape
// parseSSEStream consumes (`body.getReader()`), one `data:` frame per event.
function anthropicSseResponse(events) {
    const encoder = new TextEncoder();
    const chunks = events.map((e) => encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        return i < chunks.length
                            ? Promise.resolve({ done: false, value: chunks[i++] })
                            : Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

const WEB_SEARCH_RESULT_BLOCK = {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_01WebSearch',
    content: [
        {
            type: 'web_search_result',
            title: 'Anthropic docs — pause_turn',
            url: 'https://docs.anthropic.com/en/docs/build-with-claude/tool-use',
            encrypted_content: 'EvgBCioIARgBIiQ8dW9wcXJzdHV2d3h5ejAxMjM0NTY3ODkQ',
            page_age: 'April 30, 2025',
        },
    ],
};

function nativeSearchEvents({ text = 'Let me look that up.', stopReason = 'pause_turn' } = {}) {
    const events = [{ type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 12 } } }];
    let index = 0;
    if (text) {
        events.push(
            { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
            { type: 'content_block_stop', index },
        );
        index += 1;
    }
    events.push(
        {
            type: 'content_block_start',
            index,
            content_block: { type: 'server_tool_use', id: 'srvtoolu_01WebSearch', name: 'web_search', input: {} },
        },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"query": ' } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '"anthropic pause_turn"}' } },
        { type: 'content_block_stop', index },
        { type: 'content_block_start', index: index + 1, content_block: WEB_SEARCH_RESULT_BLOCK },
        { type: 'content_block_stop', index: index + 1 },
        { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 30 } },
        { type: 'message_stop' },
    );
    return events;
}

function parseNativeStream(events) {
    return parseSSEStream(anthropicSseResponse(events), null, () => {}, () => {}, () => {}, {}, () => {}, new Set());
}

test('providerContinuationSignal is structural only', () => {
    assert.equal(providerContinuationSignal({ content: 'Now let me check the file' }), null);
    assert.equal(providerContinuationSignal({ content: 'x', stopReason: 'end_turn' }), null);
    assert.equal(providerContinuationSignal({ content: 'x', endTurn: true }), null);
    assert.equal(providerContinuationSignal({ content: 'x', endTurn: undefined }), null);
    assert.equal(providerContinuationSignal({ content: 'x', endTurn: false }), 'end_turn_false');
    assert.equal(providerContinuationSignal({ content: 'x', end_turn: false }), 'end_turn_false');
    assert.equal(providerContinuationSignal({ content: 'x', stopReason: 'pause_turn' }), 'pause_turn');
    assert.equal(providerContinuationSignal({ content: 'x', stop_reason: 'PAUSE_TURN' }), 'pause_turn');
    assert.equal(providerContinuationSignal(null), null);
});

test('endTurn=false text turn is committed once, then the loop continues into a tool call and final answer', async () => {
    const provider = queuedProvider([
        { content: 'Reviewed the anchors; continuing.', stopReason: 'end_turn', endTurn: false },
        {
            content: '',
            stopReason: 'tool_use',
            toolCalls: [{ id: 'call-1', name: 'unknown_test_tool', arguments: {} }],
        },
        // The unknown tool fails, so the unresolved-tool-failure stop hook
        // blocks this first terminal message ONCE (loop/stop-hooks.mjs).
        { content: 'tool call failed; wrapping up', stopReason: 'end_turn' },
        { content: 'final answer', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'do the work' }];
    const committed = [];
    const uiText = [];

    const result = await run(provider, messages, {
        onAssistantMessageCommitted: (message) => committed.push(message),
        onAssistantText: (text) => uiText.push(text),
    });

    assert.equal(provider.sent.length, 4);
    assert.equal(result.content, 'final answer');
    assert.equal(result.providerContinuations, 1);
    assert.equal(result.toolCallsTotal, 1);
    assert.equal(result.terminationReason, undefined);
    // Exactly once in history and exactly once on the commit callback.
    assert.equal(
        messages.filter((m) => m.role === 'assistant' && m.content === 'Reviewed the anchors; continuing.').length,
        1,
    );
    assert.equal(committed.filter((m) => m.content === 'Reviewed the anchors; continuing.').length, 1);
    assert.equal(uiText.filter((t) => t === 'Reviewed the anchors; continuing.').length, 1);
    // Second send replays the committed continuation turn; no synthetic nudge.
    assert.deepEqual(provider.sent[1].map((m) => m.role), ['user', 'assistant']);
    assert.equal(provider.sent[1][1].content, 'Reviewed the anchors; continuing.');
    // …, tool result, the stop-hook-blocked text, the hook continuation prompt.
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'assistant', 'tool', 'assistant', 'user']);
});

test('pause_turn uses the same continuation path and finishes on the resumed turn', async () => {
    const provider = queuedProvider([
        { content: 'partial synthesis', stopReason: 'pause_turn' },
        { content: 'resumed final', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'do the work' }];
    const committed = [];

    const result = await run(provider, messages, {
        onAssistantMessageCommitted: (message) => committed.push(message),
    });

    assert.equal(provider.sent.length, 2);
    assert.equal(result.content, 'resumed final');
    assert.equal(result.providerContinuations, 1);
    assert.equal(result.terminationReason, undefined);
    assert.equal(messages.filter((m) => m.role === 'assistant').length, 1);
    assert.equal(messages.at(-1).content, 'partial synthesis');
    assert.equal(committed.length, 1);
    assert.equal(provider.sent[1].at(-1).content, 'partial synthesis');
});

test('pause_turn preserves thinking/reasoning replay state on the continuation turn', async () => {
    const thinkingBlocks = [{ type: 'thinking', thinking: 'signed', signature: 'sig-1' }];
    const provider = queuedProvider([
        { content: 'paused', stopReason: 'pause_turn', thinkingBlocks, reasoningContent: 'display thought' },
        { content: 'done', stopReason: 'end_turn' },
    ]);

    await run(provider);

    assert.deepEqual(provider.sent[1][1].thinkingBlocks, thinkingBlocks);
    assert.equal(provider.sent[1][1].reasoningContent, 'display thought');
});

test('no continuation signal keeps the natural no-tool final answer (provider compatibility)', async () => {
    for (const response of [
        { content: 'final answer', stopReason: 'end_turn' },
        { content: 'final answer' },
        { content: 'final answer', stopReason: 'end_turn', endTurn: true },
        { content: 'Now let me continue working on this.', stopReason: 'end_turn' },
    ]) {
        const provider = queuedProvider([response]);
        const messages = [{ role: 'user', content: 'do the work' }];
        const result = await run(provider, messages);
        assert.equal(provider.sent.length, 1, JSON.stringify(response));
        assert.equal(result.content, response.content);
        assert.equal(result.providerContinuations, 0);
        assert.equal(result.terminationReason, undefined);
        assert.deepEqual(messages, [{ role: 'user', content: 'do the work' }]);
    }
});

test('endTurn=false with an output-limit stop still uses bounded max-output recovery (single commit)', async () => {
    const provider = queuedProvider([
        { content: 'A', stopReason: 'max_tokens', truncated: true, endTurn: false },
        { content: 'B', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'do the work' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 2);
    assert.equal(result.content, 'AB');
    assert.equal(result.maxOutputRecoveryAttempts, 1);
    assert.equal(result.providerContinuations, 0);
    assert.equal(messages.filter((m) => m.role === 'assistant').length, 1);
    assert.equal(messages.filter((m) => m?.meta?.source === 'max-output-recovery').length, 1);
});

test('empty continuation-signalled turn falls through to the bounded empty-turn ladder', async () => {
    const provider = repeatingProvider({ content: '', stopReason: 'pause_turn' });
    const messages = [{ role: 'user', content: 'do the work' }];

    const result = await run(provider, messages);

    // Empty payload has nothing to commit: bounded empty-nudge ladder (max 3
    // nudges → 4 sends) ends the loop instead of resending an unchanged
    // transcript forever.
    assert.equal(provider.sent.length, 4);
    assert.equal(result.providerContinuations, 0);
    assert.equal(messages.filter((m) => m.role === 'assistant').length, 0);
});

test('a provider that never stops signalling continuation stays bounded by the iteration cap', async () => {
    const provider = repeatingProvider({ content: 'still working', stopReason: 'pause_turn' });
    const messages = [{ role: 'user', content: 'do the work' }];

    const result = await run(provider, messages, { session: { maxLoopIterations: 3 } });

    assert.ok(provider.sent.length <= 5, `expected bounded sends, got ${provider.sent.length}`);
    assert.equal(result.terminationReason, 'iteration_cap');
    assert.equal(result.maxLoopIterations, 3);
    assert.ok(result.providerContinuations >= 3);
});

test('SSE parser preserves ordered native server_tool_use + web_search_tool_result blocks verbatim', async () => {
    const parsed = await parseNativeStream(nativeSearchEvents());

    assert.equal(parsed.stopReason, 'pause_turn');
    assert.equal(parsed.content, 'Let me look that up.');
    assert.equal(parsed.toolCalls, undefined);
    assert.deepEqual(parsed.assistantBlocks, [
        { type: 'text', text: 'Let me look that up.' },
        {
            type: 'server_tool_use',
            id: 'srvtoolu_01WebSearch',
            name: 'web_search',
            input: { query: 'anthropic pause_turn' },
        },
        WEB_SEARCH_RESULT_BLOCK,
    ]);
});

test('SSE parser emits no assistantBlocks for ordinary text/thinking turns (compatibility)', async () => {
    const parsed = await parseNativeStream([
        { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing options' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'final answer' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
    ]);

    assert.equal(parsed.assistantBlocks, undefined);
    assert.deepEqual(parsed.thinkingBlocks, [{ type: 'thinking', thinking: 'weighing options', signature: 'sig-abc' }]);
    assert.equal(parsed.content, 'final answer');
});

test('pause_turn with native server-tool blocks commits them once and replays them verbatim', async () => {
    const parsed = await parseNativeStream(nativeSearchEvents());
    const provider = queuedProvider([parsed, { content: 'search-informed answer', stopReason: 'end_turn' }]);
    const messages = [{ role: 'user', content: 'search the docs' }];
    const committed = [];

    const result = await run(provider, messages, {
        onAssistantMessageCommitted: (message) => committed.push(message),
    });

    assert.equal(provider.sent.length, 2);
    assert.equal(result.content, 'search-informed answer');
    assert.equal(result.providerContinuations, 1);
    // Exactly one history commit carrying the ordered native blocks verbatim.
    const intermediate = messages.filter((m) => m.role === 'assistant');
    assert.equal(intermediate.length, 1);
    assert.deepEqual(intermediate[0].assistantBlocks, parsed.assistantBlocks);
    assert.equal(intermediate[0].content, 'Let me look that up.');
    assert.equal(committed.length, 1);
    // Replayed on the resumed request, and lowered to Anthropic verbatim
    // (server_tool_use immediately followed by its web_search_tool_result).
    assert.deepEqual(provider.sent[1][1].assistantBlocks, parsed.assistantBlocks);
    const lowered = toAnthropicMessages(provider.sent[1]);
    const assistantTurn = lowered.find((m) => m.role === 'assistant');
    assert.deepEqual(assistantTurn.content, parsed.assistantBlocks);
});

test('native-only pause_turn (no flattened text) continues instead of hitting the empty-turn ladder', async () => {
    const parsed = await parseNativeStream(nativeSearchEvents({ text: '' }));
    assert.equal(parsed.content, '');
    assert.equal(parsed.assistantBlocks.length, 2);

    const provider = queuedProvider([parsed, { content: 'answer after native search', stopReason: 'end_turn' }]);
    const messages = [{ role: 'user', content: 'search the docs' }];
    const committed = [];

    const result = await run(provider, messages, {
        onAssistantMessageCommitted: (message) => committed.push(message),
    });

    assert.equal(provider.sent.length, 2);
    assert.equal(result.content, 'answer after native search');
    assert.equal(result.providerContinuations, 1);
    assert.equal(committed.length, 1);
    // No empty-turn nudge was injected: the native blocks ARE the assistant output.
    assert.equal(messages.filter((m) => m.role === 'user').length, 1);
    assert.deepEqual(messages.filter((m) => m.role === 'assistant')[0].assistantBlocks, parsed.assistantBlocks);
    assert.deepEqual(provider.sent[1].map((m) => m.role), ['user', 'assistant']);
});

test('thinking + native blocks round-trip in stream order without duplicate thinking replay', async () => {
    const events = [
        { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 8 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'need fresh docs' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-native' } },
        { type: 'content_block_stop', index: 0 },
        {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'server_tool_use', id: 'srvtoolu_01WebSearch', name: 'web_search', input: {} },
        },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"docs"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: WEB_SEARCH_RESULT_BLOCK },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
    ];
    const parsed = await parseNativeStream(events);
    assert.deepEqual(parsed.assistantBlocks[0], { type: 'thinking', thinking: 'need fresh docs', signature: 'sig-native' });

    const provider = queuedProvider([parsed, { content: 'done', stopReason: 'end_turn' }]);
    const messages = [{ role: 'user', content: 'search the docs' }];
    await run(provider, messages);

    const intermediate = messages.find((m) => m.role === 'assistant');
    assert.deepEqual(intermediate.assistantBlocks, parsed.assistantBlocks);
    // thinkingBlocks would duplicate blocks already inside assistantBlocks.
    assert.equal(Object.hasOwn(intermediate, 'thinkingBlocks'), false);
    const assistantTurn = toAnthropicMessages(provider.sent[1]).find((m) => m.role === 'assistant');
    assert.deepEqual(assistantTurn.content, parsed.assistantBlocks);
});

test('mixed native + client tool_use turn keeps both shapes and replays the block array verbatim once', async () => {
    const thinkingBlock = { type: 'thinking', thinking: 'search first, then patch', signature: 'sig-mixed' };
    const mixedBlocks = [
        thinkingBlock,
        { type: 'text', text: 'Looked it up; applying the fix.' },
        { type: 'server_tool_use', id: 'srvtoolu_01WebSearch', name: 'web_search', input: { query: 'anthropic pause_turn' } },
        WEB_SEARCH_RESULT_BLOCK,
        { type: 'tool_use', id: 'call-1', name: 'unknown_test_tool', input: { path: 'a.txt' } },
    ];
    const provider = queuedProvider([
        {
            content: 'Looked it up; applying the fix.',
            stopReason: 'tool_use',
            assistantBlocks: mixedBlocks,
            thinkingBlocks: [thinkingBlock],
            toolCalls: [{ id: 'call-1', name: 'unknown_test_tool', arguments: { path: 'a.txt' } }],
        },
        // Unknown tool → failed result → one stop-hook continuation, then done.
        { content: 'done', stopReason: 'end_turn' },
        { content: 'done for real', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'search then patch' }];

    const result = await run(provider, messages);

    assert.equal(result.content, 'done for real');
    assert.equal(result.providerContinuations, 0);
    // Client tool still executed: assistant turn + its tool result.
    assert.equal(result.toolCallsTotal, 1);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user']);
    assert.equal(messages[2].toolCallId, 'call-1');

    // History keeps BOTH shapes: compact toolCalls for execution/recovery and
    // the ordered native blocks for verbatim Anthropic replay.
    const assistantTurn = messages[1];
    assert.deepEqual(assistantTurn.assistantBlocks, mixedBlocks);
    assert.equal(assistantTurn.toolCalls.length, 1);
    assert.equal(assistantTurn.toolCalls[0].id, 'call-1');
    // thinkingBlocks would duplicate the thinking already inside assistantBlocks.
    assert.equal(Object.hasOwn(assistantTurn, 'thinkingBlocks'), false);

    // Next request replays the exact original block array, exactly once, with
    // the server_tool_use → web_search_tool_result pair intact.
    assert.deepEqual(provider.sent[1][1].assistantBlocks, mixedBlocks);
    const lowered = toAnthropicMessages(provider.sent[1]);
    const loweredAssistant = lowered.find((m) => m.role === 'assistant');
    assert.deepEqual(loweredAssistant.content, mixedBlocks);
    assert.equal(loweredAssistant.content.filter((b) => b.type === 'tool_use').length, 1);
    assert.equal(loweredAssistant.content.filter((b) => b.type === 'text').length, 1);
    assert.equal(loweredAssistant.content.filter((b) => b.type === 'thinking').length, 1);
    // The client tool result is appended after the replayed turn.
    const loweredTail = lowered.at(-1);
    assert.equal(loweredTail.role, 'user');
    assert.equal(loweredTail.content.at(-1).type, 'tool_result');
    assert.equal(loweredTail.content.at(-1).tool_use_id, 'call-1');
});

test('tool-call turns without native blocks keep the thinking round-trip (provider compatibility)', async () => {
    const thinkingBlocks = [{ type: 'thinking', thinking: 'plan', signature: 'sig-plain' }];
    const provider = queuedProvider([
        {
            content: 'preamble',
            stopReason: 'tool_use',
            thinkingBlocks,
            toolCalls: [{ id: 'call-1', name: 'unknown_test_tool', arguments: {} }],
        },
        { content: 'done', stopReason: 'end_turn' },
        // One stop-hook continuation follows the failed unknown-tool result.
        { content: 'done for real', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'use a tool' }];

    await run(provider, messages);

    const assistantTurn = messages[1];
    assert.equal(Object.hasOwn(assistantTurn, 'assistantBlocks'), false);
    assert.deepEqual(assistantTurn.thinkingBlocks, thinkingBlocks);
    assert.equal(assistantTurn.toolCalls.length, 1);
    const loweredAssistant = toAnthropicMessages(provider.sent[1]).find((m) => m.role === 'assistant');
    assert.deepEqual(loweredAssistant.content, [
        ...thinkingBlocks,
        { type: 'text', text: 'preamble' },
        { type: 'tool_use', id: 'call-1', name: 'unknown_test_tool', input: {} },
    ]);
});
