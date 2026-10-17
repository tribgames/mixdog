/**
 * use-paced-transcript-text.test.mjs — the live assistant playout buffer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PACER_DRAIN_MS,
  PACER_MAX_LAG_CHARS,
  PACER_MAX_RATE,
  TranscriptTextPacer,
  cleanRevealCut,
  streamingTextPaints,
} from './use-paced-transcript-text.ts';

const FRAME = 1000 / 60;
const WORDS = ['stream', 'of', 'text', 'arrives', 'unevenly,', 'then', 'settles.', 'Next'];

/** `count` characters of prose, continuing a running word sequence. */
function prose(count, offset = 0) {
  let out = '';
  for (let index = offset; out.length < count; index += 1) out += `${WORDS[index % WORDS.length]} `;
  return out.slice(0, count);
}

function play(pacer, from, until, frame = FRAME) {
  const frames = [];
  for (let now = from; now < until; now += frame) {
    const before = pacer.shown;
    pacer.tick(now);
    frames.push({ now, grew: pacer.shown - before });
  }
  return frames;
}

/** Feed `arrivals` ([time, chars]) while ticking; reveal per 100 ms bucket. */
function stream(arrivals, until, frame = FRAME) {
  const pacer = new TranscriptTextPacer();
  let text = '';
  let next = 0;
  const buckets = new Map();
  let maxFrame = 0;
  for (let now = 0; now < until; now += frame) {
    while (next < arrivals.length && arrivals[next][0] <= now) {
      text += prose(arrivals[next][1], text.length);
      pacer.push(text, now);
      next += 1;
    }
    const before = pacer.shown;
    pacer.tick(now);
    const grew = pacer.shown - before;
    maxFrame = Math.max(maxFrame, grew);
    const bucket = Math.floor(now / 100);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + grew);
  }
  return { pacer, buckets, maxFrame };
}

function steady(from, until) {
  const out = [];
  for (let at = from; at < until; at += 42) out.push([at, 4]);
  return out;
}

test('a burst is revealed over several frames, starting within the first few frames', () => {
  const pacer = new TranscriptTextPacer();
  const text = prose(120);
  pacer.push(text, 0);
  const frames = play(pacer, FRAME, FRAME * 4);
  const first = frames.find((frame) => frame.grew > 0);
  assert.ok(first && first.grew < 40, `first growth ${first?.grew}`);
  pacer.settle(1000);
  play(pacer, FRAME * 2, 1300);
  assert.equal(pacer.text, text);
});

// The commit that opens a reply row moves the followed transcript by its
// first line: that line must not stay empty while the slow start near the
// received end crawls toward the first word (measured: 100-500 ms).
test("a reply's first whole word paints with its first arrival; the rest is still paced", () => {
  const pacer = new TranscriptTextPacer('After long reply received', false, 0);
  assert.equal(pacer.text, 'After');
  pacer.tick(FRAME);
  assert.ok(pacer.text.length < 'After long reply'.length, JSON.stringify(pacer.text));
  const held = new TranscriptTextPacer();
  held.push('Aft', 0);
  assert.equal(held.text, '', 'an unfinished first word still waits');
  held.push('After long', 30);
  assert.equal(held.text, 'After', 'the arrival that completes it paints it');
});

test('streamingTextPaints matches the words a streaming pacer paints at once', () => {
  for (const text of [
    '',
    'Aft',
    '**',
    '  ',
    '**Hello',
    'x',
    '가나다',
    'a'.repeat(24),
    'After long',
    'Done.',
    'a'.repeat(25),
    '**Hi** ',
  ]) {
    assert.equal(streamingTextPaints(text), new TranscriptTextPacer(text, false, 0).text !== '', JSON.stringify(text));
  }
});

test('a steady stream reveals at its own rate with a small lag', () => {
  const { pacer, buckets } = stream(steady(0, 4000), 4000, 1000 / 165);
  const rates = [...buckets].filter(([bucket]) => bucket >= 10 && bucket < 39).map(([, grew]) => grew * 10);
  const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  assert.ok(mean > 70 && mean < 120, `mean ${mean}/s`);
  assert.ok(Math.max(...rates) < 250, `peak ${Math.max(...rates)}/s`);
  assert.ok(pacer.target.length - pacer.shown < 60, `lag ${pacer.target.length - pacer.shown}`);
});

