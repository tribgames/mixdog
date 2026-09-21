import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import puppeteer from 'puppeteer-core';

test('composer palette and provider buttons retain their final cascade in every interaction state', async (t) => {
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      :root {
        --mx-popup-border: 1px solid rgb(11, 12, 13);
        --mx-popup-radius: 9px;
        --mx-popup-bg: rgb(31, 32, 33);
        --mx-popup-shadow: 0 1px 2px rgb(41, 42, 43);
        --mx-text: rgb(21, 22, 23);
        --mx-icon: rgb(51, 52, 53);
        --mx-hover: rgb(61, 62, 63);
        --mx-bg-layer-1: rgb(71, 72, 73);
        --mx-border-muted: rgb(81, 82, 83);
        --mx-border: rgb(91, 92, 93);
      }
    </style>
    <div class="slash-palette">Commands</div>
    <button class="model-provider-add">Add</button>
  `);
  await page.addStyleTag({
    content: await readFile(new URL('./desktop/15-composer.css', import.meta.url), 'utf8'),
  });
  const computed = (selector, properties) =>
    page.$eval(
      selector,
      (node, keys) => {
        const style = getComputedStyle(node);
        return Object.fromEntries(keys.map((key) => [key, style[key]]));
      },
      properties
    );
  assert.deepEqual(
    await computed('.slash-palette', ['padding', 'border', 'borderRadius', 'color', 'backgroundColor', 'boxShadow']),
    {
      padding: '4px',
      border: '1px solid rgb(11, 12, 13)',
      borderRadius: '9px',
      color: 'rgb(21, 22, 23)',
      backgroundColor: 'rgb(31, 32, 33)',
      boxShadow: 'rgb(41, 42, 43) 0px 1px 2px 0px',
    }
  );
  const buttonStyle = () => computed('.model-provider-add', ['backgroundColor', 'boxShadow']);
  assert.deepEqual(await buttonStyle(), { backgroundColor: 'rgba(0, 0, 0, 0)', boxShadow: 'none' });
  await page.hover('.model-provider-add');
  assert.deepEqual(await buttonStyle(), { backgroundColor: 'rgb(61, 62, 63)', boxShadow: 'none' });
  await page.mouse.move(700, 500);
  await page.keyboard.press('Tab');
  assert.equal(await page.$eval('.model-provider-add', (node) => node.matches(':focus-visible')), true);
  assert.deepEqual(await buttonStyle(), { backgroundColor: 'rgb(61, 62, 63)', boxShadow: 'none' });
});
