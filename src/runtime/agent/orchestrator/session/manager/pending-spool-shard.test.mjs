// Per-session sharding of the pending-message spool: layout, the one-time
// migration of the legacy global file, cross-session lock independence and the
// directory-walking sweep.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const root = mkdtempSync(join(tmpdir(), 'mixdog-pending-shard-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_LOCK_TIMEOUT_MS = '150';
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { enqueuePendingMessage, settlePendingMessageWrites, sweepOrphanedPendingMessages } = await import(
  './pending-messages.mjs'
);
const { pendingMessagesPath, legacyPendingMessagesPath } = await import('./pending-spool-path.mjs');
const { _resetPendingSpoolMigrationForTest, ensurePendingSpoolMigrated, updatePendingShard } = await import(
  './pending-spool-shard.mjs'
);

const shardDir = join(root, 'session-pending');
const legacyPath = legacyPendingMessagesPath();
const readShard = (key) => JSON.parse(readFileSync(pendingMessagesPath(key), 'utf8'));
const backups = () => readdirSync(root).filter((name) => name.startsWith('session-pending-messages.json.migrated-'));

function writeLegacy(sessions, touched = {}) {
  writeFileSync(
    legacyPath,
    `${JSON.stringify({ version: 1, updatedAt: Date.now(), sessions, sessionTouchedAt: touched })}\n`,
    'utf8'
  );
}

test('every session persists into its own shard file with its own lock', async () => {
  assert.equal(enqueuePendingMessage('sess_shard_a', 'to a'), 1);
  assert.equal(enqueuePendingMessage('sess_shard_b', 'to b'), 1);
  assert.equal(await settlePendingMessageWrites({ timeoutMs: 4000 }), true);
  assert.deepEqual(Object.keys(readShard('sess_shard_a').sessions), ['sess_shard_a']);
  assert.deepEqual(Object.keys(readShard('sess_shard_b').sessions), ['sess_shard_b']);
  assert.equal(existsSync(legacyPath), false);
  assert.notEqual(pendingMessagesPath('sess_shard_a'), pendingMessagesPath('sess_shard_b'));
});

test('a shard emptied by its last ack/clear is deleted, not left behind', async () => {
  await updatePendingShard('sess_shard_gone', () => ({
    version: 1,
    updatedAt: Date.now(),
    sessions: { sess_shard_gone: [{ id: 'pm_gone', message: 'x', enqueuedAt: 1 }] },
    sessionTouchedAt: { sess_shard_gone: 1 },
  }));
  assert.equal(existsSync(pendingMessagesPath('sess_shard_gone')), true);
  await updatePendingShard('sess_shard_gone', () => ({ version: 1, updatedAt: 2, sessions: {}, sessionTouchedAt: {} }));
  assert.equal(existsSync(pendingMessagesPath('sess_shard_gone')), false);
});

test('a lock held on one session never delays or fails another session', async () => {
  mkdirSync(shardDir, { recursive: true });
  const held = `${pendingMessagesPath('sess_blocked')}.lock`;
  // Live holder: our pid with a foreign token is never reclaimed.
  writeFileSync(held, `${process.pid} ${Date.now()} deadbeefdeadbeefdeadbeef\n`, 'utf8');
  try {
    await assert.rejects(
      updatePendingShard('sess_blocked', () => undefined),
      (error) => error.code === 'ELOCKTIMEOUT'
    );
    // The blocked shard's failed commit would requeue and retry; the free
    // session's commit lands on its first attempt regardless.
    assert.equal(enqueuePendingMessage('sess_free', 'unblocked'), 1);
    await updatePendingShard('sess_free', () => undefined);
    assert.equal(await settlePendingMessageWrites({ timeoutMs: 4000 }), true);
    assert.equal(readShard('sess_free').sessions.sess_free[0].message, 'unblocked');
  } finally {
    rmSync(held, { force: true });
  }
});

