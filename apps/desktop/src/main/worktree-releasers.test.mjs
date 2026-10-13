// Path-bound handles a managed worktree removal releases first: desktop
// terminals and the language servers rooted inside the worktree.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { registerWorktreeTerminalReleaser } from './desktop-service.ts';
import { LanguageServerManager } from './language-server-manager.ts';
import { createRootCleanupRegistry } from '../../../../src/runtime/shared/worktrees/contract.mjs';

test('a worktree removal disposes the terminals and stops the language servers under it', async () => {
  const registry = createRootCleanupRegistry();
  const released = [];
  const unregister = await registerWorktreeTerminalReleaser(
    { loadWorktrees: async () => ({ registerRootReleaser: (name, fn) => registry.register(name, fn) }) },
    (root) => released.push(['terminals', root]),
    (root) => released.push(['language-servers', root])
  );
  const root = join('/data', 'worktrees-v1', 'abc', 'fix');
  const results = await registry.run(root, { reason: 'worktree-removed' });
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(released, [
    ['terminals', root],
    ['language-servers', root],
  ]);
  unregister();
  released.length = 0;
  await registry.run(root, { reason: 'worktree-removed' });
  assert.deepEqual(released, [], 'unregistered with the service');
});

test('language servers rooted in a removed worktree stop; others keep running', async () => {
  const manager = new LanguageServerManager();
  const worktree = join('/data', 'worktrees-v1', 'abc', 'fix');
  const sessions = [
    { root: worktree, key: 'a' },
    { root: join(worktree, 'packages', 'app'), key: 'b' },
    { root: join('/data', 'worktrees-v1', 'abc', 'fix-2'), key: 'c' },
    { root: join('/repo'), key: 'd' },
  ];
  const stopped = [];
  // Only the process boundary is replaced: which sessions stop is the manager's own rule.
  manager.process.state = { activeSessions: () => sessions };
  manager.process.stop = async (session) => stopped.push(session.key);
  assert.deepEqual(await manager.disposeUnder(worktree), [worktree, join(worktree, 'packages', 'app')]);
  assert.deepEqual(stopped, ['a', 'b']);
});
