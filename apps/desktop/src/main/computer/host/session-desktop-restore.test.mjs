import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: `data:text/javascript,${encodeURIComponent('export const BrowserWindow = { getAllWindows: () => [] };')}`,
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { ComputerUseCoordinator } = await import('../session/coordinator.ts');
const { createExecutionState } = await import('./execution-state.ts');
const { createInputResolution } = await import('./input-resolution.ts');
const { settleInputRun } = await import('./input-run-settle.ts');
const { createSessionLifecycle } = await import('./session-lifecycle.ts');

const recovery = (overrides = {}) => ({
  targetWindowId: 'hwnd:0x1',
  foregroundWindowId: 'hwnd:0x2',
  restoreWindowId: 'hwnd:0x2',
  restoreOwnerWindowId: '',
  cursorX: 10,
  cursorY: 20,
  inputTick: 100,
  inputObserverReady: true,
  inputMonitorId: 'monitor-a',
  inputUserSequence: 0,
  ...overrides,
});

function settleFixture() {
  const execution = createExecutionState();
  const verifications = [];
  const host = {
    sessionIdFor: (command) => command.session_id,
    executionContext: execution.executionContext,
    sessionRecoveryBySession: execution.sessionRecoveryBySession,
    sessionDesktopAnchor: execution.sessionDesktopAnchor,
    verifyInputRecovery: async (...args) => {
      verifications.push(args);
      return { ok: true };
    },
  };
  const step = (before, session = 's') =>
    settleInputRun(
      host,
      {},
      {
        run: {
          command: { action: 'mouse_move', session_id: session, delivery: 'foreground' },
          action: 'mouse_move',
          isMutation: false,
          actionTimings: {},
        },
        prepared: { targetWindowId: 'hwnd:0x1', logicalTargetWindowId: 'hwnd:0x1', inputRecovery: before },
        response: { ok: true, result: { text: 'moved' } },
        commandStartedAt: 0,
      }
    );
  return { execution, verifications, step };
}

test('separate commands hold focus and pointer against the first command’s anchor', async () => {
  const { execution, verifications, step } = settleFixture();
  await step(recovery());
  // The second command starts where the first left the agent.
  await step(recovery({ foregroundWindowId: 'hwnd:0x1', restoreWindowId: 'hwnd:0x1', cursorX: 300, cursorY: 400 }));
  assert.equal(verifications.length, 2);
  for (const args of verifications) assert.equal(args[5], true, 'every command holds the desktop');
  const second = verifications[1][2];
  assert.equal(second.restoreWindowId, 'hwnd:0x2', 'focus still returns to the user window recorded first');
  assert.equal(second.cursorX, 300);
  assert.equal(execution.sessionDesktopAnchor.get('s').recovery.cursorX, 10, 'pointer anchor is recorded once');
  assert.equal(execution.sessionDesktopAnchor.get('s').userOwned, false);
});

test('a touch on the agent window that the agent resumes after keeps the original restore point', async () => {
  const { execution, verifications, step } = settleFixture();
  await step(recovery());
  // Input during that command handed the desktop to the user for the moment.
  execution.sessionDesktopAnchor.get('s').userOwned = true;
  await step(
    recovery({
      foregroundWindowId: 'hwnd:0x1',
      foregroundWithinTarget: true,
      inputUserSequence: 3,
      cursorX: 305,
      cursorY: 405,
    })
  );
  const anchor = execution.sessionDesktopAnchor.get('s');
  assert.equal(anchor.userOwned, false, 'the agent manages the desktop again once it resumes');
  assert.equal(anchor.recovery.restoreWindowId, 'hwnd:0x2', 'focus still returns to the window the session began from');
  assert.deepEqual([anchor.recovery.cursorX, anchor.recovery.cursorY], [10, 20]);
  assert.equal(anchor.recovery.inputUserSequence, 3, 'only input before the resumed command is forgiven');
  assert.equal(verifications.length, 2);
});

