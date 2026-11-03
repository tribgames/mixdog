import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// Phone layout, real Chromium with touch: a remote page in the Visualize side
// sheet pinched smaller than 1x. The page is laid out at 1/scale of the pane
// and drawn scaled down (visualize-zoom.ts), but the scaled box's untransformed
// layout size still counted as scrollable overflow, so the pane scrolled on
// into empty space past the shrunken page: a blank frame instead of the
// fitted one. The pinch comes through the page's own bridge script, as on a
// phone (the page runs in an opaque-origin frame).
const HARNESS = `
  import { createRoot } from 'react-dom/client';
  import { VisualizePane } from './VisualizePane';
  import { applyVisualizeEvent } from './visualize-store';
  window.mixdogDesktop = { visualizeCommand: async () => ({}), visualizePaneSource: async () => ({ kind: 'html', srcdoc: window.pageHtml, contentId: 'c1' }) };
  window.showPanel = () => {
    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', active: 't1', tabs: [{ id: 't1', label: 'mockup.svg',
      revision: 0, panes: [{ kind: 'html', label: 'page.html', target: 'page.html', url: '' }] }] } });
    createRoot(document.querySelector('.workbench-side-section-body')).render(<VisualizePane sessionId="s1" active onClose={() => {}} />);
  };
  window.showViewer = (src = url) => {
    window.viewerClosed = false;
    createRoot(document.getElementById('viewer')).render(
      <ImageLightbox items={[{ id: 'a', src, name: 'mockup.svg' }]} startId="a" onClose={() => { window.viewerClosed = true; }} />);
  };
`;
// The phone's right sheet around the panel, as the shell mounts it.
const BODY = `<div id="root"><div class="app-shell"><div class="pane-side-dock" data-open="true"><div class="pane-side-dock-main">
  <aside class="workbench-side-panel" data-side="right" data-embedded="true"><div class="workbench-side-panel-content">
  <div class="workbench-side-panel-body"><section class="workbench-side-section" data-sectioned="false">
  <div class="workbench-side-section-body"></div></section></div></div></aside></div></div></div></div><div id="viewer"></div>`;
const VIEWPORT =
  'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';

const noLazyChunks = {
  name: 'no-lazy-chunks',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

async function openPhone(t) {
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
      outdir: 'phone-image-gestures',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: assets,
      plugins: [noLazyChunks],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./pane-layout.css"; @import "./pane-side-dock-bottom.css"; @import "./mobile-web-runtime.css";',
      },
      outfile: 'phone-image-gestures.css',
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
  await page.emulate({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  });
  const messages = [];
  page.on('pageerror', (error) => messages.push(error.message));
  page.on('console', (message) => messages.push(message.text()));
  await page.setContent(
    `<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="${VIEWPORT}"><style>${css
      .map((file) => file.text)
      .join('\n')}</style></head><body>${BODY}</body></html>`
  );
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  let time = Date.now() / 1000;
  const touch = async (type, points) => {
    time += 0.016;
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      timestamp: time,
      touchPoints: points.map(([x, y], id) => ({ x, y, id: id + 1 })),
    });
  };
  const tap = async (x, y) => {
    await touch('touchStart', [[x, y]]);
    await touch('touchEnd', []);
  };
  return { page, messages, touch, tap };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PAGE =
  '<body style="margin:0;background:#3a6"><div style="height:2000px;background:linear-gradient(#3a6,#d33)">page</div>';

test('phone Visualize sheet: a page pinched below 1x never scrolls into empty space and returns to 1x', async (t) => {
  const { page, touch } = await openPhone(t);
  await page.evaluate((html) => {
    window.pageHtml = html;
    window.showPanel();
  }, PAGE);
  // No relay here: the frame falls back to srcdoc after its ready timeout.
  // The page's bridge script ships inside that document and runs as it
  // parses, so the frame being revealed (its load) means it is listening.
  await page.waitForFunction(
    () => {
      const frame = document.querySelector('.visualize-pane-content iframe');
      return Boolean(frame?.srcdoc) && frame.style.visibility !== 'hidden';
    },
    { timeout: 10_000 }
  );
  const content = '.visualize-pane-content';
  const geometry = () =>
    page.$eval(content, (pane) => {
      const frame = pane.querySelector('iframe').getBoundingClientRect();
      return {
        scrollWidth: pane.scrollWidth,
        scrollHeight: pane.scrollHeight,
        clientWidth: pane.clientWidth,
        clientHeight: pane.clientHeight,
        frameWidth: frame.width,
        frameHeight: frame.height,
        layer: pane.querySelector('.visualize-zoom-layer').getAttribute('style'),
      };
    });
  const pinch = async (from, to, y) => {
    await touch('touchStart', [
      [195 - from, y],
      [195 + from, y],
    ]);
    for (let step = 1; step <= 20; step += 1) {
      const half = from + ((to - from) * step) / 20;
      await touch('touchMove', [
        [195 - half, y],
        [195 + half, y],
      ]);
      await wait(16);
    }
    await touch('touchEnd', []);
  };

  await pinch(150, 20, 500);
  // The frame's last pinch messages arrive after the fingers lift: the zoom
  // has settled once it has reached the 25% floor this pinch asks for.
  await page.waitForFunction(() => document.querySelector('.browser-zoom-percent span')?.textContent === '25%');
  const percent = await page.$eval('.browser-zoom-percent span', (element) => Number.parseInt(element.textContent, 10));
  assert.ok(percent < 100, `the pinch zoomed out (${percent}%)`);
  const small = await geometry();
  assert.ok(Math.abs(small.frameWidth - small.clientWidth) < 2, 'the scaled page fills the pane width');
  assert.ok(Math.abs(small.frameHeight - small.clientHeight) < 2, 'the scaled page fills the pane height');
  assert.equal(small.scrollWidth, small.clientWidth, 'nothing to scroll sideways past the page');
  assert.equal(small.scrollHeight, small.clientHeight, 'nothing to scroll down past the page');
  await page.$eval(content, (pane) => {
    pane.scrollTop = 1e6;
    pane.scrollLeft = 1e6;
  });
  assert.deepEqual(await page.$eval(content, (pane) => [pane.scrollLeft, pane.scrollTop]), [0, 0]);

  // Back up to 1x: the zoom layer is gone and the page fills the pane as before.
  for (let step = 0; step < 6 && (await geometry()).layer; step += 1)
    await page.$eval('[aria-label="Zoom in"]', (button) => button.click());
  const fit = await geometry();
  assert.ok(!fit.layer, 'back at 1x');
  assert.ok(Math.abs(fit.frameWidth - fit.clientWidth) < 1 && Math.abs(fit.frameHeight - fit.clientHeight) < 1);
});

