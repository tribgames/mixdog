import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout.ts';
import { PANE_SIDE_DOCK_MIN_WIDTH, PANE_SIDE_DOCK_SHEET_FRAME_WIDTH } from './pane-side-dock-model.ts';
import { SESSION_RAIL_GAP, SESSION_RAIL_MIN_WIDTH, sessionRailFit } from './session-rail-layout.ts';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };

// A pane cell with its conversation (the app's own elements and styles) and
// the session panel beside it.
const HARNESS = `
  import { useRef } from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { installScrollbarMetrics } from './scrollbar-metrics';
  import { SessionRailCard } from './SessionRailCard';
  import { useSessionRailMotion } from './session-rail-motion';

  // The panel's sections, as RailSection draws them, coming and going as the panel stays shown: open, or folded
  // when named with a leading '-'.
  function Sections({ categories }) {
    const content = useRef(null);
    useSessionRailMotion(content, 's');
    return <aside className="session-rail" style={{ width: 300 }}>
      <div className="session-rail-body">
        <div ref={content} className="session-rail-content">
          {categories.map((name) => {
            const open = !name.startsWith('-');
            const category = open ? name : name.slice(1);
            return <section key={category} className="session-rail-sec" data-category={category} data-open={open ? '' : undefined}>
              <div className="session-rail-hd"><button type="button" className="session-rail-tg">{category}</button></div>
              {open && <div className="session-rail-bd"><div style={{ height: 60 }} /></div>}
            </section>;
          })}
        </div>
      </div>
    </aside>;
  }
  window.mountSections = (categories) => {
    root ??= createRoot(document.getElementById('root'));
    flushSync(() => root.render(<Sections categories={categories} />));
  };
  window.sectionBoxes = () => Object.fromEntries([...document.querySelectorAll('.session-rail-sec')].map((node) => {
    const rect = node.getBoundingClientRect();
    const head = node.querySelector('.session-rail-tg').getBoundingClientRect();
    // The hairline above the section: where it stands against the section, and the rows' inset.
    const line = getComputedStyle(node, '::before');
    const rule = line.content === 'none' || line.content === 'normal' ? null : {
      top: line.top, left: line.left, right: line.right, height: line.height,
      inset: getComputedStyle(node).getPropertyValue('--session-rail-inset').trim(),
    };
    return [node.dataset.category, { top: rect.top, height: rect.height, head: head.top, leaving: node.hasAttribute('data-leaving'), rule }];
  }));
  // The fold of the section of \`category\`, held at \`time\` ms.
  window.holdFold = (category, time) => {
    const [fold] = document.querySelector('.session-rail-sec[data-category="' + category + '"]').getAnimations();
    if (!fold) return false;
    fold.pause();
    fold.currentTime = time;
    return true;
  };
  window.endFold = async (category) => {
    document.querySelector('.session-rail-sec[data-category="' + category + '"]')?.getAnimations().forEach((fold) => fold.finish());
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };

  function Pane({ card, reserve, dock }) {
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
                    <button type="button" className="jump-to-latest" />
                  </div>
                  <div className="composer-region"><div className="probe-composer" style={{ height: 60 }} /></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {dock > 0 && <div className="pane-side-dock" data-open="true" data-overlay="false" data-expanded="false">
        <div className="pane-side-dock-main">
          <div className="workbench-side-panel" data-side="right" data-embedded="true"
            style={{ '--workbench-side-panel-width': dock + 'px' }}>
            <div className="workbench-side-panel-resize" />
          </div>
        </div>
      </div>}
      {card > 0 && <SessionRailCard leafId="leaf" sessionId="s" width={card} reserve={reserve} />}
    </div>;
  }
  let root;
  window.mountFixture = (card, reserve, dock = 0) => {
    installScrollbarMetrics();
    root ??= createRoot(document.getElementById('root'));
    root.render(<Pane card={card} reserve={reserve} dock={dock} />);
  };
  // Headless, the metrics probe reads no reserve while the transcript's stable gutter takes its track; the app
  // publishes what the engine reserves, so the fixture publishes the transcript's own.
  window.matchGutter = () => {
    const scroller = document.querySelector('.transcript');
    const reserve = scroller.offsetWidth - scroller.clientWidth - scroller.clientLeft * 2;
    document.documentElement.style.setProperty('--mx-scrollbar-gutter', reserve + 'px');
  };
  // The topmost element under each whole pixel across a box, at its middle row.
  window.hitsAcross = (selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    const y = (rect.top + rect.bottom) / 2;
    const hits = [];
    for (let x = Math.ceil(rect.left); x < rect.right; x += 1) {
      const hit = document.elementFromPoint(x, y);
      hits.push(hit?.closest(selector) ? 'target' : String(hit?.className || hit?.tagName));
    }
    return hits;
  };
  window.measure = () => {
    const box = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
    };
    const scroller = document.querySelector('.transcript');
    const slot = document.querySelector('.session-rail-body');
    // A section with its head, the fold alone, as RailSection draws it.
    if (slot && !slot.firstChild) {
      slot.innerHTML =
        '<div class="session-rail-content"><section class="session-rail-sec" data-open style="height:120px">' +
        '<div class="session-rail-hd"><button type="button" class="session-rail-tg"></button></div></section></div>';
    }
    return {
      cell: box('.pane-cell'),
      cellWidth: document.querySelector('.pane-cell').clientWidth,
      strip: box('.workspace-tabs-shell'),
      stripMargin: getComputedStyle(document.querySelector('.workspace-tabs-shell')).marginRight,
      surface: box('.pane-surface-stack'),
      scroller: box('.transcript'),
      scrollbar: scroller.offsetWidth - scroller.clientWidth - scroller.clientLeft * 2,
      row: box('.probe-row'),
      composer: box('.composer-region'),
      chip: box('.jump-to-latest'),
      panel: box('.session-rail'),
      section: box('.session-rail-sec'),
      head: box('.session-rail-head'),
      body: box('.session-rail-body'),
      resize: box('.session-rail-resize'),
      sectionHead: box('.session-rail-tg'),
    };
  };
`;

