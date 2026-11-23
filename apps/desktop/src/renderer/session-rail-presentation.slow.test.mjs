import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout.ts';
import { SESSION_RAIL_GAP, SESSION_RAIL_MIN_WIDTH, sessionRailFit } from './session-rail-layout.ts';
import {
  PANE_SIDE_DOCK_MIN_WIDTH,
  PANE_SIDE_DOCK_SHEET_FRAME_WIDTH,
  PANE_SIDE_OVERLAY_INSET,
} from './pane-side-dock-model.ts';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };
const PREF = 400;
// The narrowest pane the panel stands beside the conversation in, and the narrowest it overlays in: every side-dock
// surface's.
const BESIDE_MIN = DESKTOP_WORKSPACE_MIN_WIDTH + PANE_SIDE_DOCK_SHEET_FRAME_WIDTH + PANE_SIDE_DOCK_MIN_WIDTH;
const OVERLAY_MIN = PANE_SIDE_OVERLAY_INSET + PANE_SIDE_DOCK_MIN_WIDTH;

/** The dock as it lays out in a pane cell, with the panel decided beside it. */
async function dockAndRail(cellWidth, { open = true, bottom = false } = {}) {
  const { paneDockRailLayout } = await import('./pane-side-dock.tsx');
  return paneDockRailLayout({
    cellWidth,
    bottom,
    sheetFrame: PANE_SIDE_DOCK_SHEET_FRAME_WIDTH,
    rail: PREF,
    dock: {
      openNow: open,
      mobileSheet: false,
      diffShowing: false,
      sessionSurfaceShowing: true,
      sessionMin: 280,
      sessionPref: 500,
      panelPref: 500,
      diffPref: 500,
    },
  });
}

test("the panel's three presentations follow the side dock's ladder from the pane cell's width", async () => {
  const fit = (cellWidth) => sessionRailFit({ cellWidth, railPref: PREF });
  // Beside while the conversation keeps its floor beside it.
  assert.deepEqual(fit(DESKTOP_WORKSPACE_MIN_WIDTH + SESSION_RAIL_GAP + PREF), {
    width: PREF,
    reserve: PREF + SESSION_RAIL_GAP,
    presentation: 'beside',
  });
  assert.deepEqual(fit(BESIDE_MIN), {
    width: SESSION_RAIL_MIN_WIDTH,
    reserve: SESSION_RAIL_MIN_WIDTH + SESSION_RAIL_GAP,
    presentation: 'beside',
  });
  // Then over the conversation at its own width, which the conversation keeps.
  assert.deepEqual(fit(BESIDE_MIN - 1), { width: 400, reserve: 0, presentation: 'overlay' });
  assert.deepEqual(fit(420), { width: 420 - PANE_SIDE_OVERLAY_INSET, reserve: 0, presentation: 'overlay' });
  assert.deepEqual(fit(OVERLAY_MIN), { width: SESSION_RAIL_MIN_WIDTH, reserve: 0, presentation: 'overlay' });
  // Then the whole pane.
  assert.deepEqual(fit(OVERLAY_MIN - 1), {
    width: OVERLAY_MIN - 1 - SESSION_RAIL_GAP,
    reserve: 0,
    presentation: 'full',
  });
  const frame = PANE_SIDE_DOCK_SHEET_FRAME_WIDTH;

  // The overlay and full-pane steps are the dock's own: a dock surface with the panel's width takes the same width,
  // down to the panel's own minimum, at the same pane widths, and the whole pane at the same one.
  const { paneDockRailLayout } = await import('./pane-side-dock.tsx');
  for (let cellWidth = 200; cellWidth <= 700; cellWidth += 1) {
    const { dock: alone } = paneDockRailLayout({
      cellWidth,
      bottom: false,
      sheetFrame: frame,
      rail: null,
      dock: {
        openNow: true,
        mobileSheet: false,
        diffShowing: false,
        sessionSurfaceShowing: true,
        sessionMin: PANE_SIDE_DOCK_MIN_WIDTH,
        sessionPref: PREF,
        panelPref: PREF,
        diffPref: PREF,
      },
    });
    const rail = fit(cellWidth);
    const dockFull = alone.overlay && alone.baseAsideWidth === cellWidth;
    assert.equal(rail.presentation === 'full', dockFull, `${cellWidth}: the whole pane at the dock's step`);
    if (alone.overlay && !dockFull)
      assert.equal(
        rail.width,
        Math.max(SESSION_RAIL_MIN_WIDTH, alone.baseAsideWidth),
        `${cellWidth}: the dock's overlay width`
      );
  }

  // Every pane width has the panel while no dock is open at its side, in the presentation that width gives, a dock
  // below the conversation changing nothing; a dock open at the side, inline or floating, covers it.
  const seen = { inline: 0, overlay: 0 };
  for (let cellWidth = 10; cellWidth <= 3000; cellWidth += 7) {
    assert.deepEqual((await dockAndRail(cellWidth, { open: false })).rail, fit(cellWidth), `${cellWidth}: folded dock`);
    assert.ok(fit(cellWidth).width > 0, `${cellWidth}: shown`);
    const below = await dockAndRail(cellWidth, { bottom: true });
    assert.deepEqual(below.rail, fit(cellWidth), `${cellWidth}: a dock below`);
    const side = await dockAndRail(cellWidth);
    assert.equal(side.rail.width, 0, `${cellWidth}: a dock at the side covers the panel`);
    assert.equal(side.rail.reserve, 0, `${cellWidth}: the conversation gives up room for the dock alone`);
    seen[side.dock.overlay ? 'overlay' : 'inline'] += 1;
  }
  assert.ok(seen.inline > 0 && seen.overlay > 0, 'both dock layouts are covered');
});

