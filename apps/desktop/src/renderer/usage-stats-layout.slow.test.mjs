import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { resolveUsageStatsPeriod } from '../../../../src/standalone/usage-stats-period.mjs';

test('token usage stays centered and scrollable with titlebar insets, empty results and small viewports', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { CommandSurface } from "./CommandSurface";

          const root = createRoot(document.getElementById("root"));
          const period = ${JSON.stringify(resolveUsageStatsPeriod({
            view: 'hour', now: new Date(2026, 8, 13, 12).getTime(),
          }))};
          window.renderStats = (state) => {
            const empty = state === "empty";
            const route = {
              turns: empty ? 0 : 1, sessions: empty ? 0 : 1,
              input: empty ? 0 : 1000, output: empty ? 0 : 200,
              tokens: empty ? 0 : 1200, cacheRead: 0, cacheWrite: 0,
              cacheTokens: 0, costUsd: 0, costCoverage: 1, share: 1, models: [],
            };
            const value = {
              period, range: { days: period.days, firstDay: "2026-09-01" },
              totals: route,
              providers: empty ? [] : [{ ...route, provider: "openai", providerKind: "api" }],
              daily: [], hourly: [], coverage: {},
            };
            const api = {
              invokeCapability: () => state === "loading"
                ? new Promise(() => {})
                : Promise.resolve({ value }),
            };
            root.render(<CommandSurface key={state} surface="stats" open onClose={() => {}} api={api} />);
          };
        `,
      },
      bundle: true,
      write: false,
      outfile: 'usage-stats-layout.js',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: '@import "./ui/tokens.css"; @import "./desktop.css";',
      },
      outfile: 'usage-stats-layout.css',
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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css'))) {
    await page.addStyleTag({ content: file.text });
  }
  await page.addStyleTag({
    content: `
      html:not([data-mixdog-mobile-tabs]) .mixdog-settings-layer {
        --settings-layer-safe-top: 43px;
        --settings-layer-safe-bottom: 16px;
      }
    `,
  });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });

  for (const viewport of [
    { width: 1160, height: 831 },
    { width: 1440, height: 1100 },
    { width: 640, height: 400 },
    { width: 980, height: 1800, mobile: true, scale: 2.5 },
  ]) {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.evaluate(({ mobile, scale }) => {
      document.documentElement.toggleAttribute('data-mixdog-mobile-tabs', Boolean(mobile));
      document.documentElement.style.setProperty('--mx-device-scale', String(scale || 1));
    }, viewport);
    for (const state of ['loading', 'populated', 'empty']) {
      await page.evaluate((state) => window.renderStats(state), state);
      await page.waitForFunction((state) => {
        const surface = document.querySelector('.stats-surface');
        if (!surface) return false;
        if (state === 'loading') return surface.dataset.loading === 'true';
        if (surface.dataset.loading === 'true') return false;
        return state === 'empty'
          ? surface.dataset.empty === 'true'
          : Boolean(surface.querySelector('.stats-provider-row'));
      }, {}, state);
      const layout = await page.evaluate(async () => {
        await document.fonts.ready;
        const dialog = document.querySelector('.command-surface');
        const body = dialog.querySelector('.mixdog-settings__body');
        const layer = dialog.parentElement;
        const rect = dialog.getBoundingClientRect();
        body.scrollTop = body.scrollHeight;
        return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          layerOverflow: layer.scrollHeight - layer.clientHeight,
          bodyOverflow: body.scrollHeight - body.clientHeight,
          scrollTop: body.scrollTop,
          scrollEnd: body.scrollHeight - body.clientHeight - body.scrollTop,
        };
      });
      const label = `${state} at ${viewport.width}x${viewport.height}`;
      assert.ok(
        Math.abs(layout.left - (viewport.width - layout.right)) <= 1,
        `horizontal center: ${label}, left=${layout.left}, right inset=${viewport.width - layout.right}`
      );
      assert.ok(
        Math.abs(layout.top - (viewport.height - layout.bottom)) <= 1,
        `vertical center: ${label}, top=${layout.top}, bottom inset=${viewport.height - layout.bottom}`
      );
      const safeTop = viewport.mobile ? 12 * viewport.scale : 43;
      assert.ok(layout.top >= safeTop - 1, `titlebar clearance: ${label}`);
      assert.ok(layout.bottom <= viewport.height - safeTop + 1, `bottom clearance: ${label}`);
      assert.ok(layout.layerOverflow <= 1, `overlay does not scroll: ${label}`);
      assert.ok(Math.abs(layout.scrollEnd) <= 1, `body reaches its last content: ${label}`);
      if (viewport.height === 400 && state !== 'empty') {
        assert.ok(layout.bodyOverflow > 0 && layout.scrollTop > 0, `small-window content scrolls: ${label}`);
      }
    }
  }
  assert.deepEqual(errors, [], 'no renderer errors');
});
