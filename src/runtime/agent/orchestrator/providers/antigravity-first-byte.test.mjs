import test from 'node:test';
import assert from 'node:assert/strict';
import { createAntigravityRequest } from './antigravity-transport.mjs';
import { createAntigravityStreamCollector } from './antigravity-stream.mjs';
import { isProviderRecoveryExhausted } from './retry-classifier.mjs';

// The provider timers are unref'd; keep the loop alive while they run.
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

// Small windows stand in for the 180s / 285s production ones.
const THINKING = { timeoutMs: 40, maxMs: 70, retries: 1 };

function harness(fetchFn, { firstByte = THINKING, onStreamDelta } = {}) {
  const sleeps = [];
  const stages = [];
  const collector = createAntigravityStreamCollector({ tools: [], useModel: 'gemini-4-argon' });
  const request = createAntigravityRequest({
    fetchFn,
    endpoint: 'https://gateway.test',
    headers: {},
    body: '{}',
    opts: { onStageChange: (stage, detail) => stages.push([stage, detail]), onStreamDelta },
    signal: null,
    collector,
    sleepFn: async (ms) => sleeps.push(ms),
    firstByte,
  });
  return { request, sleeps, stages };
}

// Never answers; rejects the way fetch does once its signal aborts.
function silentFetch(calls) {
  return (_url, init) => {
    calls.push(Date.now());
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };
}

// Headers arrive at once; the body never produces a chunk.
function headersOnlyFetch(calls) {
  return async () => {
    calls.push(Date.now());
    return new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

test('a header timeout on a thinking model is retried once at a doubled window, then surfaces', async () => {
  const calls = [];
  const h = harness(silentFetch(calls));
  await assert.rejects(h.request(), (error) => {
    assert.equal(error.code, 'EPROVIDERTIMEOUT');
    assert.equal(error.timeoutPhase, 'headers');
    assert.match(error.message, /first byte timed out after 70ms/);
    assert.equal(error.attempts, 2);
    assert.equal(error.waitedMs, 40 + 70);
    assert.equal(isProviderRecoveryExhausted(error), true);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(h.sleeps.length, 1);
  // Headers never came: the stage stays at model thinking, never streaming.
  assert.equal(
    h.stages.some(([stage]) => stage === 'streaming'),
    false
  );
  assert.equal(h.stages.filter(([stage]) => stage === 'model_thinking').length, 2);
  // The retry status counts against the first-byte budget, not the 4-attempt ladder.
  const reconnect = h.stages.find(([stage]) => stage === 'reconnecting')[1];
  assert.equal(reconnect.max, 2);
});

test('a first-chunk timeout uses the same window, reports the headers as transport, and retries once', async () => {
  const calls = [];
  const kinds = [];
  const h = harness(headersOnlyFetch(calls), { onStreamDelta: (kind) => kinds.push(kind) });
  await assert.rejects(h.request(), (error) => {
    assert.equal(error.code, 'EGEMINITIMEOUT');
    assert.equal(error.timeoutPhase, 'first-chunk');
    assert.match(error.message, /first byte timed out after 70ms/);
    assert.equal(error.attempts, 2);
    assert.equal(isProviderRecoveryExhausted(error), true);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(kinds, ['transport', 'transport']);
  // Each attempt: requesting, then model thinking once sent, then streaming at the headers.
  const order = h.stages.map(([stage]) => stage).filter((stage) => stage !== 'reconnecting');
  assert.deepEqual(order, ['requesting', 'model_thinking', 'streaming', 'requesting', 'model_thinking', 'streaming']);
});

test('connection failures keep the 4-attempt ladder at 1s / 2s / 4s', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls += 1;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });
  });
  await assert.rejects(h.request(), (error) => {
    assert.equal(error.attempts, 4);
    assert.equal(error.timeoutPhase, undefined);
    return true;
  });
  assert.equal(calls, 4);
  assert.equal(h.sleeps.length, 3);
  h.sleeps.forEach((ms, index) => {
    const base = [1000, 2000, 4000][index];
    assert.ok(ms >= base * 0.9 - 1 && ms <= base * 1.1 + 1, `${index}: ${ms}`);
  });
});

test('an empty STOP is re-asked once after a logged backoff, then the usable answer resolves', async () => {
  const chunk = (parts) => ({
    response: {
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    },
  });
  const replies = [chunk([]), chunk([{ text: 'answer' }])];
  let calls = 0;
  const h = harness(async () => {
    const body = `data: ${JSON.stringify(replies[calls++])}\n\n`;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (text, ...rest) => {
    lines.push(String(text));
    return write.call(process.stderr, text, ...rest);
  };
  try {
    await h.request();
  } finally {
    process.stderr.write = write;
  }
  assert.equal(calls, 2);
  assert.equal(h.sleeps.length, 1);
  assert.deepEqual(
    lines.filter((line) => line.startsWith('[antigravity] retry')),
    ['[antigravity] retry 2 after Gemini stream unusable: NO_RESPONSE_TEXT\n']
  );
  const reconnect = h.stages.find(([stage]) => stage === 'reconnecting')[1];
  assert.equal(reconnect.attempt, 2);
});

test('a non-thinking model keeps its fixed window on the ordinary ladder', async () => {
  const calls = [];
  const h = harness(silentFetch(calls), { firstByte: { timeoutMs: 30, maxMs: 30, retries: null } });
  await assert.rejects(h.request(), (error) => {
    assert.match(error.message, /first byte timed out after 30ms/);
    assert.equal(error.attempts, 4);
    return true;
  });
  assert.equal(calls.length, 4);
});
