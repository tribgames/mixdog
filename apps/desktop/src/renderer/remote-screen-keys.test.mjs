import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRemoteScreenInput } from '../shared/remote-webrtc.ts';
import { SEND_BAR_SENTINEL } from './remote-send-bar.ts';
import {
  SCREEN_SPECIAL_KEYS,
  createScreenTextController,
  screenSpecialKeyInputs,
  screenTextInputs,
} from './remote-screen-keys.ts';
import { screenInputAllowed } from './remote-screen-state.ts';

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
const summary = (inputs) => inputs.map((input) => `${input.action}:${input.vk}`);

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

/** The bar as the phone wires it: a field whose blur / focus run the bar's
 *  own handlers, and a Korean IME that commits its syllable into the field
 *  when focus leaves it. */
function bar() {
  const { sent, field, text } = controller();
  let focused = false;
  let imeSyllable = '';
  const element = Object.assign(field, {
    blur() {
      if (!focused) return;
      focused = false;
      if (text.composing) {
        // The IME commits the syllable into the field, then ends.
        element.value += imeSyllable;
        imeSyllable = '';
        text.compositionEnd(element);
      }
      text.blur(element);
    },
    focus() {
      if (focused) return;
      focused = true;
      text.focus(element);
    },
  });
  const type = (characters) => {
    element.value += characters;
    text.input(element, false);
  };
  const compose = (syllable) => {
    if (!text.composing) text.compositionStart();
    imeSyllable = syllable;
    text.input(element, true);
  };
  const endComposition = (syllable) => {
    element.value += syllable;
    imeSyllable = '';
    text.compositionEnd(element);
  };
  return { sent, element, text, type, compose, endComposition, isFocused: () => focused };
}

const bodyOf = (value) => value.split(SEND_BAR_SENTINEL).join('');

test('typing, a composing Korean syllable and a paste send nothing until send', () => {
  const b = bar();
  b.element.focus();
  b.type('hi ');
  b.compose('ㅎ');
  b.compose('하');
  b.endComposition('한');
  b.compose('ㄱ');
  assert.deepEqual(b.sent, []);
  assert.equal(bodyOf(b.element.value), 'hi 한');
});

test('send delivers the exact full text once, clears the bar, keeps focus and presses no Enter', () => {
  const b = bar();
  b.element.focus();
  b.type('hi ');
  b.compose('하');
  b.endComposition('한');
  b.type('글');
  b.text.send(b.element);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'hi 한글' }]);
  assert.equal(bodyOf(b.element.value), '');
  assert.equal(b.isFocused(), true);
  assert.ok(parseRemoteScreenInput(b.sent[0]));
});

test('send mid-composition commits the running syllable into the text first', () => {
  const b = bar();
  b.element.focus();
  b.type('a');
  b.compose('한');
  // A running composition is already in the field's value.
  b.element.value += '한';
  b.text.send(b.element);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'a한' }]);
  assert.equal(bodyOf(b.element.value), '');
  assert.equal(b.isFocused(), true, 'focus is kept');
  assert.equal(b.text.composing, false);
  // The IME's late end of the same composition adds nothing.
  b.text.compositionEnd(b.element);
  assert.equal(b.sent.length, 1);
});

test('the soft keyboard’s Enter in the bar sends the text; the newline it also inserts is dropped', () => {
  const b = bar();
  b.element.focus();
  b.type('ls');
  assert.equal(b.text.keyDown({ key: 'Enter' }, b.element), true);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'ls' }]);
  b.element.value += '\n';
  b.text.input(b.element, false);
  assert.equal(bodyOf(b.element.value), '');
  assert.equal(b.sent.length, 1);
});