/** A page with the fixture's bundle and the app's styles loaded. */
async function openPage(t) {
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
        // The cell is a grid only in pane-layout.css: without it the panel is not laid out as the app lays it out.
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./pane-layout.css";',
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
  return { page, errors };
}

test('the session panel stands right of the reading column: in its margin, or the conversation re-centres left of it', async (t) => {
  const { page, errors } = await openPage(t);
  const at = async (width, card, reserve = 0, dock = 0) => {
    await page.setViewport({ width, height: 800 });
    await page.evaluate((next, room, side) => window.mountFixture(next, room, side), card, reserve, dock);
    await page.evaluate(() => window.measure());
    await page.evaluate(() => window.matchGutter());
    await new Promise((resolve) => setTimeout(resolve, 100));
    return page.evaluate(() => window.measure());
  };
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} ≠ ${expected}`);

  const centre = (rect) => (rect.left + rect.right) / 2;

  // A wide pane: the margin beside the reading column holds the panel, so nothing moves.
  const bare = await at(2000, 0);
  const wide = await at(2000, 400);
  near(wide.row.left, bare.row.left, 'the reading column stays where it was');
  near(wide.row.right, bare.row.right, 'the reading column stays where it was');
  near(wide.composer.left, bare.composer.left, 'the composer too');
  near(wide.composer.right, bare.composer.right, 'the composer too');
  // A band at the pane's edge: its width and the gap, both grid rows from the pane's top; the tab strip ends at it.
  near(wide.panel.right, wide.cell.right, "the panel on the pane's edge");
  near(wide.panel.right - wide.panel.left, 400 + SESSION_RAIL_GAP, 'its width and the gap');
  near(wide.panel.top, wide.cell.top, "from the pane's top, the tab strip's row");
  near(wide.panel.top, wide.strip.top, 'beside the tab strip');
  near(wide.panel.bottom, wide.surface.bottom, "to the surface's bottom");
  assert.equal(wide.stripMargin, `${400 + SESSION_RAIL_GAP}px`, "the strip's margin is the panel's band");
  near(wide.strip.right, wide.panel.left, 'the strip ends at the panel');
  assert.equal(bare.stripMargin, '0px', 'without the panel the strip has no margin');
  near(bare.strip.right, bare.cell.right, "without it the strip reaches the pane's edge");
  assert.ok(wide.section.right - wide.section.left > 300, 'the sections take the panel');
  // No head row: the body scrolls from the pane's top, and the first section's head row stands on the tab strip's
  // row beside it; the resize edge spans the panel's full height.
  assert.equal(wide.head, null, 'no head');
  near(wide.body.top, wide.cell.top, "the body from the pane's top");
  near(wide.body.bottom, wide.panel.bottom, "to the panel's bottom");
  near(wide.sectionHead.bottom - wide.sectionHead.top, 28, "the section's head row");
  const middle = (rect) => (rect.top + rect.bottom) / 2;
  near(middle(wide.sectionHead), middle(wide.strip), "the first head row centred on the strip's row");
  near(wide.resize.top, wide.panel.top, 'the resize edge from the top');
  near(wide.resize.bottom, wide.panel.bottom, 'to the bottom');
  // The scroller ends at the panel, its scrollbar beside it.
  assert.ok(wide.scrollbar > 0, 'the transcript shows its scrollbar');
  near(wide.scroller.right, wide.panel.left, "the scroller's right edge, its scrollbar's, meets the panel");
  assert.ok(wide.row.right <= wide.scroller.right - wide.scrollbar, 'the reading column ends before the scrollbar');
  // The jump-to-latest chip stays at the pane's centre, where it was without the panel.
  near(centre(wide.chip), centre(bare.chip), 'the chip stays where it was');
  near(centre(wide.chip), centre(wide.cell), "the chip at the pane's centre");

  // The narrowest pane the layout shows it beside the conversation in: the conversation re-centres left of the
  // panel at its floor, and the scroller ends at the panel.
  const pane = DESKTOP_WORKSPACE_MIN_WIDTH + PANE_SIDE_DOCK_SHEET_FRAME_WIDTH + PANE_SIDE_DOCK_MIN_WIDTH;
  const fit = sessionRailFit({ cellWidth: pane, railPref: 400 });
  assert.deepEqual(fit, {
    width: SESSION_RAIL_MIN_WIDTH,
    reserve: SESSION_RAIL_MIN_WIDTH + SESSION_RAIL_GAP,
    presentation: 'beside',
  });
  const tight = await at(pane, fit.width, fit.reserve);
  near(tight.panel.right, tight.cell.right, "the panel on the pane's edge");
  near(tight.panel.bottom, tight.surface.bottom, "to the surface's bottom");
  near(tight.scroller.right, tight.panel.left, 'the scroller ends at the panel');
  assert.ok(
    tight.row.right <= tight.panel.left,
    `the reading column ends before the panel: ${tight.row.right} > ${tight.panel.left}`
  );
  assert.ok(tight.composer.right <= tight.panel.left, 'and so does the composer');

  // Either side of the width where the scroller, giving up the band on both sides, still holds the 848px column the
  // pane gives its rows: above it nothing moves, below it the conversation re-centres; the rows keep their width.
  const frame = 2000 - bare.cellWidth;
  const boundary = 848 + 2 * (400 + SESSION_RAIL_GAP);
  for (const cellWidth of [boundary + 1, boundary - 1]) {
    const fitted = sessionRailFit({ cellWidth, railPref: 400 });
    assert.equal(fitted.reserve, cellWidth > boundary ? 0 : 400 + SESSION_RAIL_GAP, `${cellWidth}: the reserve`);
    const without = await at(cellWidth + frame, 0);
    const beside = await at(cellWidth + frame, fitted.width, fitted.reserve);
    assert.equal(beside.cellWidth, cellWidth);
    const width = (rect) => rect.right - rect.left;
    assert.ok(
      Math.abs(width(beside.row) - width(without.row)) <= 0.5,
      `${cellWidth}: the rows keep their width: ${width(beside.row)} ≠ ${width(without.row)}`
    );
    assert.ok(beside.row.right <= beside.panel.left, `${cellWidth}: the rows end before the panel`);
    if (fitted.reserve === 0) {
      near(beside.row.left, without.row.left, `${cellWidth}: the rows stay where they were`);
    }
  }

  // The panel's whole resize edge takes the pointer (a dock open at the side covers the panel, so none stands beside it).
  const roomy = sessionRailFit({ cellWidth: 2000 - frame, railPref: 400 });
  await at(2000, roomy.width, roomy.reserve);
  const railEdge = await page.evaluate(() => window.hitsAcross('.session-rail-resize'));
  assert.deepEqual(
    railEdge.filter((hit) => hit !== 'target'),
    [],
    "the panel's edge is its own"
  );
  assert.deepEqual(errors, []);
});

test('a section that arrives opens from nothing and one that leaves closes to nothing: no other head jumps at its first or last frame, beside open or folded sections, first or last', async (t) => {
  const { page, errors } = await openPage(t);
  await page.setViewport({ width: 800, height: 800 });
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) <= 0.5, `${message}: ${actual} ≠ ${expected}`);
  const boxes = () => page.evaluate(() => window.sectionBoxes());
  // `moving` comes (it is in `to` only) or goes (in `from` only); '-' names a folded section.
  const fold = async (from, to, moving) => {
    const label = `${from.join(',')} → ${to.join(',')}`;
    await page.evaluate((names) => window.mountSections(names), from);
    await page.evaluate(async () => {
      for (const animation of document.getAnimations()) animation.finish();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const before = await boxes();
    await page.evaluate((names) => window.mountSections(names), to);
    assert.ok(await page.evaluate((category) => window.holdFold(category, 0), moving), `${label}: it folds`);
    const first = await boxes();
    await page.evaluate((category) => window.holdFold(category, 199.99), moving);
    const last = await boxes();
    await page.evaluate((category) => window.endFold(category), moving);
    const rest = await boxes();
    const arriving = to.some((name) => name.replace('-', '') === moving);
    if (arriving) {
      near(first[moving].height, 0, `${label}: it opens from nothing`);
      assert.ok(rest[moving].height > 30, `${label}: to its own height`);
    } else {
      assert.equal(last[moving].leaving, true);
      near(last[moving].height, 0, `${label}: it closes to nothing`);
      assert.equal(rest[moving], undefined, `${label}: gone once closed`);
    }
    for (const category of Object.keys(rest).filter((name) => name !== moving)) {
      near(first[category].head, before[category].head, `${label}: ${category}'s head at the first frame`);
      near(last[category].head, rest[category].head, `${label}: ${category}'s head at the last frame`);
    }
    // Every section after the first, open or folded, under a 1px hairline inset by the rows' inset on both sides;
    // folded sections one after another keep their own padding round their head (44px apart).
    const settled = Object.keys(rest);
    for (const [index, category] of settled.entries()) {
      const { rule } = rest[category];
      if (index === 0) {
        assert.equal(rule, null, `${label}: no hairline above the first section`);
        continue;
      }
      assert.ok(rule, `${label}: a hairline above ${category}`);
      assert.deepEqual(
        [rule.top, rule.left, rule.right, rule.height],
        ['0px', rule.inset, rule.inset, '1px'],
        `${label}: ${category}'s hairline`
      );
    }
    for (let index = 1; index < to.length; index += 1) {
      const [above, below] = [to[index - 1], to[index]];
      if (!above.startsWith('-') || !below.startsWith('-')) continue;
      near(rest[below.slice(1)].head - rest[above.slice(1)].head, 44, `${label}: ${above} then ${below}`);
    }
  };
  const cases = [
    // Open sections either side.
    [['info', 'context'], ['info', 'todo', 'context'], 'todo'],
    // Open between folded ones, which read as one list without it.
    [['info', '-todo', '-shells'], ['info', '-todo', 'agents', '-shells'], 'agents'],
    // Folded between folded ones.
    [['info', '-todo', '-shells'], ['info', '-todo', '-agents', '-shells'], 'agents'],
    // First, before an open section and before folded ones.
    [['info', 'context'], ['agents', 'info', 'context'], 'agents'],
    [['-todo', '-shells'], ['agents', '-todo', '-shells'], 'agents'],
    [['-todo', '-shells'], ['-agents', '-todo', '-shells'], 'agents'],
    // Last, after folded ones.
    [['info', '-todo', '-shells'], ['info', '-todo', '-shells', 'agents'], 'agents'],
  ];
  for (const [without, withIt, moving] of cases) {
    await fold(without, withIt, moving);
    await fold(withIt, without, moving);
  }
  assert.deepEqual(errors, []);
});
