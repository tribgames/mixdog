import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('prefetch preserves default, custom and full read windows and caches only defaults', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-prefetch-windows-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const cached = [];
  const state = {};
  t.mock.module(new URL('../../../internal-tools.mjs', import.meta.url).href, {
    namedExports: {
      executeInternalTool: async (name, args) => {
        calls.push({ name, args });
        return `body for ${args.path}`;
      },
    },
  });
  t.mock.module(new URL('../../read-dedup.mjs', import.meta.url).href, {
    namedExports: {
      tryPrefetchCached: () => null,
      capturePrefetchCacheState: () => state,
      setPrefetchCached: (...args) => cached.push(args),
    },
  });
  const { prefetchFiles } = await import('./file-prefetch.mjs');
  const files = ['default.txt', 'custom.txt', 'full.txt', 'invalid.txt'];
  const readOpts = new Map([
    ['custom.txt', { n: 7 }],
    ['full.txt', { mode: 'full', n: 7 }],
    ['invalid.txt', { n: NaN }],
  ]);
  const result = await prefetchFiles({ id: 'synthetic-prefetch', cwd: root }, { files, readOpts });
  assert.deepEqual(calls, [
    { name: 'read', args: { path: 'default.txt', mode: 'head', n: 120 } },
    { name: 'read', args: { path: 'custom.txt', mode: 'head', n: 7 } },
    { name: 'read', args: { path: 'full.txt', mode: 'full' } },
    { name: 'read', args: { path: 'invalid.txt', mode: 'head', n: 120 } },
  ]);
  assert.deepEqual(result, {
    readParts: files.map((file) => `body for ${file}`),
    failed: [],
    stats: { files: 4, cached: 0, miss: 4, failed: 0 },
  });
  assert.deepEqual(cached, [[join(root, 'default.txt'), 'body for default.txt', state]]);
});