test('migration splits the legacy file per session, keeps a backup and is idempotent', async () => {
  const rows = (id) => [{ id, message: `row ${id}`, enqueuedAt: 5, handoffAt: 7, handoffPid: 99 }];
  writeLegacy(
    { sess_mig_1: rows('pm_m1'), tui_mig_lead: [{ id: 'ts_1', text: 'steer', at: 9 }], 'bad key!': rows('pm_bad') },
    { sess_mig_1: 111, tui_mig_lead: 222 }
  );
  _resetPendingSpoolMigrationForTest();
  await ensurePendingSpoolMigrated();
  assert.equal(existsSync(legacyPath), false);
  assert.equal(backups().length, 1);
  assert.deepEqual(readShard('sess_mig_1').sessions.sess_mig_1, rows('pm_m1'));
  assert.equal(readShard('sess_mig_1').sessionTouchedAt.sess_mig_1, 111);
  assert.deepEqual(readShard('tui_mig_lead').sessions.tui_mig_lead, [{ id: 'ts_1', text: 'steer', at: 9 }]);
  assert.equal(existsSync(join(shardDir, 'bad key!.json')), false);
  // Second run: nothing to migrate, nothing duplicated.
  _resetPendingSpoolMigrationForTest();
  await ensurePendingSpoolMigrated();
  assert.equal(backups().length, 1);
  assert.equal(readShard('sess_mig_1').sessions.sess_mig_1.length, 1);
});

test('a migration interrupted after the merge re-runs without duplicating rows', async () => {
  const row = { id: 'pm_crash', message: 'survives', enqueuedAt: 5 };
  // Crash state: the shard already holds the merged row (plus a newer one) while
  // the legacy file was never renamed.
  await updatePendingShard('sess_crash', () => ({
    version: 1,
    updatedAt: 1,
    sessions: { sess_crash: [row, { id: 'pm_newer', message: 'newer', enqueuedAt: 6 }] },
    sessionTouchedAt: { sess_crash: 1 },
  }));
  const before = backups().length;
  writeLegacy({ sess_crash: [row, { id: 'pm_only_legacy', message: 'legacy', enqueuedAt: 4 }] });
  _resetPendingSpoolMigrationForTest();
  await ensurePendingSpoolMigrated();
  assert.equal(backups().length, before + 1);
  assert.deepEqual(
    readShard('sess_crash').sessions.sess_crash.map((r) => r.id),
    ['pm_only_legacy', 'pm_crash', 'pm_newer']
  );
});

test('concurrent processes migrating the same legacy file land every row exactly once', async () => {
  const sessions = {};
  for (let i = 0; i < 12; i += 1)
    sessions[`sess_conc_${i}`] = [{ id: `pm_conc_${i}`, message: 'c', enqueuedAt: i + 1 }];
  writeLegacy(sessions);
  const shardModule = new URL('./pending-spool-shard.mjs', import.meta.url).href;
  const source = `const m = await import(${JSON.stringify(shardModule)}); await m.ensurePendingSpoolMigrated();`;
  const before = backups().length;
  await Promise.all(
    [0, 1, 2, 3].map(() =>
      promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, MIXDOG_DATA_DIR: root, MIXDOG_LOCK_TIMEOUT_MS: '2000' },
      })
    )
  );
  assert.equal(existsSync(legacyPath), false);
  assert.equal(backups().length, before + 1);
  for (let i = 0; i < 12; i += 1) {
    assert.deepEqual(
      readShard(`sess_conc_${i}`).sessions[`sess_conc_${i}`].map((r) => r.id),
      [`pm_conc_${i}`]
    );
  }
});

test('the sweep walks the shard directory and evicts only stale shards', async () => {
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const fresh = Date.now();
  await updatePendingShard('tui_sweep_old', () => ({
    version: 1,
    updatedAt: old,
    sessions: { tui_sweep_old: [{ id: 'ts_old', text: 'old', at: old }] },
    sessionTouchedAt: { tui_sweep_old: old },
  }));
  await updatePendingShard('tui_sweep_new', () => ({
    version: 1,
    updatedAt: fresh,
    sessions: { tui_sweep_new: [{ id: 'ts_new', text: 'new', at: fresh }] },
    sessionTouchedAt: { tui_sweep_new: fresh },
  }));
  // A stray non-shard file in the directory is ignored.
  writeFileSync(join(shardDir, 'notes.txt'), 'x', 'utf8');
  assert.ok((await sweepOrphanedPendingMessages()) >= 1);
  assert.equal(existsSync(pendingMessagesPath('tui_sweep_old')), false);
  assert.equal(existsSync(pendingMessagesPath('tui_sweep_new')), true);
});
