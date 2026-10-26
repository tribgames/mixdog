import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Android phone, reading upward through a long session with a finger
// (위로 스크롤하면 턱턱 막히거나 튄다). Rows mount above the reader at one learned
// estimate and measure at their real height; every third one first paints
// short and grows two frames later (a reply's parsed markdown). Sizes measured
// above the reader during the fling are deferred, and a fast fling carries a
// short row from wholly above to wholly in view between two frames, so its
// deferred size lands while it is already on screen. Every frame of several
// fast upward flings on a 4x-throttled CPU is sampled: the rows on screen must
// move only by the fling itself — never against it, never a jump on top of
// it — and every fling must run its course while older rows remain above.

const HARNESS = `
  import { useEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { TranscriptList } from './TranscriptList';
  import { useTranscriptFollow } from './use-transcript-follow';

  // XOR yields a signed 32-bit value: made unsigned before the modulo, so
  // every row lands in 0..999 and takes a real height.
  const hash = (n) => { let x = (n + 1) * 2654435761 % 4294967296; x ^= x >>> 13; return (x >>> 0) % 1000; };
  // Many one-line rows (collapsed tool rounds, turn gaps, short prompts),
  // short replies, some long replies and a few very long ones, all estimated
  // at one learned height. A one-line row is shorter than one frame of a fast
  // fling, so it passes from above the screen into it between two frames.
  const settledHeight = (index) => {
    const h = hash(index);
    if (h < 450) return 24 + Math.round(h * 0.08);
    if (h < 800) return 60 + Math.round((h - 450) * 0.6);
    if (h < 960) return 270 + (h - 800) * 4;
    return 900 + (h - 960) * 50;
  };
  const grows = (index) => index % 3 === 0;
  const grown = new Set();
  function Row({ index }) {
    const [settled, setSettled] = useState(() => !grows(index) || grown.has(index));
    useEffect(() => {
      if (settled) return undefined;
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => { grown.add(index); setSettled(true); });
      });
      return () => cancelAnimationFrame(frame);
    }, [settled]);
    const height = settled ? settledHeight(index) : Math.max(40, Math.round(settledHeight(index) * 0.55));
    return <div style={{ height, boxSizing: 'border-box', borderTop: '1px solid #888' }}>row {index}</div>;
  }
  const BASE = Array.from({ length: 1200 }, (_, index) => {
    const key = 'row-' + index;
    return { _tag: 'TurnGap', key, turnKey: key };
  });
  // A reply streaming in (window.startStream): the live row at the tail grows
  // every 60 ms and a new row (a tool round) is appended every 600 ms, each
  // tick handing the list a new row array, as the live projection does.
  let live = { rows: 0, height: 40, ticks: 0 };
  const liveListeners = new Set();
  window.startStream = () => {
    window.setInterval(() => {
      live = { ...live, height: live.height + 18, ticks: live.ticks + 1 };
      if (live.ticks % 10 === 0) live = { ...live, rows: live.rows + 1 };
      window.streamTicks = live.ticks;
      for (const listener of liveListeners) listener(live);
    }, 60);
  };
  function LiveRow({ height }) {
    return <div style={{ height, boxSizing: 'border-box', borderTop: '1px solid #888' }}>live reply</div>;
  }
  function Harness() {
    const viewport = useRef(null), content = useRef(null);
    const scrollToEndRef = useRef(() => {}), setAnchorBottomRef = useRef(() => {});
    const follow = useTranscriptFollow({ viewport, content, sessionKey: 'upward', scrollToEndRef, setAnchorBottomRef });
    const [stream, setStream] = useState(live);
    useEffect(() => {
      liveListeners.add(setStream);
      return () => liveListeners.delete(setStream);
    }, []);
    const ROWS = stream.ticks === 0 ? BASE : [
      ...BASE,
      ...Array.from({ length: stream.rows }, (_, index) => ({ _tag: 'TurnGap', key: 'tool-' + index, turnKey: 'tool-' + index })),
      { _tag: 'TurnGap', key: 'live', turnKey: 'live' },
    ];
    return <div className="transcript" ref={viewport} onScroll={follow.handleScroll} onWheel={follow.handleWheel}
      onTouchStart={follow.handleTouchStart} onTouchMove={follow.handleTouchMove}
      onTouchEnd={follow.handleTouchEnd} onTouchCancel={follow.handleTouchEnd}>
      <div className="thread" ref={content}>
        <TranscriptList sessionKey="upward" rows={ROWS} viewport={viewport} content={content}
          shouldAnchorBottom={follow.following} scrollToEndRef={scrollToEndRef} setAnchorBottomRef={setAnchorBottomRef}
          markProgrammaticScroll={follow.markProgrammaticScroll} hasScrollGesture={follow.hasScrollGesture}
          hasTouchScroll={follow.holdsScrollCorrections} touchHoldsCorrections={follow.touchHoldsCorrections}
          onSelectionAutoScroll={follow.handleSelectionAutoScroll}
          renderRow={(row) =>
            row.key === 'live' ? <LiveRow height={stream.height} />
            : row.key.startsWith('tool-') ? <Row index={Number(row.key.slice(5)) + 1200} />
            : <Row index={Number(row.key.slice(4))} />} />
      </div>
    </div>;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;

// Every programmatic offset write is counted with the distance it moved the
// native offset; every frame records the native offset and where each row on
// screen sits.
const PROBES = `
  window.armProbe = () => {
    const viewport = document.querySelector('.transcript');
    const probe = { writes: 0, written: 0, frames: [] };
    window.probe = probe;
    const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    const read = () => native.get.call(viewport);
    const note = (before) => {
      const moved = read() - before;
      if (moved !== 0) { probe.writes += 1; probe.written += moved; }
    };
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: read,
      set(value) { const before = read(); native.set.call(viewport, value); note(before); },
    });
    const scrollTo = viewport.scrollTo.bind(viewport);
    viewport.scrollTo = (...args) => { const before = read(); scrollTo(...args); note(before); };
    const rowsOnScreen = () => {
      const box = viewport.getBoundingClientRect();
      const seen = {};
      for (const row of viewport.querySelectorAll('.transcript-virtual-row')) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > box.top && rect.top < box.bottom) seen[row.dataset.timelineKey] = rect.top - box.top;
      }
      return seen;
    };
    const frame = () => {
      probe.frames.push({ t: performance.now(), top: read(), written: probe.written, rows: rowsOnScreen() });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
`;

async function fling(cdp, distance) {
  const x = 200;
  let y = 150;
  let time = Date.now() / 1000;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }], timestamp: time });
  for (let step = 0; step < 8; step += 1) {
    y += distance / 8;
    time += 0.016;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }], timestamp: time });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: time + 0.008 });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Per frame: how far the row in the middle of the screen moved (`content`,
 *  positive = down, the way an upward fling moves it), how far the native
 *  offset moved by itself (`fling`, this list's writes taken out) and what
 *  moved the rows besides the fling (`shift`). */
function frameMotion(frames) {
  const motion = [];
  for (let index = 1; index < frames.length; index += 1) {
    const before = frames[index - 1];
    const after = frames[index];
    const common = Object.keys(after.rows).filter((key) => key in before.rows);
    if (common.length === 0) continue;
    const middle = common[Math.floor(common.length / 2)];
    const content = after.rows[middle] - before.rows[middle];
    const fling = after.top - before.top - (after.written - before.written);
    motion.push({ t: after.t, row: middle, content, fling, shift: content + fling });
  }
  return motion;
}

async function openHarness(t) {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const bundle = await build({
    stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
    bundle: true,
    write: false,
    logLevel: 'error',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    plugins: [
      {
        name: 'no-lazy-chunks',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
          );
        },
      },
    ],
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.emulate({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    // A phone's density: the scroller is composited and the fling runs on the
    // compositor thread, apart from the main thread's writes.
    viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  // The transcript's own scroll and row rules (12-transcript.css).
  await page.addStyleTag({
    content: `
      html, body { margin: 0; height: 100%; }
      #root { position: fixed; inset: 0; }
      .transcript { height: 100%; overflow-y: auto; touch-action: pan-y; overflow-anchor: none;
        overscroll-behavior: contain; will-change: scroll-position; }
      .thread { padding: 44px 0 0; }
      .transcript-virtual-space { position: relative; width: 100%; contain: layout style; overflow: hidden; }
      .transcript-virtual-row { position: absolute; top: 0; left: 0; width: 100%; box-sizing: border-box;
        background: #fff; overflow: clip; contain: layout paint; }
    `,
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.addScriptTag({ content: PROBES });
  await page.waitForFunction(() => document.querySelectorAll('.transcript-virtual-row').length > 0);
  await wait(800);
  const cdp = await page.target().createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const top = () => page.evaluate(() => document.querySelector('.transcript').scrollTop);
  assert.ok((await top()) > 20_000, 'the session opens at its tail');
  return { page, cdp, top, errors };
}

/** Upward flings, each left to settle; per-frame motion and each fling's own travel. */
async function upwardFlings({ page, cdp, top }, count, beforeEach = async () => {}) {
  await page.evaluate(() => window.armProbe());
  const marks = [];
  let rest = 0;
  for (let flick = 0; flick < count; flick += 1) {
    await beforeEach();
    marks.push(await page.evaluate(() => performance.now()));
    await fling(cdp, 1_600);
    let previous = -1;
    const deadline = Date.now() + 15_000;
    for (let quiet = 0; quiet < 6; ) {
      assert.ok(Date.now() < deadline, `fling ${flick} settles within 15 s (offset ${previous})`);
      await wait(100);
      const current = await top();
      quiet = current === previous ? quiet + 1 : 0;
      previous = current;
    }
    rest = previous;
  }
  const probe = await page.evaluate(() => window.probe);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const motion = frameMotion(probe.frames);
  // Each fling's own travel: the native motion with this list's writes taken out.
  const travel = marks.map(
    (mark, index) =>
      -motion
        .filter((step) => step.t >= mark && step.t < (marks[index + 1] ?? Number.POSITIVE_INFINITY))
        .reduce((sum, step) => sum + step.fling, 0)
  );
  return { probe, motion, travel, rest };
}

test('on Android an upward touch fling through mis-estimated rows moves the rows on screen only by the fling', async (t) => {
  const harness = await openHarness(t);
  const { probe, motion, travel, rest } = await upwardFlings(harness, 6);
  assert.deepEqual(harness.errors, []);
  const backward = motion.filter((step) => step.content < -2);
  const jumps = motion.filter((step) => Math.abs(step.shift) > 2);
  const summary = `${probe.writes} corrections over ${motion.length} frames`;
  assert.deepEqual(backward, [], `the rows on screen never move against the fling (${summary})`);
  assert.deepEqual(jumps, [], `the rows on screen move only by the fling (${summary})`);
  assert.ok(rest > 0, 'older rows remain above after the flings');
  for (const [index, distance] of travel.entries()) {
    assert.ok(distance > 3_000, `fling ${index} ran its course (${travel.join(', ')}px)`);
  }
});

// The phone app (APK): a fling stops "every time the transcript updates".
// While a reply streams in at the tail (the live row grows every 60 ms, a row
// is appended every 600 ms), each upward fling starts at the followed tail —
// the live row on screen — and must run its course with no stop, no motion
// against it and no jump on top of it.
test('on Android an upward touch fling from the tail runs its course while a reply streams in', async (t) => {
  const harness = await openHarness(t);
  const { page } = harness;
  await page.evaluate(() => window.startStream());
  await wait(500);
  const toTail = async () => {
    // Back at the followed tail between flings, as a reader who returned there.
    await page.evaluate(() => {
      const viewport = document.querySelector('.transcript');
      viewport.scrollTop = viewport.scrollHeight;
    });
    await wait(600);
  };
  const ticksBefore = await page.evaluate(() => window.streamTicks);
  const { probe, motion, travel } = await upwardFlings(harness, 5, toTail);
  assert.deepEqual(harness.errors, []);
  // The reply kept streaming through the flings (a 4x-throttled main thread
  // still ran its updates).
  assert.ok((await page.evaluate(() => window.streamTicks)) - ticksBefore > 50, 'the reply streamed during the flings');
  // The tail-return writes are the test's own; only frames inside a fling count.
  const backward = motion.filter((step) => step.content < -2 && step.fling < 0);
  const summary = `${probe.writes} writes over ${motion.length} frames`;
  assert.deepEqual(backward, [], `the rows on screen never move against the fling (${summary})`);
  for (const [index, distance] of travel.entries()) {
    assert.ok(distance > 3_000, `fling ${index} ran its course while streaming (${travel.join(', ')}px)`);
  }
});
