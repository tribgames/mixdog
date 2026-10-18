/**
 * use-paced-transcript-text.test.mjs — the live assistant reveal buffer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMENTARY_MAX_GRAPHEMES,
  FADE_FLOOR_MS,
  FADE_WORDS_IN_FLIGHT,
  FINAL_FADE_MIN_MS,
  PACER_CATCHUP_MS,
  PACER_DRAIN_MS,
  PACER_LAG_FLOOR_RATE,
  PACER_MAX_LAG_MS,
  PACER_STEP_MS,
  PACER_TARGET_LAG_MS,
  TranscriptTextPacer,
  adaptiveFadeMs,
  answerStart,
  streamingTextPaints,
} from './use-paced-transcript-text.ts';
import { STREAM_FADE_COMMENTARY_MS, STREAM_FADE_DURATION_MS } from './markdown-stream-fade.ts';

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

const graphemesOf = (text) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;

/** Feed `arrivals` ([time, chars]) while ticking every frame. */
function stream(arrivals, until, frame = FRAME) {
  const pacer = new TranscriptTextPacer();
  let text = '';
  let next = 0;
  const changes = [];
  for (let now = 0; now < until; now += frame) {
    while (next < arrivals.length && arrivals[next][0] <= now) {
      text += prose(arrivals[next][1], text.length);
      pacer.push(text);
      next += 1;
    }
    const before = pacer.shown;
    if (pacer.tick(now)) changes.push({ now, grew: pacer.shown - before });
  }
  return { pacer, changes };
}

function steady(from, until) {
  const out = [];
  for (let at = from; at < until; at += 42) out.push([at, 4]);
  return out;
}

test("a part's first received text paints at once; growth after it is paced", () => {
  const pacer = new TranscriptTextPacer('Let me look', true);
  assert.equal(pacer.text, 'Let me look');
  const text = `Let me look${prose(200)}`;
  pacer.push(text);
  assert.equal(pacer.text, 'Let me look', 'growth waits for the reveal clock');
  const frames = play(pacer, 0, PACER_STEP_MS * 3);
  const first = frames.find((frame) => frame.grew > 0);
  assert.ok(first && first.grew > 0 && first.grew < 20, `first step ${first?.grew}`);
  pacer.settle(1000);
  pacer.tick(1000 + PACER_DRAIN_MS);
  assert.equal(pacer.text, text);
});

test('a part reads as commentary until a block a preamble never has, or past the length limit', () => {
  assert.equal(answerStart("I'll read the config first, then check the tests."), -1);
  assert.equal(answerStart('Two files differ:\nthe config and the lockfile.'), -1);
  const intro = 'Here is the summary.\n\n';
  for (const block of [
    '- one',
    '* one',
    '1. one',
    '2) one',
    '## Notes',
    '```js',
    '~~~',
    '> quoted',
    '| a | b |',
    '---',
    '***',
  ]) {
    assert.equal(answerStart(`${intro}${block}`), intro.length, block);
  }
  // A header without a leading pipe: the table starts at the header line.
  const table = 'Results:\nname | size\n--- | ---\n';
  assert.equal(answerStart(table), 'Results:\n'.length);
  assert.equal(answerStart('a **bold** line\n**Bold** start'), -1, 'emphasis is not a list item');
  const limit = prose(COMMENTARY_MAX_GRAPHEMES);
  assert.equal(answerStart(limit), -1, 'at the limit');
  assert.equal(answerStart(`${limit}x`), limit.length, 'past the limit, from its end');
  const emoji = '👨‍👩‍👧‍👦'.repeat(COMMENTARY_MAX_GRAPHEMES);
  assert.equal(answerStart(emoji), -1, 'the limit counts graphemes');
  assert.equal(answerStart(`${prose(40)}\n- item ${prose(400)}`), 41, 'the earlier start wins');
});

