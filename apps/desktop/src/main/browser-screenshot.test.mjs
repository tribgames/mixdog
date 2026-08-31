import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFullPageOutputBounds,
  browserScreenshotBytesFitBudget,
  normalizeScreenshotOptions,
} from './browser-screenshot-policy.ts';
import { frameImageFitsFileBudget } from './frame-files.ts';

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
