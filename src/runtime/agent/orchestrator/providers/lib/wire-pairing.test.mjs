import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    WIRE_PAIRING_STUB,
    ensureChatToolPairs,
    ensureResponsesCallOutputs,
} from './wire-pairing.mjs';
import { toOpenAIMessages, toXaiResponsesInput } from '../openai-compat-wire.mjs';
import { convertMessagesToResponsesInput } from '../openai-responses-payload.mjs';

// History shape left behind when a turn is cancelled after the model emitted
// a tool call but before any result committed.
function orphanCallHistory(callId = 'call_01orphan') {
    return [
        { role: 'user', content: 'do it' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: callId, name: 'read', arguments: { path: 'a.txt' } }],
        },
    ];
}

test('paired responses calls pass through untouched', () => {
    const items = [
        { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ];
    assert.equal(ensureResponsesCallOutputs(items), items);
});

test('orphan function_call gains a synthetic output right after it', () => {
    const out = ensureResponsesCallOutputs([
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'call_9', name: 'read', arguments: '{}' },
        { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ]);
    assert.equal(out.length, 4);
    assert.deepEqual(out[2], {
        type: 'function_call_output',
        call_id: 'call_9',
        output: WIRE_PAIRING_STUB,
    });
});

test('orphan custom and tool_search calls gain matching synthetic outputs', () => {
    const out = ensureResponsesCallOutputs([
        { type: 'custom_tool_call', call_id: 'call_c', name: 'search', input: 'q' },
        { type: 'tool_search_call', call_id: 'call_s', execution: 'client', arguments: {} },
    ]);
    assert.equal(out.length, 4);
    assert.deepEqual(out[1], {
        type: 'custom_tool_call_output',
        call_id: 'call_c',
        name: 'search',
        output: WIRE_PAIRING_STUB,
    });
    assert.deepEqual(out[3], {
        type: 'tool_search_output',
        call_id: 'call_s',
        status: 'completed',
        execution: 'client',
        tools: [],
    });
});

test('lone outputs are kept for incremental continuations', () => {
    const items = [
        { type: 'function_call_output', call_id: 'call_server_side', output: 'ok' },
    ];
    assert.equal(ensureResponsesCallOutputs(items), items);
});

test('chat pairs pass through; orphan tool_calls gain a tool message', () => {
    const paired = [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'r', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ];
    assert.equal(ensureChatToolPairs(paired), paired);
    const out = ensureChatToolPairs([
        { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'r', arguments: '{}' } }] },
        { role: 'user', content: 'go on' },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out[1], { role: 'tool', tool_call_id: 'c2', content: WIRE_PAIRING_STUB });
});

test('toXaiResponsesInput pairs a cancelled turn', () => {
    const { input } = toXaiResponsesInput(
        orphanCallHistory(),
        { xaiResponses: { previousResponseId: 'resp_1', seenMessageCount: 0, model: 'muse-spark-1.3' } },
        { model: 'muse-spark-1.3' },
    );
    const call = input.find((item) => item?.type === 'function_call');
    assert.equal(call?.call_id, 'call_01orphan');
    const output = input.find((item) => item?.type === 'function_call_output');
    assert.equal(output?.call_id, 'call_01orphan');
});

test('convertMessagesToResponsesInput pairs a cancelled turn', () => {
    const input = convertMessagesToResponsesInput(orphanCallHistory());
    const call = input.find((item) => item?.type === 'function_call');
    assert.equal(call?.call_id, 'call_01orphan');
    const output = input.find((item) => item?.type === 'function_call_output');
    assert.equal(output?.call_id, 'call_01orphan');
});

test('replay-envelope orphan calls are paired', () => {
    const replay = {
        version: 1,
        provider: 'openai-responses',
        items: [{ type: 'function_call', call_id: 'call_replay', name: 'read', arguments: '{}' }],
    };
    const history = [
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: '', providerReplay: replay },
    ];
    const { input } = toXaiResponsesInput(history, null, {
        model: 'muse-spark-1.3',
        replayProvider: 'openai-responses',
    });
    assert.ok(input.some((item) => item?.type === 'function_call' && item?.call_id === 'call_replay'));
    assert.ok(input.some((item) => item?.type === 'function_call_output' && item?.call_id === 'call_replay'));
    const codex = convertMessagesToResponsesInput(history, { replayEncryptedReasoning: true });
    assert.ok(codex.some((item) => item?.type === 'function_call' && item?.call_id === 'call_replay'));
    assert.ok(codex.some((item) => item?.type === 'function_call_output' && item?.call_id === 'call_replay'));
});

test('chat builder output pairs a cancelled turn at the send site', () => {
    const out = ensureChatToolPairs(toOpenAIMessages(orphanCallHistory(), 'openai'));
    const assistant = out.find((message) => message?.role === 'assistant' && Array.isArray(message.tool_calls));
    assert.equal(assistant?.tool_calls?.[0]?.id, 'call_01orphan');
    const tool = out.find((message) => message?.role === 'tool');
    assert.equal(tool?.tool_call_id, 'call_01orphan');
});
