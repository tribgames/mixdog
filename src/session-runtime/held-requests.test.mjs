// First: an unattended run's ask reaches the process delivery, whose queue
// lives in the data dir; run directly (not through scripts/test.mjs) this test
// once queued its held rows into the user's real routine-results.json.
import '../../scripts/test-data-dir.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHeldRequests, markUnattendedRun, pendingHeldRequests, unattendedRunOf } from './held-requests.mjs';
import { roomMemberSessionId } from '../runtime/agent/orchestrator/session/agent-room.mjs';
import { createAgentHomeDelivery, createRoutineResultQueue } from './agent-home-delivery.mjs';
import { resolvePreToolAskApproval } from '../runtime/agent/orchestrator/session/loop/tool-helpers.mjs';
import { createHumanGateStore, setHumanGateStore } from '../runtime/agent/orchestrator/session/human-gate/store.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { isActualUserInstructionMessage } from '../runtime/agent/orchestrator/session/compact/user-message-kind.mjs';
import { registerHeldRequestNotifier, resolveHeldRequest } from '../runtime/shared/held-request-host.mjs';
import { createSessionLifecycleApi } from '../tui/session/session-api/lifecycle.mjs';

function harness() {
  const delivered = [];
  const pushes = [];
  const audits = [];
  const held = createHeldRequests({
    deliver: async (agentId, row) => delivered.push([agentId, row]),
    push: (event) => pushes.push(event),
    record: async (gate, approval) => audits.push([gate, approval]),
    runOf: (sessionId) =>
      sessionId === 'sess_run' ? { kind: 'schedule', agentId: 'reviewer', name: 'nightly' } : null,
  });
  return { held, delivered, pushes, audits };
}

const outboundRequest = {
  kind: 'outbound',
  name: 'github',
  args: { action: 'pr.comment', repo: 'o/r', number: 4, body: 'ARG-SENTINEL-77' },
  outbound: { target: 'o/r#4', account: 'github.com', payload: 'ARG-SENTINEL-77', editable: ['body'] },
  remember: ['once', 'agent'],
  sessionId: 'sess_run',
  reason: 'This sends or posts outside Mixdog; it needs your approval.',
};

test('a held request is delivered to the owner, pushed without any text, and answered by id', async () => {
  const h = harness();
  const answer = h.held.hold(outboundRequest);
  await Promise.resolve();
  const [[agentId, row]] = h.delivered;
  assert.equal(agentId, 'reviewer');
  assert.equal(row.status, 'pending');
  assert.equal(row.tool, 'github');
  assert.equal(row.target, 'o/r#4');
  assert.equal(row.run.kind, 'schedule');
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(Object.keys(h.pushes[0]).sort(), ['agentId', 'agentName', 'requestId', 'sessionId']);
  assert.equal(h.pushes[0].sessionId, 'sess_home_reviewer');
  assert.doesNotMatch(JSON.stringify(h.pushes), /ARG-SENTINEL|github|o\/r/);
  assert.equal(h.held.resolve(row.id, { approved: true, response: 'approve', device: 'Pixel' }), true);
  const result = await answer;
  assert.equal(result.approved, true);
  assert.equal(result.device, 'Pixel');
  assert.equal(h.held.resolve(row.id, { approved: true }), false, 'a settled request answers nothing');
  await Promise.resolve();
  assert.equal(h.delivered.at(-1)[1].status, 'approved');
  assert.equal(h.audits[0][1].device, 'Pixel');
});

test('a held row offers exactly the scopes the gate offered, and a scope it did not offer counts as once', async () => {
  const h = harness();
  const answer = h.held.hold(outboundRequest);
  await Promise.resolve();
  const [[, row]] = h.delivered;
  assert.deepEqual(row.remember, ['once', 'agent']);
  assert.equal(h.held.resolve(row.id, { approved: true, response: 'approve', remember: 'agent' }), true);
  assert.equal((await answer).remember, 'agent');
  assert.deepEqual(h.audits[0][0].remember, ['once', 'agent']);

  const onceOnly = h.held.hold({ ...outboundRequest, remember: ['once'] });
  await Promise.resolve();
  const [, row2] = h.delivered.filter(([, held]) => held.status === 'pending').at(-1);
  assert.deepEqual(row2.remember, ['once']);
  assert.equal(h.held.resolve(row2.id, { approved: true, response: 'approve', remember: 'agent' }), true);
  assert.equal((await onceOnly).remember, 'once', 'a scope the row did not offer is dropped');
});

test('a remembering held answer stores the bot grant whichever session answers it', async () => {
  for (const session of ['sess_home_reviewer', 'sess_other_pane', '', undefined]) {
    const h = harness();
    const answer = h.held.hold(outboundRequest);
    await Promise.resolve();
    const [[, row]] = h.delivered;
    assert.equal(h.held.resolve(row.id, { approved: true, response: 'approve', remember: 'agent' }), true);
    const result = await answer;
    assert.equal(result.approved, true, String(session));
    assert.equal(result.remember, 'agent', String(session));
  }
});

