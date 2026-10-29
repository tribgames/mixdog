import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterGroups,
  gateTestBudget,
  measuredFileTimes,
  planShards,
  readTimingHistory,
  runPool,
  saveTimingHistory,
} from './lib/gate-scheduler.mjs';

test('the gate pool defaults to half the cores up to 8; an explicit budget wins, the argument first', () => {
  assert.equal(gateTestBudget([], {}, 20), 8);
  assert.equal(gateTestBudget([], {}, 32), 8);
  assert.equal(gateTestBudget([], {}, 8), 4);
  assert.equal(gateTestBudget([], {}, 1), 1);
  assert.equal(gateTestBudget([], { MIXDOG_TEST_CONCURRENCY: '3' }, 20), 3);
  assert.equal(gateTestBudget(['--test-concurrency=5'], { MIXDOG_TEST_CONCURRENCY: '3' }, 20), 5);
  assert.equal(gateTestBudget(['--test-concurrency', '24'], {}, 20), 24);
  assert.throws(() => gateTestBudget(['--test-concurrency=0'], {}, 20), /positive integer/);
  assert.throws(() => gateTestBudget([], { MIXDOG_TEST_CONCURRENCY: 'many' }, 20), /positive integer/);
});

test('a --test-concurrency flag without a valid value throws, even over a valid environment budget', () => {
  for (const env of [{}, { MIXDOG_TEST_CONCURRENCY: '3' }]) {
    assert.throws(() => gateTestBudget(['--test-concurrency'], env, 20), /positive integer/);
    assert.throws(() => gateTestBudget(['--test-concurrency='], env, 20), /positive integer/);
    assert.throws(() => gateTestBudget(['--test-concurrency', '--other'], env, 20), /positive integer/);
  }
});

const scratch = () => mkdtempSync(join(tmpdir(), 'gate-scheduler-test-'));

test('missing, unreadable or malformed timing history counts as none; invalid estimates are dropped', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'timings.json');
  assert.deepEqual(readTimingHistory(file), {});
  assert.deepEqual(readTimingHistory(dir), {});
  for (const body of ['{not json', 'null', '[]', '{}', '{"ms":null}', '{"ms":[1,2]}', '{"ms":"x"}']) {
    writeFileSync(file, body);
    assert.deepEqual(readTimingHistory(file), {}, body);
  }
  writeFileSync(file, JSON.stringify({ ms: { a: 5, b: 0, c: -1, d: 'x', e: null, f: 2.5, g: 1e400 } }));
  assert.deepEqual(readTimingHistory(file), { a: 5, f: 2.5 });
});

test('a lane planned from invalid history still gets shards: every file falls back to its default', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'timings.json');
  writeFileSync(file, JSON.stringify({ ms: { 'x.test.mjs': 'slow', 'y.test.mjs': -3 } }));
  const history = readTimingHistory(file);
  const shards = planShards(
    [{ name: 'fast', files: ['x.test.mjs', 'y.test.mjs'], estimateOf: (f) => history[f] ?? 2_000 }],
    2
  );
  assert.deepEqual(shards.flatMap((shard) => shard.files).sort(), ['x.test.mjs', 'y.test.mjs']);
});

test('timing saves use their own temp file, leave none behind, and report failure instead of throwing', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'timings.json');
  // A stale shared temp name from an older gate does not interfere.
  writeFileSync(`${file}.tmp`, 'stale');
  assert.equal(saveTimingHistory(file, { a: 1 }), null);
  assert.equal(saveTimingHistory(file, { a: 2 }), null);
  assert.deepEqual(readTimingHistory(file), { a: 2 });
  assert.deepEqual(readdirSync(dir).sort(), ['timings.json', 'timings.json.tmp']);
  // The target cannot be written (a directory is in its place): an error is returned.
  const blocked = join(dir, 'blocked');
  mkdirSync(blocked);
  const error = saveTimingHistory(blocked, { a: 3 });
  assert.ok(error instanceof Error);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith('blocked.')), []);
  assert.equal(saveTimingHistory(join(dir, 'missing', 'timings.json'), { a: 4 }) instanceof Error, true);
});

test('a file whose path contains another file path shares its shard, since filters match substrings', () => {
  const groups = filterGroups(['a/x.test.mjs', 'b/a/x.test.mjs', 'c.test.mjs', 'd/b/a/x.test.mjs']);
  assert.deepEqual(groups.map((group) => group.sort()).sort(), [
    ['a/x.test.mjs', 'b/a/x.test.mjs', 'd/b/a/x.test.mjs'],
    ['c.test.mjs'],
  ]);
});

const lane = (name, times) => ({ name, files: Object.keys(times), estimateOf: (file) => times[file] });

