import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createToolApproval, resolveToolApprovalTimeoutMs } from '../../../../../tui/session/tool-approval.mjs';
import { createProgressWatchdogRegistry } from '../../../../../session-runtime/services/agent-watchdog-registry.mjs';
import { resolveAgentWatchdogPolicy } from '../../agent-runtime/agent-progress-watchdog.mjs';
import {
  _touchRuntime,
  beginSessionApprovalWait,
  getSessionProgressSnapshot,
  updateSessionStage,
} from '../manager/runtime-liveness.mjs';
import { setLiveSession } from '../store.mjs';
import { loadSession } from '../store/load-session.mjs';
import { applyBeforeToolHook } from '../loop/tool-exec/before-hook.mjs';
import { delegationOf } from './delegation.mjs';
import {
  actingContactBotId,
  agentIdForSession,
  approvalSurface,
  humanGateDecision,
  unattendedApprovalPort,
} from './gate.mjs';
import { createHumanGateStore, setHumanGateStore } from './store.mjs';
import { roomMemberSessionId } from '../agent-room.mjs';
import { markUnattendedRun } from '../../../../../session-runtime/held-requests.mjs';
import { sessionOptions } from '../../../../../session-runtime/session-create/session-options.mjs';
import { createAgentTaskSessions } from '../../../../../session-runtime/agent-task-sessions.mjs';
import { sessionOriginFields } from '../manager/session-record.mjs';
import { endHandoff, handoffChatsOf, noteHandoff } from '../../../../shared/delegated-approval-host.mjs';
import {
  createAgentHomeDelivery,
  createRoutineResultQueue,
  QUEUE_CAPS,
} from '../../../../../session-runtime/agent-home-delivery.mjs';

