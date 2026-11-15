#!/usr/bin/env node
// Golden of the Excel HTML route's build half (crate mixdog-office-author: xlsx_build, xlsx_html_runner): what Node's
// `runtime/office/authoring/xlsx-html-build.mjs` (`buildXlsxFromSheets`) writes for the sheets of `xlsx-html-measure.mjs`.
//
//   node benchmarks/rust-core/recorders/record-office-xlsx-build.mjs --tree <product tree>
//
// Sections:
//   builds   per measure: the measure (JSON, as `measure_xlsx` hands it over), the title, the pictures the photographed
//            elements were saved as, and the package `buildXlsxFromSheets` wrote, part by part (an XML or relationships part
//            as text, anything else as base64), with the notes it returned; or the error it threw. The measures are the two
//            workbooks of the Excel suite (`office-xlsx-html.slow`: the report and the features sheet, read back from the
//            office-measure-docs recording, so the browser of that recording is the browser of these measures), the values
//            table of that suite, and measures of their own for what the grid draws: boxes and rules, a named table and its
//            print titles, charts over their own data and over table cells, pictures, notes, hidden and frozen sheets and the
//            refusal of a workbook with no sheet.
//   runs     per HTML document of `office-xlsx-html.slow`: what `runXlsxHtmlAuthoring` answered in the installed browser
//            (paths and times left out), the HTML source it kept and its package. Written only with `--browser`: the
//            offline replay builds from the recorded measures, the ignored `twin_live_xlsx_build` runs Rust against the
//            browser. Without `--browser` the section is empty.
// Writes native/core/fixtures/office-xlsx-build/golden.json and the set's manifest.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-xlsx-build.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-xlsx-build');
const stage = stageSet(finalDir);

const need = createRequire(join(tree, 'package.json'));
const JSZip = need('jszip');
const sharp = need('sharp');
const build = await importFrom(tree, 'src/runtime/office/authoring/xlsx-html-build.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'mixdog-xlsx-build-rec-'));
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const blobs = {};
const blobOf = (name, bytes) => {
  const textual = /\.(xml|rels|vml)$/.test(name);
  // The two timestamps of docProps/core.xml are the moment of writing: recorded as a mask, so the recording is the same each time.
  const body = textual ? { text: bytes.toString('utf8').replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*/g, '$1@TIME@') } : { base64: bytes.toString('base64') };
  const id = sha(JSON.stringify(body));
  blobs[id] = body;
  return id;
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

// ---- pictures ----------------------------------------------------------------------------------------------------------
const quadrants = (width, height) => {
  const raw = Buffer.alloc(width * height * 4);
  const colours = [[220, 40, 40], [40, 200, 60], [40, 60, 220], [230, 220, 30]];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colours[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
      raw.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } });
};
const photo = await quadrants(40, 20).png().toBuffer();

// ---- measures ----------------------------------------------------------------------------------------------------------
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
const face = { font: 'Malgun Gothic', size: 9, bold: false, italic: false, color: '374151', align: 'left', lines: 1, indent: 0 };
const text = (value, at, extra = {}) => ({ rect: at, text: value, ...face, ...extra });
const cell = (value, at, extra = {}) => ({ rect: at, text: value, ...face, header: false, ...extra });
const sheet = (name, extra = {}) => ({ name, width: 600, height: 300, padRight: 0, padBottom: 0, gridlines: false, freeze: '', fit: '', orientation: '', hidden: false, texts: [], boxes: [], tables: [], charts: [], pictures: [], font: 'Malgun Gothic', ...extra });
const measureOf = (sheets, extra = {}) => ({ sheets, notes: [], captures: 0, ...extra });

const documents = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'office-measure-docs', 'golden.json'), 'utf8')).xlsx;
const valueCases = [
  ['007', '007'],
  ['1,2', '1,2'],
  ['1 2', '1 2'],
  ['1e3', '1e3'],
  ['184,200', '184200'],
  ['+12.0%', '+12.0%'],
  ['2026-09-30', '2026-09-30'],
  ['−5', '−5'],
  ['1234', '1234'],
  ['12.50', '12.50'],
  ['15%', '15%'],
];