test('commentary shows as it arrives; once promoted, the rest is paced from the answer start', () => {
  const pacer = new TranscriptTextPacer("I'll check", true, true);
  assert.equal(pacer.commentary, true);
  pacer.push("I'll check the config");
  assert.equal(pacer.text, "I'll check the config", 'no smoothing');
  assert.equal(pacer.pending, 0);
  const head = "I'll check the config.\n\nFound:\n";
  const text = `${head}- one ${prose(200)}`;
  pacer.push(text);
  assert.equal(pacer.commentary, false, 'a list item promotes the part');
  assert.equal(pacer.text, head, 'text before the list shows at once');
  assert.ok(pacer.pending > 0, 'the list is paced');
  play(pacer, 0, PACER_STEP_MS * 3);
  assert.ok(pacer.shown > head.length && pacer.shown < text.length);
  pacer.push(`${text} more`);
  assert.equal(pacer.commentary, false, 'a promotion is final');
  pacer.settle(5000);
  pacer.tick(5000 + PACER_DRAIN_MS);
  assert.equal(pacer.text, `${text} more`);
});

test('a long part of unknown phase is paced past the length limit; a short one settles whole', () => {
  const long = new TranscriptTextPacer('', true, true);
  const text = prose(COMMENTARY_MAX_GRAPHEMES + 200);
  long.push(text);
  assert.equal(long.commentary, false);
  assert.equal(long.shown, COMMENTARY_MAX_GRAPHEMES);
  assert.ok(long.pending > 0);
  const preamble = new TranscriptTextPacer('Let me', true, true);
  preamble.push('Let me list the folder');
  preamble.settle();
  assert.equal(preamble.text, 'Let me list the folder');
  assert.equal(preamble.commentary, true, 'a tool call start keeps it commentary');
  const opening = new TranscriptTextPacer(`Summary:\n\n- ${prose(20)}`, true, true);
  assert.equal(opening.commentary, false, 'a first text with a list is an answer already');
});

test('the revealed prefix grows grapheme by grapheme, so a word shows while it grows', () => {
  const pacer = new TranscriptTextPacer();
  const text = 'alpha beta gamma delta';
  pacer.push(text);
  const seen = new Set();
  for (let now = 0; now < 10_000; now += FRAME) {
    pacer.tick(now);
    seen.add(pacer.text);
  }
  for (const shown of seen) assert.ok(text.startsWith(shown), JSON.stringify(shown));
  assert.ok(
    [...seen].some((shown) => /[a-z]$/.test(shown) && !/(alpha|beta|gamma|delta)$/.test(shown)),
    'some reveal ends inside a word'
  );
  assert.equal(pacer.text, text, 'a stall drains the whole backlog, last word included');
});

test('steps run on their own clock, never more often than PACER_STEP_MS', () => {
  const frame = 1000 / 144;
  const { changes } = stream(steady(0, 3000), 3000, frame);
  assert.ok(changes.length > 20, `${changes.length} changes`);
  for (let index = 1; index < changes.length; index += 1) {
    // A step lands on the first frame at or after its clock time.
    assert.ok(changes[index].now - changes[index - 1].now > PACER_STEP_MS - frame, `${changes[index].now}`);
  }
});

test('a steady stream plays at its arrival rate about the target lag behind it', () => {
  const { pacer, changes } = stream(steady(0, 6000), 6000);
  const late = changes.filter((change) => change.now >= 3000);
  const rate = (late.reduce((sum, change) => sum + change.grew, 0) * 1000) / 3000;
  assert.ok(rate > 70 && rate < 120, `rate ${rate}/s (arrival about 95/s)`);
  const lag = pacer.target.length - pacer.shown;
  const arrival = (4 * 1000) / 42;
  const lagMs = (lag / arrival) * 1000;
  assert.ok(lagMs > PACER_TARGET_LAG_MS * 0.5 && lagMs < PACER_TARGET_LAG_MS * 1.5, `lag ${Math.round(lagMs)} ms`);
});

test('a burst after a pause within the lag bound eases in and out instead of jumping', () => {
  const pacer = new TranscriptTextPacer('warm up', true);
  const burst = 200;
  assert.ok(burst < (PACER_LAG_FLOOR_RATE * PACER_MAX_LAG_MS) / 1000);
  const text = `warm up ${prose(burst)}`;
  pacer.push(text);
  const frames = play(pacer, 5000, 9000).filter((frame) => frame.grew > 0);
  const firstStep = frames[0].grew;
  const peak = Math.max(...frames.map((frame) => frame.grew));
  const peakAt = frames.findIndex((frame) => frame.grew === peak);
  assert.ok(firstStep < peak, `first ${firstStep}, peak ${peak}`);
  assert.ok(peakAt > 0 && peakAt < frames.length / 2, `peak at step ${peakAt} of ${frames.length}`);
  assert.ok(peak <= 20, `peak ${peak} graphemes in one step`);
  const atOneSecond = frames.filter((frame) => frame.now < 6000).reduce((sum, frame) => sum + frame.grew, 0);
  assert.ok(atOneSecond > burst * 0.5 && atOneSecond < burst * 0.95, `${atOneSecond} of ${burst} within 1 s`);
});

