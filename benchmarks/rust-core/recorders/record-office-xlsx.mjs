#!/usr/bin/env node
// Golden of the xlsx design expansion (crate mixdog-office-design, module xlsx): what Node's
// `runtime/office/design/xlsx/design-xlsx.mjs` (expandXlsxSheet, with design-xlsx-components.mjs) answers to a corpus of
// `compose_sheet` operations (the requests of xlsx-report-design.test.mjs, xlsx-design-tools.test.mjs and
// office-runtime-design.test.mjs, and the variations that reach every branch: dashboards and report sheets, metric
// cards and their figures, decision panels with gates and actions, tables with number formats, charts and the print
// set-up) over the designs and the compositions of the design layer. Writes native/core/fixtures/office-xlsx/golden.json
// and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-xlsx.mjs --tree <product tree>
//
// Every case is { input: { operation, design, composition }, value } or { input, error }: the operation list the sheet
// expands to (or the message Node throws). The designs are resolved once by Node (resolveOfficeDesign) and recorded as
// data, so the Rust expansion takes the design as an input. The output is byte-stable: the corpus is constants.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-xlsx.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const tokens = await importFrom(tree, 'src/runtime/office/design/design-tokens.mjs');
const xlsx = await importFrom(tree, 'src/runtime/office/design/xlsx/design-xlsx.mjs');
const components = await importFrom(tree, 'src/runtime/office/design/xlsx/design-xlsx-components.mjs');