const cases = [
  ...documents.map((entry) => ({ name: `suite: ${entry.name}`, measure: entry.output.measure, title: 'Suite', captures: [1] })),
  {
    name: 'table values: figures typed, identifiers kept',
    title: 'Values',
    measure: measureOf([
      sheet('Data', {
        tables: [
          {
            name: '',
            style: '',
            freezeHeader: false,
            rect: rect(0, 0, 400, 24 * (valueCases.length + 1)),
            rows: [
              [cell('Text', rect(0, 0, 200, 24), { header: true, bold: true }), cell('Explicit value', rect(200, 0, 400, 24), { header: true, bold: true })],
              ...valueCases.map(([shown, source], index) => [cell(shown, rect(0, 24 * (index + 1), 200, 24 * (index + 2))), cell('shown', rect(200, 24 * (index + 1), 400, 24 * (index + 2)), { value: source })]),
            ],
          },
        ],
      }),
    ]),
  },
  {
    name: 'boxes, rules, notes, formats and a wrapped text',
    title: 'Boxes',
    measure: measureOf([
      sheet('Cards', {
        boxes: [
          { rect: rect(10, 10, 230, 120), fill: 'EEF4F1', borders: { top: { style: 'thin', color: '1F5E4B' }, left: { style: 'medium', color: '1F5E4B' }, bottom: null } },
          { rect: rect(20, 20, 120, 60), fill: 'FFFFFF' },
          { rect: rect(250, 10, 400, 120), borders: { bottom: { style: 'double', color: '000000' } } },
        ],
        texts: [
          text('Heading', rect(20, 20, 220, 44), { bold: true, size: 14, color: '111827', note: 'the source of the heading' }),
          text('A longer text that wraps over two lines of the card', rect(20, 50, 220, 100), { lines: 3, valign: 'bottom', indent: 1 }),
          text('42', rect(260, 20, 390, 60), { size: 20, align: 'right', format: '0"건"', value: '42' }),
          text('Total', rect(260, 70, 390, 100), { formula: 'SUM(A1:A3)', format: '#,##0', italic: true }),
          text('', rect(260, 100, 390, 118)),
        ],
        gridlines: true,
        orientation: 'portrait',
        fit: 'page',
      }),
    ]),
  },
  {
    name: 'a named table with a frozen header and print titles',
    title: 'Tables',
    measure: measureOf([
      sheet('Ops', {
        tables: [
          {
            name: 'Ops',
            style: 'TableStyleMedium2',
            freezeHeader: true,
            rect: rect(0, 0, 300, 90),
            rows: [
              [cell('월', rect(0, 0, 100, 30), { header: true, bold: true, fill: 'EEF4F1' }), cell('처리량', rect(100, 0, 200, 30), { header: true, bold: true, align: 'right' }), cell('대기', rect(200, 0, 300, 30), { header: true, bold: true, align: 'right' })],
              [cell('2026-06', rect(0, 30, 100, 60), { value: '2026-06-01', format: 'yyyy-mm' }), cell('55,100', rect(100, 30, 200, 60), { align: 'right' }), cell('52', rect(200, 30, 300, 60), { align: 'right' })],
              [cell('2026-09', rect(0, 60, 100, 90), { value: '2026-09-01', format: 'yyyy-mm' }), cell('63,000', rect(100, 60, 200, 90), { align: 'right' }), cell('−15.5', rect(200, 60, 300, 90), { align: 'right' })],
            ],
          },
          {
            name: '',
            style: '',
            freezeHeader: false,
            rect: rect(0, 120, 300, 150),
            rows: [[cell('A', rect(0, 120, 150, 150), { header: true }), cell('B', rect(150, 120, 300, 150), { header: true })], []],
          },
        ],
        freeze: '2',
        hidden: false,
      }),
      sheet('Empty', { hidden: true, texts: [text('x', rect(0, 0, 50, 20))] }),
    ]),
  },
  {
    name: 'charts over their own data, series, a bar and a doughnut',
    title: 'Charts',
    measure: measureOf([
      sheet('One', {
        texts: [text('Title', rect(10, 10, 300, 34))],
        charts: [
          { rect: rect(10, 40, 400, 200), spec: { type: 'col', labels: ['a', 'b', 'c'], values: [1, 2, 3], colors: ['C9CED6', '1F5E4B', 'C9CED6'], format: '0"분"', grid: true, valueAxis: true, showValues: false }, range: '', title: 'Highlight', font: 'Arial', alt: '' },
          { rect: rect(410, 40, 700, 200), spec: { type: 'LINE', labels: ['x', 'y'], series: [{ name: 'S1', values: [1, 2] }, { name: 'S2', values: ['3'] }], legend: true, colors: ['111111', '222222'] }, range: '', title: '', font: '', alt: '' },
          { rect: rect(10, 210, 300, 350), spec: { type: 'bar', labels: ['p', 'q'], values: [5, null], name: 'Sales' }, range: '', title: '', font: '', alt: '' },
          { rect: rect(310, 210, 600, 350), spec: { type: 'doughnut', labels: ['a', 'b'], values: [1, 2], colors: ['#111111', '#222222', '#111111'] }, range: '', title: 'Share', font: '', alt: '' },
          { rect: rect(610, 210, 800, 350), spec: { type: 'unknown', labels: [], values: [] }, range: '', title: '', font: '', alt: '' },
        ],
      }),
      sheet('Two', { charts: [{ rect: rect(0, 0, 200, 100), spec: { type: 'area', labels: ['k'], values: [9] }, range: '', title: 'Area', font: '', alt: '' }] }),
    ]),
  },
  {
    name: 'placeholders across sheets and charts over cells',
    title: 'Placeholders',
    measure: measureOf([
      sheet('보고', {
        texts: [text('37', rect(10, 10, 110, 34), { id: 'kpi', formula: '={w6}-{w9}', format: '0"분"' }), text('x', rect(120, 10, 220, 34), { formula: "='데이터'!A1+{gone}", id: 'again' })],
        tables: [
          {
            name: '',
            style: '',
            freezeHeader: false,
            rect: rect(10, 50, 210, 110),
            rows: [
              [cell('월', rect(10, 50, 110, 80), { id: 'mh', header: true }), cell('대기', rect(110, 50, 210, 80), { id: 'wh', header: true })],
              [cell('6월', rect(10, 80, 110, 110), { id: 'm6' }), cell('52', rect(110, 80, 210, 110), { id: 'w6', formula: '=SUMIFS(Ops[대기],Ops[월],{m6})' })],
              [cell('9월', rect(10, 110, 110, 140), { id: 'm9' }), cell('15', rect(110, 110, 210, 140), { id: 'w9', formula: '=SUMIFS(Ops[대기],Ops[월],{m9})' })],
            ],
          },
        ],
        charts: [{ rect: rect(230, 50, 500, 200), spec: { type: 'col', colors: ['C9CED6', '1F5E4B'] }, range: '{mh}:{m9},{wh}:{w9}', title: '', font: '', alt: '' }],
      }),
      sheet('데이터', { texts: [text('7', rect(0, 0, 50, 20), { id: 'far', formula: '={w9}+{kpi}' })], charts: [{ rect: rect(60, 0, 300, 100), spec: { type: 'pie' }, range: '{mh}:{m9},{wh}:{w9}', title: '', font: '', alt: '' }] }),
    ]),
  },
  {
    name: 'pictures, one without its photograph',
    title: 'Pictures',
    captures: [1],
    measure: measureOf(
      [
        sheet('P', {
          texts: [text('caption', rect(10, 120, 200, 140))],
          pictures: [
            { rect: rect(10, 10, 110, 60), capture: 1, alt: '' },
            { rect: rect(120, 10, 220, 60), capture: 1, alt: 'a "quoted" <logo>' },
            { rect: rect(230, 10, 330, 60), capture: 2, alt: 'not photographed' },
          ],
        }),
      ],
      { captures: 2 }
    ),
  },
  { name: 'refused: no sheet', title: '', measure: measureOf([]) },
  {
    name: 'refused: a chart range that names no element',
    title: '',
    measure: measureOf([sheet('S', { texts: [text('x', rect(0, 0, 50, 20))], charts: [{ rect: rect(60, 0, 300, 100), spec: { type: 'pie' }, range: '{nobody}:{nobody}', title: '', font: '', alt: '' }] })]),
  },
  {
    name: 'refused: a sheet with nothing on it',
    title: '',
    measure: measureOf([sheet('Blank', { font: '' })]),
  },
];

