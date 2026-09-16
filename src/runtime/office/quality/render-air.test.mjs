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
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#111111';
    c.fillRect(40, 40, 200, 30);
  });
  const darkSparse = page((c, w, h) => {
    c.fillStyle = '#0f1b26';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#f8fafc';
    c.fillRect(40, 40, 200, 30);
  });
  const dense = page((c, w, h) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    for (let y = 30; y < h - 30; y += 24) {
      for (let x = 30; x < w - 30; x += 40) {
        c.fillStyle = (x + y) % 80 ? '#222222' : '#0e7c86';
        c.fillRect(x, y, 28, 12);
      }
    }
  });
  const light = (await renderedAir(lightSparse)).air;
  const dark = (await renderedAir(darkSparse)).air;
  const busyRead = await renderedAir(dense),
    busy = busyRead.air;
  assert.ok(light > 0.8, `a mostly empty light page: ${light}`);
  assert.ok(Math.abs(light - dark) < 0.05, `the surface color does not change the reading: ${light} vs ${dark}`);
  assert.ok(busy < 0.3, `a page full of text rows: ${busy}`);
  // Balance: the evenly filled page is balanced; a page whose only mark sits in the top-left corner is not.
  assert.ok(
    busyRead.balance.score > 0.85 && busyRead.balance.topBottom > 0.9,
    `even rows balance top and bottom: ${JSON.stringify(busyRead.balance)}`
  );
  const corner = (await renderedAir(lightSparse)).balance;
  assert.ok(
    corner.topBottom < 0.5 && corner.leftRight < 0.7 && corner.centered < 0.8,
    `one block in the top-left corner pulls every reading down: ${JSON.stringify(corner)}`
  );
  // Colourfulness: paper with black type reads near zero; the same page with a teal chart field reads as colour.
  const accent = page((c, w, h) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#111111';
    c.fillRect(40, 40, 200, 30);
    c.fillStyle = '#0e7c86';
    c.fillRect(40, 120, 400, 200);
  });
  const quiet = (await renderedAir(lightSparse)).colour,
    coloured = (await renderedAir(accent)).colour;
  assert.ok(quiet < 5, `black on white: ${quiet}`);
  assert.ok(coloured > 15 && coloured > quiet * 3, `a teal field over a third of the page: ${coloured}`);
  // The largest object: the teal field (400 × 200 of 640 × 360 = 0.35) on the accent page; the one title block
  // (200 × 30 = 0.026) on the sparse page; the dense rows are many small objects, none large.
  const big = (await renderedAir(accent)).largest,
    small = (await renderedAir(lightSparse)).largest,
    rows = (await renderedAir(dense)).largest;
  assert.ok(big > 0.3 && big < 0.4, `the teal field: ${big}`);
  assert.ok(small < 0.05, `one title block: ${small}`);
  assert.ok(rows < 0.02, `rows of separate blocks: ${rows}`);
});

test('rendered air maps every page of a deck and unfolds a contact sheet to its pages', async () => {
  const filled = page((c, w, h) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    for (let y = 30; y < h - 30; y += 20) {
      c.fillStyle = '#333333';
      c.fillRect(30, y, w - 60, 8);
    }
  });
  const empty = page((c, w, h) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
  });
  const byPage = await renderedAirByPage([
    { page: 1, data: filled },
    {
      page: 2,
      pages: [2, 3],
      data: empty,
      pageImages: [
        { page: 2, data: empty },
        { page: 3, data: filled },
      ],
    },
  ]);
  assert.deepEqual([...byPage.keys()], [1, 2, 3]);
  assert.ok(byPage.get(1).air < byPage.get(2).air);
  assert.equal(byPage.get(3).air, byPage.get(1).air);
  assert.ok(byPage.get(1).balance && typeof byPage.get(1).balance.topBottom === 'number');
  assert.equal(await renderedAir('not-an-image'), null);
});
