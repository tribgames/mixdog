import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeCompatChatCompletionStream } from './openai-compat-stream.mjs';
import { normalizeCompatChatResponse } from './openai-compat-response-normalization.mjs';

function arrayStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

const parseToolCalls = (choice) =>
  choice.message.tool_calls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || '{}'),
  }));

const toolDelta = (args, extra = {}) => ({
  choices: [{ delta: { tool_calls: [{ index: 0, ...extra, function: { arguments: args, ...extra.function } }] } }],
});

async function consume(events, onToolCall) {
  return consumeCompatChatCompletionStream(arrayStream(events), {
    label: 'gateway',
    providerName: 'gateway',
    parseToolCalls,
    onToolCall,
  });
}

test('a fragment repeating the accumulated prefix is concatenated verbatim', async () => {
  const result = await consumeCompatChatCompletionStream(
    arrayStream([
      toolDelta('{"a":"', { id: 'c1', function: { name: 'f' } }),
      toolDelta('{"a":"'),
      toolDelta('"}'),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    { label: 'gateway', providerName: 'gateway', parseToolCalls: (choice) => choice.message.tool_calls }
  );
  assert.equal(result.response.choices[0].message.tool_calls[0].function.arguments, '{"a":"{"a":""}');
});

test('normal fragmented streams dispatch the call once with the joined arguments', async () => {
  const dispatched = [];
  const result = await consume(
    [
      toolDelta('', { id: 'c1', function: { name: 'f' } }),
      toolDelta('{"x"'),
      toolDelta(':1}'),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ],
    (call) => dispatched.push(call)
  );
  assert.deepEqual(dispatched, [{ id: 'c1', name: 'f', arguments: { x: 1 } }]);
  assert.deepEqual(result.toolCalls, dispatched);
});

for (const finish of ['length', 'content_filter']) {
  test(`finish_reason=${finish} never dispatches a tool call and stays a partial result`, async () => {
    const dispatched = [];
    const assembled = await consume(
      [
        toolDelta('{"x":1}', { id: 'c1', function: { name: 'f' } }),
        { choices: [{ delta: {}, finish_reason: finish }] },
      ],
      (call) => dispatched.push(call)
    );
    assert.equal(dispatched.length, 0);
    assert.equal(assembled.toolCalls.length, 1);
    assert.throws(
      () => normalizeCompatChatResponse({ providerName: 'gateway', useModel: 'm', opts: {}, assembled }),
      (error) =>
        error.providerIncomplete === true && error.finishReason === finish && error.partialToolCalls.length === 1
    );
  });
}

test('a tool call leaked into text runs only after a normal finish_reason', async () => {
  const leak = '<invoke name="f"><parameter name="x">1</parameter></invoke>';
  const run = async (finish) => {
    const dispatched = [];
    const events = [{ choices: [{ delta: { content: leak } }] }, { choices: [{ delta: {}, finish_reason: finish }] }];
    let error = null;
    try {
      await consumeCompatChatCompletionStream(arrayStream(events), {
        label: 'gateway',
        providerName: 'gateway',
        parseToolCalls,
        knownToolNames: new Set(['f']),
        onToolCall: (call) => dispatched.push(call),
      });
    } catch (e) {
      error = e;
    }
    return { dispatched, error };
  };
  assert.equal((await run('stop')).dispatched.length, 1);
  for (const finish of ['length', 'content_filter']) assert.equal((await run(finish)).dispatched.length, 0);
  const failed = await run('network_error');
  assert.equal(failed.dispatched.length, 0);
  assert.ok(failed.error);
});
