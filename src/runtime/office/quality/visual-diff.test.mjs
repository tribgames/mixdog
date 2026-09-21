import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { compareRenderedPages } from './visual-diff.mjs';

function image(page, shades) {
  const canvas = createCanvas(shades.length, 1);
  const context = canvas.getContext('2d');
  shades.forEach((shade, index) => {
    context.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
    context.fillRect(index, 0, 1, 1);
  });
  return { page, data: canvas.toBuffer('image/png').toString('base64') };
}

test('visual diff preserves the pixel threshold, page order, missing pages, and saved evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-visual-diff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await compareRenderedPages(
    [image(2, [0]), image(1, [255, 255])],
    [image(1, [232, 231])],
    join(directory, 'review.pdf')
  );
  assert.equal(result.available, true);
  assert.deepEqual(result.pages, [
    { page: 1, changedPixels: 1, totalPixels: 2, changedPercent: 50 },
    { page: 2, changedPixels: 1, totalPixels: 1, changedPercent: 100 },
  ]);
  assert.equal(result.changedPercent, 75);
  for (const [index, entry] of result.images.entries()) {
    assert.equal(entry.page, index + 1);
    assert.equal(entry.path, join(directory, `review-visual-diff-page-${index + 1}.png`));
    assert.equal(entry.width, index === 0 ? 2 : 1);
    assert.equal(entry.height, 1);
    assert.equal(entry.mimeType, 'image/png');
    assert.equal(entry.kind, 'visual-diff');
    const bytes = await readFile(entry.path);
    assert.deepEqual(bytes, Buffer.from(entry.data, 'base64'));
    const decoded = await loadImage(bytes);
    assert.equal(decoded.width, entry.width);
    assert.equal(decoded.height, entry.height);
  }
});

test('visual diff pads unequal dimensions and reports an empty comparison without evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-visual-diff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'review.pdf');
  const result = await compareRenderedPages([image(1, [0])], [image(1, [0, 0])], output);
  assert.deepEqual(result.pages, [{ page: 1, changedPixels: 1, totalPixels: 2, changedPercent: 50 }]);
  assert.deepEqual(await compareRenderedPages([], [], output), {
    available: false,
    pages: [],
    changedPercent: 0,
    images: [],
  });
  await assert.rejects(compareRenderedPages([], [{ page: 1, data: 'not an image' }], output));
});
