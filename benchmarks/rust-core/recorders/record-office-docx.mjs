#!/usr/bin/env node
// Golden of the docx design expansion (crate mixdog-office-design, module docx): what Node's
// `runtime/office/design/docx/` modules (design-docx, design-docx-components, design-docx/front-matter, section, writer
// and document-typography) answer to a fixed corpus of compose_document operations, designs and compositions: the
// operation lists as exact data (the docx writer consumes them), the counters of the shared state, the refusals, and the
// functions the xlsx composer and the callers reach alone (documentTypography, koreanDesign, pairTableEastAsia, the
// callout, the strip, the roadmap and the section table). Writes native/core/fixtures/office-docx/golden.json and the
// set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-docx.mjs --tree <product tree>
//
// The designs the cases use are recorded with them (resolved by Node's design-tokens, or written here as literals), so
// the Rust replay takes them as inputs and does not depend on the design resolver. Every section is a list of cases
// { input, ...output }; an entry that throws is recorded as { error: message }. The output is byte-stable: the corpus is
// constants and keys are written in the order the modules produce them.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-docx.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const load = (name) => importFrom(tree, `src/runtime/office/design/${name}`);

const docx = await load('docx/design-docx.mjs');
const components = await load('docx/design-docx-components.mjs');
const typography = await load('docx/document-typography.mjs');
const tokens = await load('design-tokens.mjs');

const attempt = (run) => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
// A value as the corpus writes it: what JSON keeps.
const plain = (value) => JSON.parse(JSON.stringify(value));
// Only what the expansion reads: the design's tokens and format.
const resolve = (request) => {
  const design = plain(tokens.resolveOfficeDesign('docx', request, { library: null }));
  return { tokens: design.tokens, format: design.format };
};

// ---- designs ------------------------------------------------------------------------------------------------------
const SPARSE_COLORS = { ink: '111111', accent: '0055AA', muted: '777777' };
const DESIGNS = {
  default: resolve({}),
  editorial: resolve({ profile: 'editorial' }),
  executive: resolve({ profile: 'executive' }),
  technical: resolve({ profile: 'technical' }),
  data: resolve({ profile: 'data' }),
  korean: resolve({ intent: '분기 운영 보고서', typography: { display: 'Cambria', body: 'Calibri', data: 'Arial' } }),
  sparse: {
    tokens: { typography: { body: 'Calibri' }, colors: SPARSE_COLORS },
    format: { title: 28, heading1: 16, heading2: 12, body: 10, margin: 54 },
  },
  serifBody: {
    tokens: {
      typography: { display: 'Georgia', body: 'Times New Roman', data: 'Courier New' },
      colors: { ...DESIGNS_COLORS(), positiveWeak: 'E1F4EB', positiveText: '396951', criticalWeak: 'F4E3E1', criticalText: '71413D' },
    },
    format: { title: 20, heading1: 15, heading2: 11.5, body: 11, margin: 72 },
  },
  oddFormat: {
    tokens: { typography: { display: 'Aptos', body: 'Aptos', data: 'Aptos' }, colors: DESIGNS_COLORS() },
    format: { title: 31.7, heading1: 17.3, heading2: 12.9, body: 9.3, margin: 49.9 },
  },
};
function DESIGNS_COLORS() {
  return {
    canvas: 'FFFFFF', ink: '17221C', muted: '5A635F', accent: '1F7A55', accent2: 'D89224', surface: 'E8F1EC', surface2: 'DDE4DF',
    inverse: '132C24', onAccent: 'FFFFFF', onInverse: 'FFFFFF',
  };
}
const designNames = Object.keys(DESIGNS);

