/**
 * A fenced code block streamed in small chunks: it arrives with its content,
 * never as a bare box, raw fence characters, or a word-by-word fade.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { parseMarkdownToHast } from './markdown-ast';
import MarkdownAstBody from './MarkdownAstBody';
import { StreamFadeTimeline } from './markdown-stream-fade.ts';
import { healStreamingMarkdownTail } from './streaming-markdown';

const CopyControl = () => null;
const REPLY = 'Run this first:\n\n```bash\nnpm install\nnpm run build\n```\n\nThen `npm test` to finish.';
const markupOf = (prefix, timeline) =>
  renderToStaticMarkup(
    React.createElement(MarkdownAstBody, {
      root: parseMarkdownToHast(healStreamingMarkdownTail(prefix)),
      copyControl: CopyControl,
      fadeTimeline: timeline,
      fadeChunk: 'c0',
    })
  );
const textOf = (markup) => markup.replace(/<[^>]*>/g, '');

function* prefixes(step) {
  for (let end = 1; end <= REPLY.length; end += step) yield REPLY.slice(0, end);
  yield REPLY;
}

for (const step of [1, 3, 7]) {
  test(`code block streamed ${step} char(s) at a time arrives whole and in order`, () => {
    const timeline = new StreamFadeTimeline();
    for (const prefix of prefixes(step)) {
      const markup = markupOf(prefix, timeline);
      const shown = textOf(markup);
      assert.ok(!shown.includes('```'), `raw fence in ${JSON.stringify(prefix)}`);
      assert.ok(!shown.includes('`'), `raw backtick in ${JSON.stringify(prefix)}`);
      for (const block of markup.matchAll(/<pre[\s\S]*?<\/pre>/g)) {
        assert.ok(textOf(block[0]).trim(), `empty code box in ${JSON.stringify(prefix)}`);
        assert.ok(!block[0].includes('<mx-fade'), `code fades word by word in ${JSON.stringify(prefix)}`);
      }
      for (const code of markup.matchAll(/<code[\s\S]*?<\/code>/g)) {
        assert.ok(!code[0].includes('<mx-fade'), `code fades word by word in ${JSON.stringify(prefix)}`);
      }
      // Nothing after the block shows before the block has closed.
      if (!prefix.includes('build\n```')) assert.ok(!shown.includes('Then'), JSON.stringify(prefix));
    }
  });
}

test('prose around a code block still fades', () => {
  const timeline = new StreamFadeTimeline();
  const markup = markupOf(REPLY, timeline);
  assert.match(markup, /<mx-fade[^>]*>Run /);
  assert.match(markup, /<mx-fade[^>]*>finish/);
});

test('an opening fence is held back until its first code character', () => {
  const heal = healStreamingMarkdownTail;
  assert.equal(heal('Intro\n\n```'), 'Intro\n\n');
  assert.equal(heal('Intro\n\n```bash'), 'Intro\n\n');
  assert.equal(heal('Intro\n\n```bash\n'), 'Intro\n\n');
  assert.equal(heal('Intro\n\n```bash\n  \n'), 'Intro\n\n');
  assert.equal(heal('Intro\n\n```bash\nnpm'), 'Intro\n\n```bash\nnpm');
});
