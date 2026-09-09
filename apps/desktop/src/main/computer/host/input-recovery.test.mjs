import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputResolution } from './input-resolution.ts';

const original = {
  targetWindowId: 'hwnd:0x1', foregroundWindowId: 'hwnd:0x2',
  restoreWindowId: 'hwnd:0x2', restoreOwnerWindowId: '',
  cursorX: 10, cursorY: 20, inputTick: 100,
  inputObserverReady: true, inputMonitorId: 'monitor-a', inputUserSequence: 0,
};
const state = {
  target_window_id: 'hwnd:0x1', foreground_window_id: 'hwnd:0x1',
  cursor_x: 10, cursor_y: 20, input_tick: 100, synthetic_input: false,
  foreground_within_target: true,
  input_observer_ready: true, input_monitor_id: 'monitor-a', input_user_sequence: 0,
};

test('user input after dispatch is preserved rather than restored over', async () => {
  const calls = [];
  const resolver = createInputResolution({
    sessionIdFor: () => 'test',
    callPowerShell: async (request) => {
      calls.push(request);
      return { ok: true, result: { ...state, cursor_x: 300, cursor_y: 400, input_tick: 200, input_user_sequence: 1 } };
    },
  });
  const result = await resolver.verifyInputRecovery({ action: 'click' }, 'hwnd:0x1', original, {});
  assert.equal(result.ok, false);
  assert.equal(result.user_control, true);
  assert.equal(result.recovery_skipped, true);
  assert.deepEqual(calls.map((call) => call.action), ['input_recovery_state']);
});

test('visible foreground input keeps the real pointer at its destination between actions', async () => {
  const calls = [];
  const resolver = createInputResolution({
    sessionIdFor: () => 'test',
    callPowerShell: async request => {
      calls.push(request.action);
      return { ok: true, result: { ...state, cursor_x: 3100, cursor_y: 1200, synthetic_input: true } };
    },
  });
  const result = await resolver.verifyInputRecovery(
    { action: 'click', delivery: 'foreground' }, 'hwnd:0x1', original, {});
  assert.equal(result.ok, true);
  assert.equal(result.cursor_preserved, true);
  assert.equal(result.cursor_restored, false);
  assert.deepEqual(calls, ['input_recovery_state']);
});

test('explicit focus preparation is not immediately undone by recovery', async () => {
  const calls = [];
  const resolver = createInputResolution({
    sessionIdFor: () => 'test',
    callPowerShell: async request => {
      calls.push(request.action);
      return { ok: true, result: state };
    },
  });
  const result = await resolver.verifyInputRecovery({ action: 'focus_window' }, 'hwnd:0x1', original, {});
  assert.equal(result.ok, true);
  assert.equal(result.focus_preserved_for_followup, true);
  assert.deepEqual(calls, ['input_recovery_state']);
});

test('only target or observed owner relationship counts as preserved foreground', async () => {
  for (const owned of [true, false]) {
    const resolver = createInputResolution({
      sessionIdFor: () => 'test',
      callPowerShell: async () => ({
        ok: true, result: { ...state, foreground_window_id: 'hwnd:0x999', foreground_within_target: owned },
      }),
    });
    const result = await resolver.verifyInputRecovery({ action: 'click' }, 'hwnd:0x1', original, {});
    assert.equal(result.ok, owned);
    assert.equal(result.focus_preserved_for_followup, owned);
  }
});

test('synthetic cursor recovery carries an exact last-input watermark to native dispatch', async () => {
  const calls = [];
  const resolver = createInputResolution({
    sessionIdFor: () => 'test',
    callPowerShell: async (request) => {
      calls.push(request);
      return { ok: true, result: request.action === 'restore_input_state'
        ? { ...state, input_tick: 200, restored_target: 'preserved' }
        : { ...state, cursor_x: 300, input_tick: 200, synthetic_input: true } };
    },
  });
  const result = await resolver.verifyInputRecovery({ action: 'click' }, 'hwnd:0x1', original, {});
  assert.equal(result.ok, true);
  assert.equal(calls[1].expected_input_tick, 200);
  assert.equal(calls[1].expected_input_monitor_id, 'monitor-a');
  assert.equal(calls[1].expected_input_user_sequence, 0);
});

test('own input after physical intervention cannot erase that intervention', async () => {
  const calls = [];
  const resolver = createInputResolution({
    sessionIdFor: () => 'test',
    callPowerShell: async (request) => {
      calls.push(request);
      return { ok: true, result: { ...state, synthetic_input: true, input_user_sequence: 2 } };
    },
  });
  const result = await resolver.verifyInputRecovery({ action: 'key', delivery: 'foreground' }, 'hwnd:0x1', original, {});
  assert.equal(result.user_control, true);
  assert.equal(calls.length, 1);
});

test('observer loss is unknown, not an assertion that the user took control', async () => {
  for (const changed of [{ input_observer_ready: false }, { input_monitor_id: 'replacement' }]) {
    const resolver = createInputResolution({
      sessionIdFor: () => 'test',
      callPowerShell: async () => ({ ok: true, result: { ...state, ...changed } }),
    });
    const result = await resolver.verifyInputRecovery({ action: 'click' }, 'hwnd:0x1', original, {});
    assert.equal(result.code, 'input_observation_unavailable');
    assert.notEqual(result.user_control, true);
  }
});

test('refused input preserves pre-action focus rather than forcing the older session focus', async () => {
  const calls = [];
  const before = { ...original, foregroundWindowId: 'hwnd:0x3' };
  const resolver = createInputResolution({
    sessionIdFor: () => 'test',
    callPowerShell: async request => {
      calls.push(request.action);
      return { ok: true, result: { ...state, foreground_window_id: 'hwnd:0x3', foreground_within_target: false } };
    },
  });
  const result = await resolver.verifyInputRecovery({ action: 'click', delivery: 'foreground' },
    'hwnd:0x1', before, {}, { delivery_accepted: false, code: 'foreground_unavailable' });
  assert.equal(result.ok, true);
  assert.equal(result.input_not_dispatched, true);
  assert.equal(result.focus_unchanged, true);
  assert.deepEqual(calls, ['input_recovery_state']);
  const uncertain = await resolver.verifyInputRecovery({ action: 'click', delivery: 'foreground' },
    'hwnd:0x1', before, {}, {});
  assert.equal(uncertain.ok, false);
});

for (const action of ['mouse_move', 'invoke']) {
  test(`${action} keeps foreground target ready for subsequent actions`, async () => {
    const calls = [];
    const resolver = createInputResolution({
      sessionIdFor: () => 'test',
      callPowerShell: async request => {
        calls.push(request.action);
        return { ok: true, result: state };
      },
    });
    const result = await resolver.verifyInputRecovery({ action, delivery: 'foreground' }, 'hwnd:0x1', original, {});
    assert.equal(result.ok, true);
    assert.equal(result.focus_preserved_for_followup, true);
    assert.deepEqual(calls, ['input_recovery_state']);
  });
}

test('a keyboard-opened owned dialog retains focus for follow-up without restoring another window', async () => {
  const calls = [];
  const resolver = createInputResolution({
    sessionIdFor: () => 'test',
    callPowerShell: async (request) => {
      calls.push(request.action);
      return { ok: true, result: { ...state, foreground_window_id: 'hwnd:0xdialog', input_tick: 450 } };
    },
  });
  const result = await resolver.verifyInputRecovery({ action: 'key', delivery: 'foreground' }, 'hwnd:0x1', original, {});
  assert.equal(result.ok, true);
  assert.equal(result.focus_preserved_for_followup, true);
  assert.deepEqual(calls, ['input_recovery_state']);
});
