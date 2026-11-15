#!/usr/bin/env node
// What the portable presentation batch answers (src/runtime/office/portable/portable-pptx.mjs, the dispatcher, and
// portable-pptx-charts.mjs, the chart operations), run through Node on decks: the batches the portable runtime suites apply
// (office-runtime-portable.slow, pptx-chart-styling, pptx-incremental, pptx-chart-part-resolution) and the edge cases of
// every chart operation. Rust `mixdog-ooxml` must answer the same: the results of every batch (or the error it throws) and
// the text of every part of the deck afterwards (crates/mixdog-ooxml/tests/twin_pptx_charts.rs).
//
//   node benchmarks/rust-core/recorders/record-office-pptx-charts.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/office-pptx-charts/golden.json. The recording holds `sequences`: steps over one deck (`create`,
// `set` a part's text, `edit` a part by a pattern (the recording keeps the text the edit produced, as `text`), `batch` of
// operations, `read` a part), each step's output, then the deck's part names and the text of every part.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-pptx-charts');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-pptx-charts.mjs';

const portable = (name) => importFrom(tree, `src/runtime/office/portable/${name}.mjs`);
const batchModule = await portable('portable-pptx');
const opc = await portable('portable-opc');
const pkg = await portable('portable-package');

const work = mkdtempSync(join(tmpdir(), 'mixdog-office-pptx-charts-'));
const attempt = async (run) => {
  try {
    return { result: (await run()) ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

const runStep = async (state, step) => {
  switch (step.op) {
    case 'create': {
      const path = join(work, 'created.pptx');
      await pkg.createPortableOoxmlDocument(path, { fileKind: 'pptx', title: step.title });
      state.zip = await opc.loadPackage(path);
      return null;
    }
    case 'set':
      state.zip.file(step.name, step.text);
      return null;
    case 'edit': {
      step.text = (await opc.zipText(state.zip, step.name)).replace(new RegExp(step.pattern, step.flags ?? ''), step.to);
      state.zip.file(step.name, step.text);
      return null;
    }
    case 'read':
      return (await opc.zipText(state.zip, step.name)) || null;
    case 'batch':
      return await batchModule.applyPptx(state.zip, step.operations);
    default:
      throw new Error(`unknown step ${step.op}`);
  }
};

const snapshotOf = async (zip) => {
  const names = Object.keys(zip.files);
  const parts = {};
  for (const name of names) if (!zip.files[name].dir) parts[name] = await opc.zipText(zip, name);
  return { names, parts };
};

const SEQUENCES = [];
const sequence = (name, steps) => SEQUENCES.push({ name, steps });
const blank = [{ op: 'create', title: 'Charts' }];
const batch = (...operations) => ({ op: 'batch', operations });
const read = (name) => ({ op: 'read', name });
const edit = (name, pattern, to, flags = '') => ({ op: 'edit', name, pattern, to, flags });
const slide = { op: 'add_slide', layout: 'blank' };
const CHART = 'ppt/charts/chart1.xml';

sequence('charts added', [
  ...blank,
  batch(slide),
  batch({ op: 'add_chart', slide: 1, categories: ['1분기', '2분기'], series: [{ name: '손익', values: [12, 8] }] }),
  batch({
    op: 'add_chart', slide: 1, chartType: 'line', title: '월별 지연율', categories: ['1월', '2월'],
    series: [{ name: '서울', values: [0.021, 0.024] }, { name: '대구', values: [0.041, 0.038] }], showValues: true,
  }),
  batch({ op: 'add_chart', slide: 1, chartType: 'column', categories: ['1분기', '2분기'], series: [{ name: '손익', values: [12, -8] }] }),
  batch({ op: 'add_chart', slide: 1, chartType: 'doughnut', categories: ['A', 'B'], series: [{ name: '비중', values: [60, 40] }] }),
  batch({
    op: 'add_chart', slide: 1, chartType: 'Bar', title: 'Throughput <by> hub', categories: ['North', 'South & East', null, 5],
    series: [{ name: 'Units', values: [10, 20, 30, null], color: 'B04A2F', numberFormat: '#,##0' }, { values: [1, 'x', 3, 4] }],
    showValues: true, dataLabelPosition: 'inside_end', dataLabelColor: 'FFFFFF', valueNumberFormat: '0.0%', showLegend: false, zeroBaseline: false,
    left: 10, top: 20, width: 300, height: 200,
  }),
  batch({ op: 'add_chart', slide: 1, chartType: 'stacked column', categories: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [3, 4] }], showValues: true, dataLabelPosition: 'outside_end' }),
  batch({ op: 'add_chart', slide: 1, chartType: 'pie', categories: ['a', 'b', 'c'], series: [{ name: 'share', values: [5, 3, 2], pointColors: ['111111', null, '999999'] }], showValues: true }),
  batch({ op: 'add_chart', slide: 1, chartType: 'area', categories: ['a', 'b'], series: [{ values: [4, 9] }], showLegend: true, zeroBaseline: true, left: '30', top: null }),
  batch({ op: 'add_chart', slide: 1, categories: ['a'], series: [] }),
  batch({ op: 'add_chart', slide: 1, categories: ['a'] }),
  batch({ op: 'add_chart', slide: 1, chartType: 'radar', categories: ['a'], series: [{ values: [1] }] }),
  batch({ op: 'add_chart', slide: 1, chartType: 'column', title: 7, categories: 'nope', series: [{ values: [] }] }),
  batch({ op: 'add_chart', slide: 9, categories: ['a'], series: [{ values: [1] }] }),
  batch({ op: 'add_chart', categories: ['a'], series: [{ values: [1] }] }),
  read('ppt/slides/_rels/slide1.xml.rels'),
]);

sequence('chart data refreshed in place and rebuilt', [
  ...blank,
  batch(slide, {
    op: 'add_chart', slide: 1, chartType: 'column', title: '분기 처리량', categories: ['10월', '11월', '12월'],
    series: [{ name: '처리량', values: [4120, 4480, 4390], color: 'B04A2F' }],
    showValues: true, dataLabelPosition: 'outside_end', valueNumberFormat: '#,##0', zeroBaseline: true, left: 60, top: 110, width: 700, height: 330,
  }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['1월', '2월', '3월'], series: [{ name: '처리량', values: [4610, 4720, 5010] }] }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, series: [{ name: '처리량', values: [4610, 4720, 5010] }], showValues: false }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['a', 'b'], series: [{ name: 'x', values: [1, null] }, { name: 'y', values: [3, 'z'] }] }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, chartType: 'line', categories: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }] }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, title: 'A new title', categories: ['a', 'b'], series: [{ name: 'x', values: [5, 6] }] }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, title: '', categories: ['a', 'b'], series: [{ name: 'x', values: [5, 6] }] }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, title: 'Back again', categories: ['a', 'b'], series: [{ name: 'x', values: [5, 6] }] }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, series: [{ name: 'x', values: [5, 6] }], showLegend: true, zeroBaseline: false, valueNumberFormat: '0.00', dataLabelPosition: 'center', dataLabelColor: '222222' }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, series: [] }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1 }),
  batch({ op: 'set_chart_data', slide: 1, shape: 2, series: [{ values: [1] }] }),
  batch({ op: 'set_chart_data', slide: 3, shape: 1, series: [{ values: [1] }] }),
  batch({ op: 'set_chart_data', series: [{ values: [1] }] }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, series: [{ name: 'x', values: [1, 2] }], chartType: 'radar' }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, series: [{ name: 'x', values: [1, 2] }], categoryOrder: 'topDown' }),
  read(CHART),
]);

