// The daemon's session listing with a storage refresh (the Agent-only listing
// included) and the summary-index rewrite it causes run on the event loop:
// none of it may block that loop — no synchronous filesystem call, no
// Atomics.wait, and no wait on another process's index lock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { syncFsCalls } from '../runtime/shared/sync-fs-calls.fixture.mjs';
import { createStoredSessionViews } from './daemon-stored-session-views.mjs';

const roots = [];
const previousDataDir = process.env.MIXDOG_DATA_DIR;
test.after(async () => {
  const { settleSessionSummaryIndex } = await import('../runtime/agent/orchestrator/session/store/listing.mjs');
  await settleSessionSummaryIndex();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A data dir holding one Lead and one Agent child of it. */
function seedDataDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, 'sessions'));
  const write = (record) => writeFileSync(join(root, 'sessions', `${record.id}.json`), JSON.stringify(record));
  write({
    id: 'sess_lead',
    owner: 'user',
    agent: 'lead',
    sourceType: 'lead',
    generation: 1,
    updatedAt: 2,
    messages: [{ role: 'user', content: 'lead prompt' }],
  });
  write({
    id: 'sess_child',
    owner: 'agent',
    agent: 'worker',
    parentSessionId: 'sess_lead',
    ownerSessionId: 'sess_lead',
    generation: 1,
    updatedAt: 1,
    messages: [{ role: 'user', content: 'child task' }],
  });
  process.env.MIXDOG_DATA_DIR = root;
  return root;
}

const views = () =>
  createStoredSessionViews({
    desktopRuntime: {
      loadSessionStore: () => import('../runtime/agent/orchestrator/session/store-summary-reader.mjs'),
    },
  });

const indexedIds = (root) =>
  JSON.parse(readFileSync(join(root, 'session-summaries.json'), 'utf8'))
    .rows.map((row) => row.id)
    .sort();

test('refreshing listings (Agent-only and ordinary) and the index rewrite make no synchronous fs call or Atomics.wait', async (t) => {
  const stored = views();
  // Module loading is not the listing: import everything up front.
  await import('../runtime/agent/orchestrator/session/store.mjs');
  await import('../runtime/agent/orchestrator/session/store-summary-reader.mjs');
  const root = seedDataDir('mixdog-listing-nonblocking-');
  let waits = 0;
  const wait = Atomics.wait;
  t.mock.method(Atomics, 'wait', (...args) => {
    waits += 1;
    return wait(...args);
  });
  let rows;
  let ordinary;
  const calls = await syncFsCalls(async () => {
    rows = await stored.listSessions({ includeAgentOnly: true, refreshFromStorage: true });
    ordinary = await stored.listSessions({ refreshFromStorage: true });
  });
  assert.deepEqual(calls, []);
  assert.equal(waits, 0);
  assert.deepEqual(rows.map((row) => row.id).sort(), ['sess_child', 'sess_lead']);
  assert.equal(rows.find((row) => row.id === 'sess_child').parentSessionId, 'sess_lead');
  assert.deepEqual(indexedIds(root), ['sess_child', 'sess_lead'], 'the scan rewrote the index');
  assert.deepEqual(ordinary.map((row) => row.id).sort(), ['sess_child', 'sess_lead']);
});

test('the cached Agent-only listing reads the whole index with no synchronous fs call', async () => {
  const stored = views();
  const root = seedDataDir('mixdog-listing-cached-');
  // An index written by another process: the cold listing reads it whole.
  const row = (id, title, extra = {}) => ({ id, owner: 'user', agent: 'lead', title, updatedAt: 1, ...extra });
  writeFileSync(
    join(root, 'session-summaries.json'),
    JSON.stringify({
      version: 2,
      rows: [
        row('sess_lead', 'indexed lead'),
        row('sess_child', 'indexed child', {
          owner: 'agent',
          parentSessionId: 'sess_lead',
          ownerSessionId: 'sess_lead',
        }),
      ],
    })
  );
  let cold;
  let warm;
  const calls = await syncFsCalls(async () => {
    cold = await stored.listSessions({ includeAgentOnly: true });
    // Another process advances the index: the warm listing re-reads it.
    await appendFile(
      join(root, 'session-summaries.log'),
      `\n${JSON.stringify({ u: row('sess_lead', 'renamed elsewhere', { updatedAt: 2 }) })}\n`
    );
    await utimes(join(root, 'session-summaries.log'), new Date(), new Date(Date.now() + 5_000));
    warm = await stored.listSessions({ includeAgentOnly: true });
  });
  assert.deepEqual(calls, []);
  assert.equal(cold.find((entry) => entry.id === 'sess_lead')?.title, 'indexed lead');
  assert.equal(cold.find((entry) => entry.id === 'sess_child')?.parentSessionId, 'sess_lead');
  assert.equal(warm.find((entry) => entry.id === 'sess_lead')?.title, 'renamed elsewhere');
});

/** Another process holding `lockPath` until it is told to release it. */
async function holdLockElsewhere(lockPath) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { unlinkSync, writeFileSync } from 'node:fs';
       const lockPath = ${JSON.stringify(lockPath)};
       writeFileSync(lockPath, process.pid + ' ' + Date.now() + ' foreign-holder\\n', { flag: 'wx' });
       process.stdout.write('held\\n');
       process.stdin.once('data', () => { unlinkSync(lockPath); process.exit(0); });`,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
  });
  return () =>
    new Promise((resolve) => {
      child.once('exit', resolve);
      child.stdin.end('release\n');
    });
}

test('while another process holds the index lock the loop keeps turning, and the listing lands once it frees', async () => {
  const stored = views();
  const root = seedDataDir('mixdog-listing-held-lock-');
  const release = await holdLockElsewhere(join(root, 'session-summaries.json.lock'));
  let turns = 0;
  let counting = true;
  const count = () => {
    if (!counting) return;
    turns += 1;
    setImmediate(count);
  };
  setImmediate(count);
  let settled = false;
  const listing = stored.listSessions({ includeAgentOnly: true, refreshFromStorage: true }).finally(() => {
    settled = true;
  });
  let released = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const turnsWhileHeld = turns;
    assert.equal(settled, false, 'the index rewrite waits for the lock');
    assert.ok(turnsWhileHeld > 20, `the loop turned ${turnsWhileHeld} times while the lock was held`);
  } finally {
    counting = false;
    released = release();
  }
  await released;
  const rows = await listing;
  assert.deepEqual(rows.map((row) => row.id).sort(), ['sess_child', 'sess_lead']);
  assert.deepEqual(indexedIds(root), ['sess_child', 'sess_lead'], 'the rewrite landed after the release');
});
