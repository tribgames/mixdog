import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';

// Opening an inline dock moves the sheet's 1px frame from the main panel's
// border to the pane cells' own frames (pane-layout.css, --frame). That
// handoff must not move or recolour anything: no pane edge or divider, no tab
// strip, chat, Problems panel, footer or composer, and the frame lands on the
// pixels the panel's border painted. Only the docked pane's column gives the
// dock its room, by exactly the dock, its gap and the frame's 1px side. Each
// case flips the dock live on one DOM, the way PaneSideDock commits it, and
// compares every box to the pixel. Real Chrome lays out the app's stylesheet.

const GAP = 2; // --mx-sheet-gap
const RADIUS = 10; // --mx-sheet-radius
const DOCK_WIDTH = 200;
const DOCK_HEIGHT = 100;
const COMPOSER = { width: 400, height: 120 };
const PANEL = { left: 100, top: 40, width: 1800, height: 900 };
const VIEWPORT = { width: 1900, height: 1000 };

const RENDERER = fileURLToPath(new URL('.', import.meta.url));
const STYLE_ENTRY =
  '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./pane-layout.css"; @import "./pane-side-dock-bottom.css"; @import "./mobile-web-runtime.css";';

const FIXTURES = {
  full: { problems: true, footer: true },
  bare: { problems: false, footer: false },
};

const cellMarkup = (id, { problems, footer }) => `
  <div class="pane-cell" id="${id}">
    <div class="workspace-tabs-shell"><div class="workspace-tabs" style="height:43px"></div></div>
    <div class="pane-surface-stack" style="position:relative">
      <div class="composer-region" style="position:absolute;left:0;right:0;bottom:0;margin:0 auto;max-width:${COMPOSER.width}px;height:${COMPOSER.height}px"></div>
    </div>
    ${problems ? '<div class="bottom-panel" data-state="open" style="height:60px"></div>' : ''}
    <div class="pane-footer-slot">${footer ? '<div style="height:24px"></div>' : ''}</div>
    <div class="pane-side-dock" data-open="false"></div>
  </div>`;
const leaf = (id, fixture) => `<div class="pane-leaf">${cellMarkup(id, fixture)}</div>`;
const split = (direction, first, second, ratio) => `
  <div class="pane-split pane-split-${direction}">
    <div class="pane-split-cell" style="flex:${ratio} 1 0%">${first}</div>
    <div class="pane-resize-handle"></div>
    <div class="pane-split-cell" style="flex:${1 - ratio} 1 0%">${second}</div>
  </div>`;

/** Single pane, side-by-side, stacked, three wide, and the mixed and nested axes. */
const LAYOUTS = {
  single: { panes: ['a'], html: (f) => cellMarkup('a', f) },
  row: { panes: ['a', 'b'], html: (f) => split('row', leaf('a', f), leaf('b', f), 0.37) },
  column: { panes: ['a', 'b'], html: (f) => split('column', leaf('a', f), leaf('b', f), 0.46) },
  three: {
    panes: ['a', 'b', 'c'],
    html: (f) => split('row', leaf('a', f), split('row', leaf('b', f), leaf('c', f), 0.5), 0.34),
  },
  'row of columns': {
    panes: ['a', 'b', 'c'],
    html: (f) => split('row', leaf('a', f), split('column', leaf('b', f), leaf('c', f), 0.5), 0.45),
  },
  'column of rows': {
    panes: ['a', 'b', 'c'],
    html: (f) => split('column', split('row', leaf('a', f), leaf('b', f), 0.5), leaf('c', f), 0.55),
  },
  'nested columns': {
    panes: ['a', 'b', 'c'],
    html: (f) => split('column', leaf('a', f), split('column', leaf('b', f), leaf('c', f), 0.5), 0.34),
  },
};