test('an empty bar: send and Enter are one Enter key each, Backspace one Backspace key', () => {
  const b = bar();
  b.element.focus();
  b.text.send(b.element);
  assert.deepEqual(summary(b.sent), [`down:${VK.enter}`, `up:${VK.enter}`]);
  b.sent.length = 0;
  assert.equal(b.text.keyDown({ key: 'Enter' }, b.element), true);
  assert.deepEqual(summary(b.sent), [`down:${VK.enter}`, `up:${VK.enter}`]);
  b.text.keyUp();
  b.sent.length = 0;
  // A soft keyboard deletes the sentinel: an input event with an empty value.
  b.element.value = '';
  b.text.input(b.element, false);
  assert.deepEqual(summary(b.sent), [`down:${VK.backspace}`, `up:${VK.backspace}`]);
  assert.equal(b.element.value, SEND_BAR_SENTINEL);
  b.sent.length = 0;
  // A hardware Backspace is read from keydown, and its input event adds none.
  assert.equal(b.text.keyDown({ key: 'Backspace' }, b.element), true);
  b.element.value = '';
  b.text.input(b.element, false);
  assert.deepEqual(summary(b.sent), [`down:${VK.backspace}`, `up:${VK.backspace}`]);
});

test('Backspace with text in the bar edits the bar and sends nothing', () => {
  const b = bar();
  b.element.focus();
  b.type('ab');
  assert.equal(b.text.keyDown({ key: 'Backspace' }, b.element), false);
  b.element.value = `${SEND_BAR_SENTINEL}a`;
  b.text.input(b.element, false);
  b.element.value = SEND_BAR_SENTINEL;
  b.text.input(b.element, false);
  // Select-all and delete takes the sentinel too: emptying text is not a Backspace.
  b.type('x');
  b.element.value = '';
  b.text.input(b.element, false);
  assert.deepEqual(b.sent, []);
  assert.equal(b.element.value, SEND_BAR_SENTINEL);
});

const IME = { key: 'Process', keyCode: 229 };

test('Gboard: keydown 229, compositionend, then beforeinput insertLineBreak sends the full text once, no Enter', () => {
  const b = bar();
  b.element.focus();
  b.type('hi ');
  b.compose('한');
  assert.equal(b.text.keyDown(IME, b.element), false);
  b.endComposition('한');
  assert.equal(b.text.beforeInput({ inputType: 'insertLineBreak' }, b.element), true);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'hi 한' }]);
  assert.equal(bodyOf(b.element.value), '');
  // The newline lands anyway (the event was not cancelable) and is dropped.
  b.element.value += '\n';
  b.text.input(b.element, false);
  b.text.keyUp();
  assert.equal(b.sent.length, 1);
  assert.equal(bodyOf(b.element.value), '');
});

test('Samsung: keydown 229, compositionend, then an input with a trailing newline sends once', () => {
  const b = bar();
  b.element.focus();
  b.compose('한');
  b.text.keyDown(IME, b.element);
  b.element.value += '한\n';
  b.text.compositionEnd(b.element);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: '한' }]);
  assert.equal(b.sent.length, 1);
  // Same keyboard without a composition: the newline arrives as input.
  b.sent.length = 0;
  b.type('ls\n');
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'ls' }]);
});

test('a line break arriving as beforeinput after a named Enter does not send twice', () => {
  const b = bar();
  b.element.focus();
  b.type('ls');
  assert.equal(b.text.keyDown({ key: 'Enter' }, b.element), true);
  assert.equal(b.text.beforeInput({ inputType: 'insertLineBreak' }, b.element), true);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'ls' }]);
});

test('a line break with an empty bar is one Enter key; a line break mid-composition ends it without a blur', () => {
  const b = bar();
  b.element.focus();
  assert.equal(b.text.beforeInput({ inputType: 'insertParagraph' }, b.element), true);
  assert.deepEqual(summary(b.sent), [`down:${VK.enter}`, `up:${VK.enter}`]);
  b.sent.length = 0;
  b.compose('한');
  b.element.value += '한';
  assert.equal(b.text.beforeInput({ inputType: 'insertLineBreak' }, b.element), true);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: '한' }]);
  assert.equal(b.isFocused(), true);
  b.text.compositionEnd(b.element);
  assert.equal(b.sent.length, 1, 'the IME’s late end adds nothing');
  assert.equal(bodyOf(b.element.value), '');
});

