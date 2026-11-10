import assert from 'node:assert/strict';
import test from 'node:test';
import { getSessionProgressSnapshot, markSessionStreamDelta, updateSessionStage } from './runtime-liveness.mjs';
import { runtimeState } from './runtime-state.mjs';
import {
  KEEPALIVE_MAX_IDLE_MULTIPLIER,
  evaluateAgentWatchdogAbort,
  resolveAgentWatchdogPolicy,
} from '../../agent-runtime/agent-progress-watchdog.mjs';

// Anthropic `ping` keepalives (reported as the 'keepalive' stream kind) keep an
// agent alive only after the request's first semantic event, and only within
// KEEPALIVE_MAX_IDLE_MULTIPLIER x the idle budget since the last real progress.

const policy = resolveAgentWatchdogPolicy('worker');
const verdict = (id) => evaluateAgentWatchdogAbort(getSessionProgressSnapshot(id), Date.now(), policy);
const PING_EVERY_MS = 30_000;

function setup(t, id) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
  t.after(() => runtimeState.delete(id));
  updateSessionStage(id, 'requesting');
}

// Pings every 30s for `ms`, returning the first elapsed time the watchdog aborts at (or null).
function pingFor(t, id, ms) {
  for (let elapsed = PING_EVERY_MS; elapsed <= ms; elapsed += PING_EVERY_MS) {
    t.mock.timers.tick(PING_EVERY_MS);
    markSessionStreamDelta(id, 'keepalive');
    if (verdict(id)) return elapsed;
  }
  return null;
}

test('without pings a semantically silent agent aborts once the idle budget is exceeded', async (t) => {
  const id = 'sess_keepalive_none';
  setup(t, id);
  await markSessionStreamDelta(id, 'reasoning');
  assert.ok(policy.idleStaleMs > 0);
  t.mock.timers.tick(policy.idleStaleMs + 1);
  assert.match(verdict(id).message, /^agent task stale \(/);
});

test('pings extend liveness past the idle budget up to the cap, then the watchdog aborts', async (t) => {
  const id = 'sess_keepalive_cap';
  setup(t, id);
  await markSessionStreamDelta(id, 'reasoning');
  const cap = policy.idleStaleMs * KEEPALIVE_MAX_IDLE_MULTIPLIER;
  const abortedAt = pingFor(t, id, cap + 4 * PING_EVERY_MS);
  assert.ok(abortedAt > policy.idleStaleMs, `kept alive past the idle budget (aborted at ${abortedAt})`);
  assert.ok(
    abortedAt > cap - PING_EVERY_MS && abortedAt <= cap + PING_EVERY_MS,
    `aborted at the cap, got ${abortedAt}`
  );
  assert.match(verdict(id).message, /^agent task stale \(/);
});

test('a stream that stops pinging dies at the idle budget even inside the cap', async (t) => {
  const id = 'sess_keepalive_stopped';
  setup(t, id);
  await markSessionStreamDelta(id, 'reasoning');
  assert.equal(pingFor(t, id, policy.idleStaleMs * 1.5), null);
  // Still inside the cap, but the last ping is older than the idle budget.
  t.mock.timers.tick(policy.idleStaleMs + 1);
  assert.match(verdict(id).message, /^agent task stale \(/);
});

test('real progress restarts the cap', async (t) => {
  const id = 'sess_keepalive_restart';
  setup(t, id);
  await markSessionStreamDelta(id, 'reasoning');
  assert.equal(pingFor(t, id, policy.idleStaleMs * 2), null);
  await markSessionStreamDelta(id, 'text');
  assert.equal(pingFor(t, id, policy.idleStaleMs * 2), null);
});

test('a ping before the first semantic event does not count as progress or liveness', async (t) => {
  const id = 'sess_keepalive_before_first';
  setup(t, id);
  const progressAt = getSessionProgressSnapshot(id).lastProgressAt;
  t.mock.timers.tick(PING_EVERY_MS);
  markSessionStreamDelta(id, 'keepalive');
  let snap = getSessionProgressSnapshot(id);
  assert.equal(snap.lastKeepaliveAt, 0);
  assert.equal(snap.lastProgressAt, progressAt);
  assert.equal(snap.waitingForFirstSemantic, true);
  // The first-output window still judges the phase: the ping did not reset it.
  t.mock.timers.tick(policy.firstSemanticMs);
  assert.match(verdict(id).message, /^agent first semantic response stale \(/);
  // A semantic event ends that phase; only later pings are recorded.
  await markSessionStreamDelta(id, 'reasoning');
  t.mock.timers.tick(PING_EVERY_MS);
  markSessionStreamDelta(id, 'keepalive');
  snap = getSessionProgressSnapshot(id);
  assert.ok(snap.lastKeepaliveAt > snap.lastProgressAt);
});
