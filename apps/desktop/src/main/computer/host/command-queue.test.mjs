import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionLifecycle } from './session-lifecycle.ts';
import { createExecutionState } from './execution-state.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';
import { buildRecaptureRequiredPayload } from '../observation/recapture.ts';
import { executeComputerSequenceSteps } from '../input/sequence.ts';
import { createComputerUserWait } from '../session/user-wait.ts';
import { computerUseOverlayPresentation, computerUseCursorPresentations } from '../overlay/model.ts';
import { createCaptureAfter } from '../observation/capture-after.ts';

const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const coordinator = new ComputerUseCoordinator();
  const execution = createExecutionState();
  const calls = [];
  const host = createSessionLifecycle({
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
      calls.push(command.action);
      return { text: command.action };
    },
    recaptureRequiredReply: async (command, error) => {
      const payload = buildRecaptureRequiredPayload(command.action, error, {
        ok: true,
        action: 'capture',
        window_id: 'hwnd:0x1',
        frame_id: 'fresh',
      });
      if (!payload) return null;
      calls.push('recapture');
      return { text: JSON.stringify(payload) };
    },
    ...overrides,
  });
  t.after(async () => {
    await host.stopAllComputerSessions();
    coordinator.reset();
  });
  return { coordinator, execution, host, calls };
}

test('concurrent clipboard reads retain serialization without requiring a window recapture', {
  timeout: 3000,
}, async (t) => {
  const dispatched = [];
  let release;
  const firstRead = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture(t, {
    runCommand: async (command) => {
      dispatched.push(command.session_id);
      if (command.session_id === 'first') await firstRead;
      return { text: `clipboard-${command.session_id}` };
    },
  });
  t.after(() => release());
  const first = f.host.executeSerialized({ action: 'clipboard_read', session_id: 'first' });
  await turn();
  const second = f.host.executeSerialized({ action: 'clipboard_read', session_id: 'second' });
  await turn();
  assert.deepEqual(dispatched, ['first']);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((result) => result.text),
    ['clipboard-first', 'clipboard-second']
  );
  assert.deepEqual(dispatched, ['first', 'second']);
  assert.deepEqual(f.calls, [], 'a global read never invents a target window to recapture');
});

test('a dispatched menu timeout survives worker cancellation without replay or recovery capture', async (t) => {
  let f;
  let dispatched = 0;
  f = fixture(t, {
    runCommand: async () => {
      dispatched++;
      f.host.onSessionWorkerRetired('a', undefined, true);
      throw new Error('computer_command_timeout: menu provider did not respond');
    },
  });
  await assert.rejects(
    f.host.executeSerialized({ action: 'invoke_menu', session_id: 'a' }),
    /computer_command_timeout: menu provider did not respond/
  );
  await f.host.waitForCleanup();
  assert.equal(dispatched, 1);
  assert.deepEqual(f.calls, []);
  f.coordinator.assertAutomationAllowed();
});

test('failed or interrupted recovery preserves the original error and never publishes stale state', async (t) => {
  for (const interrupted of [false, true]) {
    let f;
    let dispatched = 0;
    const diagnostics = [];
    f = fixture(t, {
      runCommand: async () => {
        dispatched++;
        throw new Error('menu_path_not_found: fixture menu is unavailable');
      },
      recaptureRequiredReply: async () => {
        if (interrupted) {
          await f.host.abortComputerSession({ action: 'session_abort', session_id: 'a' });
          return { text: 'stale observation' };
        }
        throw new Error('pixel_unavailable: recovery capture failed');
      },
      recordDiagnostic: (_session, record) => diagnostics.push(record),
    });
    await assert.rejects(
      f.host.executeSerialized({ action: 'invoke_menu', session_id: 'a' }),
      /menu_path_not_found: fixture menu is unavailable/
    );
    assert.equal(dispatched, 1);
    assert.ok(diagnostics.some((record) => record.stage === 'recovery' && record.ok === false));
  }
});