// A bot (`사무관`, id mailer) delegates to sub-agents; a coding Lead does too.
// Session records are the runtime's own (live store records), so the gate
// reads the same parent links a real sub-agent or task session carries.
const dataRoot = mkdtempSync(join(tmpdir(), 'delegated-approval-data-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
for (const [id, kind, name] of [
  ['mailer', 'bot', '사무관'],
  ['worker', 'agent', 'Worker'],
  ['reviewer', 'agent', 'Reviewer'],
]) {
  mkdirSync(join(dataRoot, 'agents', id), { recursive: true });
  writeFileSync(join(dataRoot, 'agents', id, 'AGENT.md'), `---\nkind: ${kind}\n---\nYou are ${id}.\n`);
  writeFileSync(join(dataRoot, 'agents', id, 'agent.json'), JSON.stringify({ name }));
}
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const HOME = 'sess_home_mailer';
const childRecord = (id, agent, parent, owner = parent) => ({
  id,
  owner: 'agent',
  agent,
  visibility: 'agent-only',
  parentSessionId: parent,
  ownerSessionId: owner,
});
/** A session as the manager creates it: the record's origin fields (the
 *  delegation root among them) derived from its creation options. */
const created = (record) => {
  const origin = sessionOriginFields(record, {
    profile: null,
    presetObj: null,
    providerCacheOpts: null,
    surface: { toolPermission: null, hasCallerAllow: false },
  });
  const session = {
    ...record,
    ...(origin.delegation ? { delegation: origin.delegation } : {}),
    ...(origin.run ? { run: origin.run } : {}),
    createdAt: Date.now(),
  };
  setLiveSession(session);
  return session;
};
const agentChild = (...args) => created(childRecord(...args));
const taskSession = (id, sessionId, requestId = `atask_${id}`) =>
  created({
    id,
    owner: 'cli',
    agent: 'lead',
    taskOrigin: { agentId: 'mailer', sessionId, requestId, title: 'Report', notify: true },
  });
// coding Lead → Reviewer
setLiveSession({ id: 'sess_dlg_lead1', owner: 'cli', agent: 'lead' });
agentChild('sess_dlg_lsub1', 'reviewer', 'sess_dlg_lead1');
// bot home → Worker
agentChild('sess_dlg_sub1', 'worker', HOME);
// bot home → task session (session create, a top-level coding Lead) → Worker → Reviewer
taskSession('sess_dlg_task1', HOME, 'atask_1');
agentChild('sess_dlg_tsub1', 'worker', 'sess_dlg_task1');
agentChild('sess_dlg_tsub2', 'reviewer', 'sess_dlg_tsub1', 'sess_dlg_task1');

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'delegated-gate-'));
  const store = createHumanGateStore(dir);
  setHumanGateStore(store);
  t.after(() => {
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

const email = { name: 'mcp__gmail__send_email', args: { to: 'boss@example.com', subject: 's', body: 'hi' } };

const ROOM_MEMBER = roomMemberSessionId('room123abc', 'mailer');
agentChild('sess_dlg_rmem_w', 'worker', ROOM_MEMBER);
agentChild('sess_dlg_rmem_w2', 'reviewer', 'sess_dlg_rmem_w', ROOM_MEMBER);
agentChild('sess_dlg_sub2', 'reviewer', 'sess_dlg_sub1', HOME);

for (const [label, sessionId] of [
  ['bot home chat', HOME],
  ['bot room member session', ROOM_MEMBER],
]) {
  test(`${label}: an email send asks with the bot's identity and honours the bot's grant`, async (t) => {
    const store = tempStore(t);
    const asked = [];
    const send = () =>
      applyBeforeToolHook({
        ...email,
        cwd: '/tmp',
        callerSessionId: sessionId,
        executeOpts: {},
        beforeToolHook: async () => ({ action: 'allow' }),
        toolApprovalHook: async (request) => {
          asked.push(request);
          return { approved: true, response: 'approve', remember: 'agent' };
        },
      });
    await send();
    assert.equal(asked.length, 1, 'the bot is asked on the outbound card');
    assert.equal(asked[0].kind, 'outbound');
    assert.equal(asked[0].agentId, 'mailer', 'with the bot as the requester');
    assert.deepEqual(asked[0].remember, ['once', 'agent']);
    // "Don't ask again" was stored for the bot, shared by its home chat and its room seat.
    const [grant] = await store.listGrants({ agentId: 'mailer' });
    assert.deepEqual({ agentId: grant.agentId, action: grant.action }, { agentId: 'mailer', action: 'email' });
    await send();
    assert.equal(asked.length, 1, 'the bot grant lets the next send through unasked');
    const [row] = await store.readAudit({ agentId: 'mailer' });
    assert.equal(row.decision, 'remembered');
    for (const other of [HOME, ROOM_MEMBER]) {
      const out = await humanGateDecision(email, null, { sessionId: other, store, annotations: {} });
      assert.equal(out.remembered, true, other);
    }
    // The bot's block blocks it; payments never remember.
    await store.setMode({ agentId: 'mailer', action: 'email', mode: 'block' });
    assert.match((await send()).denial, /permission blocks this action/);
    const pay = await humanGateDecision({ name: 'mcp__stripe__create_payment', args: { amount: 1 } }, null, {
      sessionId,
      store,
      annotations: {},
    });
    assert.deepEqual(pay.request.remember, ['once']);
    assert.equal(pay.request.agentId, 'mailer');
  });
}

const NO_ASK = { decision: { action: 'allow' }, request: null, gate: null };
const payment = { name: 'mcp__stripe__create_payment', args: { amount: 1 } };
const permanentDelete = { name: 'mcp__drive__empty_trash', args: {} };

/** One tool call through the hook layer; `shell` carries an ordinary ask. */
const hookCall = (sessionId, tool, cards) =>
  applyBeforeToolHook({
    ...tool,
    cwd: '/tmp',
    callerSessionId: sessionId,
    executeOpts: {},
    beforeToolHook: async () => (tool.name === 'shell' ? { action: 'ask', reason: 'policy' } : { action: 'allow' }),
    toolApprovalHook: async (request) => {
      cards.push(request);
      return { approved: true, response: 'approve' };
    },
  });

/** Work a schedule/webhook run started is the run: sends and ordinary asks are
 *  allowed, a payment and a permanent delete denied, never a card. */
async function assertRunWork(sessionId, kind = 'schedule') {
  assert.equal(unattendedApprovalPort().runOf(sessionId)?.kind, kind, `${sessionId} is the run`);
  const cards = [];
  for (const tool of [email, { name: 'shell', args: { command: 'echo' } }]) {
    assert.equal((await hookCall(sessionId, tool, cards)).denial, undefined, `${sessionId}: ${tool.name} runs`);
  }
  for (const tool of [payment, permanentDelete]) {
    assert.match((await hookCall(sessionId, tool, cards)).denial, /do it from the chat/, `${sessionId}: ${tool.name}`);
  }
  assert.deepEqual(cards, [], `${sessionId}: never a card`);
}

test('a coding Lead and a bot-created task session, with their sub-agents, stay ungated', async (t) => {
  const store = tempStore(t);
  for (const sessionId of ['sess_dlg_lead1', 'sess_dlg_lsub1', 'sess_dlg_task1', 'sess_dlg_tsub1', 'sess_dlg_tsub2']) {
    const out = await humanGateDecision(email, { action: 'allow' }, { sessionId, store, annotations: {} });
    assert.deepEqual(out, NO_ASK, sessionId);
    assert.equal(agentIdForSession(sessionId), agentIdForSession('sess_dlg_lead1'), sessionId);
  }
  assert.deepEqual(await store.readAudit({}), []);
});

test('sub-agents of a bot home or room member (any depth) are no bot: no outbound ask, no run', async (t) => {
  const store = tempStore(t);
  await store.setMode({ agentId: 'mailer', action: 'email', mode: 'block' });
  for (const sessionId of ['sess_dlg_sub1', 'sess_dlg_sub2', 'sess_dlg_rmem_w', 'sess_dlg_rmem_w2']) {
    const out = await humanGateDecision(email, { action: 'allow' }, { sessionId, store, annotations: {} });
    assert.deepEqual(out, NO_ASK, `${sessionId}: the bot's block does not reach it either`);
    assert.equal(agentIdForSession(sessionId), agentIdForSession('sess_dlg_lead1'), sessionId);
    assert.equal(actingContactBotId(sessionId), '', sessionId);
    assert.equal(unattendedApprovalPort().runOf(sessionId), null, sessionId);
    assert.equal(delegationOf(sessionId).state, 'resolved', sessionId);
  }
  // The seats themselves are the bot.
  for (const sessionId of [HOME, ROOM_MEMBER]) assert.equal(actingContactBotId(sessionId), 'mailer', sessionId);
});

test('a bot home or room seat sub-agent surfaces in that session with the bot name in the chain', () => {
  assert.deepEqual(approvalSurface('sess_dlg_sub1'), { sessionId: HOME, chain: ['사무관', 'Worker'] });
  assert.deepEqual(approvalSurface('sess_dlg_sub2'), { sessionId: HOME, chain: ['사무관', 'Worker', 'Reviewer'] });
  assert.deepEqual(approvalSurface('sess_dlg_rmem_w2'), {
    sessionId: ROOM_MEMBER,
    chain: ['사무관', 'Worker', 'Reviewer'],
  });
  for (const sessionId of [HOME, ROOM_MEMBER]) assert.equal(approvalSurface(sessionId), null, sessionId);
});

test("a bot sub-agent's ordinary approval shows in the bot home or room seat and is answered once", async () => {
  for (const [root, sub] of [
    [HOME, 'sess_dlg_sub1'],
    [ROOM_MEMBER, 'sess_dlg_rmem_w'],
  ]) {
    const top = sessionQueue(root);
    const pane = sessionQueue(sub);
    try {
      const answer = pane.api.requestToolApproval({ name: 'shell', args: {}, sessionId: sub });
      const shown = top.state().toolApproval;
      assert.equal(shown?.id, pane.state().toolApproval.id, 'one request, one id in both places');
      assert.deepEqual(shown.chain, ['사무관', 'Worker']);
      assert.equal(shown.remember, undefined, 'no bot grant is involved');
      assert.equal(top.api.finishToolApproval(shown.id, true, 'approved by user'), true);
      assert.equal((await answer).approved, true);
      assert.equal(pane.state().toolApproval, null);
      assert.equal(top.state().toolApproval, null);
      assert.equal(pane.api.finishToolApproval(shown.id, true), false, 'resolved once');
    } finally {
      top.dispose();
      pane.dispose();
    }
  }
});

test('a sub-agent surfaces in a coding Lead or task session with the chain; a task session is top-level', () => {
  // Under a bot-created task session the chain reads like a coding Lead's, in the task session.
  assert.deepEqual(approvalSurface('sess_dlg_tsub2'), {
    sessionId: 'sess_dlg_task1',
    chain: ['Lead', 'Worker', 'Reviewer'],
  });
  assert.deepEqual(approvalSurface('sess_dlg_lsub1'), { sessionId: 'sess_dlg_lead1', chain: ['Lead', 'Reviewer'] });
  // Top-level sessions (a task session included) surface in themselves.
  for (const sessionId of [HOME, 'sess_dlg_lead1', 'sess_dlg_task1']) assert.equal(approvalSurface(sessionId), null);
  // A coding Lead's and a task session's agents are never the bot.
  for (const sessionId of ['sess_dlg_task1', 'sess_dlg_tsub1', 'sess_dlg_tsub2', 'sess_dlg_lsub1'])
    assert.equal(actingContactBotId(sessionId), '', sessionId);
});

test('a task session a bot created (home, room member, run) and its nested Worker never ask for an email', async (t) => {
  const store = tempStore(t);
  const member = roomMemberSessionId('room123abc', 'mailer');
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Daily' });
  try {
    taskSession('sess_dlg_runtask1', HOME);
    agentChild('sess_dlg_runtask1_w', 'worker', 'sess_dlg_runtask1');
    agentChild('sess_dlg_runtask1_r', 'reviewer', 'sess_dlg_runtask1_w', 'sess_dlg_runtask1');
  } finally {
    unmark();
  }
  taskSession('sess_dlg_hometask2', HOME);
  agentChild('sess_dlg_hometask2_w', 'worker', 'sess_dlg_hometask2');
  taskSession('sess_dlg_roomtask', member);
  agentChild('sess_dlg_roomtask_w', 'worker', 'sess_dlg_roomtask');
  agentChild('sess_dlg_roomtask_r', 'reviewer', 'sess_dlg_roomtask_w', 'sess_dlg_roomtask');
  for (const [task, nested, run] of [
    ['sess_dlg_hometask2', ['sess_dlg_hometask2_w'], false],
    ['sess_dlg_roomtask', ['sess_dlg_roomtask_w', 'sess_dlg_roomtask_r'], false],
    // Started by a schedule run: the run's own work, auto-allowed like the run (never a card).
    ['sess_dlg_runtask1', ['sess_dlg_runtask1_w', 'sess_dlg_runtask1_r'], true],
  ]) {
    assert.equal(delegationOf(task).state, 'top', task);
    assert.equal(approvalSurface(task), null, task);
    for (const [depth, sessionId] of nested.entries()) {
      assert.deepEqual(
        approvalSurface(sessionId),
        { sessionId: task, chain: ['Lead', 'Worker', 'Reviewer'].slice(0, depth + 2) },
        sessionId
      );
    }
    for (const sessionId of [task, ...nested]) {
      assert.equal(
        unattendedApprovalPort().runOf(sessionId)?.kind ?? null,
        run ? 'schedule' : null,
        `${sessionId}: ${run ? 'the run' : 'attended'}`
      );
      if (!run) {
        assert.equal(actingContactBotId(sessionId), '', sessionId);
        const out = await humanGateDecision(email, { action: 'allow' }, { sessionId, store, annotations: {} });
        assert.deepEqual(out, NO_ASK, sessionId);
      }
      const hooked = await applyBeforeToolHook({
        ...email,
        cwd: '/tmp',
        callerSessionId: sessionId,
        executeOpts: {},
        beforeToolHook: async () => ({ action: 'allow' }),
        toolApprovalHook: async () => assert.fail(`${sessionId} must not be asked`),
      });
      assert.equal(hooked.denial, undefined, sessionId);
    }
  }
  const decisions = (await store.readAudit({})).map((row) => row.decision);
  assert.ok(decisions.length > 0 && decisions.every((d) => d === 'run-allowed'), 'only the run auto-allowed');
});

test('a stored delegation with a task step (a task session sub-agent from before) no longer acts as the bot', async (t) => {
  const store = tempStore(t);
  const stale = (id, agent, parent, delegation) =>
    setLiveSession({ ...childRecord(id, agent, parent, parent), delegation, createdAt: Date.now() });
  const oldHome = {
    rootSessionId: HOME,
    rootAgentId: 'mailer',
    via: 'home',
    path: [{ kind: 'task' }, { kind: 'agent', agent: 'worker' }],
  };
  const oldRun = {
    rootSessionId: HOME,
    rootAgentId: 'mailer',
    via: 'run',
    run: { kind: 'schedule', name: '' },
    path: [{ kind: 'task' }, { kind: 'agent', agent: 'worker' }],
  };
  stale('sess_dlg_stale_home', 'worker', 'sess_dlg_task1', oldHome);
  stale('sess_dlg_stale_run', 'worker', 'sess_dlg_task1', oldRun);
  stale('sess_dlg_stale_nested', 'reviewer', 'sess_dlg_stale_home', {
    ...oldHome,
    path: [...oldHome.path, { kind: 'agent', agent: 'reviewer' }],
  });
  for (const sessionId of ['sess_dlg_stale_home', 'sess_dlg_stale_nested']) {
    const out = await humanGateDecision(email, { action: 'allow' }, { sessionId, store, annotations: {} });
    assert.deepEqual(out, NO_ASK, sessionId);
    assert.equal(actingContactBotId(sessionId), '', sessionId);
    assert.equal(unattendedApprovalPort().runOf(sessionId), null, sessionId);
    assert.equal(approvalSurface(sessionId).sessionId, 'sess_dlg_task1', sessionId);
    assert.equal(loadSession(sessionId).delegation.via, 'coding', `${sessionId}: re-derived`);
    assert.ok(
      loadSession(sessionId).delegation.path.every((step) => step.kind === 'agent'),
      sessionId
    );
  }
  assert.deepEqual(approvalSurface('sess_dlg_stale_nested').chain, ['Lead', 'Worker', 'Reviewer']);

  // A stored run-born delegation is the run's work still: the run is stamped
  // before the delegation is derived again (reading it first must not lose it).
  assert.equal(delegationOf('sess_dlg_stale_run').via, 'coding', 're-derived under the task session');
  assert.deepEqual(loadSession('sess_dlg_stale_run').run, { kind: 'schedule', agentId: 'mailer', name: '' });
  await assertRunWork('sess_dlg_stale_run');

  // An older shape under a bot's own sessions (acting as the bot, unknown) is re-derived too.
  for (const [i, [parent, old]] of [
    [HOME, { rootAgentId: 'mailer', via: 'home' }],
    [HOME, { rootAgentId: 'mailer', via: 'unknown' }],
    [ROOM_MEMBER, { rootAgentId: 'mailer', via: 'room' }],
  ].entries()) {
    const id = `sess_dlg_stale_bot${i}`;
    stale(id, 'worker', parent, { rootSessionId: parent, ...old, path: [{ kind: 'agent', agent: 'worker' }] });
    const out = await humanGateDecision(email, { action: 'allow' }, { sessionId: id, store, annotations: {} });
    assert.deepEqual(out, NO_ASK, id);
    assert.equal(delegationOf(id).via, 'bot', id);
    assert.equal(loadSession(id).delegation.via, 'bot', `${id}: persisted`);
    assert.equal(unattendedApprovalPort().runOf(id), null, id);
    assert.equal(approvalSurface(id).sessionId, parent, id);
  }
  // …and one a schedule run stored (`via: 'run'`), whether the gate or the
  // delegation read comes first, keeps being that run's.
  for (const [id, first] of [
    ['sess_dlg_stale_runbot0', 'gate'],
    ['sess_dlg_stale_runbot1', 'delegation'],
  ]) {
    stale(id, 'worker', HOME, {
      rootSessionId: HOME,
      rootAgentId: 'mailer',
      via: 'run',
      run: { kind: 'webhook', name: 'Hook' },
      path: [{ kind: 'agent', agent: 'worker' }],
    });
    if (first === 'delegation') assert.equal(delegationOf(id).via, 'bot');
    await assertRunWork(id, 'webhook');
    assert.deepEqual(unattendedApprovalPort().runOf(id), { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
    assert.equal(delegationOf(id).via, 'bot', `${id}: re-derived`);
  }
});

test('a session whose parent is unknown is no bot session: never an outbound ask, nothing mirrored', async (t) => {
  const store = tempStore(t);
  // Its parent's record is gone (not a home or room id); a session naming
  // itself as parent; a child of one with no root.
  agentChild('sess_dlg_orphan', 'worker', 'sess_dlg_deleted_parent');
  setLiveSession(childRecord('sess_dlg_self', 'worker', 'sess_dlg_self'));
  agentChild('sess_dlg_orphan2', 'worker', 'sess_dlg_orphan');
  for (const sessionId of ['sess_dlg_orphan', 'sess_dlg_self', 'sess_dlg_orphan2']) {
    const out = await humanGateDecision(email, { action: 'allow' }, { sessionId, store, annotations: {} });
    assert.deepEqual(out, NO_ASK, sessionId);
    assert.equal(actingContactBotId(sessionId), '', sessionId);
    assert.equal(delegationOf(sessionId).state, 'top', sessionId);
    assert.equal(approvalSurface(sessionId), null, `${sessionId} stays in its own session`);
    assert.equal(unattendedApprovalPort().runOf(sessionId), null, sessionId);
  }
});

test('a delegated session records its root at creation; reading it never walks the parents', () => {
  assert.deepEqual(loadSession('sess_dlg_tsub2').delegation, {
    rootSessionId: 'sess_dlg_task1',
    via: 'coding',
    path: [
      { kind: 'agent', agent: 'worker' },
      { kind: 'agent', agent: 'reviewer' },
    ],
  });
  assert.deepEqual(loadSession('sess_dlg_lsub1').delegation, {
    rootSessionId: 'sess_dlg_lead1',
    via: 'coding',
    path: [{ kind: 'agent', agent: 'reviewer' }],
  });
  assert.deepEqual(loadSession('sess_dlg_sub1').delegation, {
    rootSessionId: HOME,
    via: 'bot',
    path: [{ kind: 'agent', agent: 'worker' }],
  });
  // The intermediate records may disappear later: the nested one still resolves.
  setLiveSession({ id: 'sess_dlg_tsub1', owner: 'agent', agent: 'worker', visibility: 'agent-only' });
  assert.deepEqual(approvalSurface('sess_dlg_tsub2'), {
    sessionId: 'sess_dlg_task1',
    chain: ['Lead', 'Worker', 'Reviewer'],
  });
  agentChild('sess_dlg_tsub1', 'worker', 'sess_dlg_task1');
});

test('origin is set by the host, never by tool input', async () => {
  const member = roomMemberSessionId('room123abc', 'mailer');
  const calls = [];
  const runtime = { getState: () => ({}), subscribe: () => () => {} };
  const api = createAgentTaskSessions({
    getSessionService: () => ({
      createSession: async (params) => {
        calls.push(params);
        return { sessionId: 'sess_dlg_forged' };
      },
      configureSession: async () => ({ value: {} }),
      materializeSession: async () => runtime,
      submitSession: async () => ({ accepted: true }),
    }),
    deliver: async () => {},
    watches: { add: async () => {}, list: async () => [], remove: async () => {} },
    queuedSubmissionIds: async () => [],
    loadSession: async () => null,
    listProjects: async () => [],
    newTaskDefault: async () => null,
    leadRoute: async () => ({ provider: 'p', model: 'm' }),
    log: () => {},
  });
  // A model in a room asks for a task and tries to pass itself off as the bot's own chat.
  const forged = {
    brief: 'do it',
    title: 'Forged',
    sourceName: 'agent:mailer@home',
    from: 'home',
    taskOrigin: { sessionId: HOME },
    delegation: { rootSessionId: HOME, rootAgentId: 'mailer', via: 'home', path: [] },
    run: { kind: 'schedule', agentId: 'mailer', name: 'Forged' },
  };
  await api.create(forged, { callerSessionId: member, callerAgentId: 'mailer', callerCwd: dataRoot });
  const profile = calls[0].sessionProfile;
  assert.equal(profile.taskOrigin.sessionId, member);
  assert.equal('run' in profile, false, 'tool input carries no run into the session profile');
  const options = sessionOptions(
    {
      rt: {
        route: { provider: 'openai-oauth', model: 'gpt-test' },
        config: {},
        mode: 'full',
        sessionProfile: { ...profile, sourceName: 'agent:mailer@home', delegation: forged.delegation },
        currentCwd: dataRoot,
      },
      cfgMod: { getPluginData: () => dataRoot },
      activeWorkflowContext: () => ({ summary: null, packContext: '', leadPromptParts: () => ({}) }),
      featureDisallowedTools: () => [],
    },
    null
  );
  assert.equal(options.sourceName, 'agent:mailer@room');
  assert.equal('run' in options, false);
  created({ id: 'sess_dlg_forged', ...options, delegation: forged.delegation });
  // A task session is a top-level coding Lead whatever the options claim.
  assert.equal(delegationOf('sess_dlg_forged').state, 'top');
  assert.equal(actingContactBotId('sess_dlg_forged'), '');
  assert.equal(approvalSurface('sess_dlg_forged'), null);
  agentChild('sess_dlg_forged_w', 'worker', 'sess_dlg_forged');
  assert.deepEqual(approvalSurface('sess_dlg_forged_w'), { sessionId: 'sess_dlg_forged', chain: ['Lead', 'Worker'] });
  assert.equal(actingContactBotId('sess_dlg_forged_w'), '');
});

test('a run in creation options is ignored: only the creating session decides what a new session is', () => {
  const forgedRun = { kind: 'schedule', agentId: 'mailer', name: 'Forged' };
  const originOf = (record) =>
    sessionOriginFields(record, {
      profile: null,
      presetObj: null,
      providerCacheOpts: null,
      surface: { toolPermission: null, hasCallerAllow: false },
    });
  const forgedDelegation = { rootSessionId: HOME, rootAgentId: 'mailer', via: 'run', run: forgedRun, path: [] };
  const task = {
    id: 'sess_dlg_forgerun_t',
    owner: 'cli',
    agent: 'lead',
    taskOrigin: { agentId: 'mailer', sessionId: HOME, requestId: 'atask_fr', title: 'T', notify: true },
  };
  // An attended creator: a forged run (or delegation) on a sub-agent or task session changes nothing.
  for (const record of [
    { ...childRecord('sess_dlg_forgerun_w', 'worker', HOME), run: forgedRun, delegation: forgedDelegation },
    { ...childRecord('sess_dlg_forgerun_c', 'reviewer', 'sess_dlg_lead1'), run: forgedRun },
    { ...task, run: forgedRun },
  ]) {
    assert.equal('run' in originOf(record), false, record.id);
    assert.notDeepEqual(originOf(record).delegation, forgedDelegation, record.id);
  }
  // A running creator: the new session gets that run, whatever the options say.
  const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
  try {
    for (const record of [
      { ...childRecord('sess_dlg_forgerun_w2', 'worker', HOME), run: forgedRun },
      { ...task, run: forgedRun },
    ]) {
      assert.deepEqual(originOf(record).run, { kind: 'webhook', agentId: 'mailer', name: 'Hook' }, record.id);
    }
  } finally {
    unmark();
  }
});

test('the task session records where it was created, for the desktop (home, room, run)', () => {
  const optionsFor = (sessionId) =>
    sessionOptions(
      {
        rt: {
          route: { provider: 'openai-oauth', model: 'gpt-test' },
          config: {},
          mode: 'full',
          sessionProfile: { taskOrigin: { agentId: 'mailer', sessionId, requestId: 'atask_x', title: 'T' } },
          currentCwd: dataRoot,
        },
        cfgMod: { getPluginData: () => dataRoot },
        activeWorkflowContext: () => ({ summary: null, packContext: '', leadPromptParts: () => ({}) }),
        featureDisallowedTools: () => [],
      },
      null
    );
  assert.equal(optionsFor(HOME).sourceName, 'agent:mailer@home');
  assert.equal(optionsFor(roomMemberSessionId('room123abc', 'mailer')).sourceName, 'agent:mailer@room');
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Daily' });
  try {
    assert.equal(optionsFor(HOME).sourceName, 'agent:mailer@run', 'a schedule turn in the home is no attended chat');
  } finally {
    unmark();
  }
  // Another bot's home, a coding session: origin unknown to the desktop.
  assert.equal(optionsFor('sess_dlg_lead1').sourceName, 'agent:mailer');
});

test('what a run started stays the run: auto-allowed like the run, ended or not, after a restart; later work is attended', async (t) => {
  tempStore(t);
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Nightly' });
  // Started by the run: a sub-agent with its own sub-agent, and a task session with a Worker.
  agentChild('sess_dlg_runsub', 'worker', HOME);
  agentChild('sess_dlg_runtsub', 'reviewer', 'sess_dlg_runsub', HOME);
  taskSession('sess_dlg_runtask', HOME);
  agentChild('sess_dlg_runtask_w', 'worker', 'sess_dlg_runtask');
  unmark();
  // Started after the run, by the user's own turn in the home.
  agentChild('sess_dlg_latersub', 'worker', HOME);
  // As read back after a daemon restart: only the record says it was the run's.
  setLiveSession({ ...loadSession('sess_dlg_runtsub'), id: 'sess_dlg_restored' });
  const runOf = unattendedApprovalPort().runOf;
  const run = { kind: 'schedule', agentId: 'mailer', name: 'Nightly' };
  for (const sessionId of [
    'sess_dlg_runsub',
    'sess_dlg_runtsub',
    'sess_dlg_runtask',
    'sess_dlg_runtask_w',
    'sess_dlg_restored',
  ]) {
    assert.deepEqual(runOf(sessionId), run, sessionId);
    await assertRunWork(sessionId);
  }
  assert.equal(runOf('sess_dlg_latersub'), null);
  assert.equal(runOf(HOME), null, 'the home itself is attended again');
});

test('a run in the bot home never remembers: the run-policy answer carries no grant', async (t) => {
  const store = tempStore(t);
  const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
  t.after(unmark);
  const out = await applyBeforeToolHook({
    ...email,
    cwd: '/tmp',
    callerSessionId: HOME,
    executeOpts: {},
    beforeToolHook: async () => ({ action: 'allow' }),
    toolApprovalHook: async () => assert.fail('a run has no card'),
  });
  assert.equal(out.denial, undefined);
  assert.deepEqual(await store.listGrants({ agentId: 'mailer' }), []);
});

test('pre-upgrade records (no delegation) are backfilled once from the parent, never from model input', async (t) => {
  const store = tempStore(t);
  const legacy = (record) => {
    setLiveSession(record);
    return record;
  };
  // An ordinary coding Lead (no agent provenance) → coding: unchanged, no ask.
  legacy(childRecord('sess_bf_code', 'reviewer', 'sess_dlg_lead1'));
  const coding = await humanGateDecision(
    email,
    { action: 'allow' },
    { sessionId: 'sess_bf_code', store, annotations: {} }
  );
  assert.deepEqual(coding, { decision: { action: 'allow' }, request: null, gate: null });
  assert.equal(delegationOf('sess_bf_code').via, 'coding');
  assert.equal(loadSession('sess_bf_code').delegation.via, 'coding', 'persisted on the child');
  // A bot home's old sub-agent is no bot work: no ask, nothing mirrored.
  setLiveSession({ id: HOME, owner: 'cli', agent: 'lead' });
  legacy(childRecord('sess_bf_home', 'worker', HOME));
  const home = await humanGateDecision(
    email,
    { action: 'allow' },
    { sessionId: 'sess_bf_home', store, annotations: {} }
  );
  assert.deepEqual(home, { decision: { action: 'allow' }, request: null, gate: null });
  assert.equal(delegationOf('sess_bf_home').via, 'bot');
  assert.equal(loadSession('sess_bf_home').delegation.via, 'bot');
  assert.equal(actingContactBotId('sess_bf_home'), '');
  assert.deepEqual(approvalSurface('sess_bf_home'), { sessionId: HOME, chain: ['사무관', 'Worker'] });
  // A task session a bot created before (taskOrigin, with or without the
  // host-set sourceName) is a top-level coding Lead; its old sub-agent is its.
  legacy({
    id: 'sess_bf_task',
    owner: 'cli',
    agent: 'lead',
    taskOrigin: { agentId: 'mailer', sessionId: HOME, requestId: 'atask_bf', title: 'Old', notify: true },
  });
  legacy(childRecord('sess_bf_tsub', 'worker', 'sess_bf_task'));
  assert.deepEqual(approvalSurface('sess_bf_tsub'), { sessionId: 'sess_bf_task', chain: ['Lead', 'Worker'] });
  assert.equal(loadSession('sess_bf_task').delegation, undefined);
  assert.equal(loadSession('sess_bf_tsub').delegation.via, 'coding');
  // Host-set bot provenance on a Lead (home, room or suffixless) changes nothing.
  for (const from of ['@home', '@room', '']) {
    const lead = `sess_bf_src${from.slice(1) || 'old'}`;
    legacy({ id: lead, owner: 'cli', agent: 'lead', sourceType: 'lead', sourceName: `agent:mailer${from}` });
    legacy(childRecord(`${lead}_w`, 'worker', lead));
    const out = await humanGateDecision(email, { action: 'allow' }, { sessionId: `${lead}_w`, store, annotations: {} });
    assert.deepEqual(out, { decision: { action: 'allow' }, request: null, gate: null }, lead);
    assert.equal(unattendedApprovalPort().runOf(`${lead}_w`), null, lead);
  }
  // …but the task source `@run` is a run's: the task session and its old
  // sub-agent (no delegation recorded) are that run's work.
  legacy({
    id: 'sess_bf_srcrun',
    owner: 'cli',
    agent: 'lead',
    sourceType: 'lead',
    sourceName: 'agent:mailer@run',
    taskOrigin: { agentId: 'mailer', sessionId: HOME, requestId: 'atask_bfr', title: 'Run', notify: true },
  });
  legacy(childRecord('sess_bf_srcrun_w', 'worker', 'sess_bf_srcrun'));
  legacy(childRecord('sess_bf_srcrun_w2', 'reviewer', 'sess_bf_srcrun_w'));
  for (const sessionId of ['sess_bf_srcrun', 'sess_bf_srcrun_w', 'sess_bf_srcrun_w2']) {
    assert.deepEqual(unattendedApprovalPort().runOf(sessionId), { kind: 'schedule', agentId: 'mailer', name: '' });
    await assertRunWork(sessionId);
  }
  assert.equal(delegationOf('sess_bf_srcrun_w2').via, 'coding', 'rooted at the task session');
  assert.equal(loadSession('sess_bf_srcrun_w2').run.kind, 'schedule', 'the run stays stamped with its delegation');
  // A missing parent has no root: no bot's session, no ask, nothing persisted.
  legacy(childRecord('sess_bf_gone', 'worker', 'sess_bf_missing_parent'));
  const out = await humanGateDecision(
    email,
    { action: 'allow' },
    { sessionId: 'sess_bf_gone', store, annotations: {} }
  );
  assert.deepEqual(out, { decision: { action: 'allow' }, request: null, gate: null });
  assert.equal(approvalSurface('sess_bf_gone'), null);
  assert.equal(loadSession('sess_bf_gone').delegation, undefined, 'nothing persisted');
});

test('legacy work of a webhook that has ended: only what recorded the run is the run', async (t) => {
  const store = tempStore(t);
  setLiveSession({ id: HOME, owner: 'cli', agent: 'lead' });
  const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
  // Created during the webhook by the old code: no delegation, no run recorded
  // for the sub-agent (nothing says it was the run's); the task session names `@run`.
  setLiveSession(childRecord('sess_wh_child', 'worker', HOME));
  setLiveSession({
    id: 'sess_wh_task',
    owner: 'cli',
    agent: 'lead',
    sourceType: 'lead',
    sourceName: 'agent:mailer@run',
    taskOrigin: { agentId: 'mailer', sessionId: HOME, requestId: 'atask_wh', title: 'Hook', notify: true },
  });
  setLiveSession(childRecord('sess_wh_tsub', 'worker', 'sess_wh_task'));
  unmark();
  // Read for the first time after the webhook ended.
  const runOf = unattendedApprovalPort().runOf;
  const child = await humanGateDecision(
    email,
    { action: 'allow' },
    { sessionId: 'sess_wh_child', store, annotations: {} }
  );
  assert.deepEqual(child, NO_ASK, 'a bot sub-agent with no recorded run asks nothing');
  assert.equal(runOf('sess_wh_child'), null);
  for (const sessionId of ['sess_wh_task', 'sess_wh_tsub']) {
    assert.equal(runOf(sessionId)?.agentId, 'mailer', sessionId);
    await assertRunWork(sessionId);
  }
});

/** One session's approval queue, as the daemon runs it. */
function sessionQueue(sessionId, { timeoutMs = 60_000 } = {}) {
  let state = { sessionId, toolApproval: null, toolApprovalResult: null };
  let disposed = false;
  let seq = 0;
  const api = createToolApproval({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    nextId: () => `${sessionId}-req-${++seq}`,
    getDisposed: () => disposed,
    timeoutMs,
    surfaceOf: approvalSurface,
  });
  return {
    api,
    state: () => state,
    dispose() {
      disposed = true;
      api.denyAllToolApprovals('runtime closing');
    },
  };
}

test('a sub-agent approval appears in the top-level chat with its chain and resolves once from there', async () => {
  const home = sessionQueue('sess_dlg_lead1');
  const sub = sessionQueue('sess_dlg_lsub1');
  try {
    const answer = sub.api.requestToolApproval({
      ...email,
      kind: 'outbound',
      sessionId: 'sess_dlg_lsub1',
      remember: ['once', 'agent'],
      agentId: 'mailer',
    });
    const shown = home.state().toolApproval;
    assert.ok(shown, 'the Lead shows the card');
    assert.equal(shown.id, sub.state().toolApproval.id, 'one request, one id in both places');
    assert.deepEqual(shown.remember, ['once', 'agent'], 'offered wherever the card is shown');
    assert.deepEqual(sub.state().toolApproval.remember, ['once', 'agent']);
    assert.deepEqual(shown.chain, ['Lead', 'Reviewer']);
    assert.equal(shown.sessionId, 'sess_dlg_lsub1');
    // The home's own turn ending does not take the sub-agent's card away.
    home.api.denyAllToolApprovals('turn finished');
    assert.equal(home.state().toolApproval?.id, shown.id);
    assert.equal(
      home.api.finishToolApproval(shown.id, true, 'approved by user', 'Pixel', undefined, undefined, {
        remember: 'agent',
      }),
      true
    );
    const result = await answer;
    assert.equal(result.approved, true);
    assert.equal(result.remember, 'agent');
    assert.equal(result.device, 'Pixel');
    assert.equal(home.state().toolApproval, null);
    assert.equal(sub.state().toolApproval, null);
    // A second answer from either place finds nothing: no double execution.
    assert.equal(sub.api.finishToolApproval(shown.id, true), false);
    assert.equal(home.api.finishToolApproval(shown.id, true), false);
  } finally {
    home.dispose();
    sub.dispose();
  }
});

test('a remember answer the card offered counts wherever it is answered; one it did not offer is once', async () => {
  const home = sessionQueue(HOME);
  const member = sessionQueue(ROOM_MEMBER);
  const lead = sessionQueue('sess_dlg_lead1');
  const sub = sessionQueue('sess_dlg_lsub1');
  const outbound = { ...email, kind: 'outbound', remember: ['once', 'agent'], agentId: 'mailer' };
  const answerIn = async (queue, request, remember) => {
    const answer = queue.api.requestToolApproval({ ...request, sessionId: queue.state().sessionId });
    queue.api.finishToolApproval(queue.state().toolApproval.id, true, 'ok', '', undefined, undefined, { remember });
    return (await answer).remember;
  };
  try {
    assert.equal(await answerIn(home, outbound, 'agent'), 'agent', 'the bot home');
    assert.equal(await answerIn(member, outbound, 'agent'), 'agent', 'the room member session');
    assert.equal(await answerIn(home, { ...outbound, remember: ['once'] }, 'agent'), 'once', 'not offered');
    // A card mirrored into another pane and answered in either keeps the offered scope.
    const answer = sub.api.requestToolApproval({ ...outbound, sessionId: 'sess_dlg_lsub1' });
    lead.api.finishToolApproval(lead.state().toolApproval.id, true, 'ok', '', undefined, undefined, {
      remember: 'agent',
    });
    assert.equal((await answer).remember, 'agent');
    const second = sub.api.requestToolApproval({ ...outbound, sessionId: 'sess_dlg_lsub1' });
    sub.api.finishToolApproval(sub.state().toolApproval.id, true, 'ok', '', undefined, undefined, {
      remember: 'agent',
    });
    assert.equal((await second).remember, 'agent');
  } finally {
    home.dispose();
    member.dispose();
    lead.dispose();
    sub.dispose();
  }
});

test("with no hand-off owing its report, a bot-created task session's own approval stays in the task session; its Worker's shows there too", async () => {
  const home = sessionQueue(HOME);
  const task = sessionQueue('sess_dlg_task1');
  const worker = sessionQueue('sess_dlg_tsub1');
  try {
    const own = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    assert.equal(home.state().toolApproval, null, "not copied into the bot's chat");
    task.api.finishToolApproval(task.state().toolApproval.id, true, 'approved by user');
    assert.equal((await own).approved, true);

    const answer = worker.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_tsub1' });
    assert.equal(home.state().toolApproval, null);
    const shown = task.state().toolApproval;
    assert.deepEqual(shown.chain, ['Lead', 'Worker']);
    assert.equal(task.api.finishToolApproval(shown.id, true, 'approved by user'), true);
    assert.equal((await answer).approved, true);
    assert.equal(worker.state().toolApproval, null);
  } finally {
    home.dispose();
    task.dispose();
    worker.dispose();
  }
});

const handoffDirs = [];
test.after(() => {
  for (const dir of handoffDirs) rmSync(dir, { recursive: true, force: true });
});
/** The real report watch store (agent-home-delivery.mjs) in a temp file, as
 *  agent-task-sessions.mjs drives it: store a watch, list them, report a
 *  turn's end (dropping the watches it names), drop one never taken. */
function handoffPorts(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-watches-'));
  handoffDirs.push(dir);
  const path = join(dir, 'routine-results.json');
  const queue = createRoutineResultQueue(path, options);
  return {
    path,
    queue,
    deliver: (_agentId, report) => {
      const unwatch = [report.watchId, ...(report.watchIds ?? [])].filter(Boolean);
      return queue.add(HOME, { runId: report.runId }, { unwatch });
    },
    watches: {
      add: (watch) => queue.watch(watch),
      list: () => queue.watches(),
      remove: (runId) => queue.unwatch(runId),
    },
  };
}
const handoffWatch = (runId, taskSessionId, title, homeSessionId = HOME) => ({
  runId,
  agentId: 'mailer',
  homeSessionId,
  taskSessionId,
  title,
  at: Date.now(),
});
taskSession('sess_dlg_task2', HOME, 'atask_2');
taskSession('sess_dlg_task3', HOME, 'atask_3');

test("a task session the bot's chat handed work to asks in that chat too, named; answering there settles its own card", async () => {
  const ports = handoffPorts();
  const home = sessionQueue(HOME);
  const task = sessionQueue('sess_dlg_task1');
  try {
    await ports.watches.add(handoffWatch('atask_h1', 'sess_dlg_task1', 'Fix login'));
    assert.deepEqual([...handoffChatsOf('sess_dlg_task1')], [[HOME, { title: 'Fix login' }]]);
    assert.equal(approvalSurface('sess_dlg_task1'), null, 'still a top-level session');
    const answer = task.api.requestToolApproval({
      name: 'shell',
      args: { command: 'npm test' },
      sessionId: 'sess_dlg_task1',
    });
    const own = task.state().toolApproval;
    const shown = home.state().toolApproval;
    assert.ok(own, 'its own pane still shows it');
    assert.equal(shown?.id, own.id, 'one request, one id in both places');
    assert.equal(shown.sessionId, 'sess_dlg_task1');
    assert.equal(shown.surfaceSessionId, HOME);
    assert.deepEqual(shown.handoff, { title: 'Fix login' });
    assert.equal(home.api.finishToolApproval(shown.id, true, 'approved by user', 'DESKTOP-7'), true);
    assert.equal((await answer).approved, true);
    assert.equal(task.state().toolApproval, null, "the task session's own card is settled");
    assert.deepEqual(
      { id: task.state().toolApprovalResult?.id, device: task.state().toolApprovalResult?.device },
      { id: own.id, device: 'DESKTOP-7' },
      'and says where it was answered'
    );
    assert.equal(home.state().toolApproval, null);
    assert.equal(task.api.finishToolApproval(own.id, false), false, 'never answered twice');
    // Its report ends the hand-off: a later approval stays in the task session.
    await ports.deliver('mailer', {
      runId: 'atask_h1_end',
      taskSessionId: 'sess_dlg_task1',
      status: 'completed',
      watchId: 'atask_h1',
    });
    assert.equal(handoffChatsOf('sess_dlg_task1').size, 0);
    const later = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    assert.equal(home.state().toolApproval, null);
    task.api.finishToolApproval(task.state().toolApproval.id, false, 'no');
    assert.equal((await later).approved, false);
  } finally {
    endHandoff('atask_h1');
    home.dispose();
    task.dispose();
  }
});

test('the chat shows its waiting approvals one at a time and counts every one behind the shown one', async () => {
  const ports = handoffPorts();
  const home = sessionQueue(HOME);
  const first = sessionQueue('sess_dlg_task1');
  const second = sessionQueue('sess_dlg_task2');
  try {
    await ports.watches.add(handoffWatch('atask_q1', 'sess_dlg_task1', 'Fix login'));
    await ports.watches.add(handoffWatch('atask_q2', 'sess_dlg_task2', 'Bump deps'));
    const a = first.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    const b = second.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task2' });
    assert.equal(home.state().toolApproval.handoff.title, 'Fix login');
    assert.equal(home.state().toolApprovalsWaiting, 1, '"1/2"');
    // The chat's own request queues behind them and counts too.
    const mine = home.api.requestToolApproval({ name: 'shell', args: {}, sessionId: HOME });
    assert.equal(home.state().toolApprovalsWaiting, 2, '"1/3"');
    home.api.finishToolApproval(home.state().toolApproval.id, true, 'ok');
    assert.equal((await a).approved, true);
    assert.equal(home.state().toolApproval.handoff.title, 'Bump deps', 'the next one in the same place');
    assert.equal(home.state().toolApprovalsWaiting, 1);
    // Answered in its own pane: the copy leaves the chat, and the count with it.
    second.api.finishToolApproval(second.state().toolApproval.id, true, 'ok');
    assert.equal((await b).approved, true);
    assert.equal(home.state().toolApproval.sessionId, HOME);
    assert.equal(home.state().toolApprovalsWaiting, 0, '"1/1" is left');
    home.api.finishToolApproval(home.state().toolApproval.id, true, 'ok');
    assert.equal((await mine).approved, true);
    assert.equal(home.state().toolApproval, null);
  } finally {
    endHandoff('atask_q1');
    endHandoff('atask_q2');
    home.dispose();
    first.dispose();
    second.dispose();
  }
});

test('a session this chat handed no work to never asks there; work another chat handed asks in that chat', async () => {
  const ports = handoffPorts();
  const home = sessionQueue(HOME);
  const other = sessionQueue('sess_dlg_lead1');
  const task = sessionQueue('sess_dlg_task3');
  try {
    // Created by this bot, but no hand-off owes a report (notify: false, or reported).
    const quiet = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task3' });
    assert.equal(home.state().toolApproval, null);
    task.api.finishToolApproval(task.state().toolApproval.id, true, 'ok');
    await quiet;
    // Handed work by another chat: it asks there, never here.
    await ports.watches.add(handoffWatch('atask_o1', 'sess_dlg_task3', 'Other work', 'sess_dlg_lead1'));
    const asked = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task3' });
    assert.equal(home.state().toolApproval, null);
    assert.equal(other.state().toolApproval?.handoff.title, 'Other work');
    other.api.finishToolApproval(other.state().toolApproval.id, true, 'ok');
    assert.equal((await asked).approved, true);
  } finally {
    endHandoff('atask_o1');
    home.dispose();
    other.dispose();
    task.dispose();
  }
});

test('hand-offs follow the report watches: ended by a report naming them or a turn never taken, never listed back', async () => {
  const ports = handoffPorts();
  const title = () => handoffChatsOf('sess_dlg_task1').get(HOME)?.title;
  await ports.watches.add(handoffWatch('atask_w1', 'sess_dlg_task1', 'One'));
  await ports.watches.add(handoffWatch('atask_w2', 'sess_dlg_task1', 'Two'));
  assert.equal(handoffChatsOf('sess_dlg_task1').size, 1, 'one chat, once');
  assert.equal(title(), 'Two', "the chat's latest hand-off names it");
  // One turn answered both sends: its report names every watch it closes.
  await ports.deliver('mailer', {
    runId: 'atask_w1_end',
    status: 'completed',
    watchId: 'atask_w1',
    watchIds: ['atask_w1', 'atask_w2'],
  });
  assert.equal(handoffChatsOf('sess_dlg_task1').size, 0);
  // Read again, the store has neither; an ended run id never comes back.
  await ports.watches.list();
  assert.equal(handoffChatsOf('sess_dlg_task1').size, 0);
  noteHandoff(handoffWatch('atask_w1', 'sess_dlg_task1', 'One'));
  assert.equal(handoffChatsOf('sess_dlg_task1').size, 0, 'a stale read of an ended watch notes nothing');
  // A progress or wait report closes nothing; a turn never taken does.
  await ports.watches.add(handoffWatch('atask_w3', 'sess_dlg_task1', 'Three'));
  await ports.deliver('mailer', { runId: 'sess_dlg_task1_x_blocked', status: 'blocked' });
  assert.equal(title(), 'Three');
  await ports.watches.remove('atask_w3');
  assert.equal(handoffChatsOf('sess_dlg_task1').size, 0);
});

test('an ended hand-off stays ended however many others end after it', async () => {
  const stale = handoffWatch('atask_old1', 'sess_dlg_task1', 'Old');
  noteHandoff(stale);
  assert.equal(handoffChatsOf('sess_dlg_task1').size, 1);
  endHandoff('atask_old1');
  assert.equal(handoffChatsOf('sess_dlg_task1').size, 0);
  // More ends than any fixed tombstone cap would have kept.
  for (let i = 0; i < 5_000; i += 1) {
    noteHandoff(handoffWatch(`atask_many${i}`, 'sess_dlg_task1', 'Many'));
    endHandoff(`atask_many${i}`);
  }
  noteHandoff(stale);
  assert.equal(handoffChatsOf('sess_dlg_task1').size, 0, 'the stale registration is rejected');
});

// Two chats hand the same task session work: the bot home (A) and a coding Lead (B).
const CHAT_B = 'sess_dlg_lead1';

test('every chat with a live hand-off docks the request once; an answer anywhere settles it once and clears the rest', async () => {
  const ports = handoffPorts();
  const a = sessionQueue(HOME);
  const b = sessionQueue(CHAT_B);
  const bystander = sessionQueue('sess_dlg_task2');
  const task = sessionQueue('sess_dlg_task1');
  try {
    await ports.watches.add(handoffWatch('atask_m1', 'sess_dlg_task1', 'Fix login'));
    await ports.watches.add(handoffWatch('atask_m2', 'sess_dlg_task1', 'Fix login again'));
    await ports.watches.add(handoffWatch('atask_m3', 'sess_dlg_task1', 'Login fix', CHAT_B));
    const first = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    const id = task.state().toolApproval.id;
    assert.equal(a.state().toolApproval?.id, id, 'A docks it');
    assert.equal(b.state().toolApproval?.id, id, 'B docks it');
    assert.equal(a.state().toolApprovalsWaiting ?? 0, 0, 'one copy per chat, however many hand-offs');
    assert.deepEqual(
      [a.state().toolApproval.surfaceSessionId, a.state().toolApproval.handoff.title],
      [HOME, 'Fix login again']
    );
    assert.deepEqual(
      [b.state().toolApproval.surfaceSessionId, b.state().toolApproval.handoff.title],
      [CHAT_B, 'Login fix']
    );
    assert.equal(bystander.state().toolApproval, null, 'a chat with no hand-off never gets a copy');
    // Answered in A: settled once, B and the target cleared, the device recorded.
    assert.equal(a.api.finishToolApproval(id, true, 'ok', 'Pixel'), true);
    const settled = await first;
    assert.deepEqual([settled.approved, task.state().toolApproval], [true, null]);
    assert.equal(b.state().toolApproval, null);
    assert.equal(b.state().toolApprovalResult?.device, 'Pixel', 'B says where it was answered');
    assert.equal(task.state().toolApprovalResult?.device, 'Pixel');
    assert.equal(b.api.finishToolApproval(id, false), false, 'never answered twice');
    // Answered in the target itself: both copies leave.
    const second = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    const next = task.state().toolApproval.id;
    assert.deepEqual([a.state().toolApproval?.id, b.state().toolApproval?.id], [next, next]);
    assert.equal(task.api.finishToolApproval(next, false, 'no', 'DESKTOP-7'), true);
    assert.equal((await second).approved, false);
    assert.deepEqual([a.state().toolApproval, b.state().toolApproval], [null, null]);
  } finally {
    for (const runId of ['atask_m1', 'atask_m2', 'atask_m3']) endHandoff(runId);
    for (const queue of [a, b, bystander, task]) queue.dispose();
  }
});

const pick = (record, keys) => Object.fromEntries(keys.map((key) => [key, record[key]]));

test('an unanswered end is published by kind: a timeout is expired, an abort interrupted, a removed copy withdrawn; an answer keeps its device', async () => {
  const ports = handoffPorts();
  const a = sessionQueue(HOME);
  const b = sessionQueue(CHAT_B);
  const task = sessionQueue('sess_dlg_task1', { timeoutMs: 40 });
  try {
    await ports.watches.add(handoffWatch('atask_x1', 'sess_dlg_task1', 'Fix login'));
    await ports.watches.add(handoffWatch('atask_x2', 'sess_dlg_task1', 'Login fix', CHAT_B));
    // The target's request times out: its own card and both copies say expired.
    const timed = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    const timedId = task.state().toolApproval.id;
    const keepAlive = setTimeout(() => {}, 1000);
    const timedOut = (await timed).timedOut;
    clearTimeout(keepAlive);
    assert.equal(timedOut, true);
    for (const queue of [task, a, b]) {
      assert.equal(queue.state().toolApproval, null);
      assert.deepEqual(pick(queue.state().toolApprovalResult, ['id', 'expired', 'device']), {
        id: timedId,
        expired: true,
        device: '',
      });
    }
    // Stop / turn abort: the target says interrupted, the copies are withdrawn (not expired).
    task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    const abortedId = task.state().toolApproval.id;
    task.api.denyAllToolApprovals('turn aborted');
    assert.equal(task.state().toolApprovalResult.interrupted, true);
    assert.equal(task.state().toolApprovalResult.expired, undefined);
    for (const queue of [a, b]) {
      assert.deepEqual(pick(queue.state().toolApprovalResult, ['id', 'withdrawn', 'expired']), {
        id: abortedId,
        withdrawn: true,
        expired: undefined,
      });
    }
    // A hand-off ending removes only its copy: withdrawn, nobody named.
    const long = sessionQueue('sess_dlg_task2');
    try {
      await ports.watches.add(handoffWatch('atask_x3', 'sess_dlg_task2', 'Other', CHAT_B));
      long.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task2' });
      const longId = long.state().toolApproval.id;
      assert.equal(b.state().toolApproval?.id, longId);
      await ports.watches.remove('atask_x3');
      assert.equal(b.state().toolApproval, null);
      assert.deepEqual(pick(b.state().toolApprovalResult, ['id', 'withdrawn']), { id: longId, withdrawn: true });
      assert.equal(long.state().toolApproval?.id, longId, 'the target still waits');
      // Answered in the target: the copy keeps saying who answered, never expired.
      await ports.watches.add(handoffWatch('atask_x4', 'sess_dlg_task2', 'Other', CHAT_B));
      assert.equal(b.state().toolApproval?.id, longId);
      assert.equal(long.api.finishToolApproval(longId, true, 'ok', 'Pixel'), true);
      assert.deepEqual(pick(b.state().toolApprovalResult, ['device', 'approved', 'expired']), {
        device: 'Pixel',
        approved: true,
        expired: undefined,
      });
    } finally {
      long.dispose();
    }
  } finally {
    for (const runId of ['atask_x1', 'atask_x2', 'atask_x3', 'atask_x4']) endHandoff(runId);
    for (const queue of [a, b, task]) queue.dispose();
  }
});

test("one chat's hand-off ending withdraws only its copy; a chat handing work while it waits gets one", async () => {
  const ports = handoffPorts();
  const a = sessionQueue(HOME);
  const b = sessionQueue(CHAT_B);
  const task = sessionQueue('sess_dlg_task1');
  try {
    await ports.watches.add(handoffWatch('atask_e1', 'sess_dlg_task1', 'Fix login'));
    await ports.watches.add(handoffWatch('atask_e2', 'sess_dlg_task1', 'Fix login'));
    const asked = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    const id = task.state().toolApproval.id;
    assert.equal(b.state().toolApproval, null);
    await ports.watches.add(handoffWatch('atask_e3', 'sess_dlg_task1', 'Login fix', CHAT_B));
    assert.equal(b.state().toolApproval?.id, id, 'B handed it work while it waited');
    // One of A's two hand-offs reports: A still waits on the other.
    await ports.deliver('mailer', { runId: 'atask_e1_end', status: 'completed', watchId: 'atask_e1' });
    assert.equal(a.state().toolApproval?.id, id);
    // A's last one ends: only A's copy leaves.
    await ports.watches.remove('atask_e2');
    assert.equal(a.state().toolApproval, null);
    assert.equal(b.state().toolApproval?.id, id);
    assert.equal(task.state().toolApproval?.id, id, 'still waiting in the target');
    assert.equal(b.api.finishToolApproval(id, true, 'ok'), true);
    assert.equal((await asked).approved, true);
    assert.deepEqual([b.state().toolApproval, task.state().toolApproval], [null, null]);
  } finally {
    for (const runId of ['atask_e1', 'atask_e2', 'atask_e3']) endHandoff(runId);
    for (const queue of [a, b, task]) queue.dispose();
  }
});

test('the target stopping or closing while docked withdraws every copy', async () => {
  const ports = handoffPorts();
  const a = sessionQueue(HOME);
  const b = sessionQueue(CHAT_B);
  const task = sessionQueue('sess_dlg_task1');
  try {
    await ports.watches.add(handoffWatch('atask_s1', 'sess_dlg_task1', 'Fix login'));
    await ports.watches.add(handoffWatch('atask_s2', 'sess_dlg_task1', 'Login fix', CHAT_B));
    const aborted = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    assert.ok(a.state().toolApproval && b.state().toolApproval);
    task.api.denyAllToolApprovals('turn aborted');
    assert.deepEqual(await aborted, { approved: false, reason: 'turn aborted' });
    assert.deepEqual([a.state().toolApproval, b.state().toolApproval], [null, null]);
    const closed = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    assert.ok(a.state().toolApproval && b.state().toolApproval);
    task.dispose();
    assert.equal((await closed).approved, false);
    assert.deepEqual([a.state().toolApproval, b.state().toolApproval], [null, null]);
  } finally {
    for (const runId of ['atask_s1', 'atask_s2']) endHandoff(runId);
    for (const queue of [a, b, task]) queue.dispose();
  }
});

test('after a restart the stored watches bring back every chat, and a bot chat is named by its bot', async () => {
  const ports = handoffPorts();
  const a = sessionQueue(HOME);
  const b = sessionQueue(CHAT_B);
  const target = sessionQueue('sess_home_reviewer');
  try {
    // An earlier process left both watches in the store; this one never noted them.
    const left = [
      handoffWatch('atask_r1', 'sess_home_reviewer', 'Reviewer'),
      handoffWatch('atask_r2', 'sess_home_reviewer', 'Reviewer', CHAT_B),
    ];
    writeFileSync(ports.path, JSON.stringify({ watches: Object.fromEntries(left.map((w) => [w.runId, w])) }));
    const asked = target.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_home_reviewer' });
    assert.deepEqual([a.state().toolApproval, b.state().toolApproval], [null, null]);
    await ports.watches.list();
    for (const chat of [a, b]) {
      assert.deepEqual(chat.state().toolApproval?.handoff, { title: 'Reviewer', agentId: 'reviewer' });
    }
    a.api.finishToolApproval(a.state().toolApproval.id, true, 'ok');
    assert.equal((await asked).approved, true);
    assert.equal(b.state().toolApproval, null);
  } finally {
    for (const runId of ['atask_r1', 'atask_r2']) endHandoff(runId);
    for (const queue of [a, b, target]) queue.dispose();
  }
});

/** The delivery around a watch store, as the daemon runs it; `presence` and
 *  `deleted` say which bots and target sessions are proven gone. */
const watchDelivery = (queue, { presence = () => 'present', deleted = () => false } = {}) =>
  createAgentHomeDelivery({
    loadSession: () => null,
    saveSession: async () => {},
    turnInFlight: () => false,
    queue,
    live: () => null,
    agentPresence: presence,
    sessionDeleted: deleted,
    log: () => {},
  });

test("a watch evicted because its target was deleted ends that hand-off and withdraws that chat's copy; an outstanding one stays", async () => {
  const ports = handoffPorts({ caps: { ...QUEUE_CAPS, watches: 1 } });
  const delivery = watchDelivery(ports.queue, { deleted: (id) => id === 'sess_dlg_task1' });
  const a = sessionQueue(HOME);
  const b = sessionQueue(CHAT_B);
  const task = sessionQueue('sess_dlg_task1');
  try {
    await delivery.watchTask(handoffWatch('atask_v1', 'sess_dlg_task1', 'Fix login'));
    await delivery.watchTask(handoffWatch('atask_v2', 'sess_dlg_task1', 'Login fix', CHAT_B));
    const asked = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    const id = task.state().toolApproval.id;
    assert.deepEqual([a.state().toolApproval?.id, b.state().toolApproval?.id], [id, id]);
    // A, at its cap of one, hands other work on: its watch of the deleted target is evicted.
    await delivery.watchTask(handoffWatch('atask_v3', 'sess_dlg_task2', 'Bump deps'));
    assert.deepEqual(
      (await ports.queue.watches()).map((w) => w.runId),
      ['atask_v2', 'atask_v3']
    );
    assert.equal(a.state().toolApproval, null, "A's copy is withdrawn");
    assert.deepEqual([...handoffChatsOf('sess_dlg_task1').keys()], [CHAT_B]);
    assert.equal(b.state().toolApproval?.id, id, "B's outstanding hand-off keeps its copy");
    assert.equal(task.state().toolApproval?.id, id);
    b.api.finishToolApproval(id, true, 'ok');
    assert.equal((await asked).approved, true);
  } finally {
    for (const runId of ['atask_v1', 'atask_v2', 'atask_v3']) endHandoff(runId);
    for (const queue of [a, b, task]) queue.dispose();
  }
});

test("a pruned home's watches end their hand-offs and withdraw its copy; another home's stay", async () => {
  const ports = handoffPorts();
  const delivery = watchDelivery(ports.queue, { presence: (id) => (id === 'reviewer' ? 'deleted' : 'present') });
  const gone = sessionQueue('sess_home_reviewer');
  const a = sessionQueue(HOME);
  const task = sessionQueue('sess_dlg_task1');
  try {
    await delivery.watchTask(handoffWatch('atask_p1', 'sess_dlg_task1', 'Fix login', 'sess_home_reviewer'));
    await delivery.watchTask(handoffWatch('atask_p2', 'sess_dlg_task1', 'Fix login'));
    const asked = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    const id = task.state().toolApproval.id;
    assert.deepEqual([gone.state().toolApproval?.id, a.state().toolApproval?.id], [id, id]);
    // Its bot was deleted: the daemon's start retires that home's bookkeeping.
    await delivery.recover();
    assert.deepEqual(
      (await ports.queue.watches()).map((w) => w.runId),
      ['atask_p2']
    );
    assert.equal(gone.state().toolApproval, null);
    assert.deepEqual([...handoffChatsOf('sess_dlg_task1').keys()], [HOME]);
    assert.equal(a.state().toolApproval?.id, id);
    a.api.finishToolApproval(id, true, 'ok');
    assert.equal((await asked).approved, true);
  } finally {
    for (const runId of ['atask_p1', 'atask_p2']) endHandoff(runId);
    for (const queue of [gone, a, task]) queue.dispose();
  }
});

test('a room member session is the bot home: always-allow is offered there, stored for the bot, covers home and room', async (t) => {
  const store = tempStore(t);
  const member = ROOM_MEMBER;
  const queue = sessionQueue(member);
  const asked = [];
  const send = (sessionId) =>
    applyBeforeToolHook({
      ...email,
      cwd: '/tmp',
      callerSessionId: sessionId,
      executeOpts: {},
      beforeToolHook: async () => ({ action: 'allow' }),
      toolApprovalHook: async (request) => {
        asked.push(request);
        // Answered on the room member's own card.
        const answer = queue.api.requestToolApproval({ ...request, sessionId: member });
        const id = queue.state().toolApproval.id;
        queue.api.finishToolApproval(id, true, 'ok', '', undefined, undefined, { remember: 'agent' });
        return answer;
      },
    });
  try {
    assert.equal(actingContactBotId(member), 'mailer');
    assert.equal((await send(member)).denial, undefined);
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].remember, ['once', 'agent']);
    assert.equal(asked[0].agentId, 'mailer');
    const [grant] = await store.listGrants({ agentId: 'mailer' });
    assert.deepEqual({ agentId: grant.agentId, action: grant.action }, { agentId: 'mailer', action: 'email' });
    // The bot's grant now covers the room and the home chat alike.
    for (const sessionId of [member, HOME]) {
      assert.equal((await send(sessionId)).denial, undefined, sessionId);
    }
    assert.equal(asked.length, 1, 'never asked again');
    // Payments stay once-only in a room too.
    const pay = await humanGateDecision({ name: 'mcp__stripe__create_payment', args: { amount: 1 } }, null, {
      sessionId: member,
      store,
      annotations: {},
    });
    assert.deepEqual(pay.request.remember, ['once']);
  } finally {
    queue.dispose();
  }
});

test('answered in the sub-agent pane, the top-level copy goes away saying who answered', async () => {
  const home = sessionQueue('sess_dlg_lead1');
  const sub = sessionQueue('sess_dlg_lsub1');
  try {
    const answer = sub.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_lsub1' });
    const shown = home.state().toolApproval;
    assert.deepEqual(shown.chain, ['Lead', 'Reviewer']);
    assert.equal(sub.api.finishToolApproval(shown.id, false, 'denied by user', 'Laptop'), true);
    assert.equal((await answer).approved, false);
    assert.equal(home.state().toolApproval, null);
    assert.deepEqual(
      { id: home.state().toolApprovalResult.id, approved: home.state().toolApprovalResult.approved },
      { id: shown.id, approved: false }
    );
    assert.equal(home.api.finishToolApproval(shown.id, true), false);
  } finally {
    home.dispose();
    sub.dispose();
  }
});

test('a top-level chat opened after the request adopts it; a question stays in its own session', async () => {
  const sub = sessionQueue('sess_dlg_lsub1');
  let home = null;
  try {
    const answer = sub.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_lsub1' });
    home = sessionQueue('sess_dlg_lead1');
    home.api.adoptDelegatedApprovals();
    const shown = home.state().toolApproval;
    assert.equal(shown?.id, sub.state().toolApproval.id);
    home.dispose();
    home = null;
    // The home closing never answers for the sub-agent.
    assert.equal(sub.state().toolApproval.id, shown.id);
    home = sessionQueue('sess_dlg_lead1');
    home.api.adoptDelegatedApprovals();
    assert.equal(home.api.finishToolApproval(shown.id, true, 'approved by user'), true);
    assert.equal((await answer).approved, true);
    const question = sub.api.requestToolApproval({ name: 'ask_user', kind: 'question', timeoutMs: null });
    assert.equal(sub.state().toolApproval.kind, 'question');
    assert.equal(home.state().toolApproval, null, 'questions are not mirrored');
    sub.api.denyAllToolApprovals('done');
    await question;
  } finally {
    home?.dispose();
    sub.dispose();
  }
});

test('a secret and a login takeover also show in the conversation that delegated them; either place settles both', async () => {
  const lead = sessionQueue('sess_dlg_lead1');
  const sub = sessionQueue('sess_dlg_lsub1');
  const ports = handoffPorts();
  const home = sessionQueue(HOME);
  const task = sessionQueue('sess_dlg_task1');
  try {
    // A sub-agent's secret: in the Lead's chat, with its chain; answered there.
    const secret = sub.api.requestToolApproval({
      name: 'ask_user',
      kind: 'secret',
      secret: { requestId: 'secret_0123456789ab', surface: 'browser', target: 'bank', field: 'Password' },
      timeoutMs: 120_000,
      sessionId: 'sess_dlg_lsub1',
    });
    const copy = lead.state().toolApproval;
    assert.equal(copy?.kind, 'secret', 'the secret card is in the chat the user watches');
    assert.equal(copy.id, sub.state().toolApproval.id);
    assert.equal(copy.sessionId, 'sess_dlg_lsub1', 'it still names the asking session');
    assert.deepEqual(copy.chain, ['Lead', 'Reviewer']);
    assert.equal(
      lead.api.finishToolApproval(copy.id, true, 'ok', 'DESKTOP', undefined, undefined, { response: 'provide-secret' }),
      true
    );
    const answered = await secret;
    assert.deepEqual([answered.approved, answered.response], [true, 'provide-secret']);
    assert.equal(sub.state().toolApproval, null, "the sub-agent's own card is settled");

    // A task session's login takeover: in the bot chat that handed it the work.
    await ports.watches.add(handoffWatch('atask_sl1', 'sess_dlg_task1', '예측'));
    const takeover = task.api.requestToolApproval({
      name: 'ask_user',
      kind: 'takeover',
      takeover: { surface: 'browser', instructions: 'Sign in', purpose: 'login', url: 'https://dart.fss.or.kr/' },
      timeoutMs: null,
      sessionId: 'sess_dlg_task1',
    });
    const shown = home.state().toolApproval;
    assert.equal(shown?.kind, 'takeover');
    assert.equal(shown.takeover.purpose, 'login');
    assert.deepEqual(shown.handoff, { title: '예측' });
    assert.equal(shown.sessionId, 'sess_dlg_task1', 'the sign-in window stays bound to the asking session');
    // Answered in its own pane: the copy in the bot chat goes too.
    task.api.finishToolApproval(task.state().toolApproval.id, false, 'expired');
    const result = await takeover;
    assert.deepEqual([result.approved, result.reason], [false, 'expired']);
    assert.equal(home.state().toolApproval, null);
  } finally {
    endHandoff('atask_sl1');
    for (const queue of [lead, sub, home, task]) queue.dispose();
  }
});

/** A watchdog over the real runtime liveness map for `sessionId`, as the agent
 *  tool arms one per sub-agent; `stalled()` says whether it aborted the turn. */
function watchedTurn(sessionId) {
  _touchRuntime(sessionId);
  updateSessionStage(sessionId, 'tool_running');
  let signal = null;
  const mgr = {
    getSessionProgressSnapshot,
    linkParentSignalToSession: (_id, linked) => {
      signal = linked;
      return () => {};
    },
  };
  const policy = resolveAgentWatchdogPolicy('worker');
  const handle = createProgressWatchdogRegistry({ mgr }).start(sessionId, policy, 'worker');
  return { policy, stalled: () => signal?.aborted === true, stop: () => handle.stop() };
}

test('a sub-agent silent past its stall window with no approval pending is still stopped (control)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 50_000_000 });
  const watched = watchedTurn('sess_dlg_lsub1');
  t.mock.timers.tick(watched.policy.idleStaleMs + 5_000);
  assert.equal(watched.stalled(), true);
  watched.stop();
});

test('a sub-agent waiting on a delegated approval is not killed by the watchdog, hours in, and resumes on the answer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 50_000_000 });
  const SUB = 'sess_dlg_lsub1';
  // The runtime default: no wait limit.
  const options = { timeoutMs: resolveToolApprovalTimeoutMs({}) };
  const home = sessionQueue('sess_dlg_lead1', options);
  const sub = sessionQueue(SUB, options);
  const watched = watchedTurn(SUB);
  try {
    // The sub-agent's tool call asks; the question is also in the bot's chat.
    const release = beginSessionApprovalWait(SUB);
    let settled = false;
    const answer = sub.api
      .requestToolApproval({ ...email, kind: 'outbound', sessionId: SUB, agentId: 'mailer' })
      .then((result) => {
        settled = true;
        return result;
      });
    const shown = home.state().toolApproval;
    assert.equal(shown?.id, sub.state().toolApproval.id, 'the bot chat holds the sub-agent card');
    assert.equal(shown.expiresAt, null, 'no expiry on the card');

    // Two hours of the user not answering: neither the approval nor the turn gives up.
    t.mock.timers.tick(2 * 60 * 60_000);
    await Promise.resolve();
    assert.equal(settled, false, 'the approval is still pending');
    assert.equal(watched.stalled(), false, 'the progress watchdog leaves the waiting sub-agent alone');
    assert.equal(home.state().toolApproval?.id, shown.id);
    assert.equal(sub.state().toolApproval?.id, shown.id);

    // The user answers in the bot chat; the sub-agent goes on and is not
    // judged stale for the time it spent waiting.
    assert.equal(home.api.finishToolApproval(shown.id, true, 'approved by user', 'Pixel'), true);
    assert.equal((await answer).approved, true);
    release();
    t.mock.timers.tick(5_000);
    assert.equal(watched.stalled(), false, 'the wait is not counted as silence afterwards');
  } finally {
    watched.stop();
    home.dispose();
    sub.dispose();
  }
});