// Runs in the page: every box the cases compare, read in one pass.
const PROBE = `
window.paneProbe = () => {
  const px = (value) => Number.parseFloat(value) || 0;
  const rect = (node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  };
  const panel = document.querySelector('.main-panel');
  const panelStyle = getComputedStyle(panel);
  const frameOf = (cell) => {
    const style = getComputedStyle(cell, '::after');
    if (style.content === 'none') return null;
    const box = cell.getBoundingClientRect();
    const cellStyle = getComputedStyle(cell);
    const widths = {
      top: px(style.borderTopWidth),
      right: px(style.borderRightWidth),
      bottom: px(style.borderBottomWidth),
      left: px(style.borderLeftWidth),
    };
    const extraX = style.boxSizing === 'border-box' ? 0 : widths.left + widths.right + px(style.paddingLeft) + px(style.paddingRight);
    const extraY = style.boxSizing === 'border-box' ? 0 : widths.top + widths.bottom + px(style.paddingTop) + px(style.paddingBottom);
    const left = box.left + px(cellStyle.paddingLeft) + px(style.marginLeft);
    const top = box.top + px(cellStyle.paddingTop) + px(style.marginTop);
    // Computed lengths are printed rounded; layout works in 1/64 px.
    const unit = (value) => Math.round(value * 64) / 64;
    const drawn = {
      left: unit(left),
      top: unit(top),
      right: unit(left + px(style.width) + extraX),
      bottom: unit(top + px(style.height) + extraY),
    };
    // The cell clips (overflow: hidden): a side outside its box is not painted.
    const visible = {
      left: Math.max(drawn.left, box.left),
      top: Math.max(drawn.top, box.top),
      right: Math.min(drawn.right, box.right),
      bottom: Math.min(drawn.bottom, box.bottom),
    };
    return { drawn, visible, widths };
  };
  const cells = {};
  for (const cell of document.querySelectorAll('.pane-cell')) {
    const parts = {};
    const part = (name, selector) => {
      const node = cell.querySelector(':scope ' + selector);
      if (node && node.getBoundingClientRect().height > 0) parts[name] = rect(node);
    };
    part('strip', '> .workspace-tabs-shell');
    part('stack', '> .pane-surface-stack');
    part('composer', '.composer-region');
    part('problems', '> .bottom-panel');
    part('footer', '> .pane-footer-slot');
    const dock = cell.querySelector(':scope > .pane-side-dock');
    const spacer = cell.querySelector(':scope > .pane-side-dock-spacer');
    cells[cell.id] = {
      cell: rect(cell),
      parts,
      frame: frameOf(cell),
      dock: dock.dataset.open === 'true' ? rect(dock) : null,
      spacer: spacer ? rect(spacer) : null,
    };
  }
  return {
    panel: {
      rect: rect(panel),
      border: {
        top: px(panelStyle.borderTopWidth),
        right: px(panelStyle.borderRightWidth),
        bottom: px(panelStyle.borderBottomWidth),
        left: px(panelStyle.borderLeftWidth),
      },
      colors: [panelStyle.borderTopColor, panelStyle.borderRightColor, panelStyle.borderBottomColor],
    },
    cells,
    handles: [...document.querySelectorAll('.pane-resize-handle')].map(rect),
  };
};`;

async function stylesheet(rendererDir) {
  const result = await build({
    stdin: { resolveDir: rendererDir, loader: 'css', contents: STYLE_ENTRY },
    outfile: 'pane-frame-reserve.css',
    bundle: true,
    write: false,
    // Fonts and pictures stay external: the fixtures hold no text or images.
    external: ['*.woff', '*.woff2', '*.ttf', '*.svg', '*.jpg', '*.png', '*.webp'],
  });
  return result.outputFiles[0].text;
}

async function launch(t, css) {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css ?? (await stylesheet(RENDERER)) });
  await page.addScriptTag({ content: PROBE });
  return page;
}

