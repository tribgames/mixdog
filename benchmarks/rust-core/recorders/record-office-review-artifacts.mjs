#!/usr/bin/env node
// Golden of the office authoring review artifacts (crate mixdog-office-author, modules contact_sheet, review_artifacts and
// source_drift): what Node's `runtime/office/authoring/pptx-contact-sheet.mjs`, `pptx-review-artifacts.mjs` and
// `html-source-drift.mjs` answer to
//   - page image sets (a list of { page, data (base64 PNG) } entries, some nested in `pageImages`, in any order) written as
//     one labelled grid: the sheet's size, the pages it lists, the file it wrote and its PNG (@napi-rs/canvas, Skia);
//   - previews of a deck that was opened for editing (no receipt): the review result's keys, how many images ride along and
//     the contact sheet that is attached to it (the sheet's pixels only past four slides);
//   - sequences of calls on a session's HTML source (mark, batch, replace) with every answer and the state left.
// Rust `mixdog-office-author` replays the same inputs: the sheet must equal the recorded size and page list exactly, its
// pixels within the tolerance written at the top of tests/twin_review_artifacts.rs, and the drift answers exactly.
//
//   node benchmarks/rust-core/recorders/record-office-review-artifacts.mjs --tree <product tree with node_modules>
//
// Output: native/core/fixtures/office-review-artifacts/golden.json (and MANIFEST.json).
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-review-artifacts.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-review-artifacts');
const stage = stageSet(finalDir);

const requireFromTree = createRequire(join(tree, 'package.json'));
const { createCanvas } = requireFromTree('@napi-rs/canvas');
const { writeContactSheet } = await importFrom(tree, 'src/runtime/office/authoring/pptx-contact-sheet.mjs');
const { pptxReviewArtifacts } = await importFrom(tree, 'src/runtime/office/authoring/pptx-review-artifacts.mjs');
const drift = await importFrom(tree, 'src/runtime/office/authoring/html-source-drift.mjs');

const work = mkdtempSync(join(tmpdir(), 'mixdog-review-artifacts-'));

// ---- the pages: flat blocks with a hard edge, so scaling and the frame are visible ------------------------------------------
const COLOURS = ['#e0e4ea', '#d6e6d0', '#f0d9d2', '#d4dcf0', '#f2ecc8', '#e2d2ee'];
function pagePng(width, height, index) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = COLOURS[index % COLOURS.length];
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#304060';
  ctx.fillRect(Math.floor(width / 8), Math.floor(height / 6), Math.floor(width / 2), Math.floor(height / 5));
  ctx.fillStyle = '#a04030';
  ctx.fillRect(Math.floor(width / 3), Math.floor((height * 3) / 5), Math.floor(width / 2), Math.floor(height / 6));
  return canvas.toBuffer('image/png');
}
const entry = (page, width, height) => ({ page, data: pagePng(width, height, page).toString('base64'), mimeType: 'image/png' });
const sizes = { wide: [160, 90], standard: [120, 90], tall: [90, 120], square: [100, 100] };
const run = (count, shape = 'wide') => Array.from({ length: count }, (_, i) => entry(i + 1, ...sizes[shape]));
const mixed = ['wide', 'tall', 'standard', 'square', 'wide', 'tall'];

const SHEETS = [
  { name: 'one page is not a sheet', images: run(1) },
  { name: 'no pages', images: [] },
  { name: 'two pages', images: run(2) },
  { name: 'four pages', images: run(4) },
  { name: 'five pages in three columns', images: run(5) },
  { name: 'nine pages', images: run(9) },
  { name: 'ten pages in four columns', images: run(10) },
  { name: 'twelve mixed aspect ratios', images: Array.from({ length: 12 }, (_, i) => entry(i + 1, ...sizes[mixed[i % mixed.length]])) },
  { name: 'pages out of order', images: [3, 1, 2].map((n) => entry(n, ...sizes.standard)) },
  { name: 'pages nested in pageImages', images: [{ page: 0, pageImages: run(3, 'standard') }, { page: 9, data: '' }, entry(4, ...sizes.tall)] },
  { name: 'an entry without data or page is left out', images: [...run(2), { page: 3 }, { data: entry(4, ...sizes.wide).data }] },
  { name: 'a width of 800', images: run(6), options: { width: 800 } },
  { name: 'page numbers of two digits', images: Array.from({ length: 5 }, (_, i) => entry(i + 8, ...sizes.wide)) },
];

const toRecord = (images) => images.map((image) => (Array.isArray(image.pageImages) ? { ...image, pageImages: image.pageImages } : image));

const sheets = [];
for (const [index, scenario] of SHEETS.entries()) {
  const output = join(work, `deck-${index}.pdf`);
  let answer;
  try {
    const sheet = await writeContactSheet(structuredClone(scenario.images), output, scenario.options);
    answer = sheet
      ? { path: basename(sheet.path), width: sheet.width, height: sheet.height, pages: sheet.pages, mimeType: sheet.mimeType, data: sheet.data, written: readFileSync(sheet.path).toString('base64') === sheet.data }
      : null;
  } catch (error) {
    answer = { error: String(error?.message ?? error) };
  }
  sheets.push({ name: scenario.name, input: { images: toRecord(scenario.images), options: scenario.options ?? null, output: basename(output) }, output: answer });
}

