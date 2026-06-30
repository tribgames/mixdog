import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import { renderTokenAnsiSegments, lexMarkdown, hasMarkdownSyntax } from './render-ansi.mjs';
import { setThemeSetting } from '../theme.mjs';

setThemeSetting('mixdog', { persist: false });

// Mirrors the streaming suffix the <Markdown trimPartialFences> path renders.
const STREAMING = '```js\nconst x = 1;\n`';

function codeBlockVisibleLines(segments) {
  const codeSeg = segments.find((s) => s.type === 'ansi' && s.token?.type === 'code');
  assert.ok(codeSeg, 'a fenced code segment is rendered');
  return stripAnsi(codeSeg.ansi).split('\n');
}

test('streaming render path drops the partial trailing backtick body line', () => {
  const segments = renderTokenAnsiSegments(STREAMING, { trimPartialFences: true });
  const lines = codeBlockVisibleLines(segments);
  const bodyLines = lines.filter((l) => !/^js$/.test(l.trim()));
  for (const l of bodyLines) {
    assert.notEqual(l.trim(), '`', 'no body line is a lone partial fence');
  }
  // The real code body is still present.
  assert.ok(lines.some((l) => l.includes('const x = 1;')), 'code body preserved');
});

test('without trimPartialFences the partial backtick survives as a body line', () => {
  // Proves the trim flag is what removes it on the render path (not formatToken).
  const segments = renderTokenAnsiSegments(STREAMING, { trimPartialFences: false });
  const lines = codeBlockVisibleLines(segments);
  const bodyLines = lines.filter((l) => !/^js$/.test(l.trim()));
  assert.ok(
    bodyLines.some((l) => l.trim() === '`'),
    'untrimmed path keeps the partial fence as a body line',
  );
});

test('trimPartialFences tokens are not cached (stable text unaffected)', () => {
  const stable = '```js\nconst y = 2;\n```\n';
  const a = lexMarkdown(stable, { trimPartialFences: false });
  const b = lexMarkdown(stable, { trimPartialFences: false });
  assert.strictEqual(a, b, 'stable content returns the cached token array');
  // Streaming lex must be a fresh (non-cached) array.
  const c = lexMarkdown(STREAMING, { trimPartialFences: true });
  const d = lexMarkdown(STREAMING, { trimPartialFences: true });
  assert.notStrictEqual(c, d, 'streaming lex is never cached');
});

test('closed code block renders lang label and body without fence markers', () => {
  const segments = renderTokenAnsiSegments('```js\nconst z = 3;\n```\n', { trimPartialFences: true });
  const lines = codeBlockVisibleLines(segments);
  assert.ok(lines.some((l) => l.includes('const z = 3;')), 'body present');
  assert.ok(lines.some((l) => l.trim() === 'js'), 'language label present');
  assert.ok(!lines.some((l) => l.includes('```')), 'no literal fence markers');
});

const PLAIN_PREFIX = 'x'.repeat(501);

test('hasMarkdownSyntax detects strong markers after a 500+ char plain prefix', () => {
  assert.ok(hasMarkdownSyntax(`${PLAIN_PREFIX}**late bold**`));
});
test('hasMarkdownSyntax detects inline code after a 500+ char plain prefix', () => {
  assert.ok(hasMarkdownSyntax(`${PLAIN_PREFIX}\`late code\``));
});

test('render path parses fenced code after a 500+ char plain prefix', () => {
  const input = `${PLAIN_PREFIX}\n\`\`\`js\nconst late = true;\n\`\`\``;
  const tokens = lexMarkdown(input);
  assert.ok(
    tokens.some((t) => t.type === 'code' && String(t.text).includes('const late = true;')),
    'lexer emits a code token with the fenced body',
  );
  const segments = renderTokenAnsiSegments(input);
  const lines = codeBlockVisibleLines(segments);
  assert.ok(lines.some((l) => l.includes('const late = true;')), 'code block body is rendered');
  const visible = segments.map((s) => stripAnsi(s.ansi ?? '')).join('\n');
  assert.ok(!visible.includes(`${PLAIN_PREFIX}\`\`\`js`), 'prefix is not glued to raw fence markers');
});

test('render path parses strong after a 500+ char plain prefix (no raw **)', () => {
  const segments = renderTokenAnsiSegments(`${PLAIN_PREFIX}**rendered**`);
  const visible = segments.map((s) => stripAnsi(s.ansi ?? '')).join('');
  assert.ok(visible.includes('rendered'), 'bold text is present');
  assert.ok(!visible.includes('**'), 'markdown strong markers are not leaked');
});

test('render path parses inline code after a 500+ char plain prefix (no raw backticks)', () => {
  const segments = renderTokenAnsiSegments(`${PLAIN_PREFIX}\`snippet\``);
  const visible = segments.map((s) => stripAnsi(s.ansi ?? '')).join('');
  assert.ok(visible.includes('snippet'), 'codespan text is present');
  assert.ok(!visible.includes('`'), 'inline code backticks are not leaked');
});
