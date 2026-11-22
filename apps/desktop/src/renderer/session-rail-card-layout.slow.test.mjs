import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import {
  PANE_READING_COLUMN_MAX,
  SESSION_RAIL_GAP,
  SESSION_RAIL_MIN_WIDTH,
  sessionRailFit,
} from './session-rail-layout.ts';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };

// A pane cell with its conversation (the app's own elements and styles) and
// the session panel's card over it.
const HARNESS = `
  import { createRoot } from 'react-dom/client';
  import { installScrollbarMetrics } from './scrollbar-metrics';
  import { SessionRailCard } from './SessionRailCard';

  function Pane({ card }) {
    return <div className="pane-cell" style={{ height: 700 }}>
      <div className="workspace-tabs-shell" style={{ height: 44 }} />
      <div className="pane-surface-stack">
        <div className="pane-surface-handoff-layer">
          <div className="pane-conversation-slot">
            <div className="conversation-persistent-surface">
              <div className="workspace">
                <div className="conversation">
                  <div className="transcript-shell">
                    <div className="transcript">
                      <div className="probe-row" style={{ maxWidth: 'var(--pane-scroll-column)', marginInline: 'auto', height: 3000 }} />
                    </div>
                  </div>
                  <div className="composer-region"><div className="probe-composer" style={{ height: 60 }} /></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {card > 0 && <SessionRailCard leafId="leaf" sessionId="s" width={card} />}
    </div>;
  }
  let root;
  window.mountFixture = (card) => {
    installScrollbarMetrics();
    root ??= createRoot(document.getElementById('root'));
    root.render(<Pane card={card} />);
  };
  window.measure = () => {
    const box = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
    };
    const scroller = document.querySelector('.transcript');
    const slot = document.querySelector('.session-rail-body');
    if (slot && !slot.firstChild) slot.innerHTML = '<div class="session-rail-content"><section class="session-rail-sec" style="height:120px"></section></div>';
    return {
      cell: box('.pane-cell'),
      strip: box('.workspace-tabs-shell'),
      scroller: box('.transcript'),
      scrollbar: scroller.offsetWidth - scroller.clientWidth,
      row: box('.probe-row'),
      composer: box('.composer-region'),
      card: box('.session-rail'),
      sheet: box('.session-rail-sec'),
    };
  };
`;

test("the session panel's cards stand in the margin of the conversation: nothing in it moves for them", async (t) => {
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'session-rail-card-layout.js',
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://localhost/renderer/"' },
      loader,
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'session-rail-card-layout.css',
      bundle: true,
      write: false,
      loader,
    }),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack.split('\n').slice(0, 4).join(' <- ')));
  await page.setContent('<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>');
  const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'));
  if (css) await page.addStyleTag({ content: css.text });
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: 'window.process = { env: {}, platform: "win32", argv: [], versions: {} };' });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  assert.deepEqual(errors, [], 'the fixture loads');
  const at = async (width, card) => {
    await page.setViewport({ width, height: 800 });
    await page.evaluate((next) => window.mountFixture(next), card);
    await page.evaluate(() => window.measure());
    await new Promise((resolve) => setTimeout(resolve, 100));
    return page.evaluate(() => window.measure());
  };
  const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} ≠ ${expected}`);

  // A wide pane: the margin beside the reading column holds the cards, so nothing moves.
  const bare = await at(2000, 0);
  const wide = await at(2000, 400);
  near(wide.row.left, bare.row.left, 'the reading column stays where it was');
  near(wide.row.right, bare.row.right, 'the reading column stays where it was');
  near(wide.composer.right, bare.composer.right, 'the composer too');
  near(wide.scroller.right, wide.cell.right, "the scrollbar on the pane's edge");
  near(wide.card.right, wide.cell.right - 8, "the cards leave the scrollbar's lane");
  near(wide.card.top, wide.strip.bottom, 'under the tab strip');
  assert.ok(wide.card.left >= wide.row.right, 'beside the reading column');
  assert.ok(wide.card.bottom < wide.cell.bottom - 300, 'the column hugs its cards');
  assert.ok(wide.sheet.right - wide.sheet.left > 300, 'the cards take the column');

  // The narrowest pane the layout shows them in, at their narrowest: still clear of the reading column.
  const pane = PANE_READING_COLUMN_MAX + 2 * (SESSION_RAIL_MIN_WIDTH + SESSION_RAIL_GAP);
  assert.equal(sessionRailFit({ cellWidth: pane, dockWidth: 0, railPref: 400 }), SESSION_RAIL_MIN_WIDTH);
  const plain = await at(pane, 0);
  const tight = await at(pane, SESSION_RAIL_MIN_WIDTH);
  near(tight.row.right, plain.row.right, 'the reading column stays where it was');
  near(tight.scroller.right, plain.scroller.right, 'and so does the scrollbar');
  assert.ok(tight.card.left >= tight.row.right, `beside the reading column: ${tight.card.left} < ${tight.row.right}`);
  assert.ok(tight.card.left >= tight.composer.right, 'and beside the composer');
  assert.deepEqual(errors, []);
});
