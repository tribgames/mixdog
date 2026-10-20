import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { createWorkspaceTransitions } from './transitions.mjs';
import { admitTurn } from './admission-gate.mjs';
import { configureWorktreeManager, releaseWorktreeOwner } from '../../runtime/shared/worktrees/manager.mjs';
import { tryAdmitWorkspaceActivity } from '../../runtime/shared/worktrees/activity-gate.mjs';
import { WORKTREE_REFUSAL_REASONS } from '../../runtime/shared/worktrees/contract.mjs';
import { samePath } from '../../runtime/shared/worktrees/paths.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree,
  git,
  makeRepo,
  tempDir,
  useTempDataDir,
  writeFile,
} from '../../runtime/shared/worktrees/test-support.mjs';

let restoreManager = null;
beforeEach(() => {
  useTempDataDir();
  restoreManager = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
});
afterEach(() => restoreManager?.());
after(cleanupTempDirs);

let sessions = 0;

/**
 * Session-less management (no session: moving one throws) or, with
 * `session: true`, a hosted Lead whose own moves are recorded.
 */
function fixture(repo, { session: hosted = false, autoCleanup = false } = {}) {
  const state = { stored: [], live: [], jobs: [], probe: null, cwd: repo, moves: [] };
  sessions += 1;
  const session = hosted
    ? {
        id: `sess_merge_${process.pid}_${sessions}`,
        cwd: repo,
        desktopSession: { classification: 'project', projectPath: repo },
        messages: [],
      }
    : null;
  const api = createWorkspaceTransitions({
    getSession: () => session,
    getCurrentCwd: () => state.cwd,
    getConfig: () => ({ worktree: { autoCleanup } }),
    getActiveTurnCount: () => 0,
    agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
    applyResolvedCwd: (next) => {
      if (!session) throw new Error('Management must not move a session');
      state.moves.push(next);
      state.cwd = next;
      session.cwd = next;
    },
    persistSession: () => {
      if (!session) throw new Error('Management must not rewrite a session');
    },
    refreshWorkspaceContext: async () => {},
    listLiveSessions: () => state.live,
    listWorkspaceConsumers: async () => state.stored,
    listWorkspaceJobs: async () => {
      await state.probe?.();
      return state.jobs;
    },
    countOwnShellJobs: async () => 0,
    findRegisteredProject: async (path) => (samePath(path, repo) ? repo : null),
  });
  const inspect = (branch) => api.inspectProjectBranch({ projectPath: repo, branch });
  const act = (view, action) =>
    api.manageProjectBranch({
      projectPath: repo,
      branch: view.branch,
      commit: view.commit,
      target: view.target,
      targetCommit: view.targetCommit,
      confirmed: true,
      action,
    });
  return { state, api, inspect, act, session };
}

/**
 * Every public merge entry point, each with its own source checkout of `repo`:
 * the branch-row action (manageProjectBranch), the dock (mergeProjectBranch)
 * and a session merging the worktree it works in (mergeWorkspace).
 * `external`: the source is a linked checkout Mixdog did not create.
 */
const ENTRY_POINTS = {
  async manageProjectBranch(repo, { external = false } = {}) {
    const f = fixture(repo);
    const source = external ? externalSource(repo) : await managedSource(repo);
    return { f, source, merge: async () => f.act(await f.inspect(source.branch), 'merge') };
  },
  async mergeProjectBranch(repo, { external = false } = {}) {
    const f = fixture(repo);
    const source = external ? externalSource(repo) : await managedSource(repo);
    return {
      f,
      source,
      merge: () => f.api.mergeProjectBranch({ projectPath: repo, branch: source.branch, target: 'main' }),
    };
  },
  async mergeWorkspace(repo, { external = false, autoCleanup = false } = {}) {
    const f = fixture(repo, { session: true, autoCleanup });
    let source;
    if (external) {
      source = externalSource(repo);
      f.state.cwd = source.path;
      f.session.cwd = source.path;
    } else {
      const entered = await f.api.requestWorktree({ provision: true, prompt: 'Merge source', txId: f.session.id });
      source = { path: entered.workspace.cwd, branch: entered.workspace.branch };
    }
    f.state.moves = [];
    return {
      f,
      source,
      merge: (input = {}, options) => f.api.mergeWorkspace({ confirmed: true, target: 'main', ...input }, options),
    };
  },
};

