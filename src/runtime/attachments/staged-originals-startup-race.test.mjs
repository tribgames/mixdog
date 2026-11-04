// The daemon's startup index read runs outside the staging lock. A stage that
// lands while that read is in flight writes a newer index and arms its
// deadline; the startup read finishing afterwards must not replace that arm
// with its older snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

const dataDir = makeTempDirSync('staged-originals-startup-race');
process.env.MIXDOG_DATA_DIR = dataDir;

const { STAGED_ORIGINALS_TTL_MS, stageOriginalAttachment, startStagedOriginalsPrune } = await import(
  './staged-originals.mjs'
);

test('a stage during the held startup read keeps its expiry deadline', async (t) => {
  const indexFile = join(dataDir, 'prompt-attachments', 'staged-originals.json');
  const realReadFile = fsp.readFile;
  let releaseStartupRead;
  let held = false;
  t.mock.method(fsp, 'readFile', function heldReadFile(path, ...rest) {
    if (!held && String(path) === indexFile) {
      held = true;
      return new Promise((resolve) => {
        releaseStartupRead = () => resolve('[]');
      });
    }
    return realReadFile.call(this, path, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => {
    fsp.readFile = realReadFile;
    syncBuiltinESMExports();
  });
  // Expiry deadlines (about the TTL away, less the time staging took) are
  // recorded, never run; the lock's short sleeps run for real.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const deadlines = new Set();
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    if (ms < STAGED_ORIGINALS_TTL_MS / 2) return realSetTimeout(fn, ms, ...rest);
    const handle = { unref() {} };
    deadlines.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => {
    if (deadlines.delete(handle)) return;
    realClearTimeout(handle);
  });

  startStagedOriginalsPrune();
  assert.equal(held, true, 'the startup read is in flight');
  await stageOriginalAttachment(Buffer.alloc(32, 3));
  assert.equal(deadlines.size, 1, 'the stage armed its deadline');

  releaseStartupRead();
  // The released read settles in microtasks; one macrotask turn drains them.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(readFileSync(indexFile, 'utf8')).length, 1, 'one staged original is indexed');
  assert.equal(deadlines.size, 1, 'its expiry deadline is still armed');
});