test('Deny from the bot chat or Stop on the sub-agent still settles a long-waiting delegated approval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 50_000_000 });
  const options = { timeoutMs: resolveToolApprovalTimeoutMs({}) };
  const home = sessionQueue('sess_dlg_lead1', options);
  const sub = sessionQueue('sess_dlg_lsub1', options);
  try {
    const denied = sub.api.requestToolApproval({ ...email, kind: 'outbound', sessionId: 'sess_dlg_lsub1' });
    t.mock.timers.tick(10 * 60_000);
    const shown = home.state().toolApproval;
    assert.equal(home.api.finishToolApproval(shown.id, false, 'denied by user'), true);
    const deniedResult = await denied;
    assert.equal(deniedResult.approved, false);
    assert.equal(deniedResult.reason, 'denied by user');
    assert.equal(deniedResult.timedOut, undefined);
    assert.equal(sub.state().toolApproval, null);

    const stopped = sub.api.requestToolApproval({ ...email, kind: 'outbound', sessionId: 'sess_dlg_lsub1' });
    t.mock.timers.tick(10 * 60_000);
    sub.api.denyAllToolApprovals('turn cancelled');
    const stoppedResult = await stopped;
    assert.equal(stoppedResult.approved, false);
    assert.equal(stoppedResult.reason, 'turn cancelled');
    assert.equal(home.state().toolApproval, null, 'the copy goes with the settled request');
  } finally {
    home.dispose();
    sub.dispose();
  }
});

