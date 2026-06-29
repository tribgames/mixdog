import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { renderMarkdown } from './markdown.mjs';
import { refreshColorSupport, stripAnsi } from './ansi.mjs';

test.before(() => {
  env.FORCE_COLOR = '1';
  refreshColorSupport();
});

test('renderMarkdown never throws on garbage input', () => {
  assert.doesNotThrow(() => renderMarkdown('**unclosed `fence\n> quote\n'));
  assert.equal(renderMarkdown(null), '');
});

test('diff fenced blocks color hunks and +/- lines', () => {
  const src = [
    '```diff',
    '--- a/file.mjs',
    '+++ b/file.mjs',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    '```',
  ].join('\n');
  const out = renderMarkdown(src);
  assert.match(out, /\x1b\[38;2;204;157;44/);
  assert.match(out, /\x1b\[38;2;0;170;75/);
  assert.match(out, /\x1b\[38;2;220;70;88/);
  assert.ok(stripAnsi(out).includes('diff'));
});

test('inline code and headings use Mixdog accent colors', () => {
  const out = renderMarkdown('# Title\nUse `code` here.');
  assert.match(out, /\x1b\[38;2;215;119;87/);
  assert.match(out, /\x1b\[38;2;138;190;183/);
});

test('longer fence opener does not close on shorter backtick line inside block', () => {
  const src = ['````', '```', 'still inside', '````'].join('\n');
  const plain = stripAnsi(renderMarkdown(src));
  assert.ok(plain.includes('still inside'));
  assert.ok(!plain.includes('```\nstill'));
});

test('mixed backtick-tilde closer does not end backtick fence', () => {
  const src = ['```', '``~', 'still inside', '```'].join('\n');
  const plain = stripAnsi(renderMarkdown(src));
  assert.ok(plain.includes('still inside'));
  assert.ok(plain.includes('``~'));
});

test('fenced code block body rows include right border', () => {
  const out = stripAnsi(renderMarkdown('```js\nx\n```'));
  const rows = out.split('\n').filter((line) => line.startsWith('│ '));
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.match(row, /│\s*$/);
  }
});

test('inline code inside link labels is preserved', () => {
  const out = renderMarkdown('[see `foo`](https://example.com)');
  const plain = stripAnsi(out);
  assert.ok(plain.includes('foo'));
  assert.ok(plain.includes('https://example.com'));
  assert.match(out, /\x1b\[38;2;138;190;183/);
});