test('background semantic focus guards cannot interrupt another session pointer and remain background', {
  timeout: 3000,
}, async (t) => {
  let release;
  const events = [];
  let f;
  f = fixture(t, {
    runCommand: async (command) => {
      events.push([
        command.session_id,
        f.coordinator.snapshot().activities.find((row) => row.sessionId === command.session_id)?.mode,
      ]);
      if (command.session_id === 'pointer')
        await new Promise((resolve) => {
          release = resolve;
        });
      return { text: 'done' };
    },
  });
  const pointer = f.host.executeSerialized({ action: 'click', delivery: 'foreground', session_id: 'pointer' });
  await turn();
  const command = {
    action: 'sequence',
    delivery: 'background',
    session_id: 'semantic',
    steps: [{ action: 'invoke', ref: 's1:e0' }],
  };
  const semantic = f.host.executeSerialized(command);
  await turn();
  assert.deepEqual(events, [['pointer', 'foreground']]);
  release();
  await pointer;
  const observed = JSON.parse((await semantic).text);
  assert.equal(observed.observation.frame_id, 'fresh');
  assert.deepEqual(events, [['pointer', 'foreground']], 'waiting must not dispatch stale input');
  await f.host.executeSerialized({ ...command, steps: [{ action: 'invoke', ref: 'fresh-ref' }] });
  assert.deepEqual(events.at(-1), ['semantic', 'background']);
});

for (const reason of ['user_pause', 'user_input_active']) {
  test(`${reason} retains FIFO work without holding the resume drain or replaying stale input`, {
    timeout: 3000,
  }, async (t) => {
    const f = fixture(t);
    const first = f.host.executeSerialized({ action: 'capture', session_id: 'a' });
    const second = f.host.executeSerialized({ action: 'click', session_id: 'a', window_id: 'hwnd:0x1' });
    const third = f.host.executeSerialized({ action: 'clipboard_read', session_id: 'a' });
    f.host.takeOverComputer(reason);
    let settled = false;
    const results = Promise.all([first, second, third]).then((value) => {
      settled = true;
      return value;
    });
    await f.host.waitForCleanup();
    await turn();
    assert.equal(settled, false);
    assert.deepEqual(f.calls, []);
    await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
    const values = await results;
    assert.deepEqual(f.calls, ['capture', 'recapture', 'clipboard_read']);
    assert.equal(JSON.parse(values[1].text).verdict.recommended, 'continue_pending_work');
    assert.equal(JSON.parse(values[1].text).observation.frame_id, 'fresh');
    assert.equal(f.coordinator.snapshot().userControlActive, false);
  });
}

test('work admitted during a pause is visible to Stop and must refresh its target on resume', {
  timeout: 3000,
}, async (t) => {
  const f = fixture(t);
  f.coordinator.pauseForUser('user_pause', ['a']);
  const pending = f.host.executeSerialized({ action: 'type', session_id: 'b', window_id: 'hwnd:0x1' });
  await turn();
  assert.ok(f.coordinator.snapshot().pausedSessionIds.includes('b'));
  // A safe probe cannot deadlock behind that parked request.
  assert.equal((await f.host.executeSerialized({ action: 'diagnose', session_id: 'b' })).text, 'diagnose');
  await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
  assert.equal(JSON.parse((await pending).text).code, 'computer_resume_recapture_required');
  assert.deepEqual(f.calls, ['diagnose', 'recapture']);
});

test('Stop cancels parked work even while its pause cleanup is still pending', { timeout: 3000 }, async (t) => {
  let clean;
  const f = fixture(t, {
    cleanupInput: () =>
      new Promise((resolve) => {
        clean = resolve;
      }),
  });
  const one = f.host.executeSerialized({ action: 'capture', session_id: 'a' });
  const two = f.host.executeSerialized({ action: 'type', session_id: 'a' });
  const results = Promise.allSettled([one, two]);
  f.host.takeOverComputer('user_pause');
  await turn();
  const stopped = f.host.stopAllComputerSessions();
  await turn();
  assert.deepEqual(
    (await results).map((result) => result.status),
    ['rejected', 'rejected']
  );
  assert.deepEqual(f.calls, []);
  clean(true);
  await stopped;
});

test('a queued foreground request yields its lane to cleanup instead of blocking resume', {
  timeout: 3000,
}, async (t) => {
  let finish;
  const f = fixture(t, {
    runCommand: () =>
      new Promise((resolve) => {
        finish = () => resolve({ text: 'late result' });
      }),
  });
  const first = f.host.executeSerialized({ action: 'capture', session_id: 'a', delivery: 'foreground' });
  const firstResult = first.catch((error) => error);
  await turn();
  const second = f.host.executeSerialized({
    action: 'click',
    session_id: 'b',
    delivery: 'foreground',
    window_id: 'hwnd:0x1',
  });
  await turn();
  f.host.takeOverComputer('user_pause');
  finish();
  assert.match(String(await firstResult), /session_aborted/);
  await f.host.waitForCleanup();
  await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
  assert.equal(JSON.parse((await second).text).verdict.recommended, 'continue_pending_work');
  assert.deepEqual(f.calls, ['recapture']);
});

