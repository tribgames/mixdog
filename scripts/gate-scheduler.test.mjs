import assert from 'node:assert/strict';
import test from 'node:test';
import { gateTestBudget, runGateLegs } from './lib/gate-scheduler.mjs';

test('a local gate shares the shell or explicit budget instead of multiplying it per lane', () => {
  assert.equal(gateTestBudget({}, 20), 6);
  assert.equal(gateTestBudget({}, 1), 1);
  assert.equal(gateTestBudget({ MIXDOG_SHELL_CONCURRENCY_CAP: '8' }, 20), 12);
  assert.equal(gateTestBudget({ MIXDOG_TEST_CONCURRENCY: '3', MIXDOG_SHELL_CONCURRENCY_CAP: '8' }, 20), 3);
});

for (const budget of [1, 2, 6]) {
  test(`all gate legs finish within a shared ${budget}-worker budget, including failed legs`, async () => {
    const legs = Array.from({ length: 5 }, (_, id) => ({ id }));
    const seen = [];
    let active = 0;
    let peak = 0;
    await runGateLegs(legs, budget, async (leg, concurrency) => {
      active += concurrency;
      peak = Math.max(peak, active);
      assert.ok(active <= budget);
      await new Promise((resolve) => setImmediate(resolve));
      leg.ok = leg.id !== 1;
      seen.push(leg.id);
      active -= concurrency;
    });
    assert.equal(peak, budget);
    assert.equal(active, 0);
    assert.deepEqual(seen.sort(), [0, 1, 2, 3, 4]);
    assert.equal(legs[1].ok, false);
  });
}

test('an empty gate has no work and an invalid budget is rejected', async () => {
  await runGateLegs([], 2, () => assert.fail('nothing to run'));
  await assert.rejects(
    runGateLegs([{}], 0, () => {}),
    /positive integer/
  );
});
