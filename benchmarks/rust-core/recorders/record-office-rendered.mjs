#!/usr/bin/env node
// Golden of the rendered-page review (crate mixdog-office-quality: rendered, aesthetics, aesthetics_metrics, render_air,
// visual_diff): what Node's `runtime/office/quality/{assurance-rendered,design-aesthetics,design-aesthetics-metrics,
// render-air,visual-diff}.mjs` answer to a fixed corpus of rendered PNG pages (decks, documents, worksheets, blank-ish
// pages, pages with transparent areas and soft edges, a page past the sampling step). Writes
// native/core/fixtures/office-rendered/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-rendered.mjs --tree <product tree with node_modules>
//
// Sections: pages (reviewRenderedOfficePages: input { images, options }), aesthetics (reviewRenderedOfficeAesthetics:
// input { images, format, pageRoles }), air (renderedAir of one base64), airByPage (renderedAirByPage: the output is the
// list of [page, read]) and diff (compareRenderedPages: input { before, after }; the output keeps each diff image's size
// and the sha256 of its decoded RGBA pixels, not its bytes: the PNG encoders differ, the pixels may not). Every input is
// plain JSON; the pictures are drawn by seeded scripts so a re-recording is the same.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-rendered.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-rendered');
const stage = stageSet(finalDir, ['golden.json']);
const requireFromTree = createRequire(join(tree, 'package.json'));
const { createCanvas, loadImage } = requireFromTree('@napi-rs/canvas');
const rendered = await importFrom(tree, 'src/runtime/office/quality/assurance-rendered.mjs');
const aesthetics = await importFrom(tree, 'src/runtime/office/quality/design-aesthetics.mjs');
const air = await importFrom(tree, 'src/runtime/office/quality/render-air.mjs');
const visualDiff = await importFrom(tree, 'src/runtime/office/quality/visual-diff.mjs');

