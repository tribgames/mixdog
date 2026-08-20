/**
 * markdown-surface-test.mjs — element coverage for the terminal markdown
 * surfaces (ink TUI renderer + REPL post-render renderer).
 *
 * The desktop/web pipeline is covered by
 * apps/desktop/src/renderer/markdown-pipeline.test.mjs; together the two files
 * pin the elements that used to render differently on each surface (strong at a
 * punctuation boundary, strikethrough, task boxes, raw HTML, images, and the
 * streaming heal).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTokenAnsiSegments, hasMarkdownSyntax } from '../src/tui/markdown/render-ansi.mjs';
import { balanceStreamingMarkdown } from '../src/tui/markdown/streaming-markdown.mjs';
import { renderMarkdown } from '../src/ui/markdown.mjs';
import { stripAnsi } from '../src/ui/ansi.mjs';

const BOLD = '\u001b[1m';
const STRIKE = '\u001b[9m';

function tui(text, width = 60) {
  return renderTokenAnsiSegments(text, { width })
    .map((segment) => segment.ansi ?? '')
    .join('\n');
}

function tuiText(text, width = 60) {
  return stripAnsi(tui(text, width));
}

test('TUI: strong closes against a punctuation + letter boundary', () => {
  const rendered = tui('**0.118%**tail');
  assert.ok(rendered.includes(BOLD), 'expected a bold SGR run');
  assert.equal(stripAnsi(rendered), '0.118%tail');
});

test('TUI: strikethrough is pair-only', () => {
  const struck = tui('~~gone~~ kept');
  assert.ok(struck.includes(STRIKE), 'expected a strikethrough SGR run');
  assert.equal(stripAnsi(struck), 'gone kept');
  assert.equal(tui('1~2 range').includes(STRIKE), false);
});

test('TUI: task boxes keep their state', () => {
  const rendered = tuiText('- [ ] todo\n- [x] done');
  assert.match(rendered, /\[ \] todo/);
  assert.match(rendered, /\[x\] done/);
});

test('TUI: raw HTML survives, comments do not', () => {
  assert.match(tuiText('text <b>x</b> end'), /<b>x<\/b>/);
  assert.equal(tuiText('<!-- hidden -->').trim(), '');
});

test('TUI: images keep their alt text', () => {
  const rendered = tuiText('![alt text](https://x.dev/a.png)');
  assert.match(rendered, /alt text/);
  assert.match(rendered, /https:\/\/x\.dev\/a\.png/);
});

test('TUI: block syntax outside the inline marker class is detected', () => {
  for (const source of ['+ a\n+ b', '1) a\n2) b', 'Title\n=====', '    indented']) {
    assert.equal(hasMarkdownSyntax(source), true, `expected markdown syntax in ${JSON.stringify(source)}`);
  }
  assert.equal(tuiText('+ a\n+ b'), '- a\n- b');
  assert.ok(tui('Title\n=====').includes(BOLD), 'setext heading should render bold');
});

test('TUI: footnote definitions stay visible and are not linkified', () => {
  const rendered = tuiText('body[^1]\n\n[^1]: the note');
  assert.match(rendered, /the note/);
  assert.equal(tui('body[^1]\n\n[^1]: the note').includes('\u001b]8;;'), false);
});

test('TUI streaming: unfinished emphasis, code and links are healed', () => {
  assert.equal(balanceStreamingMarkdown('**plan'), '**plan**');
  assert.equal(balanceStreamingMarkdown('*part'), '*part*');
  assert.equal(balanceStreamingMarkdown('~~drop'), '~~drop~~');
  assert.equal(balanceStreamingMarkdown('`co'), '`co`');
  assert.equal(balanceStreamingMarkdown('see [docs](https://exa'), 'see docs');
});

test('TUI streaming: literal markers are not mistaken for emphasis', () => {
  assert.equal(balanceStreamingMarkdown('2 * 3 = 6'), '2 * 3 = 6');
  assert.equal(balanceStreamingMarkdown('`a**b`'), '`a**b`');
  assert.equal(balanceStreamingMarkdown('snake_case_name'), 'snake_case_name');
});

test('REPL: backslash escapes render as literal characters', () => {
  assert.equal(stripAnsi(renderMarkdown('a\\*x\\*b')), 'a*x*b');
});

test('REPL: images drop the bang and keep the alt text', () => {
  const rendered = stripAnsi(renderMarkdown('![alt](https://x.dev/a.png)'));
  assert.equal(rendered.startsWith('!'), false);
  assert.match(rendered, /alt \(https:\/\/x\.dev\/a\.png\)/);
});

test('REPL: setext headings and task boxes render', () => {
  const heading = stripAnsi(renderMarkdown('Title\n====='));
  assert.match(heading, /Title/);
  assert.equal(heading.includes('====='), false);
  assert.match(stripAnsi(renderMarkdown('- [x] done')), /\[x\] done/);
});

test('REPL: reference links and footnotes resolve', () => {
  const rendered = stripAnsi(renderMarkdown('see [docs][1]\n\n[1]: https://x.dev'));
  assert.match(rendered, /docs \(https:\/\/x\.dev\)/);
  assert.equal(rendered.includes('[1]:'), false);
  assert.match(stripAnsi(renderMarkdown('body[^1]\n\n[^1]: the note')), /the note/);
});

test('REPL: GFM tables render as aligned rows', () => {
  const rendered = stripAnsi(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 22 |'));
  assert.match(rendered, /a/);
  assert.match(rendered, /22/);
  assert.equal(rendered.includes('---'), false);
});
