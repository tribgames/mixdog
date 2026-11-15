#!/usr/bin/env node
// Golden of the Word HTML route's build half (crate mixdog-office-author: docx_build, docx_html_runner): what Node's
// `runtime/office/authoring/docx-html-build.mjs` (`buildDocxFromFlow`) writes for the flows of `docx-html-measure.mjs`.
//
//   node benchmarks/rust-core/recorders/record-office-docx-build.mjs --tree <product tree>
//
// Sections:
//   builds   per flow: the flow (JSON, as `measure_docx` hands it over), the page (points), the title, the pictures the
//            captured elements were photographed as, and the package `buildDocxFromFlow` wrote, part by part (an XML or
//            relationships part as text, anything else as base64), with the notes it returned; or the error it threw.
//            The flows are the two documents of the Word suite (`office-docx-html.slow`: the report and its features,
//            read back from the office-measure-docs recording, so the browser of that recording is the browser of these
//            flows) and flows of their own for what a layout draws: every list, heading, border, run mark, table shape,
//            picture source, running line and the refusals.
//   runs     per HTML document of `office-docx-html.slow`: what `runDocxHtmlAuthoring` answered in the installed browser
//            (paths and times left out), the HTML source it kept and its package. Written only with `--browser`: the
//            offline replay builds from the recorded flows, the ignored `twin_live_docx_build` runs Rust against the
//            browser. Without `--browser` the section is empty.
// Writes native/core/fixtures/office-docx-build/golden.json and the set's manifest.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-docx-build.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-docx-build');
const stage = stageSet(finalDir);

const need = createRequire(join(tree, 'package.json'));
const JSZip = need('jszip');
const sharp = need('sharp');
const build = await importFrom(tree, 'src/runtime/office/authoring/docx-html-build.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'mixdog-docx-build-rec-'));
const PICTURES = '@PICTURES@';
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const blobs = {};
const blobOf = (name, bytes) => {
  const textual = /\.(xml|rels)$/.test(name);
  // The two timestamps of docProps/core.xml are the moment of writing: recorded as a mask, so the recording is the same each time.
  const body = textual ? { text: bytes.toString('utf8').replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*/g, '$1@TIME@') } : { base64: bytes.toString('base64') };
  const id = sha(JSON.stringify(body));
  blobs[id] = body;
  return id;
};
const message = (error) => String(error?.message ?? error);
const unmasked = (text, dir) => text.split(dir).join(PICTURES).split(dir.replaceAll('\\', '/')).join(PICTURES);

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
const chartPng = await quadrants(60, 30).png().toBuffer();
const logoPng = await quadrants(20, 20).png().toBuffer();
const photoJpg = await quadrants(24, 12).jpeg().toBuffer();
const dataPng = `data:image/png;base64,${logoPng.toString('base64')}`;
const dataJpeg = `data:image/jpeg;base64,${photoJpg.toString('base64')}`;

// ---- flows -------------------------------------------------------------------------------------------------------------
const run = (text, extra = {}) => ({ text, font: 'Malgun Gothic', fontEastAsia: 'Malgun Gothic', size: 11, bold: false, italic: false, underline: false, strike: false, color: '374151', ...extra });
const paragraph = (text, extra = {}) => ({ kind: 'p', tag: 'p', runs: [run(text)], align: 'left', line: 17.6, size: 11, indentLeft: 0, indentRight: 0, firstLine: 0, keepNext: false, keepLines: false, before: 0, after: 8, ...extra });
const heading = (level, text, extra = {}) => ({ ...paragraph(text, { tag: `h${level}`, heading: level, keepNext: true, runs: [run(text, { size: 28 - level * 3, bold: true, color: '111827' })] }), ...extra });
const cell = (blocks, extra = {}) => ({ blocks, span: 1, vAlign: 'top', padding: { top: 0, left: 4, bottom: 0, right: 4 }, ...extra });
const row = (cells, extra = {}) => ({ height: 22, header: false, cells, ...extra });
const table = (columns, rows, extra = {}) => ({ kind: 'table', data: true, indent: 0, columns, rows, ...extra });
const A4 = { sheet: { width: 595.28, height: 841.89 }, margin: { top: 56.69, right: 56.69, bottom: 56.69, left: 56.69 } };