// ---- compose_document operations ----------------------------------------------------------------------------------
const TABLE = [['항목', '대기 (분)', '비율', '비고'], ['북부', 38, '-4.2%', '증가'], ['남부', 21, '₩740,000', '유지'], ['중부', 0, '1.6배', '감소']];
const SECTION_TABLES = {
  array: [['Name', 'Qty'], ['a', 1], ['b', 22]],
  object: { headers: ['지표', '값', '비고'], rows: [['정시율', '92%', '양호'], ['처리량', '1,200건', '보통'], ['지연', '-3분', '개선']] },
  figures: [['Region', 'Revenue', 'Growth', 'Count'], ['N', '(1,200)', '+4%p', '12건'], ['S', '₩740,000', '−4.2%', '2.6억 원'], ['E', '1.6배', '38', '$5']],
  mixedFigures: [['A', 'B'], ['x', '12'], ['y', 'n/a']],
  ragged: [['A', 'B', 'C'], ['1'], ['2', '3', '4', '5']],
  single: [['One'], ['two']],
  metrics: [['지표', '값', '증차 후'], ['대기', '18분', '7분'], ['정시율', '92%', '97%'], ['처리량', '1,200건', '1,500건']],
  metricsNoHeader: [['지표', '값', ''], ['대기', '18분', '7분'], ['정시율', '92%', ''], ['처리량', '1,200건', '1,500건'], ['지연', '5%', '3%'], ['오류', '1%', '0%'], ['x', 'y', 'z']],
  metricsShort: [['지표', '값', '증차 후'], ['대기', '18분', '7분'], ['정시율', '92%', '97%']],
  metricsTwoColumns: [['a', 'b'], ['1', '2'], ['3', '4'], ['5', '6']],
  gates: [['게이트', '통과', '중단'], ['품질', '결함 0', '결함 3 이상'], ['일정', '1주 이내', '2주 초과']],
};
const STEPS = {
  objects: [{ title: '준비', detail: '자료 수집' }, { title: '실행', detail: '시범 운영', label: 'Week 2' }, { title: '검토', body: '결과 확인', phase: 'P3' }, { title: '확정', week: 'W4' }],
  strings: ['1주: 계획 수립', '2주：시범 운영', 'No label here', '이 라벨은 열여덟 글자를 넘기 때문에 쓰이지 않습니다: x'],
  mixed: [{ title: 'A' }, 'B: b', 5, null, '', { detail: 'only detail' }, [1, 2], true],
  wideLabel: [{ title: 'x', label: '야간 교대 추가 운영 계획' }, { title: 'y', label: 'abc' }],
  empty: [{}, '', null],
};
const SECTIONS = {
  plain: { heading: 'Overview', paragraphs: ['First paragraph.', 'Second paragraph.'] },
  titleOnly: { title: 'From title', body: 'Body text only' },
  bodyString: { heading: 'B', body: 'single body' },
  eyebrow: { eyebrow: 'PART ONE', heading: 'Eyebrow heading', paragraphs: ['p'], pageBreak: true },
  pageBreak: { heading: 'Break', pageBreak: true, paragraphs: ['after the break'] },
  level2: { heading: 'Sub', level: 2, accent: true, paragraphs: ['sub text'] },
  level2String: { heading: 'Sub', level: '2', eyebrow: 'E' },
  noHeading: { paragraphs: ['no heading here'] },
  bulletsShort: { heading: 'Short', bullets: ['one', 'two', 'three'] },
  bulletsLong: { heading: 'Long', bullets: ['1', '2', '3', '4', '5', '6', '7', '8'] },
  bulletsSix: { heading: 'Six', bullets: ['1', '2', '3', '4', '5', '6'] },
  bulletsSeven: { heading: 'Seven', bullets: ['1', '2', '3', '4', '5', '6', '7'] },
  bulletsMixed: { heading: 'Mixed', bullets: ['a', '', null, 3, ['x', 'y']] },
  bulletsWithTable: { heading: 'List then table', bullets: ['x', 'y'], table: SECTION_TABLES.array },
  bulletsWithCallout: { heading: 'List then callout', bullets: ['x', 'y'], callout: 'Decide now' },
  bulletsWithQuote: { heading: 'List then quote', bullets: ['x'], quote: 'Quoted', table: SECTION_TABLES.array },
  roadmapKind: { heading: 'Plan', kind: 'roadmap', bullets: ['1주: 설계', '2주: 구현', '3주: 검증'] },
  roadmapKindUpper: { heading: 'Plan', kind: '  ROADMAP ', bullets: ['a: b'] },
  roadmapEmptyBullets: { heading: 'Plan', kind: 'roadmap' },
  stepsObjects: { heading: '실행 계획', steps: STEPS.objects },
  stepsStrings: { heading: 'Steps', steps: STEPS.strings },
  stepsMixed: { heading: 'Mixed steps', steps: STEPS.mixed },
  stepsWide: { heading: 'Wide', steps: STEPS.wideLabel },
  stepsUnreadable: { heading: 'Bad steps', steps: STEPS.empty },
  stepsUnreadableNoHeading: { steps: [{}] },
  stepsNotList: { heading: 'x', steps: 'text', bullets: ['k'] },
  quote: { heading: 'Quote', quote: 'Short quote.' },
  quoteBy: { heading: 'Quote', quote: 'Short quote.', quoteBy: 'Someone' },
  quoteByDashed: { heading: 'Quote', quote: 'Quote', quoteBy: ' — – - Dashed Name' },
  quoteKorean: { heading: '인용', quote: '한 줄 인용문입니다.', quoteBy: '홍길동' },
  quoteKana: { heading: 'q', quote: 'これは引用です', quoteBy: 'x' },
  quoteNumber: { heading: 'q', quote: 42 },
  tableArray: { heading: 'T', table: SECTION_TABLES.array },
  tableObject: { heading: 'T', table: SECTION_TABLES.object },
  tableFigures: { heading: 'T', table: SECTION_TABLES.figures },
  tableMixedFigures: { heading: 'T', table: SECTION_TABLES.mixedFigures },
  tableRagged: { heading: 'T', table: SECTION_TABLES.ragged },
  tableSingle: { heading: 'T', table: SECTION_TABLES.single },
  tableKorean: { heading: '표', table: TABLE },
  // `tableStyle` is not a field a section may carry (only the operation names one): the section is refused.
  tableStyle: { heading: 'T', table: SECTION_TABLES.array, tableStyle: 'Light Grid Accent 1' },
  tableMetrics: { heading: 'M', kind: 'metrics', table: SECTION_TABLES.metrics },
  tableMetricsNoHeader: { heading: 'M', kind: 'metrics', table: SECTION_TABLES.metricsNoHeader },
  tableMetricsShort: { heading: 'M', kind: 'metrics', table: SECTION_TABLES.metricsShort },
  tableMetricsTwo: { heading: 'M', kind: 'metrics', table: SECTION_TABLES.metricsTwoColumns },
  tableGates: { heading: 'G', kind: 'gates', table: SECTION_TABLES.gates },
  tableDecisionGates: { heading: 'G', kind: 'decision-gates', table: SECTION_TABLES.gates },
  tableGatesTwoColumns: { heading: 'G', kind: 'gates', table: SECTION_TABLES.array },
  tableScorecard: { heading: 'S', kind: 'scorecard', table: SECTION_TABLES.object },
  tableRoadmap: { heading: 'R', kind: 'roadmap', table: [['1주', '설계'], ['2주', '구현']], bullets: ['ignored: because steps drew'] },
  tableCallout: { heading: 'C', kind: 'callout', table: SECTION_TABLES.array },
  tableUnknownKind: { heading: 'U', kind: 'Whatever', table: SECTION_TABLES.array },
  tableWithSource: { heading: 'T', table: SECTION_TABLES.array, source: '자료: 내부 집계' },
  tableWithSourceAndCallout: { heading: 'T', table: SECTION_TABLES.array, source: 'src', callout: 'Boxed' },
  tableWithCallout: { heading: 'T', table: SECTION_TABLES.array, callout: 'Boxed after table' },
  tableWithCalloutLabel: { heading: 'T', table: SECTION_TABLES.array, callout: 'Boxed', calloutLabel: '다음 단계', calloutTone: 'warning' },
  tableWithQuoteAndCallout: { heading: 'T', quote: 'q', table: SECTION_TABLES.array, callout: 'c' },
  sourceOnly: { heading: 'S', paragraphs: ['p'], source: 'Source line' },
  calloutOnly: { heading: 'C', callout: 'Decide by Friday' },
  calloutLabel: { heading: 'C', callout: 'Decide by Friday', calloutLabel: 'Decision' },
  calloutPositive: { heading: 'C', callout: 'Go', calloutLabel: 'Verdict', calloutTone: 'positive' },
  calloutCritical: { heading: 'C', callout: 'Stop', calloutTone: 'critical' },
  calloutInformative: { heading: 'C', callout: 'FYI', calloutTone: 'informative' },
  calloutBadTone: { heading: 'C', callout: 'x', calloutTone: 'inverse' },
  calloutNumber: { heading: 'C', callout: 12 },
  everything: {
    eyebrow: 'E', heading: 'All', level: 1, accent: true, pageBreak: true, kind: 'metrics', paragraphs: ['p1', 'p2'], bullets: ['b1', 'b2'],
    quote: 'q', quoteBy: 'by', table: SECTION_TABLES.metrics, source: 'src', callout: 'call', calloutLabel: 'label', calloutTone: 'positive',
  },
  unknownField: { heading: 'U', roadmap: [{ title: 'x' }] },
  unknownFields: { heading: 'U', z: 1, 2: 'a', a: 2, 1: 'b' },
  tableBad: { heading: 'T', table: ['a', 'b'] },
  tableBadShape: { heading: 'T', table: { cells: [] } },
  tableBadRows: { heading: 'T', table: { rows: 'x' } },
  tableEmptyObject: { heading: 'T', table: { headers: [], rows: [] } },
  tableNull: { heading: 'T', table: null },
  tableEmptyArray: { heading: 'T', table: [], source: 'only source' },
  empty: {},
};
const METRICS = {
  four: [
    { label: '정시율', value: 0.928, format: 'percent', detail: '전월 대비 +2%p' },
    { label: 'Orders', value: 47210, unit: 'orders' },
    { label: '인원', value: 12, unit: '명', emphasis: true },
    { label: 'Score', value: 4.5, numberFormat: '0.00' },
  ],
  noDetails: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }],
  one: [{ label: 'Only', value: 1234567.891, detail: 'd' }],
  five: [1, 2, 3, 4, 5].map((n) => ({ label: `m${n}`, value: n * 1000 })),
  formats: [
    { label: 'pct', value: 0.5, numberFormat: '0.00%' },
    { label: 'plain', value: 1234.5, numberFormat: '0.0' },
    { label: 'grouped', value: 1234567, numberFormat: '#,##0' },
    { label: 'money', value: 9876.54, format: 'currency' },
    { label: 'dec', value: 3.14159, format: 'decimal' },
  ],
  strange: [
    { label: 'neg', value: -1234.5678 },
    { label: 'zero', value: 0 },
    { label: 'big', value: 1e21 },
    { label: 'sum', value: 0.1 + 0.2 },
    { label: 'tiny', value: 1.005, numberFormat: '0.00' },
  ],
  textValues: [
    { label: 'text', value: 'n/a', unit: 'x' },
    { label: 'nullv', value: null },
    { label: 'novalue' },
    { label: 'bool', value: true },
    { label: 'arr', value: [1, 2] },
    { label: 'str number', value: '42', unit: '(units)' },
  ],
  rounding: [
    { label: 'a', value: 2.5, numberFormat: '0' },
    { label: 'b', value: -2.5, numberFormat: '0' },
    { label: 'c', value: -0.001, numberFormat: '0.00' },
    { label: 'd', value: 8.345, numberFormat: '0.00' },
    { label: 'e', value: 999.995, numberFormat: '0.00' },
  ],
  odd: [null, 7, 'x', { emphasis: true, label: 'second leads' }, { label: 'late', emphasis: true }],
  emphasisSecond: [{ label: 'a', value: 1 }, { label: 'b', value: 2, emphasis: true }, { label: 'c', value: 3, emphasis: true }],
  unitSpaces: [{ label: 'a', value: 1, unit: '  개  ' }, { label: 'b', value: 2, unit: ' Orders ' }, { label: 'c', value: 3, unit: '%' }],
  tooManyDecimals: [{ label: 'a', value: 1, numberFormat: `0.${'0'.repeat(101)}` }],
  manyDecimals: [{ label: 'a', value: 1.5, numberFormat: `0.${'0'.repeat(100)}` }],
  empty: [],
  notAList: 'x',
};
const OPERATIONS = {
  bare: { op: 'compose_document' },
  titleOnly: { op: 'compose_document', title: 'Report' },
  titleNumber: { op: 'compose_document', title: 0, subtitle: false },
  titleEmpty: { op: 'compose_document', title: '', subtitle: '', eyebrow: '', summary: '' },
  front: {
    op: 'compose_document', eyebrow: 'Q3 REVIEW', title: 'Quarterly operations review', subtitle: 'What changed and what we do next',
    meta: ['Prepared by Ops', '2026-11-15', 'Confidential'], summary: ['Throughput is up.', 'Waiting time is down.'],
  },
  frontOneMeta: { op: 'compose_document', title: 'T', meta: 'single meta' },
  frontMetaList: { op: 'compose_document', title: 'T', meta: ['a', '', null, 'b'] },
  summaryLabel: { op: 'compose_document', title: 'T', summary: '결론: 증차 승인', summaryLabel: '결론' },
  summaryLabelNumber: { op: 'compose_document', title: 'T', summary: 's', summaryLabel: 7 },
  summaryEmptyList: { op: 'compose_document', title: 'T', summary: [], summaryLabel: 'L' },
  summaryTruthyEmpty: { op: 'compose_document', title: 'T', summary: [[]], summaryLabel: 'L' },
  noPage: { op: 'compose_document', title: 'T', page: false },
  pageNull: { op: 'compose_document', title: 'T', page: null },
  landscape: { op: 'compose_document', title: 'T', orientation: 'landscape' },
  orientationEmpty: { op: 'compose_document', title: 'T', orientation: '' },
  titleSize: { op: 'compose_document', title: 'T', titleSize: 30 },
  titleSizeString: { op: 'compose_document', title: 'T', titleSize: '22.4' },
  titleSizeZero: { op: 'compose_document', title: 'T', titleSize: 0 },
  titleSizeBad: { op: 'compose_document', title: 'T', titleSize: 'x' },
  titleSizeNull: { op: 'compose_document', title: 'T', titleSize: null },
  titleSizeFraction: { op: 'compose_document', title: 'T', titleSize: 17.3 },
  metricsFour: { op: 'compose_document', title: 'T', metrics: METRICS.four },
  metricsNoDetails: { op: 'compose_document', title: 'T', metrics: METRICS.noDetails },
  metricsOne: { op: 'compose_document', title: 'T', metrics: METRICS.one },
  metricsFive: { op: 'compose_document', title: 'T', metrics: METRICS.five },
  metricsFormats: { op: 'compose_document', title: 'T', metrics: METRICS.formats },
  metricsStrange: { op: 'compose_document', title: 'T', metrics: METRICS.strange },
  metricsText: { op: 'compose_document', title: 'T', metrics: METRICS.textValues },
  metricsRounding: { op: 'compose_document', title: 'T', metrics: METRICS.rounding },
  metricsOdd: { op: 'compose_document', title: 'T', metrics: METRICS.odd },
  metricsEmphasisSecond: { op: 'compose_document', title: 'T', metrics: METRICS.emphasisSecond },
  metricsUnitSpaces: { op: 'compose_document', title: 'T', metrics: METRICS.unitSpaces },
  metricsTooManyDecimals: { op: 'compose_document', title: 'T', metrics: METRICS.tooManyDecimals },
  metricsManyDecimals: { op: 'compose_document', title: 'T', metrics: METRICS.manyDecimals },
  metricsEmpty: { op: 'compose_document', title: 'T', metrics: METRICS.empty },
  metricsNotAList: { op: 'compose_document', title: 'T', metrics: METRICS.notAList },
  footerOnly: { op: 'compose_document', title: 'T', footer: 'Confidential' },
  footerNumber: { op: 'compose_document', title: 'T', footer: 5 },
  pageNumbers: { op: 'compose_document', title: 'T', pageNumbers: true },
  pageNumbersFooter: { op: 'compose_document', title: 'T', pageNumbers: true, footer: 'Confidential' },
  pageNumbersTruthy: { op: 'compose_document', title: 'T', pageNumbers: 'yes', footer: 'F' },
  namedEastAsia: { op: 'compose_document', title: '한글 제목', nameEastAsia: 'Yu Gothic', sections: [SECTIONS.tableKorean, SECTIONS.calloutLabel] },
  namedEastAsiaLatin: { op: 'compose_document', title: 'Latin title', nameEastAsia: 'Yu Gothic', sections: [SECTIONS.tableArray, SECTIONS.calloutLabel] },
  namedEastAsiaNumber: { op: 'compose_document', title: 'T', nameEastAsia: 5, sections: [SECTIONS.tableArray] },
  languageKo: { op: 'compose_document', title: 'Latin only', language: 'ko', sections: [SECTIONS.tableArray, SECTIONS.calloutLabel] },
  languageKoKr: { op: 'compose_document', title: 'Latin only', language: 'ko-KR', sections: [SECTIONS.tableArray] },
  languageUpper: { op: 'compose_document', title: 'Latin only', language: 'KO-kr', sections: [SECTIONS.tableArray] },
  languageNotKo: { op: 'compose_document', title: 'Latin only', language: 'korean', sections: [SECTIONS.tableArray] },
  languageKoX: { op: 'compose_document', title: 'Latin only', language: 'kox', sections: [SECTIONS.tableArray] },
  languageEn: { op: 'compose_document', title: 'Latin only', language: 'en-US', sections: [SECTIONS.tableArray] },
  hangulInSection: { op: 'compose_document', title: 'Latin only', sections: [{ heading: 'H', paragraphs: ['안녕'], table: SECTION_TABLES.array, callout: 'c' }] },
  hangulInKey: { op: 'compose_document', title: 'T', sections: [{ heading: 'H' }], summary: 'ㄱ' },
  tableStyleOperation: { op: 'compose_document', title: 'T', tableStyle: 'Medium Shading 1', sections: [SECTIONS.tableArray, SECTIONS.tableGates, SECTIONS.tableMetrics, SECTIONS.tableScorecard] },
  tableStyleNumber: { op: 'compose_document', title: 'T', tableStyle: 5, sections: [SECTIONS.tableArray] },
  sectionsNotAList: { op: 'compose_document', title: 'T', sections: 'x' },
  sectionsNull: { op: 'compose_document', title: 'T', sections: null },
  sectionNull: { op: 'compose_document', title: 'T', sections: [SECTIONS.plain, null] },
  sectionString: { op: 'compose_document', title: 'T', sections: ['abc'] },
  sectionEmptyString: { op: 'compose_document', title: 'T', sections: [''] },
  sectionNumber: { op: 'compose_document', title: 'T', sections: [5, 0, false, true] },
  sectionArray: { op: 'compose_document', title: 'T', sections: [['a', 'b']] },
  sectionEmptyArray: { op: 'compose_document', title: 'T', sections: [[]] },
  sectionAstral: { op: 'compose_document', title: 'T', sections: ['😀'] },
  full: {
    op: 'compose_document', eyebrow: 'OPERATIONS', title: '분기 운영 보고서', subtitle: '정시율과 대기 시간의 변화', meta: ['운영팀', '2026-11-15'],
    summary: '증차를 승인하면 대기 시간이 7분으로 줄어든다.', summaryLabel: '결론', metrics: METRICS.four, pageNumbers: true, footer: '대외비',
    sections: [SECTIONS.eyebrow, SECTIONS.stepsObjects, SECTIONS.tableMetrics, SECTIONS.bulletsLong, SECTIONS.quoteKorean, SECTIONS.tableWithSourceAndCallout, SECTIONS.level2, SECTIONS.calloutPositive],
  },
  fullLatin: {
    op: 'compose_document', eyebrow: 'OPERATIONS', title: 'Quarterly operations review', subtitle: 'On-time rate and waiting time', meta: ['Ops team'],
    summary: 'Approving the extra trucks cuts the wait to 7 minutes.', metrics: METRICS.noDetails, pageNumbers: true, footer: 'Confidential',
    sections: [SECTIONS.plain, SECTIONS.roadmapKind, SECTIONS.tableFigures, SECTIONS.quoteBy, SECTIONS.tableGates, SECTIONS.calloutCritical],
  },
  everySection: { op: 'compose_document', title: 'Sections', sections: Object.values(SECTIONS).filter((section) => !['unknownField', 'unknownFields', 'tableBad', 'tableBadShape', 'tableBadRows', 'tableEmptyObject', 'stepsUnreadable', 'stepsUnreadableNoHeading', 'tableStyle'].some((name) => SECTIONS[name] === section)) },
};
for (const [name, section] of Object.entries(SECTIONS)) OPERATIONS[`section_${name}`] = { op: 'compose_document', title: 'T', sections: [section] };

