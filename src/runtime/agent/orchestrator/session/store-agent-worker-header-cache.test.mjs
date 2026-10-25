import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Each import of a distinct URL is a separate module instance with empty
// in-memory caches: a restarted daemon.
let instance = 0;
async function restartedPool() {
  instance += 1;
  return import(`./store-agent-worker-rows.mjs?restart=${instance}`);
}

const MINUTE = 60_000;
const LEAD = 'persist-lead';
const RUNNING = new Set(['persist-00', 'persist-01', LEAD]);
const OPTIONS = { runningSessionIds: RUNNING };

function withDataDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-header-cache-'));
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 2_200));
const sessionPath = (root, id) => join(root, 'sessions', `${id}.json`);
const cachePath = (root) => join(root, 'agent-worker-header-cache.json');

function sessionRecord(id, index, title, now) {
  const header = {
    id,
    owner: 'agent',
    agent: 'worker',
    ownerSessionId: LEAD,
    parentSessionId: LEAD,
    title,
    provider: 'test-provider',
    model: `model-${index % 3}`,
    createdAt: now - 90 * MINUTE,
    updatedAt: now - (index % 4) * MINUTE,
    totalInputTokens: 100 + index,
    totalOutputTokens: 7 * index,
    totalToolCalls: index,
    nested: { kept: 'out of the header' },
  };
  if (index % 7 === 3) Object.assign(header, { cancelStatus: 'cancel-unconfirmed', cancelledAt: now - 5 * MINUTE });
  if (index % 7 === 5) Object.assign(header, { status: 'cancelled', cancelledAt: now - 3 * MINUTE });
  const messages = Array.from({ length: 30 }, (_, n) => ({
    role: n % 2 ? 'assistant' : 'user',
    content: `message ${n} "quoted" \\ {brace} 한글 ${'z'.repeat(300)}`,
  }));
  return JSON.stringify({ ...header, messages });
}

function indexRow(id, index, now) {
  const status = RUNNING.has(id) ? 'running' : ['idle', 'failed', 'done', 'idle'][index % 4];
  return {
    tag: `tag-${index}`,
    sessionId: id,
    agent: 'worker',
    ownerSessionId: LEAD,
    parentSessionId: LEAD,
    status,
    stage: status,
    updatedAt: now - (index % 3 === 0 ? 120 * MINUTE : 10 * MINUTE),
    createdAt: now - 90 * MINUTE,
    ...(status === 'failed' ? { failureReason: 'timeout' } : {}),
  };
}

const IDS = Array.from({ length: 30 }, (_, index) => `persist-${String(index).padStart(2, '0')}`);

/** A store of IDS workers under one Lead, written but not yet settled. */
function writeStoreFiles(root) {
  const now = Date.now();
  for (const [index, id] of IDS.entries()) writeFileSync(sessionPath(root, id), sessionRecord(id, index, `T${index}`, now));
  writeFileSync(sessionPath(root, LEAD), JSON.stringify({ id: LEAD, owner: 'user', agent: 'lead', messages: [] }));
  writeFileSync(
    join(root, 'agent-workers.json'),
    JSON.stringify({ workers: Object.fromEntries(IDS.map((id, index) => [id, indexRow(id, index, now)])) })
  );
  writeFileSync(
    join(root, 'lead-workers.json'),
    JSON.stringify({ workers: [{ sessionId: LEAD, status: 'idle', updatedAt: now, createdAt: now - 100 * MINUTE }] })
  );
  return now;
}

/** A settled store of IDS workers under one Lead. */
async function writeStore(root) {
  const now = writeStoreFiles(root);
  await settle();
  return now;
}

/** A full cold scan: a fresh instance's synchronous listing, which never
 *  consults the persisted cache. */
async function fullScan() {
  return (await restartedPool()).listStoredAgentWorkers(OPTIONS);
}

/** A daemon's life: one awaited listing, then its scheduled persist. */
async function runDaemon() {
  const pool = await restartedPool();
  const rows = await pool.listStoredAgentWorkersAsync(OPTIONS);
  await pool.flushStoredAgentWorkerHeaderCache();
  return { pool, rows, reads: pool.storedAgentWorkerHeaderStats().reads };
}

