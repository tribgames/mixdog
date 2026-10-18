import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Each import of a distinct URL is a separate module instance with empty
// caches: the reference a long-lived, incrementally updated pool must match.
let instance = 0;
async function coldPool() {
  instance += 1;
  return import(`./store-agent-worker-rows.mjs?cold=${instance}`);
}

const LEAD = 'churn-lead';
const RUNNING = new Set(['churn-00', 'churn-01', 'churn-02', 'churn-03', LEAD]);

function withDataDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-churn-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'));
  return Promise.resolve()
    .then(() => run(root))
    .finally(() => {
      if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
      else process.env.MIXDOG_DATA_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    });
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const MINUTE = 60_000;

/** A worker session record whose transcript dwarfs its header. */
function sessionRecord(id, index, turn, now) {
  const header = {
    id,
    owner: 'agent',
    agent: 'worker',
    ownerSessionId: LEAD,
    parentSessionId: LEAD,
    title: `Agent ${index} turn ${turn}`,
    provider: 'test-provider',
    model: `model-${index % 3}`,
    createdAt: now - 90 * MINUTE,
    updatedAt: now - (index % 4) * MINUTE,
    totalInputTokens: 100 * turn + index,
    totalOutputTokens: 7 * turn,
    totalToolCalls: turn,
  };
  // Header-recorded cancels the index rows do not carry.
  if (index % 11 === 5) Object.assign(header, { cancelStatus: 'cancel-unconfirmed', cancelledAt: now - 5 * MINUTE });
  if (index % 11 === 7) Object.assign(header, { status: 'cancelled', cancelledAt: now - 3 * MINUTE });
  const messages = Array.from({ length: 20 + turn }, (_, n) => ({
    role: n % 2 ? 'assistant' : 'user',
    content: `turn ${turn} message ${n} "quoted" \\ {brace} [bracket] 한글 ${'z'.repeat(200)}`,
  }));
  // Header fields on both sides of the transcript, as the store writes them.
  const { title, updatedAt, totalInputTokens, totalOutputTokens, totalToolCalls, ...front } = header;
  return JSON.stringify({ ...front, messages, title, updatedAt, totalInputTokens, totalOutputTokens, totalToolCalls });
}

function indexRow(id, index, now, turn) {
  const running = RUNNING.has(id);
  const status = running ? 'running' : ['idle', 'failed', 'done', 'idle'][index % 4];
  return {
    tag: `tag-${index}`,
    sessionId: id,
    agent: 'worker',
    ownerSessionId: LEAD,
    parentSessionId: LEAD,
    status,
    stage: running ? 'streaming' : status,
    // Settled rows either inside or well outside the pane window.
    updatedAt: running ? now - turn : now - (index % 3 === 0 ? 120 * MINUTE : 10 * MINUTE),
    createdAt: now - 90 * MINUTE,
    startedAt: new Date(now - 90 * MINUTE + index * 1000).toISOString(),
    ...(status === 'failed' ? { failureReason: 'timeout' } : {}),
  };
}

