import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lockScreenGeometry,
  mapScreenPointer,
  screenFrameRegion,
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
  const locked = lockScreenGeometry(
    display({ scaleFactor: 1.5, physical: { x: 0, y: 0, width: 2880, height: 1620 } }),
    1
  );
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
  assert.deepEqual(
    summarizeScreenDisplay(display({ scaleFactor: 2, physical: { x: 0, y: 0, width: 3840, height: 2160 } })),
    {
      screenId: '1',
      label: 'Primary',
      primary: true,
      pixelWidth: 3840,
      pixelHeight: 2160,
      scaleFactor: 2,
    }
  );
});

test('screenFrameRegion locates the display in a helper frame without touching a pixel', () => {
  // The mapping is built directly (small test sizes below the stream minimum).
  const mapping = { generation: 1, pixelWidth: 4, pixelHeight: 2, physical: { x: 0, y: 0, width: 4, height: 2 } };
  // A frame exactly the display: all of it, at the same place.
  const exact = { width: 4, height: 2, stride: 16, originX: 0, originY: 0, pixels: new Uint8Array(16 * 2).fill(7) };
  const whole = screenFrameRegion(exact, mapping);
  assert.equal(whole.pixels.buffer, exact.pixels.buffer, 'a view, not a copy');
  assert.equal(whole.pixels.length, 32);
  assert.deepEqual(whole.source, { x: 0, y: 0, width: 4, height: 2 });
  assert.deepEqual(whole.target, { x: 0, y: 0, width: 4, height: 2 });

  // A virtual screen 8 × 4 starting at (-4, -2); this display is its
  // bottom-right quarter, streamed scaled down to half.
  const virtual = { width: 8, height: 4, stride: 40, originX: -4, originY: -2, pixels: new Uint8Array(40 * 4) };
  const quarter = { generation: 2, pixelWidth: 2, pixelHeight: 1, physical: { x: 0, y: 0, width: 4, height: 2 } };
  const region = screenFrameRegion(virtual, quarter);
  // Only the two rows that cover it are forwarded, from row 2.
  assert.equal(region.pixels.byteOffset, 2 * 40);
  assert.equal(region.pixels.length, 2 * 40);
  assert.deepEqual([region.width, region.height, region.stride], [8, 2, 40]);
  assert.deepEqual(region.source, { x: 4, y: 0, width: 4, height: 2 });
  assert.deepEqual(region.target, { x: 0, y: 0, width: 2, height: 1 });

  // A frame covering only the display's left half: the right half stays black.
  const half = { width: 2, height: 2, stride: 8, originX: 0, originY: 0, pixels: new Uint8Array(16) };
  assert.deepEqual(screenFrameRegion(half, mapping).target, { x: 0, y: 0, width: 2, height: 2 });
  // Not covering it at all, or malformed.
  assert.equal(screenFrameRegion({ ...half, originX: 10 }, mapping), null);
  assert.throws(() => screenFrameRegion({ ...exact, stride: 8 }, mapping), /malformed/);
  assert.throws(() => screenFrameRegion({ ...exact, pixels: new Uint8Array(8) }, mapping), /malformed/);
});
