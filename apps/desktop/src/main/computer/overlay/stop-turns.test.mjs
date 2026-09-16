import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmComputerTurnsStopped } from './stop-turns.ts';
import { createComputerOverlayController } from './controls.ts';
import { computerUseOverlayPresentation } from './model.ts';

test('every owner receives Stop even when one abort fails; raw errors never reach the pill', async () => {
  const calls = [];
  await assert.rejects(confirmComputerTurnsStopped(['a', 'b'], async id => {
    calls.push(id);
    if (id === 'a') throw new Error('private runtime error');
  }), error => {
    assert.match(error.message, /computer_stop_unconfirmed/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.deepEqual(calls, ['a', 'b']);
  await confirmComputerTurnsStopped([], async () => { assert.fail('no owner to abort'); });
});

test('a missing daemon reply expires and a late reply cannot turn the failure into success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const pending = confirmComputerTurnsStopped(['a'], () => new Promise(resolve => { finish = resolve; }));
  const rejected = assert.rejects(pending, /computer_stop_unconfirmed.*timed out/);
  t.mock.timers.tick(10_000);
  await rejected;
  finish();
  await assert.rejects(pending, /computer_stop_unconfirmed/);
});

test('repeated Stop shares one completion and a failed Stop can be retried', async () => {
  let calls = 0, fail;
  const controller = createComputerOverlayController({
    resume: async () => {},
    stop: async () => {
      calls++;
      if (calls === 1) await new Promise((_, reject) => { fail = reject; });
    },
  }, () => {});
  const first = controller.invoke('stop', 1, ['fixture']);
  const second = controller.invoke('stop', 2, ['fixture']);
  assert.equal(first, second);
  assert.equal(calls, 1);
  fail(new Error('computer_stop_unconfirmed'));
  await Promise.all([first, second]);
  assert.deepEqual(controller.state(3), { busy: false, error: 'stop' });
  const presentation = computerUseOverlayPresentation({
    revision: 1, userControlActive: true, takeoverReason: 'user_stop', takeoverGeneration: 3,
    cleanupState: 'ready', pausedSessionIds: ['fixture'], activities: [], cursors: [], targetLeases: [],
  }, 'ko', controller.state(3));
  assert.equal(presentation.canResume, false);
  assert.equal(presentation.attention, true);
  assert.equal(presentation.canDismiss, true);
  await controller.invoke('stop', 3, ['fixture']);
  assert.equal(calls, 2);
  assert.deepEqual(controller.state(4), { busy: false, error: '' });
});

test('target-local cleanup failure remains a cleanup error across Stop generations', async () => {
  const controller = createComputerOverlayController({
    resume: async () => {},
    stop: async () => { throw new Error('computer_background_cleanup_unconfirmed'); },
  }, () => {});
  await controller.invoke('stop', 1, []);
  assert.equal(controller.state(2).error, 'cleanup');
});
