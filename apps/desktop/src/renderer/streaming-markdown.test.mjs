/**
 * streaming-markdown.test.mjs — the live-tail block splitter.
 *
 * `markdownBlockStarts` replaced a full remark parse of the unfinished tail on
 * every streamed token. These tests pin it to remark-parse's top-level block
 * offsets and replay whole streams through the previous parse-based splitter
 * so the frozen chunks, their keys and the live tail stay identical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import remarkParse from 'remark-parse';
import { unified } from 'unified';

import {
  createStreamingMarkdownCache,
  markdownBlockStarts,
  MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS,
  resolveStreamingMarkdownChunks,
} from './streaming-markdown';

const parser = unified().use(remarkParse);

function remarkBlockStarts(text) {
  return parser
    .parse(text)
    .children.map((child) => Number(child.position?.start.offset))
    .filter((offset) => Number.isFinite(offset) && offset >= 0);
}

// The splitter as it was before the line scanner: identical except that the
// non-fence boundaries came from a remark parse of the tail.
function createParseSplitter() {
  const fresh = () => ({
    stableText: '',
    stableChunks: [],
    stableChunkKeys: [],
    sourceText: '',
    scanOffset: 0,
    fenceMarker: '',
    fenceLength: 0,
    boundaries: [],
  });
  const cache = fresh();
  const key = (offset) => `chunk-${Math.max(0, Math.round(offset))}`;
  const continues = (previous, next) => {
    if (!previous || previous === next) return true;
    if (next.length < previous.length) return false;
    const headLength = Math.min(128, previous.length);
    if (next.slice(0, headLength) !== previous.slice(0, headLength)) return false;
    const tailStart = Math.max(headLength, previous.length - 128);
    return next.slice(tailStart, previous.length) === previous.slice(tailStart);
  };
  const scan = (text) => {
    let lineStart = cache.scanOffset;
    while (lineStart < text.length) {
      const newline = text.indexOf('\n', lineStart);
      if (newline < 0) break;
      const rawLine = text.slice(lineStart, newline).replace(/\r$/, '');
      const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(rawLine);
      if (fence) {
        const marker = fence[1][0];
        if (!cache.fenceMarker) {
          cache.fenceMarker = marker;
          cache.fenceLength = fence[1].length;
        } else if (marker === cache.fenceMarker && fence[1].length >= cache.fenceLength && !fence[2].trim()) {
          cache.fenceMarker = '';
          cache.fenceLength = 0;
        }
      } else if (!cache.fenceMarker && !rawLine.trim()) {
        cache.boundaries.push(newline + 1);
        if (cache.boundaries.length > 2) cache.boundaries.shift();
      }
      lineStart = newline + 1;
    }
    cache.scanOffset = lineStart;
  };
  const boundaries = (text) => {
    scan(text);
    const base = cache.stableText.length;
    if (cache.fenceMarker) {
      const beforeFence = [...cache.boundaries].reverse().find((position) => position > base);
      return beforeFence === undefined ? [] : [beforeFence];
    }
    return remarkBlockStarts(text.slice(base))
      .slice(1)
      .map((offset) => base + offset);
  };
  return (value, streaming) => {
    if (!continues(cache.sourceText, value)) Object.assign(cache, fresh());
    if (!streaming) {
      if (cache.stableText && value.startsWith(cache.stableText)) {
        cache.sourceText = value;
        return {
          stableChunks: cache.stableChunks,
          stableChunkKeys: cache.stableChunkKeys,
          unstableText: value.slice(cache.stableText.length),
          unstableKey: key(cache.stableText.length),
          parseUnstable: true,
        };
      }
      Object.assign(cache, fresh());
      cache.sourceText = value;
      return { stableChunks: [], stableChunkKeys: [], unstableText: value, unstableKey: key(0), parseUnstable: true };
    }
    for (const boundary of boundaries(value)) {
      if (boundary <= cache.stableText.length || boundary > value.length) continue;
      const chunk = value.slice(cache.stableText.length, boundary);
      if (!chunk) continue;
      const chunkKey = key(cache.stableText.length);
      cache.stableText += chunk;
      cache.stableChunks = [...cache.stableChunks, chunk];
      cache.stableChunkKeys = [...cache.stableChunkKeys, chunkKey];
    }
    cache.boundaries = cache.boundaries.filter((position) => position > cache.stableText.length);
    cache.sourceText = value;
    const unstableText = value.slice(cache.stableText.length);
    return {
      stableChunks: cache.stableChunks,
      stableChunkKeys: cache.stableChunkKeys,
      unstableText,
      unstableKey: key(cache.stableText.length),
      parseUnstable: unstableText.length <= MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS,
    };
  };
}

function snapshot(parts) {
  return {
    stableChunks: [...parts.stableChunks],
    stableChunkKeys: [...parts.stableChunkKeys],
    unstableText: parts.unstableText,
    unstableKey: parts.unstableKey,
    parseUnstable: parts.parseUnstable,
  };
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
  math: [
    'Inline $x^2$ math.',
    '',
    '$$',
    '\\int_0^1 x\\,dx',
    '$$',
    'After math.',
    '',
    '$$ a+b $$',
    '\\[ x \\]',
  ].join('\n'),
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
    '  \'multi-line title\'',
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
    '', '', 'text', '  indented text', '- item', '* item', '+ item', '-', '- ', '1. one', '2. two', '1) paren',
    '01. zero', '  - nested', '    - deep', '> quote', '> > nested', '>', '> - q item', '>     qcode', '# head',
    '#nohead', '```', '```js', '``` `x`', '~~~', '    code', '\tcode', '\t- tab', '***', '---', '===', '- - -',
    '<div>', '</div>', '<!-- c', '-->', '<x>', '<a href="x">', '<a href=/x>', '<script>', '</script>', '<?php',
    '[a]: /u', '[b]: <u> "t"', '[c]:', '  /dest', '"title"', '[link](x) y', '| a | b |', '|---|---|', '$$',
    'x^2', '1.', '*', '> ```', '- ```', '  code in item', '      code in item',
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

test('streamed chunks, keys and live tail match the parse-based splitter', () => {
  for (const [name, text] of Object.entries(REPRESENTATIVE)) {
    for (const step of [1, 3, 7, 16]) {
      const cache = createStreamingMarkdownCache();
      const previous = createParseSplitter();
      for (let end = step; ; end = Math.min(text.length, end + step)) {
        const prefix = text.slice(0, end);
        assert.deepEqual(
          snapshot(resolveStreamingMarkdownChunks(prefix, true, cache)),
          snapshot(previous(prefix, true)),
          `${name} step ${step} @${end}`
        );
        if (end === text.length) break;
      }
      assert.deepEqual(
        snapshot(resolveStreamingMarkdownChunks(text, false, cache)),
        snapshot(previous(text, false)),
        `${name} step ${step} settled`
      );
    }
  }
});

test('the live tail freezes every completed top-level block', () => {
  const cache = createStreamingMarkdownCache();
  const text = '# Plan\n\n- one\n- two\n\n```js\nrun();\n```\n\n| a |\n|---|\n\nTail';
  const parts = resolveStreamingMarkdownChunks(text, true, cache);
  assert.deepEqual(parts.stableChunks, ['# Plan\n\n', '- one\n- two\n\n', '```js\nrun();\n```\n\n', '| a |\n|---|\n\n']);
  assert.equal(parts.unstableText, 'Tail');
  assert.equal(parts.parseUnstable, true);
});
