#!/usr/bin/env node
// Recording of shared/data-dir-retarget.test.mjs (b6f10295a): config.mjs (configPath, readSection, updateSection) and
// turn-snapshot-store.mjs (saveTurnSnapshotRecord) follow a runtime MIXDOG_DATA_DIR retarget instead of the import-time value.
// The test's own isolated-test-env import runs first, as it does in the Node test. Paths are recorded relative to the two temp
// data dirs (<first>, <second>).
//
//   node benchmarks/rust-core/recorders/record-data-dir-retarget-cases.mjs --tree <export of b6f10295a with node_modules>
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const set = openSet('data-dir-retarget-cases', import.meta.url);
await set.load('scripts/lib/isolated-test-env.mjs');
const { configPath, readSection, updateSection } = await set.load('src/runtime/shared/config.mjs');
const { _setTurnSnapshotStoreRootForTest, saveTurnSnapshotRecord } = await set.load('src/runtime/shared/turn-snapshot-store.mjs');
const roots = [];

await set.run('config and turn snapshot records follow a runtime MIXDOG_DATA_DIR retarget', async () => {
  const previous = process.env.MIXDOG_DATA_DIR;
  const first = mkdtempSync(join(tmpdir(), 'mixdog-retarget-a-'));
  const second = mkdtempSync(join(tmpdir(), 'mixdog-retarget-b-'));
  roots.push(first, second);
  const rel = (p) => p.replace(first, '<first>').replace(second, '<second>').replaceAll('\\', '/');
  try {
    _setTurnSnapshotStoreRootForTest('');
    const out = {};
    process.env.MIXDOG_DATA_DIR = first;
    out.configPathAfterFirst = rel(configPath());
    process.env.MIXDOG_DATA_DIR = second;
    out.configPathAfterSecond = rel(configPath());
    updateSection('retarget-probe', () => ({ ok: true }));
    out.config = { secondHasFile: existsSync(join(second, 'mixdog-config.json')), firstHasFile: existsSync(join(first, 'mixdog-config.json')), readBack: readSection('retarget-probe'), fileText: readFileSync(join(second, 'mixdog-config.json'), 'utf8') };
    const saved = await saveTurnSnapshotRecord('retarget-session', { baselineTree: 'abc', root: second });
    out.snapshot = { saved, secondHasDir: existsSync(join(second, 'turn-snapshots')), firstHasDir: existsSync(join(first, 'turn-snapshots')) };
    return out;
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

await set.finish({
  entry: { runs: 'shared/config.mjs configPath/readSection/updateSection and shared/turn-snapshot-store.mjs saveTurnSnapshotRecord, with MIXDOG_DATA_DIR retargeted between two temp dirs after import', notRun: 'nothing else' },
  replay: { entry: 'mixdog-core config / turn-snapshot store: set the data dir twice at runtime and compare the config path, the written section and the snapshot dir', normalised: { dataDirs: '<first> / <second>' } },
  replaceInText: roots.map((r) => [r, '<data>']),
});
process.exit(0);
