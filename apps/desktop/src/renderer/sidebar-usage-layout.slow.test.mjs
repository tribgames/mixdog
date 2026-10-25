import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

test('quota windows are two lines: label, reset and percent over a full-width 3px track', async (t) => {
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
        const dashboard = { rows: [
          { id: "openai-oauth", group: "oauth", authenticated: true,
            windows: [quota("7D", 95, 149)] },
          { id: "anthropic-oauth", group: "oauth", authenticated: true,
            windows: [quota("5H", 0, null), quota("7D", 23, 108),
              quota("7D FABLE", 37, 108), quota("7D SONNET", 37, 108)] },
          { id: "cursor-oauth", group: "oauth", authenticated: true,
            windows: [quota("BASIC", 0, 709), quota("API", 100, 13)] },
          { id: "antigravity-oauth", group: "oauth", authenticated: true,
            windows: [quota("FLASH", 0, 4.5), quota("PRO", 0, 4.5)] },
        ] };
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
  await Promise.race([page.waitForSelector('.sidebar-usage-meter > em'), renderError]);

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
