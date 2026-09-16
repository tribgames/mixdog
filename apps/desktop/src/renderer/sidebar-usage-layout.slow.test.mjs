import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

test("quota tracks align across providers, start after the longest label and reset text ends at the row edge", async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "tsx",
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
    outfile: "sidebar-usage-layout.js",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "css",
      contents: `
        @import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
        @import "./ui/tokens.css";
        @import "./desktop.css";
      `,
    },
    outfile: "sidebar-usage-layout.css",
    bundle: true,
    write: false,
    loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".svg": "dataurl" },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const renderError = new Promise((_, reject) => page.once("pageerror", reject));
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addStyleTag({ content: bundle.outputFiles.find((file) => file.path.endsWith(".css")).text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith(".js")).text });
  await Promise.race([page.waitForSelector(".sidebar-usage-meter > em"), renderError]);

  for (const width of [1363, 400]) {
    await page.setViewport({ width, height: 787 });
    const layout = await page.evaluate(async () => {
      await document.fonts.ready;
      const textRect = (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect();
      };
      const popup = document.querySelector(".rail-usage-popup");
      return {
        overflow: popup.scrollWidth - popup.clientWidth,
        rows: [...document.querySelectorAll(".sidebar-usage-meter")].map((row) => {
          const [label, track, percent, reset] = row.children;
          const provider = row.closest(".sidebar-usage-row").getBoundingClientRect();
          const bar = track.getBoundingClientRect();
          const fill = track.firstElementChild.getBoundingClientRect();
          return {
            label: label.textContent,
            labelText: textRect(label).width,
            rowLeft: provider.left,
            rowRight: provider.right,
            left: bar.left,
            width: bar.width,
            fill: fill.width,
            percent: Number.parseFloat(percent.textContent),
            resetRight: textRect(reset).right,
            labelClipped: label.scrollWidth > label.clientWidth,
            resetClipped: reset.scrollWidth > reset.clientWidth,
          };
        }),
      };
    });
    assert.equal(layout.overflow, 0, `popup fits at viewport ${width}`);
    assert.deepEqual(layout.rows.map((row) => row.label),
      ["7D", "5H", "7D", "7D FABLE", "7D SONNET", "BASIC", "API", "FLASH", "PRO"]);
    // The label column is only as wide as the longest label on screen, so the
    // track claims everything else (user: 앞쪽 글자 영역까지 최대한 확장).
    const widestLabel = Math.max(...layout.rows.map((row) => row.labelText));
    assert.ok(Math.abs(layout.rows[0].left - layout.rows[0].rowLeft - (widestLabel + 6)) <= 2,
      `track starts right after the longest label at viewport ${width}`);
    for (const row of layout.rows) {
      const context = `${row.label} at viewport ${width}`;
      assert.equal(row.left, layout.rows[0].left, `aligned track start: ${context}`);
      assert.equal(row.width, layout.rows[0].width, `equal track length: ${context}`);
      assert.ok(row.width >= 64, `usable track: ${context}`);
      assert.ok(Math.abs(row.fill - row.width * row.percent / 100) < 1,
        `usage percentage preserved: ${context}`);
      assert.ok(Math.abs(row.resetRight - row.rowRight) < 1,
        `reset time flush with the row edge: ${context}`);
      assert.equal(row.labelClipped, false, `full label: ${context}`);
      assert.equal(row.resetClipped, false, `full reset time: ${context}`);
    }
  }
});