test('a user who switched windows and let the agent resume becomes the new restore point', async () => {
  const { execution, verifications, step } = settleFixture();
  await step(recovery());
  await step(recovery({ foregroundWindowId: 'hwnd:0x7', inputUserSequence: 4, cursorX: 500, cursorY: 600 }));
  const anchor = execution.sessionDesktopAnchor.get('s');
  assert.equal(anchor.userOwned, false);
  assert.equal(anchor.recovery.restoreWindowId, 'hwnd:0x7');
  assert.equal(anchor.recovery.restoreOwnerWindowId, '');
  assert.deepEqual([anchor.recovery.cursorX, anchor.recovery.cursorY], [500, 600]);
  assert.equal(anchor.recovery.inputUserSequence, 4);
  assert.equal(verifications[1][2].restoreWindowId, 'hwnd:0x7', 'the command verifies against the new restore point');
});

test('a session that starts while another agent holds the desktop hands back what the user had', async () => {
  const { execution, step } = settleFixture();
  await step(recovery(), 'a');
  // B's first input finds A's target in front and the pointer where A left it;
  // B's own worker observes input under its own monitor.
  await step(
    recovery({
      foregroundWindowId: 'hwnd:0x1',
      restoreWindowId: 'hwnd:0x1',
      cursorX: 300,
      cursorY: 400,
      inputMonitorId: 'monitor-b',
      inputUserSequence: 9,
    }),
    'b'
  );
  const inherited = execution.sessionDesktopAnchor.get('b').recovery;
  assert.equal(inherited.restoreWindowId, 'hwnd:0x2', 'focus goes back to the user window, not to the other agent');
  assert.deepEqual([inherited.cursorX, inherited.cursorY], [10, 20]);

  // The user switched to another window in between: B starts from there.
  const touched = settleFixture();
  await touched.step(recovery(), 'a');
  await touched.step(
    recovery({
      foregroundWindowId: 'hwnd:0x7',
      restoreWindowId: 'hwnd:0x7',
      cursorX: 500,
      cursorY: 600,
      inputUserSequence: 4,
    }),
    'b'
  );
  const own = touched.execution.sessionDesktopAnchor.get('b').recovery;
  assert.equal(own.restoreWindowId, 'hwnd:0x7');
  assert.deepEqual([own.cursorX, own.cursorY], [500, 600]);
});

test('held verification keeps the pointer and returns focus home only when the target closed', async () => {
  const state = {
    target_window_id: 'hwnd:0x1',
    foreground_window_id: 'hwnd:0x1',
    cursor_x: 300,
    cursor_y: 400,
    input_tick: 100,
    synthetic_input: true,
    foreground_within_target: true,
    input_observer_ready: true,
    input_monitor_id: 'monitor-a',
    input_user_sequence: 0,
  };
  const calls = [];
  const resolver = createInputResolution({
    sessionIdFor: () => 'test',
    callPowerShell: async (request) => {
      calls.push(request);
      return {
        ok: true,
        result: request.action === 'restore_input_state' ? { ...state, foreground_window_id: 'hwnd:0x2' } : state,
      };
    },
  });
  const held = await resolver.verifyInputRecovery(
    { action: 'click', delivery: 'foreground' },
    'hwnd:0x1',
    recovery(),
    {},
    {},
    true
  );
  assert.equal(held.ok, true);
  assert.equal(held.cursor_held_for_followup, true);
  assert.equal(held.focus_preserved_for_followup, true);
  assert.deepEqual(
    calls.map((call) => call.action),
    ['input_recovery_state']
  );
  calls.length = 0;
  state.target_exists = false;
  state.foreground_window_id = 'hwnd:0x999';
  const closed = await resolver.verifyInputRecovery(
    { action: 'click', delivery: 'foreground' },
    'hwnd:0x1',
    recovery({ targetOwnerWindowId: 'hwnd:0x5' }),
    {},
    {},
    true
  );
  assert.equal(closed.ok, true);
  assert.equal(calls[1].restore_focus, true);
  assert.equal(calls[1].cursor_x, 300, 'the pointer is not moved back');
  assert.equal(calls[1].cursor_y, 400);
});

