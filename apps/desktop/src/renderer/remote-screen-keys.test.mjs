import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRemoteScreenInput } from '../shared/remote-webrtc.ts';
import {
  SCREEN_SPECIAL_KEYS,
  SCREEN_TEXT_SENTINEL,
  createScreenTextController,
  screenKeyCode,
  screenKeyDown,
  screenSpecialKeyInputs,
  screenTextInputs,
} from './remote-screen-keys.ts';

const VK = { backspace: 0x08, enter: 0x0d, tab: 0x09, escape: 0x1b, del: 0x2e, ctrl: 0xa2, alt: 0xa4, win: 0x5b, print: 0x2c };
const key = (extra) => ({ key: '', code: '', keyCode: 0, ...extra });
const summary = (inputs) => inputs.map((input) => `${input.action}:${input.vk}`);

test('a named key with a code is sent as a down/up pair', () => {
  const result = screenKeyDown(key({ key: 'Backspace', code: 'Backspace', keyCode: 8 }));
  assert.deepEqual(summary(result.inputs), [`down:${VK.backspace}`, `up:${VK.backspace}`]);
  assert.equal(result.preventDefault, true);
  assert.equal(result.echo, null);
});

test('a soft keyboard with an empty code falls back to KeyboardEvent.key', () => {
  const backspace = screenKeyDown(key({ key: 'Backspace', code: '', keyCode: 0 }));
  assert.deepEqual(summary(backspace.inputs), [`down:${VK.backspace}`, `up:${VK.backspace}`]);
  assert.equal(backspace.echo, 'Backspace');
  const enter = screenKeyDown(key({ key: 'Enter', code: '', keyCode: 13 }));
  assert.deepEqual(summary(enter.inputs), [`down:${VK.enter}`, `up:${VK.enter}`]);
  assert.equal(enter.echo, 'Enter');
});

test('keyCode 229 ignores the code and reads the key', () => {
  assert.equal(screenKeyCode({ key: 'Enter', code: 'KeyA', keyCode: 229 }), 'Enter');
  const result = screenKeyDown(key({ key: 'Enter', code: 'KeyA', keyCode: 229 }));
  assert.equal(result.echo, 'Enter');
  assert.deepEqual(summary(result.inputs), [`down:${VK.enter}`, `up:${VK.enter}`]);
});

test('an unidentified key, a composing key and a bare printable character send no key', () => {
  for (const event of [
    key({ key: 'Unidentified', code: '', keyCode: 229 }),
    key({ key: 'Process', code: 'KeyA', keyCode: 229 }),
    key({ key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true }),
    key({ key: 'a', code: 'KeyA', keyCode: 65 }),
    key({ key: 'Shift', code: 'ShiftLeft', keyCode: 16 }),
  ]) {
    const result = screenKeyDown(event);
    assert.deepEqual(result.inputs, []);
    assert.equal(result.preventDefault, false);
  }
});

test('Ctrl/Alt/Win chords press their modifiers around the key', () => {
  const result = screenKeyDown(key({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true }));
  assert.deepEqual(summary(result.inputs), [`down:${VK.ctrl}`, 'down:67', 'up:67', `up:${VK.ctrl}`]);
  // Paste is the paste event's.
  assert.deepEqual(screenKeyDown(key({ key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: true })).inputs, []);
});

test('text is chunked to the contract bound without splitting a surrogate pair', () => {
  assert.deepEqual(screenTextInputs('가나'), [{ type: 'screen-text', text: '가나' }]);
  const long = `${'a'.repeat(255)}😀${'b'.repeat(10)}`;
  const pieces = screenTextInputs(long);
  assert.ok(pieces.every((piece) => piece.text.length <= 256));
  assert.equal(pieces.map((piece) => piece.text).join(''), long);
  assert.equal(pieces[0].text, 'a'.repeat(255));
});

function controller() {
  const sent = [];
  const field = { value: '', setSelectionRange() {} };
  const text = createScreenTextController({ emit: (inputs) => sent.push(...inputs) });
  return { sent, field, text };
}