const plain = (value) => JSON.parse(JSON.stringify(value));
const attempt = (run) => {
  try {
    return { value: plain(run()) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};

// ---- designs ------------------------------------------------------------------------------------------------------
const DESIGN_REQUESTS = {
  executive: {},
  editorial: { profile: 'editorial', intent: 'Quarterly review', audience: 'leaders' },
  technical: { profile: 'technical', palette: { accent: '2563EB' } },
  data: { profile: 'data', density: 'dense' },
};
const DESIGN_NAMES = Object.keys(DESIGN_REQUESTS);
const designs = Object.fromEntries(DESIGN_NAMES.map((name) => [name, plain(tokens.resolveOfficeDesign('xlsx', DESIGN_REQUESTS[name]))]));
// A design that carries its own decision, and one that turns the accent headline on.
designs.withContent = { ...designs.executive, content: { decision: '야간 전용안을 10월 운영 회의에 올린다.' }, format: { ...designs.executive.format, accentHeadline: true } };
designs.plainFormat = { ...designs.editorial, format: { title: 16, heading: 10, body: 9 } };
DESIGN_NAMES.push('withContent', 'plainFormat');

const COMPOSITIONS = [
  { id: 'monitor-dashboard' },
  { id: 'trend-dashboard' },
  { id: 'comparison-board' },
  { id: 'analysis-sheet' },
  { id: 'narrative-scorecard' },
  { id: 'executive-brief' },
  null,
];

// ---- operations ---------------------------------------------------------------------------------------------------
const HUBS = [
  ['대전', 128400, 0.928, 96],
  ['광주', 84200, 0.961, 42],
  ['부산', 99800, 0.944, 61],
];
const MONTHS = [
  ['1월', 612000, 0.041],
  ['2월', 598000, 0.039],
  ['3월', 587500, 0.037],
  ['합계', 1797500, 0.117],
];
const OPERATIONS = {
  salesComparison: {
    op: 'compose_sheet', sheet: 'Sheet1', kind: 'dashboard', title: 'Sales comparison', headers: ['Menu', 'Sales'],
    rows: [['Coffee', 30], ['Cake', 20]], insights: ['Illustrative operating data.'], decision: 'Review the sales mix.',
  },
  koreanGates: {
    op: 'compose_sheet', sheet: '결정', title: '도크 4 증설 결정', headers: ['안', '비용', '야간 대응', '판정'],
    rows: [['주간 전용', '낮음', '불가', '기각'], ['야간 전용', '중간', '가능', '채택']], metrics: [{ label: '처리량 증가', value: 1.6 }],
    decision: '야간 전용안을 10월 운영 회의에 올린다.', gates: [{ track: '야간 셔틀', release: '2대 증차 확정', stop: '증차 불가 시 보류' }],
  },
  hubDashboard: {
    op: 'compose_sheet', sheet: '야간', kind: 'dashboard', title: '10월 야간 운영 현황', headers: ['허브', '처리량', '정시 출고율', '지연 건수'], rows: HUBS,
    metrics: [{ label: '정시 출고율', value: 0.928, format: 'percent' }, { label: '야간 증원 요청', value: 12, unit: '명' }, { label: '지연 건수', value: 210 }],
    insights: ['대전 허브의 야간 처리량이 4분기 목표를 좌우합니다.'],
  },
  hubDashboardPanel: {
    op: 'compose_sheet', sheet: '야간', kind: 'dashboard', title: '10월 야간 운영 현황: 대전 허브의 처리량이 4분기 목표를 좌우합니다', subtitle: '2026년 10월, 전 허브', headers: ['허브', '처리량 (건)', '정시 출고율', '지연 건수'],
    rows: HUBS, metrics: [{ label: '정시 출고율', value: 0.928, format: 'percent', detail: '전월 대비 +1.2%p' }, { label: '야간 증원 요청', value: 12, unit: '명' }, { label: '처리량', formula: '=SUM(Hubs[처리량 (건)])' }],
    insights: ['대전 허브의 야간 처리량이 4분기 목표를 좌우합니다.', '광주 허브는 정시 출고율이 가장 높습니다.'],
    decision: { text: '야간 전용안을 10월 14일 투자심의에서 확정하고 24억 원 예산을 요청합니다. 증차는 2대부터 시작합니다.', label: '결정 요청' },
    gates: [{ track: '야간 셔틀', release: '2대 증차 확정', stop: '증차 불가 시 보류' }, ['도크 4', '착공', '지연'], ['x', 'y']], actions: ['10월 14일 투자심의 상정', '증차 계약 검토', '현장 점검', '예산 확정', '다섯째 항목'],
    source: { document: '운영관리시스템.xlsx', target: 'Hubs!A1' }, chart: { type: 'column', title: '허브별 처리량' },
  },
  wrapMetrics: {
    op: 'compose_sheet', sheet: '야간', kind: 'dashboard', title: '10월 야간 운영 현황', headers: ['허브', '처리량'], rows: [['대전', 128400], ['광주', 84200]],
    metrics: [{ label: '정시 출고율', value: 0.928, format: 'percent' }, { label: '야간 증원 요청', value: 12, unit: '명' }, { label: '지연 건수', value: 210 }],
  },
  chartBeside: {
    op: 'compose_sheet', sheet: '추이', title: '월별 야간 처리량과 지연율', subtitle: '1월 ~ 9월, 전 허브 합계', insights: ['9개월 연속 지연율이 낮아졌습니다.'],
    headers: ['월', '처리량 (건)', '지연율'], rows: MONTHS, chart: { type: 'line', title: '월별 처리량 (건)' },
  },
  chartSized: {
    op: 'compose_sheet', sheet: 'S', title: 'Throughput', headers: ['Month', 'Orders', 'Late'], rows: [['Jan', 100, 3], ['Feb', 120, 4], ['Total', 220, 7]],
    chart: { type: 'bar', width: 500, height: 200, showValues: false, seriesColors: ['112233'], zeroBaseline: false, showLegend: true, valueNumberFormat: '#,##0', title: 'Orders' },
  },
  chartPlaced: {
    op: 'compose_sheet', sheet: 'S', headers: ['a', 'b'], rows: [['x', 1], ['y', 2]], chart: { type: 'pie', left: 300, top: 40, width: 400, height: 220, range: 'A1:B3', dataLabelPosition: 'outside_end', dataLabelColor: 'FFFFFF' },
  },
  chartBars: {
    op: 'compose_sheet', sheet: 'Stores', kind: 'dashboard', title: 'Stores', headers: ['Store', 'Sales', 'Visits'],
    rows: Array.from({ length: 12 }, (_, index) => [`Store ${index + 1}`, 1000 + index * 37, 20 + index]), chart: { type: 'bar' },
  },
  chartUnits: {
    op: 'compose_sheet', sheet: 'U', title: '비용', headers: ['분기', '지출 (만 원)', '건수 (건)', '비율'], rows: [['1분기', 1200, 30, 0.4], ['2분기', 1500, 28, 0.5]], chart: { type: 'column' },
  },
  chartAfterLabel: {
    op: 'compose_sheet', sheet: 'U', headers: ['허브', '권역', '처리량', '지연'], rows: [['대전', '중부', 128400, 96], ['광주', '남부', 84200, 42]], chart: {},
  },
  chartNoNumbers: { op: 'compose_sheet', sheet: 'N', headers: ['a', 'b'], rows: [['x', 'y']], chart: { type: 'column' } },
  figureText: {
    op: 'compose_sheet', sheet: 'F', kind: 'dashboard', title: 'Figures', headers: ['a', 'b'], rows: [['x', 1]],
    metrics: [{ label: 'Growth', value: '+18%' }, { label: 'Rate', value: '92.8%', detail: 'd' }, { label: 'Count', value: '1,240' }, { label: 'Loss', value: '-3.5%', emphasis: true }, { label: 'Fifth', value: '9' }],
  },
  figureMore: {
    op: 'compose_sheet', sheet: 'F', headers: ['a'], rows: [['x']],
    metrics: [{ label: 'a', value: '0.5' }, { label: 'b', value: '1,234.50' }, { label: 'c', value: '12 units' }, { label: 'd', value: '7', unit: '건' }, { label: 'e', value: '8', numberFormat: '0.0' }],
  },
  metricOddities: {
    op: 'compose_sheet', sheet: 'M', kind: 'dashboard', headers: ['x'], rows: [[1]],
    metrics: [null, 'text', { label: 'n', value: null }, { value: true, label: 'b', detail: 'z' }, { label: 'u', value: 3, unit: 'USD', format: 'currency' }],
  },
  aggregateCards: {
    op: 'compose_sheet', sheet: 'Hubs', kind: 'dashboard', title: 'Hubs', headers: ['허브', '처리량 (건)', '지연'], rows: HUBS.map((row) => [row[0], row[1], row[3]]),
    metrics: [{ label: '합계', formula: '=SUM(Hubs[처리량 (건)])' }, { label: '평균', formula: '=AVERAGE(Hubs[처리량 (건)])' }, { label: '최대', formula: '=max( T[지연] )' }, { label: '건수', formula: '=COUNT(Hubs[허브])' }],
  },
  columnFormatsArray: { op: 'compose_sheet', sheet: 'C', headers: ['a', 'b', 'c'], rows: [['x', 1.5, 2], ['y', 2.25, 3]], columnFormats: ['@', '0.00', ''] },
  columnFormatsByHeader: { op: 'compose_sheet', sheet: 'C', headers: ['a', 'b', 'c'], rows: [['x', 1.5, 2], ['y', 2.25, 3]], columnFormats: { b: '0.0%', C: '0' } },
  columnFormatsMissed: { op: 'compose_sheet', sheet: 'C', headers: ['a', 'b'], rows: [['x', 1]], columnFormats: { zzz: '0.0' } },
  columnFormatsMissedLetters: { op: 'compose_sheet', sheet: 'C', rows: [['x', 1]], columnFormats: ['', ''] },
  columnFormatsPlainNumber: { op: 'compose_sheet', sheet: 'C', headers: ['a', 'b'], rows: [['x', 1]], columnFormats: [5, 7] },
  decimals: { op: 'compose_sheet', sheet: 'D', headers: ['a', 'b', 'c'], rows: [['x', 0.1234, 1e-7], ['y', 12, 1.5e-7]] },
  datesAndLabels: {
    op: 'compose_sheet', sheet: 'D', title: 'Dates', headers: ['월', '합계', '담당', '비고'], rows: [['2026-06-01', 100, '김서연', 'a'], ['2026-07-01', 120, '박민수', null], ['', 130, '이도윤', 'c']],
  },
  noHeaders: { op: 'compose_sheet', sheet: 'N', rows: [['a', 1], ['b', 2]], title: 'No headers' },
  rowsRagged: { op: 'compose_sheet', sheet: 'R', headers: ['a', 'b', 'c'], rows: [['x'], ['y', 2, 3, 4], 'text', [null, undefined]] },
  empty: { op: 'compose_sheet' },
  titleOnly: { op: 'compose_sheet', title: 'Only a title' },
  subtitleOnly: { op: 'compose_sheet', subtitle: 'Only a subtitle', source: 'ops.xlsx' },
  sourceOnly: { op: 'compose_sheet', source: { label: 'Ops export' } },
  sourceLabelled: { op: 'compose_sheet', title: 'T', subtitle: 'S', source: '출처: 운영관리시스템', headers: ['a'], rows: [[1]] },
  sourceNoDocument: { op: 'compose_sheet', title: 'T', source: { target: 'x' }, headers: ['a'], rows: [[1]] },
  customEyebrow: { op: 'compose_sheet', kind: 'Dashboard', title: 'Title', eyebrow: 'WEEKLY', titleSize: 24, tableName: 'my table!', tableStyle: 'TableStyleLight1', headers: ['a'], rows: [[1]], accentHeadline: false },
  longTitle: {
    op: 'compose_sheet', sheet: 'L', kind: 'dashboard', title: '다음 분기 야간 처리량이 목표를 넘어서려면 부산 허브 증설이 필요합니다 그리고 광주 허브의 정시 출고율을 유지해야 합니다',
    subtitle: 'A long English subtitle that is written in Latin letters only so that it is slanted', headers: ['a', 'b'], rows: [['x', 1]], insights: ['one', 'two two two two two two', 'three'],
  },
  decisionUnder: {
    op: 'compose_sheet', sheet: 'Plan', title: 'Plan', headers: ['Option', 'Cost'], rows: [['A', 10], ['B', 20]], decision: 'Approve option B at the October review and keep option A as the fallback for the second half.',
    gates: [['Track', 'Go', 'Stop'], { label: 'Dock', go: 'Build', hold: 'Wait' }], actions: ['Book the review', 'Prepare the budget'],
  },
  decisionActionsOnly: { op: 'compose_sheet', sheet: 'Plan', headers: ['a', 'b', 'c', 'd', 'e'], rows: [['x', 1, 2, 3, 4]], decision: 'Go.', actions: ['One', 'Two'] },
  decisionFromDesign: { op: 'compose_sheet', sheet: 'Plan', headers: ['a', 'b'], rows: [['x', 1]] },
  decisionBadType: { op: 'compose_sheet', sheet: 'Plan', decision: 5 },
  decisionObjectNoText: { op: 'compose_sheet', sheet: 'Plan', decision: { label: 'only a label' } },
  decisionTextOnly: { op: 'compose_sheet', sheet: 'Plan', kind: 'dashboard', headers: ['a', 'b'], rows: [['x', 1]], decision: { text: '  Pad  ', label: '  Name  ' } },
  gatesOnly: { op: 'compose_sheet', sheet: 'G', headers: ['a'], rows: [[1]], decision: 'D', gates: [['a', 'b', 'c'], null, 'x', { track: '' }, [1, 2, 3, 4], { title: 't' }] },
  wideDashboard: {
    op: 'compose_sheet', sheet: 'W', kind: 'dashboard', title: 'Wide', headers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], rows: [['x', 1, 2, 3, 4, 5, 6, 7]],
    metrics: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }], decision: 'D',
  },
  twoColumnDashboard: { op: 'compose_sheet', sheet: 'T', kind: 'dashboard', title: 'Two', headers: ['a', 'b'], rows: [['x', 1], ['y', 2]], metrics: [{ label: 'a', value: 1234567.5, format: 'decimal' }] },
  oneColumn: { op: 'compose_sheet', sheet: 'O', kind: 'dashboard', headers: ['a'], rows: [['x'], ['y']], metrics: [{ label: 'a', value: 5 }], chart: { type: 'column' } },
  tableAggregateMissing: { op: 'compose_sheet', sheet: 'A', kind: 'dashboard', headers: ['a', 'b'], rows: [['x', 'y']], metrics: [{ label: 'a', formula: '=SUM(T[b])' }, { label: 'c', formula: '=SUM(T[zz])' }] },
  figureTextHuge: { op: 'compose_sheet', sheet: 'A', kind: 'dashboard', headers: ['a'], rows: [['x']], metrics: [{ label: 'a', value: `1.${'1'.repeat(101)}` }] },
  noMetricsFalseDashboard: { op: 'compose_sheet', kind: 'DASHBOARD', headers: ['a', 'b'], rows: [['x', 1]] },
  sheetNameOdd: { op: 'compose_sheet', sheet: 'My Sheet', title: 'T', headers: ['a'], rows: [[1]] },
  metricsBigNumbers: {
    op: 'compose_sheet', sheet: 'B', kind: 'dashboard', headers: ['월', '값'], rows: [['1월', 1], ['2월', 2]],
    metrics: [{ label: 'a', value: 204300, unit: '건' }, { label: 'b', value: -1234.5, numberFormat: '#,##0.0' }, { label: 'c', value: 0.0004, numberFormat: '0.00%' }],
  },
};
const OPERATION_NAMES = Object.keys(OPERATIONS);
const CORE = new Set([
  'salesComparison', 'koreanGates', 'hubDashboard', 'hubDashboardPanel', 'wrapMetrics', 'chartBeside', 'chartSized', 'chartBars', 'figureText', 'datesAndLabels', 'decisionUnder',
  'longTitle', 'aggregateCards', 'wideDashboard', 'oneColumn', 'metricsBigNumbers',
]);

