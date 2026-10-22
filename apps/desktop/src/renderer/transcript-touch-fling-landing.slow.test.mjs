import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Android phone, long session: the reader flings toward older history and the
// next page lands above them mid-fling. Held as a row offset (a translateY of
// the row space), the page stayed outside the native scroll range, so the
// fling ran into native 0 at the old first row and stopped there, mid-history
// (phone: 위로 스크롤하면 중간에 멈춘다). Chromium keeps a touch fling's
// momentum through a scrollTop write, so off iOS WebKit the landing is written
// at once and the same fling carries on into the page. Headless Chromium runs
// the same fling (a stream of scroll deltas) as Android Chrome and its
// WebView, not their fling curve or any device-only input path.

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

test('on Android a page landing above a touch fling is written at once and the fling carries on into it', async (t) => {
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
  assert.ok(
    landed.after - landed.before > landed.page - 1_000,
    `the landing is one native write by the page (${landed.before} -> ${landed.after}, page ${landed.page})`
  );
  assert.deepEqual(
    frames.filter((frame) => frame.transform),
    [],
    'nothing is held as a row offset'
  );
  // The momentum went on after the write: the native offset kept falling.
  assert.ok(frames.length > 2 && frames.at(-1).top < frames[0].top - 1, 'the fling keeps moving after the landing');
  // It carried on past the old first row into the landed page instead of
  // stopping at native 0 with the page out of reach above it.
  assert.ok(previous < landed.page, `the fling went on into the page (rest ${previous}, page ${landed.page})`);
});