/** The three signals of one Android Enter, each as the bar receives it. */
const SIGNALS = {
  enter: (b) => b.text.keyDown({ key: 'Enter' }, b.element),
  break: (b) => b.text.beforeInput({ inputType: 'insertLineBreak' }, b.element),
  newline: (b) => {
    b.element.value += '\n';
    b.text.input(b.element, false);
  },
};
const ORDERINGS = [
  ['enter', 'break', 'newline'],
  ['enter', 'newline', 'break'],
  ['break', 'enter', 'newline'],
  ['break', 'newline', 'enter'],
  ['newline', 'enter', 'break'],
  ['newline', 'break', 'enter'],
];

for (const order of ORDERINGS) {
  test(`one Enter signalled as ${order.join(' → ')} sends the text once and no Enter key`, () => {
    const b = bar();
    b.element.focus();
    b.type('abc');
    for (const signal of order) SIGNALS[signal](b);
    assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'abc' }]);
    assert.equal(bodyOf(b.element.value), '');
  });

  test(`on an empty bar ${order.join(' → ')} is one Enter key`, () => {
    const b = bar();
    b.element.focus();
    for (const signal of order) SIGNALS[signal](b);
    assert.deepEqual(summary(b.sent), [`down:${VK.enter}`, `up:${VK.enter}`]);
  });
}

test('a cancelled beforeinput submission, then typing, then a Process/229 submission sends the second text', () => {
  const b = bar();
  b.element.focus();
  b.type('first');
  SIGNALS.break(b);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'first' }]);
  // The newline never came (cancelled). The user keeps typing.
  b.type('second');
  b.text.keyDown(IME, b.element);
  SIGNALS.break(b);
  assert.deepEqual(b.sent, [
    { type: 'screen-text', text: 'first' },
    { type: 'screen-text', text: 'second' },
  ]);
});

test('a blur between an Enter and its companion signals does not forget the submission', () => {
  const b = bar();
  b.element.focus();
  b.type('first');
  SIGNALS.enter(b);
  b.element.blur();
  b.element.focus();
  SIGNALS.break(b);
  SIGNALS.newline(b);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'first' }]);
});

test('a genuinely new Enter after blur and refocus still submits', async () => {
  const b = bar();
  b.element.focus();
  b.type('first');
  SIGNALS.enter(b);
  b.element.blur();
  b.element.focus();
  // Typing is a real edit: the next Enter is new, even in the same tick.
  b.type('second');
  SIGNALS.enter(b);
  assert.deepEqual(b.sent, [
    { type: 'screen-text', text: 'first' },
    { type: 'screen-text', text: 'second' },
  ]);
  // On an empty bar, once the event loop has turned.
  b.sent.length = 0;
  b.element.blur();
  b.element.focus();
  await new Promise((resolve) => setTimeout(resolve, 5));
  SIGNALS.enter(b);
  assert.deepEqual(summary(b.sent), [`down:${VK.enter}`, `up:${VK.enter}`]);
});

test('a later Enter after the event loop turns is a new submission, not a stale duplicate', async () => {
  const b = bar();
  b.element.focus();
  SIGNALS.break(b);
  await new Promise((resolve) => setTimeout(resolve, 5));
  SIGNALS.enter(b);
  assert.equal(b.sent.length, 4, 'two Enter keys, down and up each');
  // Two named Enters in a row are two submissions, too.
  b.sent.length = 0;
  SIGNALS.enter(b);
  SIGNALS.enter(b);
  assert.equal(b.sent.length, 4);
});

test('a multi-line paste stays text in the bar', () => {
  const b = bar();
  b.element.focus();
  b.text.paste();
  b.type('a\nb\n');
  assert.deepEqual(b.sent, []);
  assert.equal(bodyOf(b.element.value), 'a\nb\n');
  b.element.value = SEND_BAR_SENTINEL;
  b.text.beforeInput({ inputType: 'insertFromPaste' }, b.element);
  b.type('c\nd\n');
  assert.deepEqual(b.sent, []);
  b.text.send(b.element);
  assert.deepEqual(b.sent, [{ type: 'screen-text', text: 'c\nd\n' }]);
});

const press = (b, key, extra = {}) => b.text.keyDown({ key, code: key, keyCode: 0, ...extra }, b.element);