test('a burst after a 3 s pause plays near the cap, never at hundreds of chars per second above it', () => {
  const arrivals = [...steady(0, 2000), [5000, 38], [5029, 286], ...steady(5070, 7000)];
  const { pacer, buckets } = stream(arrivals, 8000, 1000 / 165);
  const after = [...buckets].filter(([bucket]) => bucket >= 50).map(([, grew]) => grew * 10);
  const peak = Math.max(...after);
  // One word of slack over the cap within a 100 ms bucket.
  assert.ok(peak <= PACER_MAX_RATE + 100, `peak ${peak}/s`);
  assert.ok(peak < 700, `peak ${peak}/s`);
  assert.ok(pacer.target.length - pacer.shown < 60, `lag ${pacer.target.length - pacer.shown}`);
});

test('a first arrival over 600 characters is paced over many frames, never painted whole', () => {
  const pacer = new TranscriptTextPacer();
  const text = prose(1166);
  pacer.push(text, 0);
  const frames = play(pacer, FRAME, 3000);
  const largest = Math.max(...frames.map((frame) => frame.grew));
  const growing = frames.filter((frame) => frame.grew > 0).length;
  assert.ok(largest < 80, `largest frame ${largest}`);
  assert.ok(growing >= 30, `${growing} growing frames`);
  // The excess over the lag ceiling drains within about 600 ms.
  const at600 = frames.filter((frame) => frame.now <= 600).reduce((sum, frame) => sum + frame.grew, 0);
  assert.ok(text.length - at600 <= PACER_MAX_LAG_CHARS, `behind ${text.length - at600} at 600 ms`);
});

test('reveals end on word boundaries; the unfinished final word waits', () => {
  const pacer = new TranscriptTextPacer();
  let text = '';
  for (let now = 0; now < 3000; now += FRAME) {
    if (Math.round(now) % 50 < FRAME) {
      text += prose(7, text.length);
      pacer.push(text, now);
    }
    pacer.tick(now);
    const shown = pacer.shown;
    if (shown > 0 && shown < text.length) {
      assert.ok(/[\s.,]/.test(text[shown]), `cut ${shown} of ${JSON.stringify(text.slice(shown - 10, shown + 5))}`);
    }
  }
  const partial = new TranscriptTextPacer();
  partial.push('alpha beta gam', 0);
  play(partial, FRAME, 1000);
  assert.equal(partial.text, 'alpha beta');
  partial.settle(1000);
  play(partial, 1000, 1300);
  assert.equal(partial.text, 'alpha beta gam');
});

test('bursty input plays out evenly: p95 graphemes per frame stays under 3x the median', () => {
  const pacer = new TranscriptTextPacer();
  let text = '';
  const growth = [];
  let next = 0;
  for (let now = 0; now < 4000; now += FRAME) {
    if (now >= next) {
      text += 'word '.repeat(16);
      pacer.push(text, now);
      next += 400;
    }
    const before = pacer.shown;
    pacer.tick(now);
    if (now > 1000 && pacer.shown > before) growth.push(pacer.shown - before);
  }
  growth.sort((a, b) => a - b);
  const median = growth[Math.floor(growth.length / 2)];
  const p95 = growth[Math.floor(growth.length * 0.95)];
  assert.ok(p95 < 3 * median, `median ${median} p95 ${p95}`);
});

test('a stall drains everything but the unfinished final word', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push(`${prose(60)} tail`, 0);
  play(pacer, FRAME, 1500);
  assert.equal(pacer.pending, 0);
  assert.equal(pacer.text, prose(60));
});

test('a burst after an idle stall starts from one frame of credit, not the idle gap', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('warm up text', 0);
  play(pacer, FRAME, 1000);
  assert.equal(pacer.pending, 0);
  // Idle: no frames while nothing is queued. A burst lands after the stall.
  const burst = `${pacer.target} ${'가'.repeat(150)}`;
  pacer.push(burst, 1900);
  const before = pacer.shown;
  pacer.tick(1900 + FRAME / 2);
  // Credit for half a frame, not for the 100 ms frame cap (~118 here).
  assert.ok(pacer.shown - before <= 12, `first frame after idle revealed ${pacer.shown - before}`);
});

