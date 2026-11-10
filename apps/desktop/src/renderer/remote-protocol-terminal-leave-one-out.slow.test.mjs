// How strict the comparison is against Node's own variation: each of Node's runs compared, as the core's trace would be, against the
// other runs. A run passes against all of them by construction (it is one of them); against the others it shows whether the recordings
// cover what Node itself varies.
//
// Measured on the 50 runs of apps/mobile/fixtures/phone-terminal/runs.json (MANIFEST.json, `leaveOneOut`): 49 of 50 fail. The failures
// are the console's own variation in the output of a command window (the stretch after a tab's input and the stretches its own `running`
// and `finished` open): in 35 runs a stretch's sequence of screen states is no other run's (in 33 of them the stretch's bytes are no other
// run's: the console redrew differently), in the other 14 two places' alternatives are not shown together (10 of them two frame cuts
// of the same bytes). Comparing only each stretch's
// end state still fails 42 runs; comparing only the end state of each command window fails none, which drops the screen at the tab's own
// `running` and `finished`: the order of output against those changes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTraces, loadRuns } from './remote-protocol-terminal-compare.mjs';

const runs = loadRuns();

test("each Node run compared against the other 49: the measured number that fail", async () => {
  const passing = [];
  for (const [index, run] of runs.entries()) {
    try {
      await compareTraces(JSON.parse(JSON.stringify(run)), runs.filter((_, other) => other !== index));
      passing.push(index);
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
    }
  }
  assert.deepEqual({ failing: runs.length - passing.length, passing }, { failing: 49, passing: [48] });
});