test('special keys and chords go to the PC at once while the bar is empty', () => {
  const b = bar();
  b.element.focus();
  const cases = [
    ['Escape', {}, [VK.escape]],
    ['Tab', {}, [VK.tab]],
    ['ArrowLeft', {}, [0x25]],
    ['Home', {}, [0x24]],
    ['PageDown', {}, [0x22]],
    ['Delete', {}, [VK.del]],
    ['F5', {}, [0x74]],
    ['c', { code: 'KeyC', ctrlKey: true }, [VK.ctrl, 0x43]],
    ['Tab', { altKey: true }, [VK.alt, VK.tab]],
    ['r', { code: 'KeyR', metaKey: true }, [VK.win, 0x52]],
  ];
  for (const [key, extra, vks] of cases) {
    b.sent.length = 0;
    assert.equal(press(b, key, extra), true, key);
    assert.deepEqual(
      b.sent.filter((input) => input.action === 'down').map((input) => input.vk),
      vks,
      key
    );
    assert.equal(b.sent.filter((input) => input.action === 'up').length, vks.length);
  }
});

test('with text in the bar: arrows, Delete and Backspace edit it; Esc, Tab, F-keys and chords still go to the PC', () => {
  const b = bar();
  b.element.focus();
  b.type('abc');
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Backspace', 'PageUp']) {
    assert.equal(press(b, key), false, key);
  }
  assert.deepEqual(b.sent, []);
  // Editing and paste chords stay local while there is text.
  for (const key of ['a', 'x', 'z', 'y', 'v']) assert.equal(press(b, key, { ctrlKey: true }), false, key);
  assert.equal(press(b, 'v', { metaKey: true }), false);
  assert.deepEqual(b.sent, []);
  for (const [key, extra] of [
    ['Escape', {}],
    ['Tab', {}],
    ['F2', {}],
    ['c', { ctrlKey: true }],
    ['a', { altKey: true }],
  ]) {
    b.sent.length = 0;
    assert.equal(press(b, key, extra), true, key);
    assert.ok(b.sent.length > 0, key);
  }
  assert.equal(bodyOf(b.element.value), 'abc', 'the buffered text is untouched');
});

test('Ctrl/Cmd+V pastes into the bar even when it is empty; other keys and chords with no code send nothing', () => {
  const b = bar();
  b.element.focus();
  assert.equal(press(b, 'v', { ctrlKey: true }), false);
  assert.equal(press(b, 'v', { metaKey: true }), false);
  assert.deepEqual(b.sent, []);
  // Shift alone and plain letters are typing.
  assert.equal(press(b, 'Shift'), false);
  assert.equal(press(b, 'a'), false);
  assert.equal(press(b, 'A', { shiftKey: true }), false);
  assert.deepEqual(b.sent, []);
  // A chord on a key with no fixed code is claimed (no local effect) but sends nothing.
  assert.equal(press(b, '한', { code: '', ctrlKey: true }), true);
  assert.deepEqual(b.sent, []);
});

test('typed text survives blur and focus; an empty bar shows its placeholder when blurred', () => {
  const b = bar();
  b.element.focus();
  b.element.blur();
  assert.equal(b.element.value, '');
  b.element.focus();
  b.type('abc');
  b.element.blur();
  b.element.focus();
  assert.equal(bodyOf(b.element.value), 'abc');
  assert.deepEqual(b.sent, []);
});

test('disabled (control not granted): neither text nor keys pass the gate', () => {
  const b = bar();
  b.element.focus();
  const viewOnly = { kind: 'live', control: false };
  b.type('hi');
  b.text.send(b.element);
  b.text.send(b.element);
  assert.equal(b.sent.length, 3, 'text, then the empty bar’s Enter down and up');
  // Only a release (a key-up) may pass without control; nothing is typed or pressed.
  const passed = b.sent.filter((input) => screenInputAllowed(input, viewOnly));
  assert.deepEqual(
    passed.map((input) => [input.type, input.action]),
    [['screen-key', 'up']]
  );
  assert.deepEqual(
    b.sent.filter((input) => screenInputAllowed(input, { kind: 'live', control: true })),
    b.sent
  );
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
