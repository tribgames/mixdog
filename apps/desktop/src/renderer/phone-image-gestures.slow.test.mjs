import assert from 'node:assert/strict';
import test from 'node:test';
import { openPhone as openPhoneSheet, wait } from './test-support/phone-sheet-browser.mjs';

const openPhone = (t) => openPhoneSheet(t, HARNESS, 'phone-image-gestures');
const IMAGE = { width: 1080, height: 2400 };
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE.width}" height="${IMAGE.height}"><rect width="100%" height="100%" fill="#3a6"/><rect y="${IMAGE.height - 100}" width="100%" height="100" fill="#d33"/></svg>`;
const HARNESS = `
  import { createRoot } from 'react-dom/client';
  import { VisualizePane } from './VisualizePane';
  import { ImageLightbox } from './image-lightbox';
  import { applyVisualizeEvent } from './visualize-store';
  const url = 'data:image/svg+xml,' + encodeURIComponent(${JSON.stringify(svg)});
  window.mixdogDesktop = { visualizeCommand: async () => ({}) };
  window.showPanel = () => {
    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', active: 't1', tabs: [{ id: 't1', label: 'mockup.svg',
      revision: 0, panes: [{ kind: 'image', label: 'mockup.svg', target: 'mockup.svg', url }] }] } });
    createRoot(document.querySelector('.workbench-side-section-body')).render(<VisualizePane sessionId="s1" active onClose={() => {}} />);
  };
  window.showViewer = (src = url) => {
    window.viewerClosed = false;
    createRoot(document.getElementById('viewer')).render(
      <ImageLightbox items={[{ id: 'a', src, name: 'mockup.svg' }]} startId="a" onClose={() => { window.viewerClosed = true; }} />);
  };
`;
const box = (page, selector) =>
  page.$eval(selector, (element) => {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  });
/** Where window point (x, y) falls on the image, in image px. */
const onImage = (page, selector, x, y) =>
  page.$eval(
    selector,
    (element, x, y, natural) => {
      const rect = element.getBoundingClientRect();
      return { x: ((x - rect.left) / rect.width) * natural.width, y: ((y - rect.top) / rect.height) * natural.height };
    },
    x,
    y,
    IMAGE
  );
const uncancelable = (messages) => messages.filter((message) => /cancel a touchmove/.test(message));

test('phone Visualize sheet: a tall picture clears the zoom pill and follows the fingers', async (t) => {
  const { page, messages, touch, tap } = await openPhone(t);
  await page.evaluate(() => window.showPanel());
  await page.waitForFunction(() => document.querySelector('.visualize-pane-content img')?.complete);
  await wait(200);
  const img = '.visualize-pane-content img';
  const content = '.visualize-pane-content';
  const percent = () => page.$eval('.browser-zoom-percent span', (element) => element.textContent);

  // Fit: the whole picture shows, its bottom above the pill.
  const pill = await box(page, '.browser-zoom-pill');
  let picture = await box(page, img);
  assert.ok(picture.height > 600, `the picture fills the sheet's height (${picture.height}px)`);
  assert.ok(picture.bottom <= pill.top, `the fitted picture ends (${picture.bottom}) above the pill (${pill.top})`);

  // Zoomed and scrolled to the end, its bottom is reachable above the pill.
  for (let step = 0; step < 2; step += 1) await page.$eval('[aria-label="Zoom in"]', (button) => button.click());
  await page.$eval(content, (element) => {
    element.scrollTop = element.scrollHeight;
  });
  picture = await box(page, img);
  assert.ok(picture.bottom <= pill.top, `the zoomed picture's end (${picture.bottom}) is above the pill (${pill.top})`);

  // One finger drags the zoomed picture with it.
  await page.$eval(content, (element) => {
    element.scrollTop = element.scrollHeight / 4;
    element.scrollLeft = element.scrollWidth / 4;
  });
  const first = await onImage(page, img, 195, 400);
  await touch('touchStart', [[195, 400]]);
  for (let y = 396; y >= 340; y -= 4) await touch('touchMove', [[195, y]]);
  const dragged = await onImage(page, img, 195, 340);
  const pixel = (await box(page, img)).height / IMAGE.height;
  assert.ok(Math.abs(dragged.y - first.y) * pixel <= 2, 'the picture point stays under the finger');

  // A second finger lands and spreads: the picture zooms under both fingers.
  const before = await percent();
  await touch('touchStart', [
    [195, 340],
    [195, 460],
  ]);
  const underA = await onImage(page, img, 195, 340);
  const underB = await onImage(page, img, 195, 460);
  for (let y = 470; y <= 580; y += 10)
    await touch('touchMove', [
      [195, 340],
      [195, y],
    ]);
  await touch('touchEnd', []);
  assert.notEqual(await percent(), before, 'the pinch zoomed');
  const scale = (await box(page, img)).height / IMAGE.height;
  const nowA = await onImage(page, img, 195, 340);
  const nowB = await onImage(page, img, 195, 580);
  assert.ok(Math.abs(nowA.y - underA.y) * scale <= 8, `finger A kept its point (${(nowA.y - underA.y) * scale}px)`);
  assert.ok(Math.abs(nowB.y - underB.y) * scale <= 8, `finger B kept its point (${(nowB.y - underB.y) * scale}px)`);
  assert.deepEqual(uncancelable(messages), [], 'no browser scroll ran under the pinch');

  // A double tap goes back to fit, another to the picture's own pixels.
  await tap(195, 400);
  await tap(195, 400);
  await wait(100);
  assert.equal(await percent(), '100%');
  await wait(400);
  const fitted = await page.$eval(img, (element) => element.getBoundingClientRect().width);
  await tap(195, 400);
  await tap(195, 400);
  await wait(100);
  assert.equal(await percent(), `${Math.round((IMAGE.width / fitted) * 100)}%`);
});