const documents = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'office-measure-docs', 'golden.json'), 'utf8')).docx;
const points = (value) => Math.round(value * 0.75 * 100) / 100;
const pageOf = (area) => ({ sheet: { width: points(area.sheet.width), height: points(area.sheet.height) }, margin: Object.fromEntries(Object.entries(area.margin).map(([side, value]) => [side, points(value)])) });

const cases = [
  ...documents.map((entry) => ({ name: `suite: ${entry.name}`, flow: entry.output.flow, page: pageOf(entry.output.area), title: entry.output.title, captures: [1, 2, 3] })),
  {
    name: 'headings and body face',
    page: A4,
    title: '제목',
    flow: {
      blocks: [heading(1, '첫 제목'), heading(2, '둘째 제목'), heading(3, '셋째'), heading(4, '넷째는 스타일이 없다'), paragraph('본문'), heading(1, '다시 첫 제목')],
      header: null,
      footer: null,
      body: { font: 'Georgia', fontEastAsia: 'Batang', size: 10.5, color: '222222' },
      notes: [],
      captures: 0,
    },
  },
  {
    name: 'lists',
    page: A4,
    title: 'Lists',
    flow: {
      blocks: [
        paragraph('bullet', { list: { kind: 'bullet', level: 0, instance: 0 }, indentLeft: 18 }),
        paragraph('nested bullet', { list: { kind: 'bullet', level: 1, instance: 0 }, indentLeft: 36 }),
        paragraph('one', { list: { kind: 'number', level: 0, instance: 3 }, indentLeft: 18 }),
        paragraph('two', { list: { kind: 'number', level: 0, instance: 3 }, indentLeft: 40 }),
        paragraph('again one', { list: { kind: 'number', level: 0, instance: 5 }, indentLeft: 0 }),
        paragraph('plain'),
      ],
      body: { font: 'Georgia', size: 11, color: '000000' },
      notes: [],
      captures: 0,
    },
  },
  {
    name: 'paragraph decoration and runs',
    page: A4,
    title: 'Runs',
    flow: {
      blocks: [
        paragraph('', {
          runs: [
            run('bold', { bold: true }),
            run(' italic ', { italic: true, underline: true }),
            run('strike', { strike: true }),
            run('mark', { shading: 'FFF2A8' }),
            run('sup', { vertAlign: 'superscript' }),
            { br: true },
            run('tab\tinside'),
            run(' a & b <c>', { font: '', fontEastAsia: 'Batang' }),
            run('plain', { font: '' }),
          ],
        }),
        paragraph('A bordered, shaded paragraph.', {
          shading: 'FDF1EC',
          borders: { left: { width: 3, color: 'C2461A', style: 'single' }, top: { width: 0.25, color: '000000', style: 'dotted' }, bottom: { width: 120, color: '000000', style: 'double' } },
          borderSpace: { top: 4, left: 8, bottom: 40, right: 0 },
          keepLines: true,
          before: 4,
          indentLeft: 12,
          indentRight: 6,
          firstLine: 10,
          align: 'justify',
        }),
        paragraph('hanging', { firstLine: -14, align: 'right', line: 0, before: 0, after: 0 }),
        paragraph('centred', { align: 'center', pageBreakBefore: true }),
        { kind: 'spacer', height: 12 },
      ],
      body: { size: 11 },
      notes: ['a note from the measure'],
      captures: 0,
    },
  },
  {
    name: 'tables',
    page: A4,
    title: 'Tables',
    flow: {
      blocks: [
        paragraph('표 1. 처리량'),
        table(
          [100, 10, 150],
          [
            row([cell([paragraph('허브')], { fill: 'EEF4F1', borders: { bottom: { width: 0.75, color: 'CCCCCC', style: 'single' } } }), { span: 1, empty: true }, cell([paragraph('처리량')], { vAlign: 'center' })], { header: true }),
            row([cell([paragraph('동부')], { padding: { top: 6, left: 8, bottom: 6, right: 8 } }), { span: 1, empty: true }, cell([paragraph('69,800', { align: 'right' })], { padding: { top: 6, left: 8, bottom: 6, right: 8 } })], { height: 40 }),
            { spacer: true, height: 8 },
            row([cell([paragraph('합계')], { span: 3, vAlign: 'bottom', borders: { top: { width: 1.5, color: '000000', style: 'dashed' }, left: { width: 1, color: '111111', style: 'single' } } })], { height: 0.9 }),
          ],
          { indent: 12 }
        ),
        paragraph('between'),
        table([200], [row([cell([{ kind: 'spacer', height: 3 }])]), row([cell([table([100], [row([cell([paragraph('nested')])])], { data: false })], { padding: { top: 5, left: 0, bottom: 5, right: 0 } })])], { data: false, pageBreakBefore: true }),
        table([50, 50], Array.from({ length: 8 }, (_, index) => row([cell([paragraph(`r${index}`)]), cell([paragraph(`v${index}`)])], { header: index === 0 }))),
        table([50, 50], Array.from({ length: 8 }, (_, index) => row([cell([paragraph(`k${index}`)]), cell([paragraph(`w${index}`)])])), { keepTogether: true }),
        table([40], [row([{ span: 1, empty: true }]), row([cell([])])]),
        table([60], [row([cell([paragraph('last table')])])]),
      ],
      body: { font: 'Malgun Gothic', size: 10, color: '111111' },
      notes: [],
      captures: 0,
    },
  },
  {
    name: 'pictures',
    page: A4,
    title: 'Pictures',
    captures: [1, 2],
    flow: {
      blocks: [
        paragraph('그림 1. 차트'),
        { kind: 'image', width: 120, height: 60, indent: 0, alt: '차트', capture: 1 },
        { kind: 'image', width: 80, height: 80, indent: 20, alt: '', capture: 2, align: 'center' },
        { kind: 'image', width: 10, height: 10, indent: 0, alt: 'ghost', capture: 9 },
        { kind: 'image', width: 40, height: 40, indent: 0, alt: 'file picture', src: `${PICTURES}/logo.png` },
        { kind: 'image', width: 48, height: 24, indent: 0, alt: 'a "data" <jpeg>', src: dataJpeg },
        { kind: 'image', width: 48, height: 24, indent: 0, alt: 'same data again', src: dataJpeg },
        { kind: 'image', width: 20, height: 20, indent: 0, alt: 'data png', src: dataPng },
        { kind: 'image', width: 30, height: 30, indent: 0, alt: 'remote', src: 'https://example.org/x/a-very-long-picture-name-that-is-cut-at-sixty-characters-of-the-source.png' },
        table([200], [row([cell([{ kind: 'image', width: 40, height: 40, indent: 0, alt: 'in a cell', src: dataPng }])])]),
      ],
      body: { size: 11 },
      notes: [],
      captures: 2,
    },
  },
  {
    name: 'running lines: page and pages, none on the cover',
    page: A4,
    title: 'Running',
    flow: {
      blocks: [paragraph('body')],
      header: { text: '운영 보고', font: 'Malgun Gothic', fontEastAsia: 'Malgun Gothic', size: 9, color: '666666', bold: true, align: 'right', firstPage: 'none' },
      footer: { text: '{page} / {pages}', size: 9, color: '666666', align: 'center' },
      body: { size: 11 },
      notes: [],
      captures: 0,
    },
  },
  {
    name: 'running lines: page prefix and plain footer',
    page: A4,
    title: 'Running 2',
    flow: { blocks: [paragraph('body')], header: { text: 'Page {page}', align: 'left', firstPage: 'Blank' }, footer: { text: 'Confidential', size: 8, align: 'center', firstPage: 'hidden' }, body: { size: 11 }, notes: [], captures: 0 },
  },
  {
    name: 'running lines: total with a separator',
    page: { sheet: { width: 612, height: 792 }, margin: { top: 72, right: 72, bottom: 72, left: 72 } },
    title: '',
    flow: { blocks: [], header: { text: 'x {page} of {pages} y' }, footer: { text: 'only {page}' }, body: { size: 11 }, notes: [], captures: 0 },
  },
  {
    name: 'empty flow',
    page: A4,
    title: '',
    flow: { blocks: [], header: null, footer: null, body: { size: 11 }, notes: [], captures: 0 },
  },
  {
    name: 'refused: a body with no face, size or colour',
    page: A4,
    title: '',
    flow: { blocks: [paragraph('x')], header: null, footer: null, body: {}, notes: [], captures: 0 },
  },
  {
    name: 'refused: a picture format Word has no part for',
    page: A4,
    title: 'Refused',
    pictureFile: 'capture-1.ico',
    captures: [1],
    flow: { blocks: [{ kind: 'image', width: 10, height: 10, indent: 0, alt: '', capture: 1 }], header: null, footer: null, body: { size: 11 }, notes: [], captures: 1 },
  },
  {
    name: 'refused: a picture file that is not there',
    page: A4,
    title: 'Refused',
    flow: { blocks: [{ kind: 'image', width: 10, height: 10, indent: 0, alt: '', src: `${PICTURES}/missing.png` }], header: null, footer: null, body: { size: 11 }, notes: [], captures: 0 },
  },
];

