import '../../../shared/llm/usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger } from '../../../shared/llm/usage-ledger.mjs';
import { accountProviderSend } from '../../../shared/llm/usage-accounting.mjs';
import { createTerminalFrameEvents } from './openai-http-sse-response-state/response-events/terminal-frames.mjs';
import { createTerminalFrameHandlers } from './openai-ws-stream/terminal-frames.mjs';
import { createWsResponseState } from './openai-ws-response-state.mjs';
import { handleCompatResponsesStreamEvent } from './openai-compat-responses-events.mjs';
import { attachPartialState } from './openai-compat-responses-state.mjs';
import { responsesUsage } from './openai-compat-response-normalization.mjs';
import { consumeCompatChatCompletionStream } from './openai-compat-chat-stream.mjs';
import { parseToolCalls } from './openai-compat.mjs';

function useLedger(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-failed-usage-')), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  return () => {
    const ledger = new UsageLedger(path);
    try {
      return ledger.db.prepare('SELECT * FROM events ORDER BY session_id').all();
    } finally {
      ledger.close();
    }
  };
}

const usage = { input_tokens: 1000, output_tokens: 100 };
const failedFrames = [
  { type: 'response.failed', response: { status: 'failed', model: 'm-1', error: { message: 'boom' }, usage } },
  { type: 'response.done', response: { status: 'failed', model: 'm-1', error: { message: 'boom' }, usage } },
];

const sseThrow = (event) => {
  const state = {};
  const frames = createTerminalFrameEvents({ state, items: {}, text: {}, outcome: {}, meaningful() {} });
  if (event.type === 'response.failed') throw frames.failedFrameError(event);
  frames.onDone(event);
};
const wsThrow = (event) => {
  const midState = {};
  const response = createWsResponseState({ midState, traceProvider: 'openai' });
  const outcome = {};
  const handlers = createTerminalFrameHandlers({
    response,
    textRelay: {},
    midState,
    errLabel: 'ws',
    progress() {},
    outcome,
    finish() {},
  });
  if (event.type === 'response.failed') handlers.onResponseFailed(event);
  else handlers.onResponseDone(event);
  throw outcome.terminalError;
};
const compatThrow = (event) => {
  const state = { model: '', content: '', toolCalls: [], pendingCalls: new Map() };
  try {
    handleCompatResponsesStreamEvent(event, state, { label: 'x' });
  } catch (error) {
    attachPartialState(error, state, []);
    throw error;
  }
};

for (const [name, thrower] of [
  ['HTTP-SSE', sseThrow],
  ['WS', wsThrow],
  ['compat Responses', compatThrow],
]) {
  test(`${name} failed terminal frames record the reported usage once`, async (t) => {
    const readRows = useLedger(t);
    for (const [i, event] of failedFrames.entries()) {
      await assert.rejects(
        accountProviderSend('openai', {}, async () => thrower(event), 'req-model', { sessionId: `s${i}` })
      );
    }
    const rows = readRows();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.input, 1000);
      assert.equal(row.output, 100);
    }
  });
}

async function* chunks(values) {
  yield* values;
}
const toolChunk = {
  model: 'm-1',
  choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'x', arguments: '{"a":' } }] } }],
};
const usageChunk = { choices: [], usage: { prompt_tokens: 500, completion_tokens: 40, cost: 0.5 } };

test('compat chat truncated and unfinished streams record received usage only', async (t) => {
  const readRows = useLedger(t);
  const run =
    (values, parse = parseToolCalls) =>
    () =>
      consumeCompatChatCompletionStream(chunks(values), {
        label: 'openrouter',
        providerName: 'openrouter',
        parseToolCalls: parse,
      });
  const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] };
  const failParse = () => {
    throw new Error('unparseable tool call');
  };
  const cases = [
    ['a-parse-failure-with-usage', [toolChunk, stop, usageChunk], failParse],
    ['b-unfinished-with-usage', [toolChunk, usageChunk]],
    ['c-unfinished-no-usage', [toolChunk]],
    ['d-parse-failure-no-usage', [toolChunk, stop], failParse],
  ];
  for (const [sessionId, values, parse] of cases) {
    await assert.rejects(accountProviderSend('openrouter', {}, run(values, parse), 'm-1', { sessionId }));
  }
  const rows = readRows();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.input, 500);
    assert.equal(row.output, 40);
    assert.equal(row.cost_usd, 0.5);
    assert.equal(row.cost_source, 'provider');
  }
});

test('Responses reported cost is shared by success and incomplete paths', async (t) => {
  const readRows = useLedger(t);
  const body = (cost) => ({ input_tokens: 500, output_tokens: 40, cost });
  const send = (sessionId, cost, fail) =>
    accountProviderSend(
      'custom',
      {},
      async () => {
        const u = responsesUsage(body(cost));
        if (fail) throw Object.assign(new Error('incomplete'), { partialUsage: u, partialModel: 'm' });
        return { content: '', model: 'm', usage: u };
      },
      'm',
      { sessionId }
    );
  await send('a', 0.5, false);
  await assert.rejects(send('b', 0.5, true));
  await send('c', null, false);
  const rows = readRows();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cost_usd, 0.5);
  assert.equal(rows[0].cost_source, 'provider');
  assert.equal(rows[1].cost_usd, rows[0].cost_usd);
  assert.equal(rows[1].cost_source, 'provider');
  assert.notEqual(rows[2].cost_source, 'provider');
  assert.equal(responsesUsage(body('0.25')).costUsd, 0.25);
  assert.equal(responsesUsage(body(null)).costUsd, undefined);
});

test('cache-write tokens split inclusive input once', async (t) => {
  const readRows = useLedger(t);
  const u = responsesUsage({
    input_tokens: 1000,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
  });
  await accountProviderSend('custom', {}, async () => ({ content: '', model: 'm', usage: u }), 'm', {
    sessionId: 'a',
  });
  const [row] = readRows();
  assert.equal(row.input, 500);
  assert.equal(row.cache_read, 200);
  assert.equal(row.cache_write, 300);
  assert.equal(row.output, 100);
});