test('an incrementally updated pool lists exactly what a cold read of the same store lists', async () => {
  await withDataDir(async (root) => {
    const now = Date.now();
    const ids = Array.from({ length: 40 }, (_, index) => `churn-${String(index).padStart(2, '0')}`);
    const turns = new Map(ids.map((id) => [id, 1]));
    const sessionPath = (id) => join(root, 'sessions', `${id}.json`);
    const rowsById = new Map(ids.map((id, index) => [id, indexRow(id, index, now, 1)]));
    const tombstones = {};
    const writeIndex = () =>
      writeAtomic(
        join(root, 'agent-workers.json'),
        JSON.stringify({ version: 2, workers: Object.fromEntries(rowsById), tombstones })
      );
    for (const [index, id] of ids.entries()) writeFileSync(sessionPath(id), sessionRecord(id, index, 1, now));
    writeFileSync(sessionPath(LEAD), JSON.stringify({ id: LEAD, owner: 'user', agent: 'lead', messages: [] }));
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({ workers: [{ sessionId: LEAD, status: 'idle', updatedAt: now, createdAt: now - 100 * MINUTE }] })
    );
    writeIndex();

    const live = await coldPool();
    const options = { runningSessionIds: RUNNING };
    const listed = live.listStoredAgentWorkers(options);
    assert.ok(listed.length > 20, 'the fixture lists most of its agents');
    assert.deepEqual(live.listStoredAgentWorkers(options), listed, 'an unchanged store lists identically');

    for (let round = 0; round < 6; round++) {
      // Running agents persist a turn: their records grow and move.
      for (const id of ['churn-00', 'churn-01', 'churn-02', 'churn-03']) {
        const turn = turns.get(id) + 1;
        turns.set(id, turn);
        const text = sessionRecord(id, ids.indexOf(id), turn, now);
        if (round % 2) writeAtomic(sessionPath(id), text);
        else writeFileSync(sessionPath(id), text);
        rowsById.set(id, indexRow(id, ids.indexOf(id), now, turn));
      }
      // A settled agent's header changes without touching its index row.
      const idle = ids[10 + round];
      writeFileSync(sessionPath(idle), sessionRecord(idle, ids.indexOf(idle), 2 + round, now));
      if (round === 2) rowsById.delete('churn-20');
      if (round === 3) {
        const id = 'churn-new';
        writeFileSync(sessionPath(id), sessionRecord(id, 41, 1, now));
        rowsById.set(id, indexRow(id, 41, now, 1));
      }
      if (round === 4) {
        const reaped = rowsById.get('churn-21');
        tombstones.reaped = { tag: reaped.tag, parentSessionId: LEAD, reapedAt: new Date(now).toISOString() };
      }
      if (round === 5) rmSync(sessionPath('churn-22'));
      writeIndex();
      const reference = (await coldPool()).listStoredAgentWorkers(options);
      assert.deepEqual(live.listStoredAgentWorkers(options), reference, `round ${round}`);
      // The awaited listing (the daemon's) reads the same store identically,
      // cold or from the caches the sync listings warmed.
      assert.deepEqual(await live.listStoredAgentWorkersAsync(options), reference, `async round ${round}`);
      assert.deepEqual(
        await (await coldPool()).listStoredAgentWorkersAsync(options),
        reference,
        `cold async round ${round}`
      );
      assert.deepEqual(
        live.listStoredAgentWorkerLinks(),
        (await coldPool()).listStoredAgentWorkerLinks(),
        `links round ${round}`
      );
    }
  });
});

/** One idle worker whose session record carries `title`. */
function writeSingleWorker(root, title) {
  const path = join(root, 'sessions', 'stamp-child.json');
  writeFileSync(path, JSON.stringify({ id: 'stamp-child', owner: 'agent', title, messages: [] }));
  writeFileSync(
    join(root, 'agent-workers.json'),
    JSON.stringify({ workers: [{ sessionId: 'stamp-child', tag: 'stamp', agent: 'worker', status: 'idle' }] })
  );
  return path;
}

test('a session rewrite that keeps its size and mtime is still read, settled or not', async () => {
  await withDataDir(async (root) => {
    const path = writeSingleWorker(root, 'AAAA');
    const { mtime } = statSync(path);
    const pool = await coldPool();
    assert.equal(pool.listStoredAgentWorkers()[0].title, 'AAAA');
    // Racy: the first read is not even cached yet.
    writeFileSync(path, JSON.stringify({ id: 'stamp-child', owner: 'agent', title: 'BBBB', messages: [] }));
    utimesSync(path, mtime, mtime);
    assert.equal(pool.listStoredAgentWorkers()[0].title, 'BBBB');
    // Settled and cached: an in-place rewrite still changes the change time.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    assert.equal(pool.listStoredAgentWorkers()[0].title, 'BBBB');
    writeFileSync(path, JSON.stringify({ id: 'stamp-child', owner: 'agent', title: 'CCCC', messages: [] }));
    utimesSync(path, mtime, mtime);
    assert.equal(pool.listStoredAgentWorkers()[0].title, 'CCCC');
  });
});

