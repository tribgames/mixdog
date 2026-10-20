import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionControl } from './daemon-session-control.mjs';
import { createAgentTaskSessions } from '../session-runtime/agent-task-sessions.mjs';
import { createAgentHomeDelivery, createRoutineResultQueue } from '../session-runtime/agent-home-delivery.mjs';
import { createWorkspaceToolHandlers } from '../session-runtime/internal-tool-executor/workspace-tools.mjs';

function fixture() {
  const calls = [];
  const full = {
    title: 'Target',
    cwd: '/project',
    provider: 'test',
    model: 'model',
    busy: true,
    items: [{ kind: 'assistant', text: 'response' }],
    transcriptHasOlder: true,
  };
  const method =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args]);
      return result;
    };
  const service = {
    listSessionCatalog: method('list', { sessions: [{ id: 'target' }], nextCursor: 'next' }),
    readSession: method('read', { full, range: { offset: 0, items: full.items, hasOlder: true } }),
    submitSession: method('send', { accepted: true }),
    abortSession: method('cancel', { aborted: true }),
    configureSession: method('configure', { value: true }),
  };
  const execute = createSessionControl({ getSessionService: () => service });
  const handler = createWorkspaceToolHandlers({
    rt: { session: { id: 'caller', title: 'Current' }, config: {} },
    executeSessionControl: execute,
  }).session;
  const context = { callerCtx: { callerSessionId: 'caller' }, callerCwd: '/project' };
  return { calls, service, execute, run: async (args) => JSON.parse(await handler(args, context)), handler, context };
}

test('list and bounded reads reuse the common session catalog and projection', async () => {
  const h = fixture();
  assert.deepEqual(await h.run({ action: 'list', limit: 10, cursor: 'previous' }), {
    sessions: [{ id: 'target' }],
    nextCursor: 'next',
  });
  assert.deepEqual(h.calls[0], ['list', { page: { limit: 10, cursor: 'previous' } }]);
  const status = await h.run({ action: 'status', session_id: 'target' });
  assert.equal(status.sessionId, 'target');
  assert.equal(status.title, 'Target');
  assert.equal(status.busy, true);
  assert.equal(Object.hasOwn(status, 'items'), false);
  const read = await h.run({ action: 'read', session_id: 'target', limit: 3 });
  assert.deepEqual(read.items, [{ kind: 'assistant', offset: 0, text: 'response' }]);
  assert.equal(read.nextOffset, 1);
  assert.deepEqual(h.calls.at(-1), [
    'read',
    {
      sessionId: 'target',
      transcriptRange: { offset: 0, limit: 3 },
    },
  ]);
});

test('send, cancel and delete call existing addressed service operations', async () => {
  const h = fixture();
  // A caller that is no agent conversation: a plain queued prompt, no report.
  assert.deepEqual(await h.run({ action: 'send', session_id: 'target', prompt: 'continue' }), {
    sessionId: 'target',
    accepted: true,
    reportsBack: false,
  });
  assert.equal(h.calls[0][1].sessionId, 'target');
  assert.equal(h.calls[0][1].prompt, 'continue');
  assert.deepEqual(h.calls[0][1].options, { mode: 'prompt', transcriptMeta: { sender: 'lead' } });
  assert.deepEqual(await h.run({ action: 'cancel', session_id: 'target' }), { sessionId: 'target', aborted: true });
  assert.deepEqual(await h.run({ action: 'delete', session_id: 'target' }), { sessionId: 'target', deleted: true });
  assert.deepEqual(h.calls.at(-1), [
    'configure',
    {
      sessionId: 'target',
      action: 'deleteSession',
      args: ['target'],
    },
    { revision: 1 },
  ]);
});

