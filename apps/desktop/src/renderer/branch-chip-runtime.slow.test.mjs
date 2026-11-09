import assert from 'node:assert/strict';
import test from 'node:test';

const model = await import('./worktree-branch-model.ts');

test('the runtime getBranchMenu response feeds the renderer model: rows, marks and search', () => {
  // The response Node b6f10295a's createWorkspaceTransitions().getBranchMenu() gave for a repository with one commit on main and the
  // occupancy below (recorded; the project folder is a placeholder, `dev` was committed yesterday).
  const project = '/work/branch-chip-menu';
  const menu = {
    workspace: {
      projectPath: project,
      repoCommonDir: `${project}/.git`,
      cwd: project,
      worktreeId: null,
      branch: 'main',
      baseCommit: null,
      mergeTarget: null,
      revision: 0,
      transition: { state: 'idle', txId: null },
    },
    pendingWorktree: null,
    branches: [
      { name: 'main', current: true, remote: false, upstream: '' },
      { name: 'dev', current: false, remote: false, upstream: '', lastCommitAt: new Date(Date.now() - 86_400_000).toISOString() },
      { name: 'feat/ssh-remote', current: false, remote: false, upstream: '' },
      { name: 'ext-branch', current: false, remote: false, upstream: '' },
    ],
    occupancy: [
      { branch: 'main', kind: 'current', path: project },
      { branch: 'dev', kind: 'free' },
      { branch: 'feat/ssh-remote', kind: 'session', sessionId: 'other-session', path: '/wt/ssh' },
      { branch: 'ext-branch', kind: 'external', path: '/elsewhere' },
    ],
    retainedWorktree: null,
    warnings: [],
  };
  assert.deepEqual(
    model.branchRows(menu, 'lead-1', '').map((row) => [row.name, row.mark, row.group]),
    [
      ['main', 'current', 'current'],
      ['feat/ssh-remote', 'inUse', 'worktree'],
      ['dev', '', 'recent'],
      ['ext-branch', 'external', 'external'],
    ],
    'the commit time reaches the renderer: dev, committed yesterday, is recent'
  );
  assert.deepEqual(
    model.branchRows(menu, 'lead-1', 'SSH').map((row) => row.name),
    ['feat/ssh-remote']
  );
});
