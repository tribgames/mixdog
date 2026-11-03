// The automatic worktree removals against real git: user data only a
// worktree holds (ignored files no install restores) keeps it, and a deleted
// session's removal keeps the recovery ref of the branch it deletes.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { configureWorktreeManager, listManagedWorktrees } from './manager.mjs';
import { cleanupDeletedSessionWorktree, runWorktreeCleanup } from './maintenance.mjs';
import { getRecord, putRecord } from './registry.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree as create,
  git,
  makeRepo,
  useTempDataDir,
  writeFile,
} from './test-support.mjs';

const DAY = 24 * 60 * 60_000;
let restore = () => {};

function configure(settings = {}) {
  restore();
  restore = configureWorktreeManager({
    settings,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
  });
}

beforeEach(() => {
  useTempDataDir();
  configure();
});
afterEach(() => restore());
after(() => cleanupTempDirs());

const branchExists = (repo, branch) =>
  git(repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`) === branch;

test("a deleted session's squash-merged worktree goes with its branch; the tip stays under the recovery ref", async () => {
  const repo = makeRepo();
  const made = await create(repo, { nameHint: 'squashed' });
  const tip = commitFile(made.entry.path, 'feature.txt', 'feature\n', 'feature');
  git(repo, 'merge', '--squash', made.entry.branch);
  git(repo, 'commit', '-q', '-m', 'squash feature');
  const result = await cleanupDeletedSessionWorktree(made.sessionId, { autoCleanup: true });
  assert.equal(result.removed, true);
  assert.equal(branchExists(repo, made.entry.branch), false);
  assert.equal(git(repo, 'rev-parse', `refs/mixdog/recovered/${made.entry.id}/${tip}`), tip);
});

test('an ignored .bundle/config keeps the worktree: installing from Gemfile.lock does not restore it', async () => {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', '.bundle/\n');
  commitFile(repo, 'Gemfile', "source 'https://rubygems.org'\n");
  commitFile(repo, 'Gemfile.lock', 'GEM\n  specs:\n');
  const made = await create(repo, { nameHint: 'ruby' });
  writeFile(made.entry.path, '.bundle/config', 'BUNDLE_GEMS__EXAMPLE__COM: "user:secret"\n');
  const [row] = await listManagedWorktrees({ inspect: true });
  assert.deepEqual([row.dirty, row.ignored], [1, 1]);
  const result = await cleanupDeletedSessionWorktree(made.sessionId, { autoCleanup: true });
  assert.deepEqual([result.removed, result.reason], [false, 'WORKTREE_DIRTY']);
  assert.equal(
    readFileSync(join(made.entry.path, '.bundle', 'config'), 'utf8'),
    'BUNDLE_GEMS__EXAMPLE__COM: "user:secret"\n'
  );
});

test('ignored files no install restores keep a worktree from every automatic removal; reproducible ones do not', async () => {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', '.env\nnode_modules/\n__pycache__/\n.mixdog/\n.tool-cache/\n');
  commitFile(repo, 'package.json', '{}\n');
  commitFile(repo, 'package-lock.json', '{}\n');
  const made = {};
  for (const name of ['aged', 'orphan', 'deleted', 'regen']) {
    made[name] = await create(repo, { nameHint: name });
    await putRecord({ ...(await getRecord(made[name].entry.id)), createdAt: Date.now() - 90 * DAY });
  }
  for (const name of ['aged', 'orphan', 'deleted']) writeFile(made[name].entry.path, '.env', 'SECRET=1\n');
  const regen = made.regen.entry.path;
  writeFile(regen, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  writeFile(regen, '.mixdog/project.id', 'project-1\n');
  writeFile(regen, 'src/__pycache__/app.cpython-312.pyc', 'bytecode');
  writeFile(regen, '.tool-cache/CACHEDIR.TAG', 'Signature: 8a477f597d28d172789f06886806bc55\n');
  writeFile(regen, '.tool-cache/blob.bin', 'cached');
  configure({ maxWorktrees: 0, unusedDays: 30 });
  // A deleted session's leftover: kept, not removed.
  const deleted = await cleanupDeletedSessionWorktree(made.deleted.sessionId);
  assert.deepEqual([deleted.removed, deleted.reason], [false, 'WORKTREE_DIRTY']);
  const retained = [made.aged.sessionId, made.regen.sessionId];
  // The worktree list counts the ignored files as work to keep.
  const rows = await listManagedWorktrees({ retainedSessionIds: retained, inspect: true });
  const counts = (name) => {
    const row = rows.find((item) => item.id === made[name].entry.id);
    return [row.dirty, row.ignored];
  };
  assert.deepEqual(counts('aged'), [1, 1]);
  assert.deepEqual(counts('regen'), [0, 0]);
  const idle = Date.now() - 90 * DAY;
  const report = await runWorktreeCleanup({
    listSessionIds: async () => retained,
    readActivity: async () => Object.fromEntries(retained.map((id) => [id, { lastActiveAt: idle }])),
    readFavorites: async () => [],
    listJobs: async () => [],
  });
  // The age limit selects only the reproducible one; the orphan and the
  // deleted session's leftover are reported kept for their ignored files.
  assert.deepEqual(
    report.selected.map((item) => item.id),
    [made.regen.entry.id]
  );
  assert.deepEqual(report.removed, [made.regen.entry.id]);
  for (const name of ['orphan', 'deleted']) {
    const kept = report.kept.find((item) => item.id === made[name].entry.id);
    assert.deepEqual([kept?.reason, kept?.files, kept?.count], ['ignored', ['.env'], 1], name);
  }
  for (const name of ['aged', 'orphan', 'deleted']) {
    assert.equal(readFileSync(join(made[name].entry.path, '.env'), 'utf8'), 'SECRET=1\n', name);
  }
  assert.equal(existsSync(regen), false);
});