async function layout(page, html, { theme = 'dark', folded = false } = {}) {
  await page.evaluate(
    (markup, themeName, foldedOn, panel) => {
      const root = document.documentElement;
      for (const name of [
        'data-mixdog-skin',
        'data-mixdog-skin-plate',
        'data-mixdog-theme',
        'data-mixdog-mobile-tabs',
        'style',
      ]) {
        root.removeAttribute(name);
      }
      if (themeName === 'light') root.setAttribute('data-mixdog-theme', 'light');
      if (themeName === 'skin') {
        // What desktop-skin.ts writes for a dark plate over a picture.
        root.setAttribute('data-mixdog-skin', 'test');
        root.setAttribute('data-mixdog-skin-plate', 'dark');
        root.style.cssText =
          '--mx-skin-tint: rgb(28, 40, 64); --mx-skin-ink: rgb(236, 240, 248); --mx-skin-chrome-ink: rgb(236, 240, 248); --mx-skin-edge-amount: 26%; --mx-skin-rule-amount: 16%; --mx-skin-edge-strong-amount: 40%; --mx-skin-fill-amount: 10%; --mx-skin-fill-strong-amount: 16%; --mx-skin-card-amount: 70%';
        document.body.style.background = 'rgb(120, 90, 60)';
      } else {
        document.body.style.background = '';
      }
      for (const node of document.querySelectorAll(
        'body > .session-terminal-surface-container, body > .session-browser-surface-container'
      )) {
        node.remove();
      }
      document.getElementById('root').innerHTML = `
        <div class="app-shell${foldedOn ? ' sidebar-collapsed' : ''}">
          <main class="main-panel" style="position:absolute;left:${panel.left}px;top:${panel.top}px;width:${panel.width}px;height:${panel.height}px">${markup}</main>
        </div>`;
    },
    html,
    theme,
    folded,
    PANEL
  );
}

/**
 * Commits `#id`'s dock the way PaneSideDock does: data-open / data-overlay /
 * data-expanded on the host, data-dock-placement on the cell, the expanded
 * spacer holding the rest size the host measured, and the column's
 * data-inline-dock (useInlineDockFlag) in the same commit.
 */
async function setDock(page, id, next) {
  await page.evaluate(
    (paneId, state, sizes, panel) => {
      const cell = document.getElementById(paneId);
      const dock = cell.querySelector(':scope > .pane-side-dock');
      const bottom = state.placement === 'bottom';
      const rest = dock.getBoundingClientRect();
      cell.querySelector(':scope > .pane-side-dock-spacer')?.remove();
      dock.dataset.open = state.open ? 'true' : 'false';
      dock.dataset.placement = state.placement;
      if (bottom) cell.dataset.dockPlacement = 'bottom';
      else delete cell.dataset.dockPlacement;
      if (state.overlay) dock.dataset.overlay = 'true';
      else delete dock.dataset.overlay;
      if (state.expanded) {
        dock.dataset.expanded = 'true';
        const spacer = document.createElement('div');
        spacer.className = 'pane-side-dock-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.cssText = bottom ? `height:${Math.round(rest.height)}px` : `width:${Math.round(rest.width)}px`;
        dock.before(spacer);
      } else delete dock.dataset.expanded;
      dock.style.cssText = !state.open
        ? ''
        : state.expanded
          ? `position:fixed;left:${panel.left}px;top:${panel.top}px;width:${panel.width}px;height:${panel.height}px`
          : bottom
            ? `height:${sizes.height}px`
            : `width:${sizes.width}px`;
      const column = document.querySelector('.main-panel');
      const inline = [...document.querySelectorAll('.pane-side-dock')].some(
        (node) => node.dataset.open === 'true' && !node.dataset.overlay && !node.dataset.expanded
      );
      if (inline) column.dataset.inlineDock = 'true';
      else delete column.dataset.inlineDock;
    },
    id,
    next,
    { width: DOCK_WIDTH, height: DOCK_HEIGHT },
    PANEL
  );
}

const probe = (page) => page.evaluate(() => window.paneProbe());

