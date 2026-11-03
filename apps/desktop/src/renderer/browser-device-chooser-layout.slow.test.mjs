import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import puppeteer from 'puppeteer-core';

// #314: the generic prompt-input rule stretched the chooser radios across the
// row and pushed the device name out of view.
const css = readFileSync(new URL('./desktop/browser-isolated-view.css', import.meta.url), 'utf8');
const HTML = `<!doctype html><html><head><style>${css}</style></head><body>
<div style="width:360px" class="browser-page-prompt"><div class="mx-dialog-body">
<p>Choose</p>
<fieldset class="browser-device-list"><legend>Device</legend>
<label><input type="radio" name="d" /><span>Keyboard</span></label>
<label><input type="radio" name="d" /><span>Mouse</span></label>
</fieldset>
<input type="text" id="plain" />
</div></div></body></html>`;

test('device chooser radios are 16px and names stay visible', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(HTML);
  const m = await page.evaluate(() => ({
    radios: [...document.querySelectorAll('.browser-device-list input')].map((r) => ({
      w: r.getBoundingClientRect().width,
      mt: getComputedStyle(r).marginTop,
    })),
    names: [...document.querySelectorAll('.browser-device-list span')].map((s) => {
      const b = s.getBoundingClientRect();
      const row = s.parentElement.getBoundingClientRect();
      return { w: b.width, inside: b.right <= row.right + 0.5 };
    }),
    plain: document.getElementById('plain').getBoundingClientRect().width,
    body: document.querySelector('.mx-dialog-body').getBoundingClientRect().width,
  }));
  for (const r of m.radios) {
    assert.equal(r.w, 16);
    assert.equal(r.mt, '0px');
  }
  for (const n of m.names) {
    assert.ok(n.w > 0 && n.inside, 'name visible inside its row');
  }
  assert.equal(m.plain, m.body, 'text input stays full width');
});