const choice = {
  questions: [{ question: 'Which markets?', options: [{ label: 'All five' }, { label: 'Only KR' }] }],
};
const ask = (queue, sessionId) =>
  queue.api.requestToolApproval({
    name: 'ask_user',
    kind: 'question',
    args: choice,
    timeoutMs: null,
    sessionId,
    toolCallId: 'call_q',
  });

test("a handed-off session's question shows in the chat handing it work, apart from its queue, and is answered once from there", async () => {
  const ports = handoffPorts();
  const home = sessionQueue(HOME);
  const task = sessionQueue('sess_dlg_task1');
  const before = Object.keys(home.state()).sort();
  try {
    await ports.watches.add(handoffWatch('atask_qa1', 'sess_dlg_task1', 'Rank model'));
    const answer = ask(task, 'sess_dlg_task1');
    const own = task.state().toolApproval;
    assert.equal(own.kind, 'question', 'its own pane still asks');
    const [shown] = home.state().handoffQuestions;
    assert.equal(home.state().handoffQuestions.length, 1);
    assert.equal(shown.id, own.id, 'one request, one id in both places');
    assert.deepEqual(shown.args, choice, 'the same options');
    assert.deepEqual([shown.sessionId, shown.surfaceSessionId], ['sess_dlg_task1', HOME]);
    assert.equal(home.state().toolApproval, null, "never in the chat's own queue or dock");
    // The chat's own request is not held back by it.
    const mine = home.api.requestToolApproval({ name: 'shell', args: {}, sessionId: HOME });
    assert.equal(home.state().toolApproval.sessionId, HOME);
    home.api.finishToolApproval(home.state().toolApproval.id, true, 'ok');
    assert.equal((await mine).approved, true);
    // Answered in the chat: the asking session gets the answers, once.
    const answers = [{ selected: ['All five'] }];
    const resultBefore = home.state().toolApprovalResult;
    assert.equal(home.api.finishToolApproval(own.id, true, 'answered by user', 'DESKTOP-7', answers), true);
    const result = await answer;
    assert.deepEqual([result.approved, result.answers], [true, answers]);
    assert.equal(task.state().toolApproval, null, "the session's own card is settled");
    assert.deepEqual(home.state().handoffQuestions, []);
    assert.equal(home.api.finishToolApproval(own.id, true), false, 'never answered twice from the chat');
    assert.equal(task.api.finishToolApproval(own.id, true), false, 'nor from the session');
    // Nothing else of the chat's state moved: no transcript rows, no result trace.
    assert.equal(home.state().toolApprovalResult, resultBefore);
    assert.deepEqual(
      Object.keys(home.state())
        .filter((key) => key !== 'handoffQuestions')
        .sort(),
      before
    );
    assert.equal(home.state().items, undefined);
  } finally {
    endHandoff('atask_qa1');
    home.dispose();
    task.dispose();
  }
});

