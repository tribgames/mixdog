import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The DOM suite owns mode selection and saving. This browser check owns the
// actual field geometry, shared skin, and menu visibility above the dialog.
test('goal time mode matches the dialog fields and opens above the modal layer', async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ComposerGoalDialog } from './ComposerGoalDialog';
        import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
        import './ui/tokens.css';
        import './desktop.css';
        const host = document.getElementById('root');
        createRoot(host).render(React.createElement(ComposerGoalDialog, {
          anchor: { current: host }, disabled: false,
          initialGoal: {
            objective: '목표: Verify the approved work', timeLimitMs: 10_800_000,
            timeMode: 'duration',
          },
          onSave: async () => true, onClose() {}, returnFocus() {},
        }));
      `,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
    },
    outfile: 'goal-dialog.js',
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const { width, inset } of [{ width: 1200, inset: 240 }, { width: 360, inset: 0 }]) {
    await page.setViewport({ width, height: 800 });
    await page.setContent(`<!doctype html><html><head></head><body>
      <main class="pane-cell" style="position:fixed;inset:0 0 0 ${inset}px">
        <div id="root"></div>
      </main>
    </body></html>`);
    await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text });
    await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
    await page.waitForSelector('[role="combobox"]', { visible: true });
    await page.$eval('[role="dialog"]', async dialog => {
      await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished));
      await document.fonts.ready;
    });
    const fields = await page.$eval('[role="dialog"]', dialog => {
      const measure = element => {
        const { left, right, width, height } = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left, right, width, height, color: style.color, background: style.backgroundColor,
          radius: style.borderRadius, fontSize: style.fontSize, shadow: style.boxShadow,
        };
      };
      return {
        input: measure(dialog.querySelector('input[type="number"]')),
        select: measure(dialog.querySelector('[role="combobox"]')),
        typography: [
          dialog.querySelector('h2'),
          ...dialog.querySelectorAll('.schedules-field > span'),
          dialog.querySelector('textarea'),
          dialog.querySelector('input[type="number"]'),
          dialog.querySelector('[role="combobox"]'),
          dialog.querySelector('small'),
        ].map(element => {
          const style = getComputedStyle(element);
          return {
            family: style.fontFamily, size: style.fontSize, weight: style.fontWeight,
            line: style.lineHeight,
          };
        }),
        fontLoaded: document.fonts.check('14px "Pretendard Variable"', 'Goal 목표'),
      };
    });
    assert.equal(fields.fontLoaded, true, `${width}px: the existing UI font is loaded`);
    assert.deepEqual(fields.typography.map(({ size, weight }) => [size, weight]), [
      ['16px', '600'],
      ['15px', '600'], ['15px', '600'], ['15px', '600'],
      ['14px', '400'], ['14px', '400'], ['14px', '400'],
      ['13px', '400'],
    ], `${width}px: editor title, labels, values, and supporting text follow the shared hierarchy`);
    for (const typography of fields.typography) {
      assert.ok(typography.family.startsWith('"Pretendard Variable"'), `${width}px: one UI font family`);
    }
    assert.equal(fields.typography[4].line, '20px', `${width}px: multiline objective has readable leading`);
    assert.equal(fields.select.height, 32, `${width}px: standard dialog control height`);
    for (const property of ['left', 'width', 'height', 'color', 'background', 'radius', 'fontSize', 'shadow']) {
      assert.equal(fields.select[property], fields.input[property], `${width}px: matching ${property}`);
    }
    assert.ok(fields.select.left >= inset && fields.select.right <= width, `${width}px: field stays in its pane`);
    await page.click('[role="combobox"]');
    await page.waitForSelector('[role="listbox"]', { visible: true });
    await page.$eval('[role="listbox"]', async listbox => {
      await Promise.all(listbox.getAnimations({ subtree: true }).map(animation => animation.finished));
    });
    const menu = await page.$eval('[role="listbox"]', listbox => {
      const { left, right, top, bottom } = listbox.getBoundingClientRect();
      return {
        left, right, top, bottom,
        items: [...listbox.querySelectorAll('[role="option"]')].map(option => {
          const rect = option.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return option === hit || option.contains(hit);
        }),
      };
    });
    assert.ok(menu.left >= inset && menu.right <= width && menu.top >= 0 && menu.bottom <= 800,
      `${width}px: menu stays within the visible pane`);
    assert.deepEqual(menu.items, [true, true], `${width}px: both choices are above the modal and hittable`);
  }
  assert.deepEqual(errors, []);
});
