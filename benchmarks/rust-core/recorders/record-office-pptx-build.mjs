#!/usr/bin/env node
// Golden of the HTML deck builder and runner (crate mixdog-office-author: pptx_build, pptx_html_runner): what Node's
// `runtime/office/authoring/pptx-html-build.mjs` (`buildPptxFromMeasure`, `textPlacement`, `coverOffset`) and
// `pptx-html-runner.mjs` (`runPptxHtmlAuthoring`, `measureHtmlDrift`, `writeHtmlComparisons`) answer.
//
//   node benchmarks/rust-core/recorders/record-office-pptx-build.mjs --tree <product tree>
//
// Sections:
//   placements   `textPlacement(item, canvasWidth)` for text items of every kind (single and multi line, framed and not,
//                chips, discs, bands, Malgun Gothic, tight and loose spacing, wide boxes at the page edge) and
//                `coverOffset` for object-position strings.
//   builds       per measure: the measure (JSON, as `measure_deck` hands it over) and the package `buildPptxFromMeasure`
//                wrote, normalised by `normalizeAuthoredPptx`, part by part (an XML or relationships part as text,
//                anything else as base64); or the error it threw. The measures hold every item kind: rectangles with
//                strokes, radii, rotation and shadows, lines cut at the page edge, text, tables, charts of every spec
//                option, SVG drawings, pictures (cover at a position, contain, fill, rounded, transparent, cut at the
//                edge), captured decorations, and a sheet of its own size.
//   runs         the HTML decks of pptx-html.slow and pptx-html-reauthor.slow, and the refusals, run through
//                `runPptxHtmlAuthoring` in the installed browser: the HTML, the measure Node read from it, the result
//                (paths and times left out) and the package. The browser and its fonts belong to the machine that
//                recorded them: the offline replay builds from the recorded measure; the ignored `twin_live_pptx_build`
//                runs Rust against the browser.
//   drift        `measureHtmlDrift` and `writeHtmlComparisons` over synthetic pages (PNG) with items moved by known amounts.
// Writes native/core/fixtures/office-pptx-build/golden.json and the set's manifest.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-pptx-build.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-pptx-build');
const stage = stageSet(finalDir);

const need = createRequire(join(tree, 'package.json'));
const JSZip = need('jszip');
const sharp = need('sharp');
const build = await importFrom(tree, 'src/runtime/office/authoring/pptx-html-build.mjs');
const runner = await importFrom(tree, 'src/runtime/office/authoring/pptx-html-runner.mjs');
const measureModule = await importFrom(tree, 'src/runtime/office/authoring/pptx-html-measure.mjs');
const { normalizeAuthoredPptx } = await importFrom(tree, 'src/runtime/office/authoring/pptx-script-normalize.mjs');
const launch = await importFrom(tree, 'src/runtime/shared/browser-launch.mjs');
if (!launch.localBrowserAvailable()) throw new Error('no local Chrome or Edge: the HTML decks cannot be run');

const scratch = mkdtempSync(join(tmpdir(), 'mixdog-pptx-build-rec-'));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const blobs = {};
const blobOf = (name, bytes) => {
  const textual = /\.(xml|rels)$/.test(name);
  const body = textual ? { text: bytes.toString('utf8') } : { base64: bytes.toString('base64') };
  const id = sha(JSON.stringify(body));
  blobs[id] = body;
  return id;
};
const pngBlob = (bytes) => {
  const body = { base64: bytes.toString('base64') };
  const id = sha(JSON.stringify(body));
  blobs[id] = body;
  return id;
};
const quiet = async (work) => {
  const { warn, error, log } = console;
  console.warn = console.error = console.log = () => {};
  try {
    return await work();
  } finally {
    Object.assign(console, { warn, error, log });
  }
};
const message = (error) => String(error?.message ?? error);

async function partsOf(path) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const parts = [];
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) parts.push({ name, dir: true });
    else parts.push({ name, blob: blobOf(name, Buffer.from(await entry.async('uint8array'))) });
  }
  return parts;
}

