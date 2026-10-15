import assert from 'node:assert/strict';
import test from 'node:test';

import { hasControlCharacter } from './ipc-control-chars.ts';
import { projectDisplayName, requiredSubmitOptions, sessionDisplayName } from './ipc-validation.ts';

// The retired inline pattern; the helper must agree with it on every UTF-16 code unit.
// biome-ignore lint/suspicious/noControlCharactersInRegex: reference pattern for the equivalence proof.
const LEGACY = /[\u0000-\u001f\u007f]/;

test('hasControlCharacter matches the legacy regex on every UTF-16 code unit', () => {
  for (let code = 0; code <= 0xffff; code += 1) {
    const char = String.fromCharCode(code);
    assert.equal(hasControlCharacter(char), LEGACY.test(char), `U+${code.toString(16)}`);
    assert.equal(hasControlCharacter(`ab${char}cd`), LEGACY.test(`ab${char}cd`), `U+${code.toString(16)} embedded`);
  }
});

test('hasControlCharacter range edges', () => {
  assert.equal(hasControlCharacter(''), false);
  assert.equal(hasControlCharacter('plain text 😀'), false);
  for (const code of [0x00, 0x1f, 0x7f]) assert.equal(hasControlCharacter(String.fromCharCode(code)), true);
  for (const code of [0x20, 0x7e, 0x80, 0x9f]) assert.equal(hasControlCharacter(String.fromCharCode(code)), false);
});

test('alias, title and submit id reject control characters and accept the rest', () => {
  for (const code of [0x00, 0x1f, 0x7f]) {
    const bad = `a${String.fromCharCode(code)}b`;
    assert.throws(() => projectDisplayName(bad), TypeError);
    assert.throws(() => sessionDisplayName(bad), TypeError);
    assert.throws(() => requiredSubmitOptions({ id: bad }), TypeError);
  }
  assert.equal(projectDisplayName(' ok name '), 'ok name');
  assert.equal(sessionDisplayName(' ok title '), 'ok title');
  assert.deepEqual(requiredSubmitOptions({ id: 'abc' }), { id: 'abc' });
  // Leading/trailing controls are trimmed (\t \n) before the check, as before.
  assert.equal(projectDisplayName('\tname\n'), 'name');
  assert.throws(() => projectDisplayName('x'.repeat(121)), TypeError);
});
