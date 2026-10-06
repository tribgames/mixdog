import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,' +
            encodeURIComponent(`
        export const BrowserWindow = { getAllWindows: () => [] };
        export const screen = {};
      `),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createCommandRouter } = await import('./command-router.ts');
const { createSequenceRunner } = await import('./sequence-runner.ts');
const { computerRunRecord } = await import('../session/run-log.ts');
const { createExecutionState } = await import('./execution-state.ts');
const { createSessionState } = await import('../session/state.ts');

const windows = [{ id: 'hwnd:0x1', pid: 10, title: 'Fixture', width: 500, height: 300 }];
const scope = {
  primaryWindowId: 'hwnd:0x1',
  relatedWindowIds: ['hwnd:0x1'],
  observedAt: Date.now(),
  inputObservation: { ready: true, monitor: 'fixture', sequence: 0 },
};
// Native coordinates equal DIPs on macOS; the fixture's screen has no Linux
// scaling, so these host-level checks run where native points are known.
const NATIVE_POINTS_KNOWN = { skip: !['win32', 'darwin'].includes(process.platform) && 'Windows and macOS only' };

function fixture(replyFor) {
  const requests = [];
  const captures = [];
  const checkpoints = [];
  const claims = [];
  let separateReads = 0;
  let separateSettles = 0;
  let recoveries = 0;
  let aborted = false;
  const activeExecution = { sessionId: 'sequence-batch-test', aborted: false };
  const assertExecutionNotAborted = () => {
    if (aborted) throw new Error('computer_session_aborted: fixture stopped');
  };
  const host = {
    ...createExecutionState(),
    ...createSessionState({ callPowerShell: async () => ({ ok: true }) }),
    isObserveOnly: () => false,
    sessionIdFor: () => 'sequence-batch-test',
    framesBySession: new Map(),
    elementTargetsBySession: new Map(),
    observedWindowBySession: new Map(),
    lastCaptureBySession: new Map(),
    sessionRecoveryBySession: new Map(),
    assertExecutionNotAborted,
    resolveElementAliases: (command) => ({ ...command }),
    freshObservedWindowScope: () => scope,
    resolveInputTarget: async () => ({
      targetWindowId: 'hwnd:0x1',
      allowedWindowIds: ['hwnd:0x1'],
      observedScope: scope,
    }),
    claimComputerTargets: async (_, ids) => {
      claims.push(...ids);
    },
    executionContext: { getStore: () => activeExecution },
    readInputRecovery: async () => ({}),
    verifyInputRecovery: async () => {
      recoveries++;
      return { ok: true };
    },
    readWindowIntegrity: async () => ({ known: true, higher: false }),
    readComputerWindows: async () => {
      separateReads++;
      return windows;
    },
    settleWindowTransition: async () => {
      separateSettles++;
      return { transition: null, settleDelayMs: 150 };
    },
    captureAfterAction: async (_, windowId) => {
      assertExecutionNotAborted();
      captures.push(windowId);
      return { metadata: { ok: true }, image: { mimeType: 'image/jpeg', data: 'fixture' } };
    },
    callPowerShell: async (request) => {
      requests.push(request);
      const result = replyFor?.(request, requests.length, () => {
        aborted = true;
      });
      if (result) return result;
      const step = request.step || request;
      const delivered = { action: step.action, delivery: step.delivery, delivery_accepted: true, path: 'fixture' };
      return {
        id: requests.length,
        ok: true,
        result:
          request.action === 'sequence_step'
            ? {
                step_result: delivered,
                windows_before: windows,
                windows_after: windows,
                settle_delay_ms: 150,
                timings_ms: {
                  delivery_ms: 2,
                  before_windows_ms: 3,
                  after_windows_ms: 4,
                  settle_ms: 150,
                  backend_ms: 159,
                  settle_credit_ms: 0,
                },
              }
            : delivered,
      };
    },
  };
  const runner = createSequenceRunner({
    ...host,
    recordProgress: (completed, inFlight) => checkpoints.push({ completed, inFlight }),
    runCommand: (command) => router.runCommand(command),
  });
  const router = createCommandRouter({ ...host, runBoundedSequence: runner.runBoundedSequence });
  return {
    router,
    requests,
    captures,
    checkpoints,
    claims,
    counters: () => ({ separateReads, separateSettles, recoveries }),
  };
}

const command = {
  action: 'sequence',
  window_id: 'hwnd:0x1',
  steps: [
    { action: 'key', keys: '{TAB}' },
    { action: 'type', text: 'private fixture value' },
  ],
};

test(
  'background sequence batches native phases but retains per-step checkpoints and one capture',
  NATIVE_POINTS_KNOWN,
  async () => {
    const f = fixture();
    const reply = await f.router.runCommand(command);
    const payload = JSON.parse(reply.text);
    assert.equal(payload.completed, true);
    assert.deepEqual(
      f.requests.map((request) => [request.action, request.step.action]),
      [
        ['sequence_step', 'key'],
        ['sequence_step', 'type'],
      ]
    );
    assert.deepEqual(f.counters(), { separateReads: 0, separateSettles: 0, recoveries: 0 });
    assert.deepEqual(f.captures, ['hwnd:0x1']);
    assert.deepEqual(f.checkpoints, [
      { completed: 0, inFlight: undefined },
      { completed: 0, inFlight: 0 },
      { completed: 1, inFlight: undefined },
      { completed: 1, inFlight: 1 },
      { completed: 2, inFlight: undefined },
    ]);
    const record = computerRunRecord(command, performance.now(), reply);
    assert.equal(record.step_timings[0].timings_ms.backend_ms, 159);
    assert.equal(record.step_timings[0].timings_ms.settle_credit_ms, 0);
    assert.ok(record.step_timings[0].timings_ms.backend_roundtrip_ms >= 0);
    assert.doesNotMatch(JSON.stringify(record), /private fixture value/);
  }
);

