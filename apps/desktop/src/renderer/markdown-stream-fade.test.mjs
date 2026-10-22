import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyStreamFade,
  dropStreamFadeTimeline,
  STREAM_FADE_AHEAD_MAX_MS,
  STREAM_FADE_CHUNK_CHARS,
  STREAM_FADE_CHUNK_OPEN_MS,
  STREAM_FADE_DURATION_MS,
  STREAM_FADE_FAST_CHARS_PER_MS,
  STREAM_FADE_MS_PER_CHAR,
  STREAM_FADE_PASS_CHUNK_CHARS,
  STREAM_FADE_SETTLE_MS,
  StreamFadeTimeline,
  streamFadeTimeline,
  streamFadeWords,
} from './markdown-stream-fade.ts';

const paragraph = (...children) => ({
  type: 'root',
  children: [{ type: 'element', tagName: 'p', properties: {}, children }],
});
const text = (value) => ({ type: 'text', value });
const element = (tagName, children = [], properties = {}) => ({ type: 'element', tagName, properties, children });

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

/** `count` words of four characters ("w00 "). */
const fours = (count) => Array.from({ length: count }, (_, index) => `w${String(index).padStart(2, '0')} `).join('');

test('the fade: 200 ms linear, chained 2.5 ms per character up to 600 ms ahead, chunks of 16/48 characters', () => {
  assert.equal(STREAM_FADE_DURATION_MS, 200);
  assert.equal(STREAM_FADE_MS_PER_CHAR, 2.5);
  assert.equal(STREAM_FADE_AHEAD_MAX_MS, 600);
  assert.equal(STREAM_FADE_PASS_CHUNK_CHARS, 16);
  assert.equal(STREAM_FADE_CHUNK_CHARS, 48);
  assert.equal(STREAM_FADE_CHUNK_OPEN_MS, 100);
  assert.equal(STREAM_FADE_FAST_CHARS_PER_MS, 1.6);
  assert.equal(STREAM_FADE_SETTLE_MS, 1000);
});

test('words of one pass share a chunk up to 16 characters; each chunk starts 2.5 ms per character later', () => {
  assert.deepEqual(streamFadeWords('Hello, big world!'), ['Hello, ', 'big ', 'world!']);
  const timeline = new StreamFadeTimeline(0);
  const out = wrapped(applyStreamFade(paragraph(text(fours(10))), 'c0', timeline, 1000).root);
  assert.equal(out.length, 10);
  // Four words of four characters fill a chunk; the chain moves 10 ms a word.
  assert.deepEqual(
    out.map((word) => word.at),
    [1010, 1010, 1010, 1010, 1050, 1050, 1050, 1050, 1090, 1090]
  );
  assert.deepEqual(new Set(out.map((word) => word.ms)), new Set([200]));
  assert.equal(new Set(out.map((word) => word.tag)).size, 10, 'every word has its own element');
});

test('the chain never runs more than 600 ms ahead; re-renders reschedule nothing', () => {
  const timeline = new StreamFadeTimeline(0);
  const words = fours(100);
  const one = wrapped(applyStreamFade(paragraph(text(words)), 'c0', timeline, 1000).root);
  const two = wrapped(applyStreamFade(paragraph(text(words)), 'c1', timeline, 1000).root);
  const starts = [...one, ...two].map((word) => word.at);
  assert.ok(
    starts.every((at, index) => index === 0 || at >= starts[index - 1]),
    'top to bottom, across chunks'
  );
  assert.equal(Math.max(...starts), 1600, 'capped 600 ms ahead');
  const again = wrapped(applyStreamFade(paragraph(text(words)), 'c0', timeline, 1100).root);
  assert.deepEqual(
    again.map((word) => word.at),
    one.map((word) => word.at)
  );
});

test('across passes a chunk takes up to 48 characters; it closes after 100 ms when a new word starts', () => {
  const timeline = new StreamFadeTimeline(0);
  timeline.sync('One ', 0);
  applyStreamFade(paragraph(text('One ')), 'c0', timeline, 0);
  timeline.sync('One two ', 50);
  applyStreamFade(paragraph(text('One two ')), 'c0', timeline, 50);
  timeline.sync('One two three ', 120);
  const out = wrapped(applyStreamFade(paragraph(text('One two three ')), 'c0', timeline, 120).root);
  // "two" joined the open chunk of the pass before; 120 ms on, "three" starts
  // a new one: 6 characters after the chain's last start (20) or now.
  assert.deepEqual(
    out.map((word) => [word.text, word.at]),
    [
      ['One ', 10],
      ['two ', 10],
      ['three ', 135],
    ]
  );
});

