// End to end against real git and the managed-worktree backend: a worktree
// task provisions on its first turn (memory identity carried over), a project
// branch returns to the project folder keeping the worktree, the retained
// branch re-enters it, and removal returns first, then deletes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { configureWorktreeManager, withWorktreeRecoveryStore } from '../../runtime/shared/worktrees/manager.mjs';
import { samePath } from '../../runtime/shared/worktrees/paths.mjs';
import {
  cleanupTempDirs,
  commitFile,
  git,
  makeRepo,
  tempDir,
  useTempDataDir,
  writeFile,
} from '../../runtime/shared/worktrees/test-support.mjs';
import { createWorkspaceTransitions } from './transitions.mjs';
import { workspaceCwdLock } from './admission-gate.mjs';

after(() => cleanupTempDirs());

test('lazy provisioning, branch return, re-entry and removal against a real repository', async () => {
  useTempDataDir();
  const restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
  try {
    const repo = makeRepo();
    commitFile(repo, '.gitignore', '.mixdog/\n');
    writeFile(repo, '.mixdog/project.id', `git-e2e-${process.pid}\n`);
    git(repo, 'branch', 'dev');
    const session = {
      id: `sess_git_${process.pid}`,
      cwd: repo,
      desktopSession: { classification: 'project', projectPath: repo },
      messages: [],
    };
    let cwd = repo;
    const refreshed = [];
    const api = createWorkspaceTransitions({
      getSession: () => session,
      getCurrentCwd: () => cwd,
      applyResolvedCwd: (next) => {
        cwd = next;
        session.cwd = next;
      },
      persistSession: () => {},
      refreshWorkspaceContext: async (_session, next) => refreshed.push(next),
      getActiveTurnCount: () => 0,
      agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
      countOwnShellJobs: async () => 0,
      listLiveSessions: () => [],
      findRegisteredProject: async (path) => (samePath(path, repo) ? repo : null),
      initialIntent: { mode: 'worktree', name: null },
    });

    const first = await api.prepareTurnWorkspace({ submissionId: 'sub-git-1', prompt: 'Fix the login page' });
    const worktree = first.workspace.cwd;
    assert.equal(first.workspace.branch, 'mixdog/fix-the-login-page');
    assert.equal(first.workspace.mergeTarget, 'main');
    assert.ok(existsSync(worktree));
    assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), 'mixdog/fix-the-login-page');
    assert.equal(readFileSync(join(worktree, '.mixdog', 'project.id'), 'utf8').trim(), `git-e2e-${process.pid}`);
    assert.ok(samePath(workspaceCwdLock([session.id]), worktree));
    assert.equal(session.desktopSession.projectPath, repo);

    const back = await api.selectBranch({ branch: 'dev', expectedRevision: first.revision });
    assert.notEqual(back.workspace.cwd, repo);
    assert.equal(git(back.workspace.cwd, 'symbolic-ref', '--short', 'HEAD'), 'dev');
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.ok(existsSync(worktree), 'the worktree stays retained');

    const menu = await api.getBranchMenu();
    assert.equal(
      menu.retainedWorktree.branch,
      'dev',
      'actions target the selected checkout, not the first created one'
    );
    assert.equal(menu.occupancy.find((row) => row.branch === 'dev').kind, 'session');
    assert.equal(menu.occupancy.find((row) => row.branch === 'mixdog/fix-the-login-page').kind, 'session');
    assert.deepEqual(
      menu.branches.find((row) => row.name === 'dev'),
      { name: 'dev', current: false, remote: false, upstream: '' },
      'branch rows carry the DesktopGitBranch shape'
    );

    // The session-less (draft) menu and checkout read and guard the same folder.
    const projectMenu = await api.getProjectBranchMenu({ projectPath: repo });
    assert.equal(projectMenu.workspace.branch, 'main');
    assert.equal(projectMenu.retainedWorktree, null);
    await assert.rejects(api.getProjectBranchMenu({ projectPath: join(repo, '..') }), {
      code: 'WORKTREE_PROJECT_UNKNOWN',
    });
    assert.equal(projectMenu.occupancy.find((row) => row.branch === 'mixdog/fix-the-login-page').kind, 'session');
    writeFile(repo, 'README.md', 'edited\n');
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'edited\n');
    git(repo, 'checkout', '-q', '--', 'README.md');

    const again = await api.selectBranch({ branch: 'mixdog/fix-the-login-page' });
    assert.ok(samePath(again.workspace.cwd, worktree));
    assert.equal(again.revision, back.revision + 1);

    const removed = await api.removeWorktree({});
    assert.equal(removed.workspace.cwd, repo);
    assert.equal(removed.removed.removed, true);
    assert.equal(existsSync(worktree), false);
    assert.deepEqual(refreshed.length, 4, 'every committed revision re-rooted the prompt');
  } finally {
    restore();
  }
});

