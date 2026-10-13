import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  WORKTREE_ERROR_CODES,
  WorktreeError,
  createRootCleanupRegistry,
  isWorktreeBound,
  isWorktreeError,
  managedWorktreePath,
  managedWorktreeRoot,
  nextRevision,
  normalizeSessionWorkspace,
  normalizeWorktreeEntry,
  normalizeWorktreeOwner,
  projectWorkspace,
  registerRootCleanup,
  repoHash,
  runRootCleanups,
  worktreeBranchName,
  worktreeError,
  worktreeNameError,
} from './contract.mjs';

const COMMIT = 'a'.repeat(40);

test('a project workspace starts idle at revision 0 and is not worktree-bound', () => {
  const workspace = projectWorkspace({ projectPath: '/repo', repoCommonDir: '/repo/.git', branch: 'main' });
  assert.deepEqual(workspace, {
    projectPath: '/repo',
    repoCommonDir: '/repo/.git',
    cwd: '/repo',
    worktreeId: null,
    branch: 'main',
    baseCommit: null,
    mergeTarget: null,
    revision: 0,
    transition: { state: 'idle', txId: null },
  });
  assert.equal(isWorktreeBound(workspace), false);
  assert.equal(nextRevision(workspace), 1);
});

test('a worktree-bound workspace keeps project identity separate from cwd', () => {
  const workspace = normalizeSessionWorkspace({
    projectPath: '/repo',
    repoCommonDir: '/repo/.git',
    cwd: '/data/worktrees-v1/abc/fix',
    worktreeId: 'fix',
    branch: 'mixdog/fix',
    baseCommit: COMMIT,
    mergeTarget: 'main',
    revision: 4,
    transition: { state: 'switching', txId: 'tx-1' },
  });
  assert.equal(workspace.projectPath, '/repo');
  assert.equal(isWorktreeBound(workspace), true);
  assert.equal(nextRevision(workspace), 5);
});