test('focus puts the sentinel in so an empty field still emits Backspace', () => {
  const { sent, field, text } = controller();
  text.focus(field);
  assert.equal(field.value, SCREEN_TEXT_SENTINEL);
  // The keyboard deleted the sentinel: an input event with an empty value.
  field.value = '';
  text.input(field);
  assert.deepEqual(summary(sent), [`down:${VK.backspace}`, `up:${VK.backspace}`]);
  assert.equal(field.value, SCREEN_TEXT_SENTINEL);
  text.blur(field);
  assert.equal(field.value, '');
});

test('typed characters go out as text and the field is reset to the sentinel', () => {
  const { sent, field, text } = controller();
  text.focus(field);
  field.value = `${SCREEN_TEXT_SENTINEL}hi`;
  text.input(field);
  assert.deepEqual(sent, [{ type: 'screen-text', text: 'hi' }]);
  assert.equal(field.value, SCREEN_TEXT_SENTINEL);
});

test('Backspace read from keydown is not sent again by its input event', () => {
  const { sent, field, text } = controller();
  text.focus(field);
  assert.equal(text.keyDown(key({ key: 'Backspace', code: '', keyCode: 229 })), true);
  field.value = '';
  text.input(field);
  text.keyUp();
  assert.equal(sent.length, 2);
  // With no keydown to account for it, the next deletion is a new Backspace.
  field.value = '';
  text.input(field);
  assert.equal(sent.length, 4);
});

test('Enter read from keydown swallows the newline the field would also insert', () => {
  const { sent, field, text } = controller();
  text.focus(field);
  text.keyDown(key({ key: 'Enter', code: '', keyCode: 229 }));
  field.value = `${SCREEN_TEXT_SENTINEL}\n`;
  text.input(field);
  assert.deepEqual(summary(sent), [`down:${VK.enter}`, `up:${VK.enter}`]);
});

test('an IME composition is held back and committed once at its end', () => {
  const { sent, field, text } = controller();
  text.focus(field);
  text.compositionStart();
  field.value = `${SCREEN_TEXT_SENTINEL}ㅎ`;
  text.input(field, true);
  assert.deepEqual(sent, []);
  assert.equal(text.keyDown(key({ key: 'Process', code: 'KeyG', keyCode: 229 })), false);
  text.compositionEnd('한', field);
  assert.deepEqual(sent, [{ type: 'screen-text', text: '한' }]);
  assert.equal(field.value, SCREEN_TEXT_SENTINEL);
  // The IME's own late input of what it committed is an echo, not new text.
  field.value = `${SCREEN_TEXT_SENTINEL}한`;
  text.input(field);
  assert.equal(sent.length, 1);
});

test('the special keys are ordered down/up chords', () => {
  assert.deepEqual(
    SCREEN_SPECIAL_KEYS.map((special) => special.id),
    ['ctrl-alt-del', 'print-screen', 'escape', 'tab', 'win', 'alt-tab']
  );
  assert.deepEqual(summary(screenSpecialKeyInputs('ctrl-alt-del')), [
    `down:${VK.ctrl}`,
    `down:${VK.alt}`,
    `down:${VK.del}`,
    `up:${VK.del}`,
    `up:${VK.alt}`,
    `up:${VK.ctrl}`,
  ]);
  assert.deepEqual(summary(screenSpecialKeyInputs('alt-tab')), [
    `down:${VK.alt}`,
    `down:${VK.tab}`,
    `up:${VK.tab}`,
    `up:${VK.alt}`,
  ]);
  assert.deepEqual(summary(screenSpecialKeyInputs('win')), [`down:${VK.win}`, `up:${VK.win}`]);
  assert.deepEqual(summary(screenSpecialKeyInputs('print-screen')), [`down:${VK.print}`, `up:${VK.print}`]);
  assert.deepEqual(summary(screenSpecialKeyInputs('escape')), [`down:${VK.escape}`, `up:${VK.escape}`]);
  assert.deepEqual(summary(screenSpecialKeyInputs('tab')), [`down:${VK.tab}`, `up:${VK.tab}`]);
  assert.equal(SCREEN_SPECIAL_KEYS.find((special) => special.id === 'ctrl-alt-del').needsHelper, true);
  // Every chord is accepted by the contract's own parser.
  for (const special of SCREEN_SPECIAL_KEYS) {
    for (const input of screenSpecialKeyInputs(special.id)) assert.deepEqual(parseRemoteScreenInput(input), input);
  }
});
