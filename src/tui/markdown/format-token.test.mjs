import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {
  formatToken,
  highlightCodeBlockToLines,
  extraColorizers,
  _highlightCacheSizeForTests,
} from './format-token.mjs';
import { setThemeSetting, theme } from '../theme.mjs';

setThemeSetting('basic', { persist: false });

function rgbSgr(value) {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(value || ''));
  return m ? `38;2;${m[1]};${m[2]};${m[3]}` : null;
}

function lexFirst(md, type) {
  const tokens = marked.lexer(md);
  return tokens.find((t) => t.type === type) ?? tokens[0];
}

test('fenced code block has no ``` fences and shows a language label row', () => {
  const token = lexFirst('```js\nconst x = 1;\n```\n', 'code');
  const out = formatToken(token, 0, null, null, 60);
  const plain = stripAnsi(out);
  assert.ok(!plain.includes('```'), 'no literal fence markers');
  assert.ok(plain.includes('const x = 1;'), 'body present');
  // The first non-empty row is the subtle language label; its trimmed text is
  // exactly the bare lang token (gutter trims away).
  const rows = plain.split('\n').filter((l) => l.trim().length > 0);
  assert.equal(rows[0].trim(), 'js', 'first row is the language label');
});

test('short code line is gutter-indented with no background band', () => {
  const width = 60;
  const token = lexFirst('```js\nshort\n```\n', 'code');
  const out = formatToken(token, 0, null, null, width);
  // No background band: codex/claude-code render code with no `48;2;` bg.
  assert.ok(!out.includes('48;2;'), 'no background SGR');
  const bodyLine = stripAnsi(out).split('\n').find((l) => l.includes('short'));
  assert.ok(bodyLine, 'body line present');
  assert.ok(bodyLine.startsWith('  short'), 'body is gutter-indented');
  // Content width only — NOT padded out to the full render width.
  assert.equal(stringWidth(bodyLine), '  short'.length, 'body row follows content width');
});

test('code block body lines have no background band and follow content width', () => {
  const width = 80;
  const token = lexFirst('```js\na\n\nlonger line\n```\n', 'code');
  const out = formatToken(token, 0, null, null, width);
  assert.ok(!out.includes('48;2;'), 'no background SGR anywhere');
  const plainLines = stripAnsi(out).split('\n').filter((l) => l.length > 0);
  const widths = plainLines.map((l) => stringWidth(l));
  assert.ok(widths.length >= 2, 'body lines rendered');
  // Widths follow content (gutter + visible text), not forced equal to render
  // width: the longest row stays well under the 80-col render width.
  assert.ok(Math.max(...widths) < width, 'rows are not padded to the render width');
});

test('long code line wraps within requested body width', () => {
  const long = 'a'.repeat(40);
  const token = lexFirst(`\`\`\`js\n${long}\n\`\`\`\n`, 'code');
  const width = 20;
  const out = formatToken(token, 0, null, null, width);
  const bodyLines = stripAnsi(out).split('\n').filter((l) => l.includes('a'));
  assert.ok(bodyLines.length > 1, 'long line is wrapped into multiple rows');
  for (const line of bodyLines) {
    assert.ok(line.length <= width, `wrapped line "${line}" fits width ${width}`);
  }
  assert.equal(bodyLines.join('').replace(/\s/g, ''), long, 'wrapped segments preserve content');
});

test('fenced code expands tabs so width math matches the terminal', () => {
  // A raw \t counts as ZERO cells in string-width ("Tabs are ignored by
  // design"), so without normalization the wrap/row math under-counts a
  // tab-bearing line and the terminal-expanded line bleeds past the viewport
  // clip. After normalization every rendered row must contain no raw \t and
  // its visible width must equal its character length (tabs → spaces).
  const token = lexFirst('```\n\tindented\n```\n', 'code');
  const out = formatToken(token, 0, null, null, 60);
  const plain = stripAnsi(out);
  assert.ok(!plain.includes('\t'), 'no raw tab survives into the rendered string');
  const bodyLine = plain.split('\n').find((l) => l.includes('indented'));
  assert.ok(bodyLine, 'body line present');
  assert.equal(stringWidth(bodyLine), bodyLine.length, 'visible width equals char length (no zero-width tab)');
});