// ---- pictures the cases draw with --------------------------------------------------------------------------------------
const quadrants = (width, height) => {
  const raw = Buffer.alloc(width * height * 4);
  const colours = [[220, 40, 40], [40, 200, 60], [40, 60, 220], [230, 220, 30]];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colours[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
      raw.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
};
const solid = (width, height, [r, g, b, a = 255]) =>
  sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha: a / 255 } } }).png().toBuffer();
const dataUri = (png) => `data:image/png;base64,${png.toString('base64')}`;
const quads = await quadrants(60, 30);
const tall = await quadrants(20, 40);

// ---- measure items ----------------------------------------------------------------------------------------------------
const ink = { hex: '14181F', a: 1 };
const style = (size, extra = {}) => ({ font: 'Noto Sans KR', size, bold: false, italic: false, color: ink, ls: 0, hl: null, ...extra });
const disc = {
  kind: 'text',
  box: { x: 700, y: 380, w: 44, h: 44 },
  inset: { l: 0, r: 0, t: 0, b: 0 },
  frame: { kind: 'rect', box: { x: 700, y: 380, w: 44, h: 44 }, fill: { hex: 'FF6B3D', a: 1 }, radius: 22, stroke: null, shadow: null },
  align: 'center',
  lineHeight: 24,
  fontSize: 24,
  inkW: 14,
  lines: [{ top: 384, bottom: 419, width: 14, runs: [{ text: '2', style: style(24, { bold: true }) }] }],
};
const paragraph = {
  kind: 'text',
  box: { x: 96, y: 600, w: 560, h: 84 },
  inset: { l: 0, r: 0, t: 0, b: 0 },
  frame: null,
  align: 'left',
  lineHeight: 42,
  fontSize: 28,
  inkW: 540,
  lines: [
    { top: 604, bottom: 644, width: 540, runs: [{ text: '하네스만 바꿔 다시 돌렸다.', style: style(28) }] },
    {
      top: 646,
      bottom: 686,
      width: 300,
      runs: [
        { text: '결과는 같고 ', style: style(28) },
        { text: '비용은 줄었다', style: style(28, { hl: 'FFD9CC' }) },
      ],
    },
  ],
};
const band = {
  ...disc,
  box: { x: 96, y: 840, w: 1728, h: 104 },
  inset: { l: 40, r: 40, t: 30, b: 30 },
  frame: { ...disc.frame, box: { x: 96, y: 840, w: 1728, h: 104 }, radius: 16 },
  align: 'left',
  lineHeight: 43.5,
  fontSize: 30,
  inkW: 1100,
  lines: [{ top: 866, bottom: 910, width: 1100, runs: [{ text: '제약 고객의 이탈 시간이 가장 짧다.', style: style(30) }] }],
};
const pill = { ...band, box: { ...band.box, w: 1180 } };
const loose = { ...paragraph, box: { ...paragraph.box, y: 596, h: 94 } };
const malgun = {
  ...paragraph,
  lines: paragraph.lines.map((line) => ({ ...line, runs: line.runs.map((run) => ({ ...run, style: { ...run.style, font: 'Malgun Gothic' } })) })),
};
const tight = { ...paragraph, lineHeight: 26, lines: paragraph.lines };
const wideRight = {
  ...paragraph,
  box: { x: 1500, y: 100, w: 400, h: 60 },
  align: 'right',
  lineHeight: 36,
  fontSize: 30,
  inkW: 560,
  lines: [{ top: 104, bottom: 150, width: 560, runs: [{ text: '오른쪽 끝을 넘는 한 줄', style: style(30) }] }],
};
const wideCentre = { ...wideRight, align: 'center', box: { x: 40, y: 100, w: 300, h: 60 } };
const stamp = {
  ...paragraph,
  box: { x: 200, y: 300, w: 400, h: 200 },
  inset: { l: 20, r: 20, t: 40, b: 40 },
  frame: { kind: 'rect', box: { x: 200, y: 300, w: 400, h: 200 }, fill: { hex: '0F3B3A', a: 1 }, radius: 24, stroke: { hex: 'FFFFFF', a: 1, w: 4 }, shadow: null },
  align: 'center',
  lineHeight: 60,
  fontSize: 40,
  inkW: 300,
  lines: [
    { top: 360, bottom: 420, width: 300, runs: [{ text: '가운데 두 줄', style: style(40) }] },
    { top: 420, bottom: 480, width: 200, runs: [{ text: '맞춘 도장', style: style(40) }] },
  ],
};
const framedTop = { ...band, box: { x: 96, y: 100, w: 600, h: 200 }, frame: { ...band.frame, box: { x: 96, y: 100, w: 600, h: 200 }, stroke: { hex: '14181F', a: 1, w: 2 } }, align: 'left', inkW: 300, inset: { l: 30, r: 30, t: 20, b: 20 }, lines: [{ top: 126, bottom: 170, width: 300, runs: [{ text: '위에 붙은 틀', style: style(30) }] }] };
const placements = [
  ['disc', disc], ['paragraph', paragraph], ['band', band], ['pill', pill], ['loose', loose], ['malgun', malgun], ['tight', tight],
  ['wide right', wideRight], ['wide centre', wideCentre], ['stamp', stamp], ['framed top', framedTop],
];
const coverPositions = [['27% 50%', 1000, 200, 2], ['-40px 0px', 1000, 200, 2], ['', 1000, 200, 2], ['0% 100%', 80, 40, 2], ['120% -10%', 80, 40, 2], ['left', 80, 40, 2], ['12.5px 3px', 80, 40, 2], [undefined, 10, 10, 2], ['  50%   25% ', 100, 60, 2]];

