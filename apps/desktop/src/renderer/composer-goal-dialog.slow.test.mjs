import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The DOM suite owns field values and saving. This browser check owns the
// actual field geometry and shared skin.
test('goal editor fields follow the dialog skin and stay in their pane', async (t) => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ComposerGoalDialog } from './ComposerGoalDialog';
        import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
        import './font-faces.css';
        import './ui/tokens.css';
        import './desktop.css';
        const host = document.getElementById('root');
        createRoot(host).render(React.createElement(ComposerGoalDialog, {
          anchor: { current: host }, disabled: false,
          initialGoal: {
            objective: '목표: Verify the approved work', timeLimitMs: 10_800_000,
          },
          onSave: async () => true, onClose() {}, returnFocus() {},
        }));
      `,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
    },
    outfile: 'goal-dialog.js',
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
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
  page.on('pageerror', (error) => errors.push(error.message));
  for (const { width, inset } of [
    { width: 1200, inset: 240 },
    { width: 360, inset: 0 },
  ]) {
    await page.setViewport({ width, height: 800 });
    await page.setContent(`<!doctype html><html><head></head><body>
      <main class="pane-cell" style="position:fixed;inset:0 0 0 ${inset}px">
        <div id="root"></div>
      </main>
    </body></html>`);
    await page.addStyleTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.css')).text });
    await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
    await page.waitForSelector('input[type="number"]', { visible: true });
    await page.$eval('[role="dialog"]', async (dialog) => {
      await Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished));
      await document.fonts.ready;
    });
    const fields = await page.$eval('[role="dialog"]', (dialog) => {
      const measure = (element) => {
        const { left, right, width, height } = element.getBoundingClientRect();
        return { left, right, width, height };
      };
      return {
        input: measure(dialog.querySelector('input[type="number"]')),
        objective: measure(dialog.querySelector('textarea')),
        modeChoice: dialog.querySelector('[role="combobox"]') !== null,
        typography: [
          dialog.querySelector('h2'),
          ...dialog.querySelectorAll('.schedules-field > span'),
          dialog.querySelector('textarea'),
          dialog.querySelector('input[type="number"]'),
          dialog.querySelector('small'),
        ].map((element) => {
          const style = getComputedStyle(element);
          return {
            family: style.fontFamily,
            size: style.fontSize,
            weight: style.fontWeight,
            line: style.lineHeight,
          };
        }),
        fontLoaded: document.fonts.check('14px "Pretendard Variable"', 'Goal 목표'),
      };
    });
    assert.equal(fields.fontLoaded, true, `${width}px: the existing UI font is loaded`);
    assert.deepEqual(
      fields.typography.map(({ size, weight }) => [size, weight]),
      [
        ['16px', '600'],
        ['15px', '600'],
        ['15px', '600'],
        ['14px', '400'],
        ['14px', '400'],
        ['13px', '400'],
      ],
      `${width}px: editor title, labels, values, and supporting text follow the shared hierarchy`
    );
    for (const typography of fields.typography) {
      assert.ok(typography.family.startsWith('"Pretendard Variable"'), `${width}px: one UI font family`);
    }
    assert.equal(fields.typography[3].line, '20px', `${width}px: multiline objective has readable leading`);
    assert.equal(fields.modeChoice, false, `${width}px: no time mode to choose`);
    assert.equal(fields.input.height, 32, `${width}px: standard dialog control height`);
    for (const property of ['left', 'width']) {
      assert.equal(fields.input[property], fields.objective[property], `${width}px: fields share ${property}`);
    }
    assert.ok(fields.input.left >= inset && fields.input.right <= width, `${width}px: field stays in its pane`);
  }
  assert.deepEqual(errors, []);
});
