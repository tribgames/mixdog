// A delegated worker's read-only snapshot through the git tool: held by the
// worker's own session, and gone once that worker's turn settles (the session
// runtime's unload), like the Lead's turn snapshots.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, afterEach, beforeEach, test } from 'node:test';
import { executeGitTool } from '../../agent/orchestrator/tools/builtin/git-command-tool.mjs';
import { unloadSessionRuntime } from '../../agent/orchestrator/session/manager/session-close.mjs';
import { configureWorktreeManager, getWorktreeByPath, listManagedWorktrees } from './manager.mjs';
import { cleanupTempDirs, git, makeRepo, useTempDataDir } from './test-support.mjs';
import { releaseWorkerSnapshots } from './worker-snapshots.mjs';

let restore = () => {};
beforeEach(() => {
  useTempDataDir();
  restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
});
afterEach(() => restore());
after(() => cleanupTempDirs());

const worker = (id) => ({ sessionId: id, toolCallId: `${id}-call` });

test('a worker makes a snapshot it holds; its turn ending removes it, and it still gets no branch worktree', async () => {
  const repo = makeRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  const made = JSON.parse(
    await executeGitTool({ command: 'git worktree add --detach ../snap' }, repo, worker('sess_w1'))
  );
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.snapshot, true);
  assert.equal(made.commit, head);
  assert.ok(existsSync(made.path));
  const entry = await getWorktreeByPath(made.path);
  assert.equal(entry.kind, 'snapshot');
  assert.equal(entry.holderSessionId, 'sess_w1');

  // Another worker's turn ending leaves it alone; its own removes it.
  assert.deepEqual(await releaseWorkerSnapshots('sess_other'), { removed: [], kept: [] });
  assert.ok(existsSync(made.path));
  assert.equal(unloadSessionRuntime('sess_w1', 'agent-turn-complete'), true);
  for (let i = 0; i < 100 && (await listManagedWorktrees()).length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(await listManagedWorktrees(), []);
  assert.equal(existsSync(made.path), false);
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);

  assert.match(
    await executeGitTool({ command: 'git worktree add -b w ../w' }, repo, worker('sess_w1')),
    /delegated worker may only make a read-only snapshot/
  );
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
});
