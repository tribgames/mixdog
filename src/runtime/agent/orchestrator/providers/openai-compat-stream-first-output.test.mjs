import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeCompatChatCompletionStream, consumeCompatResponsesStream } from './openai-compat-stream.mjs';
import {
  PROVIDER_FIRST_OUTPUT_TIMEOUT_MS,
  PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
} from '../stall-policy.mjs';

// First-output phase of the OpenAI-compatible streams: metadata keeps the
// stream open without ending the phase or starting the semantic idle.

import { markSessionStreamDelta, updateSessionStage } from '../session/manager/runtime-liveness.mjs';
import { runtimeState } from '../session/manager/runtime-state.mjs';

const skip = !PROVIDER_SSE_IDLE_WATCHDOG_ENABLED && 'stream watchdog disabled by env';

// A session whose logical model request starts now (mocked clock).
function sessionRequest(t, sessionId) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000_000 });
  t.after(() => runtimeState.delete(sessionId));
  updateSessionStage(sessionId, 'requesting');
  return Date.now();
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

// An SDK stream fed by the test, one event per push.
function fedStream() {
  const queue = [];
  let waiter = null;
  const iterator = {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    return: async () => ({ value: undefined, done: true }),
  };
  return {
    stream: { [Symbol.asyncIterator]: () => iterator, controller: { abort() {} } },
    async push(event) {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ value: event, done: false });
      } else queue.push(event);
      await flush();
    },
  };
}

const protocols = [
  {
    name: 'Responses',
    consume: consumeCompatResponsesStream,
    metadata: [
      { type: 'response.created', response: { id: 'r1', model: 'm' } },
      { type: 'response.in_progress', response: { id: 'r1' } },
      { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
    ],
    keepalive: { type: 'response.in_progress', response: { id: 'r1' } },
    output: { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
  },
  {
    name: 'Chat Completions',
    consume: consumeCompatChatCompletionStream,
    metadata: [{ id: 'c1', model: 'm', choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] }],
    keepalive: { id: 'c1', choices: [{ delta: {}, finish_reason: null }] },
    output: { id: 'c1', choices: [{ delta: { reasoning_content: 'thinking' }, finish_reason: null }] },
  },
];

async function openStream(t, protocol, { sessionId = null } = {}) {
  if (!sessionId) t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fed = fedStream();
  const progress = [];
  let settled = null;
  const result = protocol
    .consume(fed.stream, {
      label: 'fixture',
      sessionId,
      onStreamDelta: (kind) => progress.push(kind),
      responseOutputText: () => '',
      parseResponsesToolCalls: () => [],
    })
    .then(
      (value) => {
        settled = { value };
      },
      (error) => {
        settled = { error };
      }
    );
  for (const event of protocol.metadata) await fed.push(event);
  // Metadata or keepalives every minute for `ms`.
  const keepalivesFor = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 60_000) {
      t.mock.timers.tick(Math.min(60_000, ms - elapsed));
      await fed.push(protocol.keepalive);
    }
  };
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  return { fed, progress, keepalivesFor, tick, settled: () => settled, result };
}

for (const protocol of protocols) {
  test(`${protocol.name}: a model may think silently past the semantic idle until its first output`, { skip }, async (t) => {
    const s = await openStream(t, protocol);
    await s.keepalivesFor(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS + 60_000);
    assert.equal(s.settled(), null, 'not aborted while thinking silently');
    assert.ok(
      s.progress.every((kind) => kind === 'transport'),
      'metadata is never reported as model output'
    );
    // The first output hands the stream to the unchanged semantic idle.
    await s.fed.push(protocol.output);
    assert.ok(s.progress.includes('reasoning'));
    await s.keepalivesFor(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS - 1);
    assert.equal(s.settled(), null);
    await s.tick(1);
    await s.result;
    assert.equal(s.settled().error?.streamStalled, true);
    assert.match(s.settled().error.message, new RegExp(`after ${PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS}ms`));
  });

  test(`${protocol.name}: a reopened stream aborts at the logical request's original deadline`, { skip }, async (t) => {
    const sessionId = `sess_compat_retry_${protocol.name}`;
    const startedAt = sessionRequest(t, sessionId);
    const first = await openStream(t, protocol, { sessionId });
    await first.keepalivesFor(400_000);
    // The attempt is abandoned; the provider re-sends the same request.
    updateSessionStage(sessionId, 'requesting');
    const retry = await openStream(t, protocol, { sessionId });
    await retry.keepalivesFor(startedAt + PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1 - Date.now());
    assert.equal(retry.settled(), null);
    await retry.tick(1);
    await retry.result;
    assert.equal(retry.settled().error?.streamStalled, true);
    assert.match(retry.settled().error.message, new RegExp(`after ${PROVIDER_FIRST_OUTPUT_TIMEOUT_MS}ms`));
  });

  test(`${protocol.name}: a retry after output stays under the semantic idle`, { skip }, async (t) => {
    const sessionId = `sess_compat_retry_output_${protocol.name}`;
    sessionRequest(t, sessionId);
    await markSessionStreamDelta(sessionId, 'reasoning');
    t.mock.timers.tick(10_000);
    updateSessionStage(sessionId, 'requesting');
    const retry = await openStream(t, protocol, { sessionId });
    await retry.keepalivesFor(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS - 1);
    assert.equal(retry.settled(), null);
    await retry.tick(1);
    await retry.result;
    assert.equal(retry.settled().error?.streamStalled, true);
    assert.match(retry.settled().error.message, new RegExp(`after ${PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS}ms`));
  });

  test(`${protocol.name}: a stream that never produces output is aborted at the first-output deadline`, { skip }, async (t) => {
    const s = await openStream(t, protocol);
    await s.keepalivesFor(PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1);
    assert.equal(s.settled(), null);
    await s.tick(1);
    await s.result;
    assert.equal(s.settled().error?.streamStalled, true);
    assert.match(s.settled().error.message, new RegExp(`after ${PROVIDER_FIRST_OUTPUT_TIMEOUT_MS}ms`));
  });
}
