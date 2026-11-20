// #384: the custom-picture dialog in a real Chrome against the app's own
// stylesheets. A tall picture scrolls inside the dialog's body; the footer's
// "Use as skin" stays inside the card and the window, and the picture keeps
// its own proportions (the subject point is read from where it is clicked).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installTestDom } from '../test-support/test-dom.mjs';
import { appStyles } from '../test-support/app-styles.mjs';

const TALL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1600"><rect width="400" height="1600" fill="#6c8b5a"/></svg>'
)}`;

test('a tall picture scrolls inside the custom-skin dialog and the apply button stays visible', async (t) => {
  installTestDom(t, { actEnvironment: false });
  const { SkinCustomDialog } = await import('./skin-custom-dialog');
  const markup = renderToStaticMarkup(
    React.createElement(SkinCustomDialog, {
      prepared: {
        dataUrl: TALL,
        accent: '#336699',
        cast: { hue: 210, sat: 50 },
        picture: '#808080',
        swatches: ['#336699', '#6c8b5a'],
      },
      onClose() {},
      onApplied() {},
    })
  );
  const skinSheet = await readFile(new URL('./skin-panel.css', import.meta.url), 'utf8');
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 600 });
  await page.setContent(
    `<!doctype html><html><head><style>${await appStyles()}\n${skinSheet}</style></head><body>${markup}</body></html>`,
    { waitUntil: 'load' }
  );
  const box = (selector) =>
    page.$eval(selector, (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    });
  const dialog = await box('.skin-custom-dialog');
  const apply = await box('.skin-custom-dialog > footer button.primary');
  assert.ok(dialog.bottom <= 600 + 0.5, `the dialog fits the window (bottom ${dialog.bottom})`);
  assert.ok(apply.height > 0, 'the apply button has a box');
  assert.ok(
    apply.top >= dialog.top && apply.bottom <= dialog.bottom + 0.5,
    `"Use as skin" sits inside the card (${apply.top}-${apply.bottom} in ${dialog.top}-${dialog.bottom})`
  );
  const image = await box('.skin-focal > img');
  assert.ok(Math.abs(image.height / image.width - 4) < 0.01, 'the picture keeps its proportions');
  const scroll = await page.$eval('.skin-custom-body', (el) => ({ client: el.clientHeight, height: el.scrollHeight }));
  assert.ok(scroll.height > scroll.client, 'the body scrolls');
  // Scrolling the body brings the accent swatches into view inside it.
  const swatchInView = await page.$eval('.skin-custom-body', (body) => {
    body.scrollTop = body.scrollHeight;
    const b = body.getBoundingClientRect();
    const s = body.querySelector('.skin-swatch').getBoundingClientRect();
    return s.top >= b.top && s.bottom <= b.bottom;
  });
  assert.ok(swatchInView, 'the swatches are reached by scrolling the body');
});
