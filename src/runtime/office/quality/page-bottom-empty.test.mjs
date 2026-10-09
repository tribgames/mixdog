import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { reviewRenderedOfficePages } from './assurance-rendered.mjs';

// A 240 × 340 page whose text lines run from 10% of the height down to `end` of it, with a footer line at 95%.
const page = (number, end) => {
  const canvas = createCanvas(240, 340);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111111';
  for (let y = 34; y < 340 * end; y += 12) context.fillRect(24, y, 190, 5);
  context.fillRect(180, 323, 30, 4);
  return { page: number, width: 240, height: 340, data: canvas.toBuffer('image/png').toString('base64') };
};
const found = (review) =>
  review.issues.filter((entry) => entry.code === 'page_bottom_empty').map((entry) => [entry.path, entry.severity]);

test('a page that is not the last stops early: its empty foot is reported, the footer line aside', async () => {
  const review = await reviewRenderedOfficePages([page(1, 0.88), page(2, 0.5), page(3, 0.88), page(4, 0.3)], {
    format: 'docx',
    pageCount: 4,
    forcedBreakPages: [],
  });
  assert.deepEqual(found(review), [['/page[2]', 'warning']]);
  const metric = review.pages.find((entry) => entry.page === 2);
  assert.ok(metric.bodyEnd > 0.4 && metric.bodyEnd < 0.6, JSON.stringify(metric));
});

test('the last page may end anywhere; a short cover page is exempt; designed pages are not flowed', async () => {
  assert.deepEqual(
    found(await reviewRenderedOfficePages([page(1, 0.88), page(2, 0.4)], { format: 'pdf', pageCount: 2 })),
    []
  );
  assert.deepEqual(
    found(await reviewRenderedOfficePages([page(1, 0.45), page(2, 0.88)], { format: 'docx', pageCount: 2 })),
    []
  );
  assert.deepEqual(
    found(
      await reviewRenderedOfficePages([page(1, 0.88), page(2, 0.5), page(3, 0.88)], {
        format: 'pdf',
        pageCount: 3,
        designedPages: true,
      })
    ),
    []
  );
});

test('a page rendered alone is held against the document length, not the images it came with', async () => {
  assert.deepEqual(
    found(await reviewRenderedOfficePages([page(2, 0.5)], { format: 'docx', pageCount: 3, forcedBreakPages: [] })),
    [['/page[2]', 'warning']]
  );
});

test('a short chapter page before a forced break, or a last page that opens one, is not sparse', async () => {
  const sparse = (review) => review.issues.filter((entry) => entry.code === 'sparse_page').map((entry) => entry.path);
  const pages = [page(1, 0.88), page(2, 0.2), page(3, 0.2)];
  assert.deepEqual(sparse(await reviewRenderedOfficePages(pages, { format: 'pdf', pageCount: 3, forcedBreakPages: [2, 3] })), []);
  assert.deepEqual(sparse(await reviewRenderedOfficePages(pages, { format: 'pdf', pageCount: 3, forcedBreakPages: [] })), [
    '/page[3]',
  ]);
});

test('a page before a deliberate forced break is exempt; without break data the warning stands', async () => {
  const pages = [page(1, 0.88), page(2, 0.5), page(3, 0.88)];
  assert.deepEqual(
    found(await reviewRenderedOfficePages(pages, { format: 'docx', pageCount: 3, forcedBreakPages: [3] })),
    []
  );
  assert.deepEqual(found(await reviewRenderedOfficePages(pages, { format: 'docx', pageCount: 3 })), [
    ['/page[2]', 'warning'],
  ]);
});
