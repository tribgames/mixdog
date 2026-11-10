import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCliInvocation } from './headless-command.mjs';

test('--worktree [name] and --no-worktree become session creation options', () => {
  assert.equal(Object.hasOwn(classifyCliInvocation([]).options, 'worktree'), false);
  assert.deepEqual(classifyCliInvocation(['--worktree']).options.worktree, { mode: 'worktree', name: null });
  assert.deepEqual(classifyCliInvocation(['--worktree', 'fix-login']).options.worktree, {
    mode: 'worktree',
    name: 'fix-login',
  });
  assert.deepEqual(classifyCliInvocation(['--worktree=fix-login', '--fast']).options.worktree, {
    mode: 'worktree',
    name: 'fix-login',
  });
  const followed = classifyCliInvocation(['--worktree', '--model', 'm']);
  assert.equal(followed.kind, 'general');
  assert.deepEqual(followed.options.worktree, { mode: 'worktree', name: null });
  assert.equal(followed.options.model, 'm');
  assert.deepEqual(classifyCliInvocation(['--no-worktree']).options.worktree, { mode: 'branch' });
});

test('invalid or conflicting worktree options are rejected', () => {
  assert.match(classifyCliInvocation(['--worktree', 'a..b']).error, /--worktree name "a\.\.b" is invalid/);
  assert.match(classifyCliInvocation(['--worktree=']).error, /--worktree name "" is invalid/);
  assert.match(classifyCliInvocation(['--worktree', '--no-worktree']).error, /mutually exclusive/);
});

test('headless exec does not accept worktree options', () => {
  for (const argv of [
    ['--worktree', 'exec', '--provider', 'p', '--model', 'm', 'hello'],
    ['--worktree=wt', 'exec', 'hello'],
    ['--no-worktree', 'exec', 'hello'],
  ]) {
    const invocation = classifyCliInvocation(argv);
    assert.equal(invocation.kind, 'error', argv.join(' '));
    assert.match(invocation.error, /--(no-)?worktree is not supported for mixdog exec/);
  }
});