// A pane cell (the app's own elements and styles): its tab strip with the panel's toggle at its end, its
// conversation, the side dock (inline or floating) and the session panel.
const HARNESS = `
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { SessionRailCard } from './SessionRailCard';

  function Pane({ width, rail, dock }) {
    return <div style={{ width }}><div className="pane-cell" style={{ height: 700 }}>
      <div className="workspace-tabs-shell" style={{ height: 44, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
        <button type="button" className="pane-dock-toggle" data-view="session-panel" style={{ width: 28, height: 28, flex: 'none' }} />
      </div>
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
                  <div className="composer-region"><div className="probe-composer" style={{ height: 60 }}>
                    <textarea className="probe-input" /><button type="button" className="probe-send">Send</button>
                  </div></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {dock && <div className="pane-side-dock" data-placement="right" data-open="true" data-overlay={dock.overlay ? 'true' : 'false'} data-expanded="false">
        <div className="pane-side-dock-main">
          <div className="workbench-side-panel" data-side="right" data-embedded="true"
            style={{ width: dock.width, '--workbench-side-panel-width': dock.width + 'px' }}>
            <div className="workbench-side-panel-resize" />
          </div>
        </div>
      </div>}
      {rail && <SessionRailCard leafId="leaf" sessionId="s" width={rail.width} reserve={rail.reserve} presentation={rail.presentation} />}
    </div></div>;
  }
  let root;
  // The cell narrows inside a wide window, as a split pane does: its own container queries, not the window's.
  window.mountFixture = (width, rail, dock) => {
    root ??= createRoot(document.getElementById('root'));
    flushSync(() => root.render(<Pane width={width} rail={rail} dock={dock} />));
  };
  const box = (selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
  };
  const owner = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    if (hit?.closest('.pane-side-dock')) return 'dock';
    if (hit?.closest('.session-rail')) return 'rail';
    if (hit?.closest('.pane-dock-toggle')) return 'toggle';
    return String(hit?.className || hit?.tagName);
  };
  window.measure = () => {
    const toggle = box('.pane-dock-toggle');
    const panel = box('.session-rail');
    return {
      cell: box('.pane-cell'),
      cellWidth: document.querySelector('.pane-cell').clientWidth,
      strip: box('.workspace-tabs-shell'),
      stripMargin: getComputedStyle(document.querySelector('.workspace-tabs-shell')).marginRight,
      surface: box('.pane-surface-stack'),
      scroller: box('.transcript'),
      row: box('.probe-row'),
      composer: box('.composer-region'),
      panel,
      presentation: document.querySelector('.session-rail')?.dataset.presentation ?? null,
      resize: box('.session-rail-resize'),
      dock: box('.pane-side-dock'),
      dockEdge: box('.pane-side-dock .workbench-side-panel-resize'),
      railVars: ['--session-rail-reserve', '--session-rail-over', '--session-rail-band']
        .map((name) => document.querySelector('.pane-cell').style.getPropertyValue(name))
        .join(''),
      // Whether the composer under the panel can take focus (Tab or a click) and so typing.
      composerReachable: (() => {
        const input = document.querySelector('.probe-input');
        input.focus();
        const reached = document.activeElement === input;
        input.blur();
        return reached;
      })(),
      toggleHit: toggle && owner((toggle.left + toggle.right) / 2, (toggle.top + toggle.bottom) / 2),
      // Who takes each whole pixel across the panel, at its middle row.
      across: panel
        ? Array.from({ length: Math.floor(panel.right - Math.ceil(panel.left)) }, (_, index) => {
            const x = Math.ceil(panel.left) + index;
            return { x, hit: owner(x, (panel.top + panel.bottom) / 2) };
          })
        : [],
    };
  };
`;