test("a handed-off question comes back in a reloaded chat runtime, and after a restart once the stored watches are read", async () => {
  const ports = handoffPorts();
  const task = sessionQueue('sess_dlg_task1');
  let home = sessionQueue(HOME);
  try {
    // An earlier process stored the watch; this one has not read it yet.
    const left = handoffWatch('atask_qr1', 'sess_dlg_task1', 'Rank model');
    writeFileSync(ports.path, JSON.stringify({ watches: { [left.runId]: left } }));
    const answer = ask(task, 'sess_dlg_task1');
    assert.equal(home.state().handoffQuestions, undefined, 'no hand-off known yet');
    await ports.watches.list();
    assert.equal(home.state().handoffQuestions.length, 1, 'the restored hand-off brings the copy');
    // The chat's runtime closes (idle sweep, app restart): the next one adopts the copy.
    home.dispose();
    home = sessionQueue(HOME);
    assert.equal(home.state().handoffQuestions, undefined);
    home.api.adoptDelegatedApprovals();
    const [shown] = home.state().handoffQuestions;
    assert.equal(shown.id, task.state().toolApproval.id);
    assert.equal(home.api.finishToolApproval(shown.id, true, 'answered by user', '', [{ selected: ['All five'] }]), true);
    assert.equal((await answer).approved, true);
  } finally {
    endHandoff('atask_qr1');
    home.dispose();
    task.dispose();
  }
});