/** 1 where the cell's side lies on the panel's outer edge (the ring), from the closed layout. */
function edgesOf(snapshot, id) {
  const { rect, border } = snapshot.panel;
  const cell = snapshot.cells[id].cell;
  return {
    top: border.top && cell.top === rect.top + border.top ? 1 : 0,
    right: border.right && cell.right === rect.right - border.right ? 1 : 0,
    bottom: border.bottom && cell.bottom === rect.bottom - border.bottom ? 1 : 0,
    left: border.left && cell.left === rect.left + border.left ? 1 : 0,
  };
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/** Closed: the panel draws the one frame; no cell draws one. */
function assertPanelFrame(snapshot, label) {
  for (const color of snapshot.panel.colors) assert.notEqual(color, TRANSPARENT, `${label}: the panel draws the frame`);
  for (const [id, cell] of Object.entries(snapshot.cells))
    assert.equal(cell.frame, null, `${label}: ${id} draws no frame`);
}

/** The docked pane's column boxes: the dock takes exactly its room, nothing else moves. */
function expectedParts(closedParts, placement, dock) {
  const expected = structuredClone(closedParts);
  if (placement === 'right') {
    const right = dock.left - GAP - 1;
    for (const name of ['strip', 'stack', 'problems', 'footer']) if (expected[name]) expected[name].right = right;
    const width = Math.min(COMPOSER.width, right - expected.stack.left);
    // Auto margins split the free space in layout units (1/64 px), rounding down.
    expected.composer.left = expected.stack.left + Math.floor(((right - expected.stack.left - width) * 64) / 2) / 64;
    expected.composer.right = expected.composer.left + width;
    return expected;
  }
  const last = expected.footer ?? expected.problems ?? expected.stack;
  const rise = last.bottom - (dock.top - GAP - 1);
  expected.stack.bottom -= rise;
  for (const name of ['problems', 'footer']) {
    if (!expected[name]) continue;
    expected[name].top -= rise;
    expected[name].bottom -= rise;
  }
  expected.composer.bottom = expected.stack.bottom;
  expected.composer.top = expected.stack.bottom - COMPOSER.height;
  return expected;
}

/**
 * Open with an inline dock on `id`: every box but the docked column's is
 * unchanged to the pixel, the dock sits exactly where the sheet's ring and gap
 * put it, and every cell's frame covers exactly the ring the panel's border
 * painted, closing at one gap from the dock.
 */
function assertInline(closed, open, id, placement, label) {
  assert.deepEqual(open.handles, closed.handles, `${label}: every divider stays put`);
  assert.deepEqual(open.panel.rect, closed.panel.rect, `${label}: the panel keeps its box`);
  assert.deepEqual(open.panel.border, closed.panel.border, `${label}: the panel keeps its border widths`);
  for (const color of open.panel.colors)
    assert.equal(color, TRANSPARENT, `${label}: the panel's border is hidden, not doubled`);
  for (const [pane, before] of Object.entries(closed.cells)) {
    const after = open.cells[pane];
    const edges = edgesOf(closed, pane);
    const c = before.cell;
    let frame = {
      left: c.left - edges.left,
      top: c.top - edges.top,
      right: c.right + edges.right,
      bottom: c.bottom + edges.bottom,
    };
    let widths = { ...edges };
    if (pane !== id) {
      assert.deepEqual(after.parts, before.parts, `${label}: ${pane}'s column stays put`);
    } else {
      const dock = after.dock;
      if (placement === 'right') {
        assert.deepEqual(
          dock,
          {
            left: (edges.right ? c.right + 1 : c.right - GAP) - DOCK_WIDTH,
            top: c.top - edges.top,
            right: edges.right ? c.right + 1 : c.right - GAP,
            bottom: c.bottom + edges.bottom,
          },
          `${label}: the dock reaches the ring and keeps the sheet gap`
        );
        frame = { ...frame, right: dock.left - GAP };
        widths = { ...widths, right: 1 };
      } else {
        assert.deepEqual(
          dock,
          {
            left: c.left - edges.left,
            top: c.bottom + edges.bottom - DOCK_HEIGHT,
            right: c.right + edges.right,
            bottom: c.bottom + edges.bottom,
          },
          `${label}: the dock reaches the ring under the column`
        );
        frame = { ...frame, bottom: dock.top - GAP };
        widths = { ...widths, bottom: 1 };
      }
      assert.deepEqual(
        after.parts,
        expectedParts(before.parts, placement, dock),
        `${label}: only the dock's room leaves the column`
      );
    }
    assert.ok(after.frame, `${label}: ${pane} draws its frame`);
    assert.deepEqual(after.frame.widths, widths, `${label}: ${pane}'s frame draws exactly its outer and dock sides`);
    assert.deepEqual(
      after.frame.visible,
      frame,
      `${label}: ${pane}'s frame covers the ring and stops one gap from the dock`
    );
    for (const side of ['left', 'top', 'right', 'bottom']) {
      if (widths[side])
        assert.equal(after.frame.drawn[side], frame[side], `${label}: ${pane}'s ${side} line is painted, not clipped`);
    }
  }
}

async function cycle(page, id, placement, label) {
  const closed = await probe(page);
  assertPanelFrame(closed, `${label} closed`);
  await setDock(page, id, { open: true, placement });
  const open = await probe(page);
  assertInline(closed, open, id, placement, `${label} open`);
  await setDock(page, id, { open: false, placement });
  assert.deepEqual(await probe(page), closed, `${label}: closing puts every box back`);
}

for (const placement of ['right', 'bottom']) {
  test(`a dock ${placement === 'right' ? 'on the right' : 'below the chat'} takes exactly its room in every split, live open and close`, async (t) => {
    const page = await launch(t);
    for (const [name, { panes, html }] of Object.entries(LAYOUTS)) {
      for (const [fixtureName, fixture] of Object.entries(FIXTURES)) {
        for (const folded of [false, true]) {
          for (const id of panes) {
            await layout(page, html(fixture), { folded });
            await cycle(page, id, placement, `${name} ${fixtureName}${folded ? ' folded' : ''}, dock on ${id}`);
          }
        }
      }
    }
  });
}

test('with a skin the frame handoff is exact too', async (t) => {
  const page = await launch(t);
  for (const [name, { panes, html }] of Object.entries(LAYOUTS)) {
    for (const id of panes) {
      for (const placement of ['right', 'bottom']) {
        await layout(page, html(FIXTURES.full), { theme: 'skin' });
        await cycle(page, id, placement, `skin ${name} ${placement}, dock on ${id}`);
      }
    }
  }
});

test('an overlay dock floats at the sheet inset and moves nothing, beside an inline dock too', async (t) => {
  const page = await launch(t);
  for (const [name, { panes, html }] of Object.entries(LAYOUTS)) {
    for (const id of panes) {
      await layout(page, html(FIXTURES.full));
      const closed = await probe(page);
      await setDock(page, id, { open: true, placement: 'right', overlay: true });
      const open = await probe(page);
      const c = closed.cells[id].cell;
      const overlay = { left: c.right - GAP - DOCK_WIDTH, top: c.top, right: c.right - GAP, bottom: c.bottom - GAP };
      assert.deepEqual(open.cells[id].dock, overlay, `${name}: the overlay on ${id} sits inside its cell`);
      open.cells[id].dock = null;
      assert.deepEqual(open, closed, `${name}: an overlay on ${id} moves nothing`);
      const other = panes.find((pane) => pane !== id);
      if (!other) continue;
      await setDock(page, other, { open: true, placement: 'right' });
      assert.deepEqual(
        (await probe(page)).cells[id].dock,
        overlay,
        `${name}: ${other}'s inline dock leaves the overlay on ${id} in place`
      );
    }
  }
});

test('inline → expanded → inline keeps the column, with the spacer and with an expanded terminal or browser', async (t) => {
  const page = await launch(t);
  for (const [name, { panes, html }] of Object.entries(LAYOUTS)) {
    for (const id of panes) {
      for (const placement of ['right', 'bottom']) {
        for (const surface of [null, 'terminal', 'browser']) {
          const label = `${name} ${placement}${surface ? ` ${surface}` : ''}, dock on ${id}`;
          await layout(page, html(FIXTURES.full));
          const other = panes.find((pane) => pane !== id);
          // An expanded terminal or browser takes the whole panel: cell framing
          // steps aside even while another pane keeps an inline dock.
          if (surface && other) await setDock(page, other, { open: true, placement: 'right' });
          await setDock(page, id, { open: true, placement });
          const inline = await probe(page);
          await setDock(page, id, { open: true, placement, expanded: true });
          if (surface) {
            await page.evaluate(
              (kind, panel) => {
                const node = document.createElement('div');
                node.className = `session-${kind}-surface-container`;
                node.dataset.parked = 'false';
                node.dataset.expanded = 'true';
                node.style.cssText = `position:fixed;left:${panel.left}px;top:${panel.top}px;width:${panel.width}px;height:${panel.height}px`;
                document.body.append(node);
              },
              surface,
              PANEL
            );
          }
          const expanded = await probe(page);
          assert.deepEqual(
            expanded.cells[id].parts,
            inline.cells[id].parts,
            `${label}: expanding keeps the column where the inline dock left it`
          );
          // No inline dock is left framed: the panel draws the one frame again.
          assertPanelFrame(expanded, `${label} expanded`);
          assert.deepEqual(expanded.panel.rect, inline.panel.rect, `${label}: the panel keeps its box`);
          assert.deepEqual(expanded.handles, inline.handles, `${label}: every divider stays put`);
          if (surface) {
            await page.evaluate(() => {
              for (const node of document.querySelectorAll('body > [class$="-surface-container"]')) node.remove();
            });
          }
          await setDock(page, id, { open: true, placement });
          assert.deepEqual(await probe(page), inline, `${label}: back inline, every box is where it was`);
        }
      }
    }
  }
});

/**
 * A screenshot once every running transition has ended: a freshly inserted
 * divider fades its hairline in (pane-layout.css), and a shot taken mid-fade
 * compares a different colour.
 */
async function settledShot(page, clip) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  return page.screenshot({ clip });
}