test('the session API answers a held row from any session and stores the grant', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'held-surface-'));
  const store = createHumanGateStore(dir);
  setHumanGateStore(store);
  const unregister = registerHeldRequestNotifier(() => {});
  t.after(() => {
    unregister();
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const member = roomMemberSessionId('room123abc', 'reviewer');
  const home = 'sess_home_reviewer';
  const ask = () => {
    const events = [];
    const stop = registerHeldRequestNotifier((event) => events.push(event));
    const outcome = resolvePreToolAskApproval({
      toolName: 'github',
      args: outboundRequest.args,
      sessionId: member,
      askReason: 'needs approval',
      toolApprovalHook: null,
      request: { kind: 'outbound', outbound: outboundRequest.outbound, remember: ['once', 'agent'] },
    });
    return { events, stop, outcome };
  };
  const answerFrom = async (sessionId) => {
    const { events, stop, outcome } = ask();
    for (let i = 0; i < 10 && !events.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
    stop();
    const api = createSessionLifecycleApi(
      { runtime: {}, getState: () => ({ sessionId }), finishToolApproval: () => false },
      {}
    );
    assert.equal(
      api.resolveToolApproval(events[0].requestId, { approved: true, response: 'approve', remember: 'agent' }),
      true
    );
    return (await outcome).approval.remember;
  };
  for (const sessionId of ['sess_other_pane', member, home]) {
    assert.equal(await answerFrom(sessionId), 'agent', sessionId);
  }
});

test('an unanswered held request never expires: it waits for an answer like any approval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  let settled = false;
  const answer = h.held.hold(outboundRequest).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  const [[, row]] = h.delivered;
  assert.equal('expiresAt' in row, false, 'no countdown for the card');
  t.mock.timers.tick(24 * 60 * 60_000);
  await Promise.resolve();
  assert.equal(settled, false, 'still pending after a day');
  assert.equal(h.held.pending().length, 1);
  assert.equal(h.delivered.length, 1, 'nothing posted but the pending row');
  assert.equal(h.held.resolve(row.id, { approved: true }), true);
  assert.equal((await answer).approved, true);
});

test('Stop or run cancellation denies a pending held request', async () => {
  const h = harness();
  const controller = new AbortController();
  const answer = h.held.hold(outboundRequest, { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  const result = await answer;
  assert.equal(result.approved, false);
  assert.equal(result.reason, 'run cancelled');
  await Promise.resolve();
  assert.equal(h.delivered.at(-1)[1].status, 'denied');
  assert.equal(h.held.pending().length, 0);
});

test('a schedule or webhook run never asks and never holds: no row, no push', async (t) => {
  const events = [];
  const unregister = registerHeldRequestNotifier((event) => events.push(event));
  const unmarks = [
    markUnattendedRun('sess_sched_1', { kind: 'schedule', agentId: 'reviewer', name: 'nightly' }),
    markUnattendedRun('sess_hook_1', { kind: 'webhook', agentId: 'reviewer', name: 'issues' }),
  ];
  t.after(() => {
    for (const unmark of unmarks) unmark();
    unregister();
  });
  assert.deepEqual(unattendedRunOf('sess_sched_1'), { kind: 'schedule', agentId: 'reviewer', name: 'nightly' });
  for (const sessionId of ['sess_sched_1', 'sess_hook_1']) {
    const outcome = await resolvePreToolAskApproval({
      toolName: 'github',
      args: outboundRequest.args,
      sessionId,
      askReason: 'needs approval',
      // The approval UI is not consulted for a run: saving it was the grant.
      toolApprovalHook: async () => assert.fail('a run has no card'),
      request: { kind: 'outbound', outbound: outboundRequest.outbound, remember: ['once'] },
    });
    assert.equal(outcome.denial, undefined, sessionId);
    assert.equal(outcome.approval.approved, true, sessionId);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [], 'no push either');
  assert.deepEqual(pendingHeldRequests(), [], 'nothing waits for an answer');
});

test('a room member without an approval UI still holds its ask for the owner', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'held-gate-'));
  setHumanGateStore(createHumanGateStore(dir));
  const events = [];
  const unregister = registerHeldRequestNotifier((event) => events.push(event));
  t.after(() => {
    unregister();
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const member = roomMemberSessionId('room123abc', 'reviewer');
  const outcome = resolvePreToolAskApproval({
    toolName: 'github',
    args: outboundRequest.args,
    sessionId: member,
    askReason: 'needs approval',
    toolApprovalHook: null,
    request: { kind: 'outbound', outbound: outboundRequest.outbound, remember: ['once'] },
  });
  for (let i = 0; i < 10 && !events.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].agentName, 'reviewer');
  assert.equal(resolveHeldRequest(events[0].requestId, { approved: false, device: 'Pixel' }), true);
  const { denial } = await outcome;
  assert.match(denial, /^Error: tool "github" was not approved: denied by user\./);
});

test('the home thread receives a structured held-request row that never reads as the user', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'held-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = { id: 'sess_home_reviewer', messages: [], generation: 1 };
  const notices = [];
  const delivery = createAgentHomeDelivery({
    loadSession: (id) => (id === session.id ? session : null),
    saveSession: async () => {},
    turnInFlight: () => false,
    queue: createRoutineResultQueue(join(dir, 'q.json')),
    live: () => ({ busy: () => false, notice: (id, notice) => notices.push([id, notice]) }),
    retryLater: () => {},
    log: () => {},
  });
  const held = {
    id: 'held_x1',
    status: 'pending',
    agentId: 'reviewer',
    kind: 'outbound',
    tool: 'github',
    target: 'o/r#4',
    payload: 'hello',
    run: { kind: 'schedule', name: 'nightly', sessionId: 'sess_run' },
    expiresAt: 123,
  };
  await delivery.enqueueHeld('reviewer', held);
  await delivery.drain('sess_home_reviewer');
  await delivery.enqueueHeld('reviewer', held);
  await delivery.drain('sess_home_reviewer');
  assert.equal(session.messages.length, 1, 'one row per status');
  const [message] = session.messages;
  assert.equal(message.meta.source, 'held-request');
  assert.equal(message.meta.heldRequest.id, 'held_x1');
  assert.equal(isActualUserInstructionMessage(message), false);
  assert.equal(notices[0][1].heldRequest.status, 'pending');
  const [item] = restoreTranscriptItems([message]);
  assert.equal(item.kind, 'notice');
  assert.equal(item.heldRequest.target, 'o/r#4');
});
