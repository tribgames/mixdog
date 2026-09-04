import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { renderedAir, renderedAirByPage } from './render-air.mjs';

function page(paint, { width = 640, height = 360 } = {}) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  paint(context, width, height);
  return canvas.toBuffer('image/png').toString('base64');
}

test('rendered air reads flat regions as air on paper and on a dark field alike', async () => {
  const lightSparse = page((c, w, h) => {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#111111'; c.fillRect(40, 40, 200, 30);
  });
  const darkSparse = page((c, w, h) => {
    c.fillStyle = '#0f1b26'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#f8fafc'; c.fillRect(40, 40, 200, 30);
  });
  const dense = page((c, w, h) => {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
    for (let y = 30; y < h - 30; y += 24) {
      for (let x = 30; x < w - 30; x += 40) {
        c.fillStyle = (x + y) % 80 ? '#222222' : '#0e7c86';
        c.fillRect(x, y, 28, 12);
      }
    }
  });
  const light = await renderedAir(lightSparse);
  const dark = await renderedAir(darkSparse);
  const busy = await renderedAir(dense);
  assert.ok(light > 0.8, `a mostly empty light page: ${light}`);
  assert.ok(Math.abs(light - dark) < 0.05, `the surface color does not change the reading: ${light} vs ${dark}`);
  assert.ok(busy < 0.3, `a page full of text rows: ${busy}`);
});

test('rendered air maps every page of a deck and unfolds a contact sheet to its pages', async () => {
  const filled = page((c, w, h) => {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
    for (let y = 30; y < h - 30; y += 20) { c.fillStyle = '#333333'; c.fillRect(30, y, w - 60, 8); }
  });
  const empty = page((c, w, h) => { c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h); });
  const byPage = await renderedAirByPage([
    { page: 1, data: filled },
    { page: 2, pages: [2, 3], data: empty, pageImages: [{ page: 2, data: empty }, { page: 3, data: filled }] },
  ]);
  assert.deepEqual([...byPage.keys()], [1, 2, 3]);
  assert.ok(byPage.get(1) < byPage.get(2));
  assert.equal(byPage.get(3), byPage.get(1));
  assert.equal(await renderedAir('not-an-image'), null);
});