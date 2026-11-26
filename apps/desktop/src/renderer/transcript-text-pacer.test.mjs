import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { pretendToBeVisual: true },
  expose: ['HTMLElement', 'navigator'],
});
const { revealStepChars, revealStepInterval, useTranscriptTextReveal } = await import(
  './use-transcript-text-reveal.ts'
);

/** Words of five characters ("w000 "), `count` of them. */
const words = (count, from = 0) =>
  Array.from({ length: count }, (_, index) => `w${String(from + index).padStart(3, '0')} `).join('');

function Probe({ text, streaming = true, paced = true, id = 'r' }) {
  return React.createElement('p', null, useTranscriptTextReveal({ key: id, text, streaming, paced }).text);
}

let probes = 0;
const clocks = new WeakMap();

/** A manual clock per test: timers and performance.now move together. */
function clock(t) {
  let known = clocks.get(t);
  if (!known) {
    known = { now: 10_000 };
    t.mock.method(performance, 'now', () => known.now);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    clocks.set(t, known);
  }
  return known;
}

/** A probe on the test's manual clock. */
async function mount(t) {
  const time = clock(t);
  const id = `pacer-${probes++}`;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => act(async () => root.unmount()));
  const render = (props) => act(async () => root.render(React.createElement(Probe, { id, ...props })));
  const advance = async (ms) => {
    for (let at = 0; at < ms; at += 1) {
      time.now += 1;
      await act(async () => t.mock.timers.tick(1));
    }
  };
  return { render, advance, shown: () => host.textContent.length, host };
}

test('a 400-character opening drains as the reference pacer does: its first step at once, the rest within a second', async (t) => {
  // Interval per step: 300 x 6 / backlog within 16..50 ms, a backlog past
  // 112.5 adding its excess; the last 50 characters go a word per 50 ms, so
  // the last step lands at 925 ms.
  const view = await mount(t);
  await view.render({ text: words(80) });
  assert.equal(view.shown(), 5);
  await view.advance(900);
  assert.ok(view.shown() < 400, `not drained at 900 ms (${view.shown()})`);
  await view.advance(40);
  assert.equal(view.shown(), 400, 'drained by 940 ms');
});

test('the cadence follows the backlog: 300 x 6 / backlog, within 16..50 ms', () => {
  assert.equal(revealStepInterval(6), 50);
  assert.equal(revealStepInterval(36), 50);
  assert.equal(revealStepInterval(60), 30);
  assert.equal(revealStepInterval(90), 20);
  assert.equal(revealStepInterval(120), 16);
  assert.equal(revealStepInterval(5000), 16);
});

test('a step is 6 characters; a backlog past 112.5 adds its excess, ramped over 75 ms of waiting', () => {
  assert.equal(revealStepChars(100, 50), 6);
  assert.equal(revealStepChars(112, 75), 6);
  assert.equal(revealStepChars(212, 75), 106);
  assert.equal(revealStepChars(212, 150), 106, 'the ramp caps at the whole excess');
  assert.equal(revealStepChars(212, 37.5), 56);
});

test('a first text up to 400 characters shows as one step; a longer one shows at once', async (t) => {
  const short = await mount(t);
  await short.render({ text: words(80) });
  // 6 characters end inside the second word: back to after the first.
  assert.equal(short.host.textContent, words(1));
  const long = await mount(t);
  await long.render({ text: words(81) });
  assert.equal(long.shown(), 405, 'whole');
});

test('steps wait the cadence of their backlog, then reveal 6 characters cut at a word', async (t) => {
  const view = await mount(t);
  await view.render({ text: 'Hi ' });
  await view.advance(5);
  await view.render({ text: `Hi ${words(10)}` });
  await view.advance(1);
  assert.equal(view.host.textContent, `Hi ${words(1)}`, 'the first step at once, back to the last space');
  // The backlog is now 45: the next step 300 x 6 / 45 = 40 ms on.
  await view.advance(39);
  assert.equal(view.host.textContent, `Hi ${words(1)}`, 'not before the cadence');
  await view.advance(1);
  assert.equal(view.host.textContent, `Hi ${words(2)}`);
});