/** Max per-channel difference between two screenshots outside `skip`. */
function pixelDiff(before, after, skip) {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  let max = 0;
  let at = null;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (skip(x, y)) continue;
      const i = (y * a.width + x) * 4;
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2])
      );
      if (d > max) {
        max = d;
        at = { x, y };
      }
    }
  }
  return { max, at };
}

test('the frame handoff paints the same ring, dividers and corners in dark, light and a skin', async (t) => {
  const page = await launch(t);
  const clip = { x: PANEL.left - 4, y: PANEL.top - 4, width: PANEL.width + 8, height: PANEL.height + 8 };
  const worst = {};
  const recoloured = [];
  for (const theme of ['dark', 'light', 'skin']) {
    for (const [name, { panes, html }] of Object.entries(LAYOUTS)) {
      for (const id of panes) {
        for (const placement of ['right', 'bottom']) {
          await layout(page, html(FIXTURES.bare), { theme });
          const closedShot = await settledShot(page, clip);
          await setDock(page, id, { open: true, placement });
          const open = await probe(page);
          const openShot = await settledShot(page, clip);
          const cell = open.cells[id].cell;
          const frame = open.cells[id].frame.visible;
          // The docked column's dock side with its corners, the gap and the dock.
          const skip = (x, y) => {
            const px = x + clip.x;
            const py = y + clip.y;
            if (px < cell.left - 1 || px > cell.right + 1 || py < cell.top - 1 || py > cell.bottom + 1) return false;
            return placement === 'right' ? px >= frame.right - RADIUS - 1 : py >= frame.bottom - RADIUS - 1;
          };
          const { max, at } = pixelDiff(closedShot, openShot, skip);
          const where = at ? ` at ${at.x + clip.x},${at.y + clip.y}` : '';
          worst[theme] = Math.max(worst[theme] ?? 0, max);
          if (max > 2) recoloured.push(`${theme} ${name} ${placement} dock on ${id}: ${max}${where}`);
        }
      }
    }
  }
  t.diagnostic(`max channel difference per theme: ${JSON.stringify(worst)}`);
  assert.deepEqual(recoloured, [], 'the handoff recolours no pixel by more than 2 levels');
});

