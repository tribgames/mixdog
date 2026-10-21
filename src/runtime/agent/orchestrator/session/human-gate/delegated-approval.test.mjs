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
import {
  actingContactBotId,
  approvalSurface,
  humanGateDecision,
  rememberSurfaceOf,
  unattendedApprovalPort,
} from './gate.mjs';
import { createHumanGateStore, setHumanGateStore } from './store.mjs';
import { roomMemberSessionId } from '../agent-room.mjs';
import { markUnattendedRun } from '../../../../../session-runtime/held-requests.mjs';
import { sessionOptions } from '../../../../../session-runtime/session-create/session-options.mjs';
import { createAgentTaskSessions } from '../../../../../session-runtime/agent-task-sessions.mjs';
import { sessionOriginFields } from '../manager/session-record.mjs';

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
  const session = { ...record, ...(origin.delegation ? { delegation: origin.delegation } : {}), createdAt: Date.now() };
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
// bot home → task session (session create) → Worker → Reviewer
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

for (const [label, sessionId] of [
  ['bot → sub-agent', 'sess_dlg_sub1'],
  ['bot → task session → sub-agent → sub-agent (nested)', 'sess_dlg_tsub2'],
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
    assert.equal(asked.length, 1, 'the sub-agent is asked on the outbound card');
    assert.equal(asked[0].kind, 'outbound');
    assert.equal(asked[0].agentId, 'mailer', 'with the bot as the requester');
    assert.deepEqual(asked[0].remember, ['once', 'agent']);
    assert.equal(asked[0].rememberAt, HOME, "remembered only when answered in the bot's own chat");
    // "Don't ask again" was stored for the bot, and the bot's grant now covers the sub-agent.
    const [grant] = await store.listGrants({ agentId: 'mailer' });
    assert.deepEqual({ agentId: grant.agentId, action: grant.action }, { agentId: 'mailer', action: 'email' });
    await send();
    assert.equal(asked.length, 1, 'the bot grant lets the next send through unasked');
    const [row] = await store.readAudit({ agentId: 'mailer' });
    assert.equal(row.decision, 'remembered');
    // The bot's block blocks its sub-agents too; payments never remember.
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

test('a coding Lead → sub-agent stays ungated, as before', async (t) => {
  const store = tempStore(t);
  for (const sessionId of ['sess_dlg_lead1', 'sess_dlg_lsub1']) {
    const out = await humanGateDecision(email, { action: 'allow' }, { sessionId, store, annotations: {} });
    assert.deepEqual(out, { decision: { action: 'allow' }, request: null, gate: null }, sessionId);
  }
  assert.deepEqual(await store.readAudit({}), []);
});

test('a sub-agent or a bot-created task session surfaces in the top-level chat with the chain', () => {
  assert.deepEqual(approvalSurface('sess_dlg_sub1'), { sessionId: HOME, chain: ['사무관', 'Worker'] });
  assert.deepEqual(approvalSurface('sess_dlg_tsub2'), {
    sessionId: HOME,
    chain: ['사무관', 'Task session', 'Worker', 'Reviewer'],
  });
  // The task session's own Lead: the user watches the bot's chat, not the task.
  assert.deepEqual(approvalSurface('sess_dlg_task1'), { sessionId: HOME, chain: ['사무관', 'Task session'] });
  assert.deepEqual(approvalSurface('sess_dlg_lsub1'), { sessionId: 'sess_dlg_lead1', chain: ['Lead', 'Reviewer'] });
  // Top-level sessions surface in themselves.
  for (const sessionId of [HOME, 'sess_dlg_lead1']) assert.equal(approvalSurface(sessionId), null);
  // Everything under the bot's own chat answers there as the bot; a coding Lead's agents never.
  assert.equal(actingContactBotId('sess_dlg_sub1'), 'mailer');
  assert.equal(actingContactBotId('sess_dlg_tsub2'), 'mailer');
  assert.equal(actingContactBotId('sess_dlg_task1'), 'mailer');
  assert.equal(actingContactBotId('sess_dlg_lsub1'), '');
});

test('a task session a room member created never offers always-allow, its agents neither', async (t) => {
  const store = tempStore(t);
  const member = roomMemberSessionId('room123abc', 'mailer');
  taskSession('sess_dlg_rtask', member);
  agentChild('sess_dlg_rsub', 'worker', 'sess_dlg_rtask');
  for (const sessionId of ['sess_dlg_rtask', 'sess_dlg_rsub'])
    assert.equal(actingContactBotId(sessionId), '', sessionId);
  assert.equal(approvalSurface('sess_dlg_rsub').sessionId, member);
  // Outbound asks as the bot, once only: a room is not the bot's own chat.
  for (const sessionId of [member, 'sess_dlg_rtask', 'sess_dlg_rsub']) {
    const out = await humanGateDecision(email, null, { sessionId, store, annotations: {} });
    assert.equal(out.request.agentId, 'mailer', sessionId);
    assert.deepEqual(out.request.remember, ['once'], sessionId);
  }
});

test('a delegated session whose root cannot be resolved fails closed: outbound asks, never remembered', async (t) => {
  const store = tempStore(t);
  await store.setMode({ agentId: 'lead', action: 'email', mode: 'allow' });
  // Its parent's record is gone (not a home or room id); a session naming
  // itself as parent; a child of an unresolved one; an older record whose
  // parent (the bot home) has no record to derive its root from.
  agentChild('sess_dlg_orphan', 'worker', 'sess_dlg_deleted_parent');
  setLiveSession(childRecord('sess_dlg_self', 'worker', 'sess_dlg_self'));
  agentChild('sess_dlg_orphan2', 'worker', 'sess_dlg_orphan');
  setLiveSession({
    id: 'sess_dlg_legacytask',
    owner: 'cli',
    agent: 'lead',
    taskOrigin: { agentId: 'mailer', sessionId: HOME, requestId: 'atask_legacy', title: 'Old', notify: true },
  });
  for (const sessionId of ['sess_dlg_orphan', 'sess_dlg_self', 'sess_dlg_orphan2', 'sess_dlg_legacytask']) {
    const out = await humanGateDecision(email, { action: 'allow' }, { sessionId, store, annotations: {} });
    assert.equal(out.decision?.action, 'ask', sessionId);
    assert.equal(out.request.kind, 'outbound', sessionId);
    assert.deepEqual(out.request.remember, ['once'], sessionId);
    assert.equal(actingContactBotId(sessionId), '', sessionId);
    assert.equal(approvalSurface(sessionId), null, `${sessionId} stays in its own session`);
  }
  // A coding Lead's sub-agent created now is a resolved coding root: unchanged.
  const out = await humanGateDecision(
    email,
    { action: 'allow' },
    { sessionId: 'sess_dlg_lsub1', store, annotations: {} }
  );
  assert.deepEqual(out, { decision: { action: 'allow' }, request: null, gate: null });
});

test('a delegated session records its root at creation; reading it never walks the parents', () => {
  assert.deepEqual(loadSession('sess_dlg_tsub2').delegation, {
    rootSessionId: HOME,
    rootAgentId: 'mailer',
    via: 'home',
    path: [{ kind: 'task' }, { kind: 'agent', agent: 'worker' }, { kind: 'agent', agent: 'reviewer' }],
  });
  assert.deepEqual(loadSession('sess_dlg_lsub1').delegation, {
    rootSessionId: 'sess_dlg_lead1',
    rootAgentId: '',
    via: 'coding',
    path: [{ kind: 'agent', agent: 'reviewer' }],
  });
  // The intermediate records may disappear later: the nested one still resolves.
  setLiveSession({ id: 'sess_dlg_tsub1', owner: 'agent', agent: 'worker', visibility: 'agent-only' });
  assert.deepEqual(approvalSurface('sess_dlg_tsub2'), {
    sessionId: HOME,
    chain: ['사무관', 'Task session', 'Worker', 'Reviewer'],
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
  };
  await api.create(forged, { callerSessionId: member, callerAgentId: 'mailer', callerCwd: dataRoot });
  const profile = calls[0].sessionProfile;
  assert.equal(profile.taskOrigin.sessionId, member);
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
  const session = created({ id: 'sess_dlg_forged', ...options, delegation: forged.delegation });
  assert.equal(session.delegation.via, 'room', 'the record root comes from the creating session, not the options');
  assert.equal(actingContactBotId('sess_dlg_forged'), '');
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

test('a run that ended: what it started keeps holding its approvals, after a restart too; later work is attended', async (t) => {
  const store = tempStore(t);
  const unmark = markUnattendedRun(HOME, { kind: 'schedule', agentId: 'mailer', name: 'Nightly' });
  // Started by the run: a sub-agent, and a task session with its own sub-agent.
  agentChild('sess_dlg_runsub', 'worker', HOME);
  taskSession('sess_dlg_runtask', HOME);
  agentChild('sess_dlg_runtsub', 'worker', 'sess_dlg_runtask');
  unmark();
  // Started after the run, by the user's own turn in the home.
  agentChild('sess_dlg_latersub', 'worker', HOME);
  // As read back after a daemon restart: only the record says it was the run's.
  const restored = { ...loadSession('sess_dlg_runtsub'), id: 'sess_dlg_restored' };
  setLiveSession(restored);
  const runOf = unattendedApprovalPort().runOf;
  for (const sessionId of ['sess_dlg_runsub', 'sess_dlg_runtask', 'sess_dlg_runtsub', 'sess_dlg_restored']) {
    assert.deepEqual(runOf(sessionId), { kind: 'schedule', agentId: 'mailer', name: 'Nightly' }, sessionId);
    // Never remembered: the run's work is answered from a held row, not as the bot's chat.
    assert.equal(actingContactBotId(sessionId), '', sessionId);
    const out = await humanGateDecision(email, null, { sessionId, store, annotations: {} });
    assert.deepEqual(out.request.remember, ['once'], sessionId);
  }
  assert.equal(runOf('sess_dlg_latersub'), null);
  assert.equal(runOf(HOME), null, 'the home itself is attended again');
  assert.equal(runOf('sess_dlg_sub1'), null);
});

test('a schedule running IN the bot home is not its attended chat: no remember there', async (t) => {
  const store = tempStore(t);
  const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
  t.after(unmark);
  assert.equal(rememberSurfaceOf(HOME), '');
  assert.equal(actingContactBotId(HOME), '');
  const out = await humanGateDecision(email, null, { sessionId: HOME, store, annotations: {} });
  assert.equal(out.request.agentId, 'mailer');
  assert.deepEqual(out.request.remember, ['once']);
  assert.equal(out.request.rememberAt, undefined);
  unmark();
  assert.equal(rememberSurfaceOf(HOME), HOME, 'attended again once the run ends');
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
  assert.equal(loadSession('sess_bf_code').delegation.via, 'coding', 'persisted on the child');
  // A bot home's old sub-agent → that bot, origin unknown (an attended turn or
  // a run that has since ended): surfaced in the home chat, never remembered.
  setLiveSession({ id: HOME, owner: 'cli', agent: 'lead' });
  legacy(childRecord('sess_bf_home', 'worker', HOME));
  const home = await humanGateDecision(email, null, { sessionId: 'sess_bf_home', store, annotations: {} });
  assert.equal(home.request.agentId, 'mailer');
  assert.deepEqual(home.request.remember, ['once']);
  assert.equal(home.request.rememberAt, undefined);
  assert.equal(loadSession('sess_bf_home').delegation.via, 'unknown');
  assert.equal(actingContactBotId('sess_bf_home'), '');
  assert.deepEqual(approvalSurface('sess_bf_home'), { sessionId: HOME, chain: ['사무관', 'Worker'] });
  // A chain of two old records: an old task session from the home, and its old sub-agent.
  legacy({
    id: 'sess_bf_task',
    owner: 'cli',
    agent: 'lead',
    taskOrigin: { agentId: 'mailer', sessionId: HOME, requestId: 'atask_bf', title: 'Old', notify: true },
  });
  legacy(childRecord('sess_bf_tsub', 'worker', 'sess_bf_task'));
  assert.deepEqual(approvalSurface('sess_bf_tsub'), { sessionId: HOME, chain: ['사무관', 'Task session', 'Worker'] });
  assert.equal(loadSession('sess_bf_task').delegation.via, 'unknown');
  // A Lead parent with bot provenance (host-set sourceName, no taskOrigin) is
  // bot work, never coding: it acts as that bot, and — a legacy record — never
  // remembers, @home or suffixless alike.
  legacy({ id: 'sess_bf_srchome', owner: 'cli', agent: 'lead', sourceType: 'lead', sourceName: 'agent:mailer@home' });
  legacy({ id: 'sess_bf_srcold', owner: 'cli', agent: 'lead', sourceType: 'lead', sourceName: 'agent:mailer' });
  legacy(childRecord('sess_bf_srchome_w', 'worker', 'sess_bf_srchome'));
  legacy(childRecord('sess_bf_srcold_w', 'worker', 'sess_bf_srcold'));
  const fromHome = await humanGateDecision(
    email,
    { action: 'allow' },
    { sessionId: 'sess_bf_srchome_w', store, annotations: {} }
  );
  assert.equal(fromHome.request.agentId, 'mailer');
  assert.deepEqual(fromHome.request.remember, ['once']);
  assert.equal(fromHome.request.rememberAt, undefined);
  const unknown = await humanGateDecision(
    email,
    { action: 'allow' },
    { sessionId: 'sess_bf_srcold_w', store, annotations: {} }
  );
  assert.equal(unknown.request.agentId, 'mailer');
  assert.deepEqual(unknown.request.remember, ['once']);
  assert.equal(actingContactBotId('sess_bf_srcold_w'), '');
  // Ambiguous provenance (a room origin with no room to name) stays unresolved; so
  // does a missing parent. A forged `delegation`-like field on the parent is ignored.
  legacy({ id: 'sess_bf_srcroom', owner: 'cli', agent: 'lead', sourceType: 'lead', sourceName: 'agent:mailer@room' });
  legacy(childRecord('sess_bf_srcroom_w', 'worker', 'sess_bf_srcroom'));
  legacy(childRecord('sess_bf_gone', 'worker', 'sess_bf_missing_parent'));
  for (const sessionId of ['sess_bf_srcroom_w', 'sess_bf_gone']) {
    const out = await humanGateDecision(email, { action: 'allow' }, { sessionId, store, annotations: {} });
    assert.equal(out.decision?.action, 'ask', sessionId);
    assert.deepEqual(out.request.remember, ['once'], sessionId);
    assert.equal(approvalSurface(sessionId), null, sessionId);
    assert.equal(loadSession(sessionId).delegation, undefined, `${sessionId}: nothing persisted`);
  }
});

test('legacy work of a webhook that has ended is never remembered: its @run task stays a held run', async (t) => {
  const store = tempStore(t);
  setLiveSession({ id: HOME, owner: 'cli', agent: 'lead' });
  const unmark = markUnattendedRun(HOME, { kind: 'webhook', agentId: 'mailer', name: 'Hook' });
  // Created during the webhook by the old code: no delegation recorded.
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
  // Read for the first time after the webhook ended: the home is attended now.
  for (const sessionId of ['sess_wh_child', 'sess_wh_task', 'sess_wh_tsub']) {
    const out = await humanGateDecision(email, null, { sessionId, store, annotations: {} });
    assert.equal(out.request.agentId, 'mailer', sessionId);
    assert.deepEqual(out.request.remember, ['once'], sessionId);
    assert.equal(out.request.rememberAt, undefined, sessionId);
    assert.equal(rememberSurfaceOf(sessionId), '', sessionId);
  }
  assert.equal(loadSession('sess_wh_child').delegation.via, 'unknown');
  // The explicit @run beats the task origin and the home's current state: held.
  const runOf = unattendedApprovalPort().runOf;
  assert.equal(loadSession('sess_wh_task').delegation.via, 'run');
  for (const sessionId of ['sess_wh_task', 'sess_wh_tsub']) {
    assert.equal(runOf(sessionId)?.agentId, 'mailer', sessionId);
  }
  assert.equal(runOf('sess_wh_child'), null);
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
  const home = sessionQueue(HOME);
  const sub = sessionQueue('sess_dlg_sub1');
  try {
    const answer = sub.api.requestToolApproval({
      ...email,
      kind: 'outbound',
      sessionId: 'sess_dlg_sub1',
      remember: ['once', 'agent'],
      rememberAt: HOME,
      agentId: 'mailer',
    });
    const shown = home.state().toolApproval;
    assert.ok(shown, 'the bot home shows the card');
    assert.equal(shown.id, sub.state().toolApproval.id, 'one request, one id in both places');
    assert.deepEqual(shown.remember, ['once', 'agent'], "the bot's chat offers don't-ask-again");
    assert.deepEqual(sub.state().toolApproval.remember, ['once'], "the sub-agent's own pane does not");
    assert.deepEqual(shown.chain, ['사무관', 'Worker']);
    assert.equal(shown.sessionId, 'sess_dlg_sub1');
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

test('a remember answer counts only from the bot chat: from any other place it is once', async () => {
  const home = sessionQueue(HOME);
  const sub = sessionQueue('sess_dlg_sub1');
  const outbound = { ...email, kind: 'outbound', remember: ['once', 'agent'], rememberAt: HOME, agentId: 'mailer' };
  try {
    // Answered in the sub-agent's pane with a forged "agent" scope.
    let answer = sub.api.requestToolApproval({ ...outbound, sessionId: 'sess_dlg_sub1' });
    let id = sub.state().toolApproval.id;
    assert.equal(sub.api.finishToolApproval(id, true, 'ok', '', undefined, undefined, { remember: 'agent' }), true);
    assert.equal((await answer).remember, 'once');
    // A request with no remember surface, even in the bot's chat itself.
    const bare = home.api.requestToolApproval({ ...outbound, rememberAt: undefined, sessionId: HOME });
    id = home.state().toolApproval.id;
    assert.deepEqual(home.state().toolApproval.remember, ['once']);
    home.api.finishToolApproval(id, true, 'ok', '', undefined, undefined, { remember: 'agent' });
    assert.equal((await bare).remember, 'once');
    // A room member's request (another surface) never remembers where it is shown.
    const member = sessionQueue(roomMemberSessionId('room123abc', 'mailer'));
    const roomAnswer = member.api.requestToolApproval({ ...outbound, sessionId: member.state().sessionId });
    id = member.state().toolApproval.id;
    member.api.finishToolApproval(id, true, 'ok', '', undefined, undefined, { remember: 'agent' });
    assert.equal((await roomAnswer).remember, 'once');
    member.dispose();
    // The same request answered in the bot's chat keeps it.
    answer = sub.api.requestToolApproval({ ...outbound, sessionId: 'sess_dlg_sub1' });
    id = home.state().toolApproval.id;
    home.api.finishToolApproval(id, true, 'ok', '', undefined, undefined, { remember: 'agent' });
    assert.equal((await answer).remember, 'agent');
  } finally {
    home.dispose();
    sub.dispose();
  }
});

test("a bot-created task session's own approval is copied into the bot's chat and resolves once", async () => {
  const home = sessionQueue(HOME);
  const task = sessionQueue('sess_dlg_task1');
  try {
    const answer = task.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_task1' });
    const shown = home.state().toolApproval;
    assert.equal(shown?.id, task.state().toolApproval.id);
    assert.deepEqual(shown.chain, ['사무관', 'Task session']);
    assert.equal(home.api.finishToolApproval(shown.id, true, 'approved by user'), true);
    assert.equal((await answer).approved, true);
    assert.equal(task.state().toolApproval, null);
    assert.equal(task.api.finishToolApproval(shown.id, true), false);
  } finally {
    home.dispose();
    task.dispose();
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
  const sub = sessionQueue('sess_dlg_sub1');
  let home = null;
  try {
    const answer = sub.api.requestToolApproval({ name: 'shell', args: {}, sessionId: 'sess_dlg_sub1' });
    home = sessionQueue(HOME);
    home.api.adoptDelegatedApprovals();
    const shown = home.state().toolApproval;
    assert.equal(shown?.id, sub.state().toolApproval.id);
    home.dispose();
    home = null;
    // The home closing never answers for the sub-agent.
    assert.equal(sub.state().toolApproval.id, shown.id);
    home = sessionQueue(HOME);
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
  const watched = watchedTurn('sess_dlg_sub1');
  t.mock.timers.tick(watched.policy.idleStaleMs + 5_000);
  assert.equal(watched.stalled(), true);
  watched.stop();
});

test('a sub-agent waiting on a delegated approval is not killed by the watchdog, hours in, and resumes on the answer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 50_000_000 });
  const SUB = 'sess_dlg_sub1';
  // The runtime default: no wait limit.
  const options = { timeoutMs: resolveToolApprovalTimeoutMs({}) };
  const home = sessionQueue(HOME, options);
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
  const home = sessionQueue(HOME, options);
  const sub = sessionQueue('sess_dlg_sub1', options);
  try {
    const denied = sub.api.requestToolApproval({ ...email, kind: 'outbound', sessionId: 'sess_dlg_sub1' });
    t.mock.timers.tick(10 * 60_000);
    const shown = home.state().toolApproval;
    assert.equal(home.api.finishToolApproval(shown.id, false, 'denied by user'), true);
    const deniedResult = await denied;
    assert.equal(deniedResult.approved, false);
    assert.equal(deniedResult.reason, 'denied by user');
    assert.equal(deniedResult.timedOut, undefined);
    assert.equal(sub.state().toolApproval, null);

    const stopped = sub.api.requestToolApproval({ ...email, kind: 'outbound', sessionId: 'sess_dlg_sub1' });
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
