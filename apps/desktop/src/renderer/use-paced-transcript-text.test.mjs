/**
 * use-paced-transcript-text.test.mjs — the live assistant playout buffer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PACER_CUSHION_MAX_MS,
  PACER_DRAIN_MS,
  TranscriptTextPacer,
  cleanRevealCut,
} from './use-paced-transcript-text.ts';

const FRAME = 1000 / 60;

function play(pacer, from, until) {
  const frames = [];
  for (let now = from; now < until; now += FRAME) {
    const before = pacer.shown;
    pacer.tick(now);
    frames.push({ now, grew: pacer.shown - before });
  }
  return frames;
}

test('a burst is revealed over several frames, starting on the next frame', () => {
  const pacer = new TranscriptTextPacer();
  const text = 'a'.repeat(120);
  pacer.push(text, 0);
  const [first] = play(pacer, FRAME, FRAME * 2);
  assert.ok(first.grew >= 1 && first.grew < 120, `first frame revealed ${first.grew}`);
  play(pacer, FRAME * 2, 1000);
  assert.equal(pacer.text, text);
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

test('no idle frame while text is queued', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('x'.repeat(40), 0);
  const frames = play(pacer, FRAME, 2000);
  const lastGrowth = frames.findLastIndex((frame) => frame.grew > 0);
  assert.ok(frames.slice(0, lastGrowth + 1).every((frame) => frame.grew > 0));
});

test('a stall drains the reserve within the cushion ceiling plus slack', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('y'.repeat(30), 0);
  play(pacer, FRAME, 1000);
  assert.equal(pacer.pending, 0);
  assert.ok(PACER_CUSHION_MAX_MS <= 250);
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
  assert.ok(pacer.cushionMs() <= 250);
});

test('a large backlog enters catch-up and leaves it once drained', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('line of text\n'.repeat(20), 0);
  pacer.tick(FRAME);
  assert.equal(pacer.catchingUp, true);
  play(pacer, FRAME * 2, 1500);
  assert.equal(pacer.pending, 0);
  pacer.push(`${pacer.target}tail`, 1500);
  play(pacer, 1500, 2000);
  assert.equal(pacer.catchingUp, false);
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
  pacer.push('hello there', 1000);
  assert.equal(pacer.shown, 'hello '.length);
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

test('the backlog is capped so a huge burst does not replay', () => {
  const pacer = new TranscriptTextPacer();
  pacer.push('q'.repeat(10_000), 0);
  assert.ok(pacer.pending <= 1_200);
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
