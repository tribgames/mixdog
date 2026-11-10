import assert from 'node:assert/strict';
import test from 'node:test';
import { macosChooseScript } from './folder-dialog.mjs';

test('macOS picker prompt escapes backslashes before quotes', () => {
  assert.equal(macosChooseScript('a\\"b'), 'set f to choose folder with prompt "a\\\\\\"b"\nPOSIX path of f');
});
