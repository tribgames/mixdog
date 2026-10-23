import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolvePluginData } from '../../runtime/shared/plugin-paths.mjs';
import { isHeartbeatSession, markHeartbeatSession } from '../../runtime/shared/routine-trigger.mjs';
import { wakeMixy } from '../mixy-heartbeat.mjs';
import { assertHeartbeatSetupAction, scheduleCallerScope } from '../services/schedule-access.mjs';
import { createSetupToolExecutor } from '../setup-tool/executor.mjs';
import { createWorkspaceToolHandlers } from './workspace-tools.mjs';

const HEARTBEAT = 'sess_daemon_hb';
// Stored exactly like a heartbeat session (a session create may supply these
// fields), but never marked by the heartbeat.
const FORGED = { id: 'sess_daemon_forged', sourceType: 'exec', sourceName: 'heartbeat', ownerAgentId: 'lead' };
const OTHER_EXEC = 'sess_daemon_x';

/** The workspace handlers of a runtime whose session is `id`. */
function handlers(id) {
  const sessionControl = [];
  const agentCalls = [];
  const goalCalls = [];
  const rt = { session: id === FORGED.id ? { ...FORGED } : { id }, currentCwd: process.cwd() };
  const made = createWorkspaceToolHandlers({
    rt,
    getSessionManager: () => ({ getSession: (sessionId) => (sessionId === FORGED.id ? { ...FORGED } : null) }),
    executeSessionControl: async (args) => {
      sessionControl.push(args);
      return { ok: true };
    },
    agentTool: {
      execute: async (args) => {
        agentCalls.push(args);
        return 'ok';
      },
    },
    goalRuntime: {
      executeTool: async (name, args) => {
        goalCalls.push(args);
        return 'ok';
      },
    },
    notifyFnForSession: () => null,
  });
  const ctx = { callerCtx: { callerSessionId: id }, callerCwd: process.cwd() };
  return {
    session: (args) => made.session(args, ctx),
    agent: (args) => made.agent(args, ctx),
    goal: (args) => made.goal(args, { name: 'goal', ...ctx }),
    sessionControl,
    agentCalls,
    goalCalls,
  };
}

function dataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-hb-tools-'));
  const before = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  t.after(() => {
    if (before === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  });
}

function marked(t) {
  markHeartbeatSession(HEARTBEAT);
  t.after(() => markHeartbeatSession(HEARTBEAT, true));
}

