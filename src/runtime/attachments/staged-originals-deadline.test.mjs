// The daemon expires staged originals on one exact deadline (the earliest
// entry's expiry), with no timer while nothing is staged and no synchronous
// fs call in the prune that deadline runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

const dataDir = makeTempDirSync('staged-originals-deadline');
process.env.MIXDOG_DATA_DIR = dataDir;

const realFs = { ...fs };
const syncNames = Object.keys(realFs).filter((name) => name.endsWith('Sync') && typeof realFs[name] === 'function');
const syncCalls = [];
let watching = false;
for (const name of syncNames) {
  fs[name] = function watchedSync(...args) {
    if (watching) syncCalls.push(name);
    return realFs[name].apply(this, args);
  };
}
module.syncBuiltinESMExports();

const { attachmentFilePath } = await import('./store.mjs');
const { STAGED_ORIGINALS_TTL_MS, _deadlinePruneForTest, stageOriginalAttachment, startStagedOriginalsPrune } =
  await import('./staged-originals.mjs');

const turns = async (count) => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('with nothing staged the daemon arms no prune timer', async (t) => {
  const timeouts = t.mock.method(globalThis, 'setTimeout');
  startStagedOriginalsPrune();
  await turns(50);
  assert.equal(timeouts.mock.callCount(), 0);
});

test('a staged original expires on its own deadline, through a prune with no sync fs', async (t) => {
  // Only the clock is mocked: the prune's lock and rename retries sleep on
  // real timers, which a mocked setTimeout would freeze.
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const realSetTimeout = globalThis.setTimeout;
  const deadlines = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    if (ms < STAGED_ORIGINALS_TTL_MS) return realSetTimeout(fn, ms, ...rest);
    deadlines.push({ fn, ms });
    return { unref() {} };
  });
  t.after(() => {
    watching = false;
    for (const name of syncNames) fs[name] = realFs[name];
    module.syncBuiltinESMExports();
  });
  const { attachmentRef } = await stageOriginalAttachment(Buffer.alloc(64, 7));
  const indexFile = join(dataDir, 'prompt-attachments', 'staged-originals.json');
  assert.deepEqual(
    deadlines.map((timer) => timer.ms),
    [STAGED_ORIGINALS_TTL_MS + 1],
    'one deadline, just past the entry TTL'
  );
  t.mock.timers.tick(STAGED_ORIGINALS_TTL_MS + 1);
  watching = true;
  deadlines.at(-1).fn();
  await _deadlinePruneForTest();
  watching = false;
  assert.equal(realFs.existsSync(attachmentFilePath(attachmentRef)), false, 'blob removed');
  assert.deepEqual(JSON.parse(realFs.readFileSync(indexFile, 'utf8')), [], 'entry removed');
  assert.equal(deadlines.length, 1, 'an empty index arms nothing');
  assert.deepEqual(syncCalls, []);
});