const cases = [];
OPERATION_NAMES.forEach((name, index) => {
  const operation = OPERATIONS[name];
  const designName = DESIGN_NAMES[index % DESIGN_NAMES.length];
  const compositions = CORE.has(name) ? COMPOSITIONS : [COMPOSITIONS[index % COMPOSITIONS.length], COMPOSITIONS[(index + 3) % COMPOSITIONS.length]];
  // The decision a design carries is read when the operation names none.
  const designed = name === 'decisionFromDesign' ? ['withContent'] : [designName];
  for (const design of designed) {
    for (const composition of compositions) {
      cases.push({
        input: { name, operation: plain(operation), design, composition },
        ...attempt(() => xlsx.expandXlsxSheet(plain(operation), designs[design], composition ?? undefined)),
      });
    }
  }
});

// Every design for one operation: the faces, colours and sizes each pack gives the same sheet.
for (const design of DESIGN_NAMES) {
  for (const name of ['hubDashboardPanel', 'chartBeside', 'decisionUnder']) {
    cases.push({
      input: { name, operation: plain(OPERATIONS[name]), design, composition: COMPOSITIONS[0] },
      ...attempt(() => xlsx.expandXlsxSheet(plain(OPERATIONS[name]), designs[design], COMPOSITIONS[0])),
    });
  }
}