function lifecycleFixture(callPowerShell, cleanupInput = async () => true) {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  const workers = new Map([['s', { killed: false, exitCode: null, signalCode: null }]]);
  const lifecycle = createSessionLifecycle({
    coordinator,
    execution,
    powerShellBySession: workers,
    workerLastUsedAt: new Map([['s', 0]]),
    retirePowerShell(child) {
      child.killed = true;
      child.exitCode = 0;
      workers.delete('s');
    },
    callPowerShell,
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState() {},
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput,
    runCommand: async () => ({ text: '' }),
    recaptureRequiredReply: async () => null,
  });
  return { coordinator, execution, lifecycle, workers };
}

test('session release restores the user focus and pointer exactly once', async () => {
  const calls = [];
  const { coordinator, execution, lifecycle } = lifecycleFixture(async (request) => {
    calls.push(request);
    return { ok: true };
  });
  execution.sessionDesktopAnchor.set('s', { recovery: recovery(), targetWindowId: 'hwnd:0x1', userOwned: false });
  await lifecycle.releaseComputerSession({ action: 'session_release', session_id: 's' });
  const restores = calls.filter((call) => call.action === 'restore_input_state');
  assert.equal(restores.length, 1);
  assert.equal(restores[0].restore_window_id, 'hwnd:0x2');
  assert.equal(restores[0].restore_focus, true);
  assert.deepEqual(
    restores[0].held_window_ids,
    ['hwnd:0x1'],
    'the worker restores only from a window the session held'
  );
  assert.equal(restores[0].cursor_x, 10);
  assert.equal(restores[0].cursor_y, 20);
  assert.equal(restores[0].expected_input_user_sequence, 0);
  assert.equal(execution.sessionDesktopAnchor.has('s'), false);
  await lifecycle.releaseComputerSession({ action: 'session_release', session_id: 's' });
  assert.equal(calls.filter((call) => call.action === 'restore_input_state').length, 1);
  coordinator.reset();
});

test('the end of a turn hands the desktop back at once and keeps the worker for a follow-up', async () => {
  const calls = [];
  const { coordinator, execution, lifecycle, workers } = lifecycleFixture(async (request) => {
    calls.push(request.action);
    return { ok: true };
  });
  execution.sessionDesktopAnchor.set('s', { recovery: recovery(), targetWindowId: 'hwnd:0x1', userOwned: false });
  const reply = lifecycle.endComputerExecution({ action: 'execution_end', session_id: 's' });
  assert.equal(reply.text, 'computer execution ended');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['release_held_input', 'restore_input_state'], 'held input goes up before focus goes home');
  assert.equal(workers.has('s'), true, 'the worker and its refs stay for a follow-up turn');
  assert.equal(execution.sessionDesktopAnchor.has('s'), false);
  // The deferred release later retires the worker without moving the desktop again.
  await lifecycle.releaseComputerSession({ action: 'session_release', session_id: 's' });
  assert.equal(calls.filter((action) => action === 'restore_input_state').length, 1);
  assert.equal(workers.has('s'), false);
  coordinator.reset();
});

test('release never restores after the user took the desktop, and survives a refused restore', async () => {
  const calls = [];
  const owned = lifecycleFixture(async (request) => {
    calls.push(request.action);
    return { ok: true };
  });
  owned.execution.sessionDesktopAnchor.set('s', { recovery: recovery(), targetWindowId: 'hwnd:0x1', userOwned: true });
  await owned.lifecycle.releaseComputerSession({ action: 'session_release', session_id: 's' });
  assert.equal(calls.includes('restore_input_state'), false);
  owned.coordinator.reset();

  const refused = lifecycleFixture(async (request) => {
    if (request.action === 'restore_input_state') throw new Error('user_input_active: desktop input changed');
    return { ok: true };
  });
  refused.execution.sessionDesktopAnchor.set('s', {
    recovery: recovery(),
    targetWindowId: 'hwnd:0x1',
    userOwned: false,
  });
  const result = await refused.lifecycle.releaseComputerSession({ action: 'session_release', session_id: 's' });
  assert.equal(result.text, 'computer session released');
  refused.coordinator.reset();
});

test('an idle worker reclaim restores the desktop once before retiring', async () => {
  const calls = [];
  const { coordinator, execution, lifecycle, workers } = lifecycleFixture(async (request) => {
    calls.push(request.action);
    assert.equal(workers.has('s'), true, 'restore runs on the live worker');
    return { ok: true };
  });
  execution.sessionDesktopAnchor.set('s', { recovery: recovery(), targetWindowId: 'hwnd:0x1', userOwned: false });
  lifecycle.reapIdleSessionWorkers(300_001);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['restore_input_state']);
  assert.equal(workers.has('s'), false);
  coordinator.reset();
});

