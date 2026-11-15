#!/usr/bin/env node
// Golden of the HTML deck measurement (crate mixdog-office-author: html_browser, measure_deck, geometry, icons): what
// Node's `runtime/office/authoring/pptx-html-measure.mjs` (`measureHtmlDeck`, puppeteer on the installed Chrome or
// Edge) answers for the HTML decks of the office suites (pptx-html.slow, pptx-html-geometry.slow,
// pptx-html-reauthor.slow) and for a few decks of its own (paint with no native form, a canvas named by `prepare`,
// the decks it refuses), and what `pptx-icons.mjs` answers for the icon names a script or a page gives it.
//
//   node benchmarks/rust-core/recorders/record-office-measure-deck.mjs --tree <product tree>
//
// Sections:
//   decks         per deck: the HTML, the canvas `prepare` names (or none) and the measure (canvas, slides, notes,
//                 geometry, and per slide shot its size and a thumbnail of 40 px block means) or the error message.
//                 These depend on the installed browser and its fonts: the replay that runs Rust against them is the
//                 ignored `twin_live_measure_deck`, on the machine that recorded them.
//   icons         `ICON(name)` and `ICON.svg(name, options)` for every name and for edge names, with the error text.
//   photographs   synthetic photographs of a decoration (PNG) and what `captureRichPaint` made of each: nothing, the
//                 whole picture, or the picture trimmed to what it painted with its place on the canvas (the same sharp
//                 calls as that function, which is private to its module). The pixels are recorded raw: the replay
//                 compares what its own encoder wrote, not the bytes.
// Writes native/core/fixtures/office-measure-deck/golden.json and the set's manifest.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-measure-deck.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-measure-deck');
const stage = stageSet(finalDir);

const requireFromTree = createRequire(join(tree, 'package.json'));
const sharp = requireFromTree('sharp');
const measure = await importFrom(tree, 'src/runtime/office/authoring/pptx-html-measure.mjs');
const icons = await importFrom(tree, 'src/runtime/office/authoring/pptx-icons.mjs');
const launch = await importFrom(tree, 'src/runtime/shared/browser-launch.mjs');
if (!launch.localBrowserAvailable()) throw new Error('no local Chrome or Edge: the decks cannot be measured');

