import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { usagePinStackHeight } from './rail-usage-pin-room.ts';

/** SidebarUsage inside the rail popup in a real Chrome, with the app's
    stylesheets; `rows` is the dashboard rows' source (has `quota` and `hour`). */
async function openUsagePopup(t, rows) {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { SidebarUsage } from "./SidebarUsage";
        import { publishUsageDashboard } from "./usage-dashboard-store";
        import { DESKTOP_SIDEBAR_DEFAULT_WIDTH } from "../shared/window-layout";

        const hour = 3600000;
        const quota = (label, usedPct, hours) => ({
          label, usedPct,
          resetAt: hours === null ? null : Date.now() + hours * hour + 30000,
        });
        const dashboard = { rows: ${rows} };
        const api = { async invokeCapability({ capability }) {
          return { value: capability === "getUsageDashboard" ? dashboard : {
            selectedId: "test", auto: true, accounts: [],
          } };
        } };
        publishUsageDashboard(dashboard);
        createRoot(document.getElementById("root")).render(
          <div className="rail-usage-popup" data-state="open" style={{
            width: DESKTOP_SIDEBAR_DEFAULT_WIDTH + 88,
            maxWidth: "calc(100vw - 116px)",
          }}>
            <SidebarUsage api={api} />
          </div>
        );
      `,
    },
    bundle: true,
    write: false,
    outfile: 'sidebar-usage-layout.js',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return openPage(t, bundle, '.sidebar-usage-meter > em');
}

/** A bundled renderer entry in a real Chrome with the app's stylesheets. */
async function openPage(t, bundle, readySelector) {
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents: `
        @import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
        @import "./font-faces.css";
        @import "./ui/tokens.css";
        @import "./desktop.css";
      `,
    },
    outfile: 'sidebar-usage-layout.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const renderError = new Promise((_, reject) => page.once('pageerror', reject));
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addStyleTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await Promise.race([page.waitForSelector(readySelector), renderError]);
  return page;
}

/** The real ActivityRail, pinned in "5-hour + longest period" mode, on a
    2000px rail; `window.showUsage(rows)` republishes the dashboard. */
async function openRail(t, rows) {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { ActivityRail } from "./ActivityRail";
        import { publishUsageDashboard } from "./usage-dashboard-store";

        let dashboard = { rows: ${rows} };
        window.showUsage = (next) => {
          dashboard = { rows: next };
          publishUsageDashboard(dashboard);
        };
        window.mixdogDesktop = {
          readActivityRailPins: async () => null,
          subscribeActivityRailPins: () => () => {},
          readSettings: async () => ({ usagePinned: true, usageRailShortLong: true }),
          updateSetting: async () => ({}),
        };
        const api = { async invokeCapability({ capability }) {
          return { value: capability === "getUsageDashboard" ? dashboard : { selectedId: null, accounts: [] } };
        } };
        publishUsageDashboard(dashboard);
        createRoot(document.getElementById("root")).render(
          <div style={{ display: "flex", height: "2000px" }}>
            <ActivityRail settingsOpen={false} onOpenSettings={() => {}} usageApi={api}
              navigationItems={[]} activeNavigationId={null} onSelectNavigation={() => {}} />
          </div>
        );
      `,
    },
    bundle: true,
    write: false,
    outfile: 'activity-rail-layout.js',
    format: 'iife',
    jsx: 'automatic',
    // The rail's module graph reaches the changelog text, Monaco's codicon font
    // and the editor workers, none of which the rail draws.
    loader: { '.md': 'text', '.ttf': 'dataurl' },
    plugins: [
      {
        name: 'worker-stub',
        setup(builder) {
          builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
            contents: 'export default class {};',
            loader: 'js',
          }));
        },
      },
    ],
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return openPage(t, bundle, '.rail-usage-pin-ring');
}