sequence('a lone accent point follows the last point', [
  ...blank,
  batch(slide, {
    op: 'add_chart', slide: 1, chartType: 'column', categories: ['1월', '2월', '3월'],
    series: [{ name: '실적', values: [1, 2, 3], color: '336699', pointColors: [null, null, 'FF0000'] }],
  }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['1월', '2월', '3월', '4월'], series: [{ name: '실적', values: [1, 2, 3, 4] }] }),
  read(CHART),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['1월', '2월'], series: [{ name: '실적', values: [1, 2] }] }),
  read(CHART),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['1월', '2월', '3월'], series: [{ name: '실적', values: [1, 2, 3] }], showValues: true }),
  read(CHART),
]);

sequence('a bar chart authored bottom-up keeps its order and turns over on categoryOrder', [
  ...blank,
  batch(slide, {
    op: 'add_chart', slide: 1, chartType: 'bar', categories: ['6월', '7월', '8월', '9월'], series: [{ name: '오류 (건)', values: [8200, 5900, 3100, 2700] }],
  }),
  read(CHART),
  edit(CHART, '<c:catAx>([\\s\\S]*?)<c:orientation val="maxMin"/>', '<c:catAx>$1<c:orientation val="minMax"/>'),
  edit(CHART, '(<c:valAx>[\\s\\S]*?)<c:crosses val="max"/>', '$1<c:crosses val="autoZero"/>'),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['6월', '7월', '8월', '9월'], series: [{ name: '오류 (건)', values: [8200, 5900, 3100, 2700] }] }),
  read(CHART),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['6월', '7월', '8월', '9월'], series: [{ name: '오류 (건)', values: [1, 2, 3, 4] }], categoryOrder: 'topDown' }),
  read(CHART),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['6월', '7월', '8월', '9월'], series: [{ name: '오류 (건)', values: [4, 3, 2, 1] }] }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['6월', '7월', '8월', '9월'], series: [{ name: '오류 (건)', values: [4, 3, 2, 1] }], categoryOrder: ' Bottom_Up ' }),
  read(CHART),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, series: [{ name: '오류 (건)', values: [1, 2, 3, 4] }], categoryOrder: 'sideways' }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, series: [{ name: '오류 (건)', values: [1, 2] }], categoryOrder: 'topDown', chartType: 'column' }),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, series: [{ name: '오류 (건)', values: [1, 2] }], chartType: 'stacked bar', showValues: true }),
  read(CHART),
]);

