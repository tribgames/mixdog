import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import { applyPdfBatch } from '../src/runtime/office/pdf/pdf-adapter.mjs';
import { extractPdfTextLayout, findPdfText } from '../src/runtime/office/pdf/pdf-analysis.mjs';

// Deterministic differential stress: compare search-derived PDF marks with
// the coordinates used to draw the source, varying page rotation and boxes.
// This is opt-in and never runs as part of the default unit suite.
const until = Date.parse(process.argv[2] || '');
assert.ok(Number.isFinite(until), 'Pass an ISO end time');
const directory = await mkdtemp(join(tmpdir(), 'pdf-rotation-stress-'));
const path = join(directory, 'latest.pdf');
let state = 0x5eed2026;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 0x100000000;
};
const between = (min, max) => min + random() * (max - min);
let rounds = 0;
let pagesChecked = 0;
let nextReport = Date.now();
do {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont('Helvetica');
  const expected = [];
  for (let index = 0; index < 16; index += 1) {
    const width = between(400, 700);
    const height = between(350, 800);
    const originX = between(-100, 150);
    const originY = between(-100, 150);
    const page = pdf.addPage([width, height]);
    page.setMediaBox(originX, originY, width, height);
    page.setCropBox(originX + 10, originY + 10, width - 20, height - 20);
    page.setRotation(degrees([0, 90, 180, 270][index % 4]));
    const size = between(9, 30);
    const x = originX + 40;
    const y = originY + height - 80;
    const prefix = font.widthOfTextAtSize('Al', size);
    // Separate text runs exercise joining in reversed as well as upright text.
    page.drawText('Alpha', { x, y, size, font });
    page.drawText('beta', { x: x + font.widthOfTextAtSize('Alpha ', size), y, size, font });
    expected.push({ x: x + prefix, y, width: font.widthOfTextAtSize('pha beta', size), height: size });
  }
  await writeFile(path, await pdf.save());
  const results = await applyPdfBatch(path, [
    { op: 'highlight', find: 'pha beta' },
    { op: 'add_link', find: 'pha beta', toPage: 1 },
    { op: 'add_text', text: 'After measurement', page: 1, x: 40, y: 40, size: 10 },
  ]);
  for (const result of results.slice(0, 2)) {
    assert.equal(result.boxes.length, expected.length);
    for (const box of result.boxes) {
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(box[key] - expected[box.page - 1][key]) < 0.08,
          JSON.stringify({ round: rounds, state, key, box, expected: expected[box.page - 1], path }));
      }
    }
  }
  const layout = await extractPdfTextLayout(path, { shapes: false });
  assert.equal(findPdfText(layout, 'pha beta').matchCount, expected.length);
  const saved = await PDFDocument.load(await readFile(path));
  assert.deepEqual(saved.getPages().map((page) => page.getRotation().angle),
    expected.map((_, index) => [0, 90, 180, 270][index % 4]));
  rounds += 1;
  pagesChecked += expected.length;
  if (Date.now() >= nextReport) {
    console.log(JSON.stringify({ rounds, pagesChecked, rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024) }));
    nextReport = Date.now() + 60_000;
  }
} while (Date.now() < until);
console.log(JSON.stringify({ ok: true, rounds, pagesChecked, directory }));