test('the pinned rail stack is as tall as the room budget, and each arc paints exactly its percentage', async (t) => {
  const page = await openRail(t, `[{ id: "openai-oauth", group: "oauth", windows: [{ label: "W", usedPct: 1 }] }]`);
  const stackHeight = () =>
    page.evaluate(() => document.querySelector('.sidebar-usage-toggle.is-pinned').getBoundingClientRect().height);
  // One provider: the block is 16 + 26 = 42px, no taller (no leftover minimum).
  assert.equal(await stackHeight(), usagePinStackHeight(1));

  await page.evaluate(() =>
    window.showUsage([
      { id: 'openai-oauth', group: 'oauth', windows: [{ label: 'W', usedPct: 1 }] },
      {
        id: 'anthropic-oauth',
        group: 'oauth',
        windows: [
          { label: '5H', usedPct: 99 },
          { label: 'W', usedPct: 100 },
        ],
      },
      { id: 'opencode-go-oauth', windows: [{ label: 'M', usedPct: 0 }] },
    ])
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-usage-pin]').length === 3);
  assert.equal(await stackHeight(), usagePinStackHeight(3));

  // Painted extent of every arc as a fraction of its circle, caps included,
  // from the computed stroke the stylesheet leaves on it.
  const arcs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-usage-window]')].map((ring) => {
      const arc = ring.querySelector('.rail-usage-pin-fill');
      const slot = ring.closest('[data-usage-pin]').getAttribute('data-usage-pin');
      const key = `${slot}:${ring.getAttribute('data-usage-window')}`;
      if (!arc) return { key, painted: 0 };
      const style = getComputedStyle(arc);
      const circumference = 2 * Math.PI * Number(arc.getAttribute('r'));
      if (style.strokeDasharray === 'none') return { key, painted: 1 };
      const [dash] = style.strokeDasharray.split(/[ ,]+/).map(Number.parseFloat);
      const capped = style.strokeLinecap === 'butt' ? 0 : Number.parseFloat(style.strokeWidth);
      const painted = Math.min(1, dash / Number(arc.getAttribute('pathLength')) + capped / circumference);
      return { key, painted };
    })
  );
  const near = (value, expected) => Math.abs(value - expected) < 1e-9;
  const painted = Object.fromEntries(arcs.map((arc) => [arc.key, arc.painted]));
  assert.deepEqual(Object.keys(painted), ['codex:W', 'claude:5H', 'claude:W', 'opencode-go-oauth:M']);
  // 1 and 99 leave both an arc and a gap; only 100 closes; 0 paints nothing.
  assert.ok(near(painted['codex:W'], 0.01), `1% painted ${painted['codex:W']}`);
  assert.ok(near(painted['claude:5H'], 0.99), `99% painted ${painted['claude:5H']}`);
  assert.ok(near(painted['claude:W'], 1), `100% painted ${painted['claude:W']}`);
  assert.equal(painted['opencode-go-oauth:M'], 0);
});

test('quota windows are two lines: label, reset and percent over a full-width 3px track', async (t) => {
  const page = await openUsagePopup(
    t,
    `[
      { id: "openai-oauth", group: "oauth", authenticated: true,
        windows: [quota("7D", 95, 149)] },
      { id: "anthropic-oauth", group: "oauth", authenticated: true,
        windows: [quota("5H", 0, null), quota("7D", 23, 108),
          quota("7D FABLE", 37, 108), quota("7D SONNET", 37, 108)] },
      { id: "cursor-oauth", group: "oauth", authenticated: true,
        windows: [quota("BASIC", 0, 709), quota("API", 100, 13)] },
      { id: "antigravity-oauth", group: "oauth", authenticated: true,
        windows: [quota("FLASH", 0, 4.5), quota("PRO", 0, 4.5)] },
    ]`
  );

  for (const width of [1363, 400]) {
    await page.setViewport({ width, height: 787 });
    const layout = await page.evaluate(async () => {
      await document.fonts.ready;
      const textRect = (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect();
      };
      const popup = document.querySelector('.rail-usage-popup');
      return {
        overflow: popup.scrollWidth - popup.clientWidth,
        rows: [...document.querySelectorAll('.sidebar-usage-meter')].map((row) => {
          const [label, reset, percent, track] = row.children;
          const meter = row.getBoundingClientRect();
          const bar = track.getBoundingClientRect();
          const fill = track.firstElementChild.getBoundingClientRect();
          const next = row.nextElementSibling?.getBoundingClientRect();
          const meters = row.parentElement.getBoundingClientRect();
          const header = row.closest('.sidebar-usage-row').querySelector('.sidebar-usage-line').getBoundingClientRect();
          return {
            label: label.textContent,
            first: row === row.parentElement.firstElementChild,
            meterLeft: meter.left,
            meterRight: meter.right,
            trackLeft: bar.left,
            trackWidth: bar.width,
            trackHeight: bar.height,
            trackGap: bar.top - label.getBoundingClientRect().bottom,
            fill: fill.width,
            percent: Number.parseFloat(percent.textContent),
            percentRight: textRect(percent).right,
            labelRight: label.getBoundingClientRect().right,
            resetLeft: reset.getBoundingClientRect().left,
            resetRight: reset.getBoundingClientRect().right,
            percentLeft: percent.getBoundingClientRect().left,
            windowGap: next ? next.top - meter.bottom : null,
            headerGap: meters.top - header.bottom,
            labelClipped: label.scrollWidth > label.clientWidth,
            resetClipped: reset.scrollWidth > reset.clientWidth,
          };
        }),
      };
    });
    assert.equal(layout.overflow, 0, `popup fits at viewport ${width}`);
    assert.deepEqual(
      layout.rows.map((row) => row.label),
      ['7D', '5H', '7D', '7D FABLE', '7D SONNET', 'BASIC', 'API', 'FLASH', 'PRO']
    );
    for (const row of layout.rows) {
      const context = `${row.label} at viewport ${width}`;
      assert.equal(row.trackLeft, row.meterLeft, `full-width track start: ${context}`);
      assert.equal(row.trackWidth, row.meterRight - row.meterLeft, `full-width track: ${context}`);
      assert.ok(Math.abs(row.trackHeight - 3) < 0.5, `3px track: ${context}`);
      assert.ok(Math.abs(row.trackGap - 5) <= 1, `5px between the two lines: ${context}`);
      assert.ok(
        Math.abs(row.fill - (row.trackWidth * row.percent) / 100) < 1,
        `usage percentage preserved: ${context}`
      );
      assert.ok(Math.abs(row.percentRight - row.meterRight) < 1, `percent ends the first line: ${context}`);
      assert.ok(
        row.resetLeft >= row.labelRight && row.resetRight <= row.percentLeft,
        `reset sits between label and percent: ${context}`
      );
      if (row.windowGap !== null) assert.ok(Math.abs(row.windowGap - 10) <= 1, `10px between windows: ${context}`);
      if (row.first) assert.ok(Math.abs(row.headerGap - 8) <= 1, `8px below the header: ${context}`);
      assert.equal(row.labelClipped, false, `full label: ${context}`);
      assert.equal(row.resetClipped, false, `full reset time: ${context}`);
    }
  }
});

