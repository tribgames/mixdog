import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// One data dir for the file: the store modules resolve it at import.
const root = mkdtempSync(join(tmpdir(), 'mixdog-list-idle-'));
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

// A finished sub-agent stays open (idle) for follow-ups and the user sees it in
// the Agents pane, so the model's `agent list` must show it too, or it has no
// tag left to close it with.
function scenario() {
  const dataDir = join(root, 'case');
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  const finishedAt = new Date(Date.now() - 60_000).toISOString();
  const row = (tag, owner) => ({
    tag,
    sessionId: `sess_${tag}`,
    ownerSessionId: owner,
    parentSessionId: owner,
    agent: 'worker',
    status: 'idle',
    stage: 'idle',
    runtimePid: process.pid,
    clientHostPid: process.pid,
    createdAt: finishedAt,
    updatedAt: finishedAt,
    finishedAt,
  });
  const rows = [row('mine', 'sess_lead_a'), row('theirs', 'sess_lead_b')];
  writeFileSync(
    join(dataDir, 'agent-workers.json'),
    JSON.stringify({ workers: Object.fromEntries(rows.map((r) => [r.sessionId, r])) })
  );
  const live = new Map(
    rows.map((r) => [
      r.sessionId,
      {
        id: r.sessionId,
        owner: 'agent',
        agent: 'worker',
        agentTag: r.tag,
        ownerSessionId: r.ownerSessionId,
        parentSessionId: r.parentSessionId,
        clientHostPid: process.pid,
        status: 'idle',
        messages: [],
      },
    ])
  );
  const mgr = {
    getSession: (id) => live.get(id) || null,
    listSessions: () => [...live.values()],
    getSessionRuntime: () => null,
    closeSession: (id) => {
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
  return agent;
}

test('agent list shows the caller\'s idle open worker with its tag, drops it once closed, and hides another caller\'s', async () => {
  const agent = scenario();
  const ctx = { callerSessionId: 'sess_lead_a' };
  try {
    const before = await agent.execute({ type: 'list' }, ctx);
    assert.match(before, /^- mine {2}idle/m);
    assert.doesNotMatch(before, /theirs/);

    await agent.execute({ type: 'close', tag: 'mine' }, ctx);
    const after = await agent.execute({ type: 'list' }, ctx);
    assert.doesNotMatch(after, /mine/);
    assert.doesNotMatch(after, /theirs/);
  } finally {
    agent.dispose();
  }
});
