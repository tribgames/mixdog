import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInactiveLedgerRegistry, processIdentityGone } from '../backend/inactive-ledger-registry.ts';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { createExecutionState } from './execution-state.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';
import { computerUseOverlayPresentation } from '../overlay/model.ts';

test('idle native workers retire through confirmed cleanup without cancelling active or queued work', async () => {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  const children = new Map(
    ['idle', 'busy', 'queued', 'thinking', 'recent'].map((id) => [
      id,
      { killed: false, exitCode: null, signalCode: null },
    ])
  );
  const live = new Map(children);
  const released = [];
  execution.activeExecutionsBySession.set('busy', { sessionId: 'busy', aborted: false });
  execution.commandChainsBySession.set('queued', new Promise(() => {}));
  coordinator.beginCommand({ sessionId: 'thinking', action: 'type', mode: 'foreground' });
  const host = createSessionLifecycle({
    coordinator,
    execution,
    powerShellBySession: live,
    workerLastUsedAt: new Map([
      ['idle', 0],
      ['busy', 0],
      ['queued', 0],
      ['thinking', 0],
      ['recent', 60_000],
    ]),
    retirePowerShell(child) {
      child.killed = true;
      child.exitCode = 0;
      for (const [id, value] of live) if (value === child) live.delete(id);
    },
    callPowerShell: async () => {
      throw new Error('idle cleanup must not start a new worker');
    },
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState: (id) => released.push(id),
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput: async () => true,
    runCommand: async () => ({ text: '' }),
    recaptureRequiredReply: async () => null,
  });
  // 'recent' has thought for four minutes: still inside an agent's normal turn.
  host.reapIdleSessionWorkers(300_001);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.get('idle').killed, true);
  for (const id of ['busy', 'queued', 'thinking', 'recent']) assert.equal(children.get(id).killed, false, id);
  assert.deepEqual(released, ['idle']);
  assert.equal(coordinator.snapshot().cleanupState, 'ready');
  coordinator.reset();
});

