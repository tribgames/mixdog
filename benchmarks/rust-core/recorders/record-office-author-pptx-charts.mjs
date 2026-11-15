#!/usr/bin/env node
// Golden of the pptx chart writer and the authored-package normaliser (crate mixdog-office-author: pptx_writer::charts,
// pptx_writer::chart_workbook and normalize). Two recordings in one file, both from the Node product:
//
//   charts:    scripted `addChart` calls run against pptxgenjs 4.0.1 (a fresh copy of the library for every case, so the
//              chart counter that names `chart<n>.xml` starts at 1): the chart part, its relationships, the parts of the
//              embedded workbook and the graphic frame the slide holds, for the chart kinds the HTML route and the kit use
//              (bar and column clustered, stacked and percent stacked, line, area, pie, doughnut, radar, scatter) with the
//              options that shape them (series, categories, several label levels, axes, titles, number formats, data labels,
//              colours, legend, data table, borders, shadows, layout);
//   normalize: the decks pptxgenjs wrote for those cases, and a few more with text runs, gradient-marked shapes, icon
//              pictures, tables and the accent overlay series, run through `normalizeAuthoredPptx` of
//              `src/runtime/office/authoring/pptx-script-normalize.mjs`: the package before and after, by part.
//
//   node benchmarks/rust-core/recorders/record-office-author-pptx-charts.mjs --tree <product tree>
//
// Writes native/core/fixtures/office-author-pptx-charts/golden.json and the set's manifest. A case is a list of calls, JSON
// as the replay reads it back: { op: 'addSlide' } or { op: 'addChart', slide, type, data, options }. A case whose write
// threw records `thrown`. Parts are by blob id (an XML or relationships part as text, anything else as base64).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-author-pptx-charts.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-author-pptx-charts');
const stage = stageSet(finalDir);

const need = createRequire(join(tree, 'package.json'));
const JSZip = need('jszip');
const pptxPath = need.resolve('pptxgenjs');
const freshPptx = () => {
  delete need.cache[pptxPath];
  return need('pptxgenjs');
};
const { normalizeAuthoredPptx } = await importFrom(tree, 'src/runtime/office/authoring/pptx-script-normalize.mjs');

// ---- data helpers ---------------------------------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const series = (name, values, labels = MONTHS) => ({ name, labels, values });
const two = [series('North', [11, 13, 14, 15, 16, 12]), series('South', [22, 6, 7, 8, 9, 30])];
const three = [...two, series('East', [33, 32, 42, 53, 63, 0])];
const holes = [series('Gaps', [5, null, 0, 7.5, -2, 9], MONTHS)];
const levels = [
  ['Gear', 'Berg', 'Motr', 'Swch', 'Plug', 'Cord'],
  ['Mech', '', '', 'Elec', '', ''],
];
const multi = [
  { name: 'West', labels: levels, values: [11, 8, 3, 0, 11, 3] },
  { name: 'East', labels: levels, values: [0, 3, 2, 5, 1, 4] },
];
const pie = [{ name: 'Status', labels: ['Red', 'Amber', 'Green', 'Unknown & <more>'], values: [10, 20, 38, 2] }];
const scatter = [
  { name: 'X-Axis', values: [1, 2, 3, 4, 5] },
  { name: 'Alpha', values: [2, 22, 42, 52, 62], labels: ['a', 'b', ' ', 'd', 'e'] },
  { name: 'Beta', values: [3, 33, null, 53, 63], labels: ['p', 'q', 'r', 's', 't'] },
];
const at = { x: 0.5, y: 0.6, w: 6, h: 3.4 };

const cases = [];
const addCase = (name, calls) => cases.push({ name, calls });
const slide = () => ({ op: 'addSlide' });
const chart = (type, data, options = {}, slideIndex = 0) => ({ op: 'addChart', slide: slideIndex, type, data, options: { ...at, ...options } });
const one = (name, type, data, options) => addCase(name, [slide(), chart(type, data, options)]);