sequence('a chart saved by PowerPoint keeps its relationships, theme colours and series name', [
  ...blank,
  batch(slide, { op: 'add_chart', slide: 1, chartType: 'column', title: 'Retention', categories: ['Self-serve', 'Guided'], series: [{ name: 'Retention', values: [38, 52] }, { name: 'Other', values: [1, 2] }] }),
  edit('ppt/charts/_rels/chart1.xml.rels', 'Id="rId1"', 'Id="rId3"', 'g'),
  edit('ppt/charts/_rels/chart1.xml.rels', '</Relationships>', '<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/chartStyle" Target="style1.xml"/></Relationships>'),
  { op: 'set', name: 'ppt/charts/style1.xml', text: '<cs:chartStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" id="201"/>' },
  edit(CHART, '(<c:externalData\\b[^>]*\\br:id=")[^"]*(")', '$1rId3$2'),
  edit(CHART, '<c:tx>\\s*<c:strRef>[\\s\\S]*?</c:strRef>\\s*</c:tx>', '<c:tx><c:v>Value</c:v></c:tx>'),
  edit(CHART, '(<c:ser>[\\s\\S]*?<c:spPr>[\\s\\S]*?)<a:srgbClr val="[0-9A-Fa-f]{6}"/>', '$1<a:schemeClr val="accent2"/>'),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['Self-serve', 'Guided'], series: [{ name: '유지율', values: [41, 55] }, { name: 'Other', values: [3, 4] }] }),
  read('ppt/charts/_rels/chart1.xml.rels'),
  read(CHART),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['Self-serve', 'Guided', 'Auto'], series: [{ values: [41, 55, 60] }, { name: 'Other', values: [3, 4, 5] }], showValues: true }),
  read(CHART),
  edit('ppt/charts/_rels/chart1.xml.rels', '<Relationship Id="rId3"[^>]*/>', ''),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['x', 'y'], series: [{ name: 'k', values: [1, 2] }, { name: 'l', values: [3, 4] }], title: 'Own title' }),
  read('ppt/charts/_rels/chart1.xml.rels'),
  read(CHART),
]);

