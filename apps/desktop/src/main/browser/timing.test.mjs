import assert from 'node:assert/strict';
import test from 'node:test';
import { browserFailureTiming, measureBrowserMouseEvent, measureBrowserPhase, measureBrowserStep, timeBrowserCommand, timedBrowserOperation } from './timing.ts';

test('parallel commands have isolated phase counts and unchanged page content', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const first = timeBrowserCommand(12, async () => {
    await measureBrowserPhase('wait', () => barrier);
    await timedBrowserOperation('snapshot', async () => 'captured')();
    return { text: 'first' };
  });
  const second = await timeBrowserCommand(3, async () => {
    await measureBrowserPhase('screenshot', async () => {});
    return { text: 'second' };
  });
  release();
  const result = await first;
  assert.equal(result.text, 'first');
  assert.equal(second.text, 'second');
  assert.equal(result.timing.queueMs, 12);
  assert.equal(result.timing.snapshots, 1);
  assert.equal(result.timing.screenshots, 0);
  assert.equal(second.timing.queueMs, 3);
  assert.equal(second.timing.snapshots, 0);
  assert.equal(second.timing.screenshots, 1);
  for (const value of Object.values(result.timing)) assert.ok(Number.isFinite(value) && value >= 0);
});

test('overlapping waits are not double-counted and diagnostics preserve rejection identity', async () => {
  const result = await timeBrowserCommand(0, async () => {
    await measureBrowserPhase('wait', async () => {
      await Promise.all([
        measureBrowserPhase('wait', async () => {}),
        measureBrowserPhase('wait', async () => {}),
      ]);
    });
    return { text: 'unchanged' };
  });
  assert.ok(result.timing.waitMs <= result.timing.commandMs);
  const error = new Error('cancelled');
  await assert.rejects(
    timeBrowserCommand(0, () => measureBrowserPhase('snapshot', async () => { throw error; })),
    (caught) => caught === error,
  );
  assert.equal(await measureBrowserPhase('snapshot', async () => 7), 7);
});

test('step diagnostics attribute phases without changing returns, failures, or command isolation', async () => {
  const result = await timeBrowserCommand(0, async () => {
    assert.equal(await measureBrowserStep(1, () =>
      measureBrowserPhase('target', () => measureBrowserPhase('snapshot', async () => 7))), 7);
    const failure = new Error('input stopped');
    await assert.rejects(measureBrowserStep(2, () =>
      measureBrowserPhase('input', async () => { throw failure; })), (caught) => caught === failure);
    await measureBrowserStep(3, () => measureBrowserPhase('actionability', async () => {}));
    return { text: 'preserved' };
  });
  assert.equal(result.text, 'preserved');
  assert.deepEqual(result.timing.steps.map((step) => step.index), [1, 2, 3]);
  assert.equal(result.timing.steps[0].snapshotMs, result.timing.snapshotMs);
  assert.equal(result.timing.steps[0].targetMs, result.timing.targetMs);
  assert.equal(result.timing.steps[1].inputMs, result.timing.inputMs);
  assert.equal(result.timing.steps[2].actionabilityMs, result.timing.actionabilityMs);
  for (const step of result.timing.steps) {
    for (const value of Object.values(step)) assert.ok(Number.isFinite(value) && value >= 0);
  }
  const next = await timeBrowserCommand(0, async () => ({ text: 'next' }));
  assert.equal(next.timing.steps, undefined);
});

test('failed commands retain timing without changing a frozen error or replaying input', async () => {
  const error = Object.freeze(new Error('failed condition'));
  let dispatched = 0;
  await assert.rejects(timeBrowserCommand(4, async () => {
    await measureBrowserMouseEvent('mousePressed', async () => { dispatched++; });
    await measureBrowserPhase('wait', async () => { throw error; });
    return { text: 'unreachable' };
  }), (caught) => caught === error);
  assert.equal(dispatched, 1);
  const timing = browserFailureTiming(error);
  assert.equal(timing.queueMs, 4);
  assert.equal(timing.mouseEvents.mousePressed.count, 1);
  assert.ok(timing.commandMs >= timing.waitMs);
  assert.equal(browserFailureTiming(new Error('unrelated')), undefined);
});