const COMPOSITIONS = [null, { id: 'decision-brief' }, { id: 'compact-memo' }, { id: 'editorial-report' }, { id: 'evidence-brief' }, { id: 'unknown' }, { id: '' }, {}];
const STATES = [{ paragraph: 0, table: 0 }, { paragraph: 7, table: 3 }];

const expandCase = (operationName, designName, composition, state) => {
  const run = { paragraph: state.paragraph, table: state.table };
  const result = attempt(() => plain(docx.expandDocxDocument(OPERATIONS[operationName], DESIGNS[designName], run, composition ?? undefined)));
  return { input: { operation: operationName, design: designName, composition, state }, ...result, state: run };
};
const expand = [];
// Every operation under the default design and decision brief, so each branch of the writer is drawn once.
for (const name of Object.keys(OPERATIONS)) expand.push(expandCase(name, 'default', null, STATES[0]));
// The compositions change margins, sizes and spacing: every one over the operations that carry the most.
for (const name of ['full', 'fullLatin', 'front', 'summaryLabel', 'metricsFour', 'section_everything', 'section_bulletsLong', 'section_quoteBy', 'section_tableWithSource']) {
  for (const composition of COMPOSITIONS.slice(1)) expand.push(expandCase(name, 'default', composition, STATES[0]));
}
for (const composition of [COMPOSITIONS[2], COMPOSITIONS[3]]) expand.push(expandCase('everySection', 'default', composition, STATES[0]));
// Every design (profiles, literals with missing tokens) over the full operations, with and without a carried state.
for (const designName of designNames.filter((name) => name !== 'default')) {
  for (const name of ['full', 'summaryLabel', 'metricsFour', 'section_calloutPositive', 'section_tableGates', 'section_stepsObjects']) {
    expand.push(expandCase(name, designName, COMPOSITIONS[designNames.indexOf(designName) % COMPOSITIONS.length], STATES[1]));
  }
}
for (const name of ['full', 'section_tableMetrics']) expand.push(expandCase(name, 'default', { id: 'compact-memo' }, STATES[1]));

