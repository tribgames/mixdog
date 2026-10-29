import assert from 'node:assert/strict';
import test from 'node:test';
import { scenarioGroupOnly } from '../../../../scripts/computer-host-repeat-policy.mjs';
import { SCENARIO_GROUPS, SCENARIO_IDS, SCENARIO_RUN_ORDER, unknownScenarioIds } from './scenario-ids.ts';

test('scenario groups partition the ids and the run order is a permutation of them', () => {
  const ids = [...SCENARIO_IDS];
  assert.deepEqual(ids, ids.map((_, index) => `S${String(index + 1).padStart(2, '0')}`), 'ids are contiguous from S01');
  assert.deepEqual([...SCENARIO_RUN_ORDER].sort(), ids);
  assert.deepEqual(Object.values(SCENARIO_GROUPS).flat().sort(), ids, 'every id is in exactly one group');
});

test('--group resolves to its ids and refuses unknown names', () => {
  assert.equal(scenarioGroupOnly('performance'), 'S30');
  assert.equal(scenarioGroupOnly('external'), 'S19');
  assert.throws(() => scenarioGroupOnly('missing'), /unknown scenario group "missing"/);
  for (const [name, ids] of Object.entries(SCENARIO_GROUPS)) assert.equal(scenarioGroupOnly(name), ids.join(','));
});

test('scenario selection names its unknown ids before the harness runs', () => {
  // The harness validates `--only` up front now: the old check ran inside the
  // cleanup `finally`, where it masked real scenario failures and aborted the
  // block before report.json was written.
  assert.deepEqual(unknownScenarioIds([]), []);
  assert.deepEqual(unknownScenarioIds(['S01', SCENARIO_IDS.at(-1)]), []);
  assert.deepEqual(unknownScenarioIds(['S01', 'S99', 's01', 'S99']), ['S99', 's01']);
});
