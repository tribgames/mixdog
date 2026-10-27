import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSessionProgressSnapshot,
  markSessionStreamDelta,
  markSessionToolCall,
  updateSessionStage,
} from './runtime-liveness.mjs';
import { runtimeState } from './runtime-state.mjs';
import {
  evaluateAgentWatchdogAbort,
  resolveAgentWatchdogPolicy,
} from '../../agent-runtime/agent-progress-watchdog.mjs';
import { PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS } from '../../stall-policy.mjs';

// Agent-level first-output allowance per logical model request, judged
// through the same snapshot the agent progress watchdog reads.

const policy = resolveAgentWatchdogPolicy('worker');
const verdict = (id) => evaluateAgentWatchdogAbort(getSessionProgressSnapshot(id), Date.now(), policy);

function setup(t, id) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
  t.after(() => runtimeState.delete(id));
}

// Request 1 streams output and calls a tool; the tool batch commits and the
// loop is about to send the request that carries the tool results.
async function firstRequestWithToolCall(t, id) {
  updateSessionStage(id, 'requesting');
  t.mock.timers.tick(2_000);
  markSessionStreamDelta(id, 'transport');
  await markSessionStreamDelta(id, 'reasoning');
  t.mock.timers.tick(1_000);
  markSessionToolCall(id, 'read');
  t.mock.timers.tick(5_000);
  updateSessionStage(id, 'connecting');
  t.mock.timers.tick(1_000);
}

test('the policy under test: the idle budget is shorter than the first-output allowance', () => {
  assert.ok(policy.idleStaleMs >= PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS);
  assert.ok(policy.idleStaleMs < policy.firstSemanticMs);
});

test('the request after a tool result gets a fresh first-output allowance; turn history stays', async (t) => {
  const id = 'sess_logical_request_fresh';
  setup(t, id);
  await firstRequestWithToolCall(t, id);
  const turnFirstSemanticAt = getSessionProgressSnapshot(id).firstSemanticAt;

  updateSessionStage(id, 'requesting');
  const startedAt = Date.now();
  let snap = getSessionProgressSnapshot(id);
  assert.equal(snap.modelRequestStartedAt, startedAt);
  assert.equal(snap.waitingForTransport, true);
  assert.equal(snap.waitingForFirstSemantic, true);
  // Turn-level history is untouched by the new request.
  assert.equal(snap.firstSemanticAt, turnFirstSemanticAt);
  assert.equal(snap.hasFirstSemantic, true);

  // Headers, then silent thinking with only keepalive/metadata transport,
  // well past the idle budget but inside the first-output allowance.
  t.mock.timers.tick(3_000);
  markSessionStreamDelta(id, 'transport');
  updateSessionStage(id, 'streaming');
  for (let elapsed = 3_000; elapsed < policy.idleStaleMs + 60_000; elapsed += 30_000) {
    t.mock.timers.tick(30_000);
    markSessionStreamDelta(id, 'transport');
    assert.equal(verdict(id), null, `aborted after ${Date.now() - startedAt}ms of silent thinking`);
  }
  snap = getSessionProgressSnapshot(id);
  assert.equal(snap.waitingForTransport, false);
  assert.equal(snap.waitingForFirstSemantic, true, 'metadata never ends the first-output phase');

  // The first semantic output ends the phase; the existing idle rule applies.
  await markSessionStreamDelta(id, 'text');
  snap = getSessionProgressSnapshot(id);
  assert.equal(snap.waitingForFirstSemantic, false);
  assert.equal(snap.firstSemanticAt, turnFirstSemanticAt, 'the turn keeps its first semantic time');
  t.mock.timers.tick(policy.idleStaleMs);
  assert.equal(verdict(id), null);
  t.mock.timers.tick(1);
  assert.match(verdict(id).message, /^agent task stale \(/);
});

test('a truly stalled later request is still aborted at the first-output deadline', async (t) => {
  const id = 'sess_logical_request_stalled';
  setup(t, id);
  await firstRequestWithToolCall(t, id);
  updateSessionStage(id, 'requesting');
  markSessionStreamDelta(id, 'transport');
  t.mock.timers.tick(policy.firstSemanticMs);
  assert.equal(verdict(id), null);
  t.mock.timers.tick(1);
  assert.match(verdict(id).message, /^agent first semantic response stale \(/);
});

test('a later request with no transport at all is aborted at the first-transport deadline', async (t) => {
  const id = 'sess_logical_request_no_transport';
  setup(t, id);
  await firstRequestWithToolCall(t, id);
  updateSessionStage(id, 'requesting');
  t.mock.timers.tick(policy.firstTransportMs + 1);
  assert.match(verdict(id).message, /^agent first transport stale \(/);
});

test('a retry of the same logical request keeps its clock and stays bounded', async (t) => {
  const id = 'sess_logical_request_retry';
  setup(t, id);
  await firstRequestWithToolCall(t, id);
  updateSessionStage(id, 'requesting');
  const startedAt = Date.now();
  markSessionStreamDelta(id, 'transport');
  updateSessionStage(id, 'streaming');
  // Attempt 1 dies after its headers; the provider (or the loop, or a route
  // fallback) re-sends the same request several times.
  for (const stage of ['requesting', 'connecting', 'requesting', 'streaming', 'requesting']) {
    t.mock.timers.tick(100_000);
    updateSessionStage(id, stage);
  }
  const snap = getSessionProgressSnapshot(id);
  assert.equal(snap.modelRequestStartedAt, startedAt, 'a retry never restarts the request clock');
  assert.equal(snap.waitingForFirstSemantic, true);
  t.mock.timers.tick(startedAt + policy.firstSemanticMs - Date.now());
  assert.equal(verdict(id), null);
  t.mock.timers.tick(1);
  assert.match(verdict(id).message, /^agent first semantic response stale \(/);
});

test('a retry after output keeps the output mark, so the idle rule bounds it', async (t) => {
  const id = 'sess_logical_request_retry_after_output';
  setup(t, id);
  await firstRequestWithToolCall(t, id);
  updateSessionStage(id, 'requesting');
  await markSessionStreamDelta(id, 'reasoning');
  t.mock.timers.tick(10_000);
  updateSessionStage(id, 'requesting');
  const snap = getSessionProgressSnapshot(id);
  assert.equal(snap.waitingForFirstSemantic, false);
  t.mock.timers.tick(policy.idleStaleMs + 1);
  assert.match(verdict(id).message, /^agent task stale \(/);
});
