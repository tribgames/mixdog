import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { resolveUsageStatsPeriod } from '../../../../src/standalone/usage-stats-period.mjs';

// The usage dialog ("모델 통계") on an iPhone: it covers the screen and shell
// behind it is inert, so the dialog MUST always carry its own way out. This
// opens it at phone viewports under an iOS user agent (Chromium emulation;
// WebKit itself is not available here) with the device's safe-area insets,
// then closes it by the close button and by a tap outside the card. Set
// MIXDOG_QA_DIR to keep the screenshots.

const lazyChunkBoundary = {
  name: 'lazy-chunk-boundary',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MixdogApp/1';

// Chromium has no safe-area emulation in headless runs: the insets an iPhone
// reports are substituted for env() before the stylesheet loads.
const INSETS = { top: '59px', right: '0px', bottom: '34px', left: '0px' };
const withInsets = (css) =>
  css.replace(/env\(safe-area-inset-(top|right|bottom|left)\s*,\s*([^)]*)\)/g, (_, side) => INSETS[side]);

test('the usage dialog closes by its button and by an outside tap on a phone', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const shots = process.env.MIXDOG_QA_DIR || '';
  if (shots) mkdirSync(shots, { recursive: true });
  const [bundle, styles] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import "./process-shim";
          import React, { useState } from "react";
          import { createRoot } from "react-dom/client";
          import { CommandSurface } from "./CommandSurface";

          const period = ${JSON.stringify(
            resolveUsageStatsPeriod({ view: 'hour', now: new Date(2026, 8, 13, 12).getTime() })
          )};
          const route = {
            turns: 3, sessions: 1, input: 1000, output: 200, tokens: 1200, cacheRead: 0, cacheWrite: 0,
            cacheTokens: 0, costUsd: 0, costCoverage: 1, share: 1,
            models: [{ model: "gpt-5", turns: 3, tokens: 1200, input: 1000, output: 200, share: 1 }],
          };
          const value = {
            period, range: { days: period.days, firstDay: "2026-09-01" }, totals: route,
            providers: [{ ...route, provider: "openai", providerKind: "api" }],
            daily: [], hourly: [], coverage: {},
          };
          const api = { invokeCapability: () => Promise.resolve({ value }) };
          window.tapLog = [];
          function App() {
            const [open, setOpen] = useState(false);
            return (
              <div className="app-shell">
                <button id="open-usage" type="button" onClick={() => setOpen(true)}>usage</button>
                <button id="behind" type="button" onClick={() => window.tapLog.push("behind")}>behind</button>
                {open && <CommandSurface surface="stats" open onClose={() => setOpen(false)} api={api} />}
              </div>
            );
          }
          createRoot(document.getElementById("root")).render(<App />);
        `,
      },
      bundle: true,
      write: false,
      outfile: 'usage-stats-phone-dismiss.js',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://mixdog.test/assets/index.js"' },
      plugins: [lazyChunkBoundary],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents:
          '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./desktop.css"; @import "./mobile-web-runtime.css";',
      },
      outfile: 'usage-stats-phone-dismiss.css',
      bundle: true,
      write: false,
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    }),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const css = bundle.outputFiles.filter((file) => file.path.endsWith('.css')).map((file) => file.text);
  css.unshift(styles.outputFiles[0].text);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 375, height: 667 },
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setUserAgent(IOS_UA);
    await page.setViewport({ ...viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setContent(
      '<!doctype html><html data-mixdog-mobile-tabs data-mixdog-ios-web><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"></head><body><div id="root"></div></body></html>'
    );
    // The shell tracks the visual viewport through these (shell-viewport.ts).
    await page.evaluate(({ width, height }) => {
      const root = document.documentElement.style;
      root.setProperty('--vvw', `${width}px`);
      root.setProperty('--vvh', `${height}px`);
    }, viewport);
    await page.addStyleTag({ content: 'html, body { margin: 0; }' });
    for (const text of css) await page.addStyleTag({ content: withInsets(text) });
    await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
    const label = `${viewport.width}x${viewport.height}`;

    const open = async () => {
      await page.tap('#open-usage');
      await page.waitForSelector('.command-surface .stats-provider-row');
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
            .map((animation) => animation.finished.catch(() => undefined))
        );
      });
    };
    const isOpen = () => page.evaluate(() => Boolean(document.querySelector('.command-surface')));

    await open();
    if (shots) await page.screenshot({ path: join(shots, `open-${label}.png`) });
    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box && { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      };
      const close = document.querySelector('.mixdog-settings__close');
      const box = close.getBoundingClientRect();
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return {
        close: rect('.mixdog-settings__close'),
        dialog: rect('.command-surface'),
        closeHit: close === hit || close.contains(hit),
        vh: window.innerHeight,
        vw: window.innerWidth,
      };
    });
    assert.ok(layout.closeHit, `close button is hit-testable: ${label}`);
    assert.ok(layout.close.top >= 59, `close button sits below the notch inset: ${label} top=${layout.close.top}`);
    assert.ok(layout.close.bottom <= layout.vh - 34, `close button above the home indicator: ${label}`);
    assert.ok(layout.close.right <= layout.vw && layout.close.left >= 0, `close button on screen: ${label}`);
    assert.ok(layout.dialog.top >= 59, `dialog clears the notch inset: ${label} top=${layout.dialog.top}`);
    assert.ok(layout.dialog.bottom <= layout.vh - 34, `dialog clears the home indicator: ${label}`);

    await page.tap('.mixdog-settings__close');
    await page.waitForFunction(() => !document.querySelector('.command-surface'));
    assert.equal(await isOpen(), false, `close button dismisses: ${label}`);

    // iOS synthesizes no mouse events for a tap on a plain div (only pointer
    // and click events), so none may be needed to dismiss.
    await page.evaluate(() => {
      for (const type of ['mousedown', 'mouseup']) {
        document.addEventListener(type, (event) => event.stopImmediatePropagation(), true);
      }
    });
    await open();
    // Tap the scrim above the card, inside the notch band.
    await page.touchscreen.tap(viewport.width / 2, 8);
    await page.waitForFunction(() => !document.querySelector('.command-surface'), { timeout: 3000 }).catch(() => {});
    assert.equal(await isOpen(), false, `outside tap dismisses: ${label}`);
    assert.deepEqual(await page.evaluate(() => window.tapLog), [], `the tap does not reach the shell: ${label}`);
    if (shots) await page.screenshot({ path: join(shots, `closed-${label}.png`) });
    assert.deepEqual(errors, [], 'no renderer errors');
    await page.close();
  }
});
