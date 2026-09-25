import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { keyboardHtml, keyboardScript } from './keyboard-art.ts';

const board = () => {
  const dom = new JSDOM(keyboardHtml(), { runScripts: 'outside-only' });
  dom.window.eval(keyboardScript());
  const surface = dom.window.document.getElementById('board');
  const lit = () => [...dom.window.document.querySelectorAll('.key.down')].map((key) => key.textContent).sort();
  return { dom, surface, lit };
};

test('the board lights the keys it is given and lifts them again', () => {
  const { dom, surface, lit } = board();
  try {
    dom.window.mixdogAgentKeyboard({ keys: ['ctrl', 'c'], masked: false });
    assert.deepEqual(lit(), ['C', 'Ctrl', 'Ctrl']);
    dom.window.mixdogAgentKeyboard({ keys: ['9'], masked: false });
    assert.deepEqual(lit(), ['9'], 'a new keystroke replaces the previous one');
    assert.ok(surface.className.includes('visible'));
  } finally {
    dom.window.close();
  }
});

test('names the host uses that differ from the printed caps still land', () => {
  const { dom, lit } = board();
  try {
    for (const [sent, cap] of [
      ['Enter', '⏎'],
      ['return', '⏎'],
      ['escape', 'Esc'],
      ['backspace', '⌫'],
      ['tab', '⇥'],
    ]) {
      dom.window.mixdogAgentKeyboard({ keys: [sent], masked: false });
      assert.deepEqual(lit(), [cap], `${sent} must reach its own key`);
    }
  } finally {
    dom.window.close();
  }
});

test('a plus lights the key a finger presses for it, shift included', () => {
  const { dom, lit } = board();
  try {
    for (const sent of ['+', 'plus', 'add']) {
      dom.window.mixdogAgentKeyboard({ keys: [sent], masked: false });
      assert.deepEqual(lit(), ['=', '⇧', '⇧'], `${sent} must reach the '=' key under a shift`);
    }
  } finally {
    dom.window.close();
  }
});

test('a masked field lights nothing, whatever keys arrive', () => {
  const { dom, surface, lit } = board();
  try {
    dom.window.mixdogAgentKeyboard({ keys: ['s', 'e', 'c', 'r', 'e', 't'], masked: true });
    assert.deepEqual(lit(), [], 'a secret must never appear on the board');
    assert.ok(surface.className.includes('masked'), 'the board still shows that typing is happening');
    assert.ok(surface.className.includes('visible'));
    // Leaving the masked field must not reveal what was typed while inside it.
    dom.window.mixdogAgentKeyboard({ keys: ['a'], masked: false });
    assert.deepEqual(lit(), ['A']);
    assert.equal(surface.className.includes('masked'), false);
  } finally {
    dom.window.close();
  }
});

test('the board never writes text of its own', () => {
  const { dom } = board();
  try {
    dom.window.mixdogAgentKeyboard({ keys: ['p'], masked: false, text: 'private input' });
    assert.equal(dom.window.document.body.textContent.includes('private input'), false);
  } finally {
    dom.window.close();
  }
});
