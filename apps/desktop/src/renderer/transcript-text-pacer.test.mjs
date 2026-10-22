/**
 * transcript-text-pacer.test.mjs — the paced reveal of the coding transcript's
 * live text: step size and cadence by backlog, catch-up, rejoin, the first
 * text, idling, and the part ending.
 */
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

test('the cadence drains a backlog in about 550 ms: 550 x 22 / backlog, within 25..150 ms', () => {
  assert.equal(revealStepInterval(22), 150);
  assert.equal(revealStepInterval(100), 121);
  assert.equal(revealStepInterval(242), 50);
  assert.equal(revealStepInterval(484), 25);
  assert.equal(revealStepInterval(5000), 25);
});

test('a step is 22 characters; a backlog past 484 adds its excess, ramped over 75 ms of waiting', () => {
  assert.equal(revealStepChars(100, 150), 22);
  assert.equal(revealStepChars(484, 75), 22);
  assert.equal(revealStepChars(584, 75), 122);
  assert.equal(revealStepChars(584, 150), 122, 'the ramp caps at the whole excess');
  assert.equal(revealStepChars(584, 37.5), 72);
});

test('a first text up to 400 characters shows as one step; a longer one shows at once', async (t) => {
  const short = await mount(t);
  await short.render({ text: words(60) });
  // 22 characters end inside the fifth word: back to after the fourth.
  assert.equal(short.host.textContent, words(4));
  const long = await mount(t);
  await long.render({ text: words(81) });
  assert.equal(long.shown(), 405, 'whole');
});

test('steps wait the cadence of their backlog, then reveal 22 characters cut at a word', async (t) => {
  const view = await mount(t);
  await view.render({ text: 'Hi ' });
  await view.advance(5);
  await view.render({ text: `Hi ${words(40)}` });
  // A backlog of 200: a step every 550 x 22 / 200 = 60.5 ms.
  await view.advance(55);
  assert.equal(view.shown(), 3, 'not before the cadence');
  await view.advance(8);
  assert.equal(view.host.textContent, `Hi ${words(4)}`, 'one step, back to the last space');
  const after = view.shown();
  // The backlog is now 180: the next step 67 ms on.
  await view.advance(60);
  assert.equal(view.shown(), after);
  await view.advance(10);
  assert.equal(view.host.textContent, `Hi ${words(8)}`);
});

test('a backlog the cadence cannot drain catches up: its excess joins the step', async (t) => {
  const view = await mount(t);
  await view.render({ text: 'Hi ' });
  await view.advance(5);
  await view.render({ text: `Hi ${words(110)}` });
  // A backlog of 550 waits 25 ms; the step adds ceil(66 x 25 / 75) = 22:
  // 44 characters, which end on a space, so the step takes nine words.
  await view.advance(26);
  assert.equal(view.host.textContent, `Hi ${words(9)}`);
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

test('drained, the reveal idles; the next arrival waits its cadence from when it arrived', async (t) => {
  const view = await mount(t);
  await view.render({ text: 'Hi ' });
  await view.advance(1000);
  await view.render({ text: `Hi ${words(4)}` });
  // 20 waiting: 550 x 22 / 20 = 605, capped at 150 ms.
  await view.advance(145);
  assert.equal(view.shown(), 3);
  await view.advance(10);
  assert.equal(view.host.textContent, `Hi ${words(4)}`);
});

test('the part ending shows the rest at once; a remount continues where it was', async (t) => {
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
  assert.equal(view.shown(), 203);
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
  assert.equal(view.shown(), 203);
  await view.unmount();
});

test("deleting a session drops its rows' reveals and fade timelines", async (t) => {
  const { deleteSessionImagePreviews } = await import('./image-preview-store.ts');
  const { streamFadeTimeline } = await import('./markdown-stream-fade.ts');
  const { rememberTranscriptRowNamespace } = await import('./transcript-virtual-cache.ts');
  const view = row(t, 'gone-s:r1');
  await view.mount({ text: 'Hi ' });
  await advanceClock(t, 5);
  await view.render({ text: `Hi ${words(40)}` });
  await advanceClock(t, 300);
  const shown = view.shown();
  assert.ok(shown > 23);
  await view.unmount();
  assert.ok(streamFadeTimeline('gone-s:r1', true));
  rememberTranscriptRowNamespace('gone-ns', 'draft-gone');
  assert.ok(streamFadeTimeline('draft-gone:r1', true));
  assert.ok(streamFadeTimeline('kept-s:r1', true));
  deleteSessionImagePreviews('gone-s');
  deleteSessionImagePreviews('gone-ns');
  assert.equal(streamFadeTimeline('gone-s:r1', false), null);
  assert.equal(streamFadeTimeline('draft-gone:r1', false), null, 'its namespace too');
  assert.ok(streamFadeTimeline('kept-s:r1', false), 'other sessions keep theirs');
  await view.mount({ text: `Hi ${words(40)}` });
  assert.equal(view.shown(), 23, 'the reveal starts over: its first step');
  await view.unmount();
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
