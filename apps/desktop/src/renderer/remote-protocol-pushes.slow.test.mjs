// The phone's capability flags, activity rail pins, native push registration and desktop notices on the core, every value the page's UI
// was given compared whole with what Node (b6f10295a) gave it (apps/mobile/fixtures/phone-pushes/golden.json, recorded by
// benchmarks/rust-core/recorders/record-phone-pushes.mjs; the replay is benchmarks/rust-core/recorders/lib/phone-pushes-replay.mjs). The
// core binary is MIXDOGD_BIN; PHONE_PUSHES_ONLY plays one scenario.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { replayPushes } from '../../../../benchmarks/rust-core/recorders/lib/phone-pushes-replay.mjs';

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-pushes/golden.json', import.meta.url), 'utf8'));
const exe = process.env.MIXDOGD_BIN || 'C:\\mixdog-build\\pool\\w11-target\\debug\\mixdogd.exe';

test('the phone page on the core is given what Node gave it', async () => {
  const results = await replayPushes({ exe, golden, only: process.env.PHONE_PUSHES_ONLY });
  for (const [name, { node, core, paths }] of Object.entries(results)) {
    assert.deepEqual(paths, [], `${name} differs at ${paths.join(', ')}\nnode: ${JSON.stringify(node)}\ncore: ${JSON.stringify(core)}`);
  }
});
