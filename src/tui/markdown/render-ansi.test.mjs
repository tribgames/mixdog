import test from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import { renderTokenAnsiSegments, lexMarkdown } from './render-ansi.mjs';
import { setThemeSetting } from '../theme.mjs';

setThemeSetting('mixdog', { persist: false });

// Mirrors the streaming suffix the <Markdown trimPartialFences> path renders.
const STREAMING = '```js\nconst x = 1;\n`';

function codeBlockVisibleLines(segments) {
  // The fenced block is a single ANSI segment; return its visible code body
  // lines (between the fences).
  const codeSeg = segments.find(
    (s) => s.type === 'ansi' && stripAnsi(s.ansi).startsWith('```'),
  );
  assert.ok(codeSeg, 'a fenced code segment is rendered');
  const lines = stripAnsi(codeSeg.ansi).split('\n');
  // drop opening + closing fence lines
  return lines;
}

test('streaming render path drops the partial trailing backtick body line', () => {
  const segments = renderTokenAnsiSegments(STREAMING, { trimPartialFences: true });
  const lines = codeBlockVisibleLines(segments);
  // No body line may be a lone backtick (the partial closing fence).
  const bodyLines = lines.filter((l) => !/^```/.test(l.trimStart()));
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
  const bodyLines = lines.filter((l) => !/^```/.test(l.trimStart()));
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

test('closed code block renders both fences and the body intact', () => {
  const segments = renderTokenAnsiSegments('```js\nconst z = 3;\n```\n', { trimPartialFences: true });
  const lines = codeBlockVisibleLines(segments);
  assert.ok(lines.some((l) => l.includes('const z = 3;')), 'body present');
  assert.equal(lines.filter((l) => /^```/.test(l.trimStart())).length, 2, 'open + close fences');
});
