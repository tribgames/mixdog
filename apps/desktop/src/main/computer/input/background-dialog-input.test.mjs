import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundDialogInputError } from './background-dialog-input.ts';

const owner = { id: 'hwnd:0x1', title: '메모장', className: 'Notepad', focused: true };
const dialog = { id: 'hwnd:0x2', title: '다른 이름으로 저장', className: '#32770', focused: false };
const windows = [owner, dialog];
const unfocusedOwner = { ...owner, focused: false };

const call = (extra) => backgroundDialogInputError({ targetWindowId: dialog.id, windows, ...extra });

test('typing into a dialog that does not hold focus is refused instead of reported as delivered', () => {
  const error = call({ action: 'type', delivery: 'background' });
  assert.match(error, /^focus_required:/);
  assert.match(error, /다른 이름으로 저장/);
  assert.match(error, /no input was sent/);
});

test('the same dialog accepts background text once it holds focus', () => {
  const focused = [unfocusedOwner, { ...dialog, focused: true }];
  assert.equal(call({ action: 'type', delivery: 'background', windows: focused }), null);
});

test('a ref addresses the control itself, so it does not need the dialog to be focused', () => {
  assert.equal(call({ action: 'type', delivery: 'background', hasRef: true }), null);
});

test('keys the dialog manager owns are refused even with focus, because a posted message bypasses it', () => {
  const focused = [unfocusedOwner, { ...dialog, focused: true }];
  for (const keys of ['enter', '{ENTER}', 'Escape', 'tab']) {
    const error = backgroundDialogInputError({
      action: 'key',
      delivery: 'background',
      keys,
      targetWindowId: dialog.id,
      windows: focused,
    });
    assert.match(error, /^dialog_key_unsupported:/, `${keys} reaches no button through a background message`);
    assert.match(error, /foreground/);
  }
  // A plain character still rides the focused control.
  assert.equal(
    backgroundDialogInputError({
      action: 'key',
      delivery: 'background',
      keys: 'a',
      targetWindowId: dialog.id,
      windows: focused,
    }),
    null
  );
});

test('foreground delivery, ordinary windows and unknown focus are left alone', () => {
  assert.equal(call({ action: 'type', delivery: 'foreground' }), null);
  assert.equal(call({ action: 'click', delivery: 'background' }), null);
  assert.equal(
    backgroundDialogInputError({
      action: 'type',
      delivery: 'background',
      targetWindowId: owner.id,
      windows,
    }),
    null
  );
  // No window reports focus: that is not evidence the dialog lacks it.
  assert.equal(call({ action: 'type', delivery: 'background', windows: [unfocusedOwner, dialog] }), null);
  assert.equal(call({ action: 'type', delivery: 'background', windows: null }), null);
});
