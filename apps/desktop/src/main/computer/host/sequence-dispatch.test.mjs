import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron' ? {
      url: 'data:text/javascript,' + encodeURIComponent(`
        export const BrowserWindow = { getAllWindows: () => [] };
        export const screen = {};
      `), shortCircuit: true,
    } : next(specifier, context);
  },
});
const { createCommandRouter } = await import('./command-router.ts');
const { createSequenceRunner } = await import('./sequence-runner.ts');
const { computerRunRecord } = await import('../session/run-log.ts');

const windows = [{ id: 'hwnd:0x1', pid: 10, title: 'Fixture', width: 500, height: 300 }];
const scope = { primaryWindowId: 'hwnd:0x1', relatedWindowIds: ['hwnd:0x1'], observedAt: Date.now() };
const WINDOWS_ONLY = { skip: process.platform !== 'win32' };

function fixture(replyFor) {
  const requests = [];
  const captures = [];
  const checkpoints = [];
  const claims = [];
  let separateReads = 0;
  let separateSettles = 0;
  let recoveries = 0;
  let aborted = false;
  const assertExecutionNotAborted = () => {
    if (aborted) throw new Error('computer_session_aborted: fixture stopped');
  };
  const host = {
    isObserveOnly: () => false, sessionIdFor: () => 'sequence-batch-test',
    framesBySession: new Map(), elementTargetsBySession: new Map(), observedWindowBySession: new Map(),
    lastCaptureBySession: new Map(), sessionRecoveryBySession: new Map(),
    assertExecutionNotAborted, resolveElementAliases: (command) => ({ ...command }),
    freshObservedWindowScope: () => scope,
    resolveInputTarget: async () => ({ targetWindowId: 'hwnd:0x1', allowedWindowIds: ['hwnd:0x1'], observedScope: scope }),
    claimComputerTargets: async (_, ids) => { claims.push(...ids); },
    executionContext: { getStore: () => undefined },
    readInputRecovery: async () => ({}),
    verifyInputRecovery: async () => { recoveries++; return { ok: true }; },
    readWindowIntegrity: async () => ({ known: true, higher: false }),
    readComputerWindows: async () => { separateReads++; return windows; },
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
      const result = replyFor?.(request, requests.length, () => { aborted = true; });
      if (result) return result;
      const step = request.step || request;
      const delivered = { action: step.action, delivery: step.delivery, delivery_accepted: true, path: 'fixture' };
      return { id: requests.length, ok: true, result: request.action === 'sequence_step' ? {
        step_result: delivered, windows_before: windows, windows_after: windows, settle_delay_ms: 150,
        timings_ms: {
          delivery_ms: 2, before_windows_ms: 3, after_windows_ms: 4,
          settle_ms: 150, backend_ms: 159, settle_credit_ms: 0,
        },
      } : delivered };
    },
  };
  const runner = createSequenceRunner({
    ...host, recordProgress: (completed, inFlight) => checkpoints.push({ completed, inFlight }),
    runCommand: (command) => router.runCommand(command),
  });
  const router = createCommandRouter({ ...host, runBoundedSequence: runner.runBoundedSequence });
  return {
    router, requests, captures, checkpoints, claims,
    counters: () => ({ separateReads, separateSettles, recoveries }),
  };
}

const command = {
  action: 'sequence', window_id: 'hwnd:0x1',
  steps: [{ action: 'key', keys: '{TAB}' }, { action: 'type', text: 'private fixture value' }],
};

test('background sequence batches native phases but retains per-step checkpoints and one capture', WINDOWS_ONLY, async () => {
  const f = fixture();
  const reply = await f.router.runCommand(command);
  const payload = JSON.parse(reply.text);
  assert.equal(payload.completed, true);
  assert.deepEqual(f.requests.map((request) => [request.action, request.step.action]),
    [['sequence_step', 'key'], ['sequence_step', 'type']]);
  assert.deepEqual(f.counters(), { separateReads: 0, separateSettles: 0, recoveries: 0 });
  assert.deepEqual(f.captures, ['hwnd:0x1']);
  assert.deepEqual(f.checkpoints, [
    { completed: 0, inFlight: undefined }, { completed: 0, inFlight: 0 },
    { completed: 1, inFlight: undefined }, { completed: 1, inFlight: 1 },
    { completed: 2, inFlight: undefined },
  ]);
  const record = computerRunRecord(command, performance.now(), reply);
  assert.equal(record.step_timings[0].timings_ms.backend_ms, 159);
  assert.equal(record.step_timings[0].timings_ms.settle_credit_ms, 0);
  assert.ok(record.step_timings[0].timings_ms.backend_roundtrip_ms >= 0);
  assert.doesNotMatch(JSON.stringify(record), /private fixture value/);
});

test('foreground sequences keep recovery and ordinary non-sequence inputs are not batched', WINDOWS_ONLY, async () => {
  const foreground = fixture();
  assert.equal(JSON.parse((await foreground.router.runCommand({ ...command, delivery: 'foreground' })).text).completed, true);
  assert.deepEqual(foreground.requests.map((request) => request.action), ['key', 'type']);
  assert.deepEqual(foreground.counters(), { separateReads: 2, separateSettles: 2, recoveries: 2 });
  const ordinary = fixture();
  await ordinary.router.runCommand({ action: 'key', window_id: 'hwnd:0x1', keys: '{TAB}' });
  assert.deepEqual(ordinary.requests.map((request) => request.action), ['key']);
});

test('a native batch successor is claimed and captured without dispatching the old continuation', WINDOWS_ONLY, async () => {
  const child = { ...windows[0], id: 'hwnd:0x2', owner_id: 'hwnd:0x1', focused: true };
  const f = fixture(() => ({ id: 1, ok: true, result: {
    step_result: { action: 'key', delivery_accepted: true },
    windows_before: windows, windows_after: [...windows, child], settle_delay_ms: 150,
  } }));
  const payload = JSON.parse((await f.router.runCommand(command)).text);
  assert.equal(payload.stopped_reason, 'target_transition');
  assert.equal(f.requests.length, 1);
  assert.ok(f.claims.includes(child.id));
  assert.deepEqual(f.captures, [child.id]);
});

test('failed or incomplete native step replies are never retried or followed by more input', WINDOWS_ONLY, async () => {
  for (const response of [
    { id: 1, ok: false, error: 'computer_policy_expired: stopped before native dispatch' },
    { id: 1, ok: true, result: { step_result: { action: 'key' } } },
  ]) {
    const f = fixture(() => response);
    const payload = JSON.parse((await f.router.runCommand(command)).text);
    assert.equal(payload.completed, false);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(payload.steps.map((step) => step.status), ['failed', 'skipped']);
  }
});

test('a pause or cancellation during the native batch cannot dispatch a continuation', WINDOWS_ONLY, async () => {
  const paused = fixture(() => ({ id: 1, ok: false, error: 'user_input_active: native input interrupted' }));
  await assert.rejects(paused.router.runCommand(command), /user_input_active/);
  assert.equal(paused.requests.length, 1);
  assert.deepEqual(paused.captures, []);
  const stopped = fixture((_, __, abort) => { abort(); });
  await assert.rejects(stopped.router.runCommand(command), /computer_session_aborted/);
  assert.equal(stopped.requests.length, 1);
  assert.deepEqual(stopped.captures, []);
});