test('daemon start reads the stored watches: a question asked after the restart reaches the chat with no other read', async () => {
  const ports = handoffPorts();
  const task = sessionQueue('sess_dlg_task1');
  const home = sessionQueue(HOME);
  try {
    // An earlier process left the watch in the store; this one starts.
    const left = handoffWatch('atask_qs1', 'sess_dlg_task1', 'Rank model');
    writeFileSync(ports.path, JSON.stringify({ watches: { [left.runId]: left } }));
    await watchDelivery(ports.queue).recover();
    assert.deepEqual([...handoffChatsOf('sess_dlg_task1').keys()], [HOME], 'the start noted the hand-off');
    // The target asks again; nothing else reads the watches.
    const answer = ask(task, 'sess_dlg_task1');
    const [shown] = home.state().handoffQuestions;
    assert.equal(shown.id, task.state().toolApproval.id);
    assert.equal(home.api.finishToolApproval(shown.id, true, 'answered by user', '', [{ selected: ['All five'] }]), true);
    assert.equal((await answer).approved, true);
    assert.deepEqual(home.state().handoffQuestions, []);
  } finally {
    endHandoff('atask_qs1');
    home.dispose();
    task.dispose();
  }
});

taskSession('sess_dlg_rtask', ROOM_MEMBER, 'atask_r');