// ---- the carriers alone -------------------------------------------------------------------------------------------
const CALLOUT_CASES = [
  { text: 'Decide by Friday', design: 'default', options: {} },
  { text: 'Decide by Friday', design: 'default', options: { label: '결정', emphasis: 'accent', eastAsia: 'Malgun Gothic' } },
  { text: 'Go', design: 'default', options: { label: 'Verdict', emphasis: 'positive' } },
  { text: 'Watch', design: 'default', options: { emphasis: 'warning', eastAsia: 'Batang' } },
  { text: 'Stop', design: 'default', options: { label: 'Stop', emphasis: 'critical' } },
  { text: 'FYI', design: 'default', options: { emphasis: 'informative' } },
  { text: 'x', design: 'default', options: { emphasis: 'unknown' } },
  { text: 'x', design: 'default', options: { label: null, emphasis: null, eastAsia: null } },
  { text: 'x', design: 'sparse', options: { label: 'L', emphasis: 'positive' } },
  { text: 'x', design: 'sparse', options: { emphasis: 'accent' } },
  { text: 'x', design: 'serifBody', options: { label: 'L', emphasis: 'critical', eastAsia: 'Batang' } },
  { text: 'x', design: 'serifBody', options: { emphasis: 'warning' } },
  { text: 'x', design: 'oddFormat', options: { label: 'L' } },
  { text: '', design: 'default', options: { label: 'L' } },
];
const callout = CALLOUT_CASES.map((input) => {
  const output = [];
  const state = { paragraph: 2, table: 1 };
  const result = attempt(() => {
    components.addDocxDecisionCallout(output, state, input.text, DESIGNS[input.design], input.options);
    return plain(output);
  });
  return { input, ...result, state };
});
const STRIP_CASES = Object.keys(METRICS).flatMap((metrics) => ['default', 'sparse', 'serifBody'].map((design) => ({ metrics, design })));
const strip = STRIP_CASES.map((input) => {
  const output = [];
  const state = { paragraph: 0, table: 0 };
  const result = attempt(() => ({ drew: components.addDocxMetricStrip(output, state, METRICS[input.metrics], DESIGNS[input.design]), operations: plain(output) }));
  return { input, ...result, state };
});
const ROADMAP_CASES = [...Object.keys(STEPS).map((steps) => ({ steps: STEPS[steps], name: steps })), { steps: 'text', name: 'text' }, { steps: null, name: 'null' }, { steps: [], name: 'emptyList' }].flatMap((entry) =>
  ['default', 'sparse'].map((design) => ({ ...entry, design }))
);
const roadmap = ROADMAP_CASES.map((input) => {
  const output = [];
  const state = { paragraph: 0, table: 0 };
  const result = attempt(() => ({ drew: components.addDocxRoadmap(output, state, input.steps, DESIGNS[input.design]), operations: plain(output) }));
  return { input, ...result, state };
});
const TABLE_VARIANTS = ['default', 'metrics', 'gates', 'decision-gates', 'scorecard', 'roadmap', 'callout', '', 'other'];
const tableCases = [];
for (const [tableName, values] of Object.entries(SECTION_TABLES)) {
  const rows = Array.isArray(values) ? values : [values.headers, ...values.rows];
  for (const variant of TABLE_VARIANTS) {
    tableCases.push({ table: tableName, values: rows, variant, style: '', design: 'default' });
  }
  tableCases.push({ table: tableName, values: rows, variant: 'default', style: 'Light List', design: 'sparse' });
  tableCases.push({ table: tableName, values: rows, variant: 'gates', style: '', design: 'sparse' });
  tableCases.push({ table: tableName, values: rows, variant: 'gates', style: '', design: 'serifBody' });
}
tableCases.push({ table: 'none', values: [], variant: 'default', style: '', design: 'default' });
const sectionTable = tableCases.map((input) => {
  const output = [];
  const state = { paragraph: 0, table: 0 };
  const result = attempt(() => ({
    drew: components.addDocxSectionTable(output, state, input.values, DESIGNS[input.design], input.variant, { style: input.style }),
    operations: plain(output),
  }));
  return { input, ...result, state };
});
const sectionTableDefaults = [{ values: SECTION_TABLES.array }, { values: SECTION_TABLES.metrics }].map((input) => {
  const output = [];
  const state = { paragraph: 0, table: 0 };
  const result = attempt(() => ({ drew: components.addDocxSectionTable(output, state, input.values, DESIGNS.default), operations: plain(output) }));
  return { input, ...result, state };
});