test('a burst after an idle gap starts with one plain step; its excess then catches up from the restart', async (t) => {
  const view = await mount(t);
  await view.render({ text: 'Hi ' });
  await view.advance(1000);
  await view.render({ text: `Hi ${words(110)}` });
  await view.advance(1);
  assert.equal(view.host.textContent, `Hi ${words(1)}`, 'at once, but one step: the idle time is no catch-up');
  // A backlog of 545 waits 16 ms; the step adds ceil((545 - 112.5) x 16 / 75)
  // = 93: 99 characters, back to the last space: 20 more words.
  await view.advance(15);
  assert.equal(view.host.textContent, `Hi ${words(1)}`);
  await view.advance(1);
  assert.equal(view.host.textContent, `Hi ${words(21)}`);
});

test('one delivery of more than 600 over a backlog of more than 600 shows at once', async (t) => {
  const view = await mount(t);
  await view.render({ text: 'Hi ' });
  await view.advance(5);
  await view.render({ text: `Hi ${words(130)}` });
  assert.equal(view.shown(), 653, '650 in one delivery: rejoined');
  const paced = await mount(t);
  await paced.render({ text: 'Hi ' });
  await paced.advance(5);
  await paced.render({ text: `Hi ${words(100)}` });
  await paced.advance(30);
  const before = paced.shown();
  assert.ok(before > 3);
  await paced.render({ text: `Hi ${words(150)}` });
  assert.equal(paced.shown(), before, 'a delivery of 250 over a backlog past 600 keeps pacing');
});

test('drained, the reveal idles; the next arrival steps at once, then at its cadence', async (t) => {
  const view = await mount(t);
  await view.render({ text: 'Hi ' });
  await view.advance(1000);
  await view.render({ text: `Hi ${words(4)}` });
  await view.advance(1);
  assert.equal(view.host.textContent, `Hi ${words(1)}`, 'no wait after the idle gap');
  // 15 waiting: 300 x 6 / 15 = 120, capped at 50 ms.
  await view.advance(48);
  assert.equal(view.host.textContent, `Hi ${words(1)}`);
  await view.advance(2);
  assert.equal(view.host.textContent, `Hi ${words(2)}`);
});

test('the part ending shows the rest at once; a remount before that continues where it was', async (t) => {
  const view = await mount(t);
  await view.render({ text: 'Hi ' });
  await view.advance(5);
  await view.render({ text: `Hi ${words(40)}` });
  await view.advance(70);
  const shown = view.shown();
  assert.ok(shown > 3 && shown < 203);
  const again = document.createElement('div');
  document.body.append(again);
  const root = createRoot(again);
  const id = `pacer-${probes - 1}`;
  await act(async () => root.render(React.createElement(Probe, { id, text: `Hi ${words(40)}` })));
  assert.equal(again.textContent.length, shown, 'a second mount of the row shows the same');
  await act(async () => root.unmount());
  await view.render({ text: `Hi ${words(40)}`, streaming: false });
  assert.equal(view.shown(), 203, 'ended: the rest shows at once');
  await view.advance(200);
  assert.equal(view.shown(), 203, 'and stays whole');
  // Streaming again after it settled goes on from what shows; nothing starts
  // over.
  await view.render({ text: `Hi ${words(41)}` });
  assert.equal(view.shown(), 203);
  await view.advance(200);
  assert.equal(view.shown(), 208);
});

/** Reduced motion on or off for the rest of test `t`. */
const motionRestored = new WeakSet();
function reducedMotion(t, on) {
  if (!motionRestored.has(t)) {
    motionRestored.add(t);
    const original = globalThis.matchMedia;
    t.after(() => {
      globalThis.matchMedia = original;
    });
  }
  globalThis.matchMedia = (query) => ({
    matches: on && /reduce/.test(query),
    addEventListener() {},
    removeEventListener() {},
  });
}