sequence('chart axes, series, trendlines, error bars and data labels', [
  ...blank,
  batch(slide, {
    op: 'add_chart', slide: 1, chartType: 'column', title: 'Sales', categories: ['Q1', 'Q2', 'Q3'],
    series: [{ name: 'A', values: [3, 5, 4] }, { name: 'B', values: [2, 6, 7] }],
  }),
  batch({ op: 'set_chart_axis', slide: 1, shape: 1, axis: 'value', minimum: 0, maximum: 10, majorUnit: 2, numberFormat: '#,##0', title: 'Units & more' }),
  batch({ op: 'set_chart_axis', slide: 1, shape: 1, axis: 'Category', title: 'Quarter' }),
  batch({ op: 'set_chart_axis', slide: 1, shape: 1, axis: 'value', minimum: 1 }),
  batch({ op: 'set_chart_axis', slide: 1, shape: 1, axis: 'value', maximum: 'x' }),
  batch({ op: 'set_chart_axis', slide: 1, shape: 1, axis: 'value', title: '', numberFormat: '', majorUnit: 0 }),
  batch({ op: 'set_chart_axis', slide: 1, shape: 1, axis: 'value' }),
  batch({ op: 'set_chart_axis', slide: 1, shape: 1, axis: 'depth' }),
  batch({ op: 'set_chart_axis', slide: 1, shape: 1 }),
  read(CHART),
  batch({ op: 'set_chart_series', slide: 1, shape: 1, name: 'Alpha <1>' }),
  batch({ op: 'set_chart_series', slide: 1, shape: 1, series: 2, name: 'Beta', categories: ['a', 'b', 'c', 'd'], values: [1, 'x', null, 4] }),
  batch({ op: 'set_chart_series', slide: 1, shape: 1, series: 1, values: [9, 9] }),
  batch({ op: 'set_chart_series', slide: 1, shape: 1, series: 2.5, name: 'All' }),
  batch({ op: 'set_chart_series', slide: 1, shape: 1, series: 7, name: 'none' }),
  batch({ op: 'set_chart_series', slide: 1, shape: 1, series: 1, chartType: 'line' }),
  batch({ op: 'set_chart_series', slide: 1, shape: 1, series: 1, secondaryAxis: true }),
  batch({ op: 'set_chart_series', slide: 1, shape: 1, series: 1, categories: [], values: [] }),
  read(CHART),
  batch({ op: 'set_chart_trendline', slide: 1, shape: 1, series: 1 }),
  batch({ op: 'set_chart_trendline', slide: 1, shape: 1, series: 2, type: 'Moving Average', displayEquation: true, displayRSquared: true }),
  batch({ op: 'set_chart_trendline', slide: 1, shape: 1, type: 'exp' }),
  batch({ op: 'set_chart_trendline', slide: 1, shape: 1, type: 'polynomial', series: 0 }),
  batch({ op: 'set_chart_trendline', slide: 1, shape: 1, type: 'spline' }),
  batch({ op: 'set_chart_trendline', slide: 1, shape: 1, series: 5 }),
  batch({ op: 'set_chart_error_bars', slide: 1, shape: 1, series: 1, amount: 2.5 }),
  batch({ op: 'set_chart_error_bars', slide: 1, shape: 1, amount: 1, direction: 'horizontal', endStyle: 'plus' }),
  batch({ op: 'set_chart_error_bars', slide: 1, shape: 1, series: 2, amount: 1, endStyle: 'wide' }),
  batch({ op: 'set_chart_error_bars', slide: 1, shape: 1, amount: 0 }),
  batch({ op: 'set_chart_error_bars', slide: 1, shape: 1, amount: 1, direction: 'z' }),
  batch({ op: 'set_chart_error_bars', slide: 1, shape: 1 }),
  read(CHART),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 1 }),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 1, series: 1, position: 'inside_end', numberFormat: '0.0' }),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 1, series: 2, position: 'Outside_End', showCategoryName: true }),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 1, showValue: false, showCategoryName: true, position: 'bogus' }),
  read(CHART),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 1, showValue: false }),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 1, series: 3 }),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 9 }),
  read(CHART),
]);

sequence('data labels on stacked and pie charts', [
  ...blank,
  batch(slide,
    { op: 'add_chart', slide: 1, chartType: 'stacked_column', categories: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [3, 4] }] },
    { op: 'add_chart', slide: 1, chartType: 'pie', categories: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }] },
    { op: 'add_chart', slide: 1, chartType: 'doughnut', categories: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }] }),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 1, position: 'outside_end' }),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 2, position: 'outside_end', series: 1 }),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 3, position: 'center' }),
  batch({ op: 'set_chart_data_labels', slide: 1, shape: 4, position: 'center' }),
  read('ppt/charts/chart1.xml'),
  read('ppt/charts/chart2.xml'),
  read('ppt/charts/chart3.xml'),
  batch({ op: 'set_chart_trendline', slide: 1, shape: 2, type: 'log' }),
  batch({ op: 'set_chart_axis', slide: 1, shape: 2, axis: 'value' }),
  batch({ op: 'set_chart_series', slide: 1, shape: 2, series: 1, name: 'renamed' }),
  batch({ op: 'set_chart_data', slide: 1, shape: 3, categories: ['a', 'b', 'c'], series: [{ name: 'x', values: [1, 2, 3] }] }),
  read('ppt/charts/chart2.xml'),
]);