// ---- review results of a deck with no receipt (opened for editing) ----------------------------------------------------------
const PREVIEWS = [
  { name: 'three pages: the file is written, no sheet image', count: 3 },
  { name: 'four pages: still no sheet image', count: 4 },
  { name: 'five pages: the sheet rides along as page 0', count: 5 },
  { name: 'six pages with extra keys', count: 6, extra: { renderer: 'x', pageCount: 6, note: 'kept' } },
  { name: 'one page: no sheet', count: 1 },
  { name: 'a page count above the images: the count decides', count: 3, pageCount: 8 },
  { name: 'no page count: the images decide', count: 5, pageCount: null },
];
const previews = [];
for (const [index, scenario] of PREVIEWS.entries()) {
  const output = join(work, `preview-${index}.pdf`);
  const preview = { output, pageCount: scenario.pageCount === undefined ? scenario.count : scenario.pageCount, ...(scenario.extra ?? {}), _images: run(scenario.count, 'standard') };
  if (preview.pageCount === null) delete preview.pageCount;
  const input = { ...preview, output: basename(output) };
  const result = await pptxReviewArtifacts({ id: 'fixture', format: 'pptx' }, structuredClone(preview));
  const images = result._images.map((image) => ({ page: image.page, path: image.path ? basename(image.path) : null, hasData: Boolean(image.data), width: image.width ?? null, height: image.height ?? null, pages: image.pages ?? null, mimeType: image.mimeType ?? null }));
  const { _images, contactSheet, ...rest } = result;
  previews.push({
    name: scenario.name,
    input,
    output: {
      keys: Object.keys(result),
      rest: { ...rest, output: basename(rest.output) },
      images,
      sheetData: result._images.length ? (result._images.at(-1).page === 0 ? result._images.at(-1).data : null) : null,
      contactSheet: contactSheet ? { ...contactSheet, path: basename(contactSheet.path) } : null,
    },
  });
}

// ---- the HTML source: sequences of calls on a session ---------------------------------------------------------------------
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
const SEQUENCES = [
  { name: 'a batch before any author is not noted', ops: [['batch', { changeSummary: { changed: 3 } }], ['replaced']] },
  { name: 'author from html, then batches', ops: [['mark', '/work/deck.mixdog-source.html'], ['batch', { changeSummary: { changed: 2 } }], ['batch', { changeSummary: { changed: 1 } }], ['replaced']] },
  { name: 'a batch that changed nothing', ops: [['mark', 'a.html'], ['batch', { changeSummary: { changed: 0 } }], ['batch', {}], ['batch', null], ['batch', { changeSummary: null }], ['replaced']] },
  { name: 'one edit is singular', ops: [['mark', 'a.html'], ['batch', { changeSummary: { changed: 1 } }], ['replaced']] },
  { name: 'marking again resets the count', ops: [['mark', 'a.html'], ['batch', { changeSummary: { changed: 4 } }], ['mark', 'b.html'], ['replaced'], ['batch', { changeSummary: { changed: 1 } }], ['replaced']] },
  { name: 'an empty source path clears the source', ops: [['mark', 'a.html'], ['batch', { changeSummary: { changed: 2 } }], ['mark', ''], ['batch', { changeSummary: { changed: 2 } }], ['replaced']] },
  { name: 'a null source path clears the source', ops: [['mark', null], ['batch', { changeSummary: { changed: 2 } }], ['replaced']] },
  { name: 'changed counts read as numbers', ops: [['mark', 'a.html'], ['batch', { changeSummary: { changed: '3' } }], ['batch', { changeSummary: { changed: 'x' } }], ['batch', { changeSummary: { changed: true } }], ['batch', { changeSummary: { changed: 2.5 } }], ['replaced']] },
  { name: 'a negative count is still a count', ops: [['mark', 'a.html'], ['batch', { changeSummary: { changed: -2 } }], ['replaced']] },
];
const sequences = SEQUENCES.map((scenario) => {
  const session = { id: 'fixture' };
  const answers = scenario.ops.map(([op, value]) => {
    if (op === 'mark') {
      drift.markAuthoredFromHtml(session, value);
      return null;
    }
    if (op === 'batch') return plain(drift.noteBatchAgainstHtml(session, value));
    return plain(drift.editsReplacedByAuthor(session));
  });
  return { name: scenario.name, input: { ops: scenario.ops }, output: { answers, htmlSource: session.htmlSource ?? null, htmlSourceEdits: session.htmlSourceEdits ?? null } };
});
const nothing = {
  markNull: (() => drift.markAuthoredFromHtml(null, 'a.html') ?? null)(),
  batchNull: drift.noteBatchAgainstHtml(null, { changeSummary: { changed: 1 } }) ?? null,
  replacedNull: drift.editsReplacedByAuthor(null) ?? null,
  replacedUndefined: drift.editsReplacedByAuthor(undefined) ?? null,
};

rmSync(work, { recursive: true, force: true });
writeJson(join(stage, 'golden.json'), { sheets, previews, sequences, nothing });
writeSetManifest(stage, { set: 'office-review-artifacts', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`golden.json ${readFileSync(join(finalDir, 'golden.json')).length} bytes`);
process.exit(0);