/** A probe of row `id` that mounts and unmounts on the test's clock. */
function row(t, id) {
  clock(t);
  let root = null;
  let host = null;
  return {
    async mount(props) {
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await act(async () => root.render(React.createElement(Probe, { id, ...props })));
    },
    render: (props) => act(async () => root.render(React.createElement(Probe, { id, ...props }))),
    unmount: () => act(async () => root.unmount()),
    shown: () => host.textContent.length,
  };
}

async function advanceClock(t, ms) {
  const time = clock(t);
  for (let at = 0; at < ms; at += 1) {
    time.now += 1;
    await act(async () => t.mock.timers.tick(1));
  }
}

test('a motion change keeps the reveal and its row: it goes on from what shows', async (t) => {
  const view = row(t, `pacer-motion-${probes++}`);
  reducedMotion(t, true);
  await view.mount({ text: words(60) });
  assert.equal(view.shown(), 300, 'reduced motion: shown at once');
  reducedMotion(t, false);
  await view.render({ text: words(70) });
  assert.equal(view.shown(), 300, 'what showed stays shown');
  await advanceClock(t, 1800);
  assert.equal(view.shown(), 350, 'the mounted row keeps receiving steps');
  await view.unmount();
});

test('an unmounted row takes no steps; its remount continues where it stopped', async (t) => {
  const view = row(t, `pacer-pause-${probes++}`);
  await view.mount({ text: 'Hi ' });
  await advanceClock(t, 5);
  await view.render({ text: `Hi ${words(40)}` });
  await advanceClock(t, 70);
  const shown = view.shown();
  assert.ok(shown > 3 && shown < 203);
  await view.unmount();
  await advanceClock(t, 1000);
  await view.mount({ text: `Hi ${words(40)}` });
  assert.equal(view.shown(), shown, 'nothing stepped while unmounted');
  await advanceClock(t, 200);
  assert.ok(view.shown() > shown, 'stepping again');
  await view.render({ text: `Hi ${words(40)}`, streaming: false });
  assert.equal(view.shown(), 203, 'ended, the rest shows at once');
  await view.unmount();
});

test("deleting a session drops its rows' reveals", async (t) => {
  const { deleteSessionImagePreviews } = await import('./image-preview-store.ts');
  const { rememberTranscriptRowNamespace } = await import('./transcript-virtual-cache.ts');
  rememberTranscriptRowNamespace('gone-ns', 'draft-gone');
  const views = ['gone-s:r1', 'draft-gone:r1', 'kept-s:r1'].map((id) => row(t, id));
  let kept = 0;
  for (const view of views) {
    await view.mount({ text: 'Hi ' });
    await advanceClock(t, 5);
    await view.render({ text: `Hi ${words(40)}` });
    await advanceClock(t, 30);
    kept = view.shown();
    assert.ok(kept > 6);
    await view.unmount();
  }
  deleteSessionImagePreviews('gone-s');
  deleteSessionImagePreviews('gone-ns');
  const [gone, draft, other] = views;
  // No space keeps half of a first step of 6 characters: it cuts inside the
  // first word.
  await gone.mount({ text: `Hi ${words(20)}` });
  assert.equal(gone.shown(), 6, 'the reveal starts over: its first step');
  await draft.mount({ text: `Hi ${words(20)}` });
  assert.equal(draft.shown(), 6, 'its namespace too');
  await other.mount({ text: `Hi ${words(40)}` });
  assert.equal(other.shown(), kept, 'other sessions keep theirs');
  for (const view of views) await view.unmount();
});

test('unpaced (chat): what arrived shows whole, at most one paint per 33 ms', async (t) => {
  const view = await mount(t);
  await view.render({ text: 'Hi', paced: false });
  assert.equal(view.shown(), 2);
  await view.advance(10);
  await view.render({ text: `Hi ${words(40)}`, paced: false });
  assert.equal(view.shown(), 2, 'within 33 ms of the last paint');
  await view.advance(25);
  assert.equal(view.shown(), 203, 'then everything at once');
});
