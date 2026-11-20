import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import {
  browserScreenshotBytesFitBudget,
  FULL_PAGE_LAYOUT_PREPARE,
  FULL_PAGE_LAYOUT_RESTORE,
  bandCaptureArea,
  bandImageCrop,
  bandOutputRect,
  fullPageBandPlan,
  fullPageBandTimeoutMs,
  fullPageExceedsLimits,
  fullPageOutputSize,
  MAX_FULL_PAGE_BAND_PIXELS,
  normalizeScreenshotOptions,
} from './screenshot-policy.ts';
import { frameImageFitsFileBudget } from '../frame-files.ts';
import { scaledCaptureNote, screenshotWireImage, validatedScreenshot } from './screenshot-image.ts';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,' +
            encodeURIComponent(
              'export const nativeImage = { createFromBitmap: (bitmap, size) => globalThis.composedImage(bitmap, size) };'
            ),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { captureTiledDocument } = await import('./screenshot-tiles.ts');

test('validated Chromium screenshots preserve encoded bytes without a second lossy encode', () => {
  const bytes = Buffer.from([255, 216, 12, 34, 255, 217]);
  const jpeg = bytes.toString('base64');
  const options = normalizeScreenshotOptions({ format: 'jpeg' });
  const decode = () => ({ getSize: () => ({ width: 320, height: 240 }) });
  const capture = validatedScreenshot(jpeg, options, decode);
  assert.ok(capture);
  assert.deepEqual(capture.bytes, bytes);
  assert.equal(capture.width, 320);
  assert.equal(capture.height, 240);
  assert.equal(capture.fullPage, false);
  assert.deepEqual(screenshotWireImage(capture), { mimeType: 'image/jpeg', data: jpeg });
  assert.equal(validatedScreenshot(jpeg, normalizeScreenshotOptions({ format: 'png' }), decode), null);
  assert.equal(
    validatedScreenshot(jpeg, options, () => ({ getSize: () => ({ width: 0, height: 0 }) })),
    null
  );
  assert.equal(validatedScreenshot(Buffer.from('invalid').toString('base64'), options, decode), null);
});

test('browser screenshot options reject invalid format and PNG quality combinations', () => {
  assert.throws(() => normalizeScreenshotOptions({ format: 'webp' }), /jpeg or png/);
  assert.throws(() => normalizeScreenshotOptions({ format: 'png', quality: 80 }), /supported only with format=jpeg/);
});

