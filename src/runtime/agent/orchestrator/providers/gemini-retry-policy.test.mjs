import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEMINI_MIDSTREAM_MAX_ATTEMPTS,
  GEMINI_REQUEST_RETRY,
  geminiEndsWithFunctionResponse,
  geminiInvalidStreamReason,
  geminiMidstreamDelayMs,
  runGeminiStreamAttempts,
} from './gemini-retry-policy.mjs';
import { isProviderRecoveryExhausted, isProviderRecoveryTerminal } from './retry-classifier.mjs';
import { streamGeminiSdkAttempt } from './gemini-sdk-request.mjs';

const http = (status, extra = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status, httpStatus: status, initialResponseError: true, ...extra });
const truncated = () => Object.assign(new Error('cut'), { code: 'TRUNCATED_STREAM', truncatedStream: true });
const good = {
  response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] },
  textLeakGuard: null,
};

function harness(script) {
  const sleeps = [];
  let calls = 0;
  const run = async ({ connected }) => {
    const step = script[Math.min(calls++, script.length - 1)];
    return step({ connected });
  };
  return {
    sleeps,
    get calls() {
      return calls;
    },
    go: () => runGeminiStreamAttempts({ run, sleepFn: async (ms) => sleeps.push(ms) }),
  };
}

const within = (value, base, ratio) => value >= base * (1 - ratio) - 1 && value <= base * (1 + ratio) + 1;

test('connection phase: 10 attempts, 5s doubling to a 30s cap, ±30% jitter', async () => {
  assert.equal(GEMINI_REQUEST_RETRY.maxAttempts, 10);
  const h = harness([() => Promise.reject(http(503))]);
  await assert.rejects(h.go(), (error) => {
    assert.equal(error.status, 503);
    assert.equal(isProviderRecoveryExhausted(error), true);
    return true;
  });
  assert.equal(h.calls, 10);
  const bases = [5000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];
  assert.equal(h.sleeps.length, 9);
  h.sleeps.forEach((ms, index) => assert.ok(within(ms, bases[index], 0.3), `${index}: ${ms}`));
});

test('request ladder options: 499 retried, advice jittered upward and never below the backoff step', () => {
  assert.equal(GEMINI_REQUEST_RETRY.retry499, true);
  assert.equal(GEMINI_REQUEST_RETRY.retryAfterJitterRatio, 0.2);
  assert.equal(GEMINI_REQUEST_RETRY.adviceAtLeastBackoff, true);
});

test('connection phase: a server-advised wait is honored in full, with only upward jitter', async () => {
  const h = harness([
    () => Promise.reject(http(429, { code: 'rate_limit_exceeded', retryAfterMs: 7000 })),
    async () => good,
  ]);
  assert.equal(await h.go(), good);
  assert.equal(h.sleeps.length, 1);
  assert.ok(h.sleeps[0] >= 7000 && h.sleeps[0] <= 8400, `${h.sleeps[0]}`);
});

test('connection phase: advice shorter than the backoff step is raised to the step', async () => {
  const h = harness([
    () => Promise.reject(http(429, { code: 'rate_limit_exceeded', retryAfterMs: 500 })),
    async () => good,
  ]);
  assert.equal(await h.go(), good);
  assert.ok(h.sleeps[0] >= 3500, `${h.sleeps[0]}`);
});

test('connection phase: a 499 is retried', async () => {
  const h = harness([() => Promise.reject(http(499)), async () => good]);
  assert.equal(await h.go(), good);
  assert.equal(h.calls, 2);
});

test('stream phase: a typed 499 is not retried', () => {
  assert.equal(geminiMidstreamDelayMs(http(499, { code: 'invalid_argument' }), 0), null);
  assert.equal(geminiMidstreamDelayMs(http(499, { code: 'permission_denied' }), 0), null);
});

test('stream phase: a 499 is retried on the stream ladder', async () => {
  assert.equal(geminiMidstreamDelayMs(http(499), 0), 1000);
  const h = harness([
    async ({ connected }) => {
      connected();
      throw http(499);
    },
    async () => good,
  ]);
  assert.equal(await h.go(), good);
  assert.deepEqual(h.sleeps, [1000]);
});

const longAdvice = (ms) => http(429, { code: 'rate_limit_exceeded', retryAfterMs: ms, resetAt: Date.now() + ms });