async function settled(check) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('the end of a turn lets go of held keys and buttons even when the desktop stays as the user left it', async () => {
  const calls = [];
  const { coordinator, execution, lifecycle, workers } = lifecycleFixture(async (request) => {
    calls.push(request);
    return { ok: true };
  });
  // The user took the desktop during the turn, so focus and pointer stay put.
  execution.sessionDesktopAnchor.set('s', { recovery: recovery(), targetWindowId: 'hwnd:0x1', userOwned: true });
  lifecycle.endComputerExecution({ action: 'execution_end', session_id: 's' });
  await settled(() => calls.length > 0);
  assert.deepEqual(
    calls.map((call) => [call.action, call.session_id]),
    [['release_held_input', 's']]
  );
  assert.equal(workers.has('s'), true, 'the worker stays warm for a follow-up turn');
  coordinator.reset();
});

test('the last agent session to finish its turn hands the desktop back', async () => {
  const calls = [];
  const { coordinator, execution, lifecycle, workers } = lifecycleFixture(async (request) => {
    calls.push(request);
    return { ok: true };
  });
  workers.set('t', { killed: false, exitCode: null, signalCode: null });
  execution.sessionDesktopAnchor.set('s', { recovery: recovery(), targetWindowId: 'hwnd:0x1', userOwned: false });
  execution.sessionDesktopAnchor.set('t', {
    recovery: recovery(),
    targetWindowId: 'hwnd:0x3',
    heldWindowId: 'hwnd:0x4',
    userOwned: false,
  });
  lifecycle.endComputerExecution({ action: 'execution_end', session_id: 's' });
  await settled(() => calls.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    calls.map((call) => call.action),
    ['release_held_input'],
    'another agent still has the desktop, so nothing moves yet'
  );
  lifecycle.endComputerExecution({ action: 'execution_end', session_id: 't' });
  await settled(() => calls.some((call) => call.action === 'restore_input_state'));
  const restore = calls.find((call) => call.action === 'restore_input_state');
  assert.equal(restore.session_id, 't');
  assert.equal(restore.restore_window_id, 'hwnd:0x2');
  assert.deepEqual(
    restore.held_window_ids,
    ['hwnd:0x3', 'hwnd:0x4', 'hwnd:0x1'],
    'focus may also come back from the window the first agent left'
  );
  coordinator.reset();
});

test('a held-input release the worker cannot confirm ends the session through the owned-input sweep', async () => {
  const sweeps = [];
  const refused = lifecycleFixture(
    async (request) =>
      request.action === 'release_held_input'
        ? { ok: false, error: 'input_cleanup_unconfirmed: a held key could not be released' }
        : { ok: true },
    async (_recovery, _restoreDesktop, sweep) => {
      sweeps.push(sweep);
      return true;
    }
  );
  refused.lifecycle.endComputerExecution({ action: 'execution_end', session_id: 's' });
  await settled(() => sweeps.length > 0);
  await refused.lifecycle.waitForCleanup();
  assert.deepEqual(sweeps, [true], 'whatever input the host still owns is released');
  assert.equal(refused.workers.has('s'), false, 'a worker that could not release is not kept warm');
  assert.notEqual(refused.coordinator.snapshot().cleanupState, 'failed');
  refused.coordinator.reset();

  const lost = lifecycleFixture(
    async () => {
      throw new Error('computer_worker_exited: worker exited');
    },
    async () => false
  );
  lost.lifecycle.endComputerExecution({ action: 'execution_end', session_id: 's' });
  await settled(() => lost.coordinator.snapshot().cleanupState === 'failed');
  await lost.lifecycle.waitForCleanup();
  assert.equal(lost.coordinator.snapshot().cleanupState, 'failed', 'a release nobody can confirm is reported');
  assert.equal(lost.coordinator.snapshot().takeoverReason, 'input_cleanup_unconfirmed');
  lost.coordinator.reset();
});