test('lost callers cancel only their parked queue and release its admission budget', { timeout: 3000 }, async (t) => {
  const f = fixture(t);
  f.coordinator.pauseForUser('user_input_active', ['a', 'b']);
  const a = Array.from({ length: 4 }, () => f.host.executeSerialized({ action: 'capture', session_id: 'a' }));
  const cancelled = Promise.allSettled(a);
  const b = f.host.executeSerialized({ action: 'capture', session_id: 'b' });
  await f.host.abortComputerSession({ action: 'session_abort', session_id: 'a' });
  assert.equal(
    f.coordinator.snapshot().takeoverReason,
    'user_input_active',
    'caller cancellation must not turn an idle-resumable pause into global Stop'
  );
  assert.ok((await cancelled).every((result) => result.status === 'rejected'));
  await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
  assert.equal((await b).text, 'capture');
  assert.equal((await f.host.executeSerialized({ action: 'capture', session_id: 'a' })).text, 'capture');
});

test('settled commands retain task activity until explicit execution end without holding the pill on screen', async (t) => {
  const f = fixture(t);
  await f.host.executeSerialized({ action: 'capture', session_id: 'a' });
  await turn();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  // Thinking right after a command keeps the pill; past the grace it shows
  // nothing, while the task stays reachable by Stop.
  assert.equal(computerUseOverlayPresentation(f.coordinator.snapshot()).visible, true);
  t.mock.timers.tick(10_000);
  assert.deepEqual(computerUseOverlayPresentation(f.coordinator.snapshot()).sessionIds, ['a']);
  assert.equal(computerUseOverlayPresentation(f.coordinator.snapshot()).visible, false);
  f.coordinator.endExecution('a');
  assert.deepEqual(computerUseOverlayPresentation(f.coordinator.snapshot()).sessionIds, []);
  assert.deepEqual(computerUseCursorPresentations(f.coordinator.snapshot()), []);
  // The next request starts normally; hiding finished work is not a pause.
  assert.equal((await f.host.executeSerialized({ action: 'capture', session_id: 'a' })).text, 'capture');
});

test('a long pause frees the native queue but retains pending task activity without replay', {
  timeout: 3000,
}, async (t) => {
  const f = fixture(t, { pauseWaitMs: 15 });
  f.coordinator.pauseForUser('user_input_active', ['a']);
  const result = JSON.parse(
    (
      await f.host.executeSerialized({
        action: 'type',
        session_id: 'a',
        window_id: 'hwnd:0x1',
        text: 'private input',
      })
    ).text
  );
  assert.equal(result.status, 'paused');
  assert.equal(result.completed, false);
  assert.equal(result.fresh_capture_required, true);
  assert.equal(result.recovery.next, 'wait_for_user');
  assert.deepEqual(result.pending_work.pending_steps, [1]);
  assert.doesNotMatch(JSON.stringify(result), /private input/);
  await turn();
  assert.equal(f.execution.commandChainsBySession.size, 0);
  assert.equal(f.coordinator.snapshot().userControlActive, true);
  await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
  await turn();
  assert.deepEqual(f.calls, [], 'returning a paused result must detach the original input');
  assert.deepEqual(computerUseOverlayPresentation(f.coordinator.snapshot()).sessionIds, ['a']);
  f.coordinator.endExecution('a');
  assert.deepEqual(computerUseOverlayPresentation(f.coordinator.snapshot()).sessionIds, []);
  assert.equal(computerUseOverlayPresentation(f.coordinator.snapshot()).visible, false);
});

