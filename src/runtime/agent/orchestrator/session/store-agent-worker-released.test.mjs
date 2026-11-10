import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the pool marks an owner-closed agent released, keeps its status, and drops the mark once it works again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-released-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    const now = Date.now();
    const lead = 'rel-lead';
    const row = (id, extra = {}) => ({
      tag: `tag-${id}`,
      sessionId: id,
      agent: 'worker',
      ownerSessionId: lead,
      parentSessionId: lead,
      status: 'idle',
      stage: 'idle',
      createdAt: now - 5_000,
      updatedAt: now - 1_000,
      ...extra,
    });
    writeFileSync(
      join(root, 'sessions', `${lead}.json`),
      JSON.stringify({ id: lead, owner: 'user', agent: 'lead', messages: [] })
    );
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({ workers: [{ sessionId: lead, status: 'idle', updatedAt: now, createdAt: now - 10_000 }] })
    );
    const rows = [row('rel-closed', { released: true }), row('rel-live'), row('rel-reused', { released: true })];
    writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({ version: 2, workers: rows, tombstones: {} }));

    const { listStoredAgentWorkers } = await import('./store-agent-worker-rows.mjs?released');
    const pool = listStoredAgentWorkers({ runningSessionIds: new Set(['rel-reused']) });
    const byId = new Map(pool.map((entry) => [entry.sessionId, entry]));
    assert.equal(byId.get('rel-closed').released, true);
    assert.equal(byId.get('rel-closed').status, 'completed', 'closing keeps the completed status');
    assert.equal('released' in byId.get('rel-live'), false);
    assert.equal(byId.get('rel-reused').status, 'running');
    assert.equal('released' in byId.get('rel-reused'), false, 'a working agent is not released');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
