import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerUseCoordinator } from '../session/coordinator.ts';
import { computerUseOverlayPresentation } from '../overlay/model.ts';
import { createComputerOverlayController } from '../overlay/controls.ts';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { createExecutionState } from './execution-state.ts';

function fixture(runOverride) {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  const released = [];
  const commands = [];
  const observations = new Map([['a', 'old-ref']]);
  const workers = new Map();
  const nativeCalls = [];
  const lifecycle = createSessionLifecycle({
    coordinator, execution, powerShellBySession: workers, workerLastUsedAt: new Map(),
    retirePowerShell() {}, callPowerShell: async (request) => { nativeCalls.push(request.action); return { ok: true }; },
    cancelElevatedSession: async () => true, elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState: (id) => { released.push(id); observations.delete(id); }, invalidateWorkerGeneration() {},
    releaseCaptureSession() {}, cleanupInput: async () => true,
    runCommand: async (command) => { commands.push(command.action); return runOverride ? runOverride(command) : { text: '{"ok":true}' }; },
    recaptureRequiredReply: async () => null,
  });
  coordinator.beginCommand({ sessionId: 'a', action: 'click', mode: 'foreground' });
  coordinator.pauseForUser('user_input_active');
  return { coordinator, execution, lifecycle, released, commands, observations, workers, nativeCalls };
}

async function drainingFixture() {
  let finish;
  const gate = new Promise((resolve) => { finish = () => resolve({ text: '{"ok":true}' }); });
  const f = fixture(() => gate);
  f.coordinator.resumeAfterUserTakeover();
  const running = f.lifecycle.executeSerialized({ action: 'capture', session_id: 'a' });
  const command = running.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  f.lifecycle.takeOverComputer('user_pause');
  await f.lifecycle.waitForCleanup();
  return { ...f, finish, command };
}

test('paused UI survives session cleanup; only safe probes work, and explicit resume invalidates old observations', async () => {
  const { coordinator, lifecycle, observations, commands } = fixture();
  await lifecycle.abortComputerSession({ action: 'session_abort', session_id: 'a' });
  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.activities.length, 0);
  const model = computerUseOverlayPresentation(snapshot, 'ko');
  assert.equal(model.visible, true);
  assert.equal(model.canResume, true);
  assert.deepEqual(model.sessionIds, ['a']);
  for (const action of ['list_windows', 'list_apps', 'diagnose']) {
    await lifecycle.executeSerialized({ action, session_id: 'a' });
  }
  let completed = false;
  const queued = lifecycle.executeSerialized({ action: 'capture', session_id: 'a' })
    .then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  observations.set('a', 'late-old-ref');
  await lifecycle.resumeAfterTakeover(model.generation);
  await queued;
  assert.equal(observations.has('a'), false);
  assert.deepEqual(commands, ['list_windows', 'list_apps', 'diagnose', 'capture']);
  assert.equal(coordinator.snapshot().userControlActive, false);
  coordinator.reset();
});

test('cleanup and new takeover generations cannot be cleared by a stale resume click', async () => {
  const { coordinator, lifecycle } = fixture();
  const generation = coordinator.snapshot().takeoverGeneration;
  const finish = coordinator.beginCleanup('a');
  assert.equal(computerUseOverlayPresentation(coordinator.snapshot()).canResume, false);
  await assert.rejects(lifecycle.resumeAfterTakeover(generation), /cleanup_pending/);
  finish(true);
  coordinator.pauseForUser('second_interruption');
  await assert.rejects(lifecycle.resumeAfterTakeover(generation), /resume_stale/);
  assert.equal(coordinator.snapshot().userControlActive, true);
  await lifecycle.resumeAfterTakeover(coordinator.snapshot().takeoverGeneration);
  coordinator.reset();
});

test('failed cleanup remains blocked with visible guidance, including after reset', async () => {
  const { coordinator, lifecycle } = fixture();
  const finish = coordinator.beginCleanup('a');
  finish(false);
  coordinator.reset();
  const state = computerUseOverlayPresentation(coordinator.snapshot(), 'ko');
  assert.equal(state.visible, true);
  assert.equal(state.canResume, false);
  assert.equal(state.attention, true);
  await assert.rejects(lifecycle.resumeAfterTakeover(state.generation), /cleanup_pending/);
});

test('UI coalesces duplicate requests and retains actionable errors without raw payloads', async () => {
  let finish;
  let resumed = 0;
  let stopped = 0;
  const gate = new Promise((resolve) => { finish = resolve; });
  const control = createComputerOverlayController({
    resume: async () => { resumed++; await gate; throw new Error('computer_resume_stale: private payload'); },
    stop: async () => { stopped++; },
  }, () => {});
  const pending = control.invoke('resume', 2, ['a']);
  await control.invoke('resume', 2, ['a']);
  assert.equal(resumed, 1);
  assert.equal(control.state(2).busy, true);
  finish(); await pending;
  assert.equal(control.state(2).error, 'stale');
  assert.equal(control.state(3).error, '');
  await control.invoke('stop', 3, ['a']);
  assert.equal(stopped, 1);
});