test('a full page past the limits is delivered whole, scaled to fit them', () => {
  assert.deepEqual(fullPageOutputSize(1_280, 4_000), { width: 1_280, height: 4_000, scale: 1 });
  const tall = fullPageOutputSize(1_280, 200_000);
  assert.ok(tall.height <= 32_768 && tall.width * tall.height <= 24_000_000);
  assert.ok(Math.abs(tall.width / tall.height - 1_280 / 200_000) < 0.01, 'the aspect ratio is kept');
  assert.equal(tall.scale, tall.height / 200_000);
  const wide = fullPageOutputSize(10_000, 8_000);
  assert.ok(wide.width * wide.height <= 24_000_000);
  assert.ok(wide.scale < 1);
  assert.match(
    scaledCaptureNote({ scaledFrom: { width: 1_280, height: 200_000, scale: 0.1638 } }),
    /1280x200000 px.*scaled to 16\.38%/
  );
  assert.equal(scaledCaptureNote({}), '');
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
    '<!doctype html><header id="top" style="position: fixed !important; top: 0">Top</header>' +
      '<nav id="side" style="position: sticky">Side</nav><main id="body">Body</main>',
    { runScripts: 'outside-only' }
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

test('whether a page is past the limits is decided from its size at the capture pixel ratio', () => {
  assert.equal(fullPageExceedsLimits({ x: 0, y: 0, width: 1_280, height: 18_000 }, 1), false);
  assert.equal(fullPageExceedsLimits({ x: 0, y: 0, width: 5_000, height: 4_000 }, 2), true, 'page zoom counts');
  assert.equal(fullPageExceedsLimits({ x: 0, y: 0, width: 1_000, height: 40_000 }, 0.5), false, 'a zoomed-out page can fit');
  assert.equal(fullPageExceedsLimits({ x: 0, y: 0, width: 320, height: 400_000 }, 1), true);
  assert.equal(fullPageExceedsLimits({ x: 0, y: 0, width: 7_680, height: 20_000 }, 1), true);
});

/** Reads a page band by band the way the capture does: the viewport is
 *  scrolled (and clamped at the page's end), each band is captured from the
 *  viewport's DIP area, cropped and placed in the output. */
function simulateBands({ page, viewport, zoom, displayScale, pinch = 1 }) {
  const dipPerCss = zoom * pinch;
  const ratio = dipPerCss * displayScale;
  const plan = fullPageBandPlan(page, viewport, ratio);
  const native = { width: Math.round(page.width * ratio), height: Math.round(page.height * ratio) };
  const output = fullPageOutputSize(native.width, native.height);
  const columns = new Map();
  const rows = new Map();
  let bands = 0;
  for (let y = 0; y < page.height; y += plan.height) {
    for (let x = 0; x < page.width; x += plan.width) {
      bands++;
      const band = { x, y, width: Math.min(plan.width, page.width - x), height: Math.min(plan.height, page.height - y) };
      const left = Math.min(x, Math.max(0, page.width - viewport.width));
      const top = Math.min(y, Math.max(0, page.height - viewport.height));
      const offset = { x: x - left, y: y - top };
      assert.ok(offset.x + band.width <= viewport.width + 0.5 && offset.y + band.height <= viewport.height + 0.5);
      const area = bandCaptureArea(offset, band, dipPerCss);
      const image = { width: Math.ceil(area.width * displayScale), height: Math.ceil(area.height * displayScale) };
      assert.ok(image.width * image.height <= MAX_FULL_PAGE_BAND_PIXELS, `band image ${image.width}x${image.height}`);
      const crop = bandImageCrop(offset, band, dipPerCss, area, image);
      assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= image.width && crop.y + crop.height <= image.height);
      assert.ok(Math.abs(crop.width - band.width * ratio) <= 1 && Math.abs(crop.height - band.height * ratio) <= 1);
      const piece = bandOutputRect(band, page, output);
      columns.set(x, [piece.x, piece.width]);
      rows.set(y, [piece.y, piece.height]);
    }
  }
  // Every output column and row is written by exactly one band.
  for (const [spans, size] of [[[...columns.values()], output.width], [[...rows.values()], output.height]]) {
    let edge = 0;
    for (const [start, length] of spans) {
      assert.equal(start, edge);
      edge += length;
    }
    assert.equal(edge, size);
  }
  return { plan, output, bands };
}

test('a page past the limits is read in bands of its own viewport and composed into one scaled image', () => {
  const tall = simulateBands({ page: { width: 320, height: 400_000 }, viewport: { width: 320, height: 800 }, zoom: 1, displayScale: 1 });
  assert.deepEqual([tall.plan.width, tall.plan.height, tall.bands], [320, 800, 500], 'the viewport is never enlarged');
  assert.ok(tall.output.height <= 32_768 && tall.output.width * tall.output.height <= 24_000_000);

  const wide = simulateBands({ page: { width: 7_680, height: 20_000 }, viewport: { width: 1_265, height: 800 }, zoom: 1, displayScale: 1 });
  assert.equal(wide.bands, 7 * 25);
  assert.ok(wide.output.width * wide.output.height <= 24_000_000 && wide.output.scale < 1);

  // Page zoom other than 1, a high-DPI display, and a phone layout shown pinched out.
  simulateBands({ page: { width: 1_707, height: 60_000 }, viewport: { width: 1_692, height: 1_067 }, zoom: 0.75, displayScale: 1.25 });
  simulateBands({ page: { width: 1_164, height: 90_000 }, viewport: { width: 1_149, height: 727 }, zoom: 1.1, displayScale: 1.5 });
  simulateBands({ page: { width: 980, height: 120_000 }, viewport: { width: 980, height: 1_865 }, zoom: 1, displayScale: 1, pinch: 0.419 });
  // A viewport too large for one band is read in smaller pieces of it.
  const dense = simulateBands({ page: { width: 3_840, height: 40_000 }, viewport: { width: 3_825, height: 2_160 }, zoom: 1, displayScale: 2 });
  assert.ok(dense.plan.width === 3_825 && dense.plan.height < 2_160);
});

test('a banded capture is given time per band, inside what the command leaves it', () => {
  assert.equal(fullPageBandTimeoutMs(4, 8_000, 36_000), 9_000);
  assert.equal(fullPageBandTimeoutMs(500, 8_000, 36_000), 36_000);
});

/** A page the capture reads through CDP and capturePage, as a fake: the
 *  viewport scrolls (clamped at the page's end) and every capture returns the
 *  DIP area asked for at the display's scale, its pixels marked as painted. */
function bandedPage({ page, visible, zoom = 1, displayScale = 1, scroll = { x: 0, y: 0 }, onRead, restoreFails } = {}) {
  const calls = [];
  const state = { scroll: { ...scroll }, visible: { ...visible }, reads: 0, captures: [] };
  const fakeImage = (width, height) => ({
    getSize: () => ({ width, height }),
    crop: (rect) => fakeImage(rect.width, rect.height),
    resize: (size) => fakeImage(size.width, size.height),
    toBitmap: () => Buffer.alloc(width * height * 4, 0xff),
  });
  const guest = {
    invalidate() {},
    getZoomFactor: () => zoom,
    capturePage: async (area) => {
      state.captures.push(area);
      return fakeImage(Math.ceil(area.width * displayScale), Math.ceil(area.height * displayScale));
    },
  };
  const cdp = {
    call: async (_guest, method, params) => {
      calls.push(method);
      if (method === 'Runtime.evaluate') return { result: { objectId: 'window' } };
      if (method === 'Runtime.releaseObject') return {};
      assert.equal(method, 'Runtime.callFunctionOn', 'nothing but scrolling and reading touches the page');
      const position = params.arguments[0].value;
      if (position) {
        state.reads++;
        onRead?.(state);
        if (restoreFails && position.x === scroll.x && position.y === scroll.y && state.reads > 1) {
          throw new Error('page went away');
        }
        state.scroll = {
          x: Math.min(position.x, Math.max(0, page.width - state.visible.width)),
          y: Math.min(position.y, Math.max(0, page.height - state.visible.height)),
        };
      }
      const { width, height } = state.visible;
      return {
        result: {
          value: {
            ...state.scroll,
            width,
            height,
            clientWidth: width,
            clientHeight: height,
            left: state.scroll.x,
            top: state.scroll.y,
            visibleWidth: width,
            visibleHeight: height,
            scale: 1,
            dpr: zoom * displayScale,
          },
        },
      };
    },
  };
  return { guest, cdp, calls, state };
}

globalThis.composedImage = (bitmap, size) => {
  assert.equal(bitmap.length, size.width * size.height * 4);
  assert.equal(bitmap.indexOf(0), -1, 'every pixel of the image comes from a band');
  return {
    getSize: () => size,
    toJPEG: () => Buffer.from([255, 216, 255, 217]),
    toPNG: () => Buffer.from([137, 80, 78, 71]),
  };
};

const jpeg = normalizeScreenshotOptions({ format: 'jpeg', fullPage: true });

test('a page past the limits is captured whole in its own viewport, scaled, and scrolled back', async () => {
  for (const [page, visible, zoom, displayScale] of [
    [{ width: 320, height: 400_000 }, { width: 320, height: 800 }, 1, 1],
    [{ width: 1_707, height: 40_000 }, { width: 1_692, height: 1_067 }, 0.75, 1.25],
  ]) {
    const f = bandedPage({ page, visible, zoom, displayScale, scroll: { x: 0, y: 1_234 } });
    const shot = await captureTiledDocument(f.cdp, f.guest, { x: 0, y: 0, ...page }, jpeg, 8_000, 2_000);
    assert.ok(shot.width * shot.height <= 24_000_000 && shot.height <= 32_768);
    assert.ok(shot.scaledFrom.scale < 1);
    const nativeHeight = page.height * zoom * displayScale;
    assert.ok(Math.abs(shot.scaledFrom.height - nativeHeight) <= nativeHeight * 0.001, `${shot.scaledFrom.height}`);
    for (const area of f.state.captures) {
      assert.ok(area.width * displayScale * area.height * displayScale <= 4_000_000, 'one band stays small');
    }
    assert.deepEqual(f.state.scroll, { x: 0, y: 1_234 }, 'the page is scrolled back');
    assert.ok(f.calls.every((method) => method.startsWith('Runtime.')), 'no viewport or device override');
  }
});

test('a viewport that changes during a banded capture fails it and the page is still scrolled back', async () => {
  const f = bandedPage({
    page: { width: 411, height: 200_000 },
    visible: { width: 411, height: 782 },
    scroll: { x: 0, y: 500 },
    // The phone drops its fit halfway: the page is laid out at the pane's size again.
    onRead: (state) => {
      if (state.reads === 100) state.visible = { width: 1_265, height: 800 };
    },
  });
  await assert.rejects(
    captureTiledDocument(f.cdp, f.guest, { x: 0, y: 0, width: 411, height: 200_000 }, jpeg, 8_000, 2_000),
    /viewport changed during the full-page capture/
  );
  assert.deepEqual(f.state.scroll, { x: 0, y: 500 });
});

test('a banded capture that cannot scroll the page back reports it', async () => {
  const f = bandedPage({ page: { width: 320, height: 100_000 }, visible: { width: 320, height: 800 }, restoreFails: true });
  await assert.rejects(
    captureTiledDocument(f.cdp, f.guest, { x: 0, y: 0, width: 320, height: 100_000 }, jpeg, 8_000, 2_000),
    (error) => error.name === 'BrowserScreenshotRestoreError' && /scroll restoration failed; page went away/.test(error.message)
  );
});

test('a cancelled banded capture stops reading and scrolls the page back', async () => {
  const controller = new AbortController();
  const f = bandedPage({
    page: { width: 320, height: 400_000 },
    visible: { width: 320, height: 800 },
    scroll: { x: 0, y: 77 },
    onRead: (state) => {
      if (state.reads === 10) controller.abort(new Error('stopped'));
    },
  });
  await assert.rejects(
    captureTiledDocument(f.cdp, f.guest, { x: 0, y: 0, width: 320, height: 400_000 }, jpeg, 8_000, 2_000, controller.signal),
    /stopped/
  );
  assert.deepEqual(f.state.scroll, { x: 0, y: 77 });
  assert.ok(f.state.captures.length <= 11);
});
