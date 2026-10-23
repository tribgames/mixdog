import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyStreamFade,
  dropStreamFadeTimeline,
  STREAM_FADE_CHUNK_OPEN_MS,
  STREAM_FADE_DURATION_MS,
  STREAM_FADE_FAST_CHARS_PER_MS,
  STREAM_FADE_SETTLE_FADE_MS,
  STREAM_FADE_SETTLE_MS,
  StreamFadeTimeline,
  settledStreamFade,
  settleStreamFades,
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

test('the fade: 400 ms linear phrases of at least 100 ms; settle ends fades within 120 ms, unwraps by 700 ms', () => {
  assert.equal(STREAM_FADE_DURATION_MS, 400);
  assert.equal(STREAM_FADE_CHUNK_OPEN_MS, 100);
  assert.equal(STREAM_FADE_FAST_CHARS_PER_MS, 1.6);
  assert.equal(STREAM_FADE_SETTLE_FADE_MS, 120);
  assert.equal(STREAM_FADE_SETTLE_MS, 700);
});

test('a large step fades as one phrase in one element: it starts now, with no stagger, over 400 ms', () => {
  assert.deepEqual(streamFadeWords('Hello, big world!'), ['Hello, ', 'big ', 'world!']);
  const timeline = new StreamFadeTimeline(0);
  const out = wrapped(applyStreamFade(paragraph(text(fours(100))), 'c0', timeline, 1000).root);
  assert.deepEqual(
    out.map((phrase) => [phrase.text, phrase.at, phrase.ms]),
    [[fours(100), 1000, 400]]
  );
  // Another chunk of the same pass shares the phrase; re-renders reschedule nothing.
  const two = wrapped(applyStreamFade(paragraph(text(fours(3))), 'c1', timeline, 1000).root);
  assert.deepEqual(
    two.map((phrase) => phrase.at),
    [1000]
  );
  const again = wrapped(applyStreamFade(paragraph(text(fours(100))), 'c0', timeline, 1090).root);
  assert.deepEqual(again, out);
});

