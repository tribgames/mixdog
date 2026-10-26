import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fitScreenFrame,
  lockScreenGeometry,
  mapScreenPointer,
  screenGeometryChanged,
  screenVideoSize,
  summarizeScreenDisplay,
} from './screen-geometry.ts';

const display = (over = {}) => ({
  screenId: '1',
  label: 'Primary',
  primary: true,
  scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
  ...over,
});

test('video size keeps native pixels, scales oversize displays and stays even', () => {
  assert.deepEqual(screenVideoSize({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  assert.deepEqual(screenVideoSize({ width: 1921, height: 1081 }), { width: 1920, height: 1080 });
  // 5120 wide exceeds the 4096 bound: scaled uniformly, both even.
  const big = screenVideoSize({ width: 5120, height: 2160 });
  assert.equal(big.width, 4096);
  assert.equal(big.width % 2, 0);
  assert.equal(big.height % 2, 0);
  assert.ok(Math.abs(big.height - 2160 * (4096 / 5120)) <= 2);
  assert.throws(() => screenVideoSize({ width: 32, height: 1080 }));
});

test('locked geometry carries css bounds, scale and even pixels', () => {
  const locked = lockScreenGeometry(display({ scaleFactor: 1.5, physical: { x: 0, y: 0, width: 2880, height: 1620 } }), 1);
  assert.equal(locked.geometry.generation, 1);
  assert.equal(locked.geometry.cssWidth, 1920);
  assert.equal(locked.geometry.deviceScaleFactor, 1.5);
  assert.equal(locked.geometry.pixelWidth, 2880);
  assert.equal(locked.geometry.pixelHeight, 1620);
  assert.equal(locked.mapping.physical.width, 2880);
});

test('pointer mapping uses physical pixels on a DPI-scaled display', () => {
  // 150% display: 1920x1080 DIP → 2880x1620 physical, video locked to physical.
  const { mapping } = lockScreenGeometry(
    display({ scaleFactor: 1.5, physical: { x: 0, y: 0, width: 2880, height: 1620 } }),
    1
  );
  assert.deepEqual(mapScreenPointer(mapping, 0, 0), { x: 0, y: 0 });
  // Video centre lands on the physical centre pixel.
  assert.deepEqual(mapScreenPointer(mapping, 1440, 810), { x: 1440, y: 810 });
  // Far edge clamps to the last physical pixel, never one past it.
  assert.deepEqual(mapScreenPointer(mapping, 2880, 1620), { x: 2879, y: 1619 });
  assert.equal(mapScreenPointer(mapping, -1, 0), null);
  assert.equal(mapScreenPointer(mapping, 0, 2000), null);
});

test('pointer mapping offsets a secondary monitor left of the primary', () => {
  // A monitor at x = -1920 (to the left): video x 0 → desktop x -1920.
  const { mapping } = lockScreenGeometry(
    display({ screenId: '2', primary: false, physical: { x: -1920, y: 0, width: 1920, height: 1080 } }),
    4
  );
  assert.deepEqual(mapScreenPointer(mapping, 0, 0), { x: -1920, y: 0 });
  assert.deepEqual(mapScreenPointer(mapping, 960, 540), { x: -960, y: 540 });
});

test('geometry change is detected by physical rect only', () => {
  const { mapping } = lockScreenGeometry(display(), 1);
  assert.equal(screenGeometryChanged(mapping, display()), false);
  assert.equal(screenGeometryChanged(mapping, display({ physical: { x: 0, y: 0, width: 2560, height: 1440 } })), true);
  assert.equal(screenGeometryChanged(mapping, display({ physical: { x: 10, y: 0, width: 1920, height: 1080 } })), true);
});

test('summary reports physical pixels a phone chooses from', () => {
  assert.deepEqual(summarizeScreenDisplay(display({ scaleFactor: 2, physical: { x: 0, y: 0, width: 3840, height: 2160 } })), {
    screenId: '1',
    label: 'Primary',
    primary: true,
    pixelWidth: 3840,
    pixelHeight: 2160,
    scaleFactor: 2,
  });
});

test('fitScreenFrame passes a matching frame through and crops a virtual-desktop frame', () => {
  // The mapping is built directly (small test sizes below the stream minimum).
  const mapping = { generation: 1, pixelWidth: 4, pixelHeight: 2, physical: { x: 0, y: 0, width: 4, height: 2 } };
  // A frame exactly the display: returned without copying the whole thing.
  const exact = { width: 4, height: 2, stride: 16, originX: 0, originY: 0, pixels: new Uint8Array(16 * 2).fill(7) };
  const passed = fitScreenFrame(exact, mapping);
  assert.equal(passed.width, 4);
  assert.equal(passed.height, 2);
  assert.equal(passed.pixels.length, 16 * 2);

  // A virtual-screen frame (two monitors side by side); this display is the
  // right half. Each pixel's blue channel is its column so we can check the crop.
  const virtualWidth = 8;
  const pixels = new Uint8Array(virtualWidth * 2 * 4);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < virtualWidth; x += 1) {
      pixels[(y * virtualWidth + x) * 4] = x;
    }
  }
  const rightHalf = { generation: 2, pixelWidth: 4, pixelHeight: 2, physical: { x: 4, y: 0, width: 4, height: 2 } };
  const frame = { width: virtualWidth, height: 2, stride: virtualWidth * 4, originX: 0, originY: 0, pixels };
  const cropped = fitScreenFrame(frame, rightHalf);
  assert.equal(cropped.width, 4);
  // The crop starts at desktop x = 4: first output pixel's blue channel is 4.
  assert.equal(cropped.pixels[0], 4);
  assert.equal(cropped.pixels[(cropped.width - 1) * 4], 7);
});
