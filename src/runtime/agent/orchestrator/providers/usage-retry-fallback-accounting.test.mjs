import '../../../shared/llm/usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger } from '../../../shared/llm/usage-ledger.mjs';
import { accountProviderSend } from '../../../shared/llm/usage-accounting.mjs';
import { createStreamSafetyStamps, withRetry } from './retry-classifier.mjs';
import { createWsSendAttempts, MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT } from './openai-ws-send-attempts.mjs';
import { recoverCompatNonStreaming } from './openai-compat-chat-send.mjs';

function useLedger(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-retry-usage-')), 'ledger.sqlite');
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
const usage = (inputTokens, outputTokens) => ({ inputTokens, outputTokens, cachedTokens: 0 });
const failed = (message, extra, u) =>
  Object.assign(new Error(message), extra, { partialUsage: u, partialModel: 'test-model' });
const account = (sessionId, send) => accountProviderSend('openai', {}, send, 'test-model', { sessionId });

function wsAttempts() {
  return createWsSendAttempts({
    externalSignal: null,
    sleepFn: async () => {},
    sendSpan: { retryBackoffMs: 0, poolAcquireMs: 0, poolOwnerWaitMs: 0, emit() {} },
    emitReconnectProgress() {},
    safetyStamps: createStreamSafetyStamps(),
    handshakeErrorPolicy: null,
    retry429: true,
    stallRetryBudget: { allowStallRetry: () => true },
    trace: { poolKey: 'usage-test', traceProvider: 'openai-oauth', useModel: 'test-model' },
    auth: null,
    body: {},
  });
}
const handshakeInfo = (attemptIndex) => ({
  attemptIndex,
  handshakeStart: 0,
  handshakeRetries: 0,
  handshakeRetryClassifiers: [],
});

test('withRetry records the failed attempt and the successful one', async (t) => {
  const readRows = useLedger(t);
  let calls = 0;
  await account('retry', () =>
    withRetry(
      async () => {
        if (calls++ === 0) throw failed('reset', { code: 'ECONNRESET' }, usage(1000, 100));
        return { content: 'ok', model: 'test-model', usage: usage(200, 20) };
      },
      { backoffMs: [0], sleepFn: async () => {} }
    )
  );
  const rows = readRows();
  assert.equal(calls, 2);
  assert.equal(rows.length, 2);
  assert.equal(sum(rows, 'input'), 1200);
  assert.equal(sum(rows, 'output'), 120);
});

test('OpenAI WS midstream retry records the failed frame and the successful one', async (t) => {
  const readRows = useLedger(t);
  const attempts = wsAttempts();
  await account('ws-retry', async () => {
    const err = failed('gone', { wsCloseCode: 1006 }, usage(500, 50));
    const entry = { socket: { readyState: 3, close() {}, terminate() {} }, busy: true, lastResponseId: null };
    const midState = {
      attemptIndex: 0,
      sawResponseCreated: true,
      sawCompleted: false,
      emittedText: false,
      emittedToolCall: false,
      emittedReasoning: false,
      startedToolCall: false,
    };
    assert.equal(await attempts.streamFailed(err, { attemptIndex: 0, entry, midState }), true);
    return { content: 'ok', model: 'test-model', usage: usage(300, 30) };
  });
  const rows = readRows();
  assert.equal(rows.length, 2);
  assert.equal(sum(rows, 'input'), 800);
  assert.equal(sum(rows, 'output'), 80);
});

test('OpenAI WS exhaustion re-throwing the first error records each attempt once', async (t) => {
  const readRows = useLedger(t);
  const attempts = wsAttempts();
  const first = failed('first reset', { code: 'ECONNRESET' }, usage(100, 10));
  await assert.rejects(
    account('ws-exhausted', async () => {
      assert.equal(await attempts.handshakeFailed(first, handshakeInfo(0)), true);
      const last = failed('last reset', { code: 'ECONNRESET' }, usage(200, 20));
      await attempts.handshakeFailed(last, handshakeInfo(MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT));
    }),
    (e) => e === first
  );
  const rows = readRows();
  assert.equal(rows.length, 2);
  assert.equal(sum(rows, 'input'), 300);
  assert.equal(sum(rows, 'output'), 30);
});

test('openai-compat non-streaming fallback records the failed stream and the fallback', async (t) => {
  const readRows = useLedger(t);
  const provider = {
    name: 'compat',
    client: {
      chat: {
        completions: {
          create: async () => ({
            model: 'test-model',
            choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
          }),
        },
      },
    },
  };
  const streamErr = failed('stream cut', { code: 'ECONNRESET' }, usage(700, 70));
  await account('compat-fallback', async () => {
    const recovered = await recoverCompatNonStreaming(provider, {
      streamErr,
      params: { model: 'test-model', stream: true },
      opts: {},
      signal: null,
      useModel: 'test-model',
    });
    assert.ok(recovered);
    return { content: recovered.content, model: 'test-model', usage: usage(400, 40) };
  });
  const rows = readRows();
  assert.equal(rows.length, 2);
  assert.equal(sum(rows, 'input'), 1100);
  assert.equal(sum(rows, 'output'), 110);
});
