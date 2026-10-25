import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const base = mkdtempSync(join(tmpdir(), 'mixdog-code-graph-forget-'));
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.on('exit', () => {
  rmSync(base, { recursive: true, force: true });
});

const state = await import('../../../../shared/code-graph-state.mjs');
const disk = await import('./disk-cache.mjs');
const trusted = await import('./trusted-roots.mjs');

const cacheDir = join(process.env.MIXDOG_DATA_DIR, 'code-graph-cache');
const manifest = () => JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf8'));
const graph = (cwd) => ({ cwd, nodes: new Map(), reverse: new Map(), signature: 'sig', builtAt: Date.now() });

const rootA = join(base, 'worktrees', 'a');
const rootB = join(base, 'worktrees', 'b');

test('forgetCodeGraphStateRoot drops only the target root', () => {
  const a = state.canonicalGraphCwd(rootA);
  const b = state.canonicalGraphCwd(rootB);
  state.codeGraphCache.set(a, {});
  state.codeGraphCache.set(b, {});
  state.markCodeGraphDirtyPaths([join(rootA, 'x.js'), join(rootB, 'y.js')]);
  state.codeGraphCache.set(a, {});
  state.codeGraphCache.set(b, {});
  assert.equal(state.getCodeGraphGen(a), 1);

  const removed = state.forgetCodeGraphStateRoot(process.platform === 'win32' ? rootA.toUpperCase() : rootA);
  assert.deepEqual(removed.sort(), ['dirty-generation', 'dirty-paths', 'resident-graph']);
  assert.equal(state.getCodeGraphGen(a), 0);
  assert.deepEqual(state.consumeCodeGraphDirtyPaths(rootA), []);
  assert.equal(state.codeGraphCache.has(a), false);

  assert.equal(state.codeGraphCache.has(b), true);
  assert.equal(state.getCodeGraphGen(b), 1);
  assert.ok(state.consumeCodeGraphDirtyPaths(rootB).length > 0);
  assert.deepEqual(state.forgetCodeGraphStateRoot(rootA), []);
  state.forgetCodeGraphStateRoot(rootB);
});

test('forgetDiskCodeGraphRoot removes manifest row, files and delayed writes of one root', async () => {
  disk._setDiskCodeGraphEntry(rootA, graph(rootA));
  disk._setDiskCodeGraphEntry(rootB, graph(rootB));
  disk.drainCodeGraphCache();
  const before = manifest();
  const keyA = state.canonicalGraphCwd(rootA);
  const keyB = state.canonicalGraphCwd(rootB);
  assert.deepEqual(Object.keys(before).sort(), [keyA, keyB].sort());
  const hashA = before[keyA].hash;
  const hashB = before[keyB].hash;
  writeFileSync(join(cacheDir, `${hashA}.calls.json`), '{}');
  writeFileSync(join(cacheDir, `${hashB}.calls.json`), '{}');

  // A rebuild of A is waiting on the 250 ms flush when the root is removed.
  disk._setDiskCodeGraphEntry(rootA, graph(rootA));
  const result = disk.forgetDiskCodeGraphRoot(process.platform === 'win32' ? rootA.toUpperCase() : rootA);
  assert.deepEqual(result.kept, []);
  assert.ok(result.removed.some((item) => item === `manifest:${keyA}`));
  assert.ok(result.removed.some((item) => item.endsWith(`${hashA}.json`)));
  assert.ok(result.removed.some((item) => item.endsWith(`${hashA}.calls.json`)));

  disk.drainCodeGraphCache();
  assert.deepEqual(Object.keys(manifest()), [keyB]);
  assert.equal(existsSync(join(cacheDir, `${hashA}.json`)), false);
  assert.equal(existsSync(join(cacheDir, `${hashA}.calls.json`)), false);
  assert.equal(existsSync(join(cacheDir, `${hashB}.json`)), true);
  assert.equal(existsSync(join(cacheDir, `${hashB}.calls.json`)), true);
  assert.equal(disk.getDiskCodeGraphEntry(rootA), undefined);
  assert.ok(disk.getDiskCodeGraphEntry(rootB));
  assert.deepEqual(disk.listCachedCodeGraphRoots(), [keyB]);

  assert.deepEqual(disk.forgetDiskCodeGraphRoot(rootA), { removed: [], kept: [] });
  assert.deepEqual(Object.keys(manifest()), [keyB]);
});

test('forgetTrustedCodeGraphRoot unregisters only the exact root', () => {
  const registry = [rootA, rootB, join(rootA, 'nested')];
  const unregister = (path) => {
    registry.splice(registry.indexOf(path), 1);
    return true;
  };
  const result = trusted.forgetTrustedCodeGraphRoot(process.platform === 'win32' ? rootA.toUpperCase() : rootA, {
    registered: () => [...registry],
    unregister,
  });
  assert.deepEqual(result, { removed: [rootA], kept: [] });
  assert.deepEqual(registry, [rootB, join(rootA, 'nested')]);
  assert.deepEqual(
    trusted.forgetTrustedCodeGraphRoot(rootA, { registered: () => [...registry], unregister }),
    { removed: [], kept: [] }
  );
});
