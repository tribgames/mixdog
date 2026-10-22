import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Phone, long session: the reader flings toward older history and the next
// page lands above them mid-fling. A touch fling holds that landing as a row
// offset (a translateY of the row space): on an Android phone a scrollTop
// write under the fling desyncs it until the next touch jumps (위로 빠르게
// 넘기면 멈추고, 다시 터치하면 훨씬 위로 순간이동). The native offset stays short
// of the logical one by the page, so the fling runs into native 0 at the old
// first row. Landing the hold there was still a write under the momentum —
// headless Chromium flings on through it, a phone does not (phone: 위로
// 스크롤하면 여전히 멈췄다가 튄다) — so the hold waits for the fling to end
// there too, and the page is reachable from the next touch on.

const HARNESS = `
  import { useLayoutEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { TranscriptList } from './TranscriptList';
  import { useTranscriptFollow } from './use-transcript-follow';

  const heightOf = (key) => 180 + ((Number(key.slice(4)) * 37) % 320);
  const rowsFrom = (from, to) => Array.from({ length: to - from }, (_, offset) => {
    const key = 'row-' + (from + offset);
    return { _tag: 'TurnGap', key, turnKey: key };
  });
  function Harness() {
    const [rows, setRows] = useState(() => rowsFrom(100, 160));
    const viewport = useRef(null), content = useRef(null);
    const scrollToEndRef = useRef(() => {}), setAnchorBottomRef = useRef(() => {});
    const follow = useTranscriptFollow({ viewport, content, sessionKey: 'fling', scrollToEndRef, setAnchorBottomRef });
    useLayoutEffect(() => {
      window.fixture = {
        land: () => flushSync(() => setRows([...rowsFrom(40, 100), ...rowsFrom(100, 160)])),
        pageHeight: () => rowsFrom(40, 100).reduce((sum, row) => sum + heightOf(row.key), 0),
      };
    });
    return <div className="transcript" ref={viewport} onScroll={follow.handleScroll} onWheel={follow.handleWheel}
      onTouchStart={follow.handleTouchStart} onTouchMove={follow.handleTouchMove}
      onTouchEnd={follow.handleTouchEnd} onTouchCancel={follow.handleTouchEnd}>
      <div className="thread" ref={content}>
        <TranscriptList sessionKey="fling" rows={rows} viewport={viewport} content={content}
          shouldAnchorBottom={follow.following} scrollToEndRef={scrollToEndRef} setAnchorBottomRef={setAnchorBottomRef}
          markProgrammaticScroll={follow.markProgrammaticScroll} hasScrollGesture={follow.hasScrollGesture}
          hasTouchScroll={follow.holdsScrollCorrections} touchHoldsCorrections={follow.touchHoldsCorrections}
          onSelectionAutoScroll={follow.handleSelectionAutoScroll}
          renderRow={(row) => <div style={{ height: heightOf(row.key) }}>{row.key}</div>} />
      </div>
    </div>;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;

// The landing fires from the scroll event that first crosses the arm line,
// i.e. inside the fling. Every frame is sampled from then on.
const PROBES = `
  window.armLanding = (line) => {
    const viewport = document.querySelector('.transcript');
    const space = viewport.querySelector('.transcript-virtual-space');
    const state = { landed: null, frames: [] };
    window.landing = state;
    viewport.addEventListener('scroll', () => {
      if (state.landed || viewport.scrollTop > line) return;
      const before = viewport.scrollTop;
      window.fixture.land();
      state.landed = { before, after: viewport.scrollTop, page: window.fixture.pageHeight() };
    });
    const frame = () => {
      if (state.landed) state.frames.push({ top: viewport.scrollTop, transform: space.style.transform });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
`;

async function fling(cdp, distance) {
  const x = 200;
  let y = 200;
  let time = Date.now() / 1000;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }], timestamp: time });
  for (let step = 0; step < 10; step += 1) {
    y += distance / 10;
    time += 0.016;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }], timestamp: time });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: time + 0.008 });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a page landing above a touch fling is held through the momentum, at native 0 too, and lands once it ends', async (t) => {
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
    viewport: { width: 412, height: 915, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({
    content: `
      html, body { margin: 0; height: 100%; }
      #root { position: fixed; inset: 0; }
      .transcript { height: 100%; overflow-y: auto; touch-action: pan-y; }
      .transcript-virtual-space { position: relative; width: 100%; }
      .transcript-virtual-row { position: absolute; top: 0; left: 0; width: 100%; }
    `,
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.addScriptTag({ content: PROBES });
  await page.waitForFunction(() => document.querySelectorAll('.transcript-virtual-row').length > 0);
  await wait(500);
  const cdp = await page.target().createCDPSession();
  const top = () => page.evaluate(() => document.querySelector('.transcript').scrollTop);
  assert.ok((await top()) > 10_000, 'the session opens at its tail');

  // Fling toward older history; the page lands once the fling crosses 1500px.
  await page.evaluate(() => window.armLanding(1500));
  for (let attempt = 0; attempt < 40 && !(await page.evaluate(() => window.landing.landed)); attempt += 1) {
    await fling(cdp, 600);
    await wait(250);
  }
  const landed = await page.evaluate(() => window.landing.landed);
  assert.ok(landed, 'the page landed during a fling');
  // Let the fling run out.
  let previous = -1;
  for (let quiet = 0; quiet < 6; ) {
    await wait(100);
    const current = await top();
    quiet = current === previous ? quiet + 1 : 0;
    previous = current;
  }
  const frames = await page.evaluate(() => window.landing.frames);
  assert.deepEqual(errors, []);
  assert.ok(Math.abs(landed.after - landed.before) < 1, 'the landing writes nothing under the fling');
  const held = frames.filter((frame) => frame.transform);
  assert.ok(held.length > 0, 'the landing is held as a row offset under the fling');
  // The page's hold: the frames from the landing until its row offset drops.
  const first = frames.indexOf(held[0]);
  const end = frames.findIndex((frame, index) => index > first && !frame.transform);
  assert.ok(end > first && !frames.at(-1).transform, 'the hold lands once the fling is over');
  assert.ok(
    frames[end].top - frames[end - 1].top > landed.page - 1_000,
    `its one write moves the native offset by the page (${frames[end - 1].top} -> ${frames[end].top}, page ${landed.page})`
  );
  // The write came after the momentum: the native offset had stopped moving.
  assert.ok(end >= 2 && frames[end - 1].top === frames[end - 2].top, 'no write lands under the momentum');
  // The fling rested at the old first row (native 0 under the hold), with the
  // page reachable above it once the hold landed.
  assert.ok(previous > landed.page - 1_000, `the fling rests at the old top (rest ${previous}, page ${landed.page})`);
});