test("a room member's handed-off question waits in the member's session, its turn over, and is answered once through it", async () => {
  const ports = handoffPorts();
  const member = sessionQueue(ROOM_MEMBER);
  const task = sessionQueue('sess_dlg_rtask');
  try {
    await ports.watches.add(handoffWatch('atask_rq1', 'sess_dlg_rtask', 'Rank model', ROOM_MEMBER));
    // The member's speaking turn ends: its copy stays (the room still shows it).
    member.api.denyAllToolApprovals('turn finished');
    const answer = ask(task, 'sess_dlg_rtask');
    const own = task.state().toolApproval;
    const [shown] = member.state().handoffQuestions;
    assert.deepEqual([shown.id, shown.sessionId, shown.surfaceSessionId], [own.id, 'sess_dlg_rtask', ROOM_MEMBER]);
    assert.deepEqual(shown.args, choice);
    assert.equal(member.state().toolApproval, null);
    // The room's answer goes through the member's session (agent-rooms.ts approve).
    const answers = [{ selected: ['Only KR'] }];
    assert.equal(member.api.finishToolApproval(own.id, true, 'answered by user', 'DESKTOP-7', answers), true);
    assert.deepEqual((await answer).answers, answers);
    assert.equal(task.state().toolApproval, null);
    assert.deepEqual(member.state().handoffQuestions, []);
    assert.equal(member.api.finishToolApproval(own.id, true), false, 'never twice');
    assert.equal(member.state().items, undefined, "no row in the member's transcript");
    // Answered in the asking session instead: the member's copy is withdrawn.
    const again = ask(task, 'sess_dlg_rtask');
    assert.equal(member.state().handoffQuestions.length, 1);
    task.api.finishToolApproval(task.state().toolApproval.id, true, 'answered by user', '', []);
    assert.equal((await again).approved, true);
    assert.deepEqual(member.state().handoffQuestions, []);
  } finally {
    endHandoff('atask_rq1');
    member.dispose();
    task.dispose();
  }
});

