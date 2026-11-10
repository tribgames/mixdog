// The lag profiler rides the daemon's stall-watch tick: its flag check runs
// every window, so it must stay off synchronous node:fs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const { createLagProfiler, LAG_PROFILE_FLAG_FILE } = await import('./daemon-lag-profiler.mjs');

test('a lag-profiler tick checks its flag without synchronous fs, flag absent or present', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-lag-async-'));
  t.after(() => {
    watching = false;
    for (const name of syncNames) fs[name] = realFs[name];
    module.syncBuiltinESMExports();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const session = { post: (_method, _params, done) => done(null, {}), disconnect() {} };
  let flagChanged = () => {};
  const profiler = createLagProfiler({
    dataDir,
    createSession: async () => session,
    watchFlag: (_dir, _name, onChange) => {
      flagChanged = onChange;
      return { close() {} };
    },
  });
  watching = true;
  assert.equal(await profiler.tick(), 'disabled');
  watching = false;
  writeFileSync(join(dataDir, LAG_PROFILE_FLAG_FILE), '');
  flagChanged();
  watching = true;
  assert.equal(await profiler.tick(), 'started');
  watching = false;
  assert.deepEqual(syncCalls, []);
});
