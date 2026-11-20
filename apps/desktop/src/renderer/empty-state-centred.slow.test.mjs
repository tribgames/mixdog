import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// The shared empty state (.mx-empty-state) in real renderer CSS, real
// components, headless Chrome: a pane or list with nothing to show centres its
// line in the area it stands in for, at every size.

const noLazyChunks = {
  name: 'no-lazy-chunks',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

/** A page with the renderer's stylesheets, `body` as markup and `harness`
 *  (TSX, resolved from this folder) run on it. */
async function openPage(t, harness, body) {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const assets = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: harness },
      bundle: true,
      write: false,
      logLevel: 'error',
      format: 'iife',
      jsx: 'automatic',
      outdir: 'empty-state-centred',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: assets,
      plugins: [noLazyChunks],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./pane-layout.css";',
      },
      outfile: 'empty-state-centred.css',
      bundle: true,
      write: false,
      logLevel: 'error',
      loader: { ...assets, '.jpg': 'dataurl' },
    }),
  ]);
  const css = [styles, bundle].flatMap((result) => result.outputFiles.filter((file) => file.path.endsWith('.css')));
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.setContent(
    `<!doctype html><html><head><style>${css.map((file) => file.text).join('\n')}</style></head><body>${body}</body></html>`
  );
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  return page;
}

const resize = (page, width, height) =>
  page.$eval('#frame', (frame, [w, h]) => Object.assign(frame.style, { width: `${w}px`, height: `${h}px` }), [
    width,
    height,
  ]);

// The Visualize side panel with nothing opened showed its line directly under
// the header, left-aligned, the rest of the tall pane empty.
test('Visualize with nothing opened centres its line under the header at every pane size', async (t) => {
  const page = await openPage(
    t,
    `
      import { createRoot } from 'react-dom/client';
      import { VisualizePane } from './VisualizePane';
      window.mixdogDesktop = { visualizeCommand: async () => ({}) };
      createRoot(document.querySelector('.workbench-side-section-body')).render(
        <VisualizePane sessionId="s1" active onClose={() => {}} />
      );
    `,
    // The right dock around the panel, as the shell mounts it.
    `<div id="frame" style="display:flex;width:360px;height:800px">
      <aside class="workbench-side-panel" data-side="right" style="width:100%"><div class="workbench-side-panel-content">
      <div class="workbench-side-panel-body"><section class="workbench-side-section" data-sectioned="false">
      <div class="workbench-side-section-body"></div></section></div></div></aside></div>`
  );
  await page.waitForSelector('.visualize-pane .visualize-empty');
  // The line's glyphs against the area the empty pane leaves under its header.
  const measure = () =>
    page.$eval('.visualize-pane .visualize-empty', (empty) => {
      const range = document.createRange();
      range.selectNodeContents(empty);
      const text = range.getBoundingClientRect();
      const pane = empty.closest('.visualize-pane').getBoundingClientRect();
      const above = empty.previousElementSibling.getBoundingClientRect();
      return {
        dx: (text.left + text.right) / 2 - (pane.left + pane.right) / 2,
        dy: (text.top + text.bottom) / 2 - (above.bottom + pane.bottom) / 2,
        paneHeight: pane.height,
      };
    });
  for (const [width, height] of [
    [360, 800],
    [240, 360],
    [640, 1200],
  ]) {
    await resize(page, width, height);
    const { dx, dy, paneHeight } = await measure();
    assert.ok(Math.abs(paneHeight - height) < 1, `the pane fills the ${width}x${height} dock (${paneHeight})`);
    assert.ok(Math.abs(dx) < 1, `centred horizontally at ${width}x${height} (off by ${dx})`);
    assert.ok(Math.abs(dy) < 1, `centred vertically at ${width}x${height} (off by ${dy})`);
  }
});

