import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyStreamFade,
  STREAM_FADE_COMMENTARY_MS,
  STREAM_FADE_DURATION_MS,
  StreamFadeTimeline,
  streamFadeTimeline,
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
      found.push({
        tag: node.tagName,
        text: node.children[0].value,
        at: node.properties.dataFadeAt,
        ms: node.properties.dataFadeMs,
      });
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

test('words revealed together start fading together: no stagger of their own', () => {
  const timeline = new StreamFadeTimeline();
  const words = Array.from({ length: 50 }, (_, index) => `w${index} `).join('');
  const out = wrapped(applyStreamFade(paragraph(text(words)), 'c0', timeline, 1000).root);
  assert.equal(out.length, 50);
  assert.deepEqual(new Set(out.map((word) => word.at)), new Set([1000]));
  assert.deepEqual(new Set(out.map((word) => word.ms)), new Set([STREAM_FADE_DURATION_MS]));
  assert.equal(new Set(out.map((word) => word.tag)).size, 50);
});

test('commentary words fade quickly; a word that grows keeps its one fade', () => {
  const timeline = streamFadeTimeline('row:commentary', true, STREAM_FADE_COMMENTARY_MS);
  const first = wrapped(applyStreamFade(paragraph(text('Checking the lay')), 'c0', timeline, 0).root);
  const out = wrapped(applyStreamFade(paragraph(text('Checking the layout')), 'c0', timeline, 50).root);
  assert.deepEqual(
    out.map((word) => word.ms),
    [STREAM_FADE_COMMENTARY_MS, STREAM_FADE_COMMENTARY_MS, STREAM_FADE_COMMENTARY_MS]
  );
  assert.deepEqual(
    out.map((word) => [word.tag, word.at]),
    first.map((word) => [word.tag, word.at]),
    '"lay" grew into "layout" in place'
  );
});

test('a reply that stops streaming has no timeline: words mid-fade show at full ink', () => {
  const timeline = streamFadeTimeline('row:final', true);
  assert.ok(timeline);
  assert.equal(timeline.durationMs, STREAM_FADE_DURATION_MS);
  assert.equal(streamFadeTimeline('row:final', true), timeline, 'found again while streaming');
  assert.equal(streamFadeTimeline('row:final', false), null);
  assert.equal(streamFadeTimeline('row:never-streamed', false), null);
});

const element = (tagName, children = [], properties = {}) => ({ type: 'element', tagName, properties, children });

test("a list item's marker fades with its first word; the words still fade themselves", () => {
  const timeline = new StreamFadeTimeline();
  const root = { type: 'root', children: [element('ul', [element('li', [text('Runtime drives')])])] };
  const out = applyStreamFade(root, 'c0', timeline, 300).root;
  const li = out.children[0].children[0];
  assert.equal(li.properties.dataStreamFadeBox, 'marker');
  assert.equal(li.properties.dataFadeAt, 300);
  assert.equal(wrapped(out).length, 2);
  // Once its first word finished fading, the item is plain again.
  const later = applyStreamFade(root, 'c0', timeline, 300 + STREAM_FADE_DURATION_MS).root;
  assert.equal(later.children[0].children[0].properties.dataStreamFadeBox, undefined);
});

test('a table row fades whole with its words; later words fade on their own', () => {
  const timeline = new StreamFadeTimeline();
  const row = (...cells) =>
    element(
      'tr',
      cells.map((cell) => element('td', [text(cell)]))
    );
  const first = { type: 'root', children: [element('table', [element('tbody', [row('Runtime', 'JS')])])] };
  const out = applyStreamFade(first, 'c0', timeline, 100).root;
  const tr = out.children[0].children[0].children[0];
  assert.equal(tr.properties.dataStreamFadeBox, 'box');
  assert.equal(tr.properties.dataFadeAt, 100);
  assert.deepEqual(wrapped(out), [], 'words fading with their row are not faded twice');
  const grown = {
    type: 'root',
    children: [element('table', [element('tbody', [row('Runtime', 'JS'), row('TUI', 'JS')])])],
  };
  const next = applyStreamFade(grown, 'c0', timeline, 200).root;
  const rows = next.children[0].children[0].children;
  assert.equal(rows[0].properties.dataFadeAt, 100);
  assert.equal(rows[1].properties.dataFadeAt, 200);
  assert.deepEqual(wrapped(next), []);
});

test('an inline code chip fades as one word with its box; code blocks stay whole', () => {
  const timeline = new StreamFadeTimeline();
  const root = {
    type: 'root',
    children: [
      element('p', [text('Run '), element('code', [text('npm install')])]),
      element('pre', [element('code', [text('const a = 1;')])]),
      element('hr'),
    ],
  };
  const out = applyStreamFade(root, 'c0', timeline, 40).root;
  const chip = out.children[0].children[1];
  assert.equal(chip.properties.dataStreamFadeBox, 'box');
  assert.equal(chip.properties.dataFadeAt, 40);
  assert.equal(chip.children[0].value, 'npm install');
  assert.equal(out.children[1], root.children[1]);
  assert.equal(out.children[2].properties.dataStreamFadeBox, 'box');
  assert.deepEqual(
    wrapped(out).map((word) => word.text),
    ['Run ']
  );
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
  assert.equal(next[1].at, 20);
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
