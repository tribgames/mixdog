import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-cache-cleanups-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.on('exit', () => {
  rmSync(dataDir, { recursive: true, force: true });
});

const { WORKTREE_CACHE_CLEANUPS, registerWorktreeCacheCleanups } = await import('./cache-cleanups.mjs');
const { createRootCleanupRegistry } = await import('./contract.mjs');

test('registerWorktreeCacheCleanups registers each cleanup exactly once', async () => {
  const registry = createRootCleanupRegistry();
  const register = (name, cleanup) => registry.register(name, cleanup);
  const names = registerWorktreeCacheCleanups(register);
  assert.deepEqual(names, Object.keys(WORKTREE_CACHE_CLEANUPS));
  assert.deepEqual(registry.names(), names);
  assert.doesNotThrow(() => registerWorktreeCacheCleanups(register));
  assert.deepEqual(registry.names(), names);
});

test('registered cleanups report ok with { removed, kept } for an unknown root', async () => {
  const registry = createRootCleanupRegistry();
  registerWorktreeCacheCleanups((name, cleanup) => registry.register(name, cleanup));
  const results = await registry.run(process.platform === 'win32' ? 'C:\\no\\such\\worktree' : '/no/such/worktree');
  assert.equal(results.length, 3);
  for (const entry of results) {
    assert.equal(entry.ok, true, JSON.stringify(entry));
    assert.deepEqual(Object.keys(entry.result).sort(), ['kept', 'removed']);
  }
});
