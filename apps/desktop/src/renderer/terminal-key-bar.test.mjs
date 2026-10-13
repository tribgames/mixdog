import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  expose: ['HTMLElement', 'Event', 'MouseEvent'],
});

const { TerminalKeyBar } = await import('./TerminalKeyBar.tsx');
const { StickyModifiers, applyTerminalModifiers, terminalBarSequence } = await import('./terminal-key-bar.ts');

test('bar keys send the terminal escape sequences, honouring application cursor mode', () => {
  assert.equal(terminalBarSequence('esc'), '\x1b');
  assert.equal(terminalBarSequence('tab'), '\t');
  assert.equal(terminalBarSequence('ctrl-c'), '\x03');
  assert.equal(terminalBarSequence('up'), '\x1b[A');
  assert.equal(terminalBarSequence('left'), '\x1b[D');
  assert.equal(terminalBarSequence('down', true), '\x1bOB');
  assert.equal(terminalBarSequence('right', true), '\x1bOC');
});

test('sticky modifiers turn the next key into its Ctrl/Alt form', () => {
  const none = { ctrl: false, alt: false };
  assert.equal(applyTerminalModifiers('c', none), 'c');
  assert.equal(applyTerminalModifiers('c', { ctrl: true, alt: false }), '\x03');
  assert.equal(applyTerminalModifiers('D', { ctrl: true, alt: false }), '\x04');
  assert.equal(applyTerminalModifiers('[', { ctrl: true, alt: false }), '\x1b');
  assert.equal(applyTerminalModifiers(' ', { ctrl: true, alt: false }), '\x00');
  assert.equal(applyTerminalModifiers('f', { ctrl: false, alt: true }), '\x1bf');
  assert.equal(applyTerminalModifiers('c', { ctrl: true, alt: true }), '\x1b\x03');
  assert.equal(applyTerminalModifiers('1', { ctrl: true, alt: false }), '1');
  assert.equal(applyTerminalModifiers('\x1b[A', { ctrl: true, alt: false }), '\x1b[1;5A');
  assert.equal(applyTerminalModifiers('\x1bOD', { ctrl: false, alt: true }), '\x1b[1;3D');
  assert.equal(applyTerminalModifiers('\x1b[C', { ctrl: true, alt: true }), '\x1b[1;7C');
  // Multi-character input (paste, IME commit) is not a key.
  assert.equal(applyTerminalModifiers('hello', { ctrl: true, alt: true }), 'hello');
});

test('sticky Ctrl and Alt are armed by a toggle and consumed once', () => {
  const modifiers = new StickyModifiers();
  let changes = 0;
  modifiers.subscribe(() => {
    changes += 1;
  });
  modifiers.toggle('ctrl');
  assert.deepEqual(modifiers.snapshot(), { ctrl: true, alt: false });
  assert.deepEqual(modifiers.take(), { ctrl: true, alt: false });
  assert.deepEqual(modifiers.take(), { ctrl: false, alt: false });
  assert.equal(changes, 2);
  modifiers.toggle('alt');
  modifiers.toggle('alt');
  assert.deepEqual(modifiers.snapshot(), { ctrl: false, alt: false });
});

test('the key bar keeps terminal focus, arms sticky modifiers and sends sequences', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const modifiers = new StickyModifiers();
  const sent = [];
  // Same shape as TerminalPane's sendToPty: modifiers apply to every input.
  const send = (data) => sent.push(applyTerminalModifiers(data, modifiers.take()));
  const press = (name) => document.querySelector(`[data-key="${name}"]`);
  try {
    await act(async () =>
      root.render(React.createElement(TerminalKeyBar, { modifiers, onKey: (key) => send(terminalBarSequence(key)) }))
    );
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    for (const name of ['esc', 'tab', 'ctrl', 'alt', 'up', 'down', 'left', 'right', 'ctrl-c']) {
      const down = new dom.window.Event('pointerdown', { bubbles: true, cancelable: true });
      press(name).dispatchEvent(down);
      assert.equal(down.defaultPrevented, true, `${name} pointerdown must not move focus`);
    }
    assert.equal(document.activeElement, textarea);

    await act(async () => press('esc').click());
    await act(async () => press('tab').click());
    await act(async () => press('ctrl-c').click());
    await act(async () => press('up').click());
    assert.deepEqual(sent, ['\x1b', '\t', '\x03', '\x1b[A']);

    await act(async () => press('ctrl').click());
    assert.equal(press('ctrl').getAttribute('aria-pressed'), 'true');
    assert.equal(press('alt').getAttribute('aria-pressed'), 'false');
    // The next typed key (via the same path) consumes the armed Ctrl.
    await act(async () => send('l'));
    assert.equal(sent.at(-1), '\x0c');
    assert.equal(press('ctrl').getAttribute('aria-pressed'), 'false');

    await act(async () => press('alt').click());
    await act(async () => press('ctrl').click());
    await act(async () => press('left').click());
    assert.equal(sent.at(-1), '\x1b[1;7D');
    await act(async () => send('x'));
    assert.equal(sent.at(-1), 'x');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