test('arrivals faster than 1.6 characters per ms over two windows show unfaded, until 400 ms after', () => {
  const timeline = new StreamFadeTimeline(0);
  timeline.sync('x'.repeat(200), 100);
  timeline.sync('x'.repeat(400), 200);
  assert.deepEqual(wrapped(applyStreamFade(paragraph(text('fast words')), 'c0', timeline, 200).root), []);
  timeline.sync(`${'x'.repeat(400)} y`, 300);
  assert.deepEqual(
    wrapped(applyStreamFade(paragraph(text('fast words still')), 'c0', timeline, 300).root),
    [],
    'within 400 ms of the last fast window'
  );
  timeline.sync(`${'x'.repeat(400)} y z`, 700);
  assert.deepEqual(
    wrapped(applyStreamFade(paragraph(text('fast words still slow')), 'c0', timeline, 700).root).map(
      (word) => word.text
    ),
    ['slow']
  );
});

test('a word is unwrapped once a later close finds its fade ended; until then its element stays', () => {
  const timeline = new StreamFadeTimeline(0);
  timeline.sync('Hello wor', 0);
  const first = wrapped(applyStreamFade(paragraph(text('Hello wor')), 'c0', timeline, 0).root);
  assert.deepEqual(
    first.map((word) => [word.text, word.at]),
    [
      ['Hello ', 15],
      ['wor', 15],
    ]
  );
  // "wor" grew into "world" in place: the same word, the same element.
  timeline.sync('Hello world', 40);
  const grown = wrapped(applyStreamFade(paragraph(text('Hello world')), 'c0', timeline, 40).root);
  assert.deepEqual(
    grown.map((word) => word.tag),
    first.map((word) => word.tag)
  );
  // Past its fade but with no close since: still wrapped (no DOM change).
  const ended = wrapped(applyStreamFade(paragraph(text('Hello world')), 'c0', timeline, 900).root);
  assert.deepEqual(
    ended.map((word) => word.tag),
    first.map((word) => word.tag)
  );
  timeline.sync('Hello world again', 900);
  const later = wrapped(applyStreamFade(paragraph(text('Hello world again')), 'c0', timeline, 900).root);
  assert.deepEqual(
    later.map((word) => [word.text, word.at]),
    [['again', 913]],
    'the settled words unwrapped; the new one fades'
  );
});

test('a rewrite shows every word unwrapped', () => {
  const timeline = new StreamFadeTimeline(0);
  timeline.sync('Hello there', 0);
  assert.equal(wrapped(applyStreamFade(paragraph(text('Hello there')), 'c0', timeline, 0).root).length, 2);
  timeline.sync('Bye', 10);
  assert.deepEqual(wrapped(applyStreamFade(paragraph(text('Hello there')), 'c0', timeline, 10).root), []);
});

test('sync takes a rewrite from the reveal; a step never rescans the shown prefix', () => {
  const timeline = new StreamFadeTimeline(0);
  const shown = 'Hello there, my good friend';
  const render = (value, now) => wrapped(applyStreamFade(paragraph(text(value)), 'c0', timeline, now).root);
  timeline.sync(shown, 0, 0);
  assert.equal(render(shown, 0).length, 5);
  // The text grew and its end is where it was: an append, whatever lies before.
  timeline.sync('Jello there, my good friend again', 10, 0);
  assert.equal(render(shown, 10).length, 5, 'still fading');
  // The reveal names a rewrite: everything shows unfaded.
  timeline.sync('Jello there, my good friend again', 20, 7);
  assert.deepEqual(render(shown, 20), []);
  // The same revision again is no new rewrite: a new word still fades.
  timeline.sync('Jello there, my good friend again more', 30, 7);
  assert.deepEqual(
    render(`${shown} more`, 30).map((word) => word.text),
    ['more']
  );
});

test('a reply keeps its timeline after it stops streaming, until dropped', () => {
  const timeline = streamFadeTimeline('row:final', true);
  assert.ok(timeline);
  assert.equal(streamFadeTimeline('row:final', true), timeline, 'found again while streaming');
  assert.equal(streamFadeTimeline('row:final', false), timeline, 'kept while it settles');
  assert.equal(timeline.durationMs, STREAM_FADE_DURATION_MS, 'what it shows meanwhile still fades');
  dropStreamFadeTimeline('row:final');
  assert.equal(streamFadeTimeline('row:final', false), null, 'settled: nothing wraps');
  assert.equal(streamFadeTimeline('row:never-streamed', false), null);
});

