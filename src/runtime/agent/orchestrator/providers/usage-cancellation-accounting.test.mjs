import '../../../shared/llm/usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger } from '../../../shared/llm/usage-ledger.mjs';
import { accountProviderSend } from '../../../shared/llm/usage-accounting.mjs';
import { noteAbandonedUsage } from '../../../shared/llm/usage-context.mjs';
import { consumeGeminiRestStreamResponse } from './gemini-stream.mjs';
import { geminiFailureUsage, normalizeGeminiUsage } from './gemini-response.mjs';
import { consumeCompatChatCompletionStream } from './openai-compat-chat-stream.mjs';
import { parseSSEStream } from './anthropic-sse.mjs';

test('a cancelled Anthropic SSE turn keeps the usage message_start reported', async (t) => {
  const readRows = useLedger(t);
  const controller = new AbortController();
  const start = new TextEncoder().encode(
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { model: 'claude-opus-5', usage: { input_tokens: 100, cache_read_input_tokens: 900 } },
    })}\n\n`
  );
  let sent = false;
  let hang;
  const response = {
    body: {
      getReader: () => ({
        read() {
          if (!sent) {
            sent = true;
            return Promise.resolve({ done: false, value: start });
          }
          return new Promise((_, reject) => {
            hang = reject;
          });
        },
        cancel() {
          hang?.(new Error('cancelled'));
          return Promise.resolve();
        },
        releaseLock() {},
      }),
    },
  };
  const state = {
    attemptIndex: 0,
    sawMessageStart: false,
    sawCompleted: false,
    emittedToolCall: false,
    partialToolCall: false,
    emittedThinking: false,
    emittedText: false,
  };
  const run = accountProviderSend(
    'anthropic',
    { constructor: { inputExcludesCache: true } },
    () =>
      parseSSEStream(
        response,
        controller.signal,
        () => {},
        () => {},
        () => {},
        state,
        () => {}
      ),
    'claude-opus-5',
    { sessionId: 'anthropic-cancel' }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error('caller cancel'));
  await assert.rejects(run, /caller cancel/);
  assert.equal(controller.signal.reason.partialUsage, undefined);
  const rows = readRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 100);
  assert.equal(rows[0].cache_read, 900);
});

function useLedger(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-cancel-usage-')), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  return () => {
    const ledger = new UsageLedger(path);
    try {
      return ledger.db.prepare('SELECT * FROM events ORDER BY input').all();
    } finally {
      ledger.close();
    }
  };
}

// One SSE chunk, then a body that stays open until the reader is cancelled.
const openGeminiBody = (chunk) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      },
    })
  );

test('concurrent Gemini streams cancelled by one shared reason each keep their own reported usage', async (t) => {
  const readRows = useLedger(t);
  const model = 'gemini-2.5-pro';
  const shared = new AbortController();
  const send = (sessionId, prompt, output) =>
    accountProviderSend(
      'gemini',
      {},
      () =>
        consumeGeminiRestStreamResponse(
          openGeminiBody({
            candidates: [{ content: { parts: [{ text: 'x' }] } }],
            usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: output },
          }),
          { signal: shared.signal, label: 'rest', failureUsage: geminiFailureUsage({}, null, model) }
        ),
      model,
      { sessionId }
    );
  const runs = [send('a', 100, 10), send('b', 200, 20)];
  await new Promise((resolve) => setTimeout(resolve, 20));
  shared.abort(new Error('shared cancel'));
  for (const run of runs) await assert.rejects(run, /shared cancel/);
  assert.equal(shared.signal.reason.partialUsage, undefined, 'the shared reason is never stamped');
  const rows = readRows();
  assert.deepEqual(
    rows.map((row) => [row.session_id, row.input, row.output]),
    [
      ['a', 100, 10],
      ['b', 200, 20],
    ]
  );
});

test('a cancelled compat chat stream keeps the usage chunk it already received', async (t) => {
  const readRows = useLedger(t);
  const controller = new AbortController();
  let release;
  const stream = {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next() {
          if (!sent) {
            sent = true;
            return Promise.resolve({
              done: false,
              value: { id: 'c1', model: 'm', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } },
            });
          }
          return new Promise((resolve) => {
            release = resolve;
          });
        },
        return() {
          release?.({ done: true });
          return Promise.resolve({ done: true });
        },
      };
    },
  };
  const run = accountProviderSend(
    'openrouter',
    {},
    () =>
      consumeCompatChatCompletionStream(stream, {
        signal: controller.signal,
        label: 'chat',
        providerName: 'openrouter',
      }),
    'm',
    { sessionId: 'chat' }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error('caller cancel'));
  await assert.rejects(run, /caller cancel/);
  assert.equal(controller.signal.reason.partialUsage, undefined);
  const rows = readRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input + rows[0].cache_read, 1000);
  assert.equal(rows[0].output, 100);
});

test('a noted cost-only report whose error surfaces is recorded once with its cost', async (t) => {
  const readRows = useLedger(t);
  await assert.rejects(
    accountProviderSend(
      'openrouter',
      {},
      async () => {
        const usage = { costUsd: 0.5 };
        noteAbandonedUsage(usage, 'm');
        throw Object.assign(new Error('failed'), { usage, model: 'm' });
      },
      'm',
      { sessionId: 'cost' }
    ),
    /failed/
  );
  const rows = readRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost_usd, 0.5);
  assert.equal(rows[0].input + rows[0].output, 0);
});

test('Gemini accounting records only the cached tokens the response reported', () => {
  const { resolvedUsage } = normalizeGeminiUsage(
    { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 50 },
    { providerState: { gemini: { cacheTokenSize: 800 } } },
    { name: 'cachedContents/x' }
  );
  assert.equal(resolvedUsage.inputTokens, 1000);
  assert.equal(resolvedUsage.cachedTokens, 0);
});
