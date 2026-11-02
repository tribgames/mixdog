// A resident graph past its TTL is revalidated by manifest signature and
// served again, and every mode answers byte-for-byte as it did from the fresh
// build.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeCodeGraphTool } from './dispatch.mjs';
import { _revalidateResidentCodeGraph } from './build.mjs';
import { canonicalGraphCwd, codeGraphCache } from '../code-graph-state.mjs';

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cg-resident-'));
  writeFileSync(join(root, 'package.json'), '{"name":"resident-fixture"}\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src', 'util.mjs'),
    'export function helper(value) {\n  return value + 1;\n}\n\nexport class Box {\n  open() {\n    return helper(1);\n  }\n}\n'
  );
  writeFileSync(
    join(root, 'src', 'main.mjs'),
    "import { helper, Box } from './util.mjs';\n\nexport function run() {\n  const box = new Box();\n  return helper(2) + box.open();\n}\n"
  );
  return root;
}

const CALLS = [
  { mode: 'overview' },
  { mode: 'overview', file: 'src/util.mjs' },
  { mode: 'symbols', file: 'src/util.mjs' },
  { mode: 'find_symbol', symbol: 'helper' },
  { mode: 'find_symbol', symbol: 'helper', body: false },
  { mode: 'references', symbol: 'helper' },
  { mode: 'callers', symbol: 'helper' },
  { mode: 'callees', symbol: 'run' },
  { mode: 'impact', file: 'src/util.mjs' },
  { mode: 'imports', file: 'src/main.mjs' },
  { mode: 'dependents', file: 'src/util.mjs' },
  { mode: 'symbol_search', symbol: 'Box' },
];

async function runAll(root) {
  const out = [];
  for (const args of CALLS) out.push(String(await executeCodeGraphTool('code_graph', args, root)));
  return out;
}

test('every mode answers identically from a revalidated resident graph', async (t) => {
  const root = makeProject();
  const key = canonicalGraphCwd(root);
  t.after(() => {
    codeGraphCache.delete(key);
    rmSync(root, { recursive: true, force: true });
  });

  const fresh = await runAll(root);
  const entry = codeGraphCache.get(key);
  assert.ok(entry?.graph, 'the graph stays resident after the queries');
  entry.ts = 0; // past the TTL: the next query must revalidate, not reuse blindly
  const revalidated = await runAll(root);
  assert.deepEqual(revalidated, fresh);
  assert.equal(codeGraphCache.get(key).graph, entry.graph, 'the same graph object was served again');
  assert.ok(codeGraphCache.get(key).ts > 0);
});

test('a resident graph whose signature changed is handed to a rebuild with its manifest', async () => {
  const entry = { graph: { id: 'g' }, signature: 'old', ts: 0 };
  const manifest = [{ rel: 'a.mjs', fp: '1' }];
  const set = [];
  const base = {
    graphCwd: 'root',
    entry,
    genAtStart: 0,
    acquireSlot: async () => () => {},
    runManifest: async () => manifest,
    getGeneration: () => 0,
    setMemoryCache: (cwd, value) => set.push(value),
  };
  const miss = await _revalidateResidentCodeGraph({ ...base, computeSignature: () => 'new' });
  assert.deepEqual(miss, { graph: null, manifest, signature: 'new' });
  assert.equal(set.length, 0);
  const hit = await _revalidateResidentCodeGraph({ ...base, computeSignature: () => 'old' });
  assert.equal(hit.graph, entry.graph);
  assert.equal(set[0].graph, entry.graph);
});