test('partial-line input every 40 ms plays out at a few graphemes per frame', () => {
  const pacer = new TranscriptTextPacer();
  let text = '';
  const growth = [];
  let next = 0;
  for (let now = 0; now < 4000; now += FRAME) {
    if (now >= next) {
      text += 'abcdefgh';
      pacer.push(text, now);
      next += 40;
    }
    const before = pacer.shown;
    pacer.tick(now);
    if (now > 500 && pacer.shown > before) growth.push(pacer.shown - before);
  }
  growth.sort((a, b) => a - b);
  assert.ok(growth[Math.floor(growth.length * 0.95)] <= 5, `p95 ${growth[Math.floor(growth.length * 0.95)]}`);
});

test('a backlog drains toward the target lag at no more than the cap', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push(prose(400), 0);
  const frames = play(pacer, FRAME, 3000);
  const firstSecond = frames.filter((frame) => frame.now < 1000).reduce((sum, frame) => sum + frame.grew, 0);
  assert.ok(firstSecond <= PACER_MAX_RATE + 10, `${firstSecond} in the first second`);
  assert.ok(firstSecond >= 300, `${firstSecond} in the first second`);
});

test('completion drains the remainder within the drain budget', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('z'.repeat(400), 0);
  pacer.tick(FRAME);
  pacer.settle(FRAME);
  play(pacer, FRAME * 2, FRAME + PACER_DRAIN_MS + FRAME);
  assert.equal(pacer.pending, 0);
  assert.ok(PACER_DRAIN_MS <= 250);
});

test('a rewrite restarts from the still valid revealed prefix', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('hello world', 0);
  play(pacer, FRAME, 1000);
  // The unfinished final word "world" was held: the revealed prefix is "hello".
  pacer.push('hello there', 1000);
  assert.equal(pacer.shown, 'hello'.length);
  pacer.settle(1000);
  play(pacer, 1000, 2000);
  assert.equal(pacer.text, 'hello there');
  pacer.push('', 2000);
  assert.equal(pacer.text, '');
});

test('graphemes are never split: Korean, CJK, ZWJ emoji and flags', () => {
  const pacer = new TranscriptTextPacer();
  const family = '👨‍👩‍👧‍👦';
  // The ZWJ sequence arrives split across two deltas.
  pacer.push(`안녕 中文 ${family.slice(0, 3)}`, 0);
  pacer.push(`안녕 中文 ${family} 🇰🇷`, 5);
  pacer.settle(5);
  const seen = new Set();
  for (let now = FRAME; now < 1000; now += FRAME) {
    pacer.tick(now);
    seen.add(pacer.text);
  }
  for (const text of seen) {
    assert.ok(!text.endsWith('\u200d'), JSON.stringify(text));
    assert.ok(!/[\ud800-\udbff]$/.test(text), JSON.stringify(text));
    if (text.includes('👨')) assert.ok(text.includes(family), JSON.stringify(text));
  }
  assert.equal(pacer.text, `안녕 中文 ${family} 🇰🇷`);
});

test('flush reveals everything at once (reduced motion, hidden pane, a later row)', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('abc'.repeat(50), 0);
  pacer.flush();
  assert.equal(pacer.pending, 0);
  assert.equal(pacer.text, 'abc'.repeat(50));
});

const graphemesOf = (text) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;

test('rate, lag and reveal budget count graphemes, not UTF-16 units', () => {
  // 600 graphemes, 3,600 UTF-16 units: within the lag ceiling, so the reveal
  // stays at the cap instead of draining a 3,600-unit "excess".
  const family = '👨‍👩‍👧‍👦';
  const emoji = new TranscriptTextPacer();
  const text = `${family} `.repeat(300);
  emoji.push(text, 0);
  play(emoji, FRAME, 1000);
  const shown = graphemesOf(emoji.text);
  assert.ok(shown <= PACER_MAX_RATE + 20, `${shown} graphemes in the first second`);
  assert.ok(shown >= 250, `${shown} graphemes in the first second`);
  // Combining sequences: each "café" (e + U+0301) is four graphemes; 550
  // graphemes are within the lag ceiling, 660 UTF-16 units would not be.
  const combining = new TranscriptTextPacer();
  const cafe = 'cafe\u0301 '.repeat(110);
  combining.push(cafe, 0);
  play(combining, FRAME, 1000);
  assert.ok(graphemesOf(combining.text) <= PACER_MAX_RATE + 20, `${graphemesOf(combining.text)} graphemes`);
  assert.ok(!combining.text.endsWith('e'), 'never cuts before a combining mark');
});

