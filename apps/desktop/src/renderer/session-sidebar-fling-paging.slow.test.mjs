import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// Phone, Sessions list of 300 sessions: the reader flicks fast down the list.
// The list reveals its rows a page at a time; the next page used to be
// revealed only once the end came within 240px, so a fast fling crossed that
// band in a few frames and ran into the end of the revealed rows before the
// page committed: the momentum died there and the rows appeared under a list
// at rest (Android: 빠르게 손가락으로 스크롤하고 놓으니 중간에 멈추고 덜덜). The
// first flick after returning from background hit it every time: the wake's
// resync holds the main thread while the fling runs.

const HARNESS = `
  import { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { SessionSidebar } from './session-sidebar';

  const session = (index, at) => ({
    id: 's-' + index, title: 'Session ' + index, preview: '', updatedAt: at, activityAt: at,
    messageCount: 2, cwd: '', classification: 'task', projectPath: null, working: false,
  });
  const noop = () => {};
  const none = async () => {};
  function Harness() {
    const [sessions, setSessions] = useState(() => Array.from({ length: 300 }, (_, index) => session(index, 1e6 - index)));
    // The wake resync re-sends the whole catalog: same rows, new objects.
    window.resync = () => setSessions((rows) => rows.map((row) => ({ ...row })));
    return <SessionSidebar open sessions={sessions} sessionsReady selection={{ kind: 'new' }} onNewTask={noop}
      onNewStudio={noop} onResumeSession={noop} onRenameSession={none} onArchiveSession={none}
      onFavoriteSession={none} onDeleteSession={none} />;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;

// Samples every frame: the offset, the revealed end, and whether rows are
// still unrevealed (the paging sentinel is mounted). With a resume block
// armed, the first finger lift starts a main-thread block (the resync's
// catalog commit and decoding) while the fling runs.
const PROBES = `
  window.arm = (blockMs) => {
    const scroller = document.querySelector('.session-sidebar-sessions .session-sidebar-scroll');
    const state = { frames: [], blocked: false };
    window.probe = state;
    const frame = () => {
      state.frames.push({
        top: Math.round(scroller.scrollTop),
        max: scroller.scrollHeight - scroller.clientHeight,
        more: Boolean(scroller.querySelector('.session-list-sentinel')),
      });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    if (!blockMs) return;
    document.addEventListener('touchend', () => {
      if (state.blocked) return;
      state.blocked = true;
      setTimeout(() => {
        window.resync();
        const end = performance.now() + blockMs;
        while (performance.now() < end);
      }, 30);
    }, true);
  };
`;

async function flick(cdp, x, fromY, toY) {
  let time = Date.now() / 1000;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }], timestamp: time });
  for (let step = 1; step <= 3; step += 1) {
    time += 0.016;
    const y = fromY + ((toY - fromY) * step) / 3;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }], timestamp: time });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: time + 0.008 });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assets = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' };
const noLazyChunks = {
  name: 'no-lazy-chunks',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

async function buildHarness() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
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
      outfile: 'session-sidebar-fling.css',
      bundle: true,
      write: false,
      logLevel: 'error',
      loader: { ...assets, '.jpg': 'dataurl' },
    }),
  ]);
  return {
    script: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
    css: styles.outputFiles.find((file) => file.path.endsWith('.css')).text,
  };
}

/** A phone page showing the list at its top; returns its CDP session and the list box. */
async function openPhoneList(browser, harness) {
  const page = await browser.newPage();
  await page.emulate({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // A real origin: the sidebar keeps its list preferences in localStorage.
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.respond({
      contentType: 'text/html',
      body: '<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
    })
  );
  await page.goto('http://sidebar.test/');
  await page.addStyleTag({
    content: `${harness.css}
      html, body { margin: 0; height: 100%; }
      #root { position: fixed; inset: 0; display: flex; }
      #root > .session-sidebar { flex: 1 1 auto; width: 100%; max-width: none; height: 100%; }`,
  });
  await page.addScriptTag({ content: harness.script });
  await page.addScriptTag({ content: PROBES });
  await page
    .waitForFunction(() => document.querySelectorAll('.recent-session-list .session-row[data-session-id]').length > 0, {
      timeout: 10_000,
    })
    .catch((error) => {
      throw new Error(`${error.message}\n${errors.join('\n')}`);
    });
  await wait(800);
  const box = await page.evaluate(() => {
    const scroller = document.querySelector('.session-sidebar-sessions .session-sidebar-scroll');
    const rect = scroller.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      top: rect.top,
      bottom: Math.min(rect.bottom, window.innerHeight),
      height: scroller.clientHeight,
      revealedEnd: scroller.scrollHeight - scroller.clientHeight,
    };
  });
  assert.ok(box.height > 300, `the list has a phone-sized viewport (${box.height}px)`);
  const cdp = await page.target().createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  return { page, cdp, box, errors };
}

/** Waits for the list to come to rest; returns every sampled frame. */
async function framesAtRest(page) {
  let previous = -1;
  for (let quiet = 0; quiet < 6; ) {
    await wait(100);
    const current = await page.evaluate(() => window.probe.frames.at(-1).top);
    quiet = current === previous ? quiet + 1 : 0;
    previous = current;
  }
  return page.evaluate(() => window.probe.frames);
}

/** Offsets where the list stood against an end its revealed rows had while
 *  sessions were still unrevealed: the fling ran into the paging edge. The
 *  next page often commits in the very frame the fling hits, so the edge is
 *  any revealed end seen so far, not only the current one. */
function stuckAtRevealedEnd(frames) {
  const ends = new Set();
  const stuck = new Set();
  for (const frame of frames) {
    if (frame.more) ends.add(frame.max);
    if (frame.top > 0 && [...ends].some((end) => Math.abs(end - frame.top) <= 1)) stuck.add(frame.top);
  }
  return [...stuck];
}

test('fast phone flicks down a long session list are never stopped by the end of its revealed rows', async (t) => {
  const harness = await buildHarness();
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());

  await t.test('several fast flicks from the top', async () => {
    const { page, cdp, box, errors } = await openPhoneList(browser, harness);
    // A phone's main thread: each revealed page's commit takes a while.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => window.arm(0));
    for (let count = 0; count < 3; count += 1) {
      await flick(cdp, box.x, box.bottom - 40, box.top + 60);
      await wait(150);
    }
    const frames = await framesAtRest(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(stuckAtRevealedEnd(frames), [], 'the fling never ran into the end of the revealed rows');
    const rest = frames.at(-1).top;
    assert.ok(
      rest > box.revealedEnd + box.height,
      `the flicks carried far past the rows revealed at first (rest ${rest}, first revealed end ${box.revealedEnd})`
    );
    await page.close();
  });

  await t.test('the first flick after returning from background, under the wake resync', async () => {
    const { page, cdp, box, errors } = await openPhoneList(browser, harness);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // Background and back: frozen, then active, focused and visible again.
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await wait(300);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    // The resync lands right after the finger lifts and holds the main thread.
    await page.evaluate(() => window.arm(400));
    await flick(cdp, box.x, box.bottom - 40, box.top + 60);
    const frames = await framesAtRest(page);
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => window.probe.blocked), 'the resync block ran during the fling');
    assert.deepEqual(stuckAtRevealedEnd(frames), [], 'the fling never ran into the end of the revealed rows');
    const rest = frames.at(-1).top;
    // One flick decays well before the list's end; it must not stop short of
    // what its momentum carries (two list heights here) at a paging edge.
    assert.ok(rest > box.height * 2, `the fling carried on through the resync (rest ${rest})`);
    await page.close();
  });
});
