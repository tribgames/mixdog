// The worker turn owner over a route's turn lifecycle channel: what a send's
// own turn records on the row, and the watchdog it arms for it. The routes'
// real turns are driven end to end in standalone/agent-worker-turn-status.test.mjs.
import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnLifecycle } from '../../../runtime/shared/turn-lifecycle.mjs';
import { getProgressWatchdogState } from '../agent-watchdog-registry.mjs';
import { _runSessionPurgeHooks } from '../../../runtime/agent/orchestrator/session/store/session-observers.mjs';
import { createWorkerTurns } from './worker-turns.mjs';

function owner(session, overrides = () => ({})) {
  const turns = createTurnLifecycle();
  const upserts = [];
  const mgr = {
    getSession: () => session,
    observeSessionTurns: turns.observe,
    getSessionProgressSnapshot: () => null,
    linkParentSignalToSession: () => {},
  };
  const workerTurns = createWorkerTurns({
    mgr,
    // A canonical descriptor: its runtime persists the transcript, never this owner.
    sessionSurface: { canonical: true },
    upsertWorkerSessionDeferred: (_session, _tag, row) => upserts.push(row),
    tagForSession: () => 'worker',
    agentWatchdogOverrides: overrides,
  });
  return { turns, upserts, mgr, workerTurns };
}

test("a send's own turn carries its task id and arms the watchdog the agent and provider define", (t) => {
  const session = { id: 'child', agent: 'art-director', provider: 'antigravity-oauth', model: 'gemini-4-argon' };
  const requested = [];
  const { turns, upserts, mgr, workerTurns } = owner(session, (target) => {
    requested.push(target);
    return { firstResponseTimeoutMs: 900_000, providerFirstByteTimeoutMs: 466_000 };
  });
  t.after(() => workerTurns.dispose());
  const claim = workerTurns.claim(session, { taskId: 'task_agent_send_1p' });
  turns.started('child', { turnId: 't1', startedAt: 1_000, submissionIds: [claim.submissionId] });
  assert.deepEqual(upserts.at(-1), {
    status: 'running',
    stage: 'running',
    task_id: 'task_agent_send_1p',
    turnStartedAt: new Date(1_000).toISOString(),
  });
  assert.equal(getProgressWatchdogState(mgr, 'child').policy, null, 'nothing is judged before the ask starts');
  turns.askStarted('child', { turnId: 't1' });
  assert.deepEqual(requested, [{ agent: 'art-director', provider: 'antigravity-oauth', model: 'gemini-4-argon' }]);
  assert.equal(getProgressWatchdogState(mgr, 'child').policy.firstTransportMs, 900_000);
  turns.settled('child', { turnId: 't1', status: 'done', result: { content: 'done' } });
  assert.equal(getProgressWatchdogState(mgr, 'child').policy, null, 'the settle stopped its watchdog');
  assert.equal(upserts.at(-1).status, 'idle');
});

test('a running turn keeps a working stage beside status running, whatever phase the runtime reads', {
  timeout: 10_000,
}, async (t) => {
  const session = { id: 'child', agent: 'worker', messages: [{}, {}] };
  const { turns, upserts, mgr, workerTurns } = owner(session);
  t.after(() => workerTurns.dispose());
  const stages = ['done', 'streaming'];
  mgr.getSessionProgressSnapshot = () => ({ stage: stages[0], lastProgressAt: Date.now() });
  workerTurns.observe(session);
  turns.started('child', { turnId: 't1', startedAt: Date.now(), submissionIds: [] });
  turns.askStarted('child', { turnId: 't1' });
  const seen =() => upserts.slice(1).map((patch) => [patch.status, patch.stage]);
  while (seen().length < 1) await new Promise((resolve) => setTimeout(resolve, 20));
  stages.shift();
  while (seen().length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen(), [
    ['running', 'running'],
    ['running', 'streaming'],
  ]);
  assert.equal(upserts[1].messages, 2);
});

test('a cancelled send settles its turn cancelled, a dispatch that never started a turn settles itself', (t) => {
  const session = { id: 'child', agent: 'worker' };
  const { turns, upserts, workerTurns } = owner(session);
  t.after(() => workerTurns.dispose());
  const job = { taskId: 'task_1', status: 'running' };
  const claim = workerTurns.claim(session, job);
  turns.started('child', { turnId: 't1', startedAt: 1_000, submissionIds: [claim.submissionId] });
  job.status = 'cancelled';
  turns.settled('child', { turnId: 't1', status: 'failed', error: 'aborted' });
  assert.equal(upserts.at(-1).status, 'cancelled');
  claim.release('cancelled');
  assert.equal(upserts.length, 2, 'the turn already settled its row');

  const unstarted = workerTurns.claim(session, { taskId: 'task_2', status: 'running' });
  unstarted.release('error');
  assert.equal(upserts.at(-1).status, 'error');
});

test('dispose stops every armed watchdog, unsubscribes every session and its purge hook, once', () => {
  const sessions = { a: { id: 'a', agent: 'worker' }, b: { id: 'b', agent: 'worker' } };
  const turns = createTurnLifecycle();
  const upserts = [];
  const mgr = {
    getSession: (id) => sessions[id],
    observeSessionTurns: turns.observe,
    getSessionProgressSnapshot: () => null,
    linkParentSignalToSession: () => {},
  };
  const workerTurns = createWorkerTurns({
    mgr,
    sessionSurface: { canonical: true },
    upsertWorkerSessionDeferred: (session, _tag, row) => upserts.push([session.id, row.status]),
    tagForSession: (id) => id,
    agentWatchdogOverrides: () => ({}),
  });
  for (const session of Object.values(sessions)) workerTurns.observe(session);
  turns.started('a', { turnId: 'ta', startedAt: 1_000, submissionIds: [] });
  turns.started('b', { turnId: 'tb', startedAt: 1_000, submissionIds: [] });
  turns.askStarted('a', { turnId: 'ta' });
  turns.askStarted('b', { turnId: 'tb' });
  assert.ok(getProgressWatchdogState(mgr, 'a').policy && getProgressWatchdogState(mgr, 'b').policy);

  workerTurns.dispose();
  assert.equal(getProgressWatchdogState(mgr, 'a').policy, null);
  assert.equal(getProgressWatchdogState(mgr, 'b').policy, null);
  const written = upserts.length;
  turns.settled('a', { turnId: 'ta', status: 'done' });
  turns.started('b', { turnId: 'tb2', startedAt: 2_000, submissionIds: [] });
  assert.equal(upserts.length, written, 'no observer is left on either session');

  // With its purge hook gone, deleting a session leaves a later observer alone.
  workerTurns.observe(sessions.a);
  _runSessionPurgeHooks('a');
  turns.started('a', { turnId: 'ta2', startedAt: 3_000, submissionIds: [] });
  assert.deepEqual(upserts.at(-1), ['a', 'running']);
  turns.settled('a', { turnId: 'ta2', status: 'done' });

  workerTurns.dispose();
  workerTurns.dispose();
  assert.equal(getProgressWatchdogState(mgr, 'a').policy, null);
});