test('a whitespace run costs one step, so the lag bound holds', () => {
  const pacer = new TranscriptTextPacer();
  const text = `hello${' '.repeat(1000)}world more`;
  pacer.push(text, 0);
  play(pacer, FRAME, 600);
  assert.ok(pacer.text.endsWith('world'), JSON.stringify(pacer.text.trim()));
});

test('a run of markdown markers (split into one segment each) costs one step', () => {
  const pacer = new TranscriptTextPacer();
  const text = `hello${'*'.repeat(1000)}world more`;
  pacer.push(text, 0);
  play(pacer, FRAME, 600);
  assert.ok(pacer.text.endsWith('world'), JSON.stringify(pacer.text.slice(-12)));
  // Mixed whitespace and markers, arriving across deltas, are one run too.
  const mixed = new TranscriptTextPacer();
  mixed.push(`hello ${'* '.repeat(200)}`, 0);
  mixed.push(`hello ${'* '.repeat(400)}\n\n**world** more`, 5);
  play(mixed, FRAME, 600);
  assert.ok(mixed.text.includes('world'), JSON.stringify(mixed.text.slice(-12)));
});

test('a rewrite keeps only the last whole word of the still valid prefix', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('hello world ', 0);
  play(pacer, FRAME, 1500);
  assert.equal(pacer.text, 'hello world');
  pacer.push('hello wording ', 1500);
  assert.equal(pacer.text, 'hello');
  const seen = new Set();
  pacer.push('hello wording and more ', 1500);
  for (let now = 1500; now < 4000; now += FRAME) {
    pacer.tick(now);
    seen.add(pacer.text);
  }
  const partial = [...seen].filter((text) => /wor$|word$|wordi$|wordin$/.test(text));
  assert.deepEqual(partial, []);
  // The trailing space is the final segment: "more" ended and shows.
  assert.equal(pacer.text, 'hello wording and more');
  assert.ok(seen.has('hello wording'), 'the rewritten word reveals whole');
});

test('completion releases the held final word through the drain', () => {
  const caughtUp = new TranscriptTextPacer();
  caughtUp.push(`${prose(80)} last`, 0);
  play(caughtUp, FRAME, 2000);
  assert.ok(caughtUp.unrevealed, 'the final word is held while streaming');
  caughtUp.settle(2000);
  assert.ok(caughtUp.pending > 0, 'it joins the drain');
  play(caughtUp, 2000 + FRAME, 2000 + PACER_DRAIN_MS + FRAME);
  assert.equal(caughtUp.unrevealed, false);
});

test('the backlog is capped so a huge burst does not replay', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push(prose(10_000), 0);
  assert.ok(pacer.target.length - pacer.shown <= 4_000);
});

test('the reveal cut never ends right after a markdown marker', () => {
  const text = 'a **bold** word and `code` [link](x)';
  for (let cut = 1; cut < text.length; cut += 1) {
    const at = cleanRevealCut(text, cut);
    assert.ok(at <= cut);
    assert.ok(!/[`*_~[\]()<>#|\\!]/.test(text[at - 1] ?? ''), `cut ${cut} -> ${at}`);
  }
  assert.equal(cleanRevealCut(text, text.length), text.length);
});

test('a still-streaming reveal never ends inside a markdown marker, even at the received end', () => {
  // Unfinished lines as they arrive mid-stream.
  for (const received of ['say **bo', 'say **', 'call `', 'see [link](htt', 'see [', 'a | b |', 'x ~~']) {
    const at = cleanRevealCut(received, received.length, true);
    assert.ok(at <= received.length);
    assert.ok(!/[`*_~[\]()<>#|\\!]/.test(received[at - 1] ?? ''), `${JSON.stringify(received)} -> ${at}`);
  }
  // Clean text ends where it was received; settled text is never cut.
  assert.equal(cleanRevealCut('plain words', 11, true), 11);
  assert.equal(cleanRevealCut('say **', 6), 6);
});
