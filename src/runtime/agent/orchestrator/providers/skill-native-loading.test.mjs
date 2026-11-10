import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { SKILL_TOOL, TOOL_SEARCH_TOOL } from '../runtime-core/tool-defs.mjs';
import { buildRequestBody } from './openai-responses-payload.mjs';
import { toResponsesTools, parseResponsesToolCalls, responseOutputText } from './openai-compat-wire.mjs';
import { nativeToolSearchCallFromArguments } from './custom-tool-wire.mjs';
import { convertMessagesToResponsesInput } from './openai-responses-input.mjs';
import { _computeDelta, _sansInput, _stableStringify } from './openai-ws-delta.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { sendViaHttpSse } from './openai-oauth-http-sse.mjs';
import { _streamResponse } from './openai-ws-stream.mjs';
import { consumeCompatResponsesStream } from './openai-compat-stream.mjs';

const schema = {
  type: 'function',
  name: 'office',
  defer_loading: true,
  parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
};
const call = nativeToolSearchCallFromArguments('load-call', { names: ['office'] });
const responseItem = { type: 'tool_search_call', call_id: call.id, execution: 'client', arguments: call.arguments };
const result = {
  role: 'tool',
  toolCallId: call.id,
  content: 'Loaded deferred tools: office',
  nativeToolSearch: { provider: 'openai-oauth', openaiTools: [schema], toolReferences: ['office'] },
};

test('Responses keeps Skill a separate function tool beside the native loader', () => {
  const tools = [SKILL_TOOL, TOOL_SEARCH_TOOL];
  const body = buildRequestBody([], 'gpt-6-astra', tools, { sessionId: 'skill-test' });
  assert.deepEqual(
    body.tools.map((tool) => [tool.type, tool.name]),
    [
      ['function', 'Skill'],
      ['tool_search', undefined],
    ]
  );
  assert.equal(Object.hasOwn(body.tools[1].parameters.properties, 'name'), false);
  assert.deepEqual(toResponsesTools(tools, { provider: 'openai' }), body.tools);
  assert.deepEqual(
    toResponsesTools(tools, { provider: 'xai' }).map((tool) => [tool.type, tool.name]),
    [
      ['function', 'Skill'],
      ['function', 'load_tool'],
    ]
  );
  assert.equal(buildRequestBody([], 'gpt-6-astra', [SKILL_TOOL], {}).tools[0].type, 'function');
});

test('a native load_tool call preserves its actual identity and remains a delta continuation after loading', () => {
  const parsed = parseResponsesToolCalls({ output: [responseItem] });
  assert.deepEqual(parsed, [call]);
  const initial = [{ role: 'user', content: 'Create a deck.' }];
  const assistant = {
    role: 'assistant',
    content: '',
    toolCalls: parsed,
    providerReplay: createProviderReplay('openai-responses', [responseItem]),
  };
  const messages = [...initial, assistant, result, { role: 'user', content: '# Deck guide' }];
  const tools = [SKILL_TOOL, TOOL_SEARCH_TOOL];
  const opts = { sessionId: 'skill-test' };
  const before = buildRequestBody(initial, 'gpt-6-astra', tools, opts);
  const after = buildRequestBody(messages, 'gpt-6-astra', tools, opts);
  assert.deepEqual(after.tools, before.tools);
  assert.equal(after.prompt_cache_key, before.prompt_cache_key);
  assert.deepEqual(
    after.input.find((item) => item.type === 'tool_search_call'),
    responseItem
  );
  const output = after.input.find((item) => item.type === 'tool_search_output');
  assert.equal(output.call_id, call.id);
  assert.deepEqual(output.tools, [{ ...schema, strict: false }]);
  assert.equal(
    after.input.some((item) => item.type === 'function_call_output'),
    false
  );
  const previous = process.env.MIXDOG_OAI_TRANSPORT;
  process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
  try {
    const delta = _computeDelta({
      traceProvider: 'openai-oauth',
      body: after,
      entry: {
        lastResponseId: 'previous-response',
        lastRequestInput: before.input,
        lastRequestSansInput: _stableStringify(_sansInput(before)),
        lastResponseItems: [responseItem],
      },
    });
    assert.equal(delta.mode, 'delta');
    assert.deepEqual(delta.frame.input[0], output);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_OAI_TRANSPORT;
    else process.env.MIXDOG_OAI_TRANSPORT = previous;
  }
});

test('missing and denied native loads return paired empty search results with visible errors', () => {
  for (const error of ['Error: tool not found', 'Error: tool "load_tool" denied by policy']) {
    const input = convertMessagesToResponsesInput([
      { role: 'assistant', content: '', toolCalls: [call] },
      { role: 'tool', toolCallId: call.id, content: error },
    ]);
    assert.deepEqual(input.find((item) => item.type === 'tool_search_output')?.tools, []);
    assert.equal(
      input.some((item) => item.type === 'function_call_output'),
      false
    );
    assert.ok(input.some((item) => item.role === 'user' && item.content.some((part) => part.text === error)));
  }
});

const skillCall = { id: 'skill-call', name: 'Skill', arguments: { name: 'deck-guide' } };
const skillResult = { ...result, toolCallId: skillCall.id, content: 'Loaded skill: deck-guide' };

