import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import stripAnsi from 'strip-ansi';
import { formatToken } from './format-token.mjs';
import { setThemeSetting, theme } from '../theme.mjs';

setThemeSetting('mixdog', { persist: false });

function rgbSgr(value) {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(value || ''));
  return m ? `38;2;${m[1]};${m[2]};${m[3]}` : null;
}

function lexFirst(md, type) {
  const tokens = marked.lexer(md);
  return tokens.find((t) => t.type === type) ?? tokens[0];
}

test('fenced code block renders lang label without ``` fences and indented body', () => {
  const token = lexFirst('```js\nconst x = 1;\n```\n', 'code');
  const out = formatToken(token);
  const plain = stripAnsi(out);
  assert.ok(plain.includes('js'), 'language label visible');
  assert.ok(!plain.includes('```'), 'no literal fence markers');
  assert.ok(plain.includes('  const x = 1;'), 'body is two-space indented');
  assert.ok(out.includes(rgbSgr(theme.mdCodeBlockBorder)), 'lang label uses border color');
});

test('short code line has no terminal-width trailing padding band', () => {
  const token = lexFirst('```js\nshort\n```\n', 'code');
  const out = formatToken(token, 0, null, null, 60);
  const bodyLine = stripAnsi(out).split('\n').find((l) => l.includes('short'));
  assert.ok(bodyLine, 'body line present');
  assert.equal(bodyLine, '  short', 'body line is only indent + text');
});

test('long code line wraps within requested body width', () => {
  const long = 'a'.repeat(40);
  const token = lexFirst(`\`\`\`js\n${long}\n\`\`\`\n`, 'code');
  const width = 20;
  const out = formatToken(token, 0, null, null, width);
  const bodyLines = stripAnsi(out).split('\n').filter((l) => l.startsWith('  '));
  assert.ok(bodyLines.length > 1, 'long line is wrapped into multiple rows');
  for (const line of bodyLines) {
    assert.ok(line.length <= width, `wrapped line "${line}" fits width ${width}`);
  }
  assert.equal(bodyLines.join('').replace(/\s/g, ''), long, 'wrapped segments preserve content');
});

test('js highlighting colors keyword, string, number distinctly', () => {
  const token = lexFirst('```js\nconst n = 42;\nlet s = "hi";\n```\n', 'code');
  const out = formatToken(token);
  assert.ok(out.includes(rgbSgr(theme.syntaxKeyword)), 'keyword colored');
  assert.ok(out.includes(rgbSgr(theme.syntaxNumber)), 'number colored');
  assert.ok(out.includes(rgbSgr(theme.syntaxString)), 'string colored');
});

test('diff fenced block colors add/remove/hunk/header separately', () => {
  const diff = [
    '```diff',
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    ' context line',
    '```',
    '',
  ].join('\n');
  const token = lexFirst(diff, 'code');
  const out = formatToken(token);
  const added = rgbSgr(theme.mdDiffAdded);
  const removed = rgbSgr(theme.mdDiffRemoved);
  const hunk = rgbSgr(theme.mdDiffHunk);
  const header = rgbSgr(theme.mdDiffHeader);
  assert.ok(out.includes(added), 'added line color present');
  assert.ok(out.includes(removed), 'removed line color present');
  assert.ok(out.includes(hunk), 'hunk line color present');
  assert.ok(out.includes(header), 'header line color present');
  assert.equal(new Set([added, removed, hunk, header]).size, 4);
  assert.ok(out.indexOf('+++ b/x') !== -1);
});

test('plus/minus file headers are not treated as add/remove', () => {
  const diff = '```patch\n--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+x\n```\n';
  const token = lexFirst(diff, 'code');
  const out = formatToken(token);
  const headerSgr = rgbSgr(theme.mdDiffHeader);
  const addedSgr = rgbSgr(theme.mdDiffAdded);
  const idxHeader = out.indexOf('+++ b/f');
  const before = out.slice(0, idxHeader);
  const lastHeader = before.lastIndexOf(headerSgr);
  const lastAdded = before.lastIndexOf(addedSgr);
  assert.ok(lastHeader > lastAdded, 'plus-plus-plus header uses header color, not added');
});

