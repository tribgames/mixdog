import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createComputerPillSource } from './computer-pill.ts';
import { COMPUTER_USER_CONTROL, createComputerPillControls, createCoreUserControl } from './computer-user-control.ts';
import { computerUseOverlayPresentation } from '../computer/overlay/model.ts';

const open = { active: true, observeOnly: false, controller: null, sessionThreadId: 'th1', sessions: [{ sessionThreadId: 'th1', observeOnly: false }] };

test('the pill actions send computer/userControl and settle whatever the core answers', async () => {
  const sent = [];
  const control = createCoreUserControl(async (method, params) => {
    sent.push([method, params]);
    return { ok: sent.length === 1 };
  });
  await control.resume();
  await control.stop();
  assert.deepEqual(sent, [
    [COMPUTER_USER_CONTROL, { action: 'resume' }],
    [COMPUTER_USER_CONTROL, { action: 'stop' }],
  ]);
  const failing = createCoreUserControl(async () => {
    throw new Error('core unavailable');
  });
  await assert.rejects(failing.resume(), /core unavailable/);
});

test('a takeover in the computer section pauses the pill, which then offers Resume', () => {
  const source = createComputerPillSource(() => 5);
  source.apply({ ...open, userControl: { active: true, reason: 'input_cleanup_unconfirmed', resumeMode: 'manual' } });
  const snapshot = source.snapshot();
  assert.equal(snapshot.userControlActive, true);
  assert.equal(snapshot.takeoverReason, 'input_cleanup_unconfirmed');
  assert.deepEqual(snapshot.pausedSessionIds, ['th1']);
  const presentation = computerUseOverlayPresentation(snapshot);
  assert.equal(presentation.paused, true);
  assert.equal(presentation.resumable, true);
  source.apply({ ...open, userControl: null });
  assert.equal(source.snapshot().userControlActive, false);
  assert.equal(source.snapshot().takeoverReason, undefined);
});

test('a yield offers Resume only when the core will not resume it by itself', () => {
  const source = createComputerPillSource(() => 5);
  source.apply({ ...open, userControl: { active: false, reason: 'user_input_active', resumeMode: 'idle' } });
  assert.deepEqual(source.snapshot().yieldedSessionIds, ['th1']);
  assert.equal(source.snapshot().userControlActive, false);
  assert.equal(computerUseOverlayPresentation(source.snapshot()).resumable, false);
  source.apply({ ...open, userControl: { active: false, reason: 'user_input_active', resumeMode: 'manual' } });
  assert.equal(computerUseOverlayPresentation(source.snapshot()).resumable, true);
});

function pillControls(section) {
  const source = createComputerPillSource(() => 5);
  if (section) source.apply(section);
  const sent = [];
  const host = [];
  const controls = createComputerPillControls({
    core: createCoreUserControl(async (method, params) => {
      sent.push(params.action);
      return { ok: true };
    }),
    mirror: source,
    abortSession: async (id) => sent.push(`abort ${id}`),
    host: {
      pause: async () => host.push('pause'),
      resume: async (generation) => host.push(`resume ${generation}`),
      stop: async (ids) => host.push(`stop ${ids}`),
      configureIdleResume: (seconds) => host.push(`idle ${seconds}`),
    },
  });
  return { controls, sent, host };
}

test('while the core owns the computer the pill, the renderer-death pause and the shortcut go to the core', async () => {
  const { controls, sent, host } = pillControls(open);
  await controls.stop(['th1']);
  await controls.resume(3);
  await controls.pause();
  assert.deepEqual(sent, ['stop', 'abort th1', 'resume', 'pause']);
  assert.deepEqual(host, []);
});

test("the core's Stop failing still ends the turns, and the Stop reports the failure", async () => {
  const source = createComputerPillSource(() => 5);
  source.apply(open);
  const aborted = [];
  const controls = createComputerPillControls({
    core: createCoreUserControl(async () => {
      throw new Error('core gone');
    }),
    mirror: source,
    abortSession: async (id) => aborted.push(id),
    host: { pause: async () => {}, resume: async () => {}, stop: async () => {} },
  });
  await assert.rejects(controls.stop(['th1']), /core gone/);
  assert.deepEqual(aborted, ['th1']);
});

test("with no core session the desktop's own computer host keeps the pill actions", async () => {
  const { controls, sent, host } = pillControls(null);
  await controls.stop(['th1']);
  await controls.resume(3);
  await controls.pause();
  assert.deepEqual(sent, []);
  assert.deepEqual(host, ['stop th1', 'resume 3', 'pause']);
});

test('the idle-resume setting reaches the core without a session, and the desktop host as well where there is one', async () => {
  const { controls, sent, host } = pillControls(null);
  controls.configureIdleResume(9);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ['configureIdleResume']);
  assert.deepEqual(host, ['idle 9']);
});

test("a section that names the desktop's own host as the backend keeps every control, the setting included, off the core", async () => {
  const { controls, sent, host } = pillControls({ ...open, backend: 'desktopHost' });
  await controls.pause();
  await controls.resume(2);
  controls.configureIdleResume(4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, []);
  assert.deepEqual(host, ['pause', 'resume 2', 'idle 4']);
});

test('the setting and the pill actions go to the core where the desktop has no host of its own', async () => {
  const source = createComputerPillSource(() => 5);
  const sent = [];
  const controls = createComputerPillControls({
    core: createCoreUserControl(async (method, params) => {
      sent.push(params.seconds === undefined ? params.action : `${params.action} ${params.seconds}`);
      return { ok: true };
    }),
    mirror: source,
    abortSession: async (id) => sent.push(`abort ${id}`),
  });
  await controls.pause();
  await controls.resume(1);
  controls.configureIdleResume(30);
  await controls.stop(['th1']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ['pause', 'resume', 'configureIdleResume 30', 'stop', 'abort th1']);
});

test('a shortcut that failed to register is said by the pill', () => {
  const snapshot = createComputerPillSource(() => 5).snapshot();
  assert.equal(computerUseOverlayPresentation(snapshot).shortcutUnavailable, undefined);
  assert.match(computerUseOverlayPresentation(snapshot, 'en', { shortcutUnavailable: true }).shortcutUnavailable, /Ctrl\+Alt\+Esc/);
});