test('connection phase: advice over 300s is terminal, not quota, and keeps its display fields', async () => {
  const h = harness([() => Promise.reject(longAdvice(400_000)), async () => good]);
  await assert.rejects(h.go(), (error) => {
    assert.equal(error.retryAfterMs, 400_000);
    assert.ok(error.resetAt > Date.now());
    assert.equal(error.quotaScope, undefined);
    assert.equal(isProviderRecoveryTerminal(error), true);
    return true;
  });
  assert.equal(h.calls, 1);
  assert.deepEqual(h.sleeps, []);
});

test('connection phase: advice of exactly 300s is still a retry', async () => {
  const h = harness([() => Promise.reject(longAdvice(300_000)), async () => good]);
  assert.equal(await h.go(), good);
  assert.equal(h.calls, 2);
});

test('stream phase: advice over 300s is terminal too', async () => {
  const h = harness([
    async ({ connected }) => {
      connected();
      throw longAdvice(400_000);
    },
    async () => good,
  ]);
  await assert.rejects(h.go(), (error) => {
    assert.equal(error.quotaScope, undefined);
    assert.equal(isProviderRecoveryTerminal(error), true);
    return true;
  });
  assert.equal(h.calls, 1);
  assert.equal(geminiMidstreamDelayMs(longAdvice(400_000), 0), null);
  assert.equal(geminiMidstreamDelayMs(longAdvice(300_000), 0), 300_000);
});

test('connection phase: a spent daily quota is not retried', async () => {
  const h = harness([() => Promise.reject(http(429, { code: 'resource_exhausted', quotaScope: 'day' }))]);
  await assert.rejects(h.go());
  assert.equal(h.calls, 1);
});

test('stream phase: 4 attempts total at 1s / 2s / 4s with no jitter', async () => {
  const h = harness([
    async ({ connected }) => {
      connected();
      throw truncated();
    },
  ]);
  await assert.rejects(h.go(), (error) => {
    assert.equal(error.code, 'TRUNCATED_STREAM');
    assert.equal(isProviderRecoveryExhausted(error), true);
    return true;
  });
  assert.equal(h.calls, GEMINI_MIDSTREAM_MAX_ATTEMPTS);
  assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
});

test('stream phase: each re-open gets its own connection ladder', async () => {
  const h = harness([
    async ({ connected }) => {
      connected();
      throw truncated();
    },
    () => Promise.reject(http(503)),
    async () => good,
  ]);
  assert.equal(await h.go(), good);
  assert.equal(h.calls, 3);
  assert.equal(h.sleeps[0], 1000);
  assert.ok(within(h.sleeps[1], 5000, 0.3));
});

test('stream phase: output already relayed is never re-issued', async () => {
  const h = harness([
    async ({ connected }) => {
      connected();
      throw Object.assign(truncated(), { liveTextEmitted: true, unsafeToRetry: true });
    },
  ]);
  await assert.rejects(h.go());
  assert.equal(h.calls, 1);
});

test('stream phase: a deterministic refusal is not re-issued', async () => {
  const h = harness([
    async ({ connected }) => {
      connected();
      throw http(429, { code: 'quota_exceeded', quotaScope: 'plan' });
    },
  ]);
  await assert.rejects(h.go());
  assert.equal(h.calls, 1);
});

test('stream phase: an in-band rate limit is retried on the advised wait', async () => {
  const h = harness([
    async ({ connected }) => {
      connected();
      throw Object.assign(new Error('in-band'), { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 3000 });
    },
    async () => good,
  ]);
  assert.equal(await h.go(), good);
  assert.deepEqual(h.sleeps, [3000]);
});

test('midstream delay is null once the budget is spent or the signal aborted', () => {
  assert.equal(geminiMidstreamDelayMs(truncated(), 0), 1000);
  assert.equal(geminiMidstreamDelayMs(truncated(), 2), 4000);
  assert.equal(geminiMidstreamDelayMs(truncated(), 3), null);
  const aborted = AbortSignal.abort();
  assert.equal(geminiMidstreamDelayMs(truncated(), 0, aborted), null);
});

const response = (finishReason, parts) => ({ candidates: [{ finishReason, content: { parts } }] });

