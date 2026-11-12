import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-close-startup-'));
mkdirSync(join(root, 'sessions'), { recursive: true });
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { createStandaloneAgent } = await import('../agent-tool.mjs');

// One agent row (`status`) of lead `sess_lead`, finished `ageMs` ago. `gone`: its
// stored session was deleted (the manager still holds its descriptor, as the
// daemon does until it restarts). `known: false`: the manager has not loaded the
// stored agents yet, so it holds no descriptor of a session that exists.
function scenario(name, { ageMs, gone = false, known = true, status = 'idle' }) {
  const dataDir = join(root, name);
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  const finishedAt = new Date(Date.now() - ageMs).toISOString();
  const row = {
    tag: 'old',
    sessionId: 'sess_old',
    ownerSessionId: 'sess_lead',
    parentSessionId: 'sess_lead',
    agent: 'worker',
    status,
    stage: status,
    runtimePid: process.pid,
    clientHostPid: process.pid,
    createdAt: finishedAt,
    updatedAt: finishedAt,
    finishedAt,
  };
  writeFileSync(join(dataDir, 'agent-workers.json'), JSON.stringify({ workers: { [row.sessionId]: row } }));
  const session = {
    id: row.sessionId,
    owner: 'agent',
    agent: 'worker',
    agentTag: row.tag,
    ownerSessionId: 'sess_lead',
    parentSessionId: 'sess_lead',
    clientHostPid: process.pid,
    status: 'idle',
    messages: [],
  };
  const closed = [];
  const parked = [];
  const mgr = {
    getSession: (id) => (known && id === session.id ? session : null),
    sessionGone: async () => gone,
    listSessions: () => (known && !gone ? [session] : []),
    getSessionRuntime: () => null,
    closeSession: (id) => {
      closed.push(id);
      return true;
    },
    parkSession: async (id) => {
      parked.push(id);
      return true;
    },
  };
  const agent = createStandaloneAgent({
    cfgMod: { loadConfig: () => ({ providers: {}, presets: [] }) },
    reg: { initProviders: async () => {} },
    mgr,
    dataDir,
    cwd: dataDir,
  });
  return { agent, closed, parked };
}

test('an agent already idle with a delivered result at start-up is parked with no row change, not closed', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const { agent, closed, parked } = scenario('startup', { ageMs: 8 * 60 * 1000 });
  t.after(() => agent.dispose());
  mock.timers.tick(1);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(parked, ['sess_old']);
  assert.deepEqual(closed, []);
  assert.match(await agent.execute({ type: 'list' }, { callerSessionId: 'sess_lead' }), /old/, 'still listed');
});

test('close and cleanup drop the row of an agent whose session is gone', async () => {
  const ctx = { callerSessionId: 'sess_lead' };
  const closing = scenario('gone-close', { ageMs: 60_000, gone: true });
  try {
    assert.match(await closing.agent.execute({ type: 'list' }, ctx), /old/);
    const answer = await closing.agent.execute({ type: 'close', tag: 'old' }, ctx);
    assert.match(String(answer), /already gone/);
    assert.doesNotMatch(await closing.agent.execute({ type: 'list' }, ctx), /old/);
    assert.deepEqual(closing.closed, []);
  } finally {
    closing.agent.dispose();
  }
  const cleaning = scenario('gone-cleanup', { ageMs: 60_000, gone: true });
  try {
    await cleaning.agent.execute({ type: 'cleanup' }, ctx);
    assert.doesNotMatch(await cleaning.agent.execute({ type: 'list' }, ctx), /old/);
  } finally {
    cleaning.agent.dispose();
  }
});

test('cleanup clears the row of a gone session whatever the row status', async () => {
  const ctx = { callerSessionId: 'sess_lead' };
  const failed = scenario('gone-error', { ageMs: 60_000, gone: true, status: 'error' });
  try {
    const answer = String(await failed.agent.execute({ type: 'cleanup' }, ctx));
    assert.match(answer, /"goneRowsCleared": 1/);
    assert.match(answer, /"workers": 0/, 'no worker row is left');
    assert.deepEqual(failed.closed, []);
  } finally {
    failed.agent.dispose();
  }
});

test('an agent the manager has not loaded yet is closed, not dropped as gone', async () => {
  const ctx = { callerSessionId: 'sess_lead' };
  const unloaded = scenario('not-loaded', { ageMs: 60_000, known: false });
  try {
    const answer = await unloaded.agent.execute({ type: 'close', tag: 'old' }, ctx);
    assert.doesNotMatch(String(answer), /already gone/);
    assert.deepEqual(unloaded.closed, ['sess_old']);
  } finally {
    unloaded.agent.dispose();
  }
});
