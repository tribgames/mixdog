import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WIRE_PAIRING_STUB, ensureChatToolPairs, ensureResponsesCallOutputs } from './wire-pairing.mjs';
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
  // Documented custom_tool_call_output shape: no `name` field.
  assert.deepEqual(out[1], {
    type: 'custom_tool_call_output',
    call_id: 'call_c',
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

test('server-executed tool_search pairs (execution server or call_id null) are never paired or synthesized', () => {
  const items = [
    { type: 'tool_search_call', id: 'ts_1', call_id: null, arguments: {} },
    { type: 'tool_search_output', id: 'tso_1', call_id: null, execution: 'server', status: 'completed', tools: [] },
    { type: 'tool_search_call', id: 'ts_2', execution: 'server', arguments: {} },
  ];
  assert.equal(ensureResponsesCallOutputs(items), items);
  // A server output never answers a client call that shares its item id.
  const out = ensureResponsesCallOutputs([
    { type: 'tool_search_output', id: 'ts_c', call_id: null, execution: 'server', tools: [] },
    { type: 'tool_search_call', call_id: 'ts_c', execution: 'client', arguments: {} },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[2].type, 'tool_search_output');
  assert.equal(out[2].call_id, 'ts_c');
});

test('lone outputs are kept for incremental continuations', () => {
  const items = [{ type: 'function_call_output', call_id: 'call_server_side', output: 'ok' }];
  assert.equal(ensureResponsesCallOutputs(items), items);
});

test('chat pairs pass through; orphan tool_calls gain a tool message', () => {
  const paired = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'r', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ];
  assert.equal(ensureChatToolPairs(paired), paired);
  const out = ensureChatToolPairs([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'r', arguments: '{}' } }],
    },
    { role: 'user', content: 'go on' },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[1], { role: 'tool', tool_call_id: 'c2', content: WIRE_PAIRING_STUB });
});

test('chat tool_calls pair only with the tool messages immediately following their block', () => {
  const call = (id) => ({ id, type: 'function', function: { name: 'r', arguments: '{}' } });
  // A result after an intervening user message does not answer the call.
  const late = [
    { role: 'assistant', content: null, tool_calls: [call('c1')] },
    { role: 'user', content: 'interrupt' },
    { role: 'tool', tool_call_id: 'c1', content: 'late' },
  ];
  const lateOut = ensureChatToolPairs(late);
  // The late result is dropped (not left as an orphan after the user message).
  assert.deepEqual(lateOut, [late[0], { role: 'tool', tool_call_id: 'c1', content: WIRE_PAIRING_STUB }, late[1]]);
  // Orphan tool messages (no preceding call, unknown id, duplicate id) are removed.
  const stray = [
    { role: 'tool', tool_call_id: 'x', content: 'lone' },
    { role: 'assistant', content: null, tool_calls: [call('c1')] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'tool', tool_call_id: 'c1', content: 'dup' },
    { role: 'tool', tool_call_id: 'zz', content: 'unknown' },
    { role: 'user', content: 'next' },
  ];
  assert.deepEqual(ensureChatToolPairs(stray), [stray[1], stray[2], stray[5]]);
  // A result belonging to another occurrence of the same id does not pair
  // the earlier, unanswered occurrence.
  const reused = [
    { role: 'assistant', content: null, tool_calls: [call('c1')] },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: null, tool_calls: [call('c1')] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ];
  const reusedOut = ensureChatToolPairs(reused);
  assert.equal(reusedOut.length, 5);
  assert.deepEqual(reusedOut[1], { role: 'tool', tool_call_id: 'c1', content: WIRE_PAIRING_STUB });
  assert.deepEqual(reusedOut.slice(2), reused.slice(1));
  // Every tool message in the output directly follows an assistant block or
  // another tool message.
  assert.deepEqual(
    reusedOut.map((m) => m.role),
    ['assistant', 'tool', 'user', 'assistant', 'tool']
  );
  // A partially answered parallel block only gains the missing stub.
  const partial = [
    { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'b', content: 'ok' },
    { role: 'user', content: 'next' },
  ];
  assert.deepEqual(ensureChatToolPairs(partial), [
    partial[0],
    { role: 'tool', tool_call_id: 'a', content: WIRE_PAIRING_STUB },
    partial[1],
    partial[2],
  ]);
  // Normal multi-turn history is returned as the same array.
  const normal = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [call('x'), call('y')] },
    { role: 'tool', tool_call_id: 'x', content: '1' },
    { role: 'tool', tool_call_id: 'y', content: '2' },
    { role: 'assistant', content: 'done' },
  ];
  assert.equal(ensureChatToolPairs(normal), normal);
});

test('toXaiResponsesInput pairs a cancelled turn', () => {
  const { input } = toXaiResponsesInput(
    orphanCallHistory(),
    { xaiResponses: { previousResponseId: 'resp_1', seenMessageCount: 0, model: 'muse-spark-1.3' } },
    { model: 'muse-spark-1.3' }
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