/**
 * The device pixels a divider's line paints across it, at mid-length: every
 * pixel of a 9px band around the divider that differs from the plate beside it.
 */
async function paintedLine(page, direction, state) {
  const handle = await page.evaluate((dir) => {
    const box = document.querySelector(`.pane-split-${dir} > .pane-resize-handle`).getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  }, direction);
  const row = direction === 'row';
  const along = row ? Math.round((handle.top + handle.bottom) / 2) : Math.round((handle.left + handle.right) / 2);
  const start = Math.round(row ? handle.left : handle.top);
  await page.evaluate(
    (dir, dragging) => {
      document.querySelector(`.pane-split-${dir} > .pane-resize-handle`).classList.toggle('is-dragging', dragging);
    },
    direction,
    state === 'drag'
  );
  // Hover from the divider's own pixel; otherwise park the pointer far away.
  if (state === 'hover') await page.mouse.move(row ? start + 0.5 : along, row ? along : start + 0.5);
  else await page.mouse.move(5, 5);
  const clip = row ? { x: start - 4, y: along, width: 9, height: 1 } : { x: along, y: start - 4, width: 1, height: 9 };
  const shot = PNG.sync.read(await settledShot(page, clip));
  const value = (i) => shot.data.slice(i * 4, i * 4 + 3).join(',');
  const plate = value(0);
  const painted = [];
  for (let i = 0; i < 9; i++) if (value(i) !== plate) painted.push(clip[row ? 'x' : 'y'] + i);
  return { painted, handleStart: row ? handle.left : handle.top, start };
}

