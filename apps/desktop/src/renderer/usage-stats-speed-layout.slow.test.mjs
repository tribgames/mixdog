import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { usageSnapshot } from './test-support/usage-stats-fixture.mjs';

// Vite gives every dynamic import its own chunk, so a surface only loads what
// it opens. esbuild cannot code-split an `iife` bundle, so it inlines those
// chunks instead — for this surface that dragged in the editor chunk, and with
// it Monaco, 16MB of editor sources and Monaco's `?worker` imports, a Vite-only
// suffix esbuild has no way to resolve. Holding the dynamic-import boundary
// external reproduces the graph this surface really loads: token usage opens no
// editor, and a lazy module it did need would surface as a renderer error.
const lazyChunkBoundary = {
  name: 'lazy-chunk-boundary',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: args.path, external: true } : null
    );
  },
};

const LONG_MODEL = 'claude-sonnet-4-6-with-a-very-long-model-identifier';

// A subscription answer built by hand: a model in both modes and a long Fast-only one, in one five-hour window.
function quotaAnswer() {
  const minute = 60_000;
  const opened = new Date(2026, 8, 30, 13).getTime();
  const resetAt = opened + 5 * 60 * minute;
  const viewedAt = opened + 2 * 60 * minute;
  const route = (model, fields = {}) => ({
    model,
    consumed: 3,
    turns: 1,
    input: 100000,
    output: 300,
    cacheRead: 0,
    tokens: 100300,
    costUsd: 1,
    outputTokensPerSecond: 150,
    ...fields,
  });
  const models = [
    route('claude-opus-5-5'),
    route('claude-opus-5-5', { speedTier: 'fast', output: 600, tokens: 100600, outputTokensPerSecond: 300 }),
    route(LONG_MODEL, { speedTier: 'fast' }),
  ];
  const domain = { fromMs: opened, toMs: resetAt };
  return {
    generatedAt: viewedAt,
    view: 'window',
    selection: { provider: 'anthropic-oauth', account: 'default', label: '5H' },
    subscriptions: [{ provider: 'anthropic-oauth', account: 'default', accountLabel: 'Account 1', accountRank: 0, accountInRoster: true, windows: ['5H'] }],
    period: domain,
    domain,
    focus: { usedPct: 10, resetAt, startMs: opened, endMs: resetAt, current: true, peak: 10 },
    summary: { consumed: 9, costUsd: 3 },
    totals: { turns: 3, input: 300000, output: 1200, tokens: 301500, costUsd: 3 },
    points: [[opened, 0, 1], [viewedAt, 10, 1]],
    models,
    modelSeries: [],
    slots: [],
  };
}
test('TOK/S, Share and every kept column fit 375px and 390px in both usage tables; a Fast row keeps its marker', async (t) => {
  const quota = quotaAnswer();
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import "./process-shim";
          import React from "react";
          import { flushSync } from "react-dom";
          import { createRoot } from "react-dom/client";
          import { CommandSurface } from "./CommandSurface";
          import { focusQuotaUsage } from "./usage-surface-mode";
          // The shipped UI font, so every OS measures the same column widths.
          import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";

          // Each render commits before it returns. Otherwise the previous
          // width's rows (a name tapped open there) still satisfy the row wait
          // and get measured in place of the new render.
          let generation = 0;
          window.renderQuota = (value) => {
            focusQuotaUsage("anthropic-oauth");
            const api = { invokeCapability: () => Promise.resolve({ value }) };
            flushSync(() =>
              root.render(<CommandSurface key={"quota" + generation++} surface="stats" open onClose={() => {}} api={api} />)
            );
          };
          const root = createRoot(document.getElementById("root"));
          const period = ${JSON.stringify(
            usageSnapshot('hour').period
          )};
          window.renderStats = () => {
            const route = {
              turns: 195, sessions: 4, input: 234000, output: 56000, tokens: 1234000,
              cacheRead: 9000000, cacheWrite: 100000, cacheTokens: 9100000, costUsd: 12.34,
              costCoverage: 1, costKnownTurns: 195, share: 1, cacheHitRate: 0.93,
              outputTokensPerSecond: 93,
            };
            const model = (name, extra = {}) => ({ ...route, model: name, ...extra });
            const provider = {
              ...route, provider: "anthropic-oauth", providerKind: "oauth",
              models: [
                model("claude-opus-5-5"),
                model("claude-opus-5-5", { fast: true, outputTokensPerSecond: 148 }),
                model("claude-sonnet-4-6-with-a-very-long-model-identifier", { fast: true }),
              ],
            };
            const value = {
              period, range: { days: period.days, firstDay: "2026-09-01" },
              totals: route, providers: [provider], daily: [], hourly: [], coverage: {},
            };
            const api = { invokeCapability: () => Promise.resolve({ value }) };
            flushSync(() => root.render(<CommandSurface surface="stats" open onClose={() => {}} api={api} />));
          };
        `,
      },
      bundle: true,
      write: false,
      outfile: 'usage-stats-speed-layout.js',
      format: 'iife',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl' },
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.url': '"http://mixdog.test/assets/index.js"',
      },
      plugins: [lazyChunkBoundary],
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./desktop.css";',
      },
      outfile: 'usage-stats-speed-layout.css',
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
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });

  const measure = () =>
    page.evaluate(async () => {
      const table = document.querySelector('.stats-table');
      await document.fonts.load('14px "Pretendard Variable"', table.textContent);
      await document.fonts.ready;
      const rect = (node) => node.getBoundingClientRect();
      const headers = [...table.querySelectorAll('thead th')].map((th) => ({
        text: th.textContent,
        shown: rect(th).width > 0,
        width: Math.round(rect(th).width),
      }));
      const wrap = table.parentElement;
      const rows = [...table.querySelectorAll('.stats-model-row')]
        .filter((row) => row.cells.length > 3)
        .map((row) => {
          const name = row.cells[0];
          const label = name.querySelector('.usage-model-name');
          const fast = name.querySelector('.usage-model-fast');
          return {
            name: name.textContent,
            title: name.title,
            truncated: label.scrollWidth > label.clientWidth + 1,
            nameWidth: Math.round(rect(name).width),
            fastInside: fast ? rect(fast).width > 0 && rect(fast).right <= rect(name).right + 0.5 : null,
            fastText: fast?.textContent ?? null,
            shown: [...row.cells].map((cell) => rect(cell).width > 0),
            speed: row.cells[3].textContent,
            right: rect(row.cells[row.cells.length - 1]).right,
          };
        });
      const bars = [...table.querySelectorAll('.stats-provider-cell')].map((cell) => ({
        barRight: rect(cell.querySelector('.stats-share')).right,
        cellRight: rect(cell).right - Number.parseFloat(getComputedStyle(cell).paddingRight),
      }));
      return {
        fontLoaded: document.fonts.check('14px "Pretendard Variable"', table.textContent),
        bars,
        headers,
        rows,
        tableWidth: Math.round(rect(table).width),
        wrapClientWidth: wrap.clientWidth,
        wrapScrollWidth: wrap.scrollWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewport: window.innerWidth,
      };
    });
  const widths = {};
  const tables = [
    { kind: 'token usage', render: () => window.renderStats(), rowCount: 3, speeds: ['93', '148', '93'] },
    { kind: 'subscription', render: (value) => window.renderQuota(value), rowCount: 3, arg: quota },
  ];
  for (const { kind, render, rowCount, speeds, arg } of tables) {
    for (const width of [375, 390, 1160]) {
      await page.setViewport({ width, height: 844 });
      await page.evaluate((mobile) => {
        document.documentElement.toggleAttribute('data-mixdog-mobile-tabs', mobile);
      }, width < 681);
      await page.evaluate(render, arg);
      await page
        .waitForFunction(
          (count) => document.querySelectorAll('.stats-table .stats-model-row td.stats-model-cell').length >= count,
          { timeout: 5000 },
          rowCount
        )
        .catch(async (error) => {
          throw new Error(
            `${error.message}: ${await page.evaluate(() => document.body.innerText.slice(0, 600))} ${errors}`
          );
        });
      const layout = await measure();
      const label = `${kind} at ${width}px`;
      assert.ok(layout.fontLoaded, `the shipped UI font is loaded ${label}`);
      widths[label] = {
        table: layout.tableWidth,
        wrap: layout.wrapClientWidth,
        scroll: layout.wrapScrollWidth,
        names: layout.rows.map((row) => row.nameWidth),
      };
      const fastRows = layout.rows.filter((row) => row.fastText !== null);
      assert.ok(fastRows.length >= 2, `Fast rows are listed ${label}`);
      for (const row of fastRows) {
        assert.ok(row.fastInside, `the Fast marker stays inside the name cell ${label}: ${row.name}`);
        assert.match(row.fastText, /·\s*Fast/, `the Fast marker reads · Fast ${label}`);
        assert.match(row.title, /Fast/, `the full Fast name stays in the title ${label}`);
      }
      assert.ok(
        layout.rows.every((row) => row.title.length >= row.name.replace(/…$/, '').length - 1),
        `the title keeps the full name ${label}`
      );
      assert.ok(
        layout.rows.every((row) => row.shown[1] && row.shown[2] && row.shown[3] && row.shown[row.shown.length - 1]),
        `Share, requests, TOK/S and value cells are all shown ${label}`
      );
      if (speeds)
        assert.deepEqual(
          layout.rows.map((row) => row.speed),
          speeds,
          `speeds ${label}`
        );
      assert.ok(
        layout.wrapScrollWidth <= layout.wrapClientWidth + 1,
        `table does not scroll sideways ${label}: ${JSON.stringify(layout)}`
      );
      assert.ok(layout.pageOverflow <= 0, `page does not overflow ${label}`);
      assert.ok(
        layout.rows.every((row) => row.right <= layout.viewport + 0.5),
        `rows stay on screen ${label}`
      );
      const longRow = layout.rows.find((row) => /very.long/i.test(row.title));
      const folded = layout.headers.filter((header) => !header.shown).length;
      if (width < 681) {
        assert.ok(folded >= 2, `other optional columns still fold ${label}`);
        assert.ok(longRow?.truncated, `a long model name truncates with an ellipsis ${label}`);
        assert.ok(
          layout.bars.length > 0 && layout.bars.every((bar) => bar.barRight <= bar.cellRight + 0.5),
          `the provider share bar stays inside its cell ${label}: ${JSON.stringify(layout.bars)}`
        );
        // A tap, then Enter on the next focused cell, unclips the name in place.
        const reveal = async (index, act) => {
          const cell = (await page.$$('.stats-table .stats-model-cell .usage-model-toggle'))[index];
          await act(cell);
          return page.evaluate((i) => {
            const cell = document.querySelectorAll('.stats-table .stats-model-cell')[i];
            const name = cell.querySelector('.usage-model-name');
            const fast = cell.querySelector('.usage-model-fast');
            return {
              text: name.textContent,
              expanded: cell.querySelector('button').getAttribute('aria-expanded'),
              unclipped: name.scrollWidth <= name.clientWidth + 1,
              fastVisible: fast ? fast.getBoundingClientRect().right <= cell.getBoundingClientRect().right + 0.5 : null,
              overflow:
                document.querySelector('.stats-table').parentElement.scrollWidth -
                document.querySelector('.stats-table').parentElement.clientWidth,
            };
          }, index);
        };
        const longIndex = layout.rows.indexOf(longRow);
        const tapped = await reveal(longIndex, (cell) => cell.tap());
        assert.equal(tapped.expanded, 'true', `tapping a name expands it ${label}`);
        assert.ok(tapped.unclipped, `the tapped name shows in full ${label}`);
        assert.ok(tapped.fastVisible, `the Fast marker stays visible when expanded ${label}`);
        assert.ok(tapped.overflow <= 1, `expanding does not scroll the table sideways ${label}`);
        assert.match(tapped.text, /very.long/i);
        const keyed = await reveal(1, async (cell) => {
          await cell.focus();
          await page.keyboard.press('Enter');
        });
        assert.equal(keyed.expanded, 'true', `Enter expands a focused name ${label}`);
        assert.ok(keyed.unclipped, `the keyboard-expanded name shows in full ${label}`);
        await page.keyboard.press('Enter');
      } else {
        assert.equal(folded, 0, `every column shows on a wide screen ${label}`);
        const chrome = await page.evaluate(() => ({
          buttons: document.querySelectorAll('.stats-model-cell button, .stats-model-cell [aria-expanded]').length,
          focusable: document.querySelectorAll('.stats-model-cell [tabindex], .stats-model-cell button').length,
          cells: document.querySelectorAll('.stats-model-cell').length,
        }));
        assert.ok(chrome.cells >= rowCount, `model name cells render ${label}`);
        assert.equal(chrome.buttons + chrome.focusable, 0, `a desktop name is plain text, no toggle button ${label}`);
      }
    }
  }
  console.log('measured widths', JSON.stringify(widths));
  assert.deepEqual(errors, [], 'no renderer errors');
});
