import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// The Sessions view stays mounted behind the other rail pages, its panel
// `hidden` (display:none). A hidden scroller reads scrollTop 0 and ignores
// writes; Chromium puts the real scrollTop back when the panel shows again,
// with no scroll event. A list that started windowing in between (it crossed
// 40 rows, e.g. a page revealed by the paging observer, which fires on the
// hidden scroller's zero rect) attached its virtualizer at offset 0, and the
// virtualizer only learns an offset from scroll events: it kept rendering the
// rows near the top while the viewport sat far below, so the list showed
// blank space except its pinned rows until the reader scrolled 1px.
// Attaching while visible wrote that same 0 offset into the scroller and threw
// the list to its top. The real VirtualSessionRows runs in real Chrome (jsdom
// has no display:none scroll semantics).

const ROW_PITCH = 32;
const VIEWPORT = 300;

const HARNESS = `
  import { useMemo, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { VirtualSessionRows } from './session-sidebar-virtual-rows';

  const scrollerRef = { current: null };
  const pinned = new Set();
  function Harness() {
    const [count, setCount] = useState(40);
    window.setCount = setCount;
    const items = useMemo(
      () => Array.from({ length: count }, (_, index) => ({ key: 'row:' + index, sessionId: 's-' + index })),
      [count]
    );
    return <div id="host">
      <div id="scroller" ref={scrollerRef} style={{ height: ${VIEWPORT}, overflowY: 'auto' }}>
        <div id="list" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <VirtualSessionRows items={items} scrollerRef={scrollerRef} pinnedIds={pinned}
            renderItem={(item) => <div key={item.key} className="session-row" data-session-id={item.sessionId}
              style={{ height: 31 }}>{item.sessionId}</div>} />
        </div>
      </div>
    </div>;
  }
  createRoot(document.getElementById('root')).render(<Harness />);

  window.nextFrames = (count) => new Promise((resolve) => {
    let seen = 0;
    const step = () => (++seen >= count ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  window.scrollEvents = 0;
  document.addEventListener('scroll', () => { window.scrollEvents += 1; }, true);
  // What the reader sees: the scroll offset, the mounted row indexes, and the
  // spacers (blank space) that overlap the viewport.
  window.snapshot = () => {
    const scroller = document.getElementById('scroller');
    const view = scroller.getBoundingClientRect();
    const blank = [...scroller.querySelectorAll('.session-list-spacer')].filter((spacer) => {
      const box = spacer.getBoundingClientRect();
      return box.bottom > view.top + 1 && box.top < view.bottom - 1;
    }).length;
    return {
      top: scroller.scrollTop,
      indexes: [...scroller.querySelectorAll('.session-row')].map((row) => Number(row.dataset.sessionId.slice(2))),
      blank,
    };
  };
`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assets = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };

async function buildHarness() {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const bundle = await build({
    stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
    bundle: true,
    write: false,
    logLevel: 'error',
    format: 'iife',
    jsx: 'automatic',
    outfile: 'harness.js',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: assets,
  });
  return bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
}

async function openList(browser, script, count) {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 400 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(
    '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
  );
  await page.addScriptTag({ content: script });
  await page.evaluate(async (rows) => {
    await window.nextFrames(2);
    if (rows !== 40) window.setCount(rows);
    await window.nextFrames(3);
  }, count);
  return { page, errors };
}

/** Every row the viewport shows at `top` is mounted, and no spacer covers it. */
function assertViewportRendered(snapshot, count, label) {
  const first = Math.floor(snapshot.top / ROW_PITCH);
  const last = Math.min(count - 1, Math.floor((snapshot.top + VIEWPORT - 1) / ROW_PITCH));
  const missing = [];
  for (let index = first; index <= last; index += 1) if (!snapshot.indexes.includes(index)) missing.push(index);
  assert.deepEqual(missing, [], `${label}: rows in the viewport are mounted (scrollTop ${snapshot.top})`);
  assert.equal(snapshot.blank, 0, `${label}: no spacer covers the viewport`);
}

test('a windowed Sessions list shows its rows at the scroll position after its panel was hidden', async (t) => {
  const script = await buildHarness();
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());

  await t.test('a list that crossed 40 rows while hidden', async () => {
    const { page, errors } = await openList(browser, script, 40);
    const READER_TOP = 900;
    assert.equal(
      await page.evaluate(async (top) => {
        document.getElementById('scroller').scrollTop = top;
        await window.nextFrames(3);
        return window.snapshot().indexes.length;
      }, READER_TOP),
      40,
      'the 40-row list is not windowed yet'
    );
    // The panel hides; more rows arrive while it is hidden.
    const hidden = await page.evaluate(async () => {
      document.getElementById('host').hidden = true;
      await window.nextFrames(3);
      window.setCount(80);
      await window.nextFrames(3);
      return document.getElementById('scroller').scrollTop;
    });
    assert.equal(hidden, 0, 'a hidden scroller reads scrollTop 0');
    // The panel shows again; no scroll event is dispatched for the restore.
    const shown = await page.evaluate(async () => {
      const before = window.scrollEvents;
      document.getElementById('host').hidden = false;
      await window.nextFrames(4);
      return { ...window.snapshot(), scrollEvents: window.scrollEvents - before };
    });
    assert.equal(shown.top, READER_TOP, 'the scroll position survives');
    assert.equal(shown.scrollEvents, 0, 'the restore raised no scroll event');
    assertViewportRendered(shown, 80, 'shown again');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('a list that was windowed all along keeps its window on the quantized offset', async () => {
    const { page, errors } = await openList(browser, script, 200);
    const READER_TOP = 3000;
    await page.evaluate(async (top) => {
      document.getElementById('scroller').scrollTop = top;
      await window.nextFrames(3);
      document.getElementById('host').hidden = true;
      await window.nextFrames(3);
      document.getElementById('host').hidden = false;
      await window.nextFrames(4);
    }, READER_TOP);
    const shown = await page.evaluate(() => window.snapshot());
    assert.equal(shown.top, READER_TOP);
    assertViewportRendered(shown, 200, 'shown again');
    // The window still moves in steps of 8 rows (VIRTUAL_ROWS_STEP) with 12
    // rows of overscan above it.
    assert.equal(Math.min(...shown.indexes), Math.floor(READER_TOP / (8 * ROW_PITCH)) * 8 - 12);
    assert.ok(shown.indexes.length < 80, `still windowed (${shown.indexes.length} rows)`);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('a list crossing 40 rows while visible keeps its scroll position', async () => {
    const { page, errors } = await openList(browser, script, 40);
    const READER_TOP = 900;
    const grown = await page.evaluate(async (top) => {
      document.getElementById('scroller').scrollTop = top;
      await window.nextFrames(3);
      window.setCount(80);
      await window.nextFrames(4);
      return window.snapshot();
    }, READER_TOP);
    assert.equal(grown.top, READER_TOP, 'windowing does not throw the list to its top');
    assertViewportRendered(grown, 80, 'grown');
    assert.deepEqual(errors, []);
    await page.close();
  });
});
