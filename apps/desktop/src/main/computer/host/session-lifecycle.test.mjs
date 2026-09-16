import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { createExecutionState } from './execution-state.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';

for (const turnFailure of [false, true]) {
  test(`Stop cleans native input before the daemon replies and keeps failures paused (${turnFailure})`, async () => {
    const coordinator = new ComputerUseCoordinator();
    const execution = createExecutionState();
    execution.activeExecutionsBySession.set('fixture', { sessionId: 'fixture', aborted: false });
    let nativeStopped = false;
    const host = createSessionLifecycle({
      coordinator, execution, powerShellBySession: new Map(), workerLastUsedAt: new Map(),
      retirePowerShell() {}, callPowerShell: async () => ({ ok: true }),
      cancelElevatedSession: async () => { nativeStopped = true; return true; },
      elevatedSessionIds: () => ['fixture'], sessionIdFor: command => command.session_id,
      releaseSessionState() {}, invalidateWorkerGeneration() {}, releaseCaptureSession() {},
      cleanupInput: async () => true,
      runCommand: async () => ({ text: '' }), recaptureRequiredReply: async () => null,
    });
    let confirm, fail;
    const turns = new Promise((resolve, reject) => { confirm = resolve; fail = reject; });
    coordinator.pauseForUser('user_stop', ['fixture']);
    const stopping = host.stopAllComputerSessions(true, turns);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nativeStopped, true, 'daemon latency must not delay native input cancellation');
    assert.equal(coordinator.snapshot().cleanupState, 'ready');
    assert.equal(coordinator.snapshot().userControlActive, true);
    if (turnFailure) {
      const rejected = assert.rejects(stopping, /computer_stop_unconfirmed/);
      fail(new Error('computer_stop_unconfirmed'));
      await rejected;
      confirm();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(coordinator.snapshot().userControlActive, true);
      assert.throws(() => coordinator.assertAutomationAllowed());
    } else {
      confirm();
      await stopping;
      coordinator.assertAutomationAllowed();
      assert.equal(coordinator.snapshot().userControlActive, false);
    }
    coordinator.reset();
  });
}

test('abort does not report cleanup success before elevated termination is confirmed', async () => {
  for (const confirmed of [true, false]) {
    const computerUseCoordinator = new ComputerUseCoordinator();
    let confirm;
    let cancellationRequested = false;
    const stopped = new Promise((resolve) => { confirm = resolve; });
    const execution = createExecutionState();
    const active = { sessionId: 'test', aborted: false };
    execution.activeExecutionsBySession.set('test', active);
    const host = createSessionLifecycle({
      coordinator: computerUseCoordinator,
      powerShellBySession: new Map(),
      workerLastUsedAt: new Map(),
      retirePowerShell() {},
      callPowerShell: async () => ({ ok: true }),
      cancelElevatedSession: () => { cancellationRequested = true; return stopped; },
      elevatedSessionIds: () => ['test'],
      sessionIdFor: () => 'test',
      releaseSessionState() {},
      invalidateWorkerGeneration() {},
      releaseCaptureSession() {},
      execution,
      runCommand: async () => ({ text: '' }),
      recaptureRequiredReply: async () => null,
    });
    let finished = false;
    const abort = host.abortComputerSession({ action: 'session_abort', session_id: 'test' })
      .finally(() => { finished = true; });
    await Promise.resolve();
    assert.equal(cancellationRequested, true);
    assert.equal(active.aborted, true);
    assert.equal(finished, false);
    confirm(confirmed);
    if (confirmed) assert.match((await abort).text, /session aborted/);
    else {
      await assert.rejects(abort, /computer_abort_cleanup_unconfirmed/);
      assert.throws(() => computerUseCoordinator.resumeAfterUserTakeover(), /computer_cleanup_pending/);
    }
  }
});

test('Stop clears a paused session even after its worker and activity have already disappeared', async () => {
  const coordinator = new ComputerUseCoordinator();
  const stopped = [];
  const host = createSessionLifecycle({
    coordinator, execution: createExecutionState(),
    powerShellBySession: new Map(), workerLastUsedAt: new Map(),
    retirePowerShell() {}, callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async id => { stopped.push(id); return true; },
    elevatedSessionIds: () => [], sessionIdFor: command => command.session_id,
    releaseSessionState() {}, invalidateWorkerGeneration() {}, releaseCaptureSession() {},
    cleanupInput: async () => true,
    runCommand: async () => ({ text: '' }), recaptureRequiredReply: async () => null,
  });
  coordinator.pauseForUser('input_observation_unavailable', ['retired-fixture']);
  coordinator.cancelSession('retired-fixture');
  assert.equal(coordinator.snapshot().activities.length, 0);
  await host.stopAllComputerSessions();
  assert.deepEqual(stopped, ['retired-fixture']);
  assert.equal(coordinator.snapshot().userControlActive, false);
  assert.deepEqual(coordinator.snapshot().pausedSessionIds ?? [], []);
});