test('shards cover every lane file once, keep their lane, run a long file alone and balance the rest', () => {
  const fast = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}.test.mjs`, 2_000]));
  const slow = { 'big.slow.test.mjs': 110_000, 's1.slow.test.mjs': 30_000, 's2.slow.test.mjs': 20_000 };
  const lanes = [lane('fast', fast), lane('slow', slow), lane('empty', {})];
  // 560 s of work on 2 workers: 35 s shards.
  const shards = planShards(lanes, 2);
  for (const { name, files } of lanes) {
    const covered = shards.filter((shard) => shard.lane === name).flatMap((shard) => shard.files);
    assert.deepEqual(covered.sort(), [...files].sort());
  }
  assert.ok(shards.some((shard) => shard.files.length === 1 && shard.files[0] === 'big.slow.test.mjs'));
  const fastShards = shards.filter((shard) => shard.lane === 'fast');
  assert.equal(fastShards.length, Math.round(400_000 / 35_000));
  const sizes = fastShards.map((shard) => shard.estimate);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 2_000);
  for (const shard of shards) assert.equal(shard.estimate, shard.files.reduce((s, f) => s + { ...fast, ...slow }[f], 0));
});

test('more workers cut smaller shards, down to a floor that bounds per-shard start-up', () => {
  const times = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f${i}.test.mjs`, 1_000]));
  // 400 s of work, eight shards per worker.
  assert.equal(planShards([lane('fast', times)], 1).length, 8);
  assert.equal(planShards([lane('fast', times)], 2).length, 16);
  // 5 workers would mean 10 s shards; the 15 s floor wins.
  assert.equal(planShards([lane('fast', times)], 5).length, Math.round(400_000 / 15_000));
});

test('a shard measures each file as its reported time plus an equal share of the unreported wall time', () => {
  assert.deepEqual(measuredFileTimes(['a', 'b', 'c'], { a: 5_000, b: 1_000 }, 9_000), { a: 6_000, b: 2_000, c: 1_000 });
  assert.deepEqual(measuredFileTimes(['a'], { a: 5_000 }, 4_000), { a: 5_000 });
});

for (const budget of [1, 2, 6]) {
  test(`the pool runs every unit within ${budget} worker(s), longest first, failed units included`, async () => {
    const units = [3, 9, 1, 7, 5].map((estimate) => ({ estimate }));
    const order = [];
    let active = 0;
    let peak = 0;
    const left = await runPool(units, budget, async (unit) => {
      peak = Math.max(peak, ++active);
      order.push(unit.estimate);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return unit.estimate !== 7;
    });
    assert.deepEqual(left, []);
    assert.equal(peak, Math.min(budget, units.length));
    assert.deepEqual(order, [9, 7, 5, 3, 1]);
    assert.deepEqual(
      units.map((unit) => unit.ok),
      [true, true, true, false, true]
    );
  });
}

test('a worker freed by one lane starts the next unit of any lane while a long unit still runs', async () => {
  const units = [
    { id: 'slow lane', estimate: 30 },
    { id: 'fast lane 1', estimate: 10 },
    { id: 'fast lane 2', estimate: 10 },
    { id: 'fast lane 3', estimate: 10 },
  ];
  const finish = new Map();
  const events = [];
  const pool = runPool(units, 2, (unit) => {
    events.push(`start ${unit.id}`);
    return new Promise((resolve) => finish.set(unit.id, () => resolve(true)));
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  for (const id of ['fast lane 1', 'fast lane 2', 'fast lane 3', 'slow lane']) {
    await tick();
    events.push(`end ${id}`);
    finish.get(id)();
  }
  assert.deepEqual(await pool, []);
  assert.deepEqual(events, [
    'start slow lane',
    'start fast lane 1',
    'end fast lane 1',
    'start fast lane 2',
    'end fast lane 2',
    'start fast lane 3',
    'end fast lane 3',
    'end slow lane',
  ]);
});

test('a failed stop-on-fail unit stops new starts and the rest are returned unstarted', async () => {
  const units = [{ estimate: 9, stopOnFail: true }, { estimate: 5 }, { estimate: 1 }];
  const ran = [];
  const left = await runPool(units, 1, async (unit) => {
    ran.push(unit.estimate);
    return false;
  });
  assert.deepEqual(ran, [9]);
  assert.deepEqual(
    left.map((unit) => unit.estimate),
    [5, 1]
  );
});

test('an empty pool has no work and an invalid budget is rejected', async () => {
  assert.deepEqual(await runPool([], 2, () => assert.fail('nothing to run')), []);
  await assert.rejects(
    runPool([{ estimate: 1 }], 0, () => {}),
    /positive integer/
  );
});