const recordedBuilds = [];
for (const entry of cases) {
  const dir = mkdtempSync(join(scratch, 'case-'));
  // The pictures a case draws with sit in its folder: the capture photographs, and the file the flow names.
  writeFileSync(join(dir, 'logo.png'), logoPng);
  const captures = new Map();
  const captureFiles = {};
  for (const number of entry.captures ?? []) {
    const name = entry.pictureFile ?? `capture-${number}.png`;
    const bytes = entry.pictureFile ? logoPng : number === 1 ? chartPng : logoPng;
    writeFileSync(join(dir, name), bytes);
    captures.set(number, join(dir, name));
    captureFiles[number] = { name, blob: blobOf(name, bytes) };
  }
  const flow = JSON.parse(JSON.stringify(entry.flow));
  const resolved = JSON.parse(JSON.stringify(entry.flow).split(PICTURES).join(pathToFileURL(dir).href));
  const output = join(dir, 'out.docx');
  const record = { name: entry.name, flow, page: entry.page, title: entry.title, captures: captureFiles };
  try {
    const built = await build.buildDocxFromFlow(resolved, output, { page: entry.page, captures, title: entry.title });
    record.notes = built.notes;
    record.parts = await partsOf(output);
  } catch (error) {
    record.error = unmasked(message(error), dir);
  }
  recordedBuilds.push(record);
}

