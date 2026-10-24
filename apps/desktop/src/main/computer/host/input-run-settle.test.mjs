import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,' +
            encodeURIComponent('export const BrowserWindow = { getAllWindows: () => [] }; export const screen = {};'),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { settleInputRun } = await import('./input-run-settle.ts');

const USER_INPUT_SEEN = { ok: false, user_control: true, recovery_skipped: true, code: 'user_input_active' };

function settleFixture(verification, { command = { action: 'click' }, result } = {}) {
  const takeovers = [];
  const diagnostics = [];
  const state = { sessionId: 'a', aborted: false };
  const executionContext = new AsyncLocalStorage();
  const sessionDesktopAnchor = new Map();
  const host = {
    sessionIdFor: () => 'a',
    executionContext,
    sessionDesktopAnchor,
    verifyInputRecovery: async () => verification,
    settleWindowTransition: async () => ({ transition: null, settleDelayMs: 0 }),
    takeOverComputer: (reason) => takeovers.push(reason),
    recordDiagnostic: (_, record) => diagnostics.push(record),
  };
  const input = {
    run: { command, action: command.action, isMutation: true, actionTimings: {} },
    prepared: {
      targetWindowId: 'hwnd:0x1',
      logicalTargetWindowId: 'hwnd:0x1',
      inputRecovery: { foregroundWindowId: 'hwnd:0x9', inputMonitorId: 'm', inputUserSequence: 1 },
    },
    response: { result: result ?? { code: undefined, path: 'foreground', effect: 'unverifiable' } },
    commandStartedAt: 0,
  };
  const run = () => executionContext.run(state, async () => JSON.parse((await settleInputRun(host, {}, input)).text));
  return { run, takeovers, diagnostics, state, sessionDesktopAnchor };
}

const SKIPPED_FOR_USER = { recovery_skipped: true, user_control: true };

test('an action the native side refused without sending keeps its refusal when the user is typing', async () => {
  const f = settleFixture(USER_INPUT_SEEN, {
    command: { action: 'type', delivery: 'background' },
    result: {
      action: 'type',
      path: 'background',
      code: 'target_mismatch',
      effect: 'unverifiable',
      delivery_accepted: false,
    },
  });
  const reply = await f.run();
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'target_mismatch');
  assert.equal(reply.delivery_accepted, false);
  assert.equal(reply.input_may_have_executed, undefined);
  assert.deepEqual(reply.input_recovery, SKIPPED_FOR_USER);
  assert.deepEqual(f.takeovers, []);
  assert.equal(f.state.failureCode, undefined);
  assert.equal([...f.sessionDesktopAnchor.values()][0].userOwned, true, 'the user owns focus and pointer');
});

test('a foreground refusal that sent nothing is not turned into uncertain input', async () => {
  const f = settleFixture(USER_INPUT_SEEN, {
    command: { action: 'type', delivery: 'foreground' },
    result: { action: 'type', path: 'foreground', code: 'target_mismatch', delivery_accepted: false },
  });
  const reply = await f.run();
  assert.equal(reply.code, 'target_mismatch');
  assert.equal(reply.input_may_have_executed, undefined);
  assert.deepEqual(f.takeovers, []);
});

test('any delivery the native side accepted or may have executed stays uncertain under user input', async () => {
  const cases = [
    [
      { action: 'type', delivery: 'foreground' },
      { action: 'type', path: 'foreground', delivery_accepted: true },
    ],
    [
      { action: 'set_value', delivery: 'background' },
      { action: 'set_value', path: 'uia_value', effect: 'confirmed', verified: true, delivery_accepted: true },
    ],
    [
      { action: 'type', delivery: 'background' },
      { action: 'type', path: 'background', delivery_accepted: false, input_may_have_executed: true },
    ],
  ];
  for (const [command, result] of cases) {
    const reply = await settleFixture(USER_INPUT_SEEN, { command, result }).run();
    assert.equal(reply.code, 'user_input_active', JSON.stringify(command));
    assert.equal(reply.input_may_have_executed, true);
    assert.equal(reply.effect, 'unverifiable');
  }
});

test('failures that are not the user still take the desktop back for a background delivery', async () => {
  const f = settleFixture(
    { ok: false, recovery_skipped: true, code: 'input_observation_unavailable' },
    {
      command: { action: 'type', delivery: 'background' },
      result: { action: 'type', path: 'background', delivery_accepted: true },
    }
  );
  const reply = await f.run();
  assert.equal(reply.code, 'input_observation_unavailable');
  assert.deepEqual(f.takeovers, ['input_observation_unavailable']);
});

test('readback that finds user input refuses the action without a takeover', async () => {
  const f = settleFixture(USER_INPUT_SEEN, {
    command: { action: 'click', delivery: 'foreground' },
    result: { code: undefined, path: 'foreground', effect: 'unverifiable', delivery_accepted: true },
  });
  const reply = await f.run();
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'user_input_active');
  assert.equal(reply.effect, 'unverifiable');
  assert.equal(reply.input_may_have_executed, true);
  assert.equal(reply.verdict.decision, 'escalate');
  assert.equal(reply.verdict.recommended, 'recapture');
  assert.equal(reply.input_recovery.recovery_skipped, true);
  assert.deepEqual(f.takeovers, []);
  assert.equal(f.state.failureCode, undefined);
  assert.equal(f.diagnostics[0].code, 'user_input_active');
});

test('an unconfirmed recovery still hands the desktop back to the user', async () => {
  const f = settleFixture({ ok: false, code: 'input_recovery_unconfirmed' });
  const reply = await f.run();
  assert.equal(reply.code, 'input_recovery_unconfirmed');
  assert.equal(reply.verdict.recommended, 'wait_for_user');
  assert.deepEqual(f.takeovers, ['input_recovery_unconfirmed']);
  assert.equal(f.state.failureCode, 'input_recovery_unconfirmed');
});