const recordedBuilds = [];
for (const entry of cases) {
  const dir = mkdtempSync(join(scratch, 'case-'));
  const captures = new Map();
  const captureFiles = {};
  for (const number of entry.captures ?? []) {
    const name = `capture-${number}.png`;
    writeFileSync(join(dir, name), photo);
    captures.set(number, join(dir, name));
    captureFiles[number] = { name, blob: blobOf(name, photo) };
  }
  const output = join(dir, 'out.xlsx');
  const record = { name: entry.name, measure: JSON.parse(JSON.stringify(entry.measure)), title: entry.title, captures: captureFiles };
  try {
    const built = await build.buildXlsxFromSheets(JSON.parse(JSON.stringify(entry.measure)), output, { captures, title: entry.title });
    record.notes = built.notes;
    record.operations = built.operations;
    record.parts = await partsOf(output);
  } catch (error) {
    record.error = message(error).split(dir).join('@PICTURES@').split(dir.replaceAll('\\', '/')).join('@PICTURES@');
  }
  recordedBuilds.push(record);
}

// ---- runs --------------------------------------------------------------------------------------------------------------
const recordedRuns = [];
if (args.has('browser')) {
  const runner = await importFrom(tree, 'src/runtime/office/authoring/xlsx-html-runner.mjs');
  const launch = await importFrom(tree, 'src/runtime/shared/browser-launch.mjs');
  if (!launch.localBrowserAvailable()) throw new Error('no local Chrome or Edge: the HTML workbooks cannot be run');
  const bare = { name: 'a workbook without a data-sheet section', html: '<!doctype html><html><body><p>본문</p></body></html>' };
  for (const entry of [...documents, bare]) {
    const dir = mkdtempSync(join(scratch, 'run-'));
    const target = join(dir, 'report.xlsx');
    const staged = join(dir, 'staged.xlsx');
    const result = await runner.runXlsxHtmlAuthoring(entry.html, staged, { target });
    const { output: _output, bytes: _bytes, elapsedMs: _elapsed, htmlSource, htmlPages, ...rest } = result;
    const record = { name: entry.name, html: entry.html, result: JSON.parse(JSON.stringify({ ...rest, pages: (htmlPages ?? []).length })), sourceName: htmlSource ? htmlSource.slice(target.length) : null };
    if (result.ok) record.parts = await partsOf(staged);
    recordedRuns.push(record);
  }
}

const golden = {
  note: 'Recorded from src/runtime/office/authoring/xlsx-html-build.mjs (Node, jszip); tests/twin_xlsx_build.rs replays the builds against the Rust port: every part equal, in the recorded order (docProps/core.xml timestamps are the moment of writing); a measure Node refused is refused with the text it threw.',
  blobs,
  builds: recordedBuilds,
  runs: recordedRuns,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-xlsx-build', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
rmSync(scratch, { recursive: true, force: true });
console.log(`golden.json: ${recordedBuilds.length} builds, ${recordedRuns.length} runs, ${Object.keys(blobs).length} blobs`);
