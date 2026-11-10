import assert from 'node:assert/strict';
import test from 'node:test';
import { capShellOutput, smartMiddleTruncate, SMART_BASH_MAX_BYTES } from './shell-output.mjs';

// One CJK character is 3 UTF-8 bytes: this string is under the byte budget in
// characters but over it in bytes.
const cjkLine = '가'.repeat(Math.floor(SMART_BASH_MAX_BYTES / 2));

test('smartMiddleTruncate measures the byte budget, not the string length', () => {
  assert.ok(cjkLine.length < SMART_BASH_MAX_BYTES);
  assert.ok(Buffer.byteLength(cjkLine, 'utf8') > SMART_BASH_MAX_BYTES);
  const out = smartMiddleTruncate(cjkLine);
  assert.match(out, /output exceeded/);
  const head = out.slice(0, out.indexOf('\n\n... [output exceeded'));
  assert.ok(Buffer.byteLength(head, 'utf8') <= SMART_BASH_MAX_BYTES);
  assert.ok(!head.includes('\uFFFD'));
});

test('capShellOutput truncates multi-byte output that exceeds the byte budget', () => {
  assert.notEqual(capShellOutput(cjkLine), cjkLine);
  assert.equal(capShellOutput('short output'), 'short output');
});