const plain = (value) => JSON.parse(JSON.stringify(value));
const attempt = async (run) => {
  try {
    return { output: plain(await run()) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// A deterministic generator for the textured pages.
let seed = 20260719;
const next = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const png = (width, height, paint) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  paint(context, width, height);
  return canvas.toBuffer('image/png').toString('base64');
};
const white = (context, width, height) => {
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
};
const slide = (page, paint, size = [320, 180]) => ({
  page,
  width: size[0],
  height: size[1],
  mimeType: 'image/png',
  data: png(size[0], size[1], (context, width, height) => {
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, width, height);
    paint(context, width, height);
  }),
});
const fill = (context, colour, x, y, w, h) => {
  context.fillStyle = colour;
  context.fillRect(x, y, w, h);
};
// A 240 x 340 text page whose lines run from 10% of the height down to `end` of it, with a footer line at 95%.
const textPage = (number, end) => slide(number, (context) => {
  context.fillStyle = '#111111';
  for (let y = 34; y < 340 * end; y += 12) context.fillRect(24, y, 190, 5);
  context.fillRect(180, 323, 30, 4);
}, [240, 340]);

const pageCases = [];
const addPages = async (images, options) => pageCases.push({ input: { images, options }, ...(await attempt(() => rendered.reviewRenderedOfficePages(images, options))) });
const aestheticCases = [];
const addAesthetics = async (images, format, pageRoles) =>
  aestheticCases.push({ input: { images, format, pageRoles }, ...(await attempt(() => aesthetics.reviewRenderedOfficeAesthetics(images, { format, pageRoles }))) });
// Every deck-like corpus is read both as pages and as aesthetics.
const addBoth = async (images, options) => {
  await addPages(images, options);
  await addAesthetics(images, options.format, options.pageRoles ?? {});
};

// Page-bottom-empty and sparse-page corpus (the page-bottom-empty suite and its variants).
const flow = [textPage(1, 0.88), textPage(2, 0.5), textPage(3, 0.88), textPage(4, 0.3)];
await addPages(flow, { format: 'docx', pageCount: 4, forcedBreakPages: [] });
await addPages(flow, { format: 'docx', pageCount: 4 });
await addPages(flow, { format: 'DOCX', forcedBreakPages: [3, 4] });
await addPages([textPage(1, 0.88), textPage(2, 0.4)], { format: 'pdf', pageCount: 2 });
await addPages([textPage(1, 0.45), textPage(2, 0.88)], { format: 'docx', pageCount: 2 });
await addPages([textPage(1, 0.88), textPage(2, 0.5), textPage(3, 0.88)], { format: 'pdf', pageCount: 3, designedPages: true });
await addPages([textPage(2, 0.5)], { format: 'docx', pageCount: 3, forcedBreakPages: [] });
await addPages([textPage(1, 0.88), textPage(2, 0.2), textPage(3, 0.2)], { format: 'pdf', pageCount: 3, forcedBreakPages: [2, 3] });
await addPages([textPage(1, 0.88), textPage(2, 0.2), textPage(3, 0.2)], { format: 'pdf', pageCount: 3, forcedBreakPages: [] });
await addPages([textPage(1, 0.88), textPage(2, 0.5), textPage(3, 0.88)], { format: 'docx', pageCount: 3, forcedBreakPages: [3] });
await addPages([textPage(1, 0.88), textPage(2, 0.5), textPage(3, 0.88)], { format: 'docx', pageCount: 3 });
await addPages([textPage(1, 0.88), textPage(2, 0.5), textPage(3, 0.88)], { format: 'docx' });
for (const end of [0.3, 0.45, 0.6, 0.69, 0.7, 0.71, 0.75, 0.9]) {
  await addPages([textPage(1, 0.88), textPage(2, end), textPage(3, 0.88)], { format: 'docx', pageCount: 3, forcedBreakPages: [] });
}

// Blank pages, edge contact, worksheets scaled into a corner, formats the review does not gate.
const blank = slide(1, () => {}, [240, 340]);
const nearlyBlank = slide(2, (context) => fill(context, '#444444', 100, 100, 6, 4), [240, 340]);
const edge = slide(3, (context) => fill(context, '#111111', 0, 40, 240, 200), [240, 340]);
const leftEdge = slide(4, (context) => fill(context, '#111111', 0, 40, 100, 200), [240, 340]);
for (const format of ['docx', 'pdf', 'xlsx', 'pptx', 'csv', '']) await addBoth([blank, nearlyBlank, edge, leftEdge], { format, pageCount: 4 });
const corner = slide(1, (context) => fill(context, '#222222', 10, 10, 90, 60), [300, 400]);
const wide = slide(2, (context) => fill(context, '#222222', 20, 20, 200, 120), [400, 300]);
const full = slide(3, (context) => {
  for (let y = 10; y < 390; y += 14) for (let x = 10; x < 290; x += 28) fill(context, (x + y) % 3 ? '#333333' : '#2a6fbb', x, y, 22, 8);
}, [300, 400]);
for (const smallWorksheet of [false, true]) await addBoth([corner, wide, full], { format: 'xlsx', smallWorksheet });
await addBoth([corner, wide, full], { format: 'xlsx', pageRoles: { 2: 'chart' } });

// Decks: a flat repeated deck, a varied one, sparse ones, a rainbow and a restrained palette, roles, contact sheets.
const flat = Array.from({ length: 6 }, (_, index) => slide(index + 1, (context, width, height) => {
  fill(context, '#080C12', 0, 0, width, height);
  fill(context, '#F8FAFC', 24, 20, 190, 12);
  fill(context, '#151D28', 24, 58, 272, 96);
  fill(context, '#58A6FF', 34, 70, 70, 58);
}));
await addBoth(flat, { format: 'pptx' });
const accents = ['#1F7A55', '#A3425A', '#276FBF', '#8F5B24'];
const varied = Array.from({ length: 6 }, (_, index) => slide(index + 1, (context, width, height) => {
  if (index === 0 || index === 5) {
    fill(context, '#132C3F', 0, 0, width, height);
    fill(context, '#FFFFFF', 28, 60, 190, 18);
    return;
  }
  fill(context, '#F7F9FC', 0, 0, width, height);
  fill(context, '#17212C', 20, 16, 220, 10);
  const accent = accents[index - 1];
  if (index === 1) fill(context, accent, 20, 50, 92, 108);
  if (index === 2) for (const y of [58, 92, 126]) fill(context, accent, 20, y, [270, 210, 145][(y - 58) / 34], 18);
  if (index === 3) {
    fill(context, accent, 172, 46, 120, 112);
    fill(context, '#DCE8F2', 20, 46, 124, 48);
  }
  if (index === 4) for (const x of [20, 124, 228]) fill(context, accent, x, 54, 72, 90);
}));
await addBoth(varied, { format: 'pptx' });
await addBoth(varied, { format: 'pptx', pageRoles: { 2: 'annotated-chart', 3: { visualType: 'diagram' }, 4: { slideRole: 'section', visualType: 'metric' }, 5: 'Timeline', 6: 'decision-close' } });
await addBoth(varied.slice(0, 4), { format: 'pptx' });
await addBoth(varied.slice(0, 2), { format: 'pptx' });
await addBoth(varied.slice(0, 1), { format: 'pptx' });
await addBoth([], { format: 'pptx' });
const sparse = Array.from({ length: 6 }, (_, index) => slide(index + 1, (context, width, height) => {
  const edgePage = index === 0 || index === 5;
  fill(context, edgePage ? '#132C3F' : '#FFFFFF', 0, 0, width, height);
  fill(context, edgePage ? '#FFFFFF' : '#172B25', 24, 28, edgePage ? 190 : 90, edgePage ? 11 : 8);
  fill(context, '#20B486', edgePage ? 230 : 238, edgePage ? 70 : 116, edgePage ? 56 : 12, edgePage ? 64 : 10);
}));
await addBoth(sparse, { format: 'pptx' });
const palette = (rainbow) => Array.from({ length: 6 }, (_, index) => slide(index + 1, (context, width, height) => {
  const edgePage = index === 0 || index === 5;
  fill(context, edgePage ? '#142A3B' : '#F7F9FC', 0, 0, width, height);
  fill(context, edgePage ? '#FFFFFF' : '#18242F', 24, 20, 210, 12);
  const colours = rainbow ? ['#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5', '#8E24AA'] : ['#0B8F78'];
  colours.forEach((colour, at) => fill(context, colour, 24 + at * 42, 58, rainbow ? 38 : 248, 82));
}));
await addBoth(palette(false), { format: 'pptx' });
await addBoth(palette(true), { format: 'pptx' });
const quiet = Array.from({ length: 6 }, (_, index) => slide(index + 1, (context, width, height) => {
  fill(context, '#F7F9FC', 0, 0, width, height);
  fill(context, '#18313E', 28, 34, 110, 12);
  fill(context, '#178D75', 222, 112, 34, 24);
}));
for (const role of ['decision-close', 'annotated-chart', 'cover', 'picture', 'scorecard', 'allocation', 'roadmap']) await addBoth(quiet, { format: 'pptx', pageRoles: { 3: role } });
const beats = [1, 2, 3, 4, 5].map((page) => slide(page, (context) => {
  fill(context, '#0B1F33', 0, 0, 320, 180);
  fill(context, '#F7FAFC', 28, 60, 90, 12);
}));
await addBoth(beats, { format: 'pptx' });
await addBoth(beats, { format: 'pptx', pageRoles: { 2: { slideRole: 'section', visualType: 'metric' } } });
const diagrams = [1, 2, 3, 4, 5].map((page) => slide(page, (context) => {
  fill(context, '#F7F9FC', 0, 0, 320, 180);
  fill(context, '#18242F', 24, 20, 100, 9);
  fill(context, '#EEF2F6', 24, 50, 130, 110);
  fill(context, '#EEF2F6', 166, 50, 130, 110);
  fill(context, '#178D75', 60, 100, 40, 6);
}));
await addBoth(diagrams, { format: 'pptx' });
await addBoth(diagrams, { format: 'pptx', pageRoles: { 3: { visualType: 'diagram' } } });
const sheetPage = (number, dark) => slide(number, (context, width, height) => {
  fill(context, dark ? '#0B1F33' : '#F7F9FC', 0, 0, width, height);
  fill(context, dark ? '#F7FAFC' : '#18242F', 24, 20, 150, 12);
  fill(context, '#178D75', 24, 50, 120, 90);
});
const contact = (first, numbers) => ({
  ...slide(first, (context, width, height) => fill(context, '#EEF0F4', 0, 0, width, height)),
  pages: numbers,
  pageImages: numbers.map((number) => sheetPage(number, number === 1 || number === 6)),
});
await addBoth([contact(1, [1, 2, 3]), contact(4, [4, 5, 6])], { format: 'pptx' });

// Documents and worksheets that trip the contrast and clutter gates.
await addBoth([slide(1, (context) => fill(context, '#DDDDDD', 32, 36, 256, 110), [320, 240])], { format: 'docx' });
await addBoth([slide(1, (context, width, height) => {
  for (let y = 0; y < height; y += 6) for (let x = 0; x < width; x += 6) fill(context, (x / 6 + y / 6) % 2 ? '#FFFFFF' : '#111111', x, y, 6, 6);
})], { format: 'xlsx' });

// Soft edges, gradients, transparency and a big page: what the resampling and the white flatten decide.
const gradient = slide(1, (context, width, height) => {
  const field = context.createLinearGradient(0, 0, width, height);
  field.addColorStop(0, '#0b3d91');
  field.addColorStop(1, '#f5a623');
  context.fillStyle = field;
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  context.fillRect(40, 60, 120, 30);
}, [320, 180]);
const circles = slide(2, (context, width, height) => {
  for (let index = 0; index < 40; index += 1) {
    context.fillStyle = `hsl(${Math.floor(next() * 360)}, 70%, 50%)`;
    context.beginPath();
    context.arc(next() * width, next() * height, 4 + next() * 24, 0, Math.PI * 2);
    context.fill();
  }
}, [640, 360]);
const diagonal = slide(3, (context, width, height) => {
  context.strokeStyle = '#222222';
  context.lineWidth = 1;
  for (let x = -height; x < width; x += 9) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x + height, height);
    context.stroke();
  }
}, [300, 420]);
const transparent = {
  page: 4,
  width: 320,
  height: 180,
  data: png(320, 180, (context) => {
    context.fillStyle = 'rgba(15, 30, 60, 0.5)';
    context.fillRect(20, 20, 200, 80);
    context.fillStyle = 'rgba(200, 40, 40, 0.25)';
    context.fillRect(120, 70, 180, 90);
  }),
};
const bigPage = slide(5, (context) => {
  fill(context, '#222222', 100, 100, 1500, 60);
  fill(context, '#1f7a55', 200, 800, 900, 400);
}, [2100, 2100]);
for (const format of ['pptx', 'docx', 'xlsx', 'pdf']) {
  await addBoth([gradient, circles, diagonal, transparent, bigPage], { format, pageCount: 5 });
  await addBoth([gradient, circles, transparent, diagonal, circles, gradient], { format });
}

