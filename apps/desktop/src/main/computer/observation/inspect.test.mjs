import assert from 'node:assert/strict';
import test from 'node:test';
import { createInspection } from './inspect.ts';

function inspection(result) {
  return createInspection({
    callPowerShell: async () => ({ ok: true, result }),
    sessionIdFor: () => 'test',
    assertExecutionNotAborted() {},
    readComputerWindows: async () => [],
    readDisplays: () => [],
    isObserveOnly: () => false,
  });
}

test('verification keeps provider budgets intact near the polling deadline and in one-shot mode', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    now += delay;
    queueMicrotask(callback);
  });
  for (const [timeout, expectedSamples] of [
    [0, 1],
    [100, 1],
    [350, 2],
  ]) {
    now = 0;
    const budgets = [];
    const reader = createInspection({
      callPowerShell: async (_request, budget) => {
        budgets.push(budget);
        now += 50;
        return { ok: true, result: { exists: true, title: 'not ready' } };
      },
      sessionIdFor: () => 'verify-budget',
      assertExecutionNotAborted() {},
    });
    const result = JSON.parse(
      (
        await reader.verifyWindowState({
          action: 'verify',
          window_id: 'hwnd:0x1',
          expect: [{ window_exists: false }],
          timeout_ms: timeout,
          stable_samples: 1,
        })
      ).text
    );
    assert.equal(result.decision, 'unsatisfied');
    assert.equal(result.samples, expectedSamples);
    assert.equal(result.provider_error, undefined);
    assert.deepEqual(budgets, Array(expectedSamples).fill(2_000));
  }
});

test('genuine predicate provider failure remains unknown, not proof of absence', async () => {
  const reader = createInspection({
    callPowerShell: async () => {
      throw new Error('provider timed out');
    },
    sessionIdFor: () => 'verify-failure',
    assertExecutionNotAborted() {},
  });
  const result = JSON.parse(
    (
      await reader.verifyWindowState({
        action: 'verify',
        window_id: 'hwnd:0x1',
        expect: [{ absent: 'error' }],
        timeout_ms: 0,
      })
    ).text
  );
  assert.equal(result.ok, false);
  assert.equal(result.decision, 'unknown');
  assert.equal(result.provider_error, 'provider timed out');
});

test('verification propagates provider coverage instead of treating missing text as absence', async () => {
  for (const [elements, text_complete, expected] of [
    [[], true, 'unknown'],
    [[{ name: 'ready' }], undefined, 'unknown'],
    [[{ name: 'ready' }], false, 'unknown'],
    [[{ name: 'ready' }], true, 'satisfied'],
    [[{ name: 'error' }], false, 'unsatisfied'],
  ]) {
    const result = JSON.parse(
      (
        await inspection({
          exists: true,
          elements,
          text_complete,
        }).verifyWindowState({
          action: 'verify',
          window_id: 'hwnd:0x1',
          expect: [{ absent: 'error' }],
          timeout_ms: 0,
          stable_samples: 1,
        })
      ).text
    );
    assert.equal(result.decision, expected);
    assert.equal(result.ok, expected === 'satisfied');
  }
});

test('diagnose reports blocked input even when window enumeration and accessibility work', async () => {
  for (const state of [
    { userControlActive: true, cleanupState: 'ready', takeoverReason: 'input_recovery_unconfirmed' },
    { userControlActive: false, cleanupState: 'failed', takeoverReason: '' },
    { userControlActive: false, cleanupState: 'pending', takeoverReason: '' },
    { userControlActive: false, cleanupState: 'ready', takeoverReason: '' },
  ]) {
    const reader = createInspection({
      callPowerShell: async () => ({
        ok: true,
        result: { elements: [{}], available: true, observer_ready: true, ready: true, held: false },
      }),
      sessionIdFor: () => 'diagnose',
      assertExecutionNotAborted() {},
      readComputerWindows: async () => [{ id: 'hwnd:0x1', focused: true }],
      readDisplays: () => [],
      isObserveOnly: () => false,
      readInputState: () => state,
    });
    const result = JSON.parse((await reader.diagnoseComputer({ action: 'diagnose' })).text);
    const blocked = state.userControlActive || state.cleanupState !== 'ready';
    assert.equal(result.ok, true);
    assert.equal(result.ready, !blocked);
    assert.equal(result.capabilities.input_mode, blocked ? 'blocked' : 'enabled');
    assert.equal(result.capabilities.input_state.cleanup_state, state.cleanupState);
    assert.equal(
      result.issues.some((issue) => issue.startsWith('input blocked:')),
      blocked
    );
  }
});

test('diagnose probes native input readiness instead of inferring it from usable accessibility', async () => {
  for (const native of [
    { observer_ready: true, ready: true, held: false },
    { observer_ready: false, ready: false, held: false },
    { observer_ready: true, ready: false, held: false },
    { observer_ready: true, ready: true, held: true },
    new Error('native observation unavailable'),
  ]) {
    const reader = createInspection({
      callPowerShell: async (request) => {
        if (request.action === 'input_idle_state') {
          if (native instanceof Error) throw native;
          return { ok: true, result: native };
        }
        return { ok: true, result: { elements: [{}], available: true } };
      },
      sessionIdFor: () => 'diagnose-input',
      assertExecutionNotAborted() {},
      readComputerWindows: async () => [{ id: 'hwnd:0x1', focused: true }],
      readDisplays: () => [],
      isObserveOnly: () => false,
      readInputState: () => ({ userControlActive: false, cleanupState: 'ready' }),
    });
    const result = JSON.parse((await reader.diagnoseComputer({ action: 'diagnose' })).text);
    const ready = native.observer_ready === true && native.ready === true && native.held === false;
    assert.equal(result.capabilities.semantic_accessibility.available, true);
    assert.equal(result.capabilities.input_observation.ready, ready);
    assert.equal(result.ready, ready);
    assert.equal(
      result.issues.some((issue) => /input|observation/.test(issue)),
      !ready
    );
  }
});
