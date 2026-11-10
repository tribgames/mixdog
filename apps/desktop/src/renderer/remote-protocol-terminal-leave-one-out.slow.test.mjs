// How strict the comparison is against Node's own variation: each of Node's runs compared, as the core's trace would be, against the
// other runs. A run passes against all of them by construction (it is one of them); against the others it shows whether the recordings
// cover what Node itself varies.
//
// Measured on the 50 runs of apps/mobile/fixtures/phone-terminal/runs.json under the rule decided 2026-11-11 (the screen each command
// ends in, the messages besides output in order, a command's output against its own activity changes only where Node shows one order):
// none fail, and none may. The rules it replaced failed Node's own runs (MANIFEST.json, `leaveOneOut`).
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTraces, loadRuns } from './remote-protocol-terminal-compare.mjs';

const runs = loadRuns();

test('each Node run compared against the other 49: none fails', async () => {
  const failing = [];
  for (const [index, run] of runs.entries()) {
    try {
      await compareTraces(JSON.parse(JSON.stringify(run)), runs.filter((_, other) => other !== index));
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      failing.push(`run ${index}: ${error.message.split('\n').slice(0, 3).join(' / ')}`);
    }
  }
  assert.deepEqual(failing, []);
});
