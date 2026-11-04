// The attachment census runs inside the daemon, so from its start through the
// stamp, claim, census and release it must stay off synchronous node:fs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

const dataDir = makeTempDirSync('attachment-gc-async');
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

const { startAttachmentGc } = await import('./store.mjs');
await import('./staged-originals.mjs');

const turns = async (count) => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('the scheduled attachment census makes no synchronous fs call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    watching = false;
    for (const name of syncNames) fs[name] = realFs[name];
    module.syncBuiltinESMExports();
  });
  const stamp = join(dataDir, 'prompt-attachments', 'gc-last-run');
  watching = true;
  startAttachmentGc();
  await turns(50);
  t.mock.timers.tick(5_000);
  const deadline = performance.now() + 5_000;
  while (!realFs.existsSync(stamp) && performance.now() < deadline) await turns(20);
  await turns(50);
  watching = false;
  assert.equal(realFs.existsSync(stamp), true, 'the census ran and stamped its run');
  assert.equal(realFs.existsSync(join(dataDir, 'prompt-attachments', 'gc-running')), false, 'the claim is released');
  assert.deepEqual(syncCalls, []);

  // Startup (and an attachment save) runs the census, not a cadence.
  realFs.rmSync(stamp);
  t.mock.timers.tick(7 * 60 * 60 * 1000);
  const quiet = performance.now() + 1_500;
  while (!realFs.existsSync(stamp) && performance.now() < quiet) await turns(20);
  assert.equal(realFs.existsSync(stamp), false, 'no recurring census');
});