test('invalid stream: empty text, malformed and unexpected tool calls are unusable', () => {
  assert.equal(geminiInvalidStreamReason(response('STOP', [])), 'NO_RESPONSE_TEXT');
  assert.equal(geminiInvalidStreamReason(response('STOP', [{ text: '\u200b ' }])), 'NO_RESPONSE_TEXT');
  assert.equal(geminiInvalidStreamReason(response('STOP', [{ text: 'thinking', thought: true }])), 'NO_RESPONSE_TEXT');
  assert.equal(geminiInvalidStreamReason(response('MALFORMED_FUNCTION_CALL', [])), 'MALFORMED_FUNCTION_CALL');
  assert.equal(geminiInvalidStreamReason(response('FINISH_REASON_UNEXPECTED_TOOL_CALL', [])), 'UNEXPECTED_TOOL_CALL');
});

test('invalid stream: tool calls, text, refusals and output limits are not retried', () => {
  assert.equal(geminiInvalidStreamReason(response('STOP', [{ functionCall: { name: 'a', args: {} } }])), null);
  assert.equal(geminiInvalidStreamReason(response('STOP', [{ text: 'hello' }])), null);
  assert.equal(geminiInvalidStreamReason(response('SAFETY', [])), null);
  assert.equal(geminiInvalidStreamReason(response('RECITATION', [])), null);
  assert.equal(geminiInvalidStreamReason(response('MAX_TOKENS', [])), null);
  assert.equal(
    geminiInvalidStreamReason(response('MALFORMED_FUNCTION_CALL', []), { getRelayedText: () => 'seen' }),
    null
  );
  assert.equal(geminiInvalidStreamReason(response('STOP', []), { getLeakedToolCalls: () => [{ name: 'a' }] }), null);
});

test('invalid stream: an empty response right after a tool result is accepted', () => {
  const after = { afterToolResult: true };
  assert.equal(geminiInvalidStreamReason(response('STOP', []), null, after), null);
  assert.equal(geminiInvalidStreamReason(response('STOP', [{ text: ' ' }]), null, after), null);
  assert.equal(
    geminiInvalidStreamReason(response('MALFORMED_FUNCTION_CALL', []), null, after),
    'MALFORMED_FUNCTION_CALL'
  );
  assert.equal(
    geminiEndsWithFunctionResponse([{ role: 'user', parts: [{ functionResponse: { name: 'a', response: {} } }] }]),
    true
  );
  assert.equal(geminiEndsWithFunctionResponse([{ role: 'user', parts: [{ text: 'hi' }] }]), false);
  assert.equal(geminiEndsWithFunctionResponse([]), false);
});

test('invalid stream: empty answer is re-asked on the stream ladder, then throws a terminal typed error', async () => {
  const empty = { response: response('STOP', []), textLeakGuard: null };
  const h = harness([async () => empty, async () => good]);
  assert.equal(await h.go(), good);
  assert.deepEqual(h.sleeps, [1000]);

  const stuck = harness([async () => empty]);
  await assert.rejects(stuck.go(), (error) => {
    assert.equal(error.code, 'no_response_text');
    assert.equal(error.name, 'InvalidStreamError');
    assert.equal(isProviderRecoveryTerminal(error), true);
    assert.equal(error.quotaScope, undefined);
    return true;
  });
  assert.equal(stuck.calls, GEMINI_MIDSTREAM_MAX_ATTEMPTS);
  assert.deepEqual(stuck.sleeps, [1000, 2000, 4000]);

  // Right after a tool result the same empty answer is accepted.
  const after = await runGeminiStreamAttempts({
    run: async () => empty,
    sleepFn: async () => {},
    afterToolResult: true,
  });
  assert.equal(after, empty);
});

test('SDK attempt reports the connection only after the request opened', async () => {
  const seen = [];
  const failing = streamGeminiSdkAttempt(
    {
      generateContentStream: async () => {
        throw Object.assign(new Error('refused'), { status: 503 });
      },
    },
    { contents: [], callbacks: {} },
    null,
    () => seen.push('connected')
  );
  await assert.rejects(failing);
  assert.deepEqual(seen, []);

  const opened = await streamGeminiSdkAttempt(
    {
      generateContentStream: async () => ({
        stream: (async function* () {
          yield { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'ok' }] } }] };
        })(),
        response: Promise.resolve({}),
      }),
    },
    { contents: [], callbacks: {}, opts: {} },
    null,
    () => seen.push('connected')
  );
  assert.deepEqual(seen, ['connected']);
  assert.equal(opened.response.candidates[0].finishReason, 'STOP');
});

// ── GeminiProvider end to end (SDK path) ──

import { GeminiProvider } from './gemini.mjs';