function realApi(session, projects, cwdRef) {
  return createWorkspaceTransitions({
    getSession: () => session,
    getCurrentCwd: () => cwdRef.cwd,
    applyResolvedCwd: (next) => {
      cwdRef.cwd = next;
      session.cwd = next;
    },
    persistSession: () => {},
    refreshWorkspaceContext: async () => {},
    getActiveTurnCount: () => 0,
    agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
    countOwnShellJobs: async () => 0,
    listLiveSessions: () => [],
    findRegisteredProject: async (path) => projects.find((project) => samePath(project, path)) ?? null,
  });
}

test('two repositories: a worktree retained from repository A is never merged into Project B', async () => {
  useTempDataDir();
  const restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
  try {
    const repoA = makeRepo();
    const repoB = makeRepo();
    commitFile(repoB, 'b.txt', 'b\n');
    const session = {
      id: `sess_two_${process.pid}`,
      cwd: repoA,
      desktopSession: { classification: 'project', projectPath: repoA },
      messages: [],
    };
    const cwdRef = { cwd: repoA };
    const api = realApi(session, [repoA, repoB], cwdRef);
    const entered = await api.requestWorktree({ provision: true, prompt: 'Work in A', txId: 'two-repos' });
    commitFile(entered.workspace.cwd, 'a-feature.txt', 'feature\n');
    // Back to A's folder, then the Project switches to B (the session keeps its worktree of A).
    await api.selectBranch({ branch: 'main' });
    session.desktopSession = { classification: 'project', projectPath: repoB };
    session.cwd = repoB;
    cwdRef.cwd = repoB;
    delete session.workspace;
    const headA = git(repoA, 'rev-parse', 'HEAD');
    const headB = git(repoB, 'rev-parse', 'HEAD');
    await assert.rejects(api.mergeWorkspace({ confirmed: true, target: 'main' }), {
      code: 'WORKTREE_PROJECT_MISMATCH',
    });
    assert.equal(git(repoA, 'rev-parse', 'HEAD'), headA);
    assert.equal(git(repoB, 'rev-parse', 'HEAD'), headB);
    assert.equal(existsSync(join(repoB, 'a-feature.txt')), false);
  } finally {
    restore();
  }
});

test('a live session moves into a new worktree: the dirty choice first, then its changes carried along', async () => {
  useTempDataDir();
  const restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
  try {
    const repo = makeRepo();
    commitFile(repo, '.gitignore', '.mixdog/\n');
    writeFile(repo, '.mixdog/project.id', `git-move-${process.pid}\n`);
    writeFile(repo, 'README.md', 'edited\n');
    writeFile(repo, 'src/new.js', 'export {};\n');
    const session = {
      id: `sess_move_${process.pid}`,
      cwd: repo,
      desktopSession: { classification: 'project', projectPath: repo },
      messages: [],
    };
    const cwdRef = { cwd: repo };
    const moves = [];
    const api = createWorkspaceTransitions({
      getSession: () => session,
      getCurrentCwd: () => cwdRef.cwd,
      applyResolvedCwd: (next) => {
        cwdRef.cwd = next;
        session.cwd = next;
      },
      persistSession: () => {},
      refreshWorkspaceContext: async (_session, _cwd, move) => moves.push(move),
      getActiveTurnCount: () => 0,
      agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
      countOwnShellJobs: async () => 0,
      listLiveSessions: () => [],
      findRegisteredProject: async (path) => (samePath(path, repo) ? repo : null),
    });
    await assert.rejects(api.requestWorktree({ provision: true }), (error) => {
      assert.equal(error.code, 'WORKTREE_DIRTY_CHOICE');
      assert.deepEqual(error.details, { count: 2, paths: ['README.md', 'src/new.js'] });
      return true;
    });
    assert.equal(session.cwd, repo, 'the session stays until the user decides');
    const moved = await api.requestWorktree({ provision: true, carryChanges: 'carry' });
    const worktree = moved.workspace.cwd;
    assert.deepEqual(moved.changes, { mode: 'carried', count: 2 });
    assert.ok(samePath(session.cwd, worktree));
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the project folder is clean');
    assert.equal(readFileSync(join(repo, '.mixdog', 'project.id'), 'utf8').trim(), `git-move-${process.pid}`);
    assert.equal(readFileSync(join(worktree, 'README.md'), 'utf8'), 'edited\n');
    assert.equal(readFileSync(join(worktree, 'src', 'new.js'), 'utf8'), 'export {};\n');
    assert.deepEqual(moves, [{ from: repo, changes: 'carried' }]);
    assert.equal(git(repo, 'for-each-ref', 'refs/mixdog/carry/'), '', 'the committed move dropped its recovery ref');
  } finally {
    restore();
  }
});