test('a handed-off question answered or aborted in its session leaves the chat; each session has its own', async () => {
  const ports = handoffPorts();
  const home = sessionQueue(HOME);
  const first = sessionQueue('sess_dlg_task1');
  const second = sessionQueue('sess_dlg_task2');
  try {
    await ports.watches.add(handoffWatch('atask_qb1', 'sess_dlg_task1', 'Rank model'));
    await ports.watches.add(handoffWatch('atask_qb2', 'sess_dlg_task2', 'Markets'));
    const a = ask(first, 'sess_dlg_task1');
    const b = ask(second, 'sess_dlg_task2');
    assert.deepEqual(
      home.state().handoffQuestions.map((question) => question.sessionId),
      ['sess_dlg_task1', 'sess_dlg_task2'],
      'both at once'
    );
    // Answered in its own session: the chat's card leaves.
    first.api.finishToolApproval(first.state().toolApproval.id, true, 'answered by user', '', []);
    assert.equal((await a).approved, true);
    assert.deepEqual(
      home.state().handoffQuestions.map((question) => question.sessionId),
      ['sess_dlg_task2']
    );
    // Aborted in its own session: it leaves too, unanswered.
    second.api.denyAllToolApprovals('turn aborted');
    assert.equal((await b).approved, false);
    assert.deepEqual(home.state().handoffQuestions, []);
    // The chat's own turn ending keeps a waiting copy; its hand-off ending removes it.
    const c = ask(first, 'sess_dlg_task1');
    home.api.denyAllToolApprovals('turn finished');
    assert.equal(home.state().handoffQuestions.length, 1);
    await ports.watches.remove('atask_qb1');
    assert.deepEqual(home.state().handoffQuestions, []);
    assert.equal(first.state().toolApproval?.kind, 'question', 'the session still asks');
    first.api.denyAllToolApprovals('done');
    await c;
  } finally {
    endHandoff('atask_qb1');
    endHandoff('atask_qb2');
    home.dispose();
    first.dispose();
    second.dispose();
  }
});
