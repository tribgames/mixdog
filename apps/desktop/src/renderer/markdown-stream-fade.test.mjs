import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyStreamFade,
  STREAM_FADE_DURATION_MS,
  STREAM_FADE_MAX_LEAD_MS,
  STREAM_FADE_STAGGER_MS,
  StreamFadeTimeline,
  streamFadeWords,
} from './markdown-stream-fade.ts';

const paragraph = (...children) => ({
  type: 'root',
  children: [{ type: 'element', tagName: 'p', properties: {}, children }],
});
const text = (value) => ({ type: 'text', value });

function wrapped(root) {
  const found = [];
  const visit = (node) => {
    if (node.type === 'element' && node.tagName.startsWith('mx-fade-')) {
      found.push({ tag: node.tagName, text: node.children[0].value, at: node.properties.dataFadeAt });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return found;
}

test('words carry their trailing spaces and punctuation', () => {
  assert.deepEqual(streamFadeWords('Hello, big world!'), ['Hello, ', 'big ', 'world!']);
  assert.deepEqual(streamFadeWords('  lead'), ['  lead']);
  assert.deepEqual(streamFadeWords('\n'), ['\n']);
});

test('each word gets its own staggered start, capped ahead of now', () => {
  const timeline = new StreamFadeTimeline();
  const words = Array.from({ length: 50 }, (_, index) => `w${index} `).join('');
  const out = wrapped(applyStreamFade(paragraph(text(words)), 'c0', timeline, 1000).root);
  assert.equal(out.length, 50);
  assert.equal(out[0].at, 1000);
  assert.equal(out[1].at, 1000 + STREAM_FADE_STAGGER_MS);
  assert.equal(new Set(out.map((word) => word.tag)).size, 50);
  assert.equal(Math.max(...out.map((word) => word.at)), 1000 + STREAM_FADE_MAX_LEAD_MS);
});

test('revealed words keep their start across re-renders and settle into plain text', () => {
  const timeline = new StreamFadeTimeline();
  const first = wrapped(applyStreamFade(paragraph(text('Hello wor')), 'c0', timeline, 0).root);
  // "wor" grew into "world" in place: same word, same reveal.
  const second = wrapped(applyStreamFade(paragraph(text('Hello world again')), 'c0', timeline, 100).root);
  assert.deepEqual(
    second.slice(0, 2),
    first.map((word, index) => ({ ...word, text: ['Hello ', 'world '][index] }))
  );
  assert.equal(second[2].at, 100);
  const later = applyStreamFade(
    paragraph(text('Hello world again!')),
    'c0',
    timeline,
    first[1].at + STREAM_FADE_DURATION_MS
  );
  assert.deepEqual(
    wrapped(later.root).map((word) => word.text),
    ['again!']
  );
  assert.equal(later.root.children[0].children[0].value, 'Hello world ');
});

test('a re-parse into new elements keeps word identity', () => {
  const timeline = new StreamFadeTimeline();
  const before = wrapped(applyStreamFade(paragraph(text('a b')), 'c0', timeline, 0).root);
  const strong = { type: 'element', tagName: 'strong', properties: {}, children: [text('b')] };
  const after = wrapped(applyStreamFade(paragraph(text('a '), strong), 'c0', timeline, 10).root);
  assert.equal(after[0].tag, before[0].tag);
  assert.equal(after.length, 2);
});

test('a new chunk inherits the words cut off the chunk it split from', () => {
  const timeline = new StreamFadeTimeline();
  const tail = wrapped(applyStreamFade(paragraph(text('One two. Three')), 'chunk-0', timeline, 0).root);
  applyStreamFade(paragraph(text('One two.')), 'chunk-0', timeline, 20);
  const next = wrapped(applyStreamFade(paragraph(text('Three four')), 'chunk-9', timeline, 20).root);
  assert.equal(next[0].tag, tail[2].tag);
  assert.equal(next[0].at, tail[2].at);
  assert.equal(next[1].at, tail[2].at + STREAM_FADE_STAGGER_MS);
});

test('blank text, math and svg are left whole', () => {
  const timeline = new StreamFadeTimeline();
  const root = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'p', properties: {}, children: [text('a')] },
      text('\n'),
      { type: 'element', tagName: 'span', properties: { className: ['katex'] }, children: [text('x')] },
    ],
  };
  const out = applyStreamFade(root, 'c0', timeline, 0).root;
  assert.deepEqual(
    wrapped(out).map((word) => word.text),
    ['a']
  );
  assert.equal(out.children[1], root.children[1]);
  assert.equal(out.children[2], root.children[2]);
});
