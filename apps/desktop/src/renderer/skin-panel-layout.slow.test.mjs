import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The shared settings row caps its control column at 220px, narrower than the
// Korean segmented labels, which then overflowed leftwards over the description
// (issue #287). Real renderer CSS, real SkinPanel, headless Chrome.
test('panel color segmented group never overlaps its description and drops below it when narrow', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const loader = {
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
    '.svg': 'dataurl',
    '.png': 'dataurl',
    '.jpg': 'dataurl',
    '.webp': 'dataurl',
    '.webm': 'empty',
  };
  const [bundle, styles] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import "./process-shim";
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { SkinPanel } from "./settings/skin-panel";
          createRoot(document.getElementById("root")).render(<SkinPanel />);
        `,
      },
      bundle: true,
      write: false,
      outfile: 'skin-panel-layout.js',
      format: 'iife',
      jsx: 'automatic',
      loader,
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"http://mixdog.test/assets/index.js"' },
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./desktop.css";',
      },
      outfile: 'skin-panel-layout.css',
      bundle: true,
      write: false,
      loader,
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
  // localStorage (the skin store) needs a real origin, not about:blank.
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.respond({
      contentType: 'text/html',
      body: '<!doctype html><html lang="ko"><head></head><body><div class="mixdog-settings-v2"><div id="root"></div></div></body></html>',
    })
  );
  await page.goto('http://mixdog.test/');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css'))) {
    await page.addStyleTag({ content: file.text });
  }
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.waitForSelector('.skin-card[data-skin="glass-flow"]');
  await page.click('.skin-card[data-skin="glass-flow"]');
  await page.waitForSelector('.skin-seg[aria-label="Panel color"]');
  // The reported Korean copy; the panel renders English in a test locale.
  await page.evaluate(() => {
    const seg = document.querySelector('.skin-seg[aria-label="Panel color"]');
    ['밝은 유리', '어두운 유리', '그림 색'].forEach((label, i) => {
      seg.children[i].textContent = label;
    });
    seg.closest('.skin-row').querySelector('.skin-row-desc').textContent =
      '사이드바와 메시지 패널의 색상입니다. 밝은 유리 효과는 밝은 이미지에 잘 어울립니다.';
    document.body.style.fontFamily = '"Malgun Gothic", "Noto Sans CJK KR", sans-serif';
  });

  const measure = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      const row = document.querySelector('.skin-seg[aria-label="Panel color"]').closest('.skin-row');
      const seg = row.querySelector('.skin-seg').getBoundingClientRect();
      const descNode = row.querySelector('.skin-row-desc');
      const range = document.createRange();
      range.selectNodeContents(descNode);
      const text = [...range.getClientRects()].map((r) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      }));
      const box = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      return {
        seg: box(seg),
        text,
        row: box(row.getBoundingClientRect()),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
  const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  // Settings content column of a ~1210px-wide window, then a phone.
  await page.setViewport({ width: 1210, height: 800 });
  await page.addStyleTag({ content: '#root { width: 680px; }' });
  const wide = await measure();
  assert.ok(wide.seg.right - wide.seg.left > 220, 'Korean labels are wider than the shared control column');
  for (const line of wide.text)
    assert.ok(
      !intersects(wide.seg, line),
      `desktop overlap seg=${JSON.stringify(wide.seg)} text=${JSON.stringify(line)}`
    );
  assert.ok(
    wide.seg.right <= wide.row.right + 1 && wide.seg.left >= wide.row.left,
    'desktop group stays inside the row'
  );

  await page.addStyleTag({ content: '#root { width: 300px; }' });
  const narrow = await measure();
  const textBottom = Math.max(...narrow.text.map((r) => r.bottom));
  assert.ok(
    narrow.seg.top >= textBottom - 1,
    `narrow group sits below the description: seg=${JSON.stringify(narrow.seg)} textBottom=${textBottom}`
  );
  assert.ok(Math.abs(narrow.seg.left - narrow.row.left) <= 1, 'narrow group is left-aligned');
  assert.ok(narrow.seg.right <= narrow.row.right + 1, 'narrow group does not overflow the row');
  assert.ok(narrow.overflowX <= 0, 'no horizontal overflow');
  assert.deepEqual(errors, [], 'no renderer errors');
});
