import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Cause of the phone composer "jump" on send: tapping the send disc moved focus
// from the textarea to the button, so the soft keyboard slid away (the WebView /
// visual viewport resized) in the same frame as the draft clearing, the field
// shrinking and the new row landing. Sending must leave the textarea focused
// (keyboard untouched); a closed keyboard stays closed; desktop keeps its focus.
const resolveDir = fileURLToPath(new URL('.', import.meta.url));
const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' };

const PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>';

test('send press keeps the composer field focused on a phone, and desktop focus is unchanged', async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir,
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { holdFieldFocusOnPress } from './surface-input-focus';
        function Harness() {
          const [draft, setDraft] = React.useState('hello');
          return (
            <form id="form" onSubmit={(event) => {
              event.preventDefault();
              window.__events.push('submit');
              setDraft('');
            }}>
              <textarea id="field" value={draft} onChange={(e) => setDraft(e.target.value)}
                onBlur={() => window.__events.push('blur')} />
              <button type="submit" className="send-button" onMouseDown={holdFieldFocusOnPress}>↑</button>
            </form>
          );
        }
        window.__events = [];
        createRoot(document.getElementById('root')).render(<Harness />);
      `,
    },
    bundle: true,
    format: 'iife',
    write: false,
    loader,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());

  const open = async ({ phone }) => {
    const page = await browser.newPage();
    if (phone) await page.setViewport({ width: 412, height: 900, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await page.setContent(PAGE);
    if (phone) await page.evaluate(() => document.documentElement.setAttribute('data-mixdog-mobile-tabs', ''));
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForSelector('.send-button');
    return page;
  };
  const press = async (page) => {
    const box = await (await page.$('.send-button')).boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
  };
  const state = (page) =>
    page.evaluate(() => ({
      active: document.activeElement?.id || document.activeElement?.tagName,
      events: window.__events,
      value: document.getElementById('field').value,
      bottom: document.getElementById('form').getBoundingClientRect().bottom,
    }));

  await t.test('phone: tapping send with the keyboard open leaves the field focused', async () => {
    const page = await open({ phone: true });
    await page.focus('#field');
    const before = await state(page);
    await press(page);
    const after = await state(page);
    assert.deepEqual(after.events, ['submit'], 'submitted once, the field never blurred');
    assert.equal(after.active, 'field', 'focus (and so the keyboard) stays in the field');
    assert.equal(after.value, '', 'the draft cleared');
    assert.equal(after.bottom, before.bottom, 'the composer did not move');
    await page.close();
  });

  await t.test('phone: tapping send with the keyboard closed focuses nothing', async () => {
    const page = await open({ phone: true });
    await press(page);
    const after = await state(page);
    assert.deepEqual(after.events, ['submit']);
    assert.notEqual(after.active, 'field', 'a closed keyboard is not reopened by sending');
    await page.close();
  });

  await t.test('desktop: a click on send keeps its native focus move', async () => {
    const page = await open({ phone: false });
    await page.focus('#field');
    await press(page);
    const after = await state(page);
    assert.deepEqual(after.events, ['blur', 'submit']);
    assert.equal(after.active, 'BUTTON');
    await page.close();
  });
});