// A page the decoder cannot read and a page with no data.
await addPages([{ page: 1, data: 'not an image' }], { format: 'docx' });
await addAesthetics([{ page: 1, data: 'not an image' }], 'pptx', {});
await addPages([{ page: 1 }, { page: 2, data: '' }, { pages: [1, 2], data: blank.data }], { format: 'docx' });

// Air.
const airCases = [];
const addAir = async (data) => airCases.push({ input: data, ...(await attempt(() => air.renderedAir(data))) });
const airPages = [
  flat[0], varied[1], varied[2], varied[3], sparse[2], quiet[0], beats[0], diagrams[0], gradient, circles, diagonal, transparent, blank, textPage(1, 0.88), textPage(2, 0.3), corner, full,
].map((image) => image.data);
for (const data of airPages) await addAir(data);
await addAir('not-an-image');
await addAir('');
await addAir(png(8, 8, (context) => fill(context, '#000000', 0, 0, 8, 8)));
await addAir(png(640, 360, (context, width, height) => {
  white(context, width, height);
  fill(context, '#111111', 40, 40, 200, 30);
}));
await addAir(png(640, 360, (context, width, height) => {
  fill(context, '#0f1b26', 0, 0, width, height);
  fill(context, '#f8fafc', 40, 40, 200, 30);
}));
await addAir(png(640, 360, (context, width, height) => {
  white(context, width, height);
  fill(context, '#111111', 40, 40, 200, 30);
  fill(context, '#0e7c86', 40, 120, 400, 200);
}));
await addAir(png(640, 360, (context, width, height) => {
  white(context, width, height);
  for (let y = 30; y < height - 30; y += 24) for (let x = 30; x < width - 30; x += 40) fill(context, (x + y) % 80 ? '#222222' : '#0e7c86', x, y, 28, 12);
}));