test("a bot's send to a session it did not create reports the turn to its home and wakes it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'session-control-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = { id: 'sess_home_lead', owner: 'cli', agent: 'lead', sourceType: 'lead', messages: [], generation: 1 };
  const target = { id: 'sess_user_1', title: 'BB proto', owner: 'cli', sourceType: 'lead' };
  const before = structuredClone(target);
  const wakes = [];
  const delivery = createAgentHomeDelivery({
    loadSession: (id) => (id === home.id ? home : null),
    saveSession: async () => {},
    turnInFlight: () => false,
    queue: createRoutineResultQueue(join(dir, 'routine-results.json')),
    live: () => ({ busy: () => false, notice: () => {}, wake: async (id, prompt) => wakes.push([id, prompt]) }),
    retryLater: () => {},
    log: () => {},
  });
  let queued = null;
  const submits = [];
  const service = {
    materializeSession: async () => ({ getState: () => ({}), subscribe: () => () => {} }),
    submitSession: async (params) => {
      submits.push(params);
      return { accepted: true };
    },
  };
  const agentTasks = createAgentTaskSessions({
    getSessionService: () => service,
    deliver: (agentId, report) => {
      queued = delivery.enqueueTask(agentId, report);
      return queued;
    },
    watches: {
      add: (watch) => delivery.watchTask(watch),
      list: () => delivery.taskWatches(),
      remove: (runId) => delivery.unwatchTask(runId),
    },
    loadSession: async (id) => (id === target.id ? target : null),
    log: () => {},
  });
  const handler = createWorkspaceToolHandlers({
    rt: { session: home, config: {} },
    executeSessionControl: createSessionControl({ getSessionService: () => service, agentTasks }),
  }).session;
  const result = JSON.parse(
    await handler(
      { action: 'send', session_id: target.id, prompt: 'run the simulation' },
      { callerCtx: { callerSessionId: home.id }, callerCwd: '/project' }
    )
  );
  assert.deepEqual(result, { sessionId: target.id, accepted: true, reportsBack: true });
  const [send] = submits;
  assert.equal(send.sessionId, target.id);
  assert.equal(send.prompt, 'run the simulation');
  assert.deepEqual(send.options.transcriptMeta, { sender: 'lead' });
  send.options.onSettled({ status: 'done', result: { content: 'simulation finished' } });
  await new Promise((resolve) => setImmediate(resolve));
  await delivery.drain(await queued);
  const [reported] = home.messages;
  assert.match(reported.content, /\] Session "BB proto" \(sess_user_1\) reported \(completed\)/);
  assert.deepEqual(await delivery.taskWatches(), [], 'the queued report drops its watch');
  assert.match(reported.content, /simulation finished/);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0][0], home.id);
  assert.match(wakes[0][1], /Relay the task result above to the user now/);
  assert.deepEqual(target, before, "the target's record, origin and owner stay as they were");
});

test('invalid targets and self mutations are rejected before reaching the service', async () => {
  const h = fixture();
  for (const action of ['read', 'send', 'cancel', 'delete']) {
    await assert.rejects(h.run({ action }), /session_id is required/);
    await assert.rejects(h.run({ action, session_id: '../other' }), /session_id is required/);
  }
  for (const action of ['send', 'cancel', 'delete']) {
    await assert.rejects(h.run({ action, session_id: 'caller', prompt: 'x' }), /another session/);
  }
  await assert.rejects(h.run({ action: 'send', session_id: 'target', prompt: ' ' }), /prompt is required/);
  await assert.rejects(h.run({ action: 'list', limit: 0 }), /limit/);
  await assert.rejects(h.run({ action: 'read', session_id: 'target', offset: -1 }), /offset/);
  await assert.rejects(h.run({ action: 'read', session_id: 'target', text_offset: 1 }), /requires/);
  await assert.rejects(h.run({ action: 'rename', session_id: 'target', title: 'wrong' }), /current session/);
  await assert.rejects(h.handler({ action: 'list' }, { callerCtx: { callerSessionId: 'foreign' } }), /Lead session/);
  assert.deepEqual(h.calls, []);
});

test('current-session status stays local and service refusal is not reported as success', async () => {
  const h = fixture();
  assert.equal((await h.run({ action: 'status' })).title, 'Current');
  assert.deepEqual(h.calls, []);
  h.service.submitSession = async () => ({ accepted: false });
  h.service.abortSession = async () => ({ aborted: false });
  h.service.configureSession = async () => ({ value: false });
  assert.equal((await h.run({ action: 'send', session_id: 'target', prompt: 'x' })).accepted, false);
  assert.equal((await h.run({ action: 'cancel', session_id: 'target' })).aborted, false);
  assert.equal((await h.run({ action: 'delete', session_id: 'target' })).deleted, false);
  const unavailable = createWorkspaceToolHandlers({ rt: { session: { id: 'caller' } } }).session;
  await assert.rejects(unavailable({ action: 'list' }, h.context), /unavailable/);
});