test('reset credit details expand in the popup flow, so every ticket scrolls into view', async (t) => {
  const page = await openUsagePopup(
    t,
    // Codex alone, so its reset row is the popup's last line.
    `[
      { id: "openai-oauth", group: "oauth", authenticated: true,
        windows: [quota("5H", 40, 3), quota("7D", 95, 149)],
        resetCredits: { availableCount: 3, offerRevision: "o", availableCredits: [
          { id: "r1", expiresAt: Date.now() + 36 * hour },
          { id: "r2", expiresAt: Date.now() + 100 * hour },
          { id: "r3", expiresAt: Date.now() + 300 * hour },
        ] } },
    ]`
  );
  // A short window: the popup's max-height makes it scroll.
  await page.setViewport({ width: 1363, height: 260 });
  await page.click('.sidebar-usage-reset-info');
  const layout = await page.evaluate(async () => {
    await document.fonts.ready;
    const popup = document.querySelector('.rail-usage-popup');
    const reset = document.querySelector('.sidebar-usage-reset-credit');
    const details = document.querySelector('.sidebar-usage-reset-popover');
    popup.scrollTop = popup.scrollHeight;
    const view = popup.getBoundingClientRect();
    const usage = document.querySelector('.sidebar-usage').getBoundingClientRect();
    const box = details.getBoundingClientRect();
    return {
      resetIsLast: reset.closest('.sidebar-usage-row') === [...document.querySelectorAll('.sidebar-usage-row')].at(-1),
      position: getComputedStyle(details).position,
      insideUsage: box.top >= usage.top && box.bottom <= usage.bottom + 0.5,
      insideView: box.top >= view.top && box.bottom <= view.top + popup.clientHeight + 0.5,
      expiries: [...details.querySelectorAll('li small')].map((small) => [small.textContent, small.className]),
    };
  });
  assert.equal(layout.resetIsLast, true, 'the reset row ends the popup');
  assert.notEqual(layout.position, 'absolute', 'details are not an absolutely positioned overflow');
  assert.equal(layout.insideUsage, true, 'details sit inside the usage list, not past its clipped edge');
  assert.equal(layout.insideView, true, 'scrolled to the end, the popup shows the whole details list');
  assert.equal(layout.expiries.length, 3);
  assert.equal(new Set(layout.expiries.map(([text]) => text)).size, 3, 'each ticket shows its own expiry');
  for (const [text] of layout.expiries) assert.match(text, /^Expires in /);
  assert.deepEqual(
    layout.expiries.map(([, className]) => className),
    ['is-soon', 'is-soon', '']
  );
});