async function openPage(t) {
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: HARNESS },
      outfile: 'session-rail-presentation.js',
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
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./pane-layout.css";',
      },
      outfile: 'session-rail-presentation.css',
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
  await page.setViewport({ width: 2000, height: 800 });
  await page.setContent('<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>');
  const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'));
  if (css) await page.addStyleTag({ content: css.text });
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: 'window.process = { env: {}, platform: "win32", argv: [], versions: {} };' });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  assert.deepEqual(errors, [], 'the fixture loads');
  return { page, errors };
}

test('beside, over the conversation, over the whole pane: where the panel stands, what it leaves the conversation, and the toggle', async (t) => {
  const { page, errors } = await openPage(t);
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} ≠ ${expected}`);
  // The pane at `cellWidth`, bare and then with the panel as sessionRailFit places it there.
  const at = async (cellWidth) => {
    const mount = (rail) => page.evaluate((w, r) => window.mountFixture(w, r, null), cellWidth, rail);
    await mount(null);
    const bare = await page.evaluate(() => window.measure());
    const fit = sessionRailFit({ cellWidth: bare.cellWidth, railPref: PREF });
    await mount(fit);
    return { bare, fit, shown: await page.evaluate(() => window.measure()) };
  };

  // Beside: a band from the pane's top, the strip ending at it, the conversation re-centred left of it.
  const beside = await at(BESIDE_MIN + 40);
  assert.equal(beside.shown.presentation, 'beside');
  near(beside.shown.panel.right, beside.shown.cell.right, "beside: on the pane's edge");
  near(beside.shown.panel.top, beside.shown.cell.top, "beside: from the pane's top");
  near(beside.shown.strip.right, beside.shown.panel.left, 'beside: the strip ends at the panel');
  assert.ok(beside.shown.composer.right <= beside.shown.panel.left + 1, 'beside: the composer left of the panel');
  assert.equal(beside.shown.toggleHit, 'toggle', 'beside: the toggle is reachable');
  assert.ok(beside.shown.resize, 'beside: its resize edge');

  // Over the conversation: the same band at its own width, the conversation keeping its width under it.
  const overlay = await at(600);
  assert.equal(overlay.fit.presentation, 'overlay');
  assert.equal(overlay.shown.presentation, 'overlay');
  near(overlay.shown.panel.right - overlay.shown.panel.left, PREF + SESSION_RAIL_GAP, 'overlay: its own width');
  near(overlay.shown.panel.right, overlay.shown.cell.right, "overlay: on the pane's edge");
  near(overlay.shown.panel.top, overlay.shown.cell.top, "overlay: from the pane's top");
  for (const part of ['row', 'composer', 'scroller']) {
    near(overlay.shown[part].left, overlay.bare[part].left, `overlay: the ${part} keeps its place`);
    near(overlay.shown[part].right, overlay.bare[part].right, `overlay: the ${part} keeps its width`);
  }
  assert.deepEqual(
    overlay.shown.across.filter(({ hit }) => hit !== 'rail'),
    [],
    'overlay: above the conversation'
  );
  near(overlay.shown.strip.right, overlay.shown.panel.left, 'overlay: the strip ends at the panel');
  assert.equal(overlay.shown.toggleHit, 'toggle', 'overlay: the toggle is reachable');
  assert.ok(overlay.shown.resize, 'overlay: its resize edge');
  assert.equal(overlay.shown.composerReachable, true, 'overlay: the conversation stays usable');

  // Over the whole pane: the conversation's whole width under the strip, which keeps the toggle.
  const full = await at(OVERLAY_MIN - 20);
  assert.equal(full.shown.presentation, 'full');
  near(full.shown.panel.left, full.shown.cell.left, "full: from the pane's left");
  near(full.shown.panel.right, full.shown.cell.right, "full: to the pane's right");
  near(full.shown.panel.top, full.shown.surface.top, 'full: under the strip');
  near(full.shown.panel.bottom, full.shown.surface.bottom, "full: to the conversation's bottom");
  assert.equal(full.shown.stripMargin, '0px', 'full: the strip keeps its width');
  near(full.shown.strip.right, full.shown.cell.right, "full: the strip reaches the pane's edge");
  assert.equal(full.shown.toggleHit, 'toggle', 'full: the toggle is reachable');
  assert.deepEqual(
    full.shown.across.filter(({ hit }) => hit !== 'rail'),
    [],
    'full: above the conversation'
  );
  assert.equal(full.shown.resize, null, 'full: no width to resize');
  for (const part of ['row', 'composer']) {
    near(full.shown[part].left, full.bare[part].left, `full: the ${part} under it keeps its place`);
  }
  assert.equal(full.bare.composerReachable, true, 'without the panel the composer takes focus');
  assert.equal(full.shown.composerReachable, false, 'full: the hidden composer takes no focus and no typing');
  // Floating over part of the pane again, or gone, it gives the conversation back.
  await page.evaluate((w, r) => window.mountFixture(w, r, null), OVERLAY_MIN - 20, {
    ...full.fit,
    width: SESSION_RAIL_MIN_WIDTH,
    presentation: 'overlay',
  });
  assert.equal((await page.evaluate(() => window.measure())).composerReachable, true, 'overlay again: usable');
  await page.evaluate((w) => window.mountFixture(w, { width: 1, reserve: 0, presentation: 'full' }, null), 330);
  await page.evaluate((w) => window.mountFixture(w, null, null), 330);
  assert.equal((await page.evaluate(() => window.measure())).composerReachable, true, 'gone: usable');
  assert.deepEqual(errors, []);
});

test("a dock open at the pane's side covers the session panel: nothing of it beside or behind the dock, the conversation giving up room for the dock alone; closed, the panel is back", async (t) => {
  const { page, errors } = await openPage(t);
  // The pane drawn as the layout places it: the panel only while it has a width.
  const draw = async (cellWidth, open) => {
    await page.evaluate((w) => window.mountFixture(w, null, null), cellWidth);
    const measured = await page.evaluate(() => document.querySelector('.pane-cell').clientWidth);
    const { dock, rail } = await dockAndRail(measured, { open });
    const sheet = open ? { overlay: dock.overlay, width: dock.baseAsideWidth } : null;
    await page.evaluate((w, r, d) => window.mountFixture(w, r, d), cellWidth, rail.width > 0 ? rail : null, sheet);
    return { dock, rail, measured, shown: await page.evaluate(() => window.measure()) };
  };
  // 1,400px: the dock inline (the reported case); 600px: floating over the conversation; 330px: floating over a pane
  // the panel alone would take whole.
  for (const [cellWidth, overlay] of [
    [1400, false],
    [600, true],
    [330, true],
  ]) {
    const docked = await draw(cellWidth, true);
    assert.equal(docked.dock.overlay, overlay, `${cellWidth}: the dock's layout`);
    assert.equal(docked.rail.width, 0, `${cellWidth}: no panel`);
    assert.equal(docked.shown.panel, null, `${cellWidth}: nothing of the panel drawn`);
    assert.equal(docked.shown.railVars, '', `${cellWidth}: the conversation gives up nothing for it`);
    assert.equal(docked.shown.stripMargin, '0px', `${cellWidth}: the strip gives up nothing for it`);
    assert.equal(docked.shown.composerReachable, true, `${cellWidth}: the composer stays usable`);
    // Left of the dock's edge, beside it: the conversation, not the panel.
    const y = (docked.shown.surface.top + docked.shown.surface.bottom) / 2;
    const left = Math.min(docked.shown.dock.left, docked.shown.dockEdge.left);
    const beside = await page.evaluate(
      (x, at) =>
        document.elementFromPoint(x, at)?.closest('.pane-side-dock, .session-rail, .pane-conversation-slot')?.className,
      Math.floor(left) - 2,
      y
    );
    if (left > 2) assert.equal(beside, 'pane-conversation-slot', `${cellWidth}: the conversation beside the dock`);
    if (!overlay) {
      assert.ok(
        docked.shown.scroller.right <= docked.shown.dock.left + 1,
        `${cellWidth}: the conversation left of the dock`
      );
    }
    // Closed: the panel is back where the pane's width puts it.
    const closed = await draw(cellWidth, false);
    const fit = sessionRailFit({ cellWidth: closed.measured, railPref: PREF });
    assert.deepEqual(closed.rail, fit, `${cellWidth}: back`);
    assert.equal(closed.shown.presentation, fit.presentation, `${cellWidth}: in its presentation`);
  }
  assert.deepEqual(errors, []);
});