// One settled store serves every phase: each settle costs 2.2 s.
test('the persisted header cache across daemon restarts', async (t) => {
  let lingering;
  let removedRoot;
  await withDataDir(async (root) => {
    removedRoot = root;
    const now = await writeStore(root);
    let reference;

    await t.test('a restarted reader lists what a full scan lists without reading an unchanged record', async () => {
      const first = await runDaemon();
      assert.equal(first.reads, IDS.length + 1, 'the first daemon reads every record');
      assert.ok(existsSync(cachePath(root)), 'the header cache is persisted');
      reference = await fullScan();
      assert.ok(reference.length > 10, 'the fixture lists most of its agents');
      assert.deepEqual(first.rows, reference);

      const restarted = await runDaemon();
      assert.deepEqual(restarted.rows, reference, 'restarted rows equal a full scan');
      assert.equal(restarted.reads, 0, 'no unchanged record is read after a restart');
      assert.deepEqual(await restarted.pool.listStoredAgentWorkersAsync(OPTIONS), reference);
    });

    await t.test('a corrupt, foreign or missing header cache seeds nothing and is replaced', async () => {
      await corruptCacheCases(root, reference);
    });

    await t.test('a record changed while no daemon ran is read again after the restart', async () => {
      // Replaced by rename (new inode), rewritten in place keeping size and
      // mtime (only the change time moves), and deleted.
      const renamed = sessionPath(root, IDS[4]);
      writeFileSync(`${renamed}.tmp`, sessionRecord(IDS[4], 4, 'RENAMED', now));
      renameSync(`${renamed}.tmp`, renamed);
      const inPlace = sessionPath(root, IDS[5]);
      const { mtime } = statSync(inPlace);
      writeFileSync(inPlace, sessionRecord(IDS[5], 5, 'XX', now));
      utimesSync(inPlace, mtime, mtime);
      rmSync(sessionPath(root, IDS[8]));
      await settle();

      const changed = await fullScan();
      const titles = new Map(changed.map((row) => [row.sessionId, row.title]));
      assert.equal(titles.get(IDS[4]), 'RENAMED');
      assert.equal(titles.get(IDS[5]), 'XX');
      const restarted = await runDaemon();
      assert.deepEqual(restarted.rows, changed);
      assert.equal(restarted.reads, 2, 'exactly the two rewritten records are read');
      const persisted = JSON.parse(readFileSync(cachePath(root), 'utf8')).sessions;
      assert.equal(Object.hasOwn(persisted, IDS[8]), false, 'a deleted record leaves the persisted cache');
      assert.ok(Object.hasOwn(persisted, IDS[9]));

      // The rewrite was persisted: the next restart reads nothing.
      const again = await runDaemon();
      assert.deepEqual(again.rows, changed);
      assert.equal(again.reads, 0);
    });

    // A listing that schedules a persist right before its store is removed.
    rmSync(cachePath(root));
    lingering = await restartedPool();
    await lingering.listStoredAgentWorkersAsync(OPTIONS);
  });

  await t.test('a persist scheduled for a removed store never recreates it', async () => {
    await lingering.flushStoredAgentWorkerHeaderCache();
    assert.equal(existsSync(removedRoot), false);
  });
});

test('switching data directories before a scheduled persist still persists the new directory', async () => {
  const previous = process.env.MIXDOG_DATA_DIR;
  const roots = [0, 1].map(() => mkdtempSync(join(tmpdir(), 'mixdog-worker-header-switch-')));
  try {
    for (const root of roots) {
      mkdirSync(join(root, 'sessions'));
      writeStoreFiles(root);
    }
    await settle();
    const pool = await restartedPool();
    const [first, second] = roots;
    process.env.MIXDOG_DATA_DIR = first;
    await pool.listStoredAgentWorkersAsync(OPTIONS);
    // Switched before the first directory's write fired.
    process.env.MIXDOG_DATA_DIR = second;
    await pool.listStoredAgentWorkersAsync(OPTIONS);
    await pool.flushStoredAgentWorkerHeaderCache();
    await pool.listStoredAgentWorkersAsync(OPTIONS);
    await pool.flushStoredAgentWorkerHeaderCache();
    assert.ok(existsSync(cachePath(second)), 'the directory now listed has its cache written');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

/** Every damaged cache shape: the restarted reader lists `reference`, reads
 *  what the shape could not vouch for, and leaves a whole cache behind. */
async function corruptCacheCases(root, reference) {
  const valid = JSON.parse(readFileSync(cachePath(root), 'utf8'));
  const tampered = structuredClone(valid);
  // A stamp that is not the record's, and malformed entries.
  tampered.sessions[IDS[2]].stamp[3] = '1';
  tampered.sessions[IDS[3]].stamp = 'garbage';
  tampered.sessions[IDS[5]].header = ['not', 'a', 'header'];
  tampered.sessions[IDS[7]].header = { ...tampered.sessions[IDS[7]].header, unknownField: 1 };
  tampered.sessions['../escape'] = valid.sessions[IDS[9]];
  const damaged = [
    ['missing', null, IDS.length + 1],
    ['empty', '', IDS.length + 1],
    ['truncated', JSON.stringify(valid).slice(0, 200), IDS.length + 1],
    ['not json', '{not json', IDS.length + 1],
    ['null', 'null', IDS.length + 1],
    ['other version', JSON.stringify({ ...valid, version: 999 }), IDS.length + 1],
    ['other fields', JSON.stringify({ ...valid, fields: 'title' }), IDS.length + 1],
    ['bad sessions', JSON.stringify({ ...valid, sessions: [] }), IDS.length + 1],
    ['tampered entries', JSON.stringify(tampered), 4],
  ];
  for (const [label, text, reads] of damaged) {
    if (text === null) rmSync(cachePath(root));
    else writeFileSync(cachePath(root), text);
    const restarted = await runDaemon();
    assert.deepEqual(restarted.rows, reference, `${label}: rows equal a full scan`);
    assert.equal(restarted.reads, reads, `${label}: records read`);
    const recovered = await runDaemon();
    assert.deepEqual(recovered.rows, reference, `${label}: rewritten cache`);
    assert.equal(recovered.reads, 0, `${label}: the cache was rewritten whole`);
  }
}
