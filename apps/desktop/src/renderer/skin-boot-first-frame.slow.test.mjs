import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// Real boot.js, real skin CSS, fake data: a reload with a recorded skin paints
// its very first frame already skinned. The bundle never mounts here (#root
// stays empty), which is exactly the window in which the picture used to show
// bare, at full strength, before any plate existed.
const BOOT = readFileSync(new URL('./public/boot.js', import.meta.url), 'utf8');
const RED = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ff0000"/></svg>')}`;
const VARS = {
  '--mx-skin-pos': 'center',
  '--mx-skin-tint': '#ffffff',
  '--mx-skin-frame-amount': '40%',
  '--mx-skin-veil-amount': '22%',
  '--mx-skin-panel-amount': '40%',
  '--mx-skin-card-amount': '70%',
};
const SNAPSHOT = {
  v: 1,
  sig: '',
  inputs: '',
  themeId: 'basic',
  skin: {
    attributes: { 'data-mixdog-skin': 'spring-window', 'data-mixdog-skin-plate': 'light' },
    vars: VARS,
    image: { custom: 'mixdog.desktop.skin-custom-image.v1' },
  },
  userTheme: null,
};

test('the first screenshot after a reload is already skinned: the picture is never bare', async (t) => {
  const css = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents: '@import "./desktop/33-skin.css";',
    },
    outfile: 'skin.css',
    bundle: true,
    write: false,
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><script>${BOOT.replace(/<\/script/gi, '<\\/script')}</script><style>${css.outputFiles[0].text}</style></head><body style="margin:0"><div id="root"></div></body></html>`;
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 240 });
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.url() === 'https://mixdog.test/'
      ? request.respond({ status: 200, contentType: 'text/html', body: html })
      : request.respond({ status: 404, body: '' })
  );
  const center = async () => {
    const png = await page.screenshot({ clip: { x: 150, y: 110, width: 1, height: 1 }, encoding: 'base64' });
    return Buffer.from(png, 'base64');
  };
  const pixel = async () => {
    const dataUrl = await page.evaluate(
      async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return [...context.getImageData(0, 0, 1, 1).data];
      },
      (await center()).toString('base64')
    );
    return dataUrl;
  };
  await page.goto('https://mixdog.test/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    (snapshot, picture) => {
      // boot.js resolves the appearance inputs itself (the browser's colour scheme included).
      localStorage.setItem(
        'mixdog.desktop.skin-boot.v1',
        JSON.stringify({ ...snapshot, inputs: window.mixdogThemeInputs() })
      );
      localStorage.setItem('mixdog.desktop.skin-custom-image.v1', picture);
    },
    SNAPSHOT,
    RED
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  const skinned = await page.evaluate(() => document.documentElement.dataset.mixdogSkin);
  assert.equal(skinned, 'spring-window', 'boot.js painted the skin before anything else ran');
  const [r, g, b] = await pixel();
  // Red picture under a white wash (frame 40% + veil 22%): clearly lifted, not the bare picture.
  assert.ok(r > 200 && g > 90 && b > 90, `first frame is picture under its plates, got ${r},${g},${b}`);

  // Sensitivity: the same page without the boot wash shows the picture bare.
  await page.evaluate(() => document.getElementById('mixdog-boot-skin').remove());
  const [bareR, bareG] = await pixel();
  assert.ok(bareR > 240 && bareG < 20, `without the wash the picture is bare, got ${bareR},${bareG}`);
});