test('Stop clears a latched cleanup failure only after every worker exited and held input was released', async () => {
  const coordinator = new ComputerUseCoordinator();
  let workersAlive = true;
  let releaseOk = true;
  let sweeps = 0;
  const host = createSessionLifecycle({
    coordinator, execution: createExecutionState(),
    powerShellBySession: new Map(), workerLastUsedAt: new Map(),
    retirePowerShell() {}, callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true, elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {}, invalidateWorkerGeneration() {}, releaseCaptureSession() {},
    cleanupInput: async (recovery) => { if (!recovery) sweeps++; return releaseOk; },
    waitForResidentWorkersExit: async () => !workersAlive,
    runCommand: async () => ({ text: '' }), recaptureRequiredReply: async () => null,
  });
  coordinator.beginCleanup('a')(false);
  assert.equal(coordinator.snapshot().cleanupState, 'failed');
  await assert.rejects(host.stopAllComputerSessions(), /computer_abort_cleanup_unconfirmed: input workers are still running/);
  assert.equal(coordinator.snapshot().cleanupState, 'failed');
  assert.equal(sweeps, 0);
  workersAlive = false;
  releaseOk = false;
  await assert.rejects(host.stopAllComputerSessions(), /computer_abort_cleanup_unconfirmed: held input/);
  assert.equal(coordinator.snapshot().cleanupState, 'failed');
  releaseOk = true;
  await host.stopAllComputerSessions();
  assert.equal(coordinator.snapshot().cleanupState, 'ready');
  assert.equal(sweeps, 2);
  coordinator.assertAutomationAllowed();
});

test('Stop cannot use global key release as proof of target-local message cleanup', async () => {
  const coordinator = new ComputerUseCoordinator();
  let released = 0;
  const host = createSessionLifecycle({
    coordinator, execution: createExecutionState(),
    powerShellBySession: new Map(), workerLastUsedAt: new Map(),
    retirePowerShell() {}, callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true, elevatedSessionIds: () => [],
    sessionIdFor: command => command.session_id,
    releaseSessionState() {}, invalidateWorkerGeneration() {}, releaseCaptureSession() {},
    waitForResidentWorkersExit: async () => true,
    cleanupInput: async () => { released++; return true; },
    hasUnconfirmedBackgroundInput: () => true,
    runCommand: async () => ({ text: '' }), recaptureRequiredReply: async () => null,
  });
  coordinator.beginCleanup('background')(false);
  await assert.rejects(host.stopAllComputerSessions(), /computer_background_cleanup_unconfirmed/);
  assert.equal(released, 1);
  assert.equal(coordinator.snapshot().cleanupState, 'failed');
  assert.throws(() => coordinator.assertAutomationAllowed(), /computer_cleanup_pending/);
});

test('abort keeps target acquisition and resume blocked until worker exit AND input cleanup finish', async () => {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  execution.activeExecutionsBySession.set('a', { sessionId: 'a', aborted: false });
  let exitWorker;
  let cleanInput;
  const stopped = new Promise((resolve) => { exitWorker = resolve; });
  const cleaned = new Promise((resolve) => { cleanInput = resolve; });
  const host = createSessionLifecycle({
    coordinator, execution, powerShellBySession: new Map(), workerLastUsedAt: new Map(),
    retirePowerShell() {}, callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: () => stopped, elevatedSessionIds: () => ['a'],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {}, invalidateWorkerGeneration() {}, releaseCaptureSession() {},
    cleanupInput: () => cleaned, runCommand: async () => ({ text: '' }), recaptureRequiredReply: async () => null,
  });
  await host.claimComputerTargets({ session_id: 'a' }, ['hwnd:0x1']);
  const aborted = host.abortComputerSession({ action: 'session_abort', session_id: 'a' });
  await assert.rejects(host.claimComputerTargets({ session_id: 'b' }, ['hwnd:0x1']), /computer_cleanup_pending/);
  assert.throws(() => coordinator.resumeAfterUserTakeover(), /computer_cleanup_pending/);
  exitWorker(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => coordinator.assertAutomationAllowed(), /computer_cleanup_pending/);
  cleanInput(true);
  await aborted;
  coordinator.resumeAfterUserTakeover();
  await host.claimComputerTargets({ session_id: 'b' }, ['hwnd:0x1']);
  coordinator.reset();
});