// ---- the helpers of the components module --------------------------------------------------------------------------
const TEXTS = [
  ['', 10, 480], ['a', 10, 480], ['abcdefghijklmnop', 10, 480], ['한'.repeat(100), 10, 480], ['a\nb\nc', 12, 300], ['10월 14일 투자심의에서 확정합니다', 15, 120],
  ['야간 전용안을 10월 운영 회의에 올린다. 증차 계약은 24억 원 예산 안에서 12만 6천 원 단위로 검토합니다.', 15, 200], ['word '.repeat(80), 11, 360], ['x', 10, 0], ['y y', 10, 'bad'],
  ['日本語のテキストと English mixed 한국어', 18, 150], ['one two three four five six seven', 14, 100], ['  leading and  double  spaces ', 10, 90],
];
const heights = TEXTS.map(([text, size, canvas]) => ({ input: { text, size, canvas }, ...attempt(() => components.bandHeight(text, size, canvas)) }));
const wraps = TEXTS.map(([text, size, canvas]) => ({ input: { text, size, canvas }, ...attempt(() => components.wrapWords(text, size, canvas)) }));

const out = {
  note: 'Recorded from the Node xlsx design modules; tests/twin_xlsx.rs replays it.',
  designs,
  compositions: COMPOSITIONS,
  cases,
  bandHeights: heights,
  wrapWords: wraps,
};

const fixtures = path.join(FIXTURES_ROOT, 'office-xlsx');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-xlsx', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes, ${cases.length} cases`);
