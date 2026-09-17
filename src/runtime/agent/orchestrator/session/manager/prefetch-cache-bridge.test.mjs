import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a slower prefetch cannot relabel an earlier read after that source changes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-prefetch-bridge-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  const cache = await import('../cache/prefetch-cache.mjs');
  t.after(() => {
    cache.drainPrefetchDiskWrites();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const fast = join(root, 'fast.txt');
  const slow = join(root, 'slow.txt');
  writeFileSync(fast, 'original fast body');
  writeFileSync(slow, 'slow body');
  const originalTools = await import('../../internal-tools.mjs');
  let fastReads = 0;
  t.mock.module(new URL('../../internal-tools.mjs', import.meta.url).href, {
    namedExports: {
      ...originalTools,
      executeInternalTool: async (_name, args) => {
        if (args.path === fast) {
          fastReads += 1;
          return readFileSync(fast, 'utf8');
        }
        writeFileSync(fast, 'modified while the other read was pending');
        return readFileSync(slow, 'utf8');
      },
    },
  });
  const { _tryBridgeExplicitPrefetch } = await import('./prefetch-bridge.mjs');
  const session = { id: 'prefetch-version-test', owner: 'agent', cwd: root };
  const first = await _tryBridgeExplicitPrefetch(session, { files: [fast, slow] });
  assert.match(first, /original fast body/);
  assert.equal(cache.tryPrefetchCached(fast), null);
  const second = await _tryBridgeExplicitPrefetch(session, { files: [fast] });
  assert.match(second, /modified while the other read was pending/);
  await _tryBridgeExplicitPrefetch(session, { files: [fast] });
  assert.equal(fastReads, 2);
});
