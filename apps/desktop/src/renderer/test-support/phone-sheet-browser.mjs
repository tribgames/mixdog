import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../../src/runtime/shared/browser-launch.mjs';

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

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openPhone(t, harness, name) {
  const resolveDir = fileURLToPath(new URL('..', import.meta.url));
  const assets = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: { resolveDir, loader: 'tsx', contents: harness },
      bundle: true,
      write: false,
      logLevel: 'error',
      format: 'iife',
      jsx: 'automatic',
      outdir: name,
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
      outfile: `${name}.css`,
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
