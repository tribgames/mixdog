import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSSEStream } from './anthropic-sse.mjs';
import { applyAnthropicErrorContract } from './anthropic-error-contract.mjs';
import {
  NATIVE_SERVER_TOOL_RESULT_BLOCK_TYPES,
  isNativeServerToolBlockType,
} from './lib/anthropic-native-blocks.mjs';

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const start = frame({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } });
const stop = frame({ type: 'message_stop' });
const blockStart = (index, content_block) => frame({ type: 'content_block_start', index, content_block });
const blockDelta = (index, delta) => frame({ type: 'content_block_delta', index, delta });
const blockStop = (index) => frame({ type: 'content_block_stop', index });
const messageDelta = (delta, usage = { output_tokens: 3 }) => frame({ type: 'message_delta', delta, usage });

async function run(...frames) {
  const relayed = [];
  const result = await parseSSEStream(
    new Response(frames.join(''), { status: 200 }),
    new AbortController().signal,
    () => {},
    null,
    null,
    {},
    (text) => relayed.push(text),
    null,
    {}
  );
  return { result, relayed };
}

test('tool_search_tool_result is a native result block kept with its server_tool_use', async () => {
  assert.ok(NATIVE_SERVER_TOOL_RESULT_BLOCK_TYPES.has('tool_search_tool_result'));
  assert.ok(isNativeServerToolBlockType('tool_search_tool_result'));
  const searchResult = {
    type: 'tool_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: {
      type: 'tool_search_tool_search_result',
      tool_references: [{ type: 'tool_reference', tool_name: 'get_weather' }],
    },
  };
  const { result } = await run(
    start,
    blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: {} }),
    blockDelta(0, { type: 'input_json_delta', partial_json: '{"pattern":"weather"}' }),
    blockStop(0),
    blockStart(1, searchResult),
    blockStop(1),
    blockStart(2, { type: 'text', text: '' }),
    blockDelta(2, { type: 'text_delta', text: 'done' }),
    blockStop(2),
    messageDelta({ stop_reason: 'pause_turn' }),
    stop
  );
  assert.deepEqual(result.assistantBlocks, [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { pattern: 'weather' } },
    searchResult,
    { type: 'text', text: 'done' },
  ]);
});

test('non-empty initial text of a text block reaches content and live relay once', async () => {
  const { result, relayed } = await run(
    start,
    blockStart(0, { type: 'text', text: 'Hello' }),
    blockDelta(0, { type: 'text_delta', text: ' world' }),
    blockStop(0),
    messageDelta({ stop_reason: 'end_turn' }),
    stop
  );
  assert.equal(result.content, 'Hello world');
  assert.equal(relayed.join(''), 'Hello world');
  assert.deepEqual(result.assistantBlocks, [{ type: 'text', text: 'Hello world' }]);
});

test('citations_delta and start citations stay on their text block', async () => {
  const first = { type: 'char_location', cited_text: 'a', document_index: 0, start_char_index: 0, end_char_index: 1 };
  const second = { type: 'page_location', cited_text: 'b', document_index: 0, start_page_number: 1, end_page_number: 2 };
  const { result } = await run(
    start,
    blockStart(0, { type: 'text', text: '', citations: [first] }),
    blockDelta(0, { type: 'text_delta', text: 'cited' }),
    blockDelta(0, { type: 'citations_delta', citation: second }),
    blockStop(0),
    blockStart(1, { type: 'text', text: '' }),
    blockDelta(1, { type: 'text_delta', text: ' plain' }),
    blockStop(1),
    messageDelta({ stop_reason: 'end_turn' }),
    stop
  );
  assert.equal(result.content, 'cited plain');
  assert.deepEqual(result.assistantBlocks, [
    { type: 'text', text: 'cited', citations: [first, second] },
    { type: 'text', text: ' plain' },
  ]);
  assert.ok(result.contentBlockTypes.includes('citations_delta'));
});

test('message_delta stop_sequence and stop_details are accumulated on the turn', async () => {
  const details = { type: 'refusal', category: 'cyber', explanation: 'no' };
  const { result } = await run(
    start,
    blockStart(0, { type: 'text', text: '' }),
    blockDelta(0, { type: 'text_delta', text: 'x' }),
    blockStop(0),
    messageDelta({ stop_reason: 'stop_sequence', stop_sequence: 'END', stop_details: details }),
    stop
  );
  assert.equal(result.stopReason, 'stop_sequence');
  assert.equal(result.stopSequence, 'END');
  assert.deepEqual(result.stopDetails, details);
});

test('ordinary text/thinking/tool_use streams keep their exact result shape', async () => {
  const { result, relayed } = await run(
    start,
    blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
    blockDelta(0, { type: 'thinking_delta', thinking: 'hm' }),
    blockDelta(0, { type: 'signature_delta', signature: 'sig' }),
    blockStop(0),
    blockStart(1, { type: 'text', text: '' }),
    blockDelta(1, { type: 'text_delta', text: 'hi' }),
    blockStop(1),
    blockStart(2, { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }),
    blockDelta(2, { type: 'input_json_delta', partial_json: '{"a":1}' }),
    blockStop(2),
    messageDelta({ stop_reason: 'tool_use', stop_sequence: null }),
    stop
  );
  assert.equal(result.content, 'hi');
  assert.deepEqual(relayed, ['hi']);
  assert.equal('stopSequence' in result, false);
  assert.deepEqual(result.toolCalls, [{ id: 'toolu_1', name: 'read', arguments: { a: 1 } }]);
  assert.deepEqual(result.thinkingBlocks, [{ type: 'thinking', thinking: 'hm', signature: 'sig' }]);
  assert.deepEqual(result.assistantBlocks, [
    { type: 'thinking', thinking: 'hm', signature: 'sig' },
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'toolu_1', name: 'read', input: { a: 1 } },
  ]);
});

test('SSE conflict_error and timeout_error frames resolve to 409 and 504', async () => {
  for (const [type, status] of [
    ['conflict_error', 409],
    ['timeout_error', 504],
  ]) {
    await assert.rejects(
      run(start, frame({ type: 'error', error: { type, message: 'x' } })),
      (err) => err.httpStatus === status && err.status === status && err.code === type
    );
  }
});

test('error contract names conflict_error/timeout_error from status alone', () => {
  assert.equal(applyAnthropicErrorContract(new Error('x'), { status: 409 }).code, 'conflict_error');
  assert.equal(applyAnthropicErrorContract(new Error('x'), { status: 504 }).code, 'timeout_error');
});