function sdkProvider(steps) {
  const sleeps = [];
  let opens = 0;
  const provider = new GeminiProvider({
    apiKey: 'fixture-key',
    preconnectFn: () => {},
    sleepFn: async (ms) => sleeps.push(ms),
    genAI: {
      getGenerativeModel: () => ({
        async generateContentStream() {
          const step = steps[Math.min(opens++, steps.length - 1)];
          if (step.open) throw step.open;
          return {
            stream: (async function* () {
              for (const chunk of step.chunks || []) yield chunk;
              if (step.fail) throw step.fail;
            })(),
            response: Promise.resolve({}),
          };
        },
      }),
    },
  });
  return {
    sleeps,
    get opens() {
      return opens;
    },
    send: (opts = {}) => provider.send([{ role: 'user', content: 'hi' }], 'gemini-test', [], opts),
    sendAfterTool: (opts = {}) =>
      provider.send(
        [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: {} }] },
          { role: 'tool', toolCallId: 'call_1', content: 'done' },
        ],
        'gemini-test',
        [],
        opts
      ),
  };
}

const stopChunk = (parts, finishReason = 'STOP') => ({
  candidates: [{ finishReason, content: { role: 'model', parts } }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
});

test('Gemini send: an empty STOP answer is re-asked once on the stream ladder', async () => {
  const h = sdkProvider([{ chunks: [stopChunk([])] }, { chunks: [stopChunk([{ text: 'answer' }])] }]);
  const result = await h.send();
  assert.equal(result.content, 'answer');
  assert.equal(h.opens, 2);
  assert.deepEqual(h.sleeps, [1000]);
});

test('Gemini send: an empty STOP right after a tool result is accepted, not re-asked', async () => {
  const h = sdkProvider([{ chunks: [stopChunk([])] }]);
  const result = await h.sendAfterTool();
  assert.equal(result.content, '');
  assert.equal(h.opens, 1);
  assert.deepEqual(h.sleeps, []);
});

const noFinishChunk = (parts) => ({ candidates: [{ content: { role: 'model', parts } }] });

test('Gemini send: an empty no-finish stream is truncated, even right after a tool result', async () => {
  const afterTool = sdkProvider([{ chunks: [noFinishChunk([])] }]);
  await assert.rejects(afterTool.sendAfterTool(), (error) => error.code === 'TRUNCATED_STREAM');
  assert.equal(afterTool.opens, 4);

  const plain = sdkProvider([{ chunks: [noFinishChunk([])] }]);
  await assert.rejects(plain.send(), (error) => error.code === 'TRUNCATED_STREAM');
  assert.equal(plain.opens, 4);

  const withText = sdkProvider([{ chunks: [noFinishChunk([{ text: 'cut off' }])] }]);
  await assert.rejects(withText.sendAfterTool(), (error) => error.code === 'TRUNCATED_STREAM');
  assert.equal(withText.opens, 4);
});

test('Gemini send: a malformed tool call after a tool result is still re-asked', async () => {
  const h = sdkProvider([{ chunks: [stopChunk([], 'MALFORMED_FUNCTION_CALL')] }]);
  await assert.rejects(h.sendAfterTool());
  assert.equal(h.opens, 4);
});

test('Gemini send: a malformed tool call that stays malformed is stamped exhausted after 4 attempts', async () => {
  const h = sdkProvider([{ chunks: [stopChunk([], 'MALFORMED_FUNCTION_CALL')] }]);
  await assert.rejects(h.send(), (error) => {
    assert.equal(error.finishReason, 'MALFORMED_FUNCTION_CALL');
    assert.equal(isProviderRecoveryExhausted(error), true);
    return true;
  });
  assert.equal(h.opens, 4);
  assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
});

test('Gemini send: a 503 on open follows the 10-attempt connection ladder', async () => {
  const unavailable = Object.assign(new Error('503 unavailable'), { status: 503 });
  const h = sdkProvider([{ open: unavailable }, { open: unavailable }, { chunks: [stopChunk([{ text: 'ok' }])] }]);
  assert.equal((await h.send()).content, 'ok');
  assert.equal(h.opens, 3);
  assert.ok(within(h.sleeps[0], 5000, 0.3));
  assert.ok(within(h.sleeps[1], 10_000, 0.3));
});

test('Gemini send: a stream cut before any output uses the 1s / 2s / 4s stream ladder', async () => {
  const cut = Object.assign(new Error('cut'), { code: 'TRUNCATED_STREAM', truncatedStream: true });
  const h = sdkProvider([{ fail: cut }]);
  await assert.rejects(h.send());
  assert.equal(h.opens, 4);
  assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
});
