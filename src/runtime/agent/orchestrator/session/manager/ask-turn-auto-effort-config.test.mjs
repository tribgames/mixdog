// A session runtime's in-memory settings decide Auto effort at once; the
// config file trails them by a debounce.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { autoEffortBaseSetting, autoEffortMode } from './ask-turn-auto-effort.mjs';
import { builtinFeatureActive } from '../../runtime-core/builtin-features.mjs';

test('Auto effort reads the runtime config it is handed over a conflicting file', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'auto-effort-config-'));
  const previous = { data: process.env.MIXDOG_DATA_DIR, mode: process.env.MIXDOG_AUTO_EFFORT };
  process.env.MIXDOG_DATA_DIR = dataDir;
  delete process.env.MIXDOG_AUTO_EFFORT;
  t.after(() => {
    for (const [key, value] of [
      ['MIXDOG_DATA_DIR', previous.data],
      ['MIXDOG_AUTO_EFFORT', previous.mode],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
  // The file still holds the old values: the debounced write has not landed.
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { autoEffortBase: 'low' } }));
  assert.equal(autoEffortBaseSetting(null), 'low', 'without a runtime config the file is read');
  assert.equal(autoEffortBaseSetting({ autoEffortBase: 'high' }), 'high', 'the runtime config wins');
  // The mode follows the handed config's own feature state, whatever the file says.
  const runtime = { modules: { autoEffort: { enabled: false } } };
  assert.equal(autoEffortMode(runtime), builtinFeatureActive(runtime, 'autoEffort') ? 'on' : 'off');
});
