import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpSseWatchdogs } from './openai-http-sse-watchdogs.mjs';
import { createHttpSseResponseState } from './openai-http-sse-response-state.mjs';
import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_FIRST_OUTPUT_TIMEOUT_MS,
  PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
} from '../stall-policy.mjs';

import {
  markSessionStreamDelta,
  markSessionToolCall,
  updateSessionStage,
} from '../session/manager/runtime-liveness.mjs';
import { runtimeState } from '../session/manager/runtime-state.mjs';

const skip = !PROVIDER_SSE_IDLE_WATCHDOG_ENABLED && 'stream watchdog disabled by env';

// One stream's watchdogs; `session` joins that session's logical request.
function openWatchdogs(t, { sessionId = null, reportsProgress = Boolean(sessionId) } = {}) {
  const reader = { cancel: async () => {}, read: () => new Promise(() => {}), releaseLock() {} };
  const watchdogs = createHttpSseWatchdogs({
    opts: {},
    reader,
    totalTimeout: { signal: null, cleanup() {} },
    stallPartial: () => ({ content: '', toolCalls: [], pendingToolUse: false, emittedToolCall: false, model: null }),
    label: 'fixture',
    sessionId,
    reportsProgress,
  });
  t.after(() => watchdogs.dispose());
  watchdogs.armFirstServerEvent();
  watchdogs.noteServerEvent();
  return watchdogs;
}

function watchdogsUnderTest(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reader = { cancel: async () => {}, read: () => new Promise(() => {}), releaseLock() {} };
  const watchdogs = createHttpSseWatchdogs({
    opts: {},
    reader,
    totalTimeout: { signal: null, cleanup() {} },
    stallPartial: () => ({ content: '', toolCalls: [], pendingToolUse: false, emittedToolCall: false, model: null }),
    label: 'fixture',
  });
  t.after(() => watchdogs.dispose());
  watchdogs.armFirstServerEvent();
  return watchdogs;
}

// A session whose logical model request starts now (mocked clock).
function sessionRequest(t, sessionId) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000_000 });
  t.after(() => runtimeState.delete(sessionId));
  updateSessionStage(sessionId, 'requesting');
  return Date.now();
}

const firstOutputStall = new RegExp(`after ${PROVIDER_FIRST_OUTPUT_TIMEOUT_MS}ms`);
const idleStall = new RegExp(`after ${PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS}ms`);

test('a retried stream keeps the logical request first-output deadline', { skip }, (t) => {
  const sessionId = 'sess_http_sse_retry_deadline';
  const startedAt = sessionRequest(t, sessionId);
  const first = openWatchdogs(t, { sessionId });
  t.mock.timers.tick(400_000);
  first.dispose(); // the attempt failed before any output; the provider retries
  updateSessionStage(sessionId, 'requesting');
  const retry = openWatchdogs(t, { sessionId });
  t.mock.timers.tick(startedAt + PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1 - Date.now());
  assert.equal(retry.abortReason(), null);
  t.mock.timers.tick(1);
  assert.match(retry.abortReason()?.message ?? '', firstOutputStall, 'aborted at the original deadline');

  // A fork of the request (no progress into the session) keeps its own window.
  const fork = openWatchdogs(t, { sessionId, reportsProgress: false });
  t.mock.timers.tick(PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1);
  assert.equal(fork.abortReason(), null);
});

test('a retry after output stays under the semantic idle', { skip }, async (t) => {
  const sessionId = 'sess_http_sse_retry_after_output';
  sessionRequest(t, sessionId);
  const first = openWatchdogs(t, { sessionId });
  await markSessionStreamDelta(sessionId, 'reasoning');
  first.noteMeaningful();
  t.mock.timers.tick(10_000);
  first.dispose();
  const retry = openWatchdogs(t, { sessionId });
  assert.equal(retry.semanticSeen(), true);
  t.mock.timers.tick(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS - 1);
  assert.equal(retry.abortReason(), null);
  t.mock.timers.tick(1);
  assert.match(retry.abortReason()?.message ?? '', idleStall);
});

test('a new logical request opens a fresh first-output window', { skip }, async (t) => {
  const sessionId = 'sess_http_sse_new_request';
  sessionRequest(t, sessionId);
  await markSessionStreamDelta(sessionId, 'reasoning');
  markSessionToolCall(sessionId, 'read');
  t.mock.timers.tick(400_000);
  updateSessionStage(sessionId, 'connecting');
  updateSessionStage(sessionId, 'requesting');
  const next = openWatchdogs(t, { sessionId });
  assert.equal(next.semanticSeen(), false);
  t.mock.timers.tick(PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1);
  assert.equal(next.abortReason(), null);
  t.mock.timers.tick(1);
  assert.match(next.abortReason()?.message ?? '', firstOutputStall);
});