// ---- the builds -------------------------------------------------------------------------------------------------------
const cell = (text, y, extra = {}) => ({
  text,
  box: { x: 96, y, w: 400, h: 60 },
  font: 'Noto Sans KR',
  size: 28,
  bold: false,
  color: ink,
  fill: { hex: 'FFFFFF', a: 1 },
  align: 'left',
  pad: { t: 10, r: 10, b: 10, l: 10 },
  border: { t: null, r: null, b: { w: 1, c: 'C9CDD4' }, l: null },
  span: 1,
  ...extra,
});
const mainItems = [
  { kind: 'rect', box: { x: 96, y: 200, w: 800, h: 300 }, fill: { hex: 'FFFFFF', a: 1 }, radius: 16, stroke: { hex: '14181F', a: 1, w: 2 }, shadow: { color: ink, x: 12, y: 12, blur: 0 } },
  disc,
  paragraph,
  { kind: 'table', box: { x: 96, y: 720, w: 400, h: 180 }, rows: [[cell('a', 720)], [cell('b', 780)], [cell('c', 840)]] },
];
const bandSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="260" viewBox="0 0 2000 260"><polygon points="0,202 2000,0 2000,57 0,260" fill="#C9CEF2"/></svg>';
const ringSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="none" stroke="#123456" stroke-width="6"/></svg>';
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="10" y="10" width="80" height="80" fill="#B33A3A"/></svg>';
const chartBox = { x: 96, y: 500, w: 1728, h: 420 };
const chart = (spec, extra = {}) => ({ kind: 'chart', box: chartBox, spec, ...extra });
const colA = { labels: ['a', 'b'], values: [1, 2] };
const wrap = (items, extra = {}) => ({ width: 1920, height: 1080, slides: [{ bg: null, items }], ...extra });

