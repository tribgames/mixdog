import assert from 'node:assert/strict';
import test from 'node:test';

import { screenshotClipForElement } from './screenshot-clip.ts';

test('an element clip scales the CSS box onto the captured image', () => {
  const clip = screenshotClipForElement(
    { x: 100, y: 50, width: 200, height: 100 },
    { width: 1000, height: 800 },
    { width: 2000, height: 1600 }
  );
  assert.deepEqual(clip.rect, { x: 200, y: 100, width: 400, height: 200 });
  assert.equal(clip.partial, false);
});

test('an element wider than the viewport is clipped and reported as partial', () => {
  const clip = screenshotClipForElement(
    { x: 900, y: 700, width: 400, height: 300 },
    { width: 1000, height: 800 },
    { width: 1000, height: 800 }
  );
  assert.deepEqual(clip.rect, { x: 900, y: 700, width: 100, height: 100 });
  assert.equal(clip.partial, true);
});

test('an element scrolled out of the capture is refused instead of cropped elsewhere', () => {
  assert.throws(
    () =>
      screenshotClipForElement(
        { x: 1200, y: 10, width: 80, height: 40 },
        { width: 1000, height: 800 },
        { width: 1000, height: 800 }
      ),
    /outside the viewport/
  );
  assert.throws(
    () =>
      screenshotClipForElement(
        { x: 0, y: 0, width: 10, height: 10 },
        { width: 0, height: 800 },
        { width: 10, height: 10 }
      ),
    /measured viewport/
  );
});
