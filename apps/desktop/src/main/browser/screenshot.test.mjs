import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import {
  assertFullPageOutputBounds,
  browserScreenshotBytesFitBudget,
  FULL_PAGE_LAYOUT_PREPARE,
  FULL_PAGE_LAYOUT_RESTORE,
  normalizeScreenshotOptions,
} from './screenshot-policy.ts';
import { frameImageFitsFileBudget } from '../frame-files.ts';
import { validatedScreenshot } from './screenshot-image.ts';

test('validated Chromium screenshots preserve encoded bytes without a second lossy encode', () => {
  const jpeg = Buffer.from([255, 216, 12, 34, 255, 217]).toString('base64');
  const options = normalizeScreenshotOptions({ format: 'jpeg' });
  const decode = () => ({ getSize: () => ({ width: 320, height: 240 }) });
  assert.deepEqual(validatedScreenshot(jpeg, options, decode), {
    data: jpeg, width: 320, height: 240, mimeType: 'image/jpeg', fullPage: false,
  });
  assert.equal(validatedScreenshot(jpeg, normalizeScreenshotOptions({ format: 'png' }), decode), null);
  assert.equal(validatedScreenshot(jpeg, options, () => ({ getSize: () => ({ width: 0, height: 0 }) })), null);
  assert.equal(validatedScreenshot(Buffer.from('invalid').toString('base64'), options, decode), null);
});

test('browser screenshot options reject invalid format and PNG quality combinations', () => {
  assert.throws(() => normalizeScreenshotOptions({ format: 'webp' }), /jpeg or png/);
  assert.throws(
    () => normalizeScreenshotOptions({ format: 'png', quality: 80 }),
    /supported only with format=jpeg/,
  );
});

test('full-page screenshots apply the pixel ceiling after page zoom', async () => {
  assert.throws(
    () => assertFullPageOutputBounds(
      { x: 0, y: 0, width: 5_000, height: 4_000 },
      2,
    ),
    /full-page screenshot is too large \(10000x8000\)/,
  );
});

test('persisted Browser Use frames reject empty data without writing a file', () => {
  assert.equal(frameImageFitsFileBudget(''), false);
  assert.equal(frameImageFitsFileBudget(Buffer.from('frame').toString('base64')), true);
});

test('Browser Use screenshot encoding has a bounded payload budget', () => {
  assert.equal(browserScreenshotBytesFitBudget(1), true);
  assert.equal(browserScreenshotBytesFitBudget(100 * 1024 * 1024), true);
  assert.equal(browserScreenshotBytesFitBudget(100 * 1024 * 1024 + 1), false);
});

test('full-page capture anchors fixed and sticky elements in flow and restores their inline style', () => {
  const dom = new JSDOM(
    '<!doctype html><header id="top" style="position: fixed !important; top: 0">Top</header>'
    + '<nav id="side" style="position: sticky">Side</nav><main id="body">Body</main>',
    { runScripts: 'outside-only' },
  );
  try {
    const { window } = dom;
    const top = window.document.querySelector('#top');
    const side = window.document.querySelector('#side');
    const body = window.document.querySelector('#body');
    assert.equal(window.eval(FULL_PAGE_LAYOUT_PREPARE), 2);
    assert.equal(top.style.getPropertyValue('position'), 'absolute');
    assert.equal(side.style.getPropertyValue('position'), 'relative');
    assert.equal(body.style.getPropertyValue('position'), '');
    assert.equal(window.eval(FULL_PAGE_LAYOUT_PREPARE), 0, 'a second prepare never stacks');
    assert.equal(window.eval(FULL_PAGE_LAYOUT_RESTORE), 2);
    assert.equal(top.style.getPropertyValue('position'), 'fixed');
    assert.equal(side.style.getPropertyValue('position'), 'sticky');
    assert.equal(window.__mixdogFullPageLayout, undefined);
    assert.equal(window.eval(FULL_PAGE_LAYOUT_RESTORE), 0);
  } finally {
    dom.window.close();
  }
});