async function managedSource(repo) {
  const created = await createTestWorktree(repo);
  return { path: created.entry.path, branch: created.entry.branch };
}

function externalSource(repo) {
  const path = join(tempDir(), 'external');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/external', path);
  return { path, branch: 'feature/external' };
}

for (const [name, setup] of Object.entries(ENTRY_POINTS)) {
  test(`${name}: a dirty source or one with a Git operation in progress is refused`, async () => {
    const repo = makeRepo();
    const { source, merge } = await setup(repo);
    commitFile(source.path, 'feature.txt', 'feature\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    writeFile(source.path, 'scratch.txt', 'unsaved\n');
    await assert.rejects(merge(), { code: 'WORKTREE_DIRTY' });
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    git(source.path, 'clean', '-q', '-f', '--', 'scratch.txt');
    const marker = git(source.path, 'rev-parse', '--path-format=absolute', '--git-path', 'BISECT_START');
    writeFileSync(marker, 'main\n');
    await assert.rejects(merge(), (error) => {
      assert.equal(error.code, 'WORKTREE_DIRTY');
      assert.equal(error.details.operation, 'bisect');
      return true;
    });
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  });

  test(`${name}: refused while work runs in the source, and both folders wait during the merge`, async () => {
    const repo = makeRepo();
    const { f, source, merge } = await setup(repo);
    commitFile(source.path, 'feature.txt', 'feature\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const leave = tryAdmitWorkspaceActivity('other-process-turn', source.path);
    await assert.rejects(merge(), (error) => {
      assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
      assert.equal(error.details.reason, 'folder-in-use');
      assert.equal(error.message, WORKTREE_REFUSAL_REASONS['folder-in-use']);
      return true;
    });
    leave();
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    let probed = false;
    f.state.probe = () => {
      probed = true;
      assert.equal(tryAdmitWorkspaceActivity('reader', source.path), null, 'the branch folder waits');
      assert.equal(tryAdmitWorkspaceActivity('reader', repo), null, 'the main project waits');
    };
    assert.equal((await merge()).merged, true);
    assert.ok(probed, 'the merge ran under the shared admission');
    assert.equal(git(repo, 'rev-parse', 'HEAD^2'), git(source.path, 'rev-parse', 'HEAD'));
  });

  test(`${name}: an external source is never lock-blocked, but a session running there refuses`, async () => {
    const repo = makeRepo();
    const { f, source, merge } = await setup(repo, { external: true });
    commitFile(source.path, 'external.txt', 'external\n');
    const leave = tryAdmitWorkspaceActivity('external-turn', source.path);
    await assert.rejects(merge(), { code: 'WORKTREE_BUSY_JOBS' });
    leave();
    let probed = false;
    f.state.probe = () => {
      probed = true;
      const reader = tryAdmitWorkspaceActivity('reader', source.path);
      assert.ok(reader, 'the external folder admits new work');
      reader();
      assert.equal(tryAdmitWorkspaceActivity('reader', repo), null, 'the main project waits');
    };
    assert.equal((await merge()).merged, true);
    assert.ok(probed);
  });
}

test('mergeProjectBranch preserves a live foreign turn when its shared ledger is damaged', { timeout: 20000 }, async (t) => {
  const repo = makeRepo();
  const { source, merge } = await ENTRY_POINTS.mergeProjectBranch(repo);
  commitFile(source.path, 'feature.txt', 'feature\n');
  const head = git(repo, 'rev-parse', 'HEAD');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { admitTurn } from ${JSON.stringify(new URL('./admission-gate.mjs', import.meta.url).href)};
        const leave = await admitTurn({ sessionId: 'foreign-turn', cwd: () => process.argv[1] });
        process.on('message', (message) => {
          if (message === 'ping') process.send('alive');
          if (message === 'release') { leave(); process.exit(0); }
        });
        process.send('active');
      `,
      repo,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, MIXDOG_DATA_DIR: tempDir() } }
  );
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  assert.equal((await once(child, 'message'))[0], 'active');
  await assert.rejects(merge(), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'folder-in-use' },
  });

  const path = join(repo, '.git', 'mixdog-workspace-admission.json');
  const intact = readFileSync(path);
  const damaged = Buffer.alloc(intact.length);
  writeFileSync(path, damaged);
  await assert.rejects(merge(), {
    code: 'WORKTREE_BUSY_JOBS',
    details: { reason: 'workspace-admission-unreadable' },
  });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(repo, 'feature.txt')), false);
  assert.deepEqual(readFileSync(path), damaged);
  const alive = once(child, 'message');
  child.send('ping');
  assert.equal((await alive)[0], 'alive');

  // The fixture owns the exact original record; no lease changed while its
  // bytes were damaged. After restoring it, the same child can release normally.
  writeFileSync(path, intact);
  const exited = once(child, 'exit');
  child.send('release');
  assert.deepEqual(await exited, [0, null]);
  assert.equal((await merge()).merged, true);
  assert.equal(git(repo, 'rev-parse', 'HEAD^2'), git(source.path, 'rev-parse', 'HEAD'));
});

test('mergeWorkspace never moves its session: cleanup is refused while the session works in the folder', async () => {
  const repo = makeRepo();
  const { f, source, merge } = await ENTRY_POINTS.mergeWorkspace(repo, { autoCleanup: true });
  commitFile(source.path, 'feature.txt', 'feature\n');
  // The Lead's own tool call: its admitted turn in the worktree is its own.
  const leaveTurn = await admitTurn({ sessionId: f.session.id, cwd: () => f.state.cwd });
  const result = await merge({ cleanup: true }, { ownTurn: true });
  leaveTurn();
  assert.equal(result.merged, true);
  assert.equal(result.cleanup.removed, false);
  assert.equal(result.cleanup.code, 'WORKTREE_BUSY_JOBS');
  assert.equal(result.cleanup.message, WORKTREE_REFUSAL_REASONS['folder-in-use']);
  assert.deepEqual(f.state.moves, [], 'no session was migrated');
  assert.ok(samePath(f.session.cwd, source.path));
  assert.ok(existsSync(source.path));
  // Once the session left on its own, the same cleanup removes the folder and moves nobody.
  await f.api.selectBranch({ branch: 'main' });
  f.state.moves = [];
  commitFile(source.path, 'more.txt', 'more\n');
  const cleaned = await merge({ cleanup: true });
  assert.equal(cleaned.cleanup.removed, true);
  assert.deepEqual(f.state.moves, []);
  assert.equal(existsSync(source.path), false);
});

test('session-less merges never move or rewrite a session using the source folder', async () => {
  for (const name of ['manageProjectBranch', 'mergeProjectBranch']) {
    const repo = makeRepo();
    const { f, source, merge } = await ENTRY_POINTS[name](repo);
    commitFile(source.path, 'feature.txt', 'feature\n');
    const idle = { id: 'idle-user', cwd: source.path, status: 'idle' };
    f.state.stored = [idle];
    assert.equal((await merge()).merged, true);
    assert.deepEqual(idle, { id: 'idle-user', cwd: source.path, status: 'idle' });
    assert.ok(existsSync(source.path));
  }
});

test('merge guards both folders, including idle sessions with background jobs and running workers', async () => {
  const repo = makeRepo();
  const created = await createTestWorktree(repo);
  commitFile(created.entry.path, 'feature.txt', 'feature\n');
  writeFile(created.entry.path, '.mixdog/project.id', 'managed-identity\n');
  const f = fixture(repo);
  const view = await f.inspect(created.entry.branch);
  const head = git(repo, 'rev-parse', 'HEAD');
  for (const cwd of [repo, created.entry.path]) {
    f.state.stored = [{ id: 'idle', cwd, status: 'idle' }];
    f.state.jobs = [{ cwd, terminal: false }];
    await assert.rejects(f.act(view, 'merge'), { code: 'WORKTREE_BUSY_JOBS' });
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  }
  f.state.jobs = [];
  f.state.stored = [];
  f.state.live = [{ id: 'worker', cwd: created.entry.path, status: 'tool_running' }];
  await assert.rejects(f.act(view, 'merge'), { code: 'WORKTREE_BUSY_JOBS' });
  f.state.live = [];
  assert.equal((await f.act(view, 'merge')).merged, true);
  assert.equal(git(repo, 'rev-parse', 'HEAD^2'), view.commit);
  assert.ok(existsSync(created.entry.path), 'merging never removes the source folder');
});

test('folder-only cleanup refuses retained users, preserves the branch, and branch deletion is separate', async () => {
  const repo = makeRepo();
  const created = await createTestWorktree(repo);
  await releaseWorktreeOwner(created.entry.id, created);
  const f = fixture(repo);
  const view = await f.inspect(created.entry.branch);
  f.state.stored = [{ id: created.sessionId, cwd: created.entry.path, status: 'idle' }];
  await assert.rejects(f.act(view, 'remove-worktree'), { code: 'WORKTREE_BUSY_JOBS' });
  assert.ok(existsSync(created.entry.path));
  f.state.stored = [];
  assert.equal((await f.act(view, 'remove-worktree')).removed, true);
  assert.equal(existsSync(created.entry.path), false);
  assert.equal(git(repo, 'rev-parse', view.branch), view.commit);
  assert.equal((await f.act(await f.inspect(view.branch), 'delete-branch')).deleted, true);
});

test('stale confirmations, unmerged commits, dirty worktrees and main/external folders cannot be removed', async () => {
  const repo = makeRepo();
  const f = fixture(repo);
  git(repo, 'checkout', '-q', '-b', 'feature/unmerged');
  commitFile(repo, 'unmerged.txt', 'keep\n');
  git(repo, 'checkout', '-q', 'main');
  const unmerged = await f.inspect('feature/unmerged');
  await assert.rejects(f.act(unmerged, 'delete-branch'), { code: 'WORKTREE_UNMERGED' });
  await assert.rejects(f.act({ ...unmerged, commit: '0'.repeat(40) }, 'merge'), { code: 'WORKTREE_REVISION_CONFLICT' });
  await assert.rejects(f.act(await f.inspect('main'), 'remove-worktree'), { code: 'WORKTREE_PATH_UNSAFE' });
  const external = tempDir();
  git(repo, 'worktree', 'add', '-b', 'feature/external', external);
  await assert.rejects(f.act(await f.inspect('feature/external'), 'remove-worktree'), { code: 'WORKTREE_PATH_UNSAFE' });
  await assert.rejects(f.act(await f.inspect('feature/external'), 'delete-branch'), {
    code: 'WORKTREE_BRANCH_OCCUPIED',
  });
  const created = await createTestWorktree(repo);
  await releaseWorktreeOwner(created.entry.id, created);
  writeFile(created.entry.path, 'untracked.txt', 'keep\n');
  await assert.rejects(f.act(await f.inspect(created.entry.branch), 'remove-worktree'), { code: 'WORKTREE_DIRTY' });
  assert.ok(existsSync(created.entry.path));
});

test('unreadable usage refuses mutations rather than assuming no work', async () => {
  const repo = makeRepo();
  const f = fixture(repo);
  git(repo, 'branch', 'feature/merged');
  const view = await f.inspect('feature/merged');
  f.state.jobs = null;
  await assert.rejects(f.act(view, 'delete-branch'));
  assert.equal(git(repo, 'rev-parse', view.branch), view.commit);
});
