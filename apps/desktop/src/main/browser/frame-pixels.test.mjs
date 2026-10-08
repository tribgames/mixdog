import assert from 'node:assert/strict';
import test from 'node:test';
import { browserFramePixels } from './frame-pixels.ts';

// Measured on Electron 41 (Windows, --force-device-scale-factor): paint
// images, shared textures and capturePage all matched these sizes exactly.
const owner = (bounds, content) => ({
  getBounds: () => ({ x: 0, y: 0, ...bounds }),
  getContentBounds: () => ({ x: 0, y: 0, ...content }),
});
const screen = (primary, matching = primary) => ({
  getPrimaryDisplay: () => ({ scaleFactor: primary }),
  getDisplayMatching: () => ({ scaleFactor: matching }),
});

test('offscreen pages composite at their outer bounds scaled by the primary display, rounded up', () => {
  for (const [scale, bounds, content, expected] of [
    [1, { width: 1280, height: 720 }, { width: 1280, height: 720 }, { width: 1280, height: 720 }],
    [1.25, { width: 1281, height: 721 }, { width: 1280, height: 720 }, { width: 1602, height: 902 }],
    [1.25, { width: 1004, height: 777 }, { width: 1004, height: 777 }, { width: 1255, height: 972 }],
    [1.5, { width: 640, height: 481 }, { width: 640, height: 480 }, { width: 960, height: 722 }],
    [1.75, { width: 1281, height: 722 }, { width: 1279, height: 721 }, { width: 2242, height: 1264 }],
    [2, { width: 1003, height: 777 }, { width: 1002, height: 777 }, { width: 2006, height: 1554 }],
  ]) {
    assert.deepEqual(browserFramePixels(owner(bounds, content), true, true, screen(scale, 1)), expected);
  }
});

test('software-composited offscreen pages round their pixel size down', () => {
  for (const [scale, bounds, expected] of [
    [1.25, { width: 1281, height: 721 }, { width: 1601, height: 901 }],
    [1.5, { width: 1280, height: 721 }, { width: 1920, height: 1081 }],
    [1.75, { width: 1281, height: 722 }, { width: 2241, height: 1263 }],
  ]) {
    const content = { width: bounds.width - 16, height: bounds.height - 39 };
    assert.deepEqual(browserFramePixels(owner(bounds, content), true, false, screen(scale)), expected);
  }
});

test('rounding follows the supplied rendering path, not any later acceleration report', () => {
  const bounds = { width: 1281, height: 721 };
  let accelerationReported = true;
  const startupSharedTexture = true;
  const pixels = () =>
    browserFramePixels(owner(bounds, bounds), true, startupSharedTexture, screen(1.25));
  const before = pixels();
  accelerationReported = false;
  assert.equal(accelerationReported, false);
  assert.deepEqual(pixels(), before);
  assert.deepEqual(before, { width: 1602, height: 902 });
});

test('native page windows composite their client area at their own display scale', () => {
  const matched = [];
  for (const [scale, bounds, content, expected] of [
    [1, { width: 1296, height: 785 }, { width: 1280, height: 720 }, { width: 1280, height: 720 }],
    [1.25, { width: 1292, height: 779 }, { width: 1280, height: 721 }, { width: 1600, height: 902 }],
    [1.75, { width: 1292, height: 770 }, { width: 1282, height: 722 }, { width: 2244, height: 1264 }],
  ]) {
    const display = {
      getPrimaryDisplay: () => ({ scaleFactor: 1 }),
      getDisplayMatching: (rect) => {
        matched.push(rect.width);
        return { scaleFactor: scale };
      },
    };
    for (const hardware of [true, false]) {
      assert.deepEqual(browserFramePixels(owner(bounds, content), false, hardware, display), expected);
    }
  }
  assert.deepEqual(matched, [1296, 1296, 1292, 1292, 1292, 1292], 'the display is matched by the window bounds');
});

test('scaling follows Chromium float32 arithmetic for scales that are not binary fractions', () => {
  // Electron reports the float32 device scale; 10 x 1.1f is 11.0000002 in
  // double but exactly 11 in float32.
  const scale = Math.fround(1.1);
  const box = { width: 10, height: 20 };
  assert.deepEqual(browserFramePixels(owner(box, box), true, true, screen(scale)), { width: 11, height: 22 });
});
