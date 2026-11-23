import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';

const { window } = installTestDom(null, {
  html: '<!doctype html><html><body><div id="host"></div></body></html>',
  expose: ['HTMLElement', 'Event', 'KeyboardEvent', 'MouseEvent'],
});
// xterm paints through the window's frames and watches the device pixel ratio
// through matchMedia; jsdom's window has neither.
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
window.HTMLCanvasElement.prototype.getContext = () => null;

const { Terminal } = await import('@xterm/xterm');
const { attachTerminalClipboardKeys, terminalClipboardChord } = await import('./terminal-clipboard-keys.ts');

const KEY_CODES = { a: 65, c: 67, v: 86 };

function key(type, letter, modifiers = {}) {
  const event = new window.KeyboardEvent(type, {
    key: letter,
    bubbles: true,
    cancelable: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers,
  });
  Object.defineProperty(event, 'keyCode', { value: KEY_CODES[letter.toLowerCase()] });
  return event;
}

function pasteEvent(text) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type) => (type === 'text/plain' ? text : '') } });
  return event;
}

async function openTerminal(isMac = false) {
  const term = new Terminal();
  term.open(window.document.getElementById('host'));
  const sent = [];
  const copied = [];
  term.onData((data) => sent.push(data));
  attachTerminalClipboardKeys(term, isMac, async (text) => {
    copied.push(text);
  });
  const press = (letter, modifiers) => {
    const down = key('keydown', letter, modifiers);
    term.textarea.dispatchEvent(down);
    term.textarea.dispatchEvent(key('keyup', letter, modifiers));
    return down;
  };
  const write = (data) => new Promise((resolve) => term.write(data, resolve));
  return { term, sent, copied, press, write };
}

test('clipboard chords: Ctrl(+Shift)+C/V off macOS, Cmd+C/V on it; Ctrl+C without a selection stays an interrupt', () => {
  const chord = (letter, modifiers, isMac = false, hasSelection = false) =>
    terminalClipboardChord(
      { keyCode: KEY_CODES[letter], ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers },
      isMac,
      hasSelection
    );
  assert.equal(chord('v', { ctrlKey: true }), 'paste');
  assert.equal(chord('v', { ctrlKey: true, shiftKey: true }), 'paste');
  assert.equal(chord('c', { ctrlKey: true, shiftKey: true }), 'copy');
  assert.equal(chord('c', { ctrlKey: true }, false, true), 'copy');
  assert.equal(chord('c', { ctrlKey: true }), null);
  assert.equal(chord('v', { ctrlKey: true, altKey: true }), null);
  assert.equal(chord('a', { ctrlKey: true }), null);
  assert.equal(chord('v', { metaKey: true }, true), 'paste');
  assert.equal(chord('c', { metaKey: true }, true), 'copy');
  assert.equal(chord('c', { ctrlKey: true }, true, true), null, 'Ctrl+C on macOS is always the interrupt');
  assert.equal(chord('v', { ctrlKey: true }, true), null);
});

test('Ctrl+V reaches the browser paste instead of sending ^V, and the paste goes through xterm (bracketed)', async () => {
  const { sent, press, write, term } = await openTerminal();
  for (const modifiers of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }]) {
    const down = press('v', modifiers);
    assert.equal(down.defaultPrevented, false, 'the native paste command must run');
  }
  assert.deepEqual(sent, [], 'no ^V reaches the program');

  term.textarea.dispatchEvent(pasteEvent('one\ntwo'));
  await write('\x1b[?2004h');
  term.textarea.dispatchEvent(pasteEvent('three'));
  assert.deepEqual(sent, ['one\rtwo', '\x1b[200~three\x1b[201~']);
  term.dispose();
});

test('Ctrl+C copies a selection and is otherwise the interrupt; Ctrl+Shift+C copies; other keys reach the program', async () => {
  const { sent, copied, press, write, term } = await openTerminal();
  press('c', { ctrlKey: true });
  press('a', { ctrlKey: true });
  assert.deepEqual(sent, ['\x03', '\x01']);

  await write('hello world');
  term.select(0, 0, 5);
  const copy = press('c', { ctrlKey: true });
  assert.equal(copy.defaultPrevented, true);
  term.select(6, 0, 5);
  press('c', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(copied, ['hello', 'world']);
  assert.deepEqual(sent, ['\x03', '\x01'], 'a copy sends nothing to the program');
  term.dispose();
});

test('a Ctrl+C copy clears the selection, so the next Ctrl+C interrupts the program', async () => {
  const { sent, copied, press, write, term } = await openTerminal();
  await write('building...');
  term.select(0, 0, 8);
  press('c', { ctrlKey: true });
  assert.deepEqual(copied, ['building']);
  assert.deepEqual(sent, []);
  assert.equal(term.hasSelection(), false);
  press('c', { ctrlKey: true });
  assert.deepEqual(copied, ['building']);
  assert.deepEqual(sent, ['\x03']);
  term.dispose();
});

test('macOS: Cmd+C copies the selection and Cmd+V is left to the native paste', async () => {
  const { sent, copied, press, write, term } = await openTerminal(true);
  await write('hello');
  term.select(0, 0, 5);
  press('c', { metaKey: true });
  const paste = press('v', { metaKey: true });
  assert.equal(paste.defaultPrevented, false);
  assert.deepEqual(copied, ['hello']);
  assert.deepEqual(sent, []);
  term.dispose();
});