test('a word that grows keeps its one fade; a duration of 0 wraps nothing', () => {
  const timeline = streamFadeTimeline('row:grow', true);
  const first = wrapped(applyStreamFade(paragraph(text('Checking the lay')), 'c0', timeline, 0).root);
  const out = wrapped(applyStreamFade(paragraph(text('Checking the layout')), 'c0', timeline, 50).root);
  assert.deepEqual(
    out.map((word) => [word.tag, word.at]),
    first.map((word) => [word.tag, word.at])
  );
  const unfaded = new StreamFadeTimeline(0);
  unfaded.durationMs = 0;
  assert.deepEqual(wrapped(applyStreamFade(paragraph(text('fast words')), 'c0', unfaded, 0).root), []);
});

test("a list item's marker fades with its first word; once settled the item drops its box", () => {
  const timeline = new StreamFadeTimeline(0);
  const root = { type: 'root', children: [element('ul', [element('li', [text('Runtime drives')])])] };
  timeline.sync('Runtime drives', 300);
  const out = applyStreamFade(root, 'c0', timeline, 300).root;
  const li = out.children[0].children[0];
  assert.equal(li.properties.dataStreamFadeBox, 'marker');
  assert.equal(li.properties.dataFadeAt, 320);
  assert.equal(wrapped(out).length, 2, 'its words fade themselves');
  timeline.sync('Runtime drives more', 600);
  const later = applyStreamFade(root, 'c0', timeline, 600).root;
  assert.equal(later.children[0].children[0].properties.dataStreamFadeBox, undefined);
  assert.deepEqual(wrapped(later), []);
});

test('a table row fades whole with its first word; words of the same chunk are not faded twice', () => {
  const timeline = new StreamFadeTimeline(0);
  const row = (...cells) =>
    element(
      'tr',
      cells.map((cell) => element('td', [text(cell)]))
    );
  timeline.sync('Runtime JS', 100);
  const first = { type: 'root', children: [element('table', [element('tbody', [row('Runtime', 'JS')])])] };
  const out = applyStreamFade(first, 'c0', timeline, 100).root;
  const tr = out.children[0].children[0].children[0];
  assert.equal(tr.properties.dataStreamFadeBox, 'box');
  assert.equal(tr.properties.dataFadeAt, 118);
  assert.deepEqual(wrapped(out), [], '"JS" fades with its row');
  timeline.sync('Runtime JS TUI JS', 250);
  const grown = {
    type: 'root',
    children: [element('table', [element('tbody', [row('Runtime', 'JS'), row('TUI', 'JS')])])],
  };
  const rows = applyStreamFade(grown, 'c0', timeline, 250).root.children[0].children[0].children;
  assert.equal(rows[0].properties.dataFadeAt, 118, 'still fading');
  assert.equal(rows[1].properties.dataFadeAt, 258);
});

test('an inline code chip fades as one word with its box; code blocks stay whole', () => {
  const timeline = new StreamFadeTimeline(0);
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
  assert.equal(chip.properties.dataFadeAt, 50);
  assert.equal(chip.children[0].value, 'npm install');
  assert.equal(out.children[1], root.children[1]);
  assert.equal(out.children[2].properties.dataStreamFadeBox, 'box');
  assert.deepEqual(
    wrapped(out).map((word) => word.text),
    ['Run ']
  );
});

test('a re-parse into new elements keeps word identity', () => {
  const timeline = new StreamFadeTimeline(0);
  const before = wrapped(applyStreamFade(paragraph(text('a b')), 'c0', timeline, 0).root);
  const strong = { type: 'element', tagName: 'strong', properties: {}, children: [text('b')] };
  const after = wrapped(applyStreamFade(paragraph(text('a '), strong), 'c0', timeline, 10).root);
  assert.equal(after[0].tag, before[0].tag);
  assert.equal(after.length, 2);
});

test('a new chunk inherits the words cut off the chunk it split from', () => {
  const timeline = new StreamFadeTimeline(0);
  const tail = wrapped(applyStreamFade(paragraph(text('One two. Three')), 'chunk-0', timeline, 0).root);
  applyStreamFade(paragraph(text('One two.')), 'chunk-0', timeline, 20);
  const next = wrapped(applyStreamFade(paragraph(text('Three four')), 'chunk-9', timeline, 20).root);
  assert.equal(next[0].tag, tail[2].tag);
  assert.equal(next[0].at, tail[2].at);
  // The open chunk is full (14 + 4 > 16): "four" opens the next, 10 ms after
  // the chain's last start (35).
  assert.equal(next[1].at, 45);
});

test('blank text, math and svg are left whole', () => {
  const timeline = new StreamFadeTimeline(0);
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