test('a settled, unchanged header is served from the cache, however many there are', async () => {
  await withDataDir(async (root) => {
    const ids = Array.from({ length: 300 }, (_, index) => `many-${String(index).padStart(3, '0')}`);
    for (const id of ids) {
      writeFileSync(join(root, 'sessions', `${id}.json`), JSON.stringify({ id, owner: 'agent', title: id }));
    }
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({
        workers: ids.map((sessionId) => ({ sessionId, tag: sessionId, agent: 'worker', status: 'idle' })),
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const pool = await coldPool();
    const first = pool.listStoredAgentWorkers();
    assert.equal(first.length, ids.length);
    const { reads } = pool.storedAgentWorkerHeaderStats();
    assert.deepEqual(pool.listStoredAgentWorkers(), first);
    assert.equal(pool.storedAgentWorkerHeaderStats().reads, reads, 'no unchanged record is read again');
    assert.equal(pool.storedAgentWorkerHeaderStats().entries, ids.length);
  });
});

test('the awaited listing touches the store only through async I/O, and its caches serve the next one', async (t) => {
  await withDataDir(async (root) => {
    const ids = Array.from({ length: 50 }, (_, index) => `async-${String(index).padStart(2, '0')}`);
    for (const id of ids) {
      writeFileSync(
        join(root, 'sessions', `${id}.json`),
        JSON.stringify({ id, owner: 'agent', title: id, ownerSessionId: 'async-lead' })
      );
    }
    // The owner's header is consulted too (orphan prune); an Agent owner keeps its children.
    writeFileSync(
      join(root, 'sessions', 'async-lead.json'),
      JSON.stringify({ id: 'async-lead', owner: 'agent', agent: 'worker' })
    );
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({
        workers: ids.map((sessionId) => ({ sessionId, tag: sessionId, agent: 'worker', status: 'idle' })),
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    const pool = await coldPool();
    const fs = await import('node:fs');
    const { syncBuiltinESMExports } = await import('node:module');
    const forbid = (name) =>
      t.mock.method(fs.default, name, () => {
        throw new Error(`synchronous ${name} during an awaited listing`);
      });
    forbid('readFileSync');
    forbid('statSync');
    syncBuiltinESMExports();
    let listed;
    try {
      listed = await pool.listStoredAgentWorkersAsync();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(listed, pool.listStoredAgentWorkers());
    assert.equal(listed.length, ids.length);
    const { reads } = pool.storedAgentWorkerHeaderStats();
    await pool.listStoredAgentWorkersAsync();
    assert.equal(pool.storedAgentWorkerHeaderStats().reads, reads, 'no unchanged record is read again');
  });
});

test('a worker index rewrite that keeps its size and mtime is still read', async () => {
  await withDataDir(async (root) => {
    const now = Date.now();
    const indexPath = join(root, 'agent-workers.json');
    writeFileSync(join(root, 'sessions', 'same-size.json'), JSON.stringify({ id: 'same-size', owner: 'agent' }));
    const write = (title) =>
      writeFileSync(
        indexPath,
        JSON.stringify({
          workers: [{ sessionId: 'same-size', tag: 'same', agent: 'worker', status: 'idle', title, updatedAt: now }],
        })
      );
    write('AAAA');
    const { mtime } = statSync(indexPath);
    const pool = await coldPool();
    assert.equal(pool.listStoredAgentWorkers()[0].title, 'AAAA');
    write('BBBB');
    utimesSync(indexPath, mtime, mtime);
    assert.equal(pool.listStoredAgentWorkers()[0].title, 'BBBB');
    assert.equal(pool.listStoredAgentWorkerLinks().length, 0);
  });
});