one('column clustered, defaults', 'bar', two);
one('bar chart, horizontal, long names', 'bar', three, { barDir: 'bar', showLegend: true, legendPos: 'b' });
one('column stacked, labels and gap', 'bar', three, { barGrouping: 'stacked', showValue: true, dataLabelPosition: 'ctr', barGapWidthPct: 80, chartColors: ['1A73E8', 'E8710A', '188038'] });
one('column stacked, label position outEnd', 'bar', two, { barGrouping: 'stacked', showValue: true, dataLabelPosition: 'outEnd' });
one('column percent stacked', 'bar', two, { barGrouping: 'percentStacked', showLegend: true, legendFontFace: 'Noto Sans KR', legendFontSize: 9, legendColor: '5F6368' });
one('column clustered, label position and overlap', 'bar', two, { showValue: true, dataLabelPosition: 'inEnd', barOverlapPct: 20, barGapWidthPct: 0 });
one('column clustered, invalid label position is dropped', 'bar', two, { showValue: true, dataLabelPosition: 'bestFit' });
one('single series with a colour for each bar', 'bar', [series('Sales', [4, -3, 5, 6, -1, 2])], { chartColors: ['1A73E8', 'E8710A', '188038'], invertedColors: ['D93025'], showValue: true, dataLabelFormatCode: '0.0' });
one('single series, own colours and no outline', 'bar', [series('Sales', [4, 3, 5])], { chartColors: ['1A73E8', 'E8710A'], lineSize: 0 }, 0);
one('titles and axis titles', 'bar', two, {
  showTitle: true,
  title: 'Revenue & cost',
  titleColor: '202124',
  titleFontFace: 'Noto Sans KR',
  titleFontSize: 14,
  titleBold: true,
  titleAlign: 'left',
  showCatAxisTitle: true,
  catAxisTitle: 'Month',
  catAxisTitleColor: '5F6368',
  catAxisTitleFontSize: 10,
  showValAxisTitle: true,
  valAxisTitle: 'Units',
  valAxisTitleRotate: 270,
  valAxisTitleFontFace: 'Arial',
});
one('title position and rotation', 'line', two, { showTitle: true, title: 'Placed', titlePos: { x: 1.5, y: 0.25 }, titleRotate: 10, titleAlign: 'right' });
one('axis scaling, units, formats and lines', 'bar', two, {
  valAxisMinVal: 0,
  valAxisMaxVal: 100,
  valAxisMajorUnit: 25,
  valAxisLabelFormatCode: '#,##0"k"',
  valAxisLabelFontSize: 9,
  valAxisLabelColor: '5F6368',
  valAxisLabelFontFace: 'Noto Sans KR',
  valAxisLabelFontBold: true,
  valAxisMajorTickMark: 'none',
  valAxisLabelPos: 'high',
  valAxisLineShow: false,
  valGridLine: { color: 'DADCE0', style: 'dash', size: 0.5 },
  catGridLine: { color: 'EEEEEE', style: 'solid', size: 1, cap: 'round' },
  catAxisLabelRotate: 45,
  catAxisLabelFontSize: 8,
  catAxisLabelItalic: true,
  catAxisLineColor: '202124',
  catAxisLineSize: 2,
  catAxisLineStyle: 'dash',
  catAxisMajorTickMark: 'cross',
  catAxisMinorTickMark: 'in',
  catAxisLabelPos: 'high',
  catAxisLabelFrequency: 2,
  catAxisOrientation: 'maxMin',
  valAxisOrientation: 'maxMin',
  catAxisHidden: true,
  valAxisHidden: true,
  lang: 'ko-KR',
});
one('axis crossings, log scale, display unit', 'bar', two, { valAxisLogScaleBase: 10, valAxisCrossesAt: 'max', catAxisCrossesAt: 3, valAxisDisplayUnit: 'thousands', valAxisDisplayUnitLabel: true, valAxisMaxVal: 0 });
one('axis crossings, numbers', 'bar', two, { valAxisCrossesAt: 2, catAxisCrossesAt: 'min' });
one('gridline defaults are corrected', 'bar', two, { valGridLine: { size: -1, style: 'wavy', cap: 'triangle', color: 'AAAAAA' }, catGridLine: { style: 'solid', size: 0 } });
one('line chart, markers and smoothing', 'line', three, {
  lineSize: 3,
  lineSmooth: true,
  lineDataSymbol: 'diamond',
  lineDataSymbolSize: 9,
  lineDataSymbolLineSize: 1.5,
  lineDataSymbolLineColor: '202124',
  lineDash: 'dash',
  lineCap: 'round',
  showLegend: true,
  legendPos: 'tr',
  showValue: true,
  dataLabelPosition: 't',
  dataLabelFontSize: 9,
  dataLabelColor: '5F6368',
  dataLabelFontFace: 'Noto Sans KR',
  dataLabelFontBold: true,
  dataLabelFontItalic: true,
  dataLabelFormatCode: '0%',
  chartColors: ['1A73E8', 'E8710A', '188038'],
});
one('line chart without a line', 'line', two, { lineSize: 0, lineDataSymbol: 'none', displayBlanksAs: 'gap' });
one('line chart, values with holes and zeros', 'line', holes, { showValue: true, lineSmooth: false, shadow: { type: 'outer', blur: 4, offset: 2, angle: 45, color: '#112233', opacity: 0.5 } });
one('line chart with a shadow of a made-up type', 'line', two, { shadow: { type: 'glow', angle: 400, opacity: 3, color: 'FF0000' } });
one('area chart, standard', 'area', two, { chartColorsOpacity: 40, showLegend: true });
one('area chart, stacked', 'area', two, { barGrouping: 'stacked', dataLabelPosition: 'ctr' });
one('area chart, percent stacked', 'area', two, { barGrouping: 'percentStacked' });
one('pie chart', 'pie', pie, { showLegend: true, legendPos: 'r', showPercent: true, showLabel: true, showLeaderLines: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 11, dataBorder: { pt: 2, color: 'FFFFFF' }, firstSliceAng: 90.4 });
one('pie chart, default labels and colours', 'pie', pie, {});
one('pie chart, values and no effects', 'pie', pie, { showValue: true, dataNoEffects: true, dataLabelFormatCode: '#,##0.0', chartColors: ['4285F4', 'EA4335', 'FBBC04', '34A853'], dataLabelPosition: 'nonsense' });
one('pie chart, shadow', 'pie', pie, { shadow: { type: 'outer', blur: 6, offset: 3, angle: 90, color: '000000', opacity: 0.2 } });
one('doughnut chart', 'doughnut', pie, { holeSize: 65, showPercent: true, showLegend: true, dataBorder: { color: 'not a colour' }, dataLabelPosition: 'ctr' });
one('doughnut chart, scheme colours', 'doughnut', pie, { chartColors: ['accent1', 'accent2', 'bg2', 'tx1'], holeSize: 0 });
one('radar chart', 'radar', three, { radarStyle: 'marker', showLegend: true, lineDataSymbol: 'square' });
one('scatter chart', 'scatter', scatter, { showLegend: true, lineSize: 0, lineDataSymbolSize: 8 });
one('scatter chart, custom point labels', 'scatter', scatter, { showLabel: true, dataLabelPosition: 'r' });
one('scatter chart, custom labels with the values', 'scatter', scatter, { showLabel: true, dataLabelFormatScatter: 'customXY', dataLabelPosition: 'b', lang: 'ko-KR' });
one('scatter chart, labels of X and Y', 'scatter', scatter, { showLabel: true, dataLabelFormatScatter: 'XY', showSerName: true });
one('scatter chart, axes', 'scatter', scatter, { valAxisMinVal: 0, valAxisMaxVal: 100, catAxisMinVal: 0, catAxisMaxVal: 6, catAxisMajorUnit: 1, catAxisMinorUnit: 0.5, valAxisLabelFormatCode: '0.0', showCatAxisTitle: true, catAxisTitle: 'x', lineSmooth: true });
one('category labels on several levels', 'bar', multi, { catAxisMultiLevelLabels: true, showLegend: true });
one('category labels on several levels, without the level axis', 'bar', multi, {});
one('category labels as numbers (a date axis)', 'line', [series('Index', [1, 2, 3], ['43101', '43132', '43160'])], { catLabelFormatCode: 'mmm-yy', catAxisBaseTimeUnit: 'Months', catAxisMajorTimeUnit: 'years', catAxisMinorTimeUnit: 'weeks', catAxisMajorUnit: 2, valLabelFormatCode: '0.0' });
one('data table', 'bar', two, { showDataTable: true, showDataTableHorzBorder: true, showDataTableKeys: true, dataTableFontSize: 9, dataTableFormatCode: '0.00' });
one('data table without borders', 'bar', two, { showDataTable: true });
one('areas, borders and fills', 'bar', two, {
  plotArea: { border: { pt: 2, color: 'CCCCCC' }, fill: { color: 'F8F9FA' } },
  chartArea: { border: { pt: 1.5 }, fill: { color: 'FFFFFF', transparency: 20 }, roundedCorners: false },
  dataBorder: { pt: 1, color: 'FFFFFF' },
  dataLabelBkgrdColors: true,
  showValue: true,
});
one('deprecated border and fill', 'bar', two, { border: { color: 'FF0000' }, fill: 'EEEEEE' });
one('manual layout', 'line', two, { layout: { x: 0.1, y: 0.1, w: 0.8, h: 2 }, showLegend: true, legendFontFace: 'Arial' });
one('manual layout with defaults', 'line', two, { layout: {} });
one('transparent colour and opacity', 'bar', two, { chartColors: ['transparent', '1A73E8'], chartColorsOpacity: 70 });
one('object name, alt text and percent size', 'bar', two, { objectName: 'Revenue <chart>', altText: 'Revenue "by" month', x: '10%', y: 2, w: '80%', h: '40%' });
one('size of a chart on a large slide position', 'bar', two, { x: 0, y: 150, w: 5, h: 0 });
addCase('two charts on a slide and one on the next', [slide(), chart('bar', two, { x: 0.3 }), chart('pie', pie, { x: 5 }), slide(), chart('line', three, {}, 1)]);
addCase('an invalid line cap throws when the deck is written', [slide(), chart('line', two, { lineCap: 'triangle' })]);
addCase('a chart with the grid lines of a scatter chart', [slide(), chart('scatter', scatter, { catGridLine: { color: '00FF00' } })]);

