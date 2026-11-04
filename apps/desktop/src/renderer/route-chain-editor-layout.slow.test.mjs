import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import puppeteer from 'puppeteer-core';

// Stylesheets in the renderer's load order: desktop.css (route editor layer,
// then the shell overrides), then the chain editor's own chunk stylesheet.
const css = ['./desktop/23-route-editor.css', './desktop/shell-overrides.css', './route-chain-editor.css']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n');
const html = (phone) => `<!doctype html><html${phone ? ' data-mixdog-mobile-tabs' : ''}><head>
<style>${css}</style></head><body>
<ul class="route-chain-list" style="width:320px"><li class="route-chain-row">
<button class="route-chain-handle">::</button>
<div class="route-editor"><button class="model-trigger">GPT-6-Luna Auto</button></div>
</li></ul></body></html>`;

// The chain row's dropdown may use its `.route-editor` lane
// (route-editor-layout.ts dropdownAnchor), so on a phone too that lane must
// fill the row, or the open menu shrinks to the chip and cuts its values.
test("a route chain row's picker lane fills its row on desktop and phone", async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  for (const phone of [false, true]) {
    await page.setContent(html(phone));
    const m = await page.evaluate(() => {
      const row = document.querySelector('.route-chain-row').getBoundingClientRect();
      const lane = document.querySelector('.route-chain-row > .route-editor').getBoundingClientRect();
      const chip = document.querySelector('.model-trigger').getBoundingClientRect();
      return { laneRight: lane.right, rowRight: row.right, lane: lane.width, chip: chip.width };
    });
    const surface = phone ? 'phone' : 'desktop';
    assert.ok(m.lane > m.chip + 100, `${surface}: the lane is wider than the chip (${JSON.stringify(m)})`);
    assert.ok(Math.abs(m.laneRight - m.rowRight) < 1, `${surface}: the lane reaches the row's end`);
  }
});