const airByPageCases = [];
const addAirByPage = async (images) => airByPageCases.push({
  input: images,
  ...(await attempt(async () => [...(await air.renderedAirByPage(images)).entries()])),
});
await addAirByPage([{ page: 1, data: airPages[0] }, { page: 2, pages: [2, 3], data: blank.data, pageImages: [{ page: 2, data: blank.data }, { page: 3, data: airPages[1] }] }]);
await addAirByPage([contact(1, [1, 2, 3]), contact(4, [4, 5, 6])]);
await addAirByPage([{ page: 1, data: 'junk' }, { page: 2, data: airPages[2] }, { pages: [3, 4], data: airPages[3] }, { page: 2, data: airPages[4] }]);
await addAirByPage([]);

// Visual diff.
const shades = (page, list) => ({
  page,
  data: png(list.length, 1, (context) => list.forEach((shade, index) => fill(context, `rgb(${shade}, ${shade}, ${shade})`, index, 0, 1, 1))),
});
const diffCases = [];
const decodedHash = async (data) => {
  const image = await loadImage(Buffer.from(data, 'base64'));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return createHash('sha256').update(Buffer.from(context.getImageData(0, 0, image.width, image.height).data)).digest('hex');
};
const addDiff = async (before, after) => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-rendered-diff-'));
  try {
    const result = await attempt(async () => {
      const compared = await visualDiff.compareRenderedPages(before, after, join(directory, 'review.pdf'));
      const images = [];
      for (const entry of compared.images) {
        images.push({ page: entry.page, name: entry.path.slice(directory.length + 1), width: entry.width, height: entry.height, mimeType: entry.mimeType, kind: entry.kind, pixelsSha256: await decodedHash(entry.data) });
      }
      return { available: compared.available, pages: compared.pages, changedPercent: compared.changedPercent, images };
    });
    diffCases.push({ input: { before, after }, ...result });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
await addDiff([shades(2, [0]), shades(1, [255, 255])], [shades(1, [232, 231])]);
await addDiff([shades(1, [0])], [shades(1, [0, 0])]);
await addDiff([], []);
await addDiff([], [{ page: 1, data: 'not an image' }]);
await addDiff([shades(1, [10, 20, 30, 40])], [shades(1, [10, 44, 53, 80])]);
await addDiff([shades(3, [0])], []);
await addDiff([], [shades(3, [200, 100])]);
await addDiff([shades(1, [0]), shades(1, [255])], [shades(1, [255])]);
await addDiff([gradient, circles, diagonal], [circles, gradient, diagonal]);
await addDiff([varied[1], varied[2], transparent], [varied[1], varied[3], gradient]);
await addDiff(flow.slice(0, 2), flow.slice(1, 3));

const golden = { pages: pageCases, aesthetics: aestheticCases, air: airCases, airByPage: airByPageCases, diff: diffCases };
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-rendered', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`golden.json: ${Object.entries(golden).map(([name, list]) => `${name} ${list.length}`).join(', ')}`);