test('idle resume recovers transient observation loss, returns fresh evidence and hides settled work', {
  timeout: 3000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture(t);
  let sequence = 0;
  let lastInput = 0;
  const manager = createComputerUserWait({
    coordinator: f.coordinator,
    now: () => Date.now(),
    enabled: () => true,
    observe: async () => ({
      ready: Date.now() > 500,
      monitor: 'fixture',
      sequence,
      held: false,
      idleMs: Date.now() - lastInput,
    }),
    resume: (generation, signal, recheck) => f.host.resumeAfterTakeover(generation, signal, recheck),
  });
  t.after(() => manager.dispose());
  const tick = async () => {
    t.mock.timers.tick(500);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  f.coordinator.pauseForUser('user_input_active', ['a']);
  const pending = f.host.executeSerialized({ action: 'click', session_id: 'a', window_id: 'hwnd:0x1' });
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  for (let i = 0; i < 8; i++) await tick();
  sequence++;
  lastInput = Date.now();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(settled, false, 'new user activity restarts the configured quiet interval');
  await tick();
  const result = JSON.parse((await pending).text);
  assert.equal(result.status, 'resumed');
  assert.equal(result.observation.frame_id, 'fresh');
  assert.equal(result.input_replayed, false);
  assert.deepEqual(f.calls, ['recapture']);
  await turn();
  assert.deepEqual(computerUseOverlayPresentation(f.coordinator.snapshot()).sessionIds, ['a']);
  f.coordinator.endExecution('a');
  assert.deepEqual(computerUseOverlayPresentation(f.coordinator.snapshot()).sessionIds, []);
  assert.equal(computerUseOverlayPresentation(f.coordinator.snapshot()).visible, false);
});

for (const reason of ['user_input_active', 'user_pause']) {
  test(`${reason} parks in-flight sequence progress until cleanup and resume, without replay`, {
    timeout: 3000,
  }, async (t) => {
    let dispatch;
    let f;
    let inputCalls = 0;
    f = fixture(t, {
      runCommand: async () => {
        inputCalls++;
        f.execution.executionContext.getStore().progress = { completed: 1, inFlight: 1 };
        await new Promise((resolve) => {
          dispatch = resolve;
        });
        throw new Error('computer_session_aborted: worker retired during input');
      },
    });
    const request = f.host.executeSerialized({
      action: 'sequence',
      session_id: 'a',
      window_id: 'hwnd:0x1',
      delivery: 'foreground',
      steps: [{ action: 'click' }, { action: 'type', text: 'private text' }, { action: 'key', keys: '{ENTER}' }],
    });
    let settled = false;
    request.then(() => {
      settled = true;
    });
    await turn();
    f.host.takeOverComputer(reason);
    dispatch();
    await f.host.waitForCleanup();
    await turn();
    assert.equal(settled, false);
    assert.equal(inputCalls, 1);
    await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
    const result = JSON.parse((await request).text);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'resumed');
    assert.deepEqual(
      result.steps.map((step) => step.status),
      ['succeeded', 'uncertain', 'pending']
    );
    assert.deepEqual(result.pending_work, { completed_steps: 1, uncertain_step: 2, pending_steps: [3] });
    assert.equal(result.observation.frame_id, 'fresh');
    assert.equal(result.input_replayed, false);
    assert.equal(inputCalls, 1);
    assert.equal(JSON.stringify(result).includes('private text'), false);
  });
}

test('Stop cancels an in-flight mutation parked after user intervention', { timeout: 3000 }, async (t) => {
  let dispatch;
  const f = fixture(t, {
    runCommand: () =>
      new Promise((resolve) => {
        dispatch = () => resolve({ text: 'late' });
      }),
  });
  const request = f.host.executeSerialized({ action: 'type', session_id: 'a', window_id: 'hwnd:0x1' });
  const result = request.catch((error) => error);
  await turn();
  f.host.takeOverComputer('user_input_active');
  dispatch();
  await f.host.waitForCleanup();
  await turn();
  await f.host.abortComputerSession({ action: 'session_abort', session_id: 'a' });
  assert.match(String(await result), /computer_session_aborted/);
  assert.deepEqual(f.calls, []);
});

test('recovery failure survives worker cancellation and remains blocked rather than replayed', {
  timeout: 3000,
}, async (t) => {
  let f;
  f = fixture(t, {
    runCommand: async () => {
      f.execution.executionContext.getStore().failureCode = 'input_recovery_unconfirmed';
      f.host.takeOverComputer('input_recovery_unconfirmed');
      throw new Error('computer_session_aborted: worker cancelled');
    },
  });
  await assert.rejects(
    f.host.executeSerialized({ action: 'sequence', session_id: 'a', window_id: 'hwnd:0x1' }),
    /input_recovery_unconfirmed/
  );
  await f.host.waitForCleanup();
  assert.equal(f.coordinator.snapshot().takeoverReason, 'input_recovery_unconfirmed');
  assert.equal(f.coordinator.snapshot().userControlActive, true);
  assert.deepEqual(f.calls, []);
});

