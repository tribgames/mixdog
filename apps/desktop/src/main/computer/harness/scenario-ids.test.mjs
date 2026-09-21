import assert from 'node:assert/strict';
import test from 'node:test';
import { SCENARIO_IDS, unknownScenarioIds } from './scenario-ids.ts';

test('scenario selection names its unknown ids before the harness runs', () => {
  // The harness validates `--only` up front now: the old check ran inside the
  // cleanup `finally`, where it masked real scenario failures and aborted the
  // block before report.json was written.
  assert.deepEqual(unknownScenarioIds([]), []);
  assert.deepEqual(unknownScenarioIds(['S01', SCENARIO_IDS.at(-1)]), []);
  assert.deepEqual(unknownScenarioIds(['S01', 'S99', 's01', 'S99']), ['S99', 's01']);
});