test('merged, cleanup refused while the session still uses the worktree: it, its records and the session stay', async () => {
  useTempDataDir();
  const restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
  try {
    const repo = makeRepo();
    const session = {
      id: `sess_recovery_${process.pid}`,
      cwd: repo,
      desktopSession: { classification: 'project', projectPath: repo },
      messages: [],
    };
    let cwd = repo;
    const api = createWorkspaceTransitions({
      getSession: () => session,
      getCurrentCwd: () => cwd,
      getConfig: () => ({ worktree: { autoCleanup: true } }),
      applyResolvedCwd: (next) => {
        cwd = next;
        session.cwd = next;
      },
      persistSession: () => {},
      refreshWorkspaceContext: async () => {},
      getActiveTurnCount: () => 0,
      agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
      countOwnShellJobs: async () => 0,
      listLiveSessions: () => [],
      findRegisteredProject: async (path) => (samePath(path, repo) ? repo : null),
    });
    const entered = await api.requestWorktree({ provision: true, prompt: 'Recover edits', txId: 'merge-recovery' });
    const worktree = entered.workspace.cwd;
    commitFile(worktree, 'feature.txt', 'feature\n');
    // An interrupted editor batch left a retained journal for this worktree.
    const store = join(
      tempDir('mixdog-recovery-profile-'),
      'editor-recovery',
      createHash('sha256').update(resolve(worktree)).digest('hex')
    );
    await withWorktreeRecoveryStore(worktree, store, 'write', async () => {
      mkdirSync(join(store, 'record'), { recursive: true });
      writeFileSync(join(store, 'record', 'manifest.json'), 'retained');
    });

    const result = await api.mergeWorkspace({ confirmed: true, target: 'main', cleanup: true });
    assert.equal(result.merged, true, 'the merge is reported as a success');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), result.commit);
    assert.equal(readFileSync(join(repo, 'feature.txt'), 'utf8'), 'feature\n');
    assert.equal(result.cleanup.removed, false);
    assert.equal(result.cleanup.reason, 'WORKTREE_BUSY_JOBS', 'no session is moved off a folder to clean it');
    assert.ok(existsSync(worktree), 'the worktree is kept');
    assert.ok(samePath(cwd, worktree), 'the session stays in its worktree');
    assert.equal(readFileSync(join(store, 'record', 'manifest.json'), 'utf8'), 'retained');
  } finally {
    restore();
  }
});

test('the dock merge goes through the runtime: registered Project, confirmed target, --no-ff', async () => {
  useTempDataDir();
  const restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
  try {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    const tip = commitFile(repo, 'feature.txt', 'feature\n');
    git(repo, 'checkout', '-q', 'main');
    const api = realApi({ id: '' }, [repo], { cwd: repo });
    await assert.rejects(api.mergeProjectBranch({ projectPath: join(repo, '..'), branch: 'feature', target: 'main' }), {
      code: 'WORKTREE_PROJECT_UNKNOWN',
    });
    await assert.rejects(api.mergeProjectBranch({ projectPath: repo, branch: 'feature', target: 'release' }), {
      code: 'WORKTREE_TARGET_MISMATCH',
    });
    const merged = await api.mergeProjectBranch({ projectPath: repo, branch: 'feature', target: 'main' });
    assert.equal(merged.merged, true);
    assert.equal(git(repo, 'rev-parse', 'HEAD^2'), tip);
    assert.equal(merged.commit, git(repo, 'rev-parse', 'HEAD'));
  } finally {
    restore();
  }
});