test('a backlog past the lag bound is caught up within PACER_CATCHUP_MS, never at once, with a short fade', () => {
  const pacer = new TranscriptTextPacer('warm up', true);
  const text = `warm up ${prose(1200)}`;
  pacer.push(text);
  pacer.tick(0);
  const bound = Math.ceil((PACER_LAG_FLOOR_RATE * PACER_MAX_LAG_MS) / 1000);
  const excess = text.length - 'warm up'.length - bound;
  const steps = [];
  for (let now = PACER_STEP_MS; now <= PACER_CATCHUP_MS; now += PACER_STEP_MS) {
    const before = pacer.shown;
    pacer.tick(now);
    steps.push(pacer.shown - before);
    assert.equal(pacer.fadeMs, FADE_FLOOR_MS, `${now} ms: caught up text fades for the floor`);
  }
  assert.ok(Math.max(...steps) < excess / 4, `largest step ${Math.max(...steps)} of ${excess} past the bound`);
  const left = text.length - pacer.shown;
  assert.ok(left <= bound, `${left} graphemes left after the catch-up, bound ${bound}`);
  pacer.tick(PACER_CATCHUP_MS + PACER_STEP_MS * 2);
  assert.ok(pacer.fadeMs >= FINAL_FADE_MIN_MS, 'the paced rest fades by its rate again');
});

test('a final-answer fade lasts a few word intervals at the reveal rate, within its floor and cap', () => {
  const words = (rate) => (adaptiveFadeMs(rate) * rate) / 1000 / 6;
  assert.equal(adaptiveFadeMs(10), STREAM_FADE_DURATION_MS, 'slow: the cap');
  assert.equal(adaptiveFadeMs(0), STREAM_FADE_DURATION_MS, 'unknown rate: the cap');
  for (const rate of [40, 60, 90]) {
    assert.ok(Math.abs(words(rate) - FADE_WORDS_IN_FLIGHT) < 0.05, `${rate}/s: ${words(rate)} words in flight`);
  }
  assert.ok(adaptiveFadeMs(60) > FINAL_FADE_MIN_MS && adaptiveFadeMs(60) < STREAM_FADE_DURATION_MS);
  assert.equal(adaptiveFadeMs(5000), FINAL_FADE_MIN_MS, 'fast: the floor, never unfaded');
});

test('commentary words fade for the commentary duration, however fast they arrive', () => {
  const pacer = new TranscriptTextPacer('', true, true, true);
  assert.equal(pacer.fadeMs, STREAM_FADE_COMMENTARY_MS);
  let text = 'Let';
  pacer.push(text);
  for (let index = 0; index < 10; index += 1) {
    text += ' word';
    pacer.push(text);
    assert.equal(pacer.fadeMs, STREAM_FADE_COMMENTARY_MS);
  }
  pacer.push(`${text} ${prose(800)}`);
  assert.equal(pacer.commentary, true, 'named commentary is never promoted');
  assert.equal(pacer.fadeMs, STREAM_FADE_COMMENTARY_MS, 'a burst fades too');
});

test('words inside a code span, link or emphasis stream; a heading waits for its line', () => {
  const pacer = new TranscriptTextPacer('Run', true);
  pacer.push('Run the `npm ins');
  play(pacer, 0, 3000);
  assert.equal(pacer.text, 'Run the `npm ins', 'the open code span streams (the healer closes it)');
  pacer.push('Run the `npm install` step\n## Next ste');
  play(pacer, 3000, 6000);
  assert.equal(pacer.text, 'Run the `npm install` step\n', 'the heading line is held');
  pacer.push('Run the `npm install` step\n## Next steps\n');
  play(pacer, 6000, 9000);
  assert.equal(pacer.text, 'Run the `npm install` step\n## Next steps\n');
});