test('phone chat image viewer: pinch between fit and full resolution, pan, double tap, Escape closes', async (t) => {
  const { page, touch, tap } = await openPhone(t);
  await page.evaluate(() => window.showViewer());
  await page.waitForFunction(() => document.querySelector('dialog.image-lightbox img')?.complete);
  await wait(200);
  const img = 'dialog.image-lightbox img';
  const stage = await box(page, '.image-lightbox-stage');
  const fit = await box(page, img);
  assert.ok(fit.top >= stage.top && fit.bottom <= stage.bottom + 0.5, 'the whole picture fits the stage');
  const full = IMAGE.width / fit.width;
  const scale = async () => (await box(page, img)).width / fit.width;

  // A double tap shows the picture at its own pixels, the tapped point kept.
  const at = [stage.left + stage.width / 2 + 40, stage.top + stage.height / 2 + 100];
  const point = await onImage(page, img, ...at);
  await tap(...at);
  await tap(...at);
  await wait(100);
  assert.ok(Math.abs((await scale()) - full) < 0.01, 'zoomed to the original resolution');
  const kept = await onImage(page, img, ...at);
  assert.ok(Math.hypot(kept.x - point.x, kept.y - point.y) < 2, 'the tapped point stays under the finger');

  // One finger pans; the picture never leaves the stage.
  await touch('touchStart', [[200, 400]]);
  for (let x = 210; x <= 2000; x += 60) await touch('touchMove', [[x, 400]]);
  await touch('touchEnd', []);
  const panned = await box(page, img);
  assert.ok(Math.abs(panned.left - stage.left) < 1, 'panned to the picture’s left edge, not past it');

  // Pinching out stops at full resolution, pinching in at fit.
  const pinch = async (from, to) => {
    const y = stage.top + stage.height / 2;
    await touch('touchStart', [
      [195 - from, y],
      [195 + from, y],
    ]);
    for (let step = 1; step <= 10; step += 1) {
      const half = from + ((to - from) * step) / 10;
      await touch('touchMove', [
        [195 - half, y],
        [195 + half, y],
      ]);
    }
    await touch('touchEnd', []);
  };
  await pinch(20, 160);
  assert.ok(Math.abs((await scale()) - full) < 0.01, 'never past the original resolution');
  await pinch(160, 10);
  assert.ok(Math.abs((await scale()) - 1) < 0.01, 'never below fit');
  const centred = await box(page, img);
  assert.ok(Math.abs(centred.left - fit.left) < 1 && Math.abs(centred.top - fit.top) < 1, 'fit is centred again');

  // The spread doubles while the midpoint moves: each finger keeps its point.
  const [x, y0] = [stage.left + stage.width / 2, stage.top + stage.height / 2];
  const underA = await onImage(page, img, x, y0 - 50);
  const underB = await onImage(page, img, x, y0 + 50);
  await touch('touchStart', [
    [x, y0 - 50],
    [x, y0 + 50],
  ]);
  for (let step = 1; step <= 10; step += 1)
    await touch('touchMove', [
      [x, y0 - 50],
      [x, y0 + 50 + 10 * step],
    ]);
  const nowA = await onImage(page, img, x, y0 - 50);
  const nowB = await onImage(page, img, x, y0 + 150);
  await touch('touchEnd', []);
  const pixel = (await box(page, img)).height / IMAGE.height;
  assert.ok(Math.abs((await scale()) - 2) < 0.02, 'the spread doubled the scale');
  assert.ok(Math.abs(nowA.y - underA.y) * pixel <= 2, `finger A kept its point (${(nowA.y - underA.y) * pixel}px)`);
  assert.ok(Math.abs(nowB.y - underB.y) * pixel <= 2, `finger B kept its point (${(nowB.y - underB.y) * pixel}px)`);

  // Escape closes the dialog.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.viewerClosed === true);
});

test('phone chat image viewer: a picture over 16× its fitted size still reaches its original resolution', async (t) => {
  const { page, touch, tap } = await openPhone(t);
  const wide = { width: 8000, height: 1000 };
  await page.evaluate(
    (size) =>
      window.showViewer(
        `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><rect width="100%" height="100%" fill="#3a6"/></svg>`
        )}`
      ),
    wide
  );
  await page.waitForFunction(() => document.querySelector('dialog.image-lightbox img')?.complete);
  await wait(200);
  const img = 'dialog.image-lightbox img';
  const stage = await box(page, '.image-lightbox-stage');
  const fit = await box(page, img);
  const full = wide.width / fit.width;
  assert.ok(full > 16, `the original is ${full}× the fitted picture`);
  const scale = async () => (await box(page, img)).width / fit.width;
  const [x, y] = [stage.left + stage.width / 2, stage.top + stage.height / 2];

  await tap(x, y);
  await tap(x, y);
  await wait(100);
  assert.ok(Math.abs((await scale()) - full) < 0.05, `double tap: ${await scale()}× of ${full}×`);

  await tap(x, y);
  await tap(x, y);
  await wait(400);
  // Pinch out far past the original: it stops there.
  for (let round = 0; round < 3; round += 1) {
    await touch('touchStart', [
      [x - 10, y],
      [x + 10, y],
    ]);
    for (let step = 1; step <= 10; step += 1)
      await touch('touchMove', [
        [x - 10 - 14 * step, y],
        [x + 10 + 14 * step, y],
      ]);
    await touch('touchEnd', []);
  }
  assert.ok(Math.abs((await scale()) - full) < 0.05, `pinch: ${await scale()}× of ${full}×`);
});
