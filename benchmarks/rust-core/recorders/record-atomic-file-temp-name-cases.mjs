#!/usr/bin/env node
// Recording of the case "every stale-temp sweep still recognises the temp name the writer produces" of
// src/runtime/shared/atomic-file-temp-name.test.mjs (b6f10295a): the name of the file Node's atomic writer creates beside each target
// (observed on the creating handle, as the test does), and what each stale-temp sweep decides about it: the code-graph cache
// patterns, the daemon crash-capture retention, the session-summary index sweep. The random suffix is written `<hex16>` (declared).
//
//   node benchmarks/rust-core/recorders/record-atomic-file-temp-name-cases.mjs --tree <export of b6f10295a with node_modules>
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';

REPLAY_TARGETS['atomic-file-temp-name-cases'] = {
  notPublic: ['the Rust writer\'s temp name `<target>.mixdog-tmp-<16 hex>` (mixdog-statefile/src/publish.rs:164 temp_path, private) and the migration\'s recogniser of the 1.4.5 name (mixdog-migrate/src/temp_files.rs atomic_publish_base, pub)'],
  missing: ['the code-graph cache and summary-index stale-temp sweeps of Node have no Rust counterpart under those names: the Rust caches are not written by the Node writer'],
};
const set = openSet('atomic-file-temp-name-cases', import.meta.url);
const { RE_CACHE_TMP, RE_CALLS_CACHE_TMP, RE_MANIFEST_TMP } = await set.load('src/runtime/agent/orchestrator/tools/code-graph/constants.mjs');
const { sweepStaleSummaryTempFiles } = await set.load('src/runtime/agent/orchestrator/session/store-summary-index.mjs');
const { pruneDaemonCrashCaptures } = await set.load('src/session-runtime/services/daemon-crash-capture/retention.mjs');
const { writeFileAtomicSync } = await set.load('src/runtime/shared/atomic-file.mjs');

const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-atomic-temp-name-'));
const freshDir = () => fs.mkdtempSync(join(root, 'd-'));
// The names of the files created in `dir` through the durable-write handle while `run` executes (the temp file is visible only then).
function createdNames(dir, run) {
  const names = [];
  const { openSync } = fs;
  fs.openSync = (path, flags, ...rest) => {
    if (dirname(String(path)) === dir && String(flags).startsWith('w')) names.push(basename(String(path)));
    return openSync(path, flags, ...rest);
  };
  // The writer imports `openSync` by name: the live binding follows only after this (as in the Node test).
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    fs.openSync = openSync;
    syncBuiltinESMExports();
  }
  return names;
}
const tempNameFor = (dir, target) => createdNames(dir, () => writeFileAtomicSync(join(dir, target), 'x'));

await set.run('every stale-temp sweep still recognises the temp name the writer produces', async () => {
  try {
    const cacheDir = freshDir();
    const hash = 'a1'.repeat(8);
    const cache = tempNameFor(cacheDir, `${hash}.json`);
    const manifest = tempNameFor(cacheDir, 'manifest.json');
    const calls = tempNameFor(cacheDir, `${hash}.calls.json`);
    const cachePatterns = { cache: RE_CACHE_TMP.test(cache[0]), manifest: RE_MANIFEST_TMP.test(manifest[0]), calls: RE_CALLS_CACHE_TMP.test(calls[0]) };

    const captureDir = freshDir();
    const captureTarget = 'daemon-20260915-064858-999999998-dead.json';
    const captureNames = tempNameFor(captureDir, captureTarget);
    const captureTemp = join(captureDir, captureNames[0]);
    fs.writeFileSync(captureTemp, '{');
    pruneDaemonCrashCaptures({ dir: captureDir, pidAlive: () => false });
    const captureReclaimed = !fs.existsSync(captureTemp);

    const dataDir = freshDir();
    const previous = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = dataDir;
    try {
      const summaryNames = tempNameFor(dataDir, 'session-summaries.json');
      const summaryTemp = join(dataDir, summaryNames[0]);
      fs.writeFileSync(summaryTemp, '{');
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
      fs.utimesSync(summaryTemp, old, old);
      const swept = await sweepStaleSummaryTempFiles();
      return {
        written: [`${hash}.json`, 'manifest.json', `${hash}.calls.json`, captureTarget, 'session-summaries.json'],
        names: { cache, manifest, calls, capture: captureNames, summary: summaryNames },
        cachePatterns,
        captureReclaimed,
        summarySwept: swept,
        summaryReclaimed: !fs.existsSync(summaryTemp),
      };
    } finally {
      if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
      else process.env.MIXDOG_DATA_DIR = previous;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await set.finish({
  entry: { runs: 'writeFileAtomicSync (src/runtime/shared/atomic-file.mjs) in scratch folders, RE_CACHE_TMP / RE_MANIFEST_TMP / RE_CALLS_CACHE_TMP (code-graph/constants.mjs), pruneDaemonCrashCaptures (daemon-crash-capture/retention.mjs), sweepStaleSummaryTempFiles (store-summary-index.mjs)', notRun: 'the writer\'s async twin is not run: the test\'s own names come from the sync writer', hops: 'No wire in the Node test.' },
  replay: { entry: 'every temp name Node\'s writer produced is recognised as the temp of its target by the migration\'s 1.4.5 temp-file recogniser and is what the Rust writer also produces; compare the recorded names (random suffix written <hex16>) with the recogniser\'s answer', normalised: {} },
  replaceRegex: [[/(\.mixdog-tmp-)[0-9a-f]{16}$/, '$1<hex16>']],
  normaliseReason: 'the random 16-hex suffix of the writer\'s temp name (randomBytes(8)) differs per run',
});
process.exit(0);