sequence('a batch of deck operations through the dispatcher', [
  ...blank,
  batch({ op: 'add_slide' }, { op: 'add_textbox', slide: 1, text: 'Body', left: 60, top: 60, width: 400, height: 60 }, { op: 'add_slide' }),
  batch({ op: 'add_textbox', slide: 2, text: 'Appendix', left: 60, top: 60, width: 400, height: 60 }),
  batch({ op: 'move_slide', slide: 2, index: 1 }, { op: 'set_text', slide: 1, shape: 1, text: 'Moved first' }),
  batch({ op: 'duplicate_slide', slide: 1 }, { op: 'set_slide_visibility', slide: 2, visible: false }),
  batch({ op: 'set_text', slideId: 257, shapeId: 2, text: 'Selected by id' }),
  batch({ op: 'set_text', slide: 3, slideId: 256, shapeId: 2, text: 'Wrong' }),
  batch({ op: 'set_text', slideId: 999, shapeId: 2, text: 'Missing' }),
  batch({ op: 'set_text', slide: 1, shapeId: 77, text: 'Missing shape' }),
  batch({ op: 'set_text', shapeId: 2, text: 'No slide' }),
  batch({ op: 'set_notes', slide: 1, text: 'Speaker notes' }),
  batch({ op: 'add_comment', slide: 1, text: 'Remark', author: 'Ann' }),
  batch({ op: 'keep_slides', slides: [3, 1] }),
  batch({ op: 'delete_slide', slide: 2 }),
  batch({ op: 'delete_slide', slide: 9 }),
  batch({ op: 'add_slide' }, { op: 'delete_slide', slide: 1 }, { op: 'add_textbox', slide: 5, text: 'gone' }),
  batch({ op: 'constructor' }),
  batch({ op: 'toString' }),
  batch({ op: '__proto__' }),
  batch({ op: 'nothing_like_it' }),
  batch({}),
  batch(),
  batch({ op: 'z_order', slide: 1, shape: 1, command: 'front' }, { op: 'set_hyperlink', slide: 1, shape: 1, address: 'https://example.com' }),
  batch({ op: 'add_table', slide: 1, values: [['A', 'B'], ['1', '2']] }, { op: 'set_slide_background', slide: 1, color: '#102030' }, { op: 'replace_text', find: 'Appendix', replace: 'Annex' }),
]);

sequence('a duplicated slide owns its chart and an absolute relationship target is followed', [
  ...blank,
  batch(slide, { op: 'add_chart', slide: 1, chartType: 'bar', categories: ['Self-serve', 'Guided'], series: [{ name: 'Retention', values: [38, 52] }] }),
  edit('ppt/slides/_rels/slide1.xml.rels', '\\.\\./charts/chart1\\.xml', '/ppt/charts/chart1.xml'),
  batch({ op: 'duplicate_slide', slide: 1 }),
  batch({ op: 'set_chart_data', slide: 2, shape: 1, categories: ['Self-serve', 'Guided'], series: [{ name: 'Retention', values: [7, 9] }] }),
  read('ppt/slides/_rels/slide1.xml.rels'),
  read('ppt/slides/_rels/slide2.xml.rels'),
  batch({ op: 'set_chart_data', slide: 1, shape: 1, categories: ['Self-serve', 'Guided'], series: [{ name: 'Retention', values: [40, 50] }] }),
  read('ppt/charts/chart1.xml'),
  read('ppt/charts/chart2.xml'),
  batch({ op: 'add_chart', slide: 2, categories: ['a'], series: [{ values: [1] }] }),
  read('ppt/slides/_rels/slide2.xml.rels'),
]);

const sequences = [];
for (const entry of SEQUENCES) {
  const state = { zip: null };
  const outputs = [];
  for (const step of entry.steps) outputs.push(await attempt(() => runStep(state, step)));
  sequences.push({ ...entry, outputs, snapshot: state.zip ? await snapshotOf(state.zip) : null });
}
rmSync(work, { recursive: true, force: true });

writeJson(join(stage, 'golden.json'), { sequences });
writeSetManifest(stage, { set: 'office-pptx-charts', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
