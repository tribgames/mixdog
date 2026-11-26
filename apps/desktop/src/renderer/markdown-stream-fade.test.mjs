import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMarkdownToHast } from './markdown-ast.ts';
import {
  applyStreamFade,
  dropStreamFadeTimeline,
  STREAM_FADE_DURATION_MS,
  StreamFadeTimeline,
  streamFadeTimeline,
} from './markdown-stream-fade.ts';

const paragraph = (...children) => ({
  type: 'root',
  children: [{ type: 'element', tagName: 'p', properties: {}, children }],
});
/** A text node starting at `offset` in the parsed text. */
const text = (value, offset = 0) => ({ type: 'text', value, offset });
const element = (tagName, children = [], properties = {}) => ({ type: 'element', tagName, properties, children });
const textOf = (node) => (node.type === 'text' ? node.value : (node.children ?? []).map(textOf).join(''));
const x = (count) => 'x'.repeat(count);

/** A render pass that reveals `value` at `now`, its body bringing all of it
 *  on screen, and commits. */
function show(timeline, value, now, revision = 0, ended = false) {
  const pass = timeline.read(value, now, revision, ended);
  timeline.appear(timeline.appearing(0, value.length, now), now);
  timeline.commit(pass);
  return pass;
}

/** Every fade start in `root`, wrappers and boxes, with the text it covers. */
function starts(root) {
  const found = [];
  const visit = (node) => {
    const at = node.properties?.dataFadeAt;
    if (at !== undefined) found.push([textOf(node), at]);
    if (node.tagName?.startsWith('mx-fade-')) return;
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return found;
}

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

test('a large step fades as one phrase in one element: it starts at its render, with no stagger, over 400 ms', () => {
  const timeline = new StreamFadeTimeline(0);
  show(timeline, fours(100), 1000);
  const out = wrapped(applyStreamFade(paragraph(text(fours(100))), 0, timeline, 1000).root);
  assert.deepEqual(
    out.map((phrase) => [phrase.text, phrase.at, phrase.ms]),
    [[fours(100), 1000, 400]]
  );
  // Re-renders reschedule nothing.
  const again = wrapped(applyStreamFade(paragraph(text(fours(100))), 0, timeline, 1090).root);
  assert.deepEqual(again, out);
});

test('text revealed within 100 ms shares one phrase; the next growth after that opens the next', () => {
  const timeline = new StreamFadeTimeline(0);
  show(timeline, 'One ', 0);
  show(timeline, 'One two ', 50);
  show(timeline, 'One two thr', 99);
  show(timeline, 'One two three four ', 120);
  const out = wrapped(applyStreamFade(paragraph(text('One two three four ')), 0, timeline, 120).root);
  // "two" and "thr" joined the phrase opened at 0; 120 ms on, the letters
  // "thr" grew by and "four" start a new one, at once.
  assert.deepEqual(
    out.map((phrase) => [phrase.text, phrase.at]),
    [
      ['One two thr', 0],
      ['ee four ', 120],
    ]
  );
});

test('letters that continue a word after its phrase closed fade from their own start, in Korean too', () => {
  const timeline = new StreamFadeTimeline(0);
  const render = (value, now) => {
    show(timeline, value, now);
    return wrapped(applyStreamFade(paragraph(text(value)), 0, timeline, now).root);
  };
  const first = render('스트리밍 응답이 화', 0);
  const grown = render('스트리밍 응답이 화면에 ', 150);
  assert.deepEqual(
    grown.map((phrase) => [phrase.text, phrase.at]),
    [
      ['스트리밍 응답이 화', 0],
      ['면에 ', 150],
    ]
  );
  assert.equal(grown[0].tag, first[0].tag, 'what showed keeps its element and its start');
  // Within its phrase a word grows in the same stretch.
  assert.deepEqual(
    render('스트리밍 응답이 화면에 보입', 200).map((phrase) => phrase.text),
    ['스트리밍 응답이 화', '면에 보입']
  );
  assert.deepEqual(
    render('스트리밍 응답이 화면에 보입니다', 230).map((phrase) => phrase.text),
    ['스트리밍 응답이 화', '면에 보입니다']
  );
});

test('a character that moves to another segment keeps its fade: 研究生 → 研究生命, 中国人 → 中国人民', () => {
  for (const [before, after] of [
    ['研究生', '研究生命'],
    ['中国人', '中国人民'],
  ]) {
    const timeline = new StreamFadeTimeline(0);
    show(timeline, before, 0);
    applyStreamFade(paragraph(text(before)), 0, timeline, 0);
    show(timeline, after, 150);
    assert.deepEqual(
      wrapped(applyStreamFade(paragraph(text(after)), 0, timeline, 150).root).map((phrase) => [phrase.text, phrase.at]),
      [
        [before, 0],
        [after.slice(before.length), 150],
      ],
      `${before} → ${after}: only the new character fades from now`
    );
  }
});

test('decoded text keeps exact offsets: a reference, an escape, a quote marker, a code chip', () => {
  for (const [before, after, last] of [
    ['A &amp; ', 'A &amp; X', 'X'],
    ['a \\* b', 'a \\* b c', ' c'],
    ['> one\n> two', '> one\n> two three', ' three'],
    ['`a&amp;b` ', '`a&amp;b` next', 'next'],
  ]) {
    const timeline = new StreamFadeTimeline(0);
    show(timeline, before, 0);
    show(timeline, after, 150, 0, true);
    const root = applyStreamFade(parseMarkdownToHast(after), 0, timeline, 150).root;
    assert.deepEqual(
      starts(root).filter(([, at]) => at === 150),
      [[last, 150]],
      `${JSON.stringify(after)}: exactly the new text fades from its phrase`
    );
    assert.ok(
      wrapped(root).every((run) => run.at === 150 || !run.text.includes(last.trim())),
      `${JSON.stringify(after)}: no stretch shown before holds the new text`
    );
  }
});

test('a re-parse that changes the text nodes fades nothing already shown again: a header becomes a table', () => {
  const header = '| a | b |\n';
  const table = `${header}|---|---|\n`;
  const timeline = new StreamFadeTimeline(0);
  show(timeline, header, 0);
  const before = starts(applyStreamFade(parseMarkdownToHast(header), 0, timeline, 0).root);
  assert.ok(before.length > 0, 'the header fades in as a paragraph');
  assert.ok(before.every(([, at]) => at === 0));
  show(timeline, table, 150);
  const after = starts(applyStreamFade(parseMarkdownToHast(table), 0, timeline, 150).root);
  assert.ok(after.length > 0, 'parsed into a table, it goes on fading from when it showed');
  assert.deepEqual(
    after.filter(([, at]) => at !== 0),
    [],
    'no character shown at 0 fades again'
  );
});

test('arrivals faster than 1.6 characters per ms over two windows show unfaded, until 400 ms after', () => {
  const timeline = new StreamFadeTimeline(0);
  const render = (value, now) => {
    show(timeline, value, now);
    return wrapped(applyStreamFade(paragraph(text(value)), 0, timeline, now).root).map((run) => [run.text, run.at]);
  };
  // The first window is not yet a run of fast ones: it fades.
  assert.deepEqual(render(x(200), 100), [[x(200), 100]]);
  assert.deepEqual(render(x(400), 200), [[x(200), 100]], 'the second fast window shows unfaded');
  assert.deepEqual(render(`${x(400)} y`, 300), [[x(200), 100]], 'within 400 ms of the last fast window');
  assert.deepEqual(render(`${x(400)} y z`, 700), [[' z', 700]]);
});

test('a phrase is unwrapped once its fade ended; until then its element stays', () => {
  const timeline = new StreamFadeTimeline(0);
  const render = (value, now) => wrapped(applyStreamFade(paragraph(text(value)), 0, timeline, now).root);
  show(timeline, 'Hello wor', 0);
  const first = render('Hello wor', 0);
  assert.deepEqual(
    first.map((run) => [run.text, run.at]),
    [['Hello wor', 0]]
  );
  // "wor" grew into "world" within the phrase: the same element.
  show(timeline, 'Hello world', 40);
  assert.deepEqual(
    render('Hello world', 40).map((run) => [run.tag, run.text]),
    [[first[0].tag, 'Hello world']]
  );
  assert.equal(render('Hello world', 399).length, 1, 'fading: wrapped');
  assert.deepEqual(render('Hello world', 400), [], 'its fade ended: unwrapped, with or without new text');
  show(timeline, 'Hello world again', 900);
  assert.deepEqual(
    render('Hello world again', 900).map((run) => [run.text, run.at]),
    [[' again', 900]]
  );
});

test('a rewrite shows unwrapped', () => {
  const timeline = new StreamFadeTimeline(0);
  show(timeline, 'Hello there', 0);
  assert.equal(wrapped(applyStreamFade(paragraph(text('Hello there')), 0, timeline, 0).root).length, 1);
  show(timeline, 'Bye', 10);
  assert.deepEqual(wrapped(applyStreamFade(paragraph(text('Bye')), 0, timeline, 10).root), []);
});

test('text a revision of the reveal brings shows unfaded; a step never rescans the shown prefix', () => {
  const timeline = new StreamFadeTimeline(0);
  const render = (value, now) =>
    wrapped(applyStreamFade(paragraph(text(value)), 0, timeline, now).root).map((run) => [run.text, run.at]);
  const first = 'Hello there, my good friend';
  show(timeline, first, 0, 0);
  assert.deepEqual(render(first, 0), [[first, 0]]);
  // The text grew and its end is where it was: an append, whatever lies before.
  const grown = `J${first.slice(1)} again`;
  show(timeline, grown, 10, 0);
  assert.deepEqual(render(grown, 10), [[grown, 0]], 'still fading, in its phrase');
  // The reveal names a revision: what it brings shows unfaded; what is on
  // screen goes on fading as it was (no jump).
  show(timeline, `${grown} later`, 200, 7);
  assert.deepEqual(render(`${grown} later`, 200), [[grown, 0]]);
  // The same revision again is none new: new text fades.
  show(timeline, `${grown} later more`, 300, 7);
  assert.deepEqual(render(`${grown} later more`, 300), [
    [grown, 0],
    [' more', 300],
  ]);
});

test('the part ending shows what had not shown as one last phrase from then, also mid-phrase and after fast arrivals', () => {
  const timeline = new StreamFadeTimeline(0);
  show(timeline, 'One ', 0);
  // 80 ms into the open phrase: the rest does not join it.
  show(timeline, 'One two three', 80, 0, true);
  assert.deepEqual(
    wrapped(applyStreamFade(paragraph(text('One two three')), 0, timeline, 80).root).map((run) => [run.text, run.at]),
    [
      ['One ', 0],
      ['two three', 80],
    ]
  );
  assert.equal(timeline.fadesUntil(80), 480);
  const fast = new StreamFadeTimeline(0);
  show(fast, x(200), 100);
  show(fast, x(400), 200);
  show(fast, `${x(400)} tail`, 250, 0, true);
  assert.deepEqual(
    wrapped(applyStreamFade(paragraph(text(`${x(400)} tail`)), 0, fast, 250).root)
      .map((run) => [run.text, run.at])
      .at(-1),
    [' tail', 250]
  );
});

test('only fading phrases are kept: a token growing over fifty phrases keeps its live ones, then none', () => {
  const timeline = new StreamFadeTimeline(0);
  let value = 'x';
  let pass = null;
  let now = 0;
  for (let index = 0; index < 50; index += 1) {
    value += 'y';
    now = index * 150;
    pass = show(timeline, value, now);
  }
  assert.ok(pass.phrases.length <= 3, `${pass.phrases.length} phrases kept`);
  const runs = wrapped(applyStreamFade(paragraph(text(value)), 0, timeline, now).root);
  assert.ok(runs.length <= 3 && runs.every((run) => run.at > now - 400));
  assert.deepEqual(wrapped(applyStreamFade(paragraph(text(value)), 0, timeline, now + 400).root), []);
  assert.equal(show(timeline, value, now + 400).phrases.length, 0, 'ended, nothing of it stays');
  assert.equal(timeline.fadesUntil(now + 400), 0);
});

test('text revealed before its parse lands fades in full from when it comes on screen, and the row is owed it until then', () => {
  const timeline = new StreamFadeTimeline(0);
  show(timeline, 'Intro ', 0);
  // The rest is revealed (the part ends) while the body still shows the
  // older parse of "Intro ".
  const pass = timeline.read('Intro and the long tail', 100, 0, true);
  const stale = applyStreamFade(paragraph(text('Intro ')), 0, timeline, 100, 6);
  timeline.appear(stale.appearance, 100);
  timeline.commit(pass);
  assert.ok(timeline.owes('Intro and the long tail'.length), 'its tail is still to show');
  // The worker's parse lands 900 ms later: the tail fades from then.
  const landed = applyStreamFade(paragraph(text('Intro and the long tail')), 0, timeline, 1000, 23);
  assert.deepEqual(
    wrapped(landed.root).map((run) => [run.text, run.at, run.ms]),
    [['and the long tail', 1000, 400]]
  );
  timeline.appear(landed.appearance, 1000);
  assert.equal(timeline.owes(23), false);
  assert.equal(timeline.fadesUntil(1000), 1400);
});

test('what has been on screen is kept as ranges: a later chunk showing first leaves the earlier one owed, and it fades when it shows', () => {
  const timeline = new StreamFadeTimeline(0);
  const pass = timeline.read('Intro text', 0);
  // The later chunk [6, 10) shows; the earlier one [0, 6) is still parsing.
  const later = applyStreamFade(paragraph(text('text')), 6, timeline, 0, 10);
  timeline.appear(later.appearance, 0);
  timeline.commit(pass);
  assert.equal(timeline.owes(10), true, 'the earlier chunk is still to show');
  const earlier = timeline.appearing(0, 6, 300);
  assert.deepEqual(
    earlier.stretches.map((stretch) => [stretch.from, stretch.to, stretch.at]),
    [[0, 6, 300]],
    'it fades from when it shows'
  );
  timeline.appear(earlier, 300);
  assert.equal(timeline.owes(10), false);
  assert.deepEqual(
    wrapped(applyStreamFade(paragraph(text('Intro ')), 0, timeline, 300, 6).root).map((run) => [run.text, run.at]),
    [['Intro ', 300]]
  );
});

test('text a plugin rebuilt keeps exact offsets: **0.118%**이며 fades only its new suffix', () => {
  const before = '값은 **0.118%**이';
  const after = '값은 **0.118%**이며';
  const timeline = new StreamFadeTimeline(0);
  show(timeline, before, 0);
  show(timeline, after, 150);
  const root = applyStreamFade(parseMarkdownToHast(after), 0, timeline, 150).root;
  assert.ok(JSON.stringify(root).includes('"strong"'), 'the repair made it strong');
  assert.deepEqual(
    wrapped(root).map((run) => [run.text, run.at]),
    [
      ['값은 ', 0],
      ['0.118%', 0],
      ['이', 0],
      ['며', 150],
    ]
  );
});

test('a reply keeps its timeline after it stops streaming, until dropped', () => {
  const timeline = streamFadeTimeline('row:final', true);
  assert.ok(timeline);
  assert.equal(streamFadeTimeline('row:final', true), timeline, 'found again while streaming');
  assert.equal(streamFadeTimeline('row:final', false), timeline, 'kept while its fades run');
  assert.equal(timeline.durationMs, STREAM_FADE_DURATION_MS, 'what it shows meanwhile still fades');
  dropStreamFadeTimeline('row:final');
  assert.equal(streamFadeTimeline('row:final', false), null, 'settled: nothing wraps');
  assert.equal(streamFadeTimeline('row:never-streamed', false), null);
});

test('a duration of 0 wraps nothing', () => {
  const unfaded = new StreamFadeTimeline(0);
  unfaded.durationMs = 0;
  show(unfaded, 'fast words', 0);
  assert.deepEqual(wrapped(applyStreamFade(paragraph(text('fast words')), 0, unfaded, 0).root), []);
});

test('a render React discards changes nothing: text past the committed pass is read from the latest one', () => {
  const timeline = new StreamFadeTimeline(0);
  show(timeline, 'One ', 0);
  // Read but never committed (a discarded render), then read again later.
  timeline.read('One two', 150);
  const pass = timeline.read('One two', 300);
  timeline.commit(pass);
  assert.deepEqual(
    wrapped(applyStreamFade(paragraph(text('One two')), 0, timeline, 300).root).map((run) => [run.text, run.at]),
    [
      ['One ', 0],
      ['two', 300],
    ],
    'the new text fades from the render that committed'
  );
});

test("a list item's marker fades with its first character; once its fade ended the item drops its box", () => {
  const timeline = new StreamFadeTimeline(0);
  const root = { type: 'root', children: [element('ul', [element('li', [text('Runtime drives')])])] };
  show(timeline, 'Runtime drives', 300);
  const out = applyStreamFade(root, 0, timeline, 300).root;
  const li = out.children[0].children[0];
  assert.equal(li.properties.dataStreamFadeBox, 'marker');
  assert.equal(li.properties.dataFadeAt, 300);
  assert.deepEqual(
    wrapped(out).map((phrase) => phrase.text),
    ['Runtime drives'],
    'its text fades itself'
  );
  show(timeline, 'Runtime drives more', 700);
  const later = applyStreamFade(root, 0, timeline, 700).root;
  assert.equal(later.children[0].children[0].properties.dataStreamFadeBox, undefined);
  assert.deepEqual(wrapped(later), []);
});

test('a table row fades whole with its first character; text of the row is not faded twice', () => {
  const timeline = new StreamFadeTimeline(0);
  // Cells at their offsets in "Runtime JS TUI JS".
  const row = (...cells) =>
    element(
      'tr',
      cells.map(([cell, offset]) => element('td', [text(cell, offset)]))
    );
  show(timeline, 'Runtime JS', 100);
  const first = {
    type: 'root',
    children: [element('table', [element('tbody', [row(['Runtime', 0], ['JS', 8])])])],
  };
  const out = applyStreamFade(first, 0, timeline, 100).root;
  const tr = out.children[0].children[0].children[0];
  assert.equal(tr.properties.dataStreamFadeBox, 'box');
  assert.equal(tr.properties.dataFadeAt, 100);
  assert.deepEqual(wrapped(out), [], '"JS" fades with its row');
  show(timeline, 'Runtime JS TUI JS', 250);
  const grown = {
    type: 'root',
    children: [element('table', [element('tbody', [row(['Runtime', 0], ['JS', 8]), row(['TUI', 11], ['JS', 15])])])],
  };
  const rows = applyStreamFade(grown, 0, timeline, 250).root.children[0].children[0].children;
  assert.equal(rows[0].properties.dataFadeAt, 100, 'still fading');
  assert.equal(rows[1].properties.dataFadeAt, 250);
});

test('an inline code chip fades as one with its box; code blocks stay whole', () => {
  const timeline = new StreamFadeTimeline(0);
  const root = {
    type: 'root',
    children: [
      element('p', [text('Run '), element('code', [text('npm install')])]),
      element('pre', [element('code', [text('const a = 1;')])]),
      element('hr'),
    ],
  };
  show(timeline, 'Run npm install\n---', 40);
  const out = applyStreamFade(root, 0, timeline, 40).root;
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

test('a re-parse into new elements keeps each stretch its element', () => {
  const timeline = new StreamFadeTimeline(0);
  show(timeline, 'a b', 0);
  const before = wrapped(applyStreamFade(paragraph(text('a b')), 0, timeline, 0).root);
  const strong = { type: 'element', tagName: 'strong', properties: {}, children: [text('b', 2)] };
  const after = wrapped(applyStreamFade(paragraph(text('a ', 0), strong), 0, timeline, 10).root);
  assert.equal(after[0].tag, before[0].tag);
  assert.deepEqual(
    after.map((run) => [run.text, run.at]),
    [
      ['a ', 0],
      ['b', 0],
    ]
  );
});

test('a chunk split off the reply keeps its characters’ fades: chunks are placed by offset', () => {
  const timeline = new StreamFadeTimeline(0);
  show(timeline, 'One two. ', 0);
  show(timeline, 'One two. Three', 200);
  show(timeline, 'One two. Three four', 220);
  const runs = (value, base) =>
    wrapped(applyStreamFade(paragraph(text(value)), base, timeline, 220).root).map((run) => [run.text, run.at]);
  assert.deepEqual(runs('One two.', 0), [['One two.', 0]]);
  // "four" joined the phrase "Three" opened.
  assert.deepEqual(runs('Three four', 9), [['Three four', 200]]);
});

test('the fades of a reply end with its latest phrase (fadesUntil); unfaded arrivals add none', () => {
  const timeline = new StreamFadeTimeline(0);
  assert.equal(timeline.fadesUntil(0), 0, 'nothing faded yet');
  show(timeline, 'Old words here ', 0);
  assert.equal(timeline.fadesUntil(0), 400);
  show(timeline, 'Old words here and the tail', 150);
  assert.equal(timeline.fadesUntil(150), 550);
  const out = wrapped(applyStreamFade(paragraph(text('Old words here and the tail')), 0, timeline, 150).root);
  assert.deepEqual(
    out.map((phrase) => [phrase.text, phrase.at, phrase.ms]),
    [
      ['Old words here ', 0, 400],
      ['and the tail', 150, 400],
    ],
    'every phrase runs its full fade: nothing is compressed'
  );
  const fast = new StreamFadeTimeline(0);
  show(fast, x(200), 100);
  assert.equal(fast.fadesUntil(100), 500);
  show(fast, x(400), 200);
  assert.equal(fast.fadesUntil(200), 500, 'the fast arrival added none');
});

test('a primed timeline shows its first text unfaded; text revealed after it fades', () => {
  const first = fours(40);
  const timeline = new StreamFadeTimeline(0, first);
  show(timeline, first, 0);
  assert.equal(timeline.fadesUntil(0), 0);
  assert.deepEqual(wrapped(applyStreamFade(paragraph(text(first)), 0, timeline, 0).root), [], 'shown at once, unfaded');
  // The step after it is not a fast arrival: the join is not counted as growth.
  show(timeline, `${first}next words `, 150);
  assert.deepEqual(
    wrapped(applyStreamFade(paragraph(text(`${first}next words `)), 0, timeline, 150).root).map((phrase) => [
      phrase.text,
      phrase.at,
    ]),
    [['next words ', 150]]
  );
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
  show(timeline, 'a', 0);
  const root = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'p', properties: {}, children: [text('a')] },
      text('\n'),
      { type: 'element', tagName: 'span', properties: { className: ['katex'] }, children: [text('x')] },
    ],
  };
  const out = applyStreamFade(root, 0, timeline, 0).root;
  assert.deepEqual(
    wrapped(out).map((word) => word.text),
    ['a']
  );
  assert.equal(out.children[1], root.children[1]);
  assert.equal(out.children[2], root.children[2]);
});
