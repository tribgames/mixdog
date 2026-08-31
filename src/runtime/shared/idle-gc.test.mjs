import assert from 'node:assert/strict';
import test from 'node:test';

import { collectGarbageNow, createIdleGc } from './idle-gc.mjs';

async function withEnv(vars, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('a full collection runs without --expose-gc at launch', async () => {
  assert.equal(await collectGarbageNow(), true);
});

test('work in flight defers the sweep', async () => {
  const gc = createIdleGc({ isBusy: () => true });
  assert.equal(await gc._tickForTest(), 'busy');
});

test('a probe that throws counts as busy rather than pausing mid-turn', async () => {
  const gc = createIdleGc({ isBusy: () => { throw new Error('probe down'); } });
  assert.equal(await gc._tickForTest(), 'busy');
});

test('an idle host still settles before its first sweep', async () => {
  const gc = createIdleGc({ isBusy: () => false });
  assert.equal(await gc._tickForTest(), 'settling');
});

test('a heap below the floor with no committed slack is left alone', async () => {
  await withEnv({
    MIXDOG_IDLE_GC_IDLE_MS: '1000',
    MIXDOG_IDLE_GC_MIN_HEAP_MB: '65536',
    MIXDOG_IDLE_GC_MIN_SLACK_MB: '65536',
  }, async () => {
    const gc = createIdleGc({ isBusy: () => false });
    await sleep(1100);
    assert.equal(await gc._tickForTest(), 'small');
  });
});

test('a small heap sitting on a wide committed gap is still swept', async () => {
  // The live daemon's shape: a heap far below any sane floor, on a committed
  // total large enough that the pages are worth handing back.
  await withEnv({
    MIXDOG_IDLE_GC_IDLE_MS: '1000',
    MIXDOG_IDLE_GC_MIN_HEAP_MB: '65536',
    MIXDOG_IDLE_GC_MIN_SLACK_MB: '0',
  }, async () => {
    const gc = createIdleGc({ isBusy: () => false });
    await sleep(1100);
    assert.equal(await gc._tickForTest(), 'swept');
  });
});

test('an idle host sweeps once, then waits for real growth', async () => {
  await withEnv({ MIXDOG_IDLE_GC_IDLE_MS: '1000', MIXDOG_IDLE_GC_MIN_HEAP_MB: '0' }, async () => {
    const lines = [];
    const gc = createIdleGc({ isBusy: () => false, log: (line) => lines.push(line) });
    await sleep(1100);
    assert.equal(await gc._tickForTest(), 'swept');
    assert.match(
      lines.join('\n'),
      /idle gc: heapUsed [\d.]+ -> [\d.]+ MB \(reclaimed -?[\d.]+ MB\) in \d+ms/,
    );
    // Nothing allocated since, so the next cycle must not burn another sweep.
    assert.equal(await gc._tickForTest(), 'unchanged');
  });
});

test('MIXDOG_IDLE_GC=0 keeps the timer disarmed', async () => {
  await withEnv({ MIXDOG_IDLE_GC: '0' }, async () => {
    const gc = createIdleGc({ isBusy: () => false });
    assert.equal(gc.arm(), false);
    assert.equal(gc.armed, false);
  });
});

test('arm is idempotent and disarm stops the timer', async () => {
  const gc = createIdleGc({ isBusy: () => false });
  assert.equal(gc.arm(), true);
  assert.equal(gc.arm(), false, 'second arm must not stack a second interval');
  assert.equal(gc.armed, true);
  gc.disarm();
  assert.equal(gc.armed, false);
});