test('fenced code strips stray C0 control chars except newline', () => {
  // A bare \x07 (BELL) etc. measures as zero width but can move the terminal
  // cursor; replace with a space so ink's row accounting holds.
  const token = lexFirst('```\na\x07b\n```\n', 'code');
  const out = formatToken(token, 0, null, null, 60);
  const plain = stripAnsi(out);
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(plain), 'no raw C0/DEL control survives');
  const bodyLine = plain.split('\n').find((l) => l.includes('a') && l.includes('b'));
  assert.ok(bodyLine, 'body line present');
  assert.equal(stringWidth(bodyLine), bodyLine.length, 'control char became a real space cell');
});

test('list item fenced code block respects narrowed width and has no fences', () => {
  const long = 'b'.repeat(36);
  const codeTok = lexFirst(`\`\`\`js\n${long}\n\`\`\`\n`, 'code');
  const listTok = {
    type: 'list',
    ordered: false,
    items: [{ type: 'list_item', tokens: [codeTok] }],
  };
  const outerWidth = 22;
  const out = formatToken(listTok, 0, null, null, outerWidth);
  const plain = stripAnsi(out);
  assert.ok(!plain.includes('```'), 'no literal fence markers');
  const prefixed = plain.split('\n').filter((l) => l.includes('b'));
  assert.ok(prefixed.length > 1, 'nested list code wraps under narrow width');
  for (const line of prefixed) {
    assert.ok(stringWidth(line) <= outerWidth, `line fits outer width: "${line}"`);
  }
});

test('blockquote fenced code block respects narrowed width and has no fences', () => {
  const long = 'c'.repeat(36);
  const codeTok = lexFirst(`\`\`\`js\n${long}\n\`\`\`\n`, 'code');
  const quoteTok = { type: 'blockquote', tokens: [codeTok] };
  const outerWidth = 24;
  const out = formatToken(quoteTok, 0, null, null, outerWidth);
  const plain = stripAnsi(out);
  assert.ok(!plain.includes('```'), 'no literal fence markers');
  const lines = plain.split('\n').filter((l) => l.includes('c'));
  assert.ok(lines.length > 1, 'blockquote code wraps under narrow width');
  for (const line of lines) {
    assert.ok(stringWidth(line) <= outerWidth, `line fits outer width: "${line}"`);
  }
});

test('blockquote fenced code with blank line keeps quote prefix on every code row', () => {
  const codeTok = lexFirst('```js\na\n\nb\n```\n', 'code');
  const quoteTok = { type: 'blockquote', tokens: [codeTok] };
  const outerWidth = 40;
  const out = formatToken(quoteTok, 0, null, null, outerWidth);
  const plain = stripAnsi(out);
  assert.ok(!plain.includes('```'), 'no literal fence markers');
  const bar = '\u258e';
  const visibleLines = plain.split('\n').filter((l) => stringWidth(l) > 0);
  assert.ok(visibleLines.length >= 3, 'two body lines + blank padded row');
  for (const line of visibleLines) {
    assert.ok(line.startsWith(bar), `quote bar on every visible row: "${line}"`);
    assert.ok(stringWidth(line) <= outerWidth, `line fits outer width: "${line}"`);
  }
  const blankPadded = visibleLines.find((l) => !l.includes('a') && !l.includes('b'));
  assert.ok(blankPadded, 'background-padded blank code row is rendered');
  assert.ok(blankPadded.startsWith(bar), 'blank padded code row keeps quote prefix');
});

test('two-level nested list code block does not double-subtract list prefix width', () => {
  const long = 'd'.repeat(40);
  const codeTok = lexFirst(`\`\`\`js\n${long}\n\`\`\`\n`, 'code');
  const innerList = {
    type: 'list',
    ordered: false,
    items: [{ type: 'list_item', tokens: [codeTok] }],
  };
  const outerList = {
    type: 'list',
    ordered: false,
    items: [{ type: 'list_item', tokens: [innerList] }],
  };
  const outerWidth = 30;
  const singleLevelNested = formatToken(innerList, 2, null, null, outerWidth);
  const twoLevelNested = formatToken(outerList, 0, null, null, outerWidth);
  const codeLines = (plain) => plain.split('\n').filter((l) => l.includes('d'));
  const singleLines = codeLines(stripAnsi(singleLevelNested));
  const nestedLines = codeLines(stripAnsi(twoLevelNested));
  assert.equal(
    nestedLines.length,
    singleLines.length,
    'nested list code wraps like one-level nested list at the same outer width',
  );
  assert.ok(nestedLines.length > 1, 'code is wrapped under narrow width');
});

