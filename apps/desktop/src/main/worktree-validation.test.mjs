import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_CAPABILITIES,
  DESKTOP_READ_CAPABILITIES,
  DESKTOP_WORKTREE_CAPABILITIES,
  DESKTOP_WORKTREE_ERROR_CODES,
  DESKTOP_WORKTREE_NEW_TASK_DEFAULTS,
} from '../shared/contract.ts';
import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation.ts';
import { worktreeErrorWithCode } from './worktree-validation.ts';
import { WORKTREE_ERROR_CODES } from '../../../../src/runtime/shared/worktrees/contract.mjs';
import {
  WORKTREE_NEW_TASK_DEFAULTS,
  WORKTREE_SETTINGS_DEFAULTS,
} from '../../../../src/runtime/shared/worktrees/settings.mjs';
import { SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';
import { createSessionWorktreeApi } from '../../../../src/tui/session/session-api/worktree.mjs';

const request = (capability, ...args) => requiredDesktopCapabilityRequest({ capability, args });

test('worktree capabilities are registered on the desktop surface and the session protocol', () => {
  const sessionActions = new Set([...SESSION_READ_ACTIONS, ...SESSION_CONFIGURE_ACTIONS]);
  for (const capability of DESKTOP_WORKTREE_CAPABILITIES) {
    assert.ok(DESKTOP_CAPABILITIES.includes(capability), capability);
    assert.ok(sessionActions.has(capability), `${capability} is not a session action`);
  }
  for (const capability of ['getBranchMenu', 'getProjectBranchMenu', 'listWorktrees', 'getWorktreeSettings']) {
    assert.ok(DESKTOP_READ_CAPABILITIES.includes(capability));
    assert.ok(SESSION_READ_ACTIONS.includes(capability));
  }
  assert.equal(requiredDesktopCapabilityReadRequests([{ capability: 'getBranchMenu' }]).length, 1);
});

test('desktop mirrors match the runtime contract', () => {
  assert.deepEqual([...DESKTOP_WORKTREE_ERROR_CODES].sort(), Object.keys(WORKTREE_ERROR_CODES).sort());
  assert.deepEqual([...DESKTOP_WORKTREE_NEW_TASK_DEFAULTS], [...WORKTREE_NEW_TASK_DEFAULTS]);
  assert.deepEqual(Object.keys(WORKTREE_SETTINGS_DEFAULTS).sort(), [
    'autoCleanup',
    'branchPrefix',
    'newTaskDefault',
    'sizeWarnBytes',
  ]);
});

test('worktree capability arguments are shape-checked', () => {
  assert.doesNotThrow(() => request('getBranchMenu'));
  assert.doesNotThrow(() => request('selectBranch', { branch: 'main', expectedRevision: 3 }));
  assert.doesNotThrow(() => request('selectBranch', { branch: 'feature/x', create: true }));
  assert.doesNotThrow(() => request('requestWorktree'));
  assert.doesNotThrow(() => request('requestWorktree', { name: null }));
  assert.doesNotThrow(() => request('requestWorktree', { expectedRevision: 0, confirmLarge: true }));
  assert.doesNotThrow(() => request('requestWorktree', { provision: true }));
  assert.doesNotThrow(() => request('requestWorktree', { provision: true, carryChanges: 'carry' }));
  assert.doesNotThrow(() => request('requestWorktree', { provision: true, carryChanges: 'leave' }));
  assert.doesNotThrow(() => request('selectBranch', { branch: 'mixdog/fix', confirmLarge: true }));
  assert.doesNotThrow(() => request('mergeWorkspace', { confirmed: true, target: 'main' }));
  assert.doesNotThrow(() => request('removeWorktree', { force: false }));
  assert.doesNotThrow(() => request('setWorktreeSettings', { newTaskDefault: 'worktree', sizeWarnBytes: 0 }));
  assert.doesNotThrow(() => request('getProjectBranchMenu', { projectPath: '/p' }));
  assert.doesNotThrow(() => request('selectProjectBranch', { projectPath: '/p', branch: 'dev' }));
  assert.doesNotThrow(() => request('selectProjectBranch', { projectPath: '/p', branch: 'feature/x', create: true }));
  assert.doesNotThrow(() => request('selectProjectBranch', { projectPath: '/p', branch: 'origin/x', remote: true }));
  assert.doesNotThrow(() => request('mergeProjectBranch', { projectPath: '/p', branch: 'dev', target: 'main' }));
  assert.doesNotThrow(() =>
    request('selectProjectBranch', { projectPath: '/p', branch: 'from-history', create: true, startPoint: 'abc1234' })
  );
  assert.doesNotThrow(() => request('selectProjectBranch', { projectPath: '/p', detach: 'a'.repeat(40) }));
  assert.doesNotThrow(() => request('mergeWorkspace', { confirmed: true, target: 'main', cleanup: true }));
  assert.doesNotThrow(() => request('listWorktrees'));
  assert.doesNotThrow(() => request('pruneWorktrees'));
  for (const input of [
    { projectPath: '/p', branch: 'origin/x', remote: 'yes' },
    { projectPath: '/p', branch: 'origin/x', remote: true, create: true },
  ]) {
    assert.throws(() => request('selectProjectBranch', input), TypeError);
  }
  for (const [capability, ...args] of [
    ['getBranchMenu', {}],
    ['getProjectBranchMenu'],
    ['getProjectBranchMenu', { projectPath: '' }],
    ['getProjectBranchMenu', { projectPath: '/p', sessionId: 's' }],
    ['selectProjectBranch', { projectPath: '/p' }],
    ['selectProjectBranch', { branch: 'dev' }],
    ['selectProjectBranch', { projectPath: '/p', branch: 'dev', create: 'yes' }],
    ['selectProjectBranch', { projectPath: '/p', branch: 'dev', expectedRevision: 0 }],
    ['selectProjectBranch', { projectPath: '/p', branch: 'dev', startPoint: 'abc1234' }],
    ['selectProjectBranch', { projectPath: '/p', branch: 'dev', create: true, startPoint: '--force' }],
    ['selectProjectBranch', { projectPath: '/p', branch: 'dev', create: true, startPoint: 'main' }],
    ['selectProjectBranch', { projectPath: '/p', detach: '--detach' }],
    ['selectProjectBranch', { projectPath: '/p', detach: 'main' }],
    ['selectProjectBranch', { projectPath: '/p', detach: 'abc1234', branch: 'main' }],
    ['selectProjectBranch', { projectPath: '/p', detach: 'abc1234', create: true }],
    ['selectProjectBranch', { projectPath: '/p', detach: 'abc1234', startPoint: 'abc1234' }],
    ['selectBranch'],
    ['selectBranch', { branch: '' }],
    ['selectBranch', { branch: 'main', cwd: '/elsewhere' }],
    ['selectBranch', { branch: 'main', expectedRevision: -1 }],
    ['requestWorktree', 'name'],
    ['requestWorktree', { name: 3 }],
    ['requestWorktree', { confirmLarge: 'yes' }],
    ['requestWorktree', { provision: 'yes' }],
    ['requestWorktree', { provision: true, carryChanges: 'stash' }],
    ['requestWorktree', { provision: true, prompt: 'p', txId: 't' }],
    ['selectBranch', { branch: 'main', confirmLarge: 1 }],
    ['mergeWorkspace', { target: 'main' }],
    ['mergeWorkspace', { confirmed: true }],
    ['mergeWorkspace', { confirmed: true, target: 'main', cleanup: 'yes' }],
    ['mergeProjectBranch', { projectPath: '/p', branch: 'dev' }],
    ['mergeProjectBranch', { projectPath: '/p', target: 'main' }],
    ['mergeProjectBranch', { branch: 'dev', target: 'main' }],
    ['mergeProjectBranch', { projectPath: '/p', branch: 'dev', target: 'main', confirmed: true }],
    ['listWorktrees', {}],
    ['pruneWorktrees', { force: true }],
    ['removeWorktree', { force: 'yes' }],
    ['setWorktreeSettings', {}],
    ['setWorktreeSettings', { newTaskDefault: 'on' }],
    ['setWorktreeSettings', { sizeWarnBytes: 1.5 }],
    ['setWorktreeSettings', { autoCleanup: 1 }],
    ['setWorktreeSettings', { unknown: true }],
  ]) {
    assert.throws(() => request(capability, ...args), TypeError, `${capability} ${JSON.stringify(args)}`);
  }
});

test('a typed worktree failure keeps its code at the head of the message across IPC', () => {
  const typed = Object.assign(new Error('The repository is large.'), {
    code: 'WORKTREE_LARGE_REPO_CONFIRM',
    details: { estimateBytes: 5 },
  });
  const coded = worktreeErrorWithCode(typed);
  assert.equal(
    coded.message,
    'WORKTREE_LARGE_REPO_CONFIRM: The repository is large.\n[worktree-details] {"estimateBytes":5}'
  );
  assert.equal(coded.code, 'WORKTREE_LARGE_REPO_CONFIRM');
  assert.deepEqual(coded.details, { estimateBytes: 5 });
  assert.equal(worktreeErrorWithCode(coded), coded, 'an already coded message is unchanged');
  const bare = Object.assign(new Error('Project is not available.'), { code: 'WORKTREE_PROJECT_UNKNOWN' });
  assert.equal(worktreeErrorWithCode(bare).message, 'WORKTREE_PROJECT_UNKNOWN: Project is not available.');
  const other = Object.assign(new Error('nope'), { code: 'ENOENT' });
  assert.equal(worktreeErrorWithCode(other), other);
});

test('session worktree actions reject with the typed not-implemented error on a runtime without the workspace authority', async () => {
  const api = createSessionWorktreeApi();
  for (const action of [
    'getBranchMenu',
    'getProjectBranchMenu',
    'selectBranch',
    'selectProjectBranch',
    'requestWorktree',
    'mergeWorkspace',
    'removeWorktree',
  ]) {
    await assert.rejects(api[action]({}), (error) => {
      assert.equal(error.code, 'WORKTREE_NOT_IMPLEMENTED');
      assert.match(error.message, new RegExp(`${action} is not implemented`));
      return true;
    });
  }
});
