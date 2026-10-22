import assert from 'node:assert/strict';
import test from 'node:test';
import { toolActivitySubject } from './transcript-tool-format';

test('a browser row drops the scheme and www from its subject', () => {
  assert.equal(toolActivitySubject('browser', {}, 'open · https://www.example.com/path'), 'open · example.com/path');
  assert.equal(toolActivitySubject('browser_devtools', {}, 'http://example.com'), 'example.com');
  assert.equal(toolActivitySubject('browser', {}, 'open · example.com'), 'open · example.com');
});

test('a session row labels each action', () => {
  const subject = (args) => toolActivitySubject('session', args, 'fallback');
  assert.equal(subject({ action: 'rename', title: 'Fix login' }), 'Rename session: Fix login');
  assert.equal(subject({ action: 'fork' }), 'Fork into new session');
  assert.equal(subject({ action: 'set-project', path: 'C:\\repo' }), 'C:\\repo');
  assert.equal(subject({}), 'fallback');
});

test('the session tool no longer labels worktree actions', () => {
  const subject = (args) => toolActivitySubject('session', args, 'fallback');
  assert.notEqual(subject({ action: 'list-worktrees' }), 'List worktrees');
  assert.notEqual(subject({ action: 'merge-worktree' }), 'Merge worktree');
});

test('a git worktree row is labelled by its worktree_action', () => {
  const subject = (args) => toolActivitySubject('git', { action: 'worktree', ...args }, 'fallback');
  assert.equal(subject({ worktree_action: 'enter' }), 'Enter worktree');
  assert.equal(subject({ worktree_action: 'return' }), 'Return to project folder');
  assert.equal(subject({ worktree_action: 'merge', session_id: 'sess_1' }), 'Merge worktree');
  assert.equal(subject({ worktree_action: 'remove' }), 'Remove worktree');
  assert.equal(subject({ worktree_action: 'list' }), 'List worktrees');
  assert.equal(subject({ worktree_action: 'prune' }), 'Prune worktrees');
});
