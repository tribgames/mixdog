import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyStreamFade,
  STREAM_FADE_DURATION_MS,
  STREAM_FADE_STAGGER_MAX_MS,
  STREAM_FADE_STAGGER_MS_PER_CHAR,
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

test('a step staggers its words 2.5 ms per character before them, capped at 150 ms', () => {
  assert.equal(STREAM_FADE_DURATION_MS, 100);
  assert.equal(STREAM_FADE_STAGGER_MS_PER_CHAR, 2.5);
  assert.equal(STREAM_FADE_STAGGER_MAX_MS, 150);
  const timeline = new StreamFadeTimeline();
  timeline.setArrival({ at: 1000 });
  const words = Array.from({ length: 50 }, (_, index) => `w${String(index).padStart(2, '0')} `).join('');
  const out = wrapped(applyStreamFade(paragraph(text(words)), 'c0', timeline, 1000).root);
  assert.equal(out.length, 50);
  // Every word is 4 characters: word n starts 10 n ms after the first.
  assert.deepEqual(
    out.map((word) => word.at),
    out.map((_, index) => 1000 + Math.min(150, index * 4 * 2.5))
  );
  assert.deepEqual(new Set(out.map((word) => word.ms)), new Set([STREAM_FADE_DURATION_MS]));
  assert.equal(new Set(out.map((word) => word.tag)).size, 50);
  // A new arrival starts its stagger over.
  timeline.setArrival({ at: 2000 });
  const next = wrapped(applyStreamFade(paragraph(text(`${words}x1 x2 `)), 'c0', timeline, 2000).root);
  assert.deepEqual(
    next.slice(-2).map((word) => word.at),
    [2000, 2007.5]
  );
});

test('a word that grows keeps its one fade', () => {
  const timeline = streamFadeTimeline('row:grow', true);
  const first = wrapped(applyStreamFade(paragraph(text('Checking the lay')), 'c0', timeline, 0).root);
  const out = wrapped(applyStreamFade(paragraph(text('Checking the layout')), 'c0', timeline, 50).root);
  assert.deepEqual(
    out.map((word) => [word.tag, word.at]),
    first.map((word) => [word.tag, word.at]),
    '"lay" grew into "layout" in place'
  );
});

test('a step of duration 0 (a row not watched arriving) is not wrapped', () => {
  const timeline = new StreamFadeTimeline();
  timeline.durationMs = 0;
  assert.deepEqual(wrapped(applyStreamFade(paragraph(text('fast words')), 'c0', timeline, 0).root), []);
  timeline.durationMs = STREAM_FADE_DURATION_MS;
  timeline.setArrival({ at: 10 });
  const out = wrapped(applyStreamFade(paragraph(text('fast words then slow')), 'c0', timeline, 10).root);
  assert.deepEqual(
    out.map((word) => word.text),
    ['then ', 'slow']
  );
});

test('a reply that stops streaming keeps its timeline: its words keep their wrappers, nothing new fades', () => {
  const timeline = streamFadeTimeline('row:final', true);
  assert.ok(timeline);
  assert.equal(timeline.durationMs, STREAM_FADE_DURATION_MS);
  assert.equal(streamFadeTimeline('row:final', true), timeline, 'found again while streaming');
  const streamed = applyStreamFade(paragraph(text('Done now')), 'c0', timeline, 0).root;
  assert.equal(streamFadeTimeline('row:final', false), timeline, 'kept once settled');
  assert.equal(timeline.durationMs, 0);
  const settled = applyStreamFade(paragraph(text('Done now!')), 'c0', timeline, 5000).root;
  assert.deepEqual(
    wrapped(settled).map((word) => [word.tag, word.at]),
    wrapped(streamed).map((word) => [word.tag, word.at])
  );
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
  // Once its first word finished fading, the item keeps its box: no DOM change.
  const later = applyStreamFade(root, 'c0', timeline, 300 + STREAM_FADE_DURATION_MS).root;
  assert.equal(later.children[0].children[0].properties.dataStreamFadeBox, 'marker');
});

