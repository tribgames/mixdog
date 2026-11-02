import assert from 'node:assert/strict';
import test from 'node:test';
import { createKeyboardInput } from './input-keyboard.ts';

async function events(rawKey) {
  const sent = [];
  const { pressKey } = createKeyboardInput(async (_guest, _method, params) => {
    sent.push(params);
    return 'completed';
  }, {});
  await pressKey({}, rawKey);
  return sent;
}

test('shifted digits and punctuation type their US-layout character on the base key', async () => {
  for (const [chord, text, code, keyCode] of [
    ['shift+1', '!', 'Digit1', 49],
    ['shift+/', '?', 'Slash', 191],
    ['shift+-', '_', 'Minus', 189],
    ['shift+;', ':', 'Semicolon', 186],
  ]) {
    const [down, char] = await events(chord);
    assert.equal(down.key, text, chord);
    assert.equal(down.code, code, chord);
    assert.equal(down.windowsVirtualKeyCode, keyCode, chord);
    assert.equal(down.modifiers, 8, chord);
    assert.equal(char.text, text, chord);
  }
});

test('shift keeps upper-casing letters and an already shifted character', async () => {
  assert.equal((await events('shift+a'))[1].text, 'A');
  const [down, char] = await events('shift+!');
  assert.equal(down.key, '!');
  assert.equal(char.text, '!');
});
