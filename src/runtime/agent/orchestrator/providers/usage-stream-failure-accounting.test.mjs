import '../../../shared/llm/usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger } from '../../../shared/llm/usage-ledger.mjs';
import { accountProviderSend } from '../../../shared/llm/usage-accounting.mjs';
import { consumeGeminiRestStreamResponse, consumeGeminiSdkStream } from './gemini-stream.mjs';
import { geminiFailureUsage } from './gemini-response.mjs';
import { createAntigravityStreamCollector } from './antigravity-stream.mjs';
import { createStreamSink } from './cursor-wire-stream-sink.mjs';
import { createAnthropicMidstreamRecovery, createAnthropicMidState } from './anthropic-midstream-recovery.mjs';

function useLedger(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-stream-failure-usage-')), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  return () => {
    const ledger = new UsageLedger(path);
    try {
      return ledger.db.prepare('SELECT * FROM events').all();
    } finally {
      ledger.close();
    }
  };
}
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

const model = 'gemini-2.5-pro';
const withUsage = {
  candidates: [{ content: { parts: [{ text: 'partial' }] } }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 },
};
const withoutUsage = { candidates: [{ content: { parts: [{ text: 'partial' }] } }] };

const sseBody = (chunks) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''));
const sdkStream = (chunks) => ({
  stream: (async function* () {
    yield* chunks;
  })(),
  response: Promise.resolve({}),
});
const antigravityConsume = (chunks) => {
  const collector = createAntigravityStreamCollector({ tools: [], useModel: model });
  collector.beginAttempt();
  return collector.consume(sseBody(chunks.map((response) => ({ response }))), undefined);
};
const consumers = {
  'Gemini REST': (chunks) =>
    consumeGeminiRestStreamResponse(sseBody(chunks), {
      label: 'rest',
      failureUsage: geminiFailureUsage({}, null, model),
    }),
  'Gemini SDK': (chunks) =>
    consumeGeminiSdkStream(sdkStream(chunks), { label: 'sdk', failureUsage: geminiFailureUsage({}, null, model) }),
  Antigravity: antigravityConsume,
};

for (const [name, consume] of Object.entries(consumers)) {
  test(`${name} stream ending without finishReason records the reported usage once`, async (t) => {
    const readRows = useLedger(t);
    await assert.rejects(
      accountProviderSend('gemini', {}, () => consume([withUsage]), model, { sessionId: 's' }),
      /no finishReason/
    );
    const rows = readRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input, 1000);
    assert.equal(rows[0].output, 150);
  });

  test(`${name} stream failure without usageMetadata records nothing`, async (t) => {
    const readRows = useLedger(t);
    await assert.rejects(accountProviderSend('gemini', {}, () => consume([withoutUsage]), model, { sessionId: 's' }));
    assert.equal(readRows().length, 0);
  });
}

test('Cursor stream failure carries provider-reported output with unknown input', async (t) => {
  const readRows = useLedger(t);
  const state = { closed: false, outputTokens: 42, contextTokens: 7 };
  let streamError;
  const sink = createStreamSink({
    controller: { enqueue() {}, close() {}, error: (e) => (streamError = e) },
    id: 'x',
    model: 'auto',
    filter: { flush: () => ({}) },
    watchdog: { stop() {} },
    state,
  });
  sink.fail(new Error('boom'));
  assert.equal(streamError.partialUsage.outputTokens, 42);
  assert.equal(streamError.partialUsage.inputTokensKnown, false);
  assert.equal(streamError.partialUsage.inputTokens, null);
  streamError.partialModel = 'auto';
  await assert.rejects(
    accountProviderSend(
      'cursor',
      {},
      async () => {
        throw streamError;
      },
      'auto',
      { sessionId: 'c' }
    )
  );
  const rows = readRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].output, 42);

  const noOutput = { closed: false, outputTokens: 0, contextTokens: null };
  let bare;
  createStreamSink({
    controller: { enqueue() {}, close() {}, error: (e) => (bare = e) },
    id: 'x',
    model: 'auto',
    filter: { flush: () => ({}) },
    watchdog: { stop() {} },
    state: noOutput,
  }).fail(new Error('boom'));
  assert.equal(bare.partialUsage, undefined);
});

const usage = (inputTokens, outputTokens) => ({ inputTokens, outputTokens, cachedTokens: 0 });
const recoveryWith = (recoverNonStreaming) =>
  createAnthropicMidstreamRecovery({
    label: 'test',
    outcomeProvider: 'anthropic',
    midstreamOwner: 'test',
    unreachableMessage: 'unreachable',
    maxRetries: 0,
    totalSignal: null,
    recovery: { recoverNonStreaming, issueNonStreamingFallback() {}, requireTransportRecoveryBudget() {} },
  });
const exposedArgs = (err) => {
  const midState = createAnthropicMidState(0);
  midState.emittedText = true;
  return { err, midState, controller: null, response: null, attemptIndex: 0 };
};
const originalError = () =>
  Object.assign(new Error('cut'), { partialUsage: usage(100, 10), partialModel: 'claude-sonnet-4-5' });

test('Anthropic recovery records the original attempt exactly once in every outcome', async (t) => {
  const readRows = useLedger(t);
  const run = (sessionId, recoverNonStreaming) => {
    const recovery = recoveryWith(recoverNonStreaming);
    const err = originalError();
    return accountProviderSend(
      'anthropic',
      {},
      async () => {
        const decision = await recovery.onStreamError(exposedArgs(err));
        return { content: 'ok', model: 'claude-sonnet-4-5', usage: decision.value.usage };
      },
      'claude-sonnet-4-5',
      { sessionId }
    );
  };
  await run('recovered', async () => ({ usage: usage(200, 20) }));
  let rows = readRows();
  assert.equal(rows.length, 2);
  assert.equal(sum(rows, 'input'), 300);
  assert.equal(sum(rows, 'output'), 30);

  await assert.rejects(
    run('failed', async () => {
      throw Object.assign(new Error('fallback failed'), {
        partialUsage: usage(200, 20),
        partialModel: 'claude-sonnet-4-5',
      });
    }),
    /fallback failed/
  );
  rows = readRows().filter((row) => row.session_id === 'failed');
  assert.equal(rows.length, 2);
  assert.equal(sum(rows, 'input'), 300);
  assert.equal(sum(rows, 'output'), 30);

  await assert.rejects(
    accountProviderSend(
      'anthropic',
      {},
      async () => {
        const err = originalError();
        await recoveryWith(async () => {
          throw err;
        }).onStreamError(exposedArgs(err));
      },
      'claude-sonnet-4-5',
      { sessionId: 'surfaced' }
    ),
    /cut/
  );
  rows = readRows().filter((row) => row.session_id === 'surfaced');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 100);
  assert.equal(rows[0].output, 10);
});