test('a table row fades whole with its first word; its later words fade in their turn', () => {
  const timeline = new StreamFadeTimeline();
  const row = (...cells) =>
    element(
      'tr',
      cells.map((cell) => element('td', [text(cell)]))
    );
  timeline.setArrival({ at: 100 });
  const first = { type: 'root', children: [element('table', [element('tbody', [row('Runtime', 'JS')])])] };
  const out = applyStreamFade(first, 'c0', timeline, 100).root;
  const tr = out.children[0].children[0].children[0];
  assert.equal(tr.properties.dataStreamFadeBox, 'box');
  assert.equal(tr.properties.dataFadeAt, 100);
  // "Runtime" fades with its row (never twice); "JS" starts 7 characters later.
  assert.deepEqual(
    wrapped(out).map((word) => [word.text, word.at]),
    [['JS', 117.5]]
  );
  const grown = {
    type: 'root',
    children: [element('table', [element('tbody', [row('Runtime', 'JS'), row('TUI', 'JS')])])],
  };
  timeline.setArrival({ at: 200 });
  const next = applyStreamFade(grown, 'c0', timeline, 200).root;
  const rows = next.children[0].children[0].children;
  assert.equal(rows[0].properties.dataFadeAt, 100);
  assert.equal(rows[1].properties.dataFadeAt, 200);
  assert.deepEqual(
    wrapped(next).map((word) => [word.text, word.at]),
    [
      ['JS', 117.5],
      ['JS', 207.5],
    ]
  );
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
  timeline.setArrival({ at: 40 });
  const out = applyStreamFade(root, 'c0', timeline, 40).root;
  const chip = out.children[0].children[1];
  assert.equal(chip.properties.dataStreamFadeBox, 'box');
  // After "Run " (4 characters).
  assert.equal(chip.properties.dataFadeAt, 50);
  assert.equal(chip.children[0].value, 'npm install');
  assert.equal(out.children[1], root.children[1]);
  assert.equal(out.children[2].properties.dataStreamFadeBox, 'box');
  assert.deepEqual(
    wrapped(out).map((word) => word.text),
    ['Run ']
  );
});

test('revealed words keep their start and their wrapper across re-renders, also after their fade', () => {
  const timeline = new StreamFadeTimeline();
  timeline.setArrival({ at: 0 });
  const first = wrapped(applyStreamFade(paragraph(text('Hello wor')), 'c0', timeline, 0).root);
  // "wor" grew into "world" in place: same word, same reveal.
  timeline.setArrival({ at: 100 });
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
    wrapped(later.root).map((word) => [word.tag, word.text]),
    second.map((word, index) => [word.tag, ['Hello ', 'world ', 'again!'][index]]),
    'a fade ending changes no element'
  );
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
  timeline.setArrival({ at: 0 });
  const tail = wrapped(applyStreamFade(paragraph(text('One two. Three')), 'chunk-0', timeline, 0).root);
  applyStreamFade(paragraph(text('One two.')), 'chunk-0', timeline, 20);
  timeline.setArrival({ at: 20 });
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

test('one step staggers across chunks, top to bottom, up to the cap; re-renders reschedule nothing', () => {
  const timeline = new StreamFadeTimeline();
  const words = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index} `).join('');
  const first = words('a', 60);
  const second = words('b', 40);
  timeline.setArrival({ at: 1000 });
  const one = wrapped(applyStreamFade(paragraph(text(first)), 'c0', timeline, 1000).root);
  const two = wrapped(applyStreamFade(paragraph(text(second)), 'c1', timeline, 1000).root);
  const starts = [...one, ...two].map((word) => word.at);
  assert.equal(starts[0], 1000, 'the first words start at once');
  assert.ok(
    starts.every((at, index) => index === 0 || at >= starts[index - 1]),
    'top to bottom, across chunks'
  );
  assert.equal(starts.at(-1), 1150, 'the last words start at the cap');
  const again = wrapped(applyStreamFade(paragraph(text(first)), 'c0', timeline, 1100).root);
  assert.deepEqual(
    again.map((word) => word.at),
    one.map((word) => word.at)
  );
});
