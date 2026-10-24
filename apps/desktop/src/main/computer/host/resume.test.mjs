import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerUseCoordinator } from '../session/coordinator.ts';
import { computerUseOverlayPresentation } from '../overlay/model.ts';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { createExecutionState } from './execution-state.ts';

function fixture(runOverride, hostOverrides = {}) {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  const released = [];
  const commands = [];
  const observations = new Map([['a', 'old-ref']]);
  const workers = new Map();
  const nativeCalls = [];
  const lifecycle = createSessionLifecycle({
    coordinator,
    execution,
    powerShellBySession: workers,
    workerLastUsedAt: new Map(),
    retirePowerShell() {},
    callPowerShell: async (request) => {
      nativeCalls.push(request.action);
      return { ok: true };
    },
    cancelElevatedSession: async () => true,
    elevatedSessionIds: () => [],
    sessionIdFor: (command) => command.session_id,
    releaseSessionState: (id) => {
      released.push(id);
      observations.delete(id);
    },
    invalidateWorkerGeneration() {},
    releaseCaptureSession() {},
    cleanupInput: async () => true,
    runCommand: async (command) => {
      commands.push(command.action);
      return runOverride ? runOverride(command) : { text: '{"ok":true}' };
    },
    recaptureRequiredReply: async () => null,
    ...hostOverrides,
  });
  coordinator.beginCommand({ sessionId: 'a', action: 'click', mode: 'foreground' });
  coordinator.pauseForUser('user_pause');
  return { coordinator, execution, lifecycle, released, commands, observations, workers, nativeCalls };
}

async function drainingFixture() {
  let finish;
  const gate = new Promise((resolve) => {
    finish = () => resolve({ text: '{"ok":true}' });
  });
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
  assert.deepEqual(model.sessionIds, ['a']);
  for (const action of ['list_windows', 'list_apps', 'diagnose']) {
    await lifecycle.executeSerialized({ action, session_id: 'a' });
  }
  let completed = false;
  const queued = lifecycle.executeSerialized({ action: 'capture', session_id: 'a' }).then(() => {
    completed = true;
  });
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
  await assert.rejects(lifecycle.resumeAfterTakeover(generation), /cleanup_pending/);
  finish(true);
  coordinator.pauseForUser('second_interruption');
  await assert.rejects(lifecycle.resumeAfterTakeover(generation), /resume_stale/);
  assert.equal(coordinator.snapshot().userControlActive, true);
  await lifecycle.resumeAfterTakeover(coordinator.snapshot().takeoverGeneration);
  coordinator.reset();
});

test('a failed cleanup leaves nothing on screen; the next command recovers it or fails with its reason', async () => {
  let unconfirmed = true;
  const { coordinator, lifecycle, commands } = fixture(undefined, {
    hasUnconfirmedBackgroundInput: () => unconfirmed,
  });
  // A background sender stopped without a release receipt: the abort latches.
  await assert.rejects(
    lifecycle.abortComputerSession({ action: 'session_abort', session_id: 'a' }),
    /computer_abort_cleanup_unconfirmed/
  );
  // The turn ended, so no task is left waiting on the pause.
  coordinator.endExecution('a');
  const state = computerUseOverlayPresentation(coordinator.snapshot(), 'ko');
  assert.equal(coordinator.snapshot().cleanupState, 'failed');
  assert.equal(state.visible, true);
  await assert.rejects(lifecycle.resumeAfterTakeover(state.generation), /cleanup_pending/);
  // Recovery still lacks its evidence: the command reports why, instead of a pill.
  await assert.rejects(
    lifecycle.executeSerialized({ action: 'capture', session_id: 'b' }),
    /computer_background_cleanup_unconfirmed/
  );
  assert.equal(commands.includes('capture'), false);
  // Once recovery succeeds, the same command runs and the host is clear again.
  unconfirmed = false;
  await lifecycle.executeSerialized({ action: 'capture', session_id: 'b' });
  assert.equal(commands.at(-1), 'capture');
  assert.equal(coordinator.snapshot().cleanupState, 'ready');
  coordinator.reset();
});

test("the overlay's Resume recovers a latched cleanup before continuing the paused task", async () => {
  const { coordinator, lifecycle } = fixture();
  const finish = coordinator.beginCleanup('a');
  finish(false);
  const state = computerUseOverlayPresentation(coordinator.snapshot(), 'ko');
  assert.equal(state.visible, true);
  assert.equal(state.resumable, true);
  await lifecycle.resumeByUser(state.generation);
  assert.equal(coordinator.snapshot().cleanupState, 'ready');
  assert.equal(coordinator.snapshot().userControlActive, false);
  coordinator.reset();
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

test('native interruption refuses only the active input and never pauses the session', async () => {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  let calls = 0;
  const lifecycle = createSessionLifecycle({
    pauseWaitMs: 15,
    coordinator,
    execution,
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
    runCommand: async (command) => {
      calls++;
      if (command.action === 'type') throw new Error('user_input_active: input interrupted');
      return { text: 'fresh capture' };
    },
    recaptureRequiredReply: async () => null,
  });
  const interrupted = lifecycle.executeSerialized({ action: 'type', session_id: 'a', delivery: 'background' });
  const refused = JSON.parse((await interrupted).text);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'user_input_active');
  assert.equal(refused.effect, 'unverifiable');
  assert.equal(refused.input_may_have_executed, true);
  assert.equal(refused.verdict.decision, 'escalate');
  assert.equal(refused.verdict.recommended, 'recapture');
  assert.equal(refused.status, undefined);
  assert.equal(coordinator.snapshot().userControlActive, false);
  assert.equal(
    (await lifecycle.executeSerialized({ action: 'capture', session_id: 'a', delivery: 'background' })).text,
    'fresh capture'
  );
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
