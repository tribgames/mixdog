import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHeldRequests, markUnattendedRun, unattendedRunOf } from './held-requests.mjs';
import { createAgentHomeDelivery, createRoutineResultQueue } from './agent-home-delivery.mjs';
import { resolvePreToolAskApproval } from '../runtime/agent/orchestrator/session/loop/tool-helpers.mjs';
import { createHumanGateStore, setHumanGateStore } from '../runtime/agent/orchestrator/session/human-gate/store.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { isActualUserInstructionMessage } from '../runtime/agent/orchestrator/session/compact/user-message-kind.mjs';
import { registerHeldRequestNotifier, resolveHeldRequest } from '../runtime/shared/held-request-host.mjs';

function harness({ expiryMs = 60_000 } = {}) {
  const delivered = [];
  const pushes = [];
  const audits = [];
  const held = createHeldRequests({
    deliver: async (agentId, row) => delivered.push([agentId, row]),
    push: (event) => pushes.push(event),
    record: async (gate, approval) => audits.push([gate, approval]),
    expiryMs,
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
  assert.ok(row.expiresAt > Date.now());
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

test('an unanswered held request expires into a deny and the run continues with it', async () => {
  const h = harness({ expiryMs: 15 });
  // The expiry timer is unref'd (it never holds the daemon open); keep this process alive for it.
  const keepAlive = setTimeout(() => {}, 5_000);
  const result = await h.held.hold(outboundRequest).finally(() => clearTimeout(keepAlive));
  assert.equal(result.approved, false);
  assert.equal(result.response, 'deny');
  assert.equal(result.timedOut, true);
  await Promise.resolve();
  assert.equal(h.delivered.at(-1)[1].status, 'expired');
  assert.equal(h.audits[0][1].timedOut, true);
});

test('an unattended schedule run never auto-approves: its ask becomes a held request', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'held-gate-'));
  setHumanGateStore(createHumanGateStore(dir));
  const events = [];
  const unregister = registerHeldRequestNotifier((event) => events.push(event));
  const unmark = markUnattendedRun('sess_sched_1', { kind: 'schedule', agentId: 'reviewer', name: 'nightly' });
  t.after(() => {
    unmark();
    unregister();
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(unattendedRunOf('sess_sched_1'), { kind: 'schedule', agentId: 'reviewer', name: 'nightly' });
  const outcome = resolvePreToolAskApproval({
    toolName: 'github',
    args: outboundRequest.args,
    sessionId: 'sess_sched_1',
    askReason: 'needs approval',
    // Even an approving hook is not consulted for an unattended run.
    toolApprovalHook: async () => ({ approved: true }),
    request: { kind: 'outbound', outbound: outboundRequest.outbound, remember: ['once'] },
  });
  for (let i = 0; i < 10 && !events.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].agentName, 'reviewer');
  assert.equal(resolveHeldRequest(events[0].requestId, { approved: false, device: 'Pixel' }), true);
  const { denial } = await outcome;
  assert.match(denial, /denied by hook: denied by user/);
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