test('user input detected by a capture shows waiting controls and keeps user wait pending until resume', {
  timeout: 3000,
}, async (t) => {
  let captures = 0;
  const f = fixture(t, {
    runCommand: async () => {
      captures++;
      throw new Error('user_input_active: user input changed during capture');
    },
  });
  await assert.rejects(
    f.host.executeSerialized({ action: 'capture', session_id: 'a', window_id: 'hwnd:0x1' }),
    /user_input_active/
  );
  await f.host.waitForCleanup();
  const snapshot = f.coordinator.snapshot();
  assert.equal(snapshot.userControlActive, true);
  assert.equal(snapshot.takeoverReason, 'user_input_active');
  const presentation = computerUseOverlayPresentation(snapshot, 'ko');
  assert.equal(presentation.visible, true);
  assert.equal(presentation.title, '대기 중');
  assert.equal(presentation.resumable, true);
  assert.deepEqual(presentation.sessionIds, ['a']);
  const wait = createComputerUserWait({
    coordinator: f.coordinator,
    enabled: () => false,
    observe: async () => assert.fail('manual resume does not poll input'),
    resume: (...args) => f.host.resumeAfterTakeover(...args),
  });
  t.after(() => wait.dispose());
  let finished = false;
  const pending = wait.wait('a', 1000).then((status) => {
    finished = true;
    return status;
  });
  await turn();
  assert.equal(finished, false);
  await f.host.resumeAfterTakeover(snapshot.takeoverGeneration);
  assert.equal(await pending, 'resumed');
  assert.equal(captures, 1, 'the interrupted capture is not replayed');
  assert.deepEqual(f.calls, [], 'no recovery capture is attempted during user control');
});

test('a read whose observer changed fails alone; only input takes the desktop back', {
  timeout: 3000,
}, async (t) => {
  for (const [action, takesOver] of [
    ['capture', false],
    ['click', true],
  ]) {
    const f = fixture(t, {
      runCommand: async () => {
        throw new Error('input_observation_unavailable: observation worker changed during capture');
      },
      recaptureRequiredReply: async () => null,
    });
    await assert.rejects(
      f.host.executeSerialized({ action, session_id: 'a', window_id: 'hwnd:0x1' }),
      /input_observation_unavailable/
    );
    await f.host.waitForCleanup();
    assert.equal(f.coordinator.snapshot().userControlActive, takesOver, action);
    if (!takesOver) f.coordinator.assertAutomationAllowed();
    f.coordinator.reset();
  }
});

test('native interruption inside a sequence reaches the pending queue instead of a failed tool reply', {
  timeout: 3000,
}, async (t) => {
  let f;
  const dispatched = [];
  f = fixture(t, {
    runCommand: async (command) => {
      const state = f.execution.executionContext.getStore();
      await executeComputerSequenceSteps(
        command.steps,
        command.window_id,
        async (_, index) => {
          state.progress = { completed: index, inFlight: index };
          dispatched.push(index);
          return index === 0 ? { ok: true } : { ok: false, code: 'user_input_active' };
        },
        (completed) => {
          state.progress = { completed };
        }
      );
      throw new Error('unexpected sequence completion');
    },
  });
  const request = f.host.executeSerialized({
    action: 'sequence',
    session_id: 'a',
    window_id: 'hwnd:0x1',
    steps: [{ action: 'click' }, { action: 'type' }, { action: 'key' }],
  });
  await turn();
  await f.host.waitForCleanup();
  assert.equal(f.coordinator.snapshot().takeoverReason, 'user_input_active');
  await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
  const result = JSON.parse((await request).text);
  assert.equal(result.status, 'resumed');
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ['succeeded', 'uncertain', 'pending']
  );
  assert.deepEqual(dispatched, [0, 1]);
});

test('post-input capture takeover pauses, then recaptures without replaying uncertain input', {
  timeout: 3000,
}, async (t) => {
  let deliveries = 0;
  let captures = 0;
  const captureAfter = createCaptureAfter(
    { sessionIdFor: () => 'a', assertExecutionNotAborted() {} },
    { resolve: () => ({ includeOcr: false }) },
    async () => {
      captures++;
      throw new Error('user_input_active: user input changed during capture');
    }
  );
  const f = fixture(t, {
    runCommand: async (command) => {
      deliveries++;
      await captureAfter(command, command.window_id, 0);
      assert.fail('interrupted observation must not return a normal input reply');
    },
  });
  const request = f.host.executeSerialized({ action: 'type', session_id: 'a', window_id: 'hwnd:0x1', text: 'once' });
  await turn();
  await f.host.waitForCleanup();
  assert.equal(f.coordinator.snapshot().takeoverReason, 'user_input_active');
  assert.deepEqual(f.calls, [], 'there is no recapture while the user has control');
  await f.host.resumeAfterTakeover(f.coordinator.snapshot().takeoverGeneration);
  const result = JSON.parse((await request).text);
  assert.equal(result.status, 'resumed');
  assert.equal(result.input_replayed, false);
  assert.equal(result.steps[0].status, 'uncertain');
  assert.equal(result.observation.frame_id, 'fresh');
  assert.deepEqual(f.calls, ['recapture']);
  assert.equal(deliveries, 1);
  assert.equal(captures, 1);
});
