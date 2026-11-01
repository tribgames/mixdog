import assert from 'node:assert/strict';
import test from 'node:test';
import {
  controlTookForeground,
  describeWatchedInput,
  focusExcursions,
  judgeFocusLock,
} from './scenario-focus-input.ts';
import { userControlDetail } from './scenario-user-control.ts';

test('a refusal names the check: the host readback carries its verdict, a native check does not', () => {
  const readback = userControlDetail({
    code: 'user_input_active',
    message: 'user input interrupted this action',
    input_recovery: { ok: false, user_control: true, code: 'user_input_active' },
  });
  assert.match(readback, /^user_input_active from the host's readback after the native call: \{"ok":false/);
  assert.equal(
    userControlDetail({ code: 'user_input_active', message: 'no input was sent' }),
    'user_input_active from a check during the native call; no input was sent'
  );
  assert.match(userControlDetail({ code: 'computer_user_intervention_pending' }), /from the host coordinator$/);
});

test('an excursion runs from leaving the sentinel to both foreground and focus being back', () => {
  const S = 1;
  const watch = {
    armed_at: 100,
    changes: [
      { at: 50, foreground: 2, focus: 2 },
      { at: 100, foreground: S, focus: S },
      { at: 200, foreground: 2, focus: S },
      { at: 210, foreground: 3, focus: 3 },
      // Foreground back but not yet the focus: still away.
      { at: 300, foreground: S, focus: 3 },
      { at: 350, foreground: S, focus: S },
      { at: 500, foreground: 2, focus: 2 },
    ],
    typed: [120, 205, 340, 360, 600],
  };
  assert.deepEqual(focusExcursions(watch, S), [
    { from: 200, to: 350, foreground: 2, focus: S, typed: 2 },
    { from: 500, to: undefined, foreground: 2, focus: 2, typed: 1 },
  ]);
  assert.deepEqual(focusExcursions({ ...watch, armed_at: 0 }, S), []);
});

test('the target taking the foreground is judged from the OS watch, not the fixture focus flag', () => {
  const [S, T] = [1, 7];
  const judge = (changes) =>
    judgeFocusLock({
      watch: { armed_at: 100, changes: [{ at: 100, foreground: S, focus: S }, ...changes], typed: [], withheld: 0 },
      sentinel: S,
      target: T,
      runs: [{ action: 'toggle', sentAt: 1_000, repliedAt: 1_100 }],
      settleMs: 600,
      boundMs: 400,
      claims: [{ label: 'toggle activation at 1110', at: 1_110 }],
    });
  // Electron said focused, but the OS foreground and focus never moved.
  const pageLevel = judge([]);
  assert.deepEqual(pageLevel.failures, []);
  assert.equal(pageLevel.notes.length, 1);
  assert.match(pageLevel.notes[0], /^toggle activation at 1110: .*did not move to it/);
  // The OS shows the target in front for 500 ms: over the 400 ms bound.
  const tooLong = judge([
    { at: 1_050, foreground: T, focus: T },
    { at: 1_550, foreground: S, focus: S },
  ]);
  assert.deepEqual(tooLong.notes, []);
  assert.equal(tooLong.failures.length, 1);
  assert.match(
    tooLong.failures[0],
    /the foreground went to the target .* 50 ms after the toggle request .* for 500 ms, over the 400 ms bound/
  );
  // Within the bound the same excursion passes, and the claim inside it is covered.
  assert.deepEqual(
    judge([
      { at: 1_050, foreground: T, focus: T },
      { at: 1_250, foreground: S, focus: S },
    ]).failures,
    []
  );
});

test('the control counts only when the OS foreground moved to the target', () => {
  const [S, T] = [1, 7];
  // The fixture said focused, but the OS foreground stayed on the sentinel;
  // the target holding only the focus root is not the foreground either.
  assert.equal(controlTookForeground([], T), false);
  assert.equal(
    controlTookForeground(
      [
        { at: 10, foreground: S, focus: S },
        { at: 20, foreground: S, focus: T },
      ],
      T
    ),
    false
  );
  assert.equal(
    controlTookForeground(
      [
        { at: 10, foreground: S, focus: S },
        { at: 20, foreground: T, focus: T },
      ],
      T
    ),
    true
  );
});

test('the watched-input line counts only what fell inside the step and lists injected input', () => {
  const watch = {
    inputs: [
      { at: 900, kind: 'pointer', injected: false },
      { at: 1_050, kind: 'pointer', injected: false },
      { at: 1_100, kind: 'key', injected: false },
      { at: 1_200, kind: 'key', injected: true, vk: 0xb9, flags: 0x10, extra: 0, foreground: 'chrome/42' },
    ],
    clock: [950, 1_300],
  };
  const line = describeWatchedInput(watch, 1_000, 1_500);
  assert.match(line, /for 500 ms: 1 physical key events, 1 physical pointer events, 1 injected events/);
  assert.match(line, /\[key vk 0xb9 flags 0x10 extra 0 at \+200 ms \(foreground chrome\/42\)\]/);
  assert.match(line, /1 last-input clock moves no hooked event explains \(at \+300 ms\)$/);
  assert.match(
    describeWatchedInput({ inputs: [], clock: [] }, 0, 10),
    /0 physical key events, 0 physical pointer events, 0 injected events, 0 last-input clock moves/
  );
});