test("suggest works from Mixy's marked heartbeat session and her chat, never from another exec session", async (t) => {
  dataDir(t);
  marked(t);
  const proposal = { action: 'suggest', key: 'pause-routine:news', title: 'Pause news' };
  assert.equal(JSON.parse(await handlers(HEARTBEAT).session(proposal)).recorded, true);
  assert.equal(JSON.parse(await handlers('sess_home_lead').session(proposal)).recorded, true);
  await assert.rejects(handlers(OTHER_EXEC).session(proposal), /suggest belongs to Mixy's chat/);
});

test('stored heartbeat fields without the heartbeat mark are no heartbeat session', async () => {
  assert.equal(isHeartbeatSession(FORGED.id), false);
  const forged = handlers(FORGED.id);
  await assert.rejects(
    forged.session({ action: 'suggest', key: 'pause-routine:news', title: 'x' }),
    /suggest belongs to Mixy's chat/
  );
  await forged.agent({ type: 'spawn', agent: 'worker', prompt: 'x' });
  assert.equal(forged.agentCalls.length, 1, 'it gets none of the heartbeat limits either');
});

test('a heartbeat session hands no work off: agent spawn/send, session create/send, Goal create/resume', async (t) => {
  marked(t);
  const hb = handlers(HEARTBEAT);
  for (const args of [
    { type: 'spawn', agent: 'worker', prompt: 'x' },
    { agent: 'worker', prompt: 'x' }, // spawn when the type is omitted
    { type: '  ', agent: 'worker', prompt: 'x' }, // or blank
    { type: 'send', tag: 'fix', prompt: 'x' },
  ]) {
    await assert.rejects(hb.agent(args), /agent: a heartbeat turn cannot hand work off.*suggest/);
  }
  for (const args of [
    { action: 'create', agent: 'reviewer', prompt: 'x' },
    { action: 'send', session_id: 'sess_home_reviewer', prompt: 'x' },
  ]) {
    await assert.rejects(hb.session(args), /session: a heartbeat turn cannot hand work off/);
  }
  for (const action of ['create', 'resume']) {
    await assert.rejects(hb.goal({ action, objective: 'x' }), /goal: a heartbeat turn cannot hand work off/);
  }
  assert.deepEqual(hb.sessionControl, []);
  assert.deepEqual(hb.agentCalls, []);
  assert.deepEqual(hb.goalCalls, []);
  // Reading is still allowed, and other exec sessions keep delegating.
  await hb.session({ action: 'list' });
  await hb.agent({ type: 'list' });
  await hb.goal({ action: 'status' });
  assert.equal(hb.sessionControl.length, 1);
  assert.equal(hb.agentCalls.length, 1);
  assert.equal(hb.goalCalls.length, 1);
  const other = handlers(OTHER_EXEC);
  await other.agent({ type: 'spawn', agent: 'worker', prompt: 'x' });
  await other.goal({ action: 'create', objective: 'x' });
  assert.equal(other.agentCalls.length, 1);
  assert.equal(other.goalCalls.length, 1);
});

test('the hand-off limits hold for any case and spacing of the action, and only for hand-offs', async (t) => {
  marked(t);
  const hb = handlers(HEARTBEAT);
  for (const type of ['SPAWN', ' Spawn ', 'sPaWn', 'SEND', ' send\t']) {
    await assert.rejects(
      hb.agent({ type, agent: 'worker', prompt: 'x' }),
      /agent: a heartbeat turn cannot hand work off/,
      type
    );
  }
  for (const action of ['CREATE', ' Create ', 'SEND', ' send ']) {
    await assert.rejects(
      hb.session({ action, agent: 'reviewer', session_id: 'sess_x', prompt: 'x' }),
      /session: a heartbeat turn cannot hand work off/,
      action
    );
  }
  for (const action of ['CREATE', ' Resume ', 'rEsUmE']) {
    await assert.rejects(hb.goal({ action, objective: 'x' }), /goal: a heartbeat turn cannot hand work off/, action);
  }
  assert.deepEqual([hb.agentCalls, hb.sessionControl, hb.goalCalls], [[], [], []]);
  // Reading and closing hand nothing off.
  await hb.agent({ type: 'status' });
  await hb.agent({ type: 'read', tag: 'x' });
  await hb.session({ action: 'read', session_id: 'sess_home_reviewer' });
  await hb.goal({ action: 'status' });
  assert.equal(hb.agentCalls.length, 2);
  assert.equal(hb.sessionControl.length, 1);
  assert.equal(hb.goalCalls.length, 1);
});

test('a heartbeat session reads sessions and bots and records proposals; every other session action is refused', async (t) => {
  dataDir(t);
  marked(t);
  const hb = handlers(HEARTBEAT);
  for (const args of [
    { action: 'cancel', session_id: 'sess_x' },
    { action: 'delete', session_id: 'sess_x' },
    { action: 'rename', title: 'x' },
    { action: 'compact' },
    { action: 'fork' },
    { action: 'favorite', value: true },
    { action: 'archive', value: true },
    { action: 'set-project', path: '.' },
    { action: 'list-projects' },
  ]) {
    await assert.rejects(hb.session(args), /session: a heartbeat turn only reads sessions and bots/, args.action);
  }
  assert.deepEqual(hb.sessionControl, []);
  for (const action of ['read', 'list', 'bots'])
    await hb.session({ action, session_id: action === 'read' ? 'sess_x' : '' });
  await hb.session({ action: 'status', session_id: 'sess_x' });
  assert.equal(hb.sessionControl.length, 4);
  assert.equal(JSON.parse(await hb.session({ action: 'status' })).sessionId, HEARTBEAT);
  assert.equal(
    JSON.parse(await hb.session({ action: 'suggest', key: 'pause-routine:news', title: 'x' })).recorded,
    true
  );
  // Any other exec session keeps every action.
  await handlers(OTHER_EXEC).session({ action: 'cancel', session_id: 'sess_x' });
});

test('a heartbeat session only pauses a routine or runs one again through setup', async (t) => {
  marked(t);
  for (const [action, args] of [
    ['delete_automation', { enabled: false }],
    ['save_automation', {}],
    ['set_agent_route', {}],
    ['set_automation_enabled', { enabled: true }],
    ['set_automation_enabled', {}],
  ]) {
    assert.throws(
      () => assertHeartbeatSetupAction(HEARTBEAT, action, args),
      /heartbeat turn only pauses a routine or runs one again/,
      `${action} ${JSON.stringify(args)}`
    );
  }
  assertHeartbeatSetupAction(HEARTBEAT, 'set_automation_enabled', { enabled: false });
  assertHeartbeatSetupAction(HEARTBEAT, 'run_automation', {});
  // Any other session is not narrowed here.
  assertHeartbeatSetupAction(OTHER_EXEC, 'delete_automation', {});
  // The setup tool refuses the rest from a heartbeat session before it touches anything.
  const touched = [];
  const setup = createSetupToolExecutor({
    getApi: () => new Proxy({}, { get: (_target, key) => () => touched.push(key) }),
    getConfig: () => ({}),
    getCallerSession: (id) => ({ id, sourceType: 'exec', sourceName: 'heartbeat', ownerAgentId: 'lead' }),
  });
  await assert.rejects(
    setup.execute(
      { action: 'delete_automation', automationKind: 'schedule', name: 'news' },
      { callerSessionId: HEARTBEAT }
    ),
    /heartbeat turn only pauses a routine or runs one again \(setup delete_automation is refused\)/
  );
  // Read-only setup actions are refused too: it reads nothing through setup.
  await assert.rejects(
    setup.execute({ action: 'status' }, { callerSessionId: HEARTBEAT }),
    /heartbeat turn only pauses a routine or runs one again \(setup status is refused\)/
  );
  assert.deepEqual(touched, []);
});

/** What the session `id` can do right now: hand work off, change a setting, and its scope. */
async function probe(id) {
  const caller = { id, sourceType: 'exec', sourceName: 'heartbeat', ownerAgentId: 'lead' };
  const writes = [];
  const setup = createSetupToolExecutor({
    getApi: () => ({
      setHeartbeatEnabled: (enabled) => {
        writes.push(enabled);
        return { heartbeat: enabled };
      },
    }),
    getConfig: () => ({}),
    getCallerSession: () => caller,
  });
  const hb = handlers(id);
  const refusal = async (call) => {
    try {
      await call();
      return null;
    } catch (error) {
      return error.message;
    }
  };
  return {
    agent: await refusal(() => hb.agent({ type: 'spawn', agent: 'worker', prompt: 'x' })),
    session: await refusal(() => hb.session({ action: 'send', session_id: 'sess_home_reviewer', prompt: 'x' })),
    goal: await refusal(() => hb.goal({ action: 'create', objective: 'x' })),
    setting: await refusal(() =>
      setup.execute({ action: 'set_heartbeat_enabled', enabled: false }, { callerSessionId: id })
    ),
    scope: scheduleCallerScope(caller),
    handedOff: hb.agentCalls.length + hb.sessionControl.length + hb.goalCalls.length,
    writes,
  };
}

test('a real heartbeat turn is limited for exactly its lifetime: no hand-offs, no setting changes, her unattended scope; after the close it is none of that', async () => {
  const id = 'sess_daemon_hb_live';
  let during = null;
  const surface = {
    submit: async (sessionId, _content, options) => {
      queueMicrotask(async () => {
        options.onCommitted?.();
        during = { marked: isHeartbeatSession(sessionId), ...(await probe(sessionId)) };
        options.onSettled?.({ status: 'done', result: { content: 'HEARTBEAT_QUIET' } });
      });
      return true;
    },
  };
  let closed = null;
  const result = await wakeMixy(
    { items: ['x'] },
    {
      getSessionService: () => ({ createSession: async () => ({ sessionId: id }) }),
      route: async () => ({ provider: 'fake', model: 'm' }),
      surface,
      deliver: async () => {},
      release: async (sessionId) => {
        closed = { sessionId, stillMarked: isHeartbeatSession(sessionId) };
        return true;
      },
      log: () => {},
    }
  );
  assert.deepEqual(result, { quiet: true, sessionId: id });
  assert.equal(during.marked, true);
  assert.match(during.agent, /heartbeat turn cannot hand work off/);
  assert.match(during.session, /heartbeat turn cannot hand work off/);
  assert.match(during.goal, /heartbeat turn cannot hand work off/);
  assert.match(during.setting, /unattended run cannot change settings/);
  assert.deepEqual(during.scope, { kind: 'agent', agentId: 'lead', unattended: true });
  assert.equal(during.handedOff, 0);
  assert.deepEqual(during.writes, []);
  // The mark lasts until the close lands, and is gone right after it.
  assert.deepEqual(closed, { sessionId: id, stillMarked: true });
  assert.equal(isHeartbeatSession(id), false);
  const after = await probe(id);
  assert.equal(after.agent, null, 'the same session id is an ordinary exec session now');
  assert.equal(after.session, null);
  assert.equal(after.goal, null);
  assert.match(after.setting, /background run cannot change settings/);
  assert.deepEqual(after.scope, { kind: 'headless' });
});

test('a heartbeat turn that fails keeps its limits until its close lands, a close that throws keeps them for the retry', async (t) => {
  const id = 'sess_daemon_hb_fail';
  t.after(() => markHeartbeatSession(id, true));
  const surface = {
    submit: async (_sessionId, _content, options) => {
      queueMicrotask(() => {
        options.onCommitted?.();
        options.onSettled?.({ status: 'failed', error: 'provider down' });
      });
      return true;
    },
  };
  const wake = (release) =>
    wakeMixy(
      { items: ['x'] },
      {
        getSessionService: () => ({ createSession: async () => ({ sessionId: id }) }),
        route: async () => ({ provider: 'fake', model: 'm' }),
        surface,
        deliver: async () => {},
        release,
        unreleased: () => {},
        log: () => {},
      }
    );
  await assert.rejects(
    wake(async () => {
      throw new Error('close failed');
    }),
    /provider down/
  );
  assert.equal(isHeartbeatSession(id), true, 'the close did not land: still a limited session');
  await assert.rejects(
    wake(async () => false),
    /provider down/
  );
  assert.equal(isHeartbeatSession(id), true);
  await assert.rejects(
    wake(async () => true),
    /provider down/
  );
  assert.equal(isHeartbeatSession(id), false, 'closed: the mark is gone');
});

test('a forged session cannot make itself a heartbeat: it gets no suggest, no unattended scope and no setting change', async () => {
  const forged = await probe(FORGED.id);
  assert.equal(forged.agent, null, 'it is an ordinary exec session: no heartbeat limits');
  assert.deepEqual(forged.scope, { kind: 'headless' });
  assert.match(forged.setting, /background run cannot change settings/);
  assert.deepEqual(forged.writes, []);
  await assert.rejects(
    handlers(FORGED.id).session({ action: 'suggest', key: 'pause-routine:news', title: 'x', value: false }),
    /suggest belongs to Mixy's chat/
  );
});

test('suggest through the tool: recorded, refreshed, declined for good, refused when malformed', async (t) => {
  dataDir(t);
  const mixy = handlers('sess_home_lead');
  const suggest = async (args) => JSON.parse(await mixy.session({ action: 'suggest', ...args }));
  assert.deepEqual(await suggest({ key: 'Pause-Routine:News', title: 'Pause the news routine' }), {
    action: 'suggest',
    key: 'pause-routine:news',
    recorded: true,
  });
  assert.deepEqual(await suggest({ key: 'pause-routine:news', title: 'Pause it, it keeps failing' }), {
    action: 'suggest',
    key: 'pause-routine:news',
    recorded: true,
    refreshed: true,
  });
  const file = () => JSON.parse(readFileSync(`${resolvePluginData()}/heartbeat.json`, 'utf8'));
  assert.deepEqual(
    file().pending.map(({ key, text }) => [key, text]),
    [['pause-routine:news', 'Pause it, it keeps failing']]
  );
  const declined = await suggest({ key: 'pause-routine:news', value: false });
  assert.equal(declined.dismissed, true);
  assert.deepEqual(file().pending, []);
  assert.deepEqual(file().dismissed, ['pause-routine:news']);
  const again = await suggest({ key: 'pause-routine:news', title: 'Please?' });
  assert.equal(again.recorded, false);
  assert.match(again.reason, /declined/);
  await assert.rejects(mixy.session({ action: 'suggest', key: 'no target', title: 'x' }), /action:target/);
  await assert.rejects(mixy.session({ action: 'suggest', title: 'x' }), /action:target/);
});
