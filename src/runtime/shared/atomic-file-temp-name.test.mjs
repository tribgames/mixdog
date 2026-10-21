import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';

import {
  RE_CACHE_TMP,
  RE_CALLS_CACHE_TMP,
  RE_MANIFEST_TMP,
} from '../agent/orchestrator/tools/code-graph/constants.mjs';
import { sweepStaleSummaryTempFiles } from '../agent/orchestrator/session/store-summary-index.mjs';
import { pruneDaemonCrashCaptures } from '../../session-runtime/services/daemon-crash-capture/retention.mjs';
import {
  writeFileAtomicAsync,
  writeFileAtomicSync,
  writeJsonAtomicAsync,
  writeJsonAtomicSync,
} from './atomic-file.mjs';

// Windows cloud-sync drives (Naver MYBOX, issue #138) reject creating a file
// whose name starts with '.', so a publication must not create one even for
// the instant its temp file exists. The temp file is only visible while the
// write is in flight, so the creating handle is observed, not the leftovers.
const root = fs.mkdtempSync(join(tmpdir(), 'mixdog-atomic-temp-name-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const freshDir = () => fs.mkdtempSync(join(root, 'd-'));

// Names of every file created in `dir` through the durable-write handles
// (sync `openSync`, async `fs.promises.open`) while `run` executes.
async function createdNames(t, dir, run) {
  const names = [];
  const record = (path, flags) => {
    if (dirname(String(path)) === dir && String(flags).startsWith('w')) names.push(basename(String(path)));
  };
  const { openSync } = fs;
  const { open } = fs.promises;
  const spies = [
    t.mock.method(fs, 'openSync', (path, flags, ...rest) => {
      record(path, flags);
      return openSync(path, flags, ...rest);
    }),
    t.mock.method(fs.promises, 'open', (path, flags, ...rest) => {
      record(path, flags);
      return open(path, flags, ...rest);
    }),
  ];
  // atomic-file.mjs binds `openSync` / `open` by name; re-sync the ESM view.
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mock.restore();
    syncBuiltinESMExports();
  }
  return names;
}

test('publication never creates a dot-prefixed file, sync or async', async (t) => {
  const dir = freshDir();
  const path = join(dir, 'state.json');
  const viaSync = await createdNames(t, dir, () => {
    writeJsonAtomicSync(path, { n: 1 }, { backup: true });
    writeJsonAtomicSync(path, { n: 2 }, { backup: true });
    writeFileAtomicSync(join(dir, 'plain.txt'), 'x', { createOnly: true });
  });
  const viaAsync = await createdNames(t, dir, async () => {
    await writeJsonAtomicAsync(path, { n: 3 }, { backup: true });
    await writeFileAtomicAsync(join(dir, 'other.txt'), 'x');
  });

  const shape = /^(?:state\.json|state\.json\.bak|plain\.txt|other\.txt)\.mixdog-tmp-[0-9a-f]{16}$/;
  for (const names of [viaSync, viaAsync]) {
    assert.ok(names.length >= 3, `the publications were observed: ${names}`);
    assert.deepEqual(
      names.filter((name) => name.startsWith('.')),
      []
    );
    for (const name of names) assert.match(name, shape);
  }
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes('mixdog-tmp')),
    [],
    'no temp file is left behind'
  );
});

test('a basename whose old-shape temp fit in 255 characters still publishes', async () => {
  const dir = freshDir();
  // Old temp: `.<name>.<24 hex>.tmp` = name + 30 characters.
  const name = `${'n'.repeat(220)}.json`;
  assert.equal(name.length + 30, 255);
  const path = join(dir, name);
  writeJsonAtomicSync(path, { n: 1 });
  await writeJsonAtomicAsync(path, { n: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')), { n: 2 });
  assert.deepEqual(fs.readdirSync(dir), [name]);
});

test('every stale-temp sweep still recognises the temp name the writer produces', async (t) => {
  const tempNameFor = async (dir, target) => {
    const names = await createdNames(t, dir, () => writeFileAtomicSync(join(dir, target), 'x'));
    assert.equal(names.length, 1);
    return names[0];
  };

  const cacheDir = freshDir();
  const hash = 'a1'.repeat(8);
  assert.match(await tempNameFor(cacheDir, `${hash}.json`), RE_CACHE_TMP);
  assert.match(await tempNameFor(cacheDir, 'manifest.json'), RE_MANIFEST_TMP);
  assert.match(await tempNameFor(cacheDir, `${hash}.calls.json`), RE_CALLS_CACHE_TMP);

  const captureDir = freshDir();
  const captureTemp = join(captureDir, await tempNameFor(captureDir, 'daemon-20260915-064858-999999998-dead.json'));
  fs.writeFileSync(captureTemp, '{');
  pruneDaemonCrashCaptures({ dir: captureDir, pidAlive: () => false });
  assert.equal(fs.existsSync(captureTemp), false, 'crash-capture debris of a dead writer is reclaimed');

  const dataDir = freshDir();
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
  });
  const summaryTemp = join(dataDir, await tempNameFor(dataDir, 'session-summaries.json'));
  fs.writeFileSync(summaryTemp, '{');
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(summaryTemp, old, old);
  assert.equal(await sweepStaleSummaryTempFiles(), 1);
  assert.equal(fs.existsSync(summaryTemp), false, 'a stale summary-index temp is reclaimed');
});
