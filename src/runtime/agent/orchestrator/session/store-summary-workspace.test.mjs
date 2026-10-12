import assert from 'node:assert/strict';
import test from 'node:test';

import { _normalizeSummaryIndex, _sessionSummary } from './store-summary-index.mjs';
import { workspaceSummary } from './store-summary-fields.mjs';

const WORKTREE = 'C:/data/worktrees-v1/0123456789abcdef/fix-login';
const workspace = {
  projectPath: 'C:/repo',
  repoCommonDir: 'C:/repo/.git',
  cwd: WORKTREE,
  worktreeId: 'fix-login',
  branch: 'mixdog/fix-login',
  baseCommit: null,
  mergeTarget: 'main',
  revision: 3,
  transition: { state: 'idle', txId: null },
};

function session(extra = {}) {
  return {
    id: 'sess_ws',
    createdAt: 1_000,
    updatedAt: 2_000,
    lastUsedAt: 2_000,
    status: 'idle',
    owner: 'user',
    cwd: WORKTREE,
    desktopSession: { classification: 'project', projectPath: 'C:/repo' },
    messages: [{ role: 'user', content: 'prompt' }],
    ...extra,
  };
}

const projectFolder = {
  projectPath: 'C:/repo',
  repoCommonDir: null,
  cwd: 'C:/repo',
  worktreeId: null,
  branch: null,
  baseCommit: null,
  mergeTarget: null,
  revision: 0,
  transition: { state: 'idle', txId: null },
};

test('workspaceSummary carries the whole workspace record and requires both paths', () => {
  assert.deepEqual(workspaceSummary(workspace), workspace);
  assert.deepEqual(workspaceSummary({ projectPath: ' C:/repo ', cwd: 'C:/repo' }), projectFolder);
  assert.deepEqual(
    workspaceSummary({ projectPath: 'C:/repo', cwd: 'C:/repo', revision: -1, transition: { state: 'bogus' } }),
    projectFolder
  );
  for (const bad of [null, 'x', {}, { projectPath: 'C:/repo' }, { cwd: 'C:/repo' }, { projectPath: 'a\0', cwd: 'b' }]) {
    assert.equal(workspaceSummary(bad), null);
  }
});

test('summary rows expose the workspace while grouping stays on the project', () => {
  const summary = _sessionSummary(session({ workspace }));
  assert.deepEqual(summary.workspace, workspace);
  assert.equal(summary.cwd, WORKTREE);
  assert.equal(summary.desktopSession.projectPath, 'C:/repo');
  const [normalized] = _normalizeSummaryIndex({ rows: [summary] }).rows;
  assert.deepEqual(normalized.workspace, summary.workspace);
});

test('a session without a workspace record has no workspace field', () => {
  assert.equal('workspace' in _sessionSummary(session()), false);
});