test('a Skill result loads its dependency schemas through a load pair after the whole batch', () => {
  const readCall = { id: 'read-call', name: 'read', arguments: { path: 'a.md' } };
  const input = convertMessagesToResponsesInput([
    { role: 'user', content: 'Create a deck.' },
    { role: 'assistant', content: '', toolCalls: [skillCall, readCall] },
    skillResult,
    { role: 'tool', toolCallId: readCall.id, content: 'text' },
  ]);
  assert.deepEqual(
    input.slice(1).map((item) => [item.type, item.call_id]),
    [
      ['function_call', 'skill-call'],
      ['function_call', 'read-call'],
      ['function_call_output', 'skill-call'],
      ['function_call_output', 'read-call'],
      ['tool_search_call', 'skill-call_load'],
      ['tool_search_output', 'skill-call_load'],
    ]
  );
  assert.equal(input[3].output, 'Loaded skill: deck-guide');
  assert.deepEqual(input[5].arguments, { names: ['office'] });
  assert.deepEqual(input[6].tools, [{ ...schema, strict: false }]);
});

test('a Skill result from another native family keeps the load hint without a pair', () => {
  const input = convertMessagesToResponsesInput([
    { role: 'assistant', content: '', toolCalls: [skillCall] },
    { ...skillResult, nativeToolSearch: { ...skillResult.nativeToolSearch, provider: 'anthropic-oauth' } },
  ]);
  assert.equal(
    input.some((item) => item.type === 'tool_search_call' || item.type === 'tool_search_output'),
    false
  );
  assert.match(
    input.find((item) => item.type === 'function_call_output').output,
    /tool_search with names:\["office"\]/
  );
});

test('a Skill load pair keeps the next request a delta continuation', () => {
  const skillItem = { type: 'function_call', call_id: skillCall.id, name: 'Skill', arguments: '{"name":"deck-guide"}' };
  const initial = [{ role: 'user', content: 'Create a deck.' }];
  const assistant = {
    role: 'assistant',
    content: '',
    toolCalls: [skillCall],
    providerReplay: createProviderReplay('openai-responses', [skillItem]),
  };
  const tools = [SKILL_TOOL, TOOL_SEARCH_TOOL];
  const opts = { sessionId: 'skill-test' };
  const before = buildRequestBody(initial, 'gpt-6-astra', tools, opts);
  const after = buildRequestBody([...initial, assistant, skillResult], 'gpt-6-astra', tools, opts);
  assert.deepEqual(after.tools, before.tools);
  assert.equal(after.prompt_cache_key, before.prompt_cache_key);
  assert.deepEqual(after.input.slice(0, before.input.length), before.input);
  const previous = process.env.MIXDOG_OAI_TRANSPORT;
  process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
  try {
    const delta = _computeDelta({
      traceProvider: 'openai-oauth',
      body: after,
      entry: {
        lastResponseId: 'previous-response',
        lastRequestInput: before.input,
        lastRequestSansInput: _stableStringify(_sansInput(before)),
        lastResponseItems: [skillItem],
      },
    });
    assert.equal(delta.mode, 'delta');
    assert.deepEqual(
      delta.frame.input.map((item) => [item.type, item.call_id]),
      [
        ['function_call_output', 'skill-call'],
        ['tool_search_call', 'skill-call_load'],
        ['tool_search_output', 'skill-call_load'],
      ]
    );
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_OAI_TRANSPORT;
    else process.env.MIXDOG_OAI_TRANSPORT = previous;
  }
});

test('all Responses streaming transports dispatch the same native load_tool call exactly once', async () => {
  const events = [
    { type: 'response.created', response: { id: 'skill-response', model: 'gpt-6-astra' } },
    { type: 'response.output_item.added', item: responseItem },
    { type: 'response.output_item.done', item: responseItem },
    {
      type: 'response.completed',
      response: {
        id: 'skill-response',
        model: 'gpt-6-astra',
        status: 'completed',
        output: [responseItem],
        usage: { input_tokens: 1024, output_tokens: 20 },
      },
    },
  ];
  for (const transport of ['http-sse', 'websocket', 'compat']) {
    const emitted = [];
    const onToolCall = (value) => emitted.push(value);
    let output;
    if (transport === 'http-sse') {
      output = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'test' },
        body: { model: 'gpt-6-astra', tools: [] },
        useModel: 'gpt-6-astra',
        onToolCall,
        fetchFn: async () =>
          new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
            headers: { 'content-type': 'text/event-stream' },
          }),
      });
    } else if (transport === 'websocket') {
      const socket = new EventEmitter();
      socket.readyState = 1;
      const pending = _streamResponse({ entry: { socket }, state: {}, onToolCall });
      for (const event of events) socket.emit('message', Buffer.from(JSON.stringify(event)));
      output = await pending;
    } else {
      output = await consumeCompatResponsesStream(
        {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
        },
        { onToolCall, parseResponsesToolCalls, responseOutputText, label: 'skill-test' }
      );
    }
    assert.deepEqual(output.toolCalls, [call], transport);
    assert.deepEqual(emitted, [call], transport);
  }
});
