import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// One data dir for the file: the store modules resolve it at import.
const root = mkdtempSync(join(tmpdir(), 'mixdog-exit-close-'));
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

let seq = 0;

/** A Lead whose turn spawned two sub-agents that already finished: one
 *  completed, one failed. Both are still resident in this process. */
function scenario() {
  seq += 1;
  const dataDir = join(root, `case-${seq}`);
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  const owner = `sess_lead_exit_${seq}`;
  const finishedAt = new Date(Date.now() - 60_000).toISOString();
  const child = (id, extra) => ({
    tag: id,
    sessionId: `sess_${id}_${seq}`,
    ownerSessionId: owner,
    parentSessionId: owner,
    agent: 'worker',
    runtimePid: process.pid,
    clientHostPid: process.pid,
    createdAt: finishedAt,
    updatedAt: finishedAt,
    finishedAt,
    ...extra,
  });
  const rows = [
    child('done', { status: 'idle', stage: 'idle' }),
    child('broke', { status: 'failed', stage: 'failed', failureReason: 'stalled' }),
  ];
  writeFileSync(
    join(dataDir, 'agent-workers.json'),
    JSON.stringify({ workers: Object.fromEntries(rows.map((row) => [row.sessionId, row])) })
  );
  const live = new Map(
    rows.map((row) => [
      row.sessionId,
      {
        id: row.sessionId,
        owner: 'agent',
        agent: 'worker',
        agentTag: row.tag,
        ownerSessionId: owner,
        parentSessionId: owner,
        clientHostPid: process.pid,
        messages: [],
      },
    ])
  );
  const closed = [];
  const mgr = {
    getSession: (id) => live.get(id) || null,
    listSessions: () => [...live.values()],
    getSessionRuntime: () => null,
    closeSession: (id) => {
      closed.push(id);
      const session = live.get(id);
      if (session) session.closed = true;
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
  const storedIds = () => {
    const doc = JSON.parse(readFileSync(join(dataDir, 'agent-workers.json'), 'utf8'));
    const workers = Array.isArray(doc.workers) ? doc.workers : Object.values(doc.workers || {});
    return workers.map((row) => row.sessionId).sort();
  };
  return { agent, owner, rows, closed, storedIds };
}

test('a process exit closes the Lead sub-agents but keeps their rows for the next process to list', async () => {
  const { agent, owner, rows, closed, storedIds } = scenario();
  try {
    await agent.closeAll('SIGTERM', { callerSessionId: owner, processExit: true });
    await agent.flushIndexWrites();
    assert.deepEqual(closed.sort(), rows.map((row) => row.sessionId).sort(), 'every resident sub-agent is closed');
    assert.deepEqual(
      storedIds(),
      rows.map((row) => row.sessionId).sort(),
      'the finished sub-agents stay in the durable pool after the exit'
    );
  } finally {
    agent.dispose();
  }
});

test('closing a Lead (not a process exit) still drops its sub-agent rows', async () => {
  const { agent, owner, storedIds } = scenario();
  try {
    await agent.closeAll('agent owner closed', { callerSessionId: owner });
    await agent.flushIndexWrites();
    assert.deepEqual(storedIds(), []);
  } finally {
    agent.dispose();
  }
});
