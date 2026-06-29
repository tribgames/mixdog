import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { trimPartialClosingFences } from './stream-fence.mjs';

test('trims a partial closing fence (single backtick) from open code block', () => {
  const tokens = marked.lexer('```js\nconst x = 1;\n`');
  trimPartialClosingFences(tokens);
  const code = tokens.find((t) => t.type === 'code');
  assert.ok(code, 'code token exists');
  assert.ok(!code.text.endsWith('`'), 'partial fence trimmed from text');
  assert.ok(code.text.includes('const x = 1;'), 'real body preserved');
});

test('leaves a complete closing fence intact', () => {
  const tokens = marked.lexer('```js\nconst x = 1;\n```\n');
  const code = tokens.find((t) => t.type === 'code');
  const before = code.text;
  trimPartialClosingFences(tokens);
  assert.equal(code.text, before, 'closed block unchanged');
});

test('no-op on non-code trailing token', () => {
  const tokens = marked.lexer('hello world\n');
  assert.doesNotThrow(() => trimPartialClosingFences(tokens));
});