const plain = (value) => JSON.parse(JSON.stringify(value));
const attempt = async (run) => {
  try {
    return { output: plain(await run()) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- decks: the HTML of the suites, read from their source ------------------------------------------------------------
const ARROW = '<path d="M10 20 H90 M74 6 L90 20 L74 34" stroke="#161A33" stroke-width="4" fill="none"/>';
const deckOf = (rel) => {
  const text = readFileSync(join(tree, 'src/runtime/office/authoring', rel), 'utf8');
  const match = /const DECK = `([\s\S]*?)`;/.exec(text);
  if (!match) throw new Error(`${rel}: no DECK`);
  return new Function('ARROW', `return \`${match[1]}\`;`)(ARROW);
};

const RICH = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
.slide { position: relative; width: 1920px; height: 1080px; background: #FFFFFF; font-family: 'Noto Sans KR', sans-serif; }
.abs { position: absolute; }
.grad { left: 96px; top: 120px; width: 420px; height: 180px; background: linear-gradient(90deg, #232A6B, #C2461A); color: #FFFFFF; font-size: 32px; padding: 24px; }
.clip { left: 600px; top: 120px; width: 300px; height: 180px; background: #E3E6F7; clip-path: polygon(0 0, 100% 20%, 80% 100%, 0 80%); }
.shadow { left: 1000px; top: 120px; width: 300px; height: 180px; background: #FFFFFF; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.25), 0 2px 4px rgba(0,0,0,0.4); }
.turn { left: 96px; top: 420px; width: 400px; height: 120px; background: #C9CEF2; transform: rotate(-6deg); font-size: 28px; padding: 20px; }
.pseudo { left: 600px; top: 420px; width: 300px; height: 120px; background: #F4F5F9; }
.pseudo::before { content: ''; position: absolute; left: -20px; top: -20px; width: 60px; height: 60px; border-radius: 50%; background: #C2461A; }
.dash { left: 1000px; top: 420px; width: 300px; height: 120px; border: 6px dashed #232A6B; }
.bleed { left: -60px; top: 700px; width: 400px; height: 200px; background: #232A6B; border-radius: 40px; }
.plain { left: 600px; top: 700px; width: 300px; height: 120px; background: #E3E6F7; font-size: 28px; padding: 16px; }
.note { left: 1000px; top: 700px; width: 600px; font-size: 26px; line-height: 1.4; color: #14181F; opacity: 0.8; }
</style></head><body>
<section class="slide">
  <div class="abs grad">Gradient with words</div>
  <div class="abs clip" data-alt="clipped band"></div>
  <div class="abs shadow"></div>
  <div class="abs turn">Turned box</div>
  <div class="abs pseudo"></div>
  <div class="abs dash"></div>
  <div class="abs bleed"></div>
  <div class="abs plain">Plain filled box</div>
  <p class="abs note">Words at 80% opacity that wrap onto a second line of the page.</p>
  <aside class="notes">Speaker note</aside>
</section>
</body></html>`;

const FRAME = `<!doctype html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
.slide { position: relative; width: 1280px; height: 720px; background: #F4F5F9; font-family: 'Noto Sans KR', sans-serif; }
.t { position: absolute; left: 80px; top: 80px; width: 600px; font-size: 40px; color: #14181F; }
</style></head><body><section class="slide"><p class="t">A sheet that is not the deck canvas</p></section></body></html>`;

const DECKS = [
  { name: 'html deck (pptx-html.slow)', html: deckOf('pptx-html.slow.test.mjs') },
  { name: 'geometry deck (pptx-html-geometry.slow)', html: deckOf('pptx-html-geometry.slow.test.mjs') },
  { name: 'reauthor deck (pptx-html-reauthor.slow)', html: deckOf('pptx-html-reauthor.slow.test.mjs') },
  { name: 'paint with no native form', html: RICH },
  { name: 'canvas named by prepare', html: FRAME, canvas: { width: 1280, height: 720, inchWidth: 13.333, inchHeight: 7.5 } },
  { name: 'slide of the wrong size', html: '<section class="slide" style="width:1280px;height:720px">x</section>' },
  { name: 'unknown icon', html: '<section class="slide" style="width:1920px;height:1080px"><i data-icon="arrow-rite" style="width:40px;height:40px"></i></section>' },
  { name: 'no slides', html: '<!doctype html><html><body><p>no sections</p></body></html>' },
];

// A shot of a page: its size and the mean of each 40 px block (r, g, b, a).
async function summary(path) {
  const { data, info } = await sharp(await readFile(path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const block = 40;
  const blocks = [];
  for (let by = 0; by < info.height; by += block) {
    for (let bx = 0; bx < info.width; bx += block) {
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let y = by; y < Math.min(by + block, info.height); y += 1) {
        for (let x = bx; x < Math.min(bx + block, info.width); x += 1) {
          const at = (y * info.width + x) * 4;
          for (let c = 0; c < 4; c += 1) sum[c] += data[at + c];
          n += 1;
        }
      }
      blocks.push(sum.map((v) => Math.round(v / n)));
    }
  }
  return { width: info.width, height: info.height, block, blocks };
}

const deckCases = [];
for (const deck of DECKS) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-measure-golden-'));
  try {
    const options = {
      sourcePath: join(dir, 'deck.html'),
      shotPath: (page) => join(dir, `page-${page}.png`),
      ...(deck.canvas ? { prepare: async () => deck.canvas } : {}),
    };
    const run = await attempt(async () => {
      const measured = await measure.measureHtmlDeck(deck.html, options);
      const shots = [];
      for (const shot of measured.shots) shots.push(await summary(shot));
      return { ...measured, shots };
    });
    deckCases.push({ name: deck.name, html: deck.html, canvas: deck.canvas ?? null, ...run });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- icons ---------------------------------------------------------------------------------------------------------------
const ICON = icons.iconGlobal();
const names = [...ICON.names];
const markupInputs = [
  ...names,
  'Arrow-Right',
  '  arrow-right  ',
  'ARROW_RIGHT',
  'arrow right',
  'arrow-rite',
  'chart',
  'check',
  'coin',
  'zzzz',
  'x',
  '',
  ' ',
  'a-b_c d',
];
const svgOptions = [
  undefined,
  { color: '1F7A4D' },
  { color: '#1F7A4D', size: 48, strokeWidth: 1.5 },
  { size: 24.5 },
  { strokeWidth: 0.75, color: 'ff00aa' },
];
const iconSection = {
  count: names.length,
  source: ICON.source,
  names,
  markup: [],
  svg: [],
};
for (const input of markupInputs) iconSection.markup.push({ input, ...(await attempt(() => ICON(input))) });
for (const name of ['arrow-right', 'check', 'Chart ', 'nothing-like-it']) {
  for (const options of svgOptions) iconSection.svg.push({ input: { name, options: options ?? null }, ...(await attempt(() => ICON.svg(name, options))) });
}
iconSection.viewBox = JSON.parse(readFileSync(join(tree, 'src/runtime/office/authoring/pptx-icons.json'), 'utf8')).viewBox;

// ---- photographs ---------------------------------------------------------------------------------------------------------
// What `captureRichPaint` (pptx-html-measure.mjs) did with each photograph: the same sharp calls.
const CAPTURE_SCALE = 2;
async function paintOf(shot, canvas) {
  const { channels } = await sharp(shot).stats();
  const alpha = channels[3];
  if (alpha && alpha.max === 0) return { kind: 'none' };
  if (!alpha || alpha.min === 255) return { kind: 'whole', draw: { x: 0, y: 0, w: canvas.width, h: canvas.height } };
  const { data, info } = await sharp(shot).trim({ threshold: 0 }).png().toBuffer({ resolveWithObject: true });
  const left = -(info.trimOffsetLeft || 0);
  const top = -(info.trimOffsetTop || 0);
  const rgba = await sharp(data).ensureAlpha().raw().toBuffer();
  return {
    kind: 'trimmed',
    draw: { x: left / CAPTURE_SCALE, y: top / CAPTURE_SCALE, w: info.width / CAPTURE_SCALE, h: info.height / CAPTURE_SCALE },
    width: info.width,
    height: info.height,
    rgba: rgba.toString('base64'),
  };
}
const rawPng = (width, height, channels, pixel) => {
  const buffer = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) buffer.set(pixel(x, y), (y * width + x) * channels);
  return sharp(buffer, { raw: { width, height, channels } }).png().toBuffer();
};
const canvas = { width: 40, height: 30 };
const [W, H] = [canvas.width * CAPTURE_SCALE, canvas.height * CAPTURE_SCALE];
const inside = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
const photographInputs = [
  ['nothing painted', await rawPng(W, H, 4, () => [0, 0, 0, 0])],
  ['covering the page, opaque RGBA', await rawPng(W, H, 4, () => [10, 20, 30, 255])],
  ['covering the page, RGB', await rawPng(W, H, 3, (x) => [x * 3, 40, 90])],
  ['a block in the middle', await rawPng(W, H, 4, (x, y) => (inside(x, y, 20, 16, 52, 40) ? [200, 10, 10, 255] : [0, 0, 0, 0]))],
  ['a block with a soft shadow', await rawPng(W, H, 4, (x, y) => (inside(x, y, 20, 16, 52, 40) ? [30, 30, 120, 255] : inside(x, y, 14, 12, 60, 50) ? [0, 0, 0, 70] : [0, 0, 0, 0]))],
  ['a small block', await rawPng(W, H, 4, (x, y) => (inside(x, y, 7, 11, 11, 15) ? [255, 255, 255, 255] : [0, 0, 0, 0]))],
  ['a block in the corner', await rawPng(W, H, 4, (x, y) => (inside(x, y, 0, 0, 10, 6) ? [1, 2, 3, 128] : [0, 0, 0, 0]))],
  ['a band across the page', await rawPng(W, H, 4, (x, y) => (inside(x, y, 0, 20, W, 30) ? [90, 90, 90, 200] : [0, 0, 0, 0]))],
  ['an almost opaque page', await rawPng(W, H, 4, (x, y) => [50, 60, 70, x === 3 && y === 3 ? 254 : 255])],
];
const photographs = [];
for (const [name, png] of photographInputs) photographs.push({ name, canvas, png: png.toString('base64'), output: await paintOf(png, canvas) });

const golden = {
  note: 'Recorded from the Node HTML deck measurement (pptx-html-measure.mjs, pptx-icons.mjs); tests/twin_measure_deck.rs replays the icons and the photographs, and twin_live_measure_deck runs the decks against the installed browser.',
  decks: deckCases,
  icons: iconSection,
  photographs,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-measure-deck', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
const failed = deckCases.filter((deck) => deck.error).map((deck) => deck.name);
console.log(`golden.json: decks ${deckCases.length} (${failed.length} refused: ${failed.join(', ')}), icons ${markupInputs.length}, photographs ${photographs.length}`);