// ---- decks for the normaliser beyond the chart cases -----------------------------------------------------------------
const PNG = 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const gradient = (spec) => `mixdog-gradient:${encodeURIComponent(JSON.stringify(spec))}`;
const icon = (svg) => `mixdog-svg:${encodeURIComponent(svg)}`;
const extraDecks = [
  {
    name: 'text runs, gradients, icons and a table on slide five',
    build: (pres) => {
      for (let number = 1; number <= 5; number += 1) {
        const slideObject = pres.addSlide();
        slideObject.addText(
          [
            { text: 'First run, ', options: { bold: true } },
            { text: 'second run' },
            { text: 'new line', options: { breakLine: true } },
            { text: 'third paragraph.' },
          ],
          { x: 0.5, y: 0.5, w: 6, h: 1.2 },
        );
        slideObject.addText('Plain text', { x: 0.5, y: 2, w: 3, h: 0.5, hangingPunct: true });
        if (number === 1) {
          slideObject.addShape('rect', { x: 0.2, y: 0.2, w: 2, h: 1, fill: { color: '0B1B2B' }, line: { color: '0B1B2B', width: 1 }, objectName: gradient({ stops: [[0, '0B1B2B', 1], [100, '1F3A5F', 0.4]], angle: 90 }) });
          slideObject.addShape('ellipse', { x: 3, y: 0.2, w: 2, h: 1, fill: { color: 'FFAA00' }, objectName: gradient({ stops: [[0, 'FFAA00', 0.35], [100, 'FFAA00', 0]], radial: { fx: 0.25, fy: 0.5 } }) });
          slideObject.addShape('rect', { x: 6, y: 0.2, w: 1, h: 1, line: { color: '202124' }, objectName: gradient({ stops: [[0, '#ff0000', 1]] }) });
          slideObject.addShape('rect', { x: 6, y: 1.5, w: 1, h: 1, line: { type: 'none' }, objectName: 'mixdog-gradient:%E0%A4%A' });
          slideObject.addImage({ data: PNG, x: 1, y: 3, w: 0.5, h: 0.5, objectName: icon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>') });
          slideObject.addImage({ data: PNG, x: 2, y: 3, w: 0.5, h: 0.5, objectName: icon('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>') });
          slideObject.addImage({ data: PNG, x: 3, y: 3, w: 0.5, h: 0.5, objectName: icon('not an svg') });
          slideObject.addNotes('Notes of the first slide');
        }
        if (number === 5) {
          slideObject.addTable([[{ text: 'Head' }, { text: 'Value' }], [{ text: 'Row' }, { text: '1' }]], { x: 0.5, y: 3, w: 4 });
          for (let n = 0; n < 4; n += 1) slideObject.addShape('rect', { x: 5 + n * 0.1, y: 3, w: 0.5, h: 0.5, fill: { color: 'CCCCCC' } });
        }
      }
    },
  },
  {
    name: 'the accent bar of the kit: a base series and an overlay',
    build: (pres) => {
      const slideObject = pres.addSlide();
      slideObject.addChart('bar', [series('처리량', [12, 18, 0], ['A', 'B', 'C']), series('처리량 ·', [0, 0, 31], ['A', 'B', 'C'])], { ...at, barGrouping: 'stacked', chartColors: ['E7EBEE', 'B81E38'], catAxisLabelFontFace: 'Noto Sans KR', valAxisLabelFontFace: 'Noto Sans KR', showLegend: true, legendFontFace: 'Noto Sans KR' });
      slideObject.addChart('bar', [series('Plain', [1, 2, 3], ['A', 'B', 'C']), series('Other', [3, 2, 1], ['A', 'B', 'C'])], { ...at, y: 4, barGrouping: 'stacked' });
      slideObject.addChart('line', two, { ...at, y: 5, chartColors: ['1A73E8'], catAxisLabelFontFace: 'Malgun Gothic', showLegend: true, legendFontFace: 'Arial' });
    },
  },
  {
    name: 'a deck whose pptxgenjs wrote its notes master list after the slides, nothing else',
    build: (pres) => {
      pres.addSlide().addShape('rect', { x: 1, y: 1, w: 1, h: 1, fill: { color: 'EEEEEE' } });
    },
  },
];

// ---- run ------------------------------------------------------------------------------------------------------------
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
const textBlob = (text) => {
  const body = { text };
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

const partsOf = async (zip) => {
  const parts = [];
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) parts.push({ name, dir: true });
    else parts.push({ name, blob: blobOf(name, Buffer.from(await entry.async('uint8array'))) });
  }
  return parts;
};

async function runCase({ calls }) {
  const PptxGenJS = freshPptx();
  const pres = new PptxGenJS();
  const slides = [];
  for (const call of calls) {
    if (call.op === 'addSlide') slides.push(pres.addSlide());
    else if (call.op === 'addChart') slides[call.slide].addChart(call.type, clone(call.data), clone(call.options));
    else throw new Error(`recorder: unknown op ${call.op}`);
  }
  return pres;
}

const frameOf = (xml) => (xml.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g) || []).filter((frame) => frame.includes('drawingml/2006/chart'));