// An empty request log kept its line in a cell just under the headers, and in
// a card narrower than the 908px table it centred on the table, out of view.
test('an empty usage table centres its line in the visible table body, the header untouched', async (t) => {
  const page = await openPage(
    t,
    `
      import { createRoot } from 'react-dom/client';
      import { UsageRequestLog } from './UsageRequestLog';
      const api = {
        invokeCapability: async () => ({ value: { requests: [], models: [], period: { view: 'hour' }, generatedAt: Date.now() } }),
      };
      window.mixdogDesktop = api;
      createRoot(document.querySelector('.command-surface-content')).render(<UsageRequestLog api={api} />);
    `,
    // The usage dialog's body column, at the size under test.
    `<div id="frame" class="command-surface" data-surface="stats" style="display:flex;flex-direction:column;width:420px;height:640px">
      <div class="command-surface-content"></div></div>`
  );
  await page.waitForSelector('.request-log-table .usage-empty .mx-empty-state');
  const measure = () =>
    page.$eval('.request-log-table .usage-empty .mx-empty-state', (empty) => {
      const range = document.createRange();
      range.selectNodeContents(empty);
      const text = range.getBoundingClientRect();
      const shell = empty.closest('.usage-table-shell');
      const box = shell.getBoundingClientRect();
      const table = shell.querySelector('table');
      const head = shell.querySelector('thead').getBoundingClientRect();
      // The header's own height: the same table at its content height.
      table.style.height = 'auto';
      const ownHeadHeight = shell.querySelector('thead').getBoundingClientRect().height;
      table.style.height = '';
      const left = box.left + shell.clientLeft;
      return {
        dx: (text.left + text.right) / 2 - (left + left + shell.clientWidth) / 2,
        dy: (text.top + text.bottom) / 2 - (head.bottom + box.top + shell.clientTop + shell.clientHeight) / 2,
        headHeight: head.height,
        ownHeadHeight,
        overflowY: shell.scrollHeight - shell.clientHeight,
        tableWidth: shell.querySelector('table').getBoundingClientRect().width,
      };
    });
  for (const [width, height] of [
    [420, 640],
    [1100, 900],
  ]) {
    await resize(page, width, height);
    const { dx, dy, headHeight, ownHeadHeight, overflowY, tableWidth } = await measure();
    if (width < 908) assert.ok(tableWidth >= 908, `the table keeps its width at ${width}px (${tableWidth})`);
    assert.ok(Math.abs(headHeight - ownHeadHeight) < 1, `the header keeps its own height (${headHeight})`);
    assert.ok(overflowY <= 1, `the body fills the card without scrolling (${overflowY})`);
    assert.ok(Math.abs(dx) < 1, `centred in the visible width at ${width}x${height} (off by ${dx})`);
    assert.ok(Math.abs(dy) < 1, `centred under the header at ${width}x${height} (off by ${dy})`);
  }
});

// A loading line under a stacked spinner sat about 12px below the middle.
test('a loading state keeps its spinner beside the line, the line on the centre', async (t) => {
  const page = await openPage(
    t,
    `
      import { createRoot } from 'react-dom/client';
      import { EditorPaneLoadingSurface } from './editor-pane-surfaces';
      createRoot(document.getElementById('frame')).render(<EditorPaneLoadingSurface breadcrumbs={null} />);
    `,
    '<div id="frame" style="display:flex;flex-direction:column;width:480px;height:600px"></div>'
  );
  await page.waitForSelector('.editor-pane-notice.mx-empty-state p');
  const { spinnerMid, textMid, areaMid } = await page.$eval('.editor-pane-notice', (notice) => {
    const spinner = notice.querySelector('.progress-spinner').getBoundingClientRect();
    const text = notice.querySelector('p').getBoundingClientRect();
    const area = notice.getBoundingClientRect();
    return {
      spinnerMid: (spinner.top + spinner.bottom) / 2,
      textMid: (text.top + text.bottom) / 2,
      areaMid: (area.top + area.bottom) / 2,
    };
  });
  assert.ok(Math.abs(spinnerMid - textMid) < 1, `spinner beside the line (${spinnerMid} vs ${textMid})`);
  assert.ok(Math.abs(textMid - areaMid) < 1, `the line on the centre (off by ${textMid - areaMid})`);
});