test('workspace invariants are enforced', () => {
  const base = { projectPath: '/repo', cwd: '/repo' };
  for (const bad of [
    { ...base, projectPath: '' },
    { ...base, revision: -1 },
    { ...base, revision: 1.5 },
    { ...base, transition: { state: 'busy', txId: 'x' } },
    { ...base, transition: { state: 'idle', txId: 'x' } },
    { ...base, transition: { state: 'provisioning', txId: null } },
    { ...base, worktreeId: 'wt', branch: 'b' },
    { ...base, baseCommit: 'abc' },
  ]) {
    assert.throws(() => normalizeSessionWorkspace(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => nextRevision({ revision: 'x' }), TypeError);
});

test('registry entries and owner records validate their shapes', () => {
  const entry = normalizeWorktreeEntry({
    id: 'fix-login',
    repoCommonDir: '/repo/.git',
    projectPath: '/repo',
    path: '/data/worktrees-v1/abc/fix-login',
    branch: 'mixdog/fix-login',
    baseCommit: COMMIT,
    createdAt: 1700000000000,
    ownerSessionId: 'sess-1',
    state: 'ready',
    extra: 'dropped',
  });
  assert.equal(entry.ownerSessionId, 'sess-1');
  assert.equal(Object.hasOwn(entry, 'extra'), false);
  assert.throws(() => normalizeWorktreeEntry({ ...entry, state: 'gone' }), TypeError);
  assert.throws(() => normalizeWorktreeEntry({ ...entry, createdAt: '2024' }), TypeError);
  assert.throws(() => normalizeWorktreeEntry({ ...entry, id: '../escape' }), TypeError);

  assert.deepEqual(normalizeWorktreeOwner({ sessionId: 's', runtimeToken: 't' }), {
    sessionId: 's',
    runtimeToken: 't',
    pid: null,
  });
  assert.throws(() => normalizeWorktreeOwner({ sessionId: 's', runtimeToken: '', pid: 1 }), TypeError);
  assert.throws(() => normalizeWorktreeOwner({ sessionId: 's', runtimeToken: 't', pid: 0 }), TypeError);
});

test('typed errors carry stable codes and default messages', () => {
  for (const code of Object.keys(WORKTREE_ERROR_CODES)) assert.equal(WORKTREE_ERROR_CODES[code], code);
  const error = worktreeError('MERGE_CONFLICT', undefined, { files: ['a.txt'] });
  assert.ok(error instanceof WorktreeError);
  assert.equal(error.code, 'MERGE_CONFLICT');
  assert.match(error.message, /conflict/);
  assert.deepEqual(error.details, { files: ['a.txt'] });
  assert.equal(isWorktreeError(error), true);
  assert.equal(isWorktreeError(error, 'MERGE_CONFLICT'), true);
  assert.equal(isWorktreeError(error, 'WORKTREE_DIRTY'), false);
  assert.equal(isWorktreeError({ code: 'ENOENT' }), false);
  assert.equal(isWorktreeError({ code: 'WORKTREE_BUSY_JOBS', message: 'over the wire' }), true);
  assert.throws(() => worktreeError('NOPE'), TypeError);
});

test('managed paths live under worktrees-v1/<repoHash>/<slug> with the branch prefix', () => {
  const hash = repoHash('C:\\Repo\\.git', 'win32');
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(repoHash('c:/repo/.git/', 'win32'), hash);
  assert.notEqual(repoHash('/repo/.git', 'linux'), repoHash('/Repo/.git', 'linux'));
  const dataDir = join('/data');
  assert.equal(
    managedWorktreeRoot('/repo/.git', { dataDir, platform: 'linux' }),
    join(dataDir, 'worktrees-v1', repoHash('/repo/.git', 'linux'))
  );
  assert.equal(
    managedWorktreePath('/repo/.git', 'fix', { dataDir, platform: 'linux' }),
    join(dataDir, 'worktrees-v1', repoHash('/repo/.git', 'linux'), 'fix')
  );
  assert.equal(worktreeBranchName('fix'), 'mixdog/fix');
  assert.equal(worktreeBranchName('fix', 'me/'), 'me/fix');
  for (const bad of ['', '-x', 'a/b', 'a..b', 'x.lock', 'x.', 'a b', 'x'.repeat(65)]) {
    assert.ok(worktreeNameError(bad), bad);
    assert.throws(() => worktreeBranchName(bad), TypeError);
  }
  assert.equal(worktreeNameError('fix-login_2.0'), null);
});

test('root cleanups run in order and report per-module results without stopping', async () => {
  const registry = createRootCleanupRegistry();
  const seen = [];
  registry.register('index', async (root, ctx) => {
    seen.push(['index', root, ctx.reason]);
    return { removed: 2 };
  });
  registry.register('broken', () => {
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  });
  const unregister = registry.register('snapshots', () => undefined);
  assert.throws(() => registry.register('index', () => {}), /already registered/);
  assert.deepEqual(registry.names(), ['index', 'broken', 'snapshots']);
  assert.deepEqual(await registry.run('/w', { reason: 'remove' }), [
    { name: 'index', ok: true, result: { removed: 2 } },
    { name: 'broken', ok: false, error: { code: 'EBUSY', message: 'locked' } },
    { name: 'snapshots', ok: true, result: null },
  ]);
  assert.deepEqual(seen, [['index', '/w', 'remove']]);
  unregister();
  assert.deepEqual(registry.names(), ['index', 'broken']);
  await assert.rejects(registry.run(''), TypeError);

  const off = registerRootCleanup('contract-test', (root) => ({ root }));
  try {
    const results = await runRootCleanups('/x');
    assert.deepEqual(
      results.find((row) => row.name === 'contract-test'),
      { name: 'contract-test', ok: true, result: { root: '/x' } }
    );
  } finally {
    off();
  }
});