test('an idle gap is never counted: the first step after it reveals a few graphemes', () => {
  const pacer = new TranscriptTextPacer('caught up', true);
  pacer.push(`caught up ${'가'.repeat(150)}`);
  pacer.tick(1900);
  assert.equal(pacer.shown, 'caught up'.length, 'the clock starts');
  pacer.tick(1900 + PACER_STEP_MS);
  const grew = pacer.shown - 'caught up'.length;
  assert.ok(grew > 0 && grew <= 10, `first step revealed ${grew}`);
});

test('settle (the turn completes) drains the backlog within PACER_DRAIN_MS with a short fade, then the fade ends', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push(prose(200), 0);
  play(pacer, 0, 200);
  assert.ok(pacer.unrevealed);
  const before = pacer.shown;
  pacer.settle(1000);
  assert.equal(pacer.settled, true);
  assert.equal(pacer.draining, true);
  assert.equal(pacer.fadeMs, FADE_FLOOR_MS);
  pacer.tick(1000 + PACER_DRAIN_MS / 2);
  assert.ok(pacer.shown > before && pacer.shown < prose(200).length, 'halfway');
  pacer.tick(1000 + PACER_DRAIN_MS);
  assert.equal(pacer.pending, 0);
  assert.equal(pacer.text, prose(200));
  assert.equal(pacer.draining, true, 'the last drained words still fade');
  assert.equal(pacer.waiting, true);
  assert.equal(pacer.tick(1000 + PACER_DRAIN_MS + FADE_FLOOR_MS / 2), false);
  assert.equal(pacer.tick(1000 + PACER_DRAIN_MS + FADE_FLOOR_MS), true, 'the fade turns off');
  assert.equal(pacer.draining, false);
  const idle = new TranscriptTextPacer('done', true);
  idle.settle();
  assert.equal(idle.draining, false, 'nothing queued: nothing to drain');
});

test('a rewrite that does not extend the received text shows it whole', () => {
  const pacer = new TranscriptTextPacer('hello', true);
  pacer.push(`hello ${prose(200)}`);
  play(pacer, 0, 300);
  pacer.push('hello there');
  assert.equal(pacer.text, 'hello there');
  assert.equal(pacer.pending, 0);
  pacer.push('');
  assert.equal(pacer.text, '');
});

test('graphemes are never split: Korean, CJK, ZWJ emoji and flags', () => {
  const pacer = new TranscriptTextPacer();
  const family = '👨‍👩‍👧‍👦';
  // The ZWJ sequence arrives split across two deltas.
  pacer.push(`안녕 中文 ${family.slice(0, 3)}`);
  pacer.push(`안녕 中文 ${family} 🇰🇷`);
  const seen = new Set();
  for (let now = 0; now < 8000; now += FRAME) {
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

test('rate and backlog count graphemes, not UTF-16 units', () => {
  // A ZWJ family is one grapheme of 11 UTF-16 units, "café" with U+0301 four
  // graphemes of five units: each reveals like plain text of the same
  // grapheme count.
  const family = '👨‍👩‍👧‍👦';
  const reveal = (text, until) => {
    const pacer = new TranscriptTextPacer();
    pacer.push(text);
    play(pacer, 0, until);
    return pacer.text;
  };
  for (const until of [100, 200, 500, 900]) {
    const emoji = graphemesOf(reveal(`${family} `.repeat(300), until));
    const plain = graphemesOf(reveal('x '.repeat(300), until));
    assert.ok(emoji > 0 && Math.abs(emoji - plain) <= 2, `${until} ms: ${emoji} vs ${plain}`);
    const combining = reveal('cafe\u0301 '.repeat(110), until);
    const ascii = graphemesOf(reveal('cafe '.repeat(110), until));
    assert.ok(Math.abs(graphemesOf(combining) - ascii) <= 2, `${until} ms: ${graphemesOf(combining)} vs ${ascii}`);
    assert.ok(!combining.endsWith('e'), 'never cuts before a combining mark');
  }
});

test('flush reveals everything at once (reduced motion, hidden pane, a later row)', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('abc'.repeat(50));
  pacer.flush();
  assert.equal(pacer.pending, 0);
  assert.equal(pacer.text, 'abc'.repeat(50));
});

test('a streaming row opens with the first text that shows', () => {
  for (const [text, paints] of [
    ['', false],
    ['  ', false],
    ['**', false],
    ['| ', false],
    ['A', true],
    ['**H', true],
    ['가', true],
    ['Aft', true],
  ]) {
    assert.equal(streamingTextPaints(text), paints, JSON.stringify(text));
  }
});