const capturePaint = await solid(8, 8, [20, 40, 60]);
const halfPaint = await sharp({
  create: { width: 20, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
}).composite([{ input: await solid(8, 10, [200, 30, 30]), left: 0, top: 0 }]).png().toBuffer();

const cases = [
  ['main deck: stroke, disc, soft breaks, hard shadow, table, notes, background', { width: 1920, height: 1080, slides: [{ bg: { hex: 'F4F5F7', a: 1 }, notes: 'speaker note', items: mainItems }] }],
  ['two slides, a framed band and a pill, a stamp', { width: 1920, height: 1080, slides: [{ bg: { hex: 'FFFFFF', a: 1 }, items: [band, stamp] }, { bg: null, notes: '둘째 노트', items: [pill, framedTop, wideRight] }] }],
  ['rectangles: plain at the edge, rounded, rotated, translucent, ellipse', wrap([
    { kind: 'rect', box: { x: 1800, y: -20, w: 200, h: 100 }, fill: { hex: 'FF7A45', a: 1 }, radius: 0, stroke: null, shadow: null },
    { kind: 'rect', box: { x: 100, y: 100, w: 200, h: 100 }, fill: { hex: '224466', a: 0.5 }, radius: 12, stroke: null, shadow: { color: { hex: '000000', a: 0.4 }, x: 4, y: 8, blur: 12 } },
    { kind: 'rect', box: { x: 400, y: 100, w: 100, h: 100 }, fill: { hex: '88AA22', a: 1 }, radius: 50, stroke: { hex: '112200', a: 1, w: 4 }, shadow: null },
    { kind: 'rect', box: { x: 600, y: 100, w: 300, h: 60 }, fill: null, radius: 0, stroke: { hex: 'AA2222', a: 1, w: 3 }, shadow: null, rotate: 12.345 },
    { kind: 'rect', box: { x: -50, y: 800, w: 300, h: 100 }, fill: { hex: '445566', a: 1 }, radius: 20, stroke: null, shadow: null },
    { kind: 'rect', box: { x: 5000, y: 5000, w: 10, h: 10 }, fill: { hex: '000000', a: 1 }, radius: 0, stroke: null, shadow: null },
  ])],
  ['lines: level, upright, cut at the page edge, too short', wrap([
    { kind: 'line', seg: [-10, 900, 1950, 900], color: { hex: '161A33', a: 1 }, w: 2 },
    { kind: 'line', seg: [300, -50, 300, 500], color: { hex: 'AA3322', a: 0.5 }, w: 1.5 },
    { kind: 'line', seg: [10, 10, 10.2, 10.2], color: { hex: '000000', a: 1 }, w: 1 },
  ])],
  ['SVG band past the page, a ring and a tile (motif naming)', wrap([
    { kind: 'svg', box: { x: -40, y: 430, w: 2000, h: 260 }, markup: bandSvg, alt: 'band', alpha: 1 },
    { kind: 'svg', box: { x: 100, y: 100, w: 100, h: 100 }, markup: ringSvg, alt: 'ring', alpha: 1 },
    { kind: 'svg', box: { x: 300, y: 100, w: 100, h: 100 }, markup: tileSvg, alt: '', alpha: 0.6 },
  ])],
  ['charts: column with a pinned plot and no category axis', wrap([chart({ type: 'col', ...colA, plot: { x: 0, y: 0.1, w: 1, h: 0.8 }, categoryAxis: false })])],
  ['charts: the element font, the fallback and the spec font', wrap([chart({ type: 'col', labels: ['a'], values: [1] }, { font: 'Georgia' }), chart({ type: 'col', labels: ['a'], values: [1], font: 'Arial' })])],
  ['charts: horizontal bars, stacked series, legend and colours', wrap([chart({ type: 'bar', labels: ['x', 'y', 'z'], series: [{ name: 'S1', values: [1, 2, 3] }, { name: 'S2', values: [3, 2, 1] }], stacked: true, legend: true, legendPos: 'r', colors: ['1A73E8', 'E8710A'], valueAxis: true, min: 0, max: 5, grid: 'DADCE0', format: '0.0', gap: 30, axisLine: true, labelColor: '5F6368', size: 14 })])],
  ['charts: line with markers off, area, pie and doughnut', wrap([
    chart({ type: 'line', labels: ['q1', 'q2', 'q3'], values: [3, 1, 2], markers: false, lineSize: 5, name: 'Revenue', showValues: false }),
    chart({ type: 'area', labels: ['q1', 'q2', 'q3'], values: [3, 1, 2], unit: '%' }),
    chart({ type: 'pie', labels: ['red', 'blue'], values: [60, 40], colors: ['C0392B', '2980B9'], labelPosition: 'ctr' }),
    chart({ type: 'doughnut', labels: ['red', 'blue'], values: [60, 40], hole: 40 }),
  ])],
  ['charts: an unknown type, a null value and a numeric label', wrap([chart({ type: 'waterfall', labels: [1, 'b', 3], values: [1, null, 3], labelPosition: 'inEnd', stacked: true })])],
  ['charts: a spec that fails the writer', wrap([chart({ type: 'bar', labels: ['a', 'b'] })])],
  ['pictures: cover at a position, contain, fill, rounded, translucent, cut at the edge', wrap([
    { kind: 'image', box: { x: 100, y: 100, w: 300, h: 100 }, src: dataUri(quads), fit: 'cover', position: '27% 50%', alt: 'cover', alpha: 1 },
    { kind: 'image', box: { x: 500, y: 100, w: 300, h: 100 }, src: dataUri(quads), fit: 'contain', position: '50% 50%', radius: 0, alpha: 1 },
    { kind: 'image', box: { x: 900, y: 100, w: 200, h: 100 }, src: dataUri(tall), fit: 'fill', radius: 20, alpha: 0.5 },
    { kind: 'image', box: { x: -100, y: 400, w: 400, h: 200 }, src: dataUri(quads), fit: 'cover', position: '-40px 0px', alt: '', alpha: 1 },
    { kind: 'image', box: { x: 1700, y: 900, w: 400, h: 300 }, src: dataUri(tall), position: '50% 0%', radius: 30, alpha: 1 },
    { kind: 'image', box: { x: 3000, y: 100, w: 100, h: 100 }, src: dataUri(quads), fit: 'cover', alpha: 1 },
  ])],
  ['a picture that is not local is refused', wrap([{ kind: 'image', box: { x: 0, y: 0, w: 10, h: 10 }, src: 'https://example.com/a.png', alpha: 1 }])],
  ['captures: the page background, an underlay and a drawing named a motif', {
    width: 1920,
    height: 1080,
    slides: [
      { bg: { hex: 'FFFFFF', a: 1 }, items: [{ kind: 'capture', png: capturePaint.toString('base64'), draw: { x: 0, y: 0, w: 4, h: 4 }, slide: true, underlay: { box: { x: 0, y: 0, w: 4, h: 4 }, radius: 0, rotate: 0 }, alt: '' }] },
      { bg: null, items: [{ kind: 'capture', png: halfPaint.toString('base64'), draw: { x: 100, y: 100, w: 20, h: 10 }, underlay: null, alt: 'half' }] },
    ],
  }],
  ['text: rotated frame, chip and a Malgun table cell with a span', wrap([
    { ...pill, rotate: 5.4321 },
    { kind: 'table', box: { x: 96, y: 300, w: 800, h: 120 }, rows: [[cell('가', 300, { font: 'Malgun Gothic', span: 2, bold: true, fill: null, align: 'center' }), cell('나', 300)], [cell('다', 360), cell('라', 360, { border: { t: { w: 2, c: '112233' }, r: { w: 1, c: '445566' }, b: null, l: null } })]] },
  ])],
  ['a sheet of its own size', { width: 794, height: 1123, inchWidth: 8.27, inchHeight: 11.69, slides: [{ bg: { hex: 'FAFAFA', a: 1 }, items: [{ ...paragraph, box: { x: 60, y: 100, w: 600, h: 84 } }] }] }],
  ['a deck with no slides', { width: 1920, height: 1080, slides: [] }],
];

async function recordBuild(name, measure) {
  const input = clone(measure);
  const output = join(scratch, `${sha(name)}.pptx`);
  const record = { name, measure: input };
  try {
    await quiet(() => build.buildPptxFromMeasure(clone(measure), output));
  } catch (error) {
    record.thrown = message(error);
    return record;
  }
  record.normalized = await quiet(() => normalizeAuthoredPptx(output));
  record.parts = await partsOf(output);
  return record;
}

const recordedBuilds = [];
for (const [name, measure] of cases) recordedBuilds.push(await recordBuild(name, measure));

// ---- the HTML decks run in the browser --------------------------------------------------------------------------------
const deckOf = (rel) => {
  const text = readFileSync(join(tree, 'src/runtime/office/authoring', rel), 'utf8');
  const match = /const DECK = `([\s\S]*?)`;/.exec(text);
  if (!match) throw new Error(`${rel}: no DECK`);
  return match[1];
};
const htmlDecks = [
  ['pptx-html.slow deck', deckOf('pptx-html.slow.test.mjs')],
  ['pptx-html-reauthor.slow deck', deckOf('pptx-html-reauthor.slow.test.mjs')],
  ['a page that is not 1920x1080', '<section class="slide" style="width:1280px;height:720px">x</section>'],
  ['no section.slide', '<div>nothing</div>'],
];
const plain = (value) => JSON.parse(JSON.stringify(value));
const recordedRuns = [];
for (const [name, html] of htmlDecks) {
  const dir = mkdtempSync(join(scratch, 'run-'));
  const target = join(dir, 'deck.pptx');
  const staged = join(dir, 'staged.pptx');
  const record = { name, html };
  if (runner.hasSlideSections(html)) {
    try {
      const measure = await quiet(() => measureModule.measureHtmlDeck(html, { sourcePath: join(dir, 'measure.html'), shotPath: (page) => join(dir, `measure-${page}.png`) }));
      const { shots, ...rest } = measure;
      record.measure = plain(rest);
    } catch (error) {
      record.measureError = message(error);
    }
    const run = await quiet(() => runner.runPptxHtmlAuthoring(html, staged, { target }));
    const { output, bytes, htmlShots, htmlSource, elapsedMs, ...result } = plain(run);
    record.result = result;
    record.shots = (htmlShots ?? []).length;
    record.sourceName = htmlSource ? htmlSource.slice(target.length) : null;
    if (run.ok) record.parts = await partsOf(staged);
  } else {
    try {
      await quiet(() => runner.runPptxHtmlAuthoring(html, staged, { target }));
      record.thrown = null;
    } catch (error) {
      record.thrown = message(error);
    }
  }
  recordedRuns.push(record);
}

// ---- drift and comparisons ---------------------------------------------------------------------------------------------
const WIDTH = 1920;
const HEIGHT = 1080;
const page = (blocks, background = [255, 255, 255]) => {
  const raw = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) raw.set(background, i * 3);
  for (const { x, y, w, h, colour } of blocks) {
    for (let row = y; row < y + h; row += 1) for (let col = x; col < x + w; col += 1) raw.set(colour, (row * WIDTH + col) * 3);
  }
  return sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).png().toBuffer();
};
const BLACK = [0, 0, 0];
const NAVY = [15, 31, 63];
const driftPages = [
  // 1: a left text 10 px low, a centred text 6 px right, a right text 4 px left, a box moved and a box resized.
  [[
    { x: 100, y: 100, w: 300, h: 40, colour: BLACK },
    { x: 800, y: 300, w: 200, h: 40, colour: BLACK },
    { x: 1500, y: 500, w: 240, h: 40, colour: BLACK },
    { x: 200, y: 700, w: 100, h: 100, colour: NAVY },
    { x: 600, y: 700, w: 100, h: 100, colour: NAVY },
  ], [
    { x: 100, y: 110, w: 300, h: 40, colour: BLACK },
    { x: 806, y: 300, w: 200, h: 40, colour: BLACK },
    { x: 1496, y: 500, w: 240, h: 40, colour: BLACK },
    { x: 215, y: 712, w: 100, h: 100, colour: NAVY },
    { x: 590, y: 700, w: 120, h: 100, colour: NAVY },
  ]],
  // 2: nothing moved.
  [[{ x: 100, y: 100, w: 300, h: 40, colour: BLACK }], [{ x: 100, y: 100, w: 300, h: 40, colour: BLACK }]],
  // 3: a text that has vanished from the render, a surround that is not one colour.
  [[{ x: 100, y: 100, w: 300, h: 40, colour: BLACK }], []],
];
const driftTargets = [
  [
    { text: 'left', align: 'left', x: 100, y: 100, w: 300, h: 40, pad: 3, ink: '000000' },
    { text: 'centre', align: 'center', x: 800, y: 300, w: 200, h: 40, pad: 3, ink: '000000' },
    { text: 'right', align: 'right', x: 1500, y: 500, w: 240, h: 40, pad: 3, ink: '000000' },
    { text: 'box moved', align: 'box', x: 200, y: 700, w: 100, h: 100, pad: 20, ink: '0F1F3F' },
    { text: 'box grown', align: 'box', x: 600, y: 700, w: 100, h: 100, pad: 20, ink: null },
  ],
  [{ text: 'same', align: 'left', x: 100, y: 100, w: 300, h: 40, pad: 3 }],
  [{ text: 'gone', align: 'left', x: 100, y: 100, w: 300, h: 40, pad: 3, ink: '000000' }],
];
const driftDir = mkdtempSync(join(scratch, 'drift-'));
const htmlShotFiles = [];
const renderedFiles = [];
const images = {};
for (let index = 0; index < driftPages.length; index += 1) {
  const [html, render] = driftPages[index];
  const htmlPath = join(driftDir, `html-${index + 1}.png`);
  const renderPath = join(driftDir, `render-${index + 1}.png`);
  const htmlPng = await page(html);
  const renderPng = await page(render);
  writeFileSync(htmlPath, htmlPng);
  writeFileSync(renderPath, renderPng);
  htmlShotFiles.push(htmlPath);
  renderedFiles.push(renderPath);
  images[`html-${index + 1}`] = pngBlob(htmlPng);
  images[`render-${index + 1}`] = pngBlob(renderPng);
}
const rendered = [
  { page: 1, path: renderedFiles[0] },
  { page: 2, path: renderedFiles[1] },
  { page: 3, path: renderedFiles[2] },
  { page: 4, pages: [4, 5], path: renderedFiles[0] },
  { page: 6, path: null },
];
const driftResult = await quiet(() => runner.measureHtmlDrift(htmlShotFiles, driftTargets, rendered));
const looser = await quiet(() => runner.measureHtmlDrift(htmlShotFiles, driftTargets, rendered, 12));
const writtenDir = join(driftDir, 'out');
mkdirSync(writtenDir, { recursive: true });
const comparisons = await quiet(() => runner.writeHtmlComparisons(join(writtenDir, 'deck.pptx'), htmlShotFiles, rendered));
const comparisonFiles = {};
for (const pair of comparisons) comparisonFiles[pair.page] = pngBlob(readFileSync(pair.path));

