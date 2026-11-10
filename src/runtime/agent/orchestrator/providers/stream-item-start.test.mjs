import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { parseSSEStream } from './anthropic-sse.mjs';
import { consumeCompatChatCompletionStream, consumeCompatResponsesStream } from './openai-compat-stream.mjs';
import { _streamResponse } from './openai-ws-stream.mjs';
import { createHttpSseResponseState } from './openai-http-sse-response-state.mjs';
import { reportStreamItemStart, responsesItemStart } from './lib/send-callbacks.mjs';

// Every streaming adapter reports a client tool call the moment it opens
// (before its arguments complete and onToolCall fires) and a Responses
// message's phase as soon as the item names it.

function arrayStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

/** One ordered log of item starts, text and dispatched calls. */
function recorder() {
  const log = [];
  return {
    log,
    onStreamItemStart: (detail) => log.push(detail.kind === 'tool' ? 'start:tool' : `start:${detail.phase}`),
    onTextDelta: (text) => log.push(`text:${text}`),
    onToolCall: (call) => log.push(`call:${call.name}`),
  };
}

const commentary = { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', content: [] };
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'list', arguments: '{}' };
const responsesEvents = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-fixture' } },
  { type: 'response.output_item.added', item: commentary },
  { type: 'response.output_text.delta', delta: 'Looking' },
  { type: 'response.output_item.done', item: { ...commentary, content: [{ type: 'output_text', text: 'Looking' }] } },
  { type: 'response.output_item.added', item: { ...call, arguments: '' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{}' },
  { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{}' },
  { type: 'response.output_item.done', item: call },
  {
    type: 'response.completed',
    response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } },
  },
];
const expectedResponsesLog = ['start:commentary', 'text:Looking', 'start:commentary', 'start:tool', 'call:list'];

test('a Responses item start names a client tool call or a phased assistant message', () => {
  assert.deepEqual(responsesItemStart(call), { kind: 'tool' });
  assert.deepEqual(responsesItemStart({ type: 'custom_tool_call' }), { kind: 'tool' });
  assert.deepEqual(responsesItemStart({ type: 'tool_search_call' }), { kind: 'tool' });
  assert.deepEqual(responsesItemStart(commentary), { kind: 'text', phase: 'commentary' });
  assert.deepEqual(responsesItemStart({ ...commentary, phase: 'final_answer' }), {
    kind: 'text',
    phase: 'final_answer',
  });
  assert.equal(responsesItemStart({ ...commentary, phase: undefined }), null);
  assert.equal(responsesItemStart({ type: 'reasoning' }), null);
  assert.equal(responsesItemStart({ type: 'web_search_call' }), null, 'a server-side tool is not a client call');
  // A throwing listener never reaches the stream.
  reportStreamItemStart(
    () => {
      throw new Error('listener');
    },
    { kind: 'tool' }
  );
});

test('compat Responses stream: the phase and the tool start arrive before the call completes', async () => {
  const seen = recorder();
  await consumeCompatResponsesStream(arrayStream(responsesEvents), {
    label: 'fixture',
    ...seen,
    responseOutputText: () => '',
    parseResponsesToolCalls: () => [],
  });
  assert.deepEqual(seen.log, expectedResponsesLog);
});

test('Responses WebSocket stream reports item starts', async () => {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.close = () => {
    socket.readyState = 3;
  };
  socket.terminate = socket.close;
  const seen = recorder();
  const pending = _streamResponse({
    entry: { socket, ephemeral: true },
    externalSignal: null,
    ...seen,
    state: { sessionId: 'stream-item-start' },
    logSuppressedReasoningDeltas: false,
  });
  for (const event of responsesEvents) socket.emit('message', Buffer.from(JSON.stringify(event)));
  await pending;
  assert.deepEqual(seen.log, expectedResponsesLog);
});

test('Responses HTTP/SSE stream reports item starts', () => {
  const seen = recorder();
  const state = createHttpSseResponseState({
    body: { tools: [] },
    ...seen,
    meaningful() {},
    onServerEvent() {},
    label: 'test',
  });
  for (const event of responsesEvents) state.handleEvent(event);
  assert.deepEqual(seen.log, expectedResponsesLog);
});

test('chat completions stream: the first delta of a tool call reports its start', async () => {
  const seen = recorder();
  await consumeCompatChatCompletionStream(
    arrayStream([
      { choices: [{ delta: { content: 'Looking' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    {
      label: 'gateway',
      providerName: 'gateway',
      parseToolCalls: (choice) =>
        choice.message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        })),
      ...seen,
    }
  );
  assert.deepEqual(seen.log, ['text:Looking', 'start:tool', 'call:list']);
});

test('Anthropic stream: a tool_use block reports its start before its input completes', async () => {
  const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const seen = recorder();
  await parseSSEStream(
    new Response(
      [
        frame({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } }),
        frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking' } }),
        frame({ type: 'content_block_stop', index: 0 }),
        frame({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'list', input: {} },
        }),
        frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
        frame({ type: 'content_block_stop', index: 1 }),
        frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }),
        frame({ type: 'message_stop' }),
      ].join(''),
      { status: 200 }
    ),
    new AbortController().signal,
    () => {},
    null,
    seen.onToolCall,
    {},
    seen.onTextDelta,
    new Set(['list']),
    { onStreamItemStart: seen.onStreamItemStart }
  );
  assert.deepEqual(seen.log, ['text:Looking', 'start:tool', 'call:list']);
});
