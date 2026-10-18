import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateWorkers, gateTestBudget, runGateLegs } from './lib/gate-scheduler.mjs';

test('a local gate shares the default or explicit budget instead of multiplying it per lane', () => {
  assert.equal(gateTestBudget({}, 20), 6);
  assert.equal(gateTestBudget({}, 1), 1);
  assert.equal(gateTestBudget({ MIXDOG_TEST_CONCURRENCY: '3' }, 20), 3);
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

test('workers are split by leg weight with at least one each and the whole budget used', () => {
  const legs = [{ weight: 3 }, { weight: 3 }, { weight: 4 }, { weight: 2 }];
  assert.deepEqual(allocateWorkers(legs, 12), [3, 3, 4, 2]);
  assert.deepEqual(allocateWorkers(legs, 6), [2, 1, 2, 1]);
  assert.deepEqual(allocateWorkers(legs, 4), [1, 1, 1, 1]);
  assert.deepEqual(allocateWorkers([{}, {}, {}], 7), [3, 2, 2]);
  for (let budget = 4; budget <= 40; budget++) {
    const shares = allocateWorkers(legs, budget);
    assert.equal(
      shares.reduce((a, b) => a + b),
      budget
    );
    assert.ok(shares.every((n) => n >= 1));
  }
});

test('weighted legs run together with their own share', async () => {
  const legs = [{ weight: 1 }, { weight: 3 }];
  const given = [];
  await runGateLegs(legs, 8, async (leg, concurrency) => {
    given.push([leg.weight, concurrency]);
  });
  assert.deepEqual(given, [
    [1, 2],
    [3, 6],
  ]);
});

test('with fewer workers than legs each worker runs legs one at a time', async () => {
  const legs = Array.from({ length: 4 }, () => ({ weight: 5 }));
  let active = 0;
  await runGateLegs(legs, 2, async (_, concurrency) => {
    assert.equal(concurrency, 1);
    assert.ok(++active <= 2);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
  });
});

test('an empty gate has no work and an invalid budget is rejected', async () => {
  await runGateLegs([], 2, () => assert.fail('nothing to run'));
  await assert.rejects(
    runGateLegs([{}], 0, () => {}),
    /positive integer/
  );
});