const golden = {
  note: 'Recorded from src/runtime/office/authoring/pptx-html-build.mjs and pptx-html-runner.mjs (Node, pptxgenjs 4.0.1, sharp); tests/twin_pptx_build.rs replays the placements, the builds and the offline half of the runs and the drift reads against the Rust port.',
  pptxgenjs: JSON.parse(readFileSync(join(tree, 'node_modules', 'pptxgenjs', 'package.json'), 'utf8')).version,
  blobs,
  placements: {
    text: placements.map(([name, item]) => ({ name, item, canvasWidth: 1920, output: plain(build.textPlacement(clone(item), 1920)) })),
    cover: coverPositions.map(([position, x, y, scale]) => ({ position: position ?? null, overflowX: x, overflowY: y, scale, output: build.coverOffset(position, x, y, scale) })),
  },
  builds: recordedBuilds,
  runs: recordedRuns,
  drift: {
    images,
    targets: driftTargets,
    rendered: rendered.map((entry) => ({ ...entry, path: entry.path ? `render-${renderedFiles.indexOf(entry.path) + 1}` : null })),
    result: driftResult,
    looser,
    comparisons: comparisons.map((pair) => ({ page: pair.page, png: comparisonFiles[pair.page] })),
  },
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-pptx-build', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
rmSync(scratch, { recursive: true, force: true });
console.log(`golden.json: ${recordedBuilds.length} builds, ${recordedRuns.length} runs, ${golden.placements.text.length} placements, ${Object.keys(blobs).length} blobs; ${readdirSync(finalDir).length} files`);