test('the first-output window is longer than the semantic idle it replaces', () => {
  assert.ok(PROVIDER_FIRST_OUTPUT_TIMEOUT_MS > PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS);
});

test('metadata-only events neither end the first-output phase nor start the semantic idle', { skip }, (t) => {
  const watchdogs = watchdogsUnderTest(t);
  // response.created, then response.in_progress / keepalives while the model
  // thinks silently past the semantic-idle window.
  for (let elapsed = 0; elapsed <= PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS + 60_000; elapsed += 30_000) {
    watchdogs.noteServerEvent();
    t.mock.timers.tick(30_000);
    assert.equal(watchdogs.abortReason(), null, `aborted after ${elapsed + 30_000}ms of silent thinking`);
  }
  assert.equal(watchdogs.semanticSeen(), false);

  // The first semantic output hands the stream to the existing idle rule.
  watchdogs.noteMeaningful();
  t.mock.timers.tick(PROVIDER_FIRST_OUTPUT_TIMEOUT_MS);
  assert.equal(watchdogs.abortReason()?.streamStalled, true, 'semantic idle runs after output');
  assert.match(watchdogs.abortReason().message, new RegExp(`after ${PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS}ms`));
});

test('after output, semantic progress keeps re-arming the idle and silence trips it', { skip }, (t) => {
  const watchdogs = watchdogsUnderTest(t);
  watchdogs.noteServerEvent();
  watchdogs.noteMeaningful();
  for (let i = 0; i < 5; i += 1) {
    t.mock.timers.tick(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS - 1);
    watchdogs.noteMeaningful();
  }
  assert.equal(watchdogs.abortReason(), null);
  t.mock.timers.tick(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS);
  assert.equal(watchdogs.abortReason()?.streamStalled, true);
});

test('a stream that never produces output is still aborted at the first-output deadline', { skip }, (t) => {
  const watchdogs = watchdogsUnderTest(t);
  let elapsed = 0;
  while (elapsed + 10_000 < PROVIDER_FIRST_OUTPUT_TIMEOUT_MS) {
    watchdogs.noteServerEvent();
    t.mock.timers.tick(10_000);
    elapsed += 10_000;
  }
  t.mock.timers.tick(PROVIDER_FIRST_OUTPUT_TIMEOUT_MS - 1 - elapsed);
  assert.equal(watchdogs.abortReason(), null);
  t.mock.timers.tick(1);
  const reason = watchdogs.abortReason();
  assert.equal(reason?.streamStalled, true);
  assert.match(reason.message, new RegExp(`after ${PROVIDER_FIRST_OUTPUT_TIMEOUT_MS}ms`));
});

test('a stream with no server event at all still fails at the first-server-event deadline', (t) => {
  const watchdogs = watchdogsUnderTest(t);
  t.mock.timers.tick(PROVIDER_FIRST_BYTE_TIMEOUT_MS);
  assert.equal(watchdogs.abortReason()?.firstByteTimeout, true);
});

test('response.created and empty items are lifecycle; output is meaningful', () => {
  const calls = [];
  let seen = false;
  const state = createHttpSseResponseState({
    body: { tools: [] },
    meaningful: (kind) => {
      seen = true;
      calls.push(['meaningful', kind]);
    },
    lifecycle: (kind) => calls.push([seen ? 'lifecycle-after-output' : 'lifecycle', kind]),
    onServerEvent: () => calls.push(['server-event']),
    label: 'fixture',
  });
  state.handleEvent({ type: 'response.created', response: { id: 'r', model: 'm' } });
  state.handleEvent({ type: 'response.in_progress', response: { id: 'r' } });
  state.handleEvent({ type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } });
  assert.deepEqual(calls, [['server-event'], ['server-event'], ['server-event'], ['lifecycle', 'semantic']]);
  calls.length = 0;
  state.handleEvent({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [] } });
  state.handleEvent({ type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } });
  state.handleEvent({ type: 'response.output_text.delta', delta: 'hi' });
  assert.deepEqual(calls, [
    ['server-event'],
    ['meaningful', 'reasoning'],
    ['server-event'],
    ['lifecycle-after-output', 'semantic'],
    ['server-event'],
    ['meaningful', 'text'],
  ]);
});
