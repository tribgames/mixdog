import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const model = await import('./worktree-branch-model.ts');

test('the runtime getBranchMenu response feeds the renderer model: rows, marks and search', async (t) => {
  const { createWorkspaceTransitions } = await import('../../../../src/session-runtime/workspace/transitions.mjs');
  // The runtime reads the project folder's repository, so the menu is read
  // for a real git repository with one commit on main.
  const project = mkdtempSync(join(tmpdir(), 'branch-chip-menu-'));
  const git = (...args) => execFileSync('git', ['-C', project, ...args]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = { id: 'lead-1', cwd: project, desktopSession: { classification: 'project', projectPath: project } };
  const api = createWorkspaceTransitions({
    getSession: () => session,
    getCurrentCwd: () => project,
    getActiveTurnCount: () => 0,
    // The manager's listBranchOccupancy shape: local branch NAMES plus occupancy rows.
    manager: {
      async listBranchOccupancy() {
        return {
          branches: ['main', 'dev', 'feat/ssh-remote', 'ext-branch'],
          occupancy: [
            { branch: 'main', kind: 'current', path: project },
            { branch: 'dev', kind: 'free' },
            { branch: 'feat/ssh-remote', kind: 'session', sessionId: 'other-session', path: '/wt/ssh' },
            { branch: 'ext-branch', kind: 'external', path: '/elsewhere' },
          ],
          retainedWorktree: null,
        };
      },
    },
  });
  const menu = await api.getBranchMenu();
  menu.workspace.branch = 'main';
  assert.deepEqual(
    model.branchRows(menu, 'lead-1', '').map((row) => [row.name, row.mark]),
    [
      ['main', 'current'],
      ['dev', ''],
      ['feat/ssh-remote', 'inUse'],
      ['ext-branch', 'external'],
    ]
  );
  assert.deepEqual(
    model.branchRows(menu, 'lead-1', 'SSH').map((row) => row.name),
    ['feat/ssh-remote']
  );
});
