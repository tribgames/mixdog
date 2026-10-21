import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// Phone, Sessions list: the reader flings down the list while a live catalog
// update re-sorts it by activity (the row at the top of their screen just
// finished a turn). The update used to land under the moving list: rows
// changed places on screen, and the scroll anchor followed the re-sorted row
// to its new place at the top of Recent, throwing the list back (phone: 세션
// 사이드패널 리스트 스크롤할 때도 모바일에서 엄청 튐). The update now holds until
// the scroll is over and then lands with the reader's rows in place.

const HARNESS = `
  import { useLayoutEffect, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { flushSync } from 'react-dom';
  import { SessionSidebar } from './session-sidebar';

  const session = (index, at) => ({
    id: 's-' + index, title: 'Session ' + index, preview: '', updatedAt: at, activityAt: at,
    messageCount: 2, cwd: '', classification: 'task', projectPath: null, working: false,
  });
  const noop = () => {};
  const none = async () => {};
  function Harness() {
    const [sessions, setSessions] = useState(() => Array.from({ length: 200 }, (_, index) => session(index, 1e6 - index)));
    useLayoutEffect(() => {
      window.fixture = {
        // These sessions get activity: each moves to the top of Recent.
        bump: (ids) => flushSync(() => setSessions((current) =>
          current.map((row, index) => (ids.includes(row.id) ? { ...row, activityAt: 2e6 + index, updatedAt: 2e6 + index } : row)))),
      };
    });
    return <SessionSidebar open sessions={sessions} sessionsReady selection={{ kind: 'new' }} onNewTask={noop}
      onNewStudio={noop} onResumeSession={noop} onRenameSession={none} onArchiveSession={none}
      onFavoriteSession={none} onDeleteSession={none} />;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;

// Samples every frame: scrollTop and each visible Recent row's screen offset.
// Once the list crosses `line` during the fling, the reader's top row and a
// row far below get activity.
const PROBES = `
  window.arm = (line) => {
    const scroller = document.querySelector('.session-sidebar-sessions .session-sidebar-scroll');
    const state = { bumped: null, frames: [], writes: [] };
    window.probe = state;
    // The page's own scrollTop writes (the anchor compensation), by frame.
    const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get() { return native.get.call(this); },
      set(value) { state.writes.push(state.frames.length); native.set.call(this, value); },
    });
    const visible = () => {
      const top = scroller.getBoundingClientRect().top;
      const rows = {};
      for (const row of scroller.querySelectorAll('.recent-session-list .session-row[data-session-id]')) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > top && rect.top < top + scroller.clientHeight) rows[row.dataset.sessionId] = rect.top - top;
      }
      return rows;
    };
    scroller.addEventListener('scroll', () => {
      if (state.bumped || scroller.scrollTop < line) return;
      const [reader] = Object.keys(visible());
      state.bumped = { reader, ids: [reader, 's-190'], at: state.frames.length };
      window.fixture.bump(state.bumped.ids);
    });
    const frame = () => {
      const head = scroller.querySelector('.recent-session-list .session-row[data-session-id]');
      state.frames.push({ top: scroller.scrollTop, rows: visible(), head: head?.dataset.sessionId });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
`;

async function fling(cdp, x, fromY, toY) {
  let time = Date.now() / 1000;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }], timestamp: time });
  for (let step = 1; step <= 10; step += 1) {
    time += 0.016;
    const y = fromY + ((toY - fromY) * step) / 10;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }], timestamp: time });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: time + 0.008 });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noLazyChunks = {
  name: 'no-lazy-chunks',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

test('a re-sort by activity during a phone fling holds until the list rests, then keeps the reader’s rows', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const assets = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      bundle: true,
      write: false,
      logLevel: 'error',
      format: 'iife',
      jsx: 'automatic',
      outfile: 'harness.js',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: assets,
      plugins: [noLazyChunks],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'session-sidebar-touch.css',
      bundle: true,
      write: false,
      logLevel: 'error',
      loader: { ...assets, '.jpg': 'dataurl' },
    }),
  ]);
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.emulate({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // A real origin: the sidebar keeps its list preferences in localStorage.
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.respond({
      contentType: 'text/html',
      body: '<!doctype html><html data-mixdog-mobile-tabs><head></head><body><div id="root"></div></body></html>',
    })
  );
  await page.goto('http://sidebar.test/');
  await page.addStyleTag({
    content: `${styles.outputFiles.find((file) => file.path.endsWith('.css')).text}
      html, body { margin: 0; height: 100%; }
      #root { position: fixed; inset: 0; display: flex; }
      #root > .session-sidebar { flex: 1 1 auto; width: 100%; max-width: none; height: 100%; }`,
  });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.addScriptTag({ content: PROBES });
  await page
    .waitForFunction(() => document.querySelectorAll('.recent-session-list .session-row[data-session-id]').length > 0, {
      timeout: 10_000,
    })
    .catch((error) => {
      throw new Error(`${error.message}\n${errors.join('\n')}`);
    });
  const box = await page.evaluate(async () => {
    const scroller = document.querySelector('.session-sidebar-sessions .session-sidebar-scroll');
    // Reveal every Recent page first, then start from the top.
    for (let page = 0; page < 10; page += 1) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    scroller.scrollTop = 0;
    const rect = scroller.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, height: scroller.clientHeight };
  });
  await wait(600);
  assert.ok(box.height > 300, `the list has a phone-sized viewport (${box.height}px)`);
  const cdp = await page.target().createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  // Fling down the list; the re-sort fires once it has passed 600px.
  await page.evaluate(() => window.arm(600));
  for (let attempt = 0; attempt < 12 && !(await page.evaluate(() => window.probe.bumped)); attempt += 1) {
    await fling(cdp, box.x, box.bottom - 40, box.bottom - 340);
    await wait(150);
  }
  const bumped = await page.evaluate(() => window.probe.bumped);
  assert.ok(bumped?.reader, 'the re-sort arrived during a fling');
  let previous = -1;
  for (let quiet = 0; quiet < 6; ) {
    await wait(100);
    const current = await page.evaluate(() => window.probe.frames.at(-1).top);
    quiet = current === previous ? quiet + 1 : 0;
    previous = current;
  }
  await wait(400);
  const { frames, writes } = await page.evaluate(() => window.probe);
  // Recent's head, read at the top of the list (the window mounts only the rows near the viewport).
  const order = await page.evaluate(async () => {
    const scroller = document.querySelector('.session-sidebar-sessions .session-sidebar-scroll');
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return [...document.querySelectorAll('.recent-session-list .session-row[data-session-id]')]
      .slice(0, 2)
      .map((row) => row.dataset.sessionId);
  });
  assert.deepEqual(errors, []);

  const moving = (index) => frames[index].top !== frames[index - 1].top;
  // The re-sort's landing: its anchor compensation (s-190 lands above the
  // reader) is the page's first scrollTop write after the re-sort.
  const landing = writes.find((frame) => frame >= bumped.at) ?? -1;
  const backward = [];
  const reordered = [];
  for (let index = Math.max(1, bumped.at); index < (landing > 0 ? landing : frames.length); index += 1) {
    const before = frames[index - 1];
    const after = frames[index];
    if (after.top < before.top - 0.5) backward.push(`${before.top} -> ${after.top}`);
    const shifts = Object.keys(after.rows)
      .filter((id) => id in before.rows)
      .map((id) => ({ id, shift: after.rows[id] - before.rows[id] }));
    if (!shifts.length) continue;
    const content = shifts.map(({ shift }) => shift).sort((a, b) => a - b)[Math.floor(shifts.length / 2)];
    // Scrolling down moves the rows up: a row moving down is the list
    // jumping against the finger.
    if (content > 0.5) backward.push(`rows moved down ${content.toFixed(1)}px at frame ${index}`);
    const odd = shifts.filter(({ shift }) => Math.abs(shift - content) > 1).map(({ id }) => id);
    if (odd.length) reordered.push(`frame ${index}: ${odd.join(',')}`);
  }
  assert.deepEqual(backward, [], 'the list never moves against the fling');
  assert.deepEqual(reordered, [], 'no row changes place on screen');
  assert.deepEqual(new Set(order), new Set(bumped.ids), 'the re-sort landed');
  assert.ok(landing > 0, 'the re-sort compensated the rows it put above the reader');
  // The list had come to rest (several still frames) before it landed.
  assert.ok(
    [1, 2, 3, 4, 5].every((back) => !moving(landing - back)),
    'the re-sort lands only once the list is at rest'
  );
  // The landing (a list at rest) keeps the reader's top row where it was;
  // only the slot the re-sorted row left closes.
  const [top] = Object.keys(frames[landing].rows).filter((id) => id in frames[landing - 1].rows);
  assert.ok(
    Math.abs(frames[landing].rows[top] - frames[landing - 1].rows[top]) <= 0.5,
    `the reader's top row ${top} stays put when the re-sort lands`
  );
});