// ---- typography ---------------------------------------------------------------------------------------------------
const FACES = ['Cambria', 'Georgia', ' bookman old style ', 'Times New Roman', 'Garamond', 'Book Antiqua', 'Palatino Linotype', 'Constantia', 'Calibri', 'Arial', 'Malgun Gothic', 'Batang', 'Cambria Math', '', null, undefined, 5, 'CAMBRIA', 'Segoe UI', 'Aptos', 'Courier New', 'BooKman Old Style'];
const TYPE_OPERATIONS = [
  {},
  { title: 'Latin' },
  { title: '한글' },
  { title: 'Latin', subtitle: '부제' },
  { title: 'Latin', summary: ['요약'] },
  { title: 'Latin', sections: [{ heading: '제목' }] },
  { title: 'Latin', language: 'ko' },
  { title: 'Latin', language: 'ko-KR' },
  { title: 'Latin', language: 'KO' },
  { title: 'Latin', language: 'kor' },
  { title: 'Latin', language: 'ko_KR' },
  { title: 'Latin', language: 5 },
  { title: '한글', nameEastAsia: 'Yu Gothic' },
  { title: 'Latin', nameEastAsia: 'Yu Gothic' },
  { title: 'Latin', nameEastAsia: '' },
  { title: '한글', nameEastAsia: '' },
  { title: 'Latin', nameEastAsia: 5 },
  { title: 'ㄱ' },
  { title: 'ᄀ' },
  { title: 'ᇿ' },
  { title: '㄰' },
  { title: '㆏' },
  { title: '가' },
  { title: '힯' },
  { title: 'あ' },
  { title: '中文' },
  { eyebrow: '한글', title: 'Latin' },
  { title: 'Latin', meta: ['한글'] },
];
const TYPOGRAPHIES = [{ display: 'Cambria', body: 'Calibri', data: 'Arial' }, { body: 'Georgia' }, {}, null, undefined, 'text'];
const documentTypography = [];
for (const operation of TYPE_OPERATIONS) {
  for (const faces of TYPOGRAPHIES) {
    const result = attempt(() => {
      const type = typography.documentTypography(operation, faces);
      return plain({ eastAsia: type.eastAsia || null, display: type.display ?? null, body: type.body ?? null, data: type.data ?? null, eastAsiaFor: FACES.map((face) => type.eastAsiaFor(face) || null) });
    });
    documentTypography.push({ input: { operation, typography: faces === undefined ? { omitted: true } : faces }, ...result });
  }
}
const KOREAN_DESIGN_TEXTS = ['', 'latin only', '안녕', 'ㄱ', 'ᄀ', '中文', 'あ', 'mixed 한글 text'];
const KOREAN_DESIGNS = {
  default: DESIGNS.default,
  sparse: DESIGNS.sparse,
  serifBody: DESIGNS.serifBody,
  odd: { tokens: { typography: { display: 'cambria', body: ' Segoe UI ', data: 'Consolas', extra: 'Aptos', blank: '', number: 5, nothing: null } } },
  noTypography: { tokens: { colors: {} } },
  noTokens: {},
  emptyTypography: { tokens: { typography: {} } },
  numericKeys: { tokens: { typography: { 2: 'Arial', b: 'Cambria', 1: 'Georgia' } } },
  extra: { a: 1, tokens: { b: 2, typography: { body: 'Calibri' } } },
};
const koreanDesign = Object.keys(KOREAN_DESIGNS).flatMap((name) =>
  KOREAN_DESIGN_TEXTS.map((text) => ({ input: { design: name, text }, ...attempt(() => plain(typography.koreanDesign(KOREAN_DESIGNS[name], text))) }))
);
const PAIR_TYPES = [{ title: 'Latin' }, { title: '한글' }, { title: '한글', nameEastAsia: 'Yu Gothic' }, { title: 'Latin', language: 'ko' }];
const PAIR_OUTPUTS = [
  [],
  [
    { op: 'add_table', properties: { fontName: 'Cambria' } },
    { op: 'add_table', properties: { fontName: 'Calibri' } },
    { op: 'add_table', properties: { fontName: 'Calibri', fontNameEastAsia: 'Batang' } },
    { op: 'add_table', properties: { fontName: 'Calibri', fontNameEastAsia: '' } },
    { op: 'add_table', properties: { fontNameEastAsia: 'x' } },
    { op: 'add_table', properties: { fontName: '' } },
    { op: 'add_table' },
    { op: 'add_table', properties: null },
    { op: 'set_table_cell_style', properties: { fontName: 'Georgia', bold: true } },
    { op: 'set_table_cell_style', properties: { fontName: 'Arial' } },
    { op: 'append_text', properties: { fontName: 'Cambria' } },
    { op: 'fit_table', table: 1 },
    { op: 'set_table_cell_style', properties: { fontName: 5 } },
  ],
];
const pairTableEastAsia = PAIR_TYPES.flatMap((operation) =>
  PAIR_OUTPUTS.map((output) => ({
    input: { operation, output },
    ...attempt(() => plain(typography.pairTableEastAsia(plain(output), typography.documentTypography(operation, { display: 'Cambria', body: 'Calibri', data: 'Arial' })))),
  }))
);
const faceTests = {
  serif: FACES.filter((face) => typeof face === 'string').map((face) => ({ face, serif: typography.SERIF_FACE.test(face) })),
  hangul: ['', 'a', 'ㄱ', 'ᄀ', 'ᇿ', 'ሀ', 'ㄯ', '㄰', '㆏', '㆐', '꯿', '가', '힯', 'ힰ', '한글', 'x한y'].map((text) => ({
    text, hangul: typography.HANGUL.test(text),
  })),
};

const out = {
  note: 'Recorded from the Node docx design modules; tests/twin_docx.rs replays it.',
  designs: DESIGNS,
  operations: OPERATIONS,
  metrics: METRICS,
  faces: FACES,
  koreanDesigns: Object.fromEntries(Object.entries(KOREAN_DESIGNS).filter(([name]) => !(name in DESIGNS))),
  expand,
  callout,
  strip,
  roadmap,
  sectionTable,
  sectionTableDefaults,
  documentTypography,
  koreanDesign,
  pairTableEastAsia,
  faceTests,
};

const fixtures = path.join(FIXTURES_ROOT, 'office-docx');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-docx', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes`);