test(
  'foreground sequences keep recovery and ordinary non-sequence inputs are not batched',
  NATIVE_POINTS_KNOWN,
  async () => {
    const foreground = fixture();
    assert.equal(
      JSON.parse((await foreground.router.runCommand({ ...command, delivery: 'foreground' })).text).completed,
      true
    );
    assert.deepEqual(
      foreground.requests.map((request) => request.action),
      ['key', 'type']
    );
    // The worker request is a field whitelist. A continuation flag that never
    // reaches it costs nothing visible and silently reacquires the cursor theme
    // for every step, so assert the flag on the wire rather than on the command.
    assert.deepEqual(
      foreground.requests.map((request) => request.input_continues),
      [true, null]
    );
    assert.deepEqual(foreground.counters(), { separateReads: 2, separateSettles: 2, recoveries: 2 });
    const ordinary = fixture();
    await ordinary.router.runCommand({ action: 'key', window_id: 'hwnd:0x1', keys: '{TAB}' });
    assert.deepEqual(
      ordinary.requests.map((request) => request.action),
      ['key']
    );
  }
);

test('a later ref step keeps the observation refs alive only up to that step', NATIVE_POINTS_KNOWN, async () => {
  const byRef = {
    action: 'sequence',
    window_id: 'hwnd:0x1',
    steps: [
      { action: 'click', ref: 's1:e1' },
      { action: 'set_value', ref: 's1:e2', text: 'value' },
      { action: 'key', keys: '{ENTER}' },
    ],
  };
  const background = fixture();
  assert.equal(JSON.parse((await background.router.runCommand(byRef)).text).completed, true);
  // The worker retires refs after the outer request, so the flag rides there;
  // the step it guards re-proves its ref from the inner request.
  assert.deepEqual(
    background.requests.map((request) => [request.retain_refs, request.step.sequence_continuation]),
    [
      [true, undefined],
      [undefined, true],
      [undefined, undefined],
    ]
  );
  const foreground = fixture();
  await foreground.router.runCommand({ ...byRef, delivery: 'foreground' });
  assert.deepEqual(
    foreground.requests.map((request) => [request.retain_refs, request.sequence_continuation]),
    [
      [true, undefined],
      [undefined, true],
      [undefined, undefined],
    ]
  );
  const forged = fixture();
  await forged.router.runCommand({ action: 'click', window_id: 'hwnd:0x1', ref: 's1:e1', retain_refs: true });
  assert.equal(forged.requests[0].retain_refs, undefined, 'only a vetted sequence step can keep refs');
});

test('a later step addresses elements by ref only', NATIVE_POINTS_KNOWN, async () => {
  const f = fixture();
  for (const [step, pattern] of [
    [{ action: 'type', x: 4, y: 4, text: 'x' }, /by ref only/],
    [{ action: 'type', element: 3, text: 'x' }, /by ref only/],
    [{ action: 'click', ref: 's1:e2', element: 3 }, /by ref only/],
    [{ action: 'click', x: 4, y: 4 }, /requires a ref from the same observation/],
    [{ action: 'drag', ref: 's1:e2', to: 's1:e3' }, /type, key, wait, or a ref-addressed input/],
  ]) {
    await assert.rejects(
      f.router.runCommand({ action: 'sequence', window_id: 'hwnd:0x1', steps: [{ action: 'key', keys: 'a' }, step] }),
      pattern
    );
  }
  assert.equal(f.requests.length, 0, 'a refused shape sends nothing');
});

test(
  'a native batch successor is claimed and captured without dispatching the old continuation',
  NATIVE_POINTS_KNOWN,
  async () => {
    const child = { ...windows[0], id: 'hwnd:0x2', owner_id: 'hwnd:0x1', focused: true };
    const f = fixture(() => ({
      id: 1,
      ok: true,
      result: {
        step_result: { action: 'key', delivery_accepted: true },
        windows_before: windows,
        windows_after: [...windows, child],
        settle_delay_ms: 150,
      },
    }));
    const payload = JSON.parse((await f.router.runCommand(command)).text);
    assert.equal(payload.stopped_reason, 'target_transition');
    assert.equal(f.requests.length, 1);
    assert.ok(f.claims.includes(child.id));
    assert.deepEqual(f.captures, [child.id]);
  }
);

test(
  'failed or incomplete native step replies are never retried or followed by more input',
  NATIVE_POINTS_KNOWN,
  async () => {
    for (const response of [
      { id: 1, ok: false, error: 'computer_policy_expired: stopped before native dispatch' },
      { id: 1, ok: true, result: { step_result: { action: 'key' } } },
    ]) {
      const f = fixture(() => response);
      const payload = JSON.parse((await f.router.runCommand(command)).text);
      assert.equal(payload.completed, false);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(
        payload.steps.map((step) => step.status),
        ['failed', 'skipped']
      );
    }
  }
);

test(
  'a pause or cancellation during the native batch cannot dispatch a continuation',
  NATIVE_POINTS_KNOWN,
  async () => {
    const paused = fixture(() => ({ id: 1, ok: false, error: 'user_input_active: native input interrupted' }));
    await assert.rejects(paused.router.runCommand(command), /user_input_active/);
    assert.equal(paused.requests.length, 1);
    assert.deepEqual(paused.captures, []);
    const stopped = fixture((_, __, abort) => {
      abort();
    });
    await assert.rejects(stopped.router.runCommand(command), /computer_session_aborted/);
    assert.equal(stopped.requests.length, 1);
    assert.deepEqual(stopped.captures, []);
  }
);