test('a divider paints its 1px line on its own pixel and the 3px accent one pixel either side, at whole and fractional positions', async (t) => {
  const page = await launch(t);
  const cases = [
    ['row', 0.5, 'whole'],
    ['row', 0.37, 'fractional'],
    ['column', 299 / 897, 'whole'],
    ['column', 0.46, 'fractional'],
  ];
  for (const [direction, ratio, position] of cases) {
    await layout(page, split(direction, leaf('a', FIXTURES.bare), leaf('b', FIXTURES.bare), ratio));
    for (const state of ['rest', 'hover', 'drag']) {
      const { painted, handleStart, start } = await paintedLine(page, direction, state);
      const label = `${direction} divider at ${handleStart} (${position}), ${state}`;
      assert.equal(Number.isInteger(handleStart), position === 'whole', `${label}: the fixture's position`);
      const expected = state === 'rest' ? [start] : [start - 1, start, start + 1];
      assert.deepEqual(painted, expected, `${label}: painted pixels`);
    }
  }
});

// The phone sheet is a fixed box under the body (the body's transform makes it
// the containing block), sliding in on a transform. Mid-slide its off-screen
// part is the body's overflow; a focus landing in the sheet (the terminal's
// input) scrolled the body sideways, and the whole app slid left and crept
// back with the sheet. The body clips instead of scrolling, so nothing can.
test('a phone sheet mid-slide never scrolls the app: focus inside it keeps every box in place', async (t) => {
  const page = await launch(t);
  await page.setViewport({ width: 412, height: 915 });
  const result = await page.evaluate(() => {
    document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
    document.getElementById('root').innerHTML = `
      <div class="app-shell"><main class="main-panel"><div class="pane-cell">
        <div id="chat" style="height:400px"></div>
        <div class="pane-side-dock" data-open="true" style="transform:translateX(200px);transition:none">
          <textarea id="field"></textarea>
        </div>
      </div></main></div>`;
    const chat = document.getElementById('chat');
    const before = chat.getBoundingClientRect().left;
    const field = document.getElementById('field');
    field.style.marginLeft = '300px';
    field.focus();
    field.scrollIntoView({ inline: 'end' });
    return {
      chatMoved: chat.getBoundingClientRect().left - before,
      body: document.body.scrollLeft,
      root: document.documentElement.scrollLeft,
    };
  });
  assert.deepEqual(result, { chatMoved: 0, body: 0, root: 0 });
});
