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

test('fenced code block renders bordered fence, lang label, indented body', () => {
  const token = lexFirst('```js\nconst x = 1;\n```\n', 'code');
  const out = formatToken(token);
  const plain = stripAnsi(out);
  assert.ok(plain.includes('```js'), 'opening fence + lang label visible');
  assert.match(plain, /\n```\s*$/, 'closing fence present');
  assert.ok(plain.includes('  const x = 1;'), 'body is two-space indented');
  assert.ok(out.includes(rgbSgr(theme.mdCodeBlockBorder)), 'fence uses border color');
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

test('inline link uses link + linkText colors with URL', () => {
  const token = lexFirst('[label](https://example.com)', 'paragraph');
  const out = formatToken(token);
  assert.ok(stripAnsi(out).includes('label'), 'link label text visible');
  assert.ok(stripAnsi(out).includes('https://example.com'), 'URL visible');
  assert.ok(out.includes(rgbSgr(theme.mdLinkText)), 'link text colored');
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

test('every palette defines the full extended key set', () => {
  const required = [
    'mdCodeBlockBorder', 'mdLink', 'mdLinkText', 'mdStrong', 'mdEmph',
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