test('text revealed within 100 ms shares one phrase; the next growth after that opens the next', () => {
  const timeline = new StreamFadeTimeline(0);
  timeline.sync('One ', 0);
  applyStreamFade(paragraph(text('One ')), 'c0', timeline, 0);
  timeline.sync('One two ', 50);
  applyStreamFade(paragraph(text('One two ')), 'c0', timeline, 50);
  timeline.sync('One two thr', 99);
  applyStreamFade(paragraph(text('One two thr')), 'c0', timeline, 99);
  timeline.sync('One two three four ', 120);
  const out = wrapped(applyStreamFade(paragraph(text('One two three four ')), 'c0', timeline, 120).root);
  // "two" and "thr" joined the phrase opened at 0, "thr" growing into "three"
  // stays in it; 120 ms on, "four" starts a new one, at once.
  assert.deepEqual(
    out.map((phrase) => [phrase.text, phrase.at]),
    [
      ['One two three ', 0],
      ['four ', 120],
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
    [['Hello wor', 0]]
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
    [['again', 900]],
    'the settled words unwrapped; the new one fades'
  );
});

test('a rewrite shows every word unwrapped', () => {
  const timeline = new StreamFadeTimeline(0);
  timeline.sync('Hello there', 0);
  assert.equal(wrapped(applyStreamFade(paragraph(text('Hello there')), 'c0', timeline, 0).root).length, 1);
  timeline.sync('Bye', 10);
  assert.deepEqual(wrapped(applyStreamFade(paragraph(text('Hello there')), 'c0', timeline, 10).root), []);
});

test('sync takes a rewrite from the reveal; a step never rescans the shown prefix', () => {
  const timeline = new StreamFadeTimeline(0);
  const shown = 'Hello there, my good friend';
  const render = (value, now) => wrapped(applyStreamFade(paragraph(text(value)), 'c0', timeline, now).root);
  timeline.sync(shown, 0, 0);
  assert.equal(render(shown, 0)[0].text, shown);
  // The text grew and its end is where it was: an append, whatever lies before.
  timeline.sync('Jello there, my good friend again', 10, 0);
  assert.equal(render(shown, 10)[0]?.text, shown, 'still fading');
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
  assert.equal(li.properties.dataFadeAt, 300);
  assert.deepEqual(
    wrapped(out).map((phrase) => phrase.text),
    ['Runtime drives'],
    'its words fade themselves'
  );
  timeline.sync('Runtime drives more', 700);
  const later = applyStreamFade(root, 'c0', timeline, 700).root;
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
  assert.equal(tr.properties.dataFadeAt, 100);
  assert.deepEqual(wrapped(out), [], '"JS" fades with its row');
  timeline.sync('Runtime JS TUI JS', 250);
  const grown = {
    type: 'root',
    children: [element('table', [element('tbody', [row('Runtime', 'JS'), row('TUI', 'JS')])])],
  };
  const rows = applyStreamFade(grown, 'c0', timeline, 250).root.children[0].children[0].children;
  assert.equal(rows[0].properties.dataFadeAt, 100, 'still fading');
  assert.equal(rows[1].properties.dataFadeAt, 250);
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
  assert.equal(chip.properties.dataFadeAt, 40);
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
  timeline.sync('One two. ', 0);
  applyStreamFade(paragraph(text('One two. ')), 'chunk-0', timeline, 0);
  timeline.sync('One two. Three', 200);
  const tail = wrapped(applyStreamFade(paragraph(text('One two. Three')), 'chunk-0', timeline, 200).root);
  assert.deepEqual(
    tail.map((phrase) => [phrase.text, phrase.at]),
    [
      ['One two. ', 0],
      ['Three', 200],
    ]
  );
  applyStreamFade(paragraph(text('One two.')), 'chunk-0', timeline, 220);
  const next = wrapped(applyStreamFade(paragraph(text('Three four')), 'chunk-9', timeline, 220).root);
  // "Three" keeps its element and start; "four" joins its open phrase.
  assert.deepEqual(next, [{ ...tail[1], text: 'Three four' }]);
});

test('settle: running phrases end within 120 ms from their progress; the rest fades as one 120 ms phrase', () => {
  const timeline = new StreamFadeTimeline(0);
  timeline.sync('Old words here ', 0);
  applyStreamFade(paragraph(text('Old words here ')), 'c0', timeline, 0);
  // The settled render, then its commit.
  timeline.sync('Old words here and the tail', 100, 0, true);
  const out = wrapped(applyStreamFade(paragraph(text('Old words here and the tail')), 'c0', timeline, 100).root);
  timeline.settle(100);
  assert.deepEqual(
    out.map((phrase) => [phrase.text, phrase.at, phrase.ms]),
    [
      ['Old words here ', 0, 400],
      ['and the tail', 100, 120],
    ]
  );
  const [old] = applyStreamFade(paragraph(text('Old words here ')), 'c0', timeline, 100).root.children[0].children;
  assert.equal(old.properties.dataFadeSettle, 100, 'marked settled');
  // An element created for it later runs the rest of its fade, ending 120 ms
  // after the settle, from the progress it had then (a quarter).
  const placed = settledStreamFade(0, 400, 100);
  assert.equal(placed.at + placed.ms, 100 + STREAM_FADE_SETTLE_FADE_MS);
  assert.equal((100 - placed.at) / placed.ms, 0.25);
  assert.deepEqual(settledStreamFade(0, 400), { at: 0, ms: 400 }, 'unsettled: unchanged');
  // A phrase that ends within 120 ms anyway is left alone.
  const late = new StreamFadeTimeline(0);
  applyStreamFade(paragraph(text('nearly done')), 'c0', late, 0);
  late.settle(300);
  const [nearly] = wrapped(applyStreamFade(paragraph(text('nearly done')), 'c0', late, 300).root);
  assert.equal(nearly.ms, 400);
  const nearlyNode = applyStreamFade(paragraph(text('nearly done')), 'c0', late, 300).root.children[0].children[0];
  assert.equal(nearlyNode.properties.dataFadeSettle, undefined);
});

test('a settled render that never commits leaves no settled state: streaming phrases stay 400 ms', () => {
  const timeline = new StreamFadeTimeline(0);
  timeline.sync('Hi ', 0);
  applyStreamFade(paragraph(text('Hi ')), 'c0', timeline, 0);
  // Discarded: it rendered settled, but settle() (its commit) never ran.
  timeline.sync('Hi there', 50, 0, true);
  applyStreamFade(paragraph(text('Hi there')), 'c0', timeline, 50);
  timeline.sync('Hi there friend', 200);
  const out = wrapped(applyStreamFade(paragraph(text('Hi there friend')), 'c0', timeline, 200).root);
  assert.deepEqual(out.map((phrase) => [phrase.text, phrase.ms]).at(-1), ['friend', 400]);
  assert.ok(
    out.every((phrase) => phrase.ms === 400 || phrase.text === 'there '),
    'only the discarded pass phrase is short'
  );
  const [first] = applyStreamFade(paragraph(text('Hi ')), 'c0', timeline, 200).root.children[0].children;
  assert.equal(first.properties.dataFadeSettle, undefined, 'nothing marked settled');
});

test('settle speeds up the running fade animations on screen to end within 120 ms, keeping their progress', () => {
  const animation = (animationName, currentTime, endTime, playbackRate = 1) => ({
    animationName,
    currentTime,
    playbackRate,
    effect: { getComputedTiming: () => ({ endTime }) },
    rates: [],
    updatePlaybackRate(rate) {
      this.rates.push(rate);
    },
  });
  const running = animation('markdown-stream-fade', 100, 400);
  const marker = animation('markdown-stream-fade-marker', 0, 400);
  const nearlyDone = animation('markdown-stream-fade', 300, 400);
  const other = animation('composer-slide', 0, 1000);
  let options;
  settleStreamFades({
    getAnimations(given) {
      options = given;
      return [running, marker, nearlyDone, other];
    },
  });
  assert.deepEqual(options, { subtree: true });
  assert.deepEqual(running.rates, [300 / 120], '300 ms left run in 120');
  assert.deepEqual(marker.rates, [400 / 120]);
  assert.deepEqual(nearlyDone.rates, [], '100 ms left: untouched');
  assert.deepEqual(other.rates, [], 'not a fade');
});

test('reduced motion: a reply gets no timeline, so nothing fades', () => {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({ matches: /reduce/.test(query) });
  try {
    assert.equal(streamFadeTimeline('row:reduced', true), null);
  } finally {
    globalThis.matchMedia = original;
  }
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