test('an interruption during the resume drain invalidates the pending request without releasing newer observations', async () => {
  const { coordinator, lifecycle, released, finish, command } = await drainingFixture();
  const releasedBefore = released.length;
  const generation = coordinator.snapshot().takeoverGeneration;
  const pending = lifecycle.resumeAfterTakeover(generation);
  await Promise.resolve();
  coordinator.pauseForUser('new_input');
  finish();
  await assert.rejects(pending, /resume_stale/);
  await command;
  assert.equal(released.length, releasedBefore);
  assert.equal(coordinator.snapshot().userControlActive, true);
  coordinator.reset();
});

test('native interruption stops the active input but retains a queued read through resume', async () => {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  let calls = 0;
  const lifecycle = createSessionLifecycle({
    coordinator, execution, powerShellBySession: new Map(), workerLastUsedAt: new Map(),
    retirePowerShell() {}, callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true, elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {}, invalidateWorkerGeneration() {}, releaseCaptureSession() {},
    cleanupInput: async () => true,
    runCommand: async (command) => {
      calls++;
      if (command.action === 'type') throw new Error('user_input_active: input interrupted');
      return { text: 'fresh capture' };
    },
    recaptureRequiredReply: async () => null,
  });
  const interrupted = lifecycle.executeSerialized({ action: 'type', session_id: 'a', delivery: 'background' });
  let completed = false;
  const queued = lifecycle.executeSerialized({ action: 'capture', session_id: 'a', delivery: 'background' })
    .then((value) => { completed = true; return value; });
  await assert.rejects(interrupted, /user_input_active/);
  await lifecycle.waitForCleanup();
  assert.equal(calls, 1);
  assert.equal(completed, false);
  assert.equal(coordinator.snapshot().userControlActive, true);
  await lifecycle.resumeAfterTakeover(coordinator.snapshot().takeoverGeneration);
  assert.equal((await queued).text, 'fresh capture');
  assert.equal(calls, 2);
  coordinator.reset();
});

test('paused session release never invokes native restoration of the former foreground window', async () => {
  const { coordinator, lifecycle, workers, nativeCalls } = fixture();
  workers.set('a', { killed: false, exitCode: 0, signalCode: null });
  await lifecycle.releaseComputerSession({ action: 'session_release', session_id: 'a' });
  assert.deepEqual(nativeCalls, []);
  assert.equal(coordinator.snapshot().userControlActive, true);
  coordinator.reset();
});

test('cancelling a resume drain prevents a late command from releasing the pause', async () => {
  const { coordinator, lifecycle, released, finish, command } = await drainingFixture();
  const releasedBefore = released.length;
  const abort = new AbortController();
  const pending = lifecycle.resumeAfterTakeover(coordinator.snapshot().takeoverGeneration, abort.signal);
  abort.abort();
  await assert.rejects(pending, /resume_cancelled/);
  finish();
  await command;
  assert.equal(coordinator.snapshot().userControlActive, true);
  assert.equal(released.length, releasedBefore);
  coordinator.reset();
});

test('Stop cancels a pending resume without waiting for it', async () => {
  let signal;
  let finish;
  let stopped = false;
  const control = createComputerOverlayController({
    resume: async (_, cancellation) => { signal = cancellation; await new Promise((resolve) => { finish = resolve; }); },
    stop: async () => { stopped = true; },
  }, () => {});
  const pending = control.invoke('resume', 1, ['a']);
  await control.invoke('stop', 1, ['a']);
  assert.equal(signal.aborted, true);
  assert.equal(stopped, true);
  finish(); await pending;
  assert.equal(control.state(1).busy, false);
});

test('pause cancels a pending resume without calling the task-ending stop control', async () => {
  let signal, finish;
  let pauses = 0, stops = 0;
  const control = createComputerOverlayController({
    resume: async (_, cancellation) => { signal = cancellation; await new Promise((resolve) => { finish = resolve; }); },
    pause: async () => { pauses++; },
    stop: async () => { stops++; },
  }, () => {});
  const pending = control.invoke('resume', 2, ['a']);
  await control.invoke('pause', 2, ['a']);
  assert.equal(signal.aborted, true);
  assert.equal(pauses, 1);
  assert.equal(stops, 0);
  finish(); await pending;
  assert.equal(control.state(2).busy, false);
});