// ---- runs --------------------------------------------------------------------------------------------------------------
const recordedRuns = [];
if (args.has('browser')) {
  const runner = await importFrom(tree, 'src/runtime/office/authoring/docx-html-runner.mjs');
  const launch = await importFrom(tree, 'src/runtime/shared/browser-launch.mjs');
  if (!launch.localBrowserAvailable()) throw new Error('no local Chrome or Edge: the HTML documents cannot be run');
  for (const entry of documents) {
    const dir = mkdtempSync(join(scratch, 'run-'));
    const target = join(dir, 'report.docx');
    const staged = join(dir, 'staged.docx');
    const result = await runner.runDocxHtmlAuthoring(entry.html, staged, { target });
    const { output: _output, bytes: _bytes, elapsedMs: _elapsed, htmlSource, htmlPages, ...rest } = result;
    const record = { name: entry.name, html: entry.html, result: JSON.parse(JSON.stringify({ ...rest, pages: (htmlPages ?? []).length })), sourceName: htmlSource ? htmlSource.slice(target.length) : null };
    if (result.ok) record.parts = await partsOf(staged);
    recordedRuns.push(record);
  }
}

const golden = {
  note: 'Recorded from src/runtime/office/authoring/docx-html-build.mjs (Node, jszip); tests/twin_docx_build.rs replays the builds against the Rust port: every part equal, in the recorded order (docProps/core.xml timestamps are the moment of writing); a flow Node refused is refused with the text it threw.',
  pictures: PICTURES,
  logo: blobOf('logo.png', logoPng),
  blobs,
  builds: recordedBuilds,
  runs: recordedRuns,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-docx-build', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
rmSync(scratch, { recursive: true, force: true });
console.log(`golden.json: ${recordedBuilds.length} builds, ${recordedRuns.length} runs, ${Object.keys(blobs).length} blobs`);