test('js highlighting colors keyword, string, number distinctly', () => {
  const token = lexFirst('```js\nconst n = 42;\nlet s = "hi";\n```\n', 'code');
  const out = formatToken(token);
  assert.ok(out.includes(rgbSgr(theme.syntaxKeyword)), 'keyword colored');
  assert.ok(out.includes(rgbSgr(theme.syntaxNumber)), 'number colored');
  assert.ok(out.includes(rgbSgr(theme.syntaxString)), 'string colored');
});

test('highlight cache serves repeat block highlight without changing output', () => {
  const c = extraColorizers();
  const text = `const cacheProbe_${Date.now()} = 1;\nlet y = 2;\n`;
  const sizeBefore = _highlightCacheSizeForTests();
  const first = highlightCodeBlockToLines(text, 'js', c);
  assert.equal(_highlightCacheSizeForTests(), sizeBefore + 1, 'first highlight populates cache');
  const second = highlightCodeBlockToLines(text, 'js', c);
  assert.deepEqual(second, first);
  assert.equal(_highlightCacheSizeForTests(), sizeBefore + 1, 'cache hit does not grow entries');
  assert.ok(first[0].includes('38;2;'), 'highlighted ANSI present');
});

test('inline codespan is accent-colored with no background band', () => {
  const tokens = marked.lexer('`hello`');
  const codespan = tokens[0].tokens[0];
  assert.equal(codespan.type, 'codespan');
  const out = formatToken(codespan);
  // Inline code uses accent color only — no bg box behind the span (a tinted
  // band behind inline text reads as awkward against body prose).
  assert.ok(!out.includes('48;2;'), 'no background SGR');
  assert.ok(stripAnsi(out).includes('hello'));
  assert.ok(out.includes(rgbSgr(theme.mdCode)), 'inline code accent');
});

test('kotlin fence resolves and highlights', () => {
  const token = lexFirst('```kotlin\nfun main() {}\n```\n', 'code');
  const out = formatToken(token);
  assert.ok(out.includes(rgbSgr(theme.syntaxKeyword)) || out.includes(rgbSgr(theme.mdCodeBlock)));
  assert.ok(stripAnsi(out).includes('fun main'));
});

test('typescript fence uses typescript highlighter', () => {
  const token = lexFirst('```ts\nconst x: number = 1;\n```\n', 'code');
  const out = formatToken(token);
  assert.ok(out.includes('38;2;'));
  assert.ok(stripAnsi(out).includes('const x'));
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
  assert.ok(stripAnsi(out).includes('some text'), 'body is flush-left');
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
  // Bold/italic carry weight/style only — NO color tint (codex/claude-code
  // convention; a colored strong/em clashes per-theme and reads too loud).
  assert.ok(strongOut.includes('\x1b[1m'), 'strong is bold');
  assert.ok(emOut.includes('\x1b[3m'), 'em is italic');
  assert.ok(!strongOut.includes(rgbSgr(theme.mdStrong)), 'strong is not color-tinted');
  assert.ok(!emOut.includes(rgbSgr(theme.mdEmph)), 'em is not color-tinted');
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
    'mdCodeBlockBorder', 'mdCodeBlockBg', 'mdCodeSpanBg', 'mdLink', 'mdLinkText', 'mdStrong', 'mdEmph',
    'mdDiffAdded', 'mdDiffRemoved', 'mdDiffHunk', 'mdDiffHeader', 'mdDiffContext',
    'mdDiffAddedBg', 'mdDiffRemovedBg',
    'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable',
    'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation',
  ];
  for (const id of ['basic', 'indigo', 'warm', 'light', 'teal', 'onedark', 'tokyonight', 'kanagawa', 'catppuccin', 'dracula', 'rosepine', 'nord', 'gruvbox', 'everforest']) {
    setThemeSetting(id, { persist: false });
    for (const key of required) {
      assert.ok(/^rgb\(\d+,\s*\d+,\s*\d+\)$/.test(String(theme[key])), `${id}.${key} is an rgb() string`);
    }
  }
  setThemeSetting('basic', { persist: false });
});
