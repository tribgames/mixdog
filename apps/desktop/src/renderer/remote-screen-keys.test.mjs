import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRemoteScreenInput } from '../shared/remote-webrtc.ts';
import { createCompositionFinisher } from './remote-composition.ts';
import {
  SCREEN_SPECIAL_KEYS,
  SCREEN_TEXT_SENTINEL,
  createScreenTextController,
  screenKeyCode,
  screenKeyDown,
  screenSpecialKeyInputs,
  screenTextInputs,
} from './remote-screen-keys.ts';

const VK = {
  backspace: 0x08,
  enter: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  del: 0x2e,
  ctrl: 0xa2,
  alt: 0xa4,
  win: 0x5b,
  print: 0x2c,
};
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

// The screen bar's send button: onSend = composition.finish() then text.submit().
function sendBar() {
  const { sent, field, text } = controller();
  globalThis.document ??= { activeElement: null };
  let focused = true;
  const element = Object.assign(field, {
    blur() {
      focused = false;
      text.blur(field);
    },
    focus() {
      focused = true;
      text.focus(field);
    },
  });
  const finisher = createCompositionFinisher(() => element);
  const raw = {
    onKeyDown() {},
    onInput: (event) => text.input(event.currentTarget, event.nativeEvent?.isComposing),
    onCompositionStart: () => text.compositionStart(),
    onCompositionUpdate() {},
    onCompositionEnd: (event) => text.compositionEnd(event.data, event.currentTarget),
  };
  const handlers = finisher.wrap(raw);
  return {
    sent,
    element,
    handlers,
    isFocused: () => focused,
    send() {
      finisher.finish(raw);
      text.submit();
    },
  };
}

test('send mid-composition commits the composed text once, then one Enter, and a late end adds nothing', () => {
  const bar = sendBar();
  const event = (extra) => ({ currentTarget: bar.element, data: '', nativeEvent: {}, ...extra });
  bar.element.focus();
  bar.handlers.onCompositionStart(event());
  bar.handlers.onCompositionUpdate(event({ data: '한' }));
  bar.send();
  assert.deepEqual(bar.sent, [{ type: 'screen-text', text: '한' }, ...bar.sent.slice(1)]);
  assert.deepEqual(summary(bar.sent.slice(1)), [`down:${VK.enter}`, `up:${VK.enter}`]);
  // The IME's late end and its echo input are swallowed.
  bar.handlers.onCompositionEnd(event({ data: '한' }));
  bar.element.value = `${SCREEN_TEXT_SENTINEL}한`;
  bar.handlers.onInput(event());
  assert.equal(bar.sent.length, 3);
  assert.equal(bar.isFocused(), true, 'focus is kept');
});

test('send with no composition is exactly one Enter', () => {
  const bar = sendBar();
  bar.element.focus();
  bar.send();
  assert.deepEqual(summary(bar.sent), [`down:${VK.enter}`, `up:${VK.enter}`]);
});

test('each special key is one atomic screen-keys combo, in press order', () => {
  assert.deepEqual(
    SCREEN_SPECIAL_KEYS.map((special) => special.id),
    ['ctrl-alt-del', 'print-screen', 'escape', 'tab', 'win', 'alt-tab']
  );
  const vks = (id) => {
    const inputs = screenSpecialKeyInputs(id);
    assert.equal(inputs.length, 1, `${id} is one message`);
    assert.equal(inputs[0].type, 'screen-keys');
    return inputs[0].keys.map((key) => key.vk);
  };
  assert.deepEqual(vks('ctrl-alt-del'), [VK.ctrl, VK.alt, VK.del]);
  assert.deepEqual(vks('alt-tab'), [VK.alt, VK.tab]);
  assert.deepEqual(vks('win'), [VK.win]);
  assert.deepEqual(vks('print-screen'), [VK.print]);
  assert.deepEqual(vks('escape'), [VK.escape]);
  assert.deepEqual(vks('tab'), [VK.tab]);
  // Keys carry vk, scan and extended (Delete is an E0 key).
  assert.deepEqual(screenSpecialKeyInputs('ctrl-alt-del')[0].keys[2], { vk: VK.del, scan: 0x53, extended: true });
  assert.equal(SCREEN_SPECIAL_KEYS.find((special) => special.id === 'ctrl-alt-del').needsHelper, true);
  // Every chord is accepted by the contract's own parser.
  for (const special of SCREEN_SPECIAL_KEYS) {
    for (const input of screenSpecialKeyInputs(special.id)) assert.deepEqual(parseRemoteScreenInput(input), input);
  }
});