test('bare unified diff (no lang) is detected and colored', () => {
  const token = lexFirst('```\n@@ -1 +1 @@\n-a\n+b\n```\n', 'code');
  const out = formatToken(token);
  assert.ok(out.includes(rgbSgr(theme.mdDiffHunk)), 'hunk colored on bare diff');
  assert.ok(out.includes(rgbSgr(theme.mdDiffAdded)), 'add colored on bare diff');
});

test('unknown language falls back to flat code block color', () => {
  const token = lexFirst('```foobarlang\nsome text\n```\n', 'code');
  const out = formatToken(token);
  assert.ok(out.includes(rgbSgr(theme.mdCodeBlock)), 'flat code-block color used');
  assert.ok(stripAnsi(out).includes('  some text'), 'body still indented');
});

test('inline link emits OSC 8 hyperlink with styled label (URL hidden)', () => {
  const token = lexFirst('[label](https://example.com)', 'paragraph');
  const out = formatToken(token);
  // OSC 8 wraps the visible label; the raw URL lives in the escape, not as
  // on-screen text, so stripAnsi keeps only the label.
  assert.ok(out.includes('\x1b]8;;https://example.com\x07'), 'OSC 8 link target present');
  assert.ok(out.includes('\x1b]8;;\x07'), 'OSC 8 close present');
  assert.ok(stripAnsi(out).includes('label'), 'link label text visible');
  assert.ok(out.includes(rgbSgr(theme.mdLinkText)), 'link label colored');
});

test('bare-url link emits OSC 8 with the URL as visible clickable text', () => {
  const token = lexFirst('<https://example.com>', 'paragraph');
  const out = formatToken(token);
  assert.ok(out.includes('\x1b]8;;https://example.com\x07'), 'OSC 8 link target present');
  assert.ok(stripAnsi(out).includes('https://example.com'), 'URL visible as text');
  assert.ok(out.includes(rgbSgr(theme.mdLink)), 'link URL colored');
});

test('strong and em use distinct mdStrong / mdEmph colors', () => {
  const strongTok = lexFirst('**bold**', 'paragraph');
  const emTok = lexFirst('*ital*', 'paragraph');
  const strongOut = formatToken(strongTok);
  const emOut = formatToken(emTok);
  assert.ok(strongOut.includes(rgbSgr(theme.mdStrong)), 'strong colored');
  assert.ok(emOut.includes(rgbSgr(theme.mdEmph)), 'em colored');
  assert.ok(strongOut.includes('\x1b[1m'), 'strong is bold');
  assert.ok(emOut.includes('\x1b[3m'), 'em is italic');
});

test('h1 heading is bold, italic, and underlined', () => {
  const token = lexFirst('# Title', 'heading');
  const out = formatToken(token);
  assert.ok(out.includes('\x1b[1m'), 'h1 is bold');
  assert.ok(out.includes('\x1b[3m'), 'h1 is italic');
  assert.ok(out.includes('\x1b[4m'), 'h1 is underlined');
});

test('ordered list markers follow nesting depth (1. / a. / i.)', () => {
  const md = [
    '1. one',
    '   1. two',
    '      1. three',
    '         1. four',
  ].join('\n');
  const tokens = marked.lexer(md);
  const plain = stripAnsi(tokens.map((t) => formatToken(t)).join(''));
  assert.ok(plain.includes('1. one'), 'depth 0 arabic');
  assert.ok(plain.includes('1. two'), 'depth 1 arabic');
  assert.ok(plain.includes('a. three'), 'depth 2 lowercase letter');
  assert.ok(plain.includes('i. four'), 'depth 3 lowercase roman');
});

test('every palette defines the full extended key set', () => {
  const required = [
    'mdCodeBlockBorder', 'mdCodeBlockBg', 'mdLink', 'mdLinkText', 'mdStrong', 'mdEmph',
    'mdDiffAdded', 'mdDiffRemoved', 'mdDiffHunk', 'mdDiffHeader', 'mdDiffContext',
    'mdDiffAddedBg', 'mdDiffRemovedBg',
    'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable',
    'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation',
  ];
  for (const id of ['mixdog', 'pi-dark', 'claude-dark', 'dracula', 'tokyonight', 'nord', 'gruvbox', 'catppuccin', 'everforest']) {
    setThemeSetting(id, { persist: false });
    for (const key of required) {
      assert.ok(/^rgb\(\d+,\s*\d+,\s*\d+\)$/.test(String(theme[key])), `${id}.${key} is an rgb() string`);
    }
  }
  setThemeSetting('mixdog', { persist: false });
});