async function recordCharts(pres, zip) {
  const charts = [];
  const names = Object.keys(zip.files);
  const chartNumbers = names.map((name) => /^ppt\/charts\/chart(\d+)\.xml$/.exec(name)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  for (const number of chartNumbers) {
    const embedded = await JSZip.loadAsync(await zip.file(`ppt/embeddings/Microsoft_Excel_Worksheet${number}.xlsx`).async('nodebuffer'));
    const workbook = [];
    for (const name of Object.keys(embedded.files)) {
      const entry = embedded.files[name];
      workbook.push(entry.dir ? { name, dir: true } : { name, blob: textBlob(await entry.async('string')) });
    }
    charts.push({
      number,
      chart: textBlob(await zip.file(`ppt/charts/chart${number}.xml`).async('string')),
      rels: textBlob(await zip.file(`ppt/charts/_rels/chart${number}.xml.rels`).async('string')),
      workbook,
    });
  }
  const frames = [];
  for (let slideNumber = 1; slideNumber <= names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length; slideNumber += 1) {
    for (const frame of frameOf(await zip.file(`ppt/slides/slide${slideNumber}.xml`).async('string'))) frames.push({ slide: slideNumber - 1, blob: textBlob(frame) });
  }
  return { charts, frames };
}

const scratch = join(stage, '..', 'office-author-pptx-charts.scratch');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

async function normalizeDeck(buffer, label) {
  const file = join(scratch, `${label.replace(/[^a-z0-9]+/gi, '-')}.pptx`);
  writeFileSync(file, buffer);
  const input = await partsOf(await JSZip.loadAsync(buffer));
  const result = await quiet(() => normalizeAuthoredPptx(file));
  const output = await partsOf(await JSZip.loadAsync(readFileSync(file)));
  return { input, output, result };
}

const recordedCharts = [];
const recordedNormalize = [];
for (const spec of cases) {
  const record = { name: spec.name, calls: spec.calls };
  const pres = await quiet(() => runCase(spec));
  let buffer;
  try {
    buffer = await quiet(() => pres.write({ outputType: 'nodebuffer' }));
  } catch (caught) {
    record.thrown = String(caught?.message ?? caught);
    recordedCharts.push(record);
    continue;
  }
  const zip = await JSZip.loadAsync(buffer);
  Object.assign(record, await recordCharts(pres, zip));
  recordedCharts.push(record);
  recordedNormalize.push({ name: spec.name, ...(await normalizeDeck(buffer, spec.name)) });
}
for (const deck of extraDecks) {
  const PptxGenJS = freshPptx();
  const pres = new PptxGenJS();
  await quiet(async () => deck.build(pres));
  const buffer = await quiet(() => pres.write({ outputType: 'nodebuffer' }));
  recordedNormalize.push({ name: deck.name, ...(await normalizeDeck(buffer, deck.name)) });
}
rmSync(scratch, { recursive: true, force: true });

const golden = {
  note: 'Recorded from pptxgenjs 4.0.1 (dist/pptxgen.cjs.js) and src/runtime/office/authoring/pptx-script-normalize.mjs; tests/twin_pptx_charts.rs replays the chart calls against the Rust chart writer and the recorded decks against the Rust normaliser.',
  pptxgenjs: JSON.parse(readFileSync(join(tree, 'node_modules', 'pptxgenjs', 'package.json'), 'utf8')).version,
  blobs,
  charts: recordedCharts,
  normalize: recordedNormalize,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-author-pptx-charts', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`golden.json: ${recordedCharts.length} chart cases, ${recordedNormalize.length} normalised decks, ${Object.keys(blobs).length} blobs`);
