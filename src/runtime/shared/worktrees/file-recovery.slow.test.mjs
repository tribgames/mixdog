import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { assertRecoveryStoresClear } from './file-recovery.mjs';
import {
  assertWorktreeRemovable, configureWorktreeManager, removeManagedWorktree,
  withWorktreeRecoveryStore,
} from './manager.mjs';
import { cleanupDeletedSessionWorktree, pruneWorktrees, reconcileWorktreesAtStartup } from './maintenance.mjs';
import { getRecord, putRecord } from './registry.mjs';
import { cleanupTempDirs, createTestWorktree, makeRepo, tempDir, useTempDataDir } from './test-support.mjs';

let restore;
beforeEach(() => {
  useTempDataDir();
  restore = configureWorktreeManager({ settings: { autoCleanup: true }, freeBytes: async () => Number.MAX_SAFE_INTEGER, processAlive: () => false });
});
afterEach(() => restore());
after(() => cleanupTempDirs());
const storeFor = (root, data = realpathSync(tempDir('mixdog-file-recovery-profile-'))) =>
  join(data, 'editor-recovery', createHash('sha256').update(resolve(root)).digest('hex'));
const retain = (directory) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'retained-record'), 'do not delete');
};

test('persisted recovery scope blocks force, preflight, prune and startup even for a clean worktree', async () => {
  const { entry, sessionId } = await createTestWorktree(makeRepo());
  const directory = storeFor(entry.path);
  await withWorktreeRecoveryStore(entry.path, directory, 'write', async () => retain(directory));
  assert.deepEqual((await getRecord(entry.id)).editorRecoveryStores, [{ root: entry.path, directory }]);
  for (const remove of [
    () => assertWorktreeRemovable({ entryId: entry.id, force: true }),
    () => removeManagedWorktree({ entryId: entry.id }),
    () => removeManagedWorktree({ entryId: entry.id, force: true }),
  ]) await assert.rejects(remove(), { code: 'WORKTREE_FILE_RECOVERY' });
  for (const maintenance of [pruneWorktrees, reconcileWorktreesAtStartup]) {
    const report = await maintenance({ listSessionIds: async () => [] });
    assert.deepEqual(report.removed, []);
    assert.ok(report.errors.some((row) => row.id === entry.id && row.error.includes('Retained file recovery')));
  }
  assert.equal((await cleanupDeletedSessionWorktree(sessionId, { autoCleanup: true })).reason, 'WORKTREE_FILE_RECOVERY');
  assert.ok(existsSync(entry.path));
  assert.equal(readFileSync(join(directory, 'retained-record'), 'utf8'), 'do not delete');
  rmSync(join(directory, 'retained-record'));
  assert.equal((await removeManagedWorktree({ entryId: entry.id })).removed, true);
  assert.ok(existsSync(directory), 'the worktree manager never deletes the journal store');
});

test('registered stores protect a pending deletion in a new process without a desktop adapter', async () => {
  const { entry } = await createTestWorktree(makeRepo());
  const directory = storeFor(entry.path);
  await withWorktreeRecoveryStore(entry.path, directory, 'inspect', async () => retain(directory));
  const record = await getRecord(entry.id);
  record.state = 'deleting';
  record.deleting = { force: true, startedAt: Date.now(), remaining: [] };
  await putRecord(record);
  const moduleUrl = new URL('./manager.mjs', import.meta.url).href;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { reconcileManagedWorktrees } from ${JSON.stringify(moduleUrl)};
    const result = await reconcileManagedWorktrees({ removeOrphans: true });
    console.log(JSON.stringify(result));
  `], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const report = JSON.parse(out.trim());
  assert.ok(report.errors.some((item) => item.id === entry.id && item.error.includes('Retained file recovery')));
  assert.ok(existsSync(entry.path));
  await assert.rejects(withWorktreeRecoveryStore(entry.path, directory, 'write', async () => assert.fail('must not write')), { code: 'WORKTREE_MISSING' });
  await withWorktreeRecoveryStore(entry.path, directory, 'discard', async () => rmSync(join(directory, 'retained-record')));
  assert.equal((await removeManagedWorktree({ entryId: entry.id, force: true })).removed, true);
});

test('journal admission and removal share a lock across the inspection/write gap', async () => {
  const { entry } = await createTestWorktree(makeRepo());
  const directory = storeFor(entry.path);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const writer = withWorktreeRecoveryStore(entry.path, directory, 'write', async () => {
    entered();
    await blocked;
    retain(directory);
  });
  await started;
  const removal = removeManagedWorktree({ entryId: entry.id, force: true });
  const rejected = assert.rejects(removal, { code: 'WORKTREE_FILE_RECOVERY' });
  release();
  await writer;
  await rejected;
  assert.ok(existsSync(entry.path));
});

test('nested project scopes and multiple file-host profiles are retained independently', async () => {
  const { entry } = await createTestWorktree(makeRepo());
  const sub = join(entry.path, 'packages', 'app');
  mkdirSync(sub, { recursive: true });
  const first = storeFor(sub), second = storeFor(sub);
  await withWorktreeRecoveryStore(sub, first, 'inspect', async () => retain(first));
  await withWorktreeRecoveryStore(sub, second, 'write', async () => retain(second));
  await withWorktreeRecoveryStore(sub, first, 'inspect', async () => {});
  assert.equal((await getRecord(entry.id)).editorRecoveryStores.length, 2);
  rmSync(join(first, 'retained-record'));
  await assert.rejects(removeManagedWorktree({ entryId: entry.id, force: true }), { code: 'WORKTREE_FILE_RECOVERY' });
  rmSync(join(second, 'retained-record'));
  assert.equal((await removeManagedWorktree({ entryId: entry.id, force: true })).removed, true);
});

test('malformed or unreadable registered storage never becomes an empty inventory', async () => {
  const { entry } = await createTestWorktree(makeRepo());
  const directory = storeFor(entry.path);
  const record = { ...(await getRecord(entry.id)), editorRecoveryStores: [{ root: entry.path, directory }] };
  await assertRecoveryStoresClear(record); // Registration precedes mkdir.
  mkdirSync(dirname(directory), { recursive: true });
  writeFileSync(directory, 'not a directory');
  await assert.rejects(assertRecoveryStoresClear(record), { code: 'WORKTREE_FILE_RECOVERY' });
  for (const scopes of [{}, Array(65).fill({ root: entry.path, directory }), [{ root: '/elsewhere', directory }]])
    await assert.rejects(assertRecoveryStoresClear({ ...record, editorRecoveryStores: scopes }), { code: 'WORKTREE_FILE_RECOVERY' });
});
