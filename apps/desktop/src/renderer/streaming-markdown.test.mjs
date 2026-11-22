import test from 'node:test';
import assert from 'node:assert/strict';

import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import {
  createStreamingMarkdownCache,
  markdownBlockStarts,
  resolveStreamingMarkdownChunks,
} from './streaming-markdown';

const chunksOf = (parts) => parts.added.map((block) => block.text);

// The renderer's block structure: display math is a block (markdown-ast).
const parser = unified().use(remarkParse).use(remarkMath);

function remarkBlockStarts(text) {
  return parser
    .parse(text)
    .children.map((child) => Number(child.position?.start.offset))
    .filter((offset) => Number.isFinite(offset) && offset >= 0);
}

const REPRESENTATIVE = {
  'code fences': [
    'Intro paragraph.',
    '',
    '```ts',
    'const a = 1;',
    '',
    'const b = `x`;',
    '```',
    'After the fence.',
    '',
    '~~~',
    'raw ``` inside',
    '~~~',
    '',
    '````md',
    '```js',
    'nested',
    '```',
    '````',
    '  ```',
    '  indented fence',
    '  ```',
    'Done.',
  ].join('\n'),
  lists: [
    'Steps:',
    '1. First',
    '2. Second',
    '   - nested a',
    '   - nested b',
    '',
    '     continued paragraph',
    '3. Third',
    'lazy line',
    '',
    '- bullet',
    '* star',
    '+ plus',
    '',
    '- [ ] task',
    '- [x] done',
    '',
    '',
    '- after two blanks',
    '10) ten',
    '11) eleven',
    'text after',
    '-',
    '',
    '  empty item then indented',
    'Para',
    '2. cannot interrupt',
    '1. can interrupt',
  ].join('\n'),
  tables: [
    '| Name | Value |',
    '| --- | ---: |',
    '| a | 1 |',
    '| b | 2 |',
    '',
    'Text under the table.',
    '| x |',
    '|---|',
    '- | y |',
  ].join('\n'),
  math: ['Inline $x^2$ math.', '', '$$', '\\int_0^1 x\\,dx', '$$', 'After math.', '', '$$ a+b $$', '\\[ x \\]'].join(
    '\n'
  ),
  'nested quotes': [
    '> Quote level one',
    '> > Level two',
    '> > - item in quote',
    '> > ```',
    '> > code in quote',
    '> > ```',
    '> back to one',
    'lazy continuation',
    '',
    '> new quote',
    '>',
    '>     quoted code',
    '    lazy indented line',
    '> - a',
    '<span>lazy tag</span>',
    'next',
    '',
    'plain',
  ].join('\n'),
  'fence in a list item': [
    '1. Install:',
    '',
    '   ```bash',
    '   npm i',
    '',
    '   npm run build',
    '   ```',
    '',
    '2. Next step',
    '',
    '> quoted:',
    '>',
    '> ```',
    '> code',
    '> ```',
    'After.',
  ].join('\n'),
  'unfinished fence': [
    'Here is the script:',
    '',
    '```python',
    'def main():',
    "    print('hi')",
    '',
    '    return 0',
    '',
  ].join('\n'),
  'headings, html and definitions': [
    '# Title',
    'Setext',
    '======',
    '---',
    '***',
    '<details>',
    '<summary>More</summary>',
    '',
    'Hidden',
    '</details>',
    '<!-- note',
    'still comment -->',
    '[ref]: https://example.com "Title"',
    '[ref2]: <https://x.y>',
    "  'multi-line title'",
    'See [ref].',
    '',
    '[only]: /definition',
    '===',
    'Underline after definitions',
    '---',
    '',
    '    indented code',
    '',
    '    more code',
    '한국어 문단입니다.\r',
    '\r',
    '## CRLF heading\r',
    '\tTabbed code',
  ].join('\n'),
};

test('block starts match remark-parse on representative markdown', () => {
  for (const [name, text] of Object.entries(REPRESENTATIVE)) {
    for (let end = 0; end <= text.length; end += 1) {
      const prefix = text.slice(0, end);
      assert.deepEqual(markdownBlockStarts(prefix), remarkBlockStarts(prefix), `${name} @${end}`);
    }
  }
});

test('block starts match remark-parse on generated markdown', () => {
  const fragments = [
    '',
    '',
    'text',
    '  indented text',
    '- item',
    '* item',
    '+ item',
    '-',
    '- ',
    '1. one',
    '2. two',
    '1) paren',
    '01. zero',
    '  - nested',
    '    - deep',
    '> quote',
    '> > nested',
    '>',
    '> - q item',
    '>     qcode',
    '# head',
    '#nohead',
    '```',
    '```js',
    '``` `x`',
    '~~~',
    '    code',
    '\tcode',
    '\t- tab',
    '***',
    '---',
    '===',
    '- - -',
    '<div>',
    '</div>',
    '<!-- c',
    '-->',
    '<x>',
    '<a href="x">',
    '<a href=/x>',
    '<script>',
    '</script>',
    '<?php',
    '[a]: /u',
    '[b]: <u> "t"',
    '[c]:',
    '  /dest',
    '"title"',
    '[link](x) y',
    '| a | b |',
    '|---|---|',
    '$$',
    'x^2',
    '1.',
    '*',
    '> ```',
    '- ```',
    '  code in item',
    '      code in item',
  ];
  let seed = 20260925;
  const random = (limit) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % limit;
  };
  for (let sample = 0; sample < 3000; sample += 1) {
    const lines = Array.from({ length: 1 + random(14) }, () => fragments[random(fragments.length)]);
    const text = lines.join(random(8) ? '\n' : '\r\n') + (random(3) ? '' : '\n');
    assert.deepEqual(markdownBlockStarts(text), remarkBlockStarts(text), JSON.stringify(text));
  }
});

test('a rewritten live tail keeps the frozen blocks it still starts with', () => {
  const cache = createStreamingMarkdownCache();
  const before = resolveStreamingMarkdownChunks('# Plan\n\nFirst paragraph.\n\nA tail that keeps growing', cache);
  assert.deepEqual(chunksOf(before), ['# Plan\n\n', 'First paragraph.\n\n']);
  const rewritten = resolveStreamingMarkdownChunks('# Plan\n\nFirst paragraph.\n\nA tail\n\n```js\nrun();', cache);
  assert.deepEqual(chunksOf(rewritten), ['A tail\n\n']);
  assert.equal(rewritten.added[0].start, '# Plan\n\nFirst paragraph.\n\n'.length);
  assert.equal(rewritten.generation, before.generation, 'the frozen blocks stand');
  assert.equal(rewritten.unstableText, '```js\nrun();');
  const replaced = resolveStreamingMarkdownChunks('Another reply', cache);
  assert.notEqual(replaced.generation, before.generation, 'none of them stands');
  assert.deepEqual(chunksOf(replaced), []);
  assert.equal(replaced.unstableText, 'Another reply');
});

test('the live tail freezes every completed top-level block', () => {
  const cache = createStreamingMarkdownCache();
  const text = '# Plan\n\n- one\n- two\n\n```js\nrun();\n```\n\n| a |\n|---|\n\nTail';
  const parts = resolveStreamingMarkdownChunks(text, cache);
  assert.deepEqual(chunksOf(parts), ['# Plan\n\n', '- one\n- two\n\n', '```js\nrun();\n```\n\n', '| a |\n|---|\n\n']);
  assert.equal(parts.unstableText, 'Tail');
  assert.equal(parts.parseUnstable, true);
});