for (const turnFailure of [false, true]) {
  test(`Stop cleans native input before the daemon replies and keeps failures paused (${turnFailure})`, async () => {
    const coordinator = new ComputerUseCoordinator();
    const execution = createExecutionState();
    execution.activeExecutionsBySession.set('fixture', { sessionId: 'fixture', aborted: false });
    let nativeStopped = false;
    const host = createSessionLifecycle({
      coordinator,
      execution,
      powerShellBySession: new Map(),
      workerLastUsedAt: new Map(),
      retirePowerShell() {},
      callPowerShell: async () => ({ ok: true }),
      cancelElevatedSession: async () => {
        nativeStopped = true;
        return true;
      },
      elevatedSessionIds: () => ['fixture'],
      sessionIdFor: (command) => command.session_id,
      releaseSessionState() {},
      invalidateWorkerGeneration() {},
      releaseCaptureSession() {},
      cleanupInput: async () => true,
      runCommand: async () => ({ text: '' }),
      recaptureRequiredReply: async () => null,
    });
    let confirm, fail;
    const turns = new Promise((resolve, reject) => {
      confirm = resolve;
      fail = reject;
    });
    coordinator.pauseForUser('user_stop', ['fixture']);
    const stopping = host.stopAllComputerSessions(true, turns);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nativeStopped, true, 'daemon latency must not delay native input cancellation');
    assert.equal(coordinator.snapshot().cleanupState, 'ready');
    assert.equal(coordinator.snapshot().userControlActive, true);
    if (turnFailure) {
      const rejected = assert.rejects(stopping, /computer_stop_unconfirmed/);
      fail(new Error('computer_stop_unconfirmed'));
      await rejected;
      confirm();
      await new Promise((resolve) => setImmediate(resolve));
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
    const stopped = new Promise((resolve) => {
      confirm = resolve;
    });
    const execution = createExecutionState();
    const active = { sessionId: 'test', aborted: false };
    execution.activeExecutionsBySession.set('test', active);
    const host = createSessionLifecycle({
      coordinator: computerUseCoordinator,
      powerShellBySession: new Map(),
      workerLastUsedAt: new Map(),
      retirePowerShell() {},
      callPowerShell: async () => ({ ok: true }),
      cancelElevatedSession: () => {
        cancellationRequested = true;
        return stopped;
      },
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
    const abort = host.abortComputerSession({ action: 'session_abort', session_id: 'test' }).finally(() => {
      finished = true;
    });
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
    coordinator,
    execution: createExecutionState(),
    powerShellBySession: new Map(),
    workerLastUsedAt: new Map(),
    retirePowerShell() {},
    callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async (id) => {
      stopped.push(id);
      return true;
    },
    elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {},
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput: async () => true,
    runCommand: async () => ({ text: '' }),
    recaptureRequiredReply: async () => null,
  });
  coordinator.pauseForUser('input_observation_unavailable', ['retired-fixture']);
  coordinator.cancelSession('retired-fixture');
  assert.equal(coordinator.snapshot().activities.length, 0);
  await host.stopAllComputerSessions();
  assert.deepEqual(stopped, ['retired-fixture']);
  assert.equal(coordinator.snapshot().userControlActive, false);
  assert.deepEqual(coordinator.snapshot().pausedSessionIds ?? [], []);
});

test('Stop on a finished turn that never sent its end signal leaves nothing on screen', async () => {
  const coordinator = new ComputerUseCoordinator();
  const host = createSessionLifecycle({
    coordinator,
    execution: createExecutionState(),
    powerShellBySession: new Map(),
    workerLastUsedAt: new Map(),
    retirePowerShell() {},
    callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {},
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput: async () => true,
    runCommand: async () => ({ text: '' }),
    recaptureRequiredReply: async () => null,
  });
  try {
    coordinator.beginCommand({ sessionId: 'ended-turn', action: 'click', mode: 'background' });
    coordinator.finishCommand('ended-turn');
    // The pill's Stop: take the desktop over, then stop while the daemon reports no running turn.
    host.takeOverComputer('user_stop');
    await host.stopAllComputerSessions(true, Promise.resolve());
    const presentation = computerUseOverlayPresentation(coordinator.snapshot(), 'ko');
    assert.equal(presentation.visible, false);
    assert.deepEqual(presentation.sessionIds, []);
    coordinator.assertAutomationAllowed();
  } finally {
    coordinator.reset();
  }
});

test('Stop clears a latched cleanup failure only after every worker exited and held input was released', async () => {
  const coordinator = new ComputerUseCoordinator();
  let workersAlive = true;
  let releaseOk = true;
  let sweeps = 0;
  const host = createSessionLifecycle({
    coordinator,
    execution: createExecutionState(),
    powerShellBySession: new Map(),
    workerLastUsedAt: new Map(),
    retirePowerShell() {},
    callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {},
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput: async (recovery) => {
      if (!recovery) sweeps++;
      return releaseOk;
    },
    waitForResidentWorkersExit: async () => !workersAlive,
    runCommand: async () => ({ text: '' }),
    recaptureRequiredReply: async () => null,
  });
  coordinator.beginCleanup('a')(false);
  assert.equal(coordinator.snapshot().cleanupState, 'failed');
  await assert.rejects(
    host.stopAllComputerSessions(),
    /computer_abort_cleanup_unconfirmed: input workers are still running/
  );
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

test('the next command recovers a latched failure even while idle workers are resident', async () => {
  const coordinator = new ComputerUseCoordinator();
  // A recovery read (list_windows) and the warmup leave idle workers that never exit on their own.
  const idle = { killed: false, exitCode: null, signalCode: null };
  const warmup = { killed: false, exitCode: null, signalCode: null };
  const live = new Map([
    ['reader', idle],
    ['__computer_host_warmup__', warmup],
  ]);
  const released = [];
  const ran = [];
  const host = createSessionLifecycle({
    coordinator,
    execution: createExecutionState(),
    powerShellBySession: live,
    workerLastUsedAt: new Map(),
    retirePowerShell(child) {
      child.killed = true;
      child.exitCode = 0;
      for (const [id, value] of live) if (value === child) live.delete(id);
    },
    callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState: (id) => released.push(id),
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput: async () => true,
    waitForResidentWorkersExit: async () => [idle, warmup].every((child) => child.exitCode !== null),
    runCommand: async (command) => {
      ran.push(command.action);
      return { text: 'ok' };
    },
    recaptureRequiredReply: async () => null,
  });
  try {
    coordinator.pauseForUser('input_cleanup_unconfirmed', []);
    coordinator.beginCleanup('stale')(false);
    assert.equal(coordinator.snapshot().cleanupState, 'failed');
    await host.executeSerialized({ action: 'capture', session_id: 'reader' });
    assert.equal(coordinator.snapshot().cleanupState, 'ready');
    assert.equal(coordinator.snapshot().userControlActive, false);
    assert.equal(idle.killed && warmup.killed, true);
    assert.deepEqual(released.sort(), ['__computer_host_warmup__', 'reader']);
    assert.deepEqual(ran, ['capture']);
  } finally {
    coordinator.reset();
  }
});

test('a takeover whose first cleanup fails on timing clears its own barrier', async () => {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  execution.activeExecutionsBySession.set('fixture', { sessionId: 'fixture', aborted: false });
  let firstRelease = true;
  const host = createSessionLifecycle({
    coordinator,
    execution,
    powerShellBySession: new Map([['fixture', { killed: false, exitCode: 0, signalCode: null }]]),
    workerLastUsedAt: new Map(),
    retirePowerShell() {},
    callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {},
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput: async () => {
      // The first release races a worker still unwinding its native call; the
      // sweep that follows finds nothing held, as observed on the live desktop.
      if (firstRelease) {
        firstRelease = false;
        return false;
      }
      return true;
    },
    waitForResidentWorkersExit: async () => true,
    runCommand: async () => ({ text: '' }),
    recaptureRequiredReply: async () => null,
  });
  host.takeOverComputer('user_input_active');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(coordinator.snapshot().cleanupState, 'ready', 'the host clears a timing-only cleanup failure itself');
  assert.equal(
    coordinator.snapshot().takeoverReason,
    'user_input_active',
    'the pause stays an ordinary interruption, which is what idle resume waits for'
  );
});

test('Stop cannot use global key release as proof of target-local message cleanup', async () => {
  const coordinator = new ComputerUseCoordinator();
  let released = 0;
  const host = createSessionLifecycle({
    coordinator,
    execution: createExecutionState(),
    powerShellBySession: new Map(),
    workerLastUsedAt: new Map(),
    retirePowerShell() {},
    callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {},
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    waitForResidentWorkersExit: async () => true,
    cleanupInput: async () => {
      released++;
      return true;
    },
    hasUnconfirmedBackgroundInput: () => true,
    runCommand: async () => ({ text: '' }),
    recaptureRequiredReply: async () => null,
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
  const stopped = new Promise((resolve) => {
    exitWorker = resolve;
  });
  const cleaned = new Promise((resolve) => {
    cleanInput = resolve;
  });
  const host = createSessionLifecycle({
    coordinator,
    execution,
    powerShellBySession: new Map(),
    workerLastUsedAt: new Map(),
    retirePowerShell() {},
    callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: () => stopped,
    elevatedSessionIds: () => ['a'],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {},
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput: () => cleaned,
    runCommand: async () => ({ text: '' }),
    recaptureRequiredReply: async () => null,
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

function latchedHost(latches) {
  const coordinator = new ComputerUseCoordinator();
  const host = createSessionLifecycle({
    coordinator,
    execution: createExecutionState(),
    powerShellBySession: new Map(),
    workerLastUsedAt: new Map(),
    retirePowerShell() {},
    callPowerShell: async () => ({ ok: true }),
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => (latches.elevated ? ['a'] : []),
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {},
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    waitForResidentWorkersExit: async () => true,
    cleanupInput: async () => true,
    hasUnconfirmedBackgroundInput: () => latches.background,
    clearUnconfirmedBackgroundInput: () => {
      latches.background = false;
    },
    releaseUnconfirmedElevated: () => {
      latches.elevated = false;
    },
    runCommand: async () => ({ text: '' }),
    recaptureRequiredReply: async () => null,
  });
  coordinator.pauseForUser('user_stop', ['a']);
  coordinator.beginCleanup('background')(false);
  return { host, coordinator };
}

test('a user Stop clears background and elevated unconfirmed latches after a confirmed sweep', async () => {
  const latches = { background: true, elevated: true };
  const { host, coordinator } = latchedHost(latches);
  // The original abort already latched; the user's Stop is the later recovery.
  await assert.rejects(host.abortComputerSession({ action: 'session_abort', session_id: 'a' }));
  // The abort of the latched session re-pauses (a newer takeover generation);
  // one press still clears the latches and hands the desktop back.
  await host.stopAllComputerSessions();
  assert.deepEqual(latches, { background: false, elevated: false });
  assert.equal(coordinator.snapshot().cleanupState, 'ready');
  assert.equal(coordinator.snapshot().userControlActive, false);
});

test('a user Stop promotes a held elevated ledger and recovers it in the same cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-stop-ledger-'));
  try {
    const ledger = join(directory, 'held.ledger');
    await writeFile(ledger, '');
    const registry = createInactiveLedgerRegistry();
    const identity = { pid: 4242, startTicks: '100' };
    registry.hold(ledger, identity);
    // The launcher process: alive, then gone, then its PID reused.
    let startTicksOfPid = '100';
    let elevated = true;
    const seenByCleanup = [];
    const coordinator = new ComputerUseCoordinator();
    const host = createSessionLifecycle({
      coordinator,
      execution: createExecutionState(),
      powerShellBySession: new Map(),
      workerLastUsedAt: new Map(),
      retirePowerShell() {},
      callPowerShell: async () => ({ ok: true }),
      cancelElevatedSession: async () => true,
      elevatedSessionIds: () => (elevated ? ['a'] : []),
      sessionIdFor: (command) => command.session_id,
      releaseSessionState() {},
      invalidateWorkerGeneration() {},
      releaseCaptureSession() {},
      waitForResidentWorkersExit: async () => true,
      releaseUnconfirmedElevated: async () => {
        if (!(await registry.promoteGone((held) => processIdentityGone(held, async () => startTicksOfPid)))) {
          return false;
        }
        elevated = false;
        return true;
      },
      // Stands in for the cleanup process: it recovers what the pool offers.
      cleanupInput: async () => {
        const offered = registry.recoverable();
        seenByCleanup.push(...offered);
        for (const path of offered) registry.forget(path);
        return true;
      },
      runCommand: async () => ({ text: '' }),
      recaptureRequiredReply: async () => null,
    });
    coordinator.pauseForUser('user_stop', ['a']);
    coordinator.beginCleanup('background')(false);
    // Without the user's acknowledgement the held ledger is not offered.
    await assert.rejects(host.stopAllComputerSessions(false), /computer_abort_cleanup_unconfirmed/);
    assert.deepEqual(seenByCleanup, []);
    // Acknowledged, but the launcher process is still alive: stays latched.
    await assert.rejects(host.stopAllComputerSessions(), /computer_abort_cleanup_unconfirmed/);
    assert.deepEqual(seenByCleanup, []);
    assert.equal(elevated, true);
    // The PID now belongs to a different process: the original is gone.
    startTicksOfPid = '999';
    await host.stopAllComputerSessions();
    assert.deepEqual(seenByCleanup, [ledger]);
    assert.deepEqual(registry.recoverable(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authorization-change stop and the next agent command never clear the latches', async () => {
  const latches = { background: true, elevated: true };
  const { host } = latchedHost(latches);
  await assert.rejects(host.stopAllComputerSessions(false), /computer_abort_cleanup_unconfirmed|computer_background/);
  await assert.rejects(host.executeSerialized({ action: 'type', session_id: 'a' }), /computer_/);
  assert.deepEqual(latches, { background: true, elevated: true });
});
