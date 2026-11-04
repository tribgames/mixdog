import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

const MINUTE = 60_000;
const LEAD = 'sess_ops_lead';
const ROWS = 1800;
const LIVE = 350;
const COUNTED = [
  [fs, ['statSync', 'lstatSync', 'readFileSync', 'existsSync', 'readdirSync', 'openSync', 'accessSync']],
  [fsp, ['stat', 'lstat', 'readFile', 'readdir', 'open', 'access']],
];

/** Runs `run` while counting every call of the fs functions above. */
async function countingFsCalls(run) {
  let calls = 0;
  const originals = [];
  for (const [target, names] of COUNTED) {
    for (const name of names) {
      const original = target[name];
      originals.push([target, name, original]);
      target[name] = function counted(...args) {
        calls += 1;
        return original.apply(this, args);
      };
    }
  }
  syncBuiltinESMExports();
  try {
    const result = await run();
    return { result, calls };
  } finally {
    for (const [target, name, original] of originals) target[name] = original;
    syncBuiltinESMExports();
  }
}

let instance = 0;
const coldPool = () => {
  instance += 1;
  return import(`./store-agent-worker-rows.mjs?ops=${instance}`);
};

test('listing a large index costs a bounded number of fs calls, whatever its row count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-ops-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'sessions'));
    const now = Date.now();
    const workers = {};
    for (let i = 0; i < ROWS; i += 1) {
      const sessionId = `sess_ops_${String(i).padStart(4, '0')}`;
      const live = i < LIVE;
      workers[`tag-${i}`] = {
        tag: `tag-${i}`,
        sessionId,
        agent: 'worker',
        ownerSessionId: LEAD,
        parentSessionId: LEAD,
        status: live && i % 7 === 0 ? 'running' : 'idle',
        stage: live && i % 7 === 0 ? 'streaming' : 'idle',
        createdAt: new Date(now - 90 * MINUTE).toISOString(),
        startedAt: new Date(now - 90 * MINUTE + i * 1000).toISOString(),
        updatedAt: new Date(now - (live ? 5 : 20 * 24 * 60) * MINUTE).toISOString(),
      };
      if (live) {
        const record = {
          id: sessionId,
          owner: 'agent',
          agent: 'worker',
          ownerSessionId: LEAD,
          title: `Agent ${i}`,
          messages: [],
        };
        writeFileSync(join(root, 'sessions', `${sessionId}.json`), JSON.stringify(record));
      }
    }
    writeFileSync(
      join(root, 'sessions', `${LEAD}.json`),
      JSON.stringify({ id: LEAD, owner: 'user', agent: 'lead', messages: [] })
    );
    writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({ version: 2, workers, tombstones: {} }));
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({ workers: [{ sessionId: LEAD, status: 'idle', updatedAt: now, createdAt: now - 100 * MINUTE }] })
    );
    // Settle the files past the racy-stamp window so the headers are cacheable.
    const past = new Date(now - 60_000);
    for (const name of fs.readdirSync(join(root, 'sessions'))) fs.utimesSync(join(root, 'sessions', name), past, past);

    const running = new Set(['sess_ops_0000', 'sess_ops_0007']);
    const reference = (await coldPool()).listStoredAgentWorkers({ runningSessionIds: running });
    assert.ok(reference.length >= LIVE, 'the live rows are listed');

    const pool = await coldPool();
    const cold = await countingFsCalls(() => pool.listStoredAgentWorkersAsync({ runningSessionIds: running }));
    assert.deepEqual(cold.result, reference, 'the awaited listing lists exactly what the synchronous one does');
    const warm = await countingFsCalls(() => pool.listStoredAgentWorkersAsync({ runningSessionIds: running }));
    assert.deepEqual(warm.result, reference);
    assert.ok(cold.calls <= 40, `a cold listing made ${cold.calls} fs calls`);
    assert.ok(warm.calls <= 40, `a warm listing made ${warm.calls} fs calls`);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
