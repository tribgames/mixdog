import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isHeartbeatSession, markHeartbeatSession } from '../../runtime/shared/routine-trigger.mjs';
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
