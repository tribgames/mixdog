#!/usr/bin/env node
// Golden of the composition system and the design system (crate mixdog-office-design, modules composition,
// design_system and native_design): what Node's `runtime/office/design/composition-system.mjs`, `design-system.mjs` and
// `native-design.mjs` answer to a corpus of requests (the ones of office-runtime-design.test.mjs,
// office-design-defaults.test.mjs and native-authoring.test.mjs, and the variations that reach every branch: the
// composition context of a request, the plan of one operation per format, the plans of a whole batch with the usage
// counted across it, the review of a sequence, the expansion of an operation list through the docx and xlsx composers,
// the PDF design of a block list, and the native design of a request). Writes
// native/core/fixtures/office-composition/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-composition.mjs --tree <product tree>
//
// Every case is { input, value } or { input, error }: the answer (or the message Node throws). Designs the planner
// reads are resolved once by Node (resolveOfficeDesign) and recorded as data, so the Rust planner takes the design as an
// input. The output is byte-stable: the corpus is constants.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-composition.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const composition = await importFrom(tree, 'src/runtime/office/design/composition-system.mjs');
const system = await importFrom(tree, 'src/runtime/office/design/design-system.mjs');
const native = await importFrom(tree, 'src/runtime/office/design/native-design.mjs');

const plain = (value) => JSON.parse(JSON.stringify(value));
const attempt = (run) => {
  try {
    return { value: plain(run()) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const resolve = (format, request, library) => plain(system.resolveOfficeDesign(format, request, { library }));

// ---- composition contexts -----------------------------------------------------------------------------------------
const RECENT = [
  { fingerprint: 'f1', format: 'docx', profile: 'data', purpose: 'decide', expressionMode: 'strong-fit', compositionIds: ['decision-brief', 'evidence-brief', '', null], createdAt: '2026-01-01T00:00:00Z' },
  { fingerprint: 'f2', compositionIds: ['decision-brief'], extra: true },
  'not an object',
  { compositionIds: 'nope', fingerprint: 7 },
  { fingerprint: 'f4', compositionIds: ['compact-memo', 'editorial-report', 'x'] },
  null,
  { fingerprint: 'f6', compositionIds: ['decision-brief', 'compact-memo'] },
];
const MANY_RECENT = Array.from({ length: 30 }, (_, index) => ({ fingerprint: `m${index}`, compositionIds: [`c${index}`, 'decision-brief'] }));
const CONTEXT_INPUTS = [
  {},
  { purpose: 'decide' },
  { purpose: ' COMPARE ', expressionMode: 'Divergent' },
  { purpose: 'nonsense', expressionMode: 'wild' },
  { composition: { purpose: 'inspect', expressionMode: 'conservative' } },
  { purpose: 'monitor', composition: { purpose: 'explain', expressionMode: 'divergent' } },
  { composition: 'text' },
  { composition: ['decide'] },
  { content: { decision: 'Go ahead.' } },
  { content: { decision: '' } },
  { purpose: 5, expressionMode: 0 },
];
const contexts = [];
for (const format of ['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'tsv', 'DocX', 'XLSX', '']) {
  for (const input of CONTEXT_INPUTS) {
    const recent = format === 'docx' ? RECENT : format === 'xlsx' ? MANY_RECENT : undefined;
    contexts.push({
      input: { format, input, recent: recent ?? null },
      ...attempt(() => composition.resolveOfficeCompositionContext(format, input, { recentCompositions: recent })),
    });
  }
}
contexts.push({ input: { format: 'docx', input: {}, recent: 'not a list' }, ...attempt(() => composition.resolveOfficeCompositionContext('docx', {}, { recentCompositions: 'not a list' })) });

// ---- designs the planner reads ------------------------------------------------------------------------------------
const LIBRARY_WITH_RECENT = { recentCompositions: RECENT };
const designs = {
  executive: resolve('docx', {}),
  editorial: resolve('docx', { profile: 'editorial', intent: 'Quarterly review', audience: 'leaders' }),
  technical: resolve('docx', { profile: 'technical', density: 'dense', purpose: 'inspect' }),
  decide: resolve('docx', { profile: 'data', purpose: 'decide', expressionMode: 'conservative', content: { decision: '야간 전용안을 채택한다.', claims: [{ id: 'c1', text: 'a claim' }], facts: [{ id: 'f1', label: 'Rate', value: 0.9, format: 'percent' }] } }),
  divergent: resolve('docx', { profile: 'editorial', expressionMode: 'divergent', purpose: 'explain' }),
  recent: resolve('docx', { profile: 'executive', purpose: 'decide' }, LIBRARY_WITH_RECENT),
  sheet: resolve('xlsx', {}),
  sheetCompare: resolve('xlsx', { purpose: 'compare', expressionMode: 'divergent' }),
  sheetRecent: resolve('xlsx', { profile: 'data' }, { recentCompositions: MANY_RECENT }),
  deck: resolve('pptx', { profile: 'editorial', purpose: 'decide' }),
  deckDivergent: resolve('pptx', { profile: 'technical', expressionMode: 'divergent', purpose: 'monitor' }),
  bare: {},
  odd: { purpose: 'monitor', density: 'dense', expressionMode: 'divergent', intent: 5, audience: null, signature: 0, content: { fingerprint: 12345 }, recentCompositions: RECENT, artDirection: { selected: { deck: { layoutBias: ['evidence', 'rhythm'] } } } },
  biased: { ...resolve('pptx', { profile: 'executive' }), artDirection: { selected: { deck: { layoutBias: ['typography', 'split', 7] } } } },
};
const DESIGN_NAMES = Object.keys(designs);

// ---- operations ---------------------------------------------------------------------------------------------------
const DOC_OPERATIONS = {
  empty: { op: 'compose_document' },
  brief: { op: 'compose_document', title: 'Decision brief', decision: '야간 전용안을 채택한다.', sections: [{ heading: 'A', paragraphs: ['one', 'two'] }, { heading: 'B', bullets: ['x', 'y'] }] },
  evidence: { op: 'compose_document', title: 'Evidence', metrics: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }], sections: [{ heading: 'T', table: [['a', 'b'], [1, 2], [3, 4]] }, { heading: 'U', table: { headers: ['a'], rows: [[1], [2], [3], [4], [5], [6], [7], [8], [9]] } }] },
  narrative: { op: 'compose_document', title: 'Story', body: 'A long body.', bullets: ['a', ' ', null, 'b'], sections: [{ paragraphs: 'text' }, { body: ['x'] }, { body: 0 }, { body: false }, { paragraphs: [], body: '' }, null, 'section'] },
  dense: { op: 'compose_document', title: 'Dense', steps: Array.from({ length: 6 }, (_, index) => ({ title: `Step ${index}` })), columns: [1, 2, 3], metrics: [1, 2, 3, 4], sections: Array.from({ length: 5 }, (_, index) => ({ heading: `S${index}`, paragraphs: ['p', 'q'], table: [['h'], ['r']] })) },
  badTable: { op: 'compose_document', title: 'Bad', sections: [{ table: ['a'] }, { table: { cells: 1 } }, { table: 5 }] },
  variantDecision: { op: 'compose_document', title: 'V', variant: ' Compact-Memo ', sections: [] },
  variantUnknown: { op: 'compose_document', title: 'V', variant: 'does-not-exist', sections: [] },
  purposed: { op: 'compose_document', title: 'P', purpose: 'Compare', expressionMode: 'DIVERGENT', sections: [{ paragraphs: ['a'] }] },
  imageChart: { op: 'compose_document', title: 'I', image: 'x.png', visualText: 'v', chart: { series: [1, 2] } },
  imagePath: { op: 'compose_document', imagePath: 'y.png', rows: [[1]] },
};
const SHEET_OPERATIONS = {
  empty: { op: 'compose_sheet' },
  dashboard: { op: 'compose_sheet', sheet: 'Data', kind: 'dashboard', title: 'Dash', headers: ['a', 'b'], rows: [['x', 1], ['y', 2]], metrics: [{ label: 'm', value: 1 }, { label: 'n', value: 2 }] },
  chart: { op: 'compose_sheet', sheet: 'C', headers: ['m', 'v'], rows: [['1', 1], ['2', 2], ['3', 3]], chart: { type: 'line', series: [1] } },
  table: { op: 'compose_sheet', sheet: 'T', headers: ['a'], rows: Array.from({ length: 30 }, (_, index) => [index]) },
  variant: { op: 'compose_sheet', sheet: 'V', variant: 'Narrative-Scorecard', rows: [[1]] },
  variantUnknown: { op: 'compose_sheet', variant: 'nope', rows: [[1]] },
  scorecard: { op: 'compose_sheet', title: 'S', purpose: 'decide', expressionMode: 'divergent', metrics: [1, 2, 3, 4, 5], rows: [[1]] },
};
const SLIDE_OPERATIONS = {
  cover: { op: 'compose_slide', kind: 'cover', title: 'Deck' },
  coverMinimal: { kind: 'Cover', variant: 'minimal-focus' },
  coverUnknown: { kind: 'cover', variant: 'poster' },
  content: { kind: 'content', body: 'text' },
  contentLayout: { kind: 'content', layoutId: 'L1', body: ['a', 'b', 'c'] },
  chartKind: { kind: 'content', chart: { series: [1, 2] } },
  tableKind: { kind: 'content', table: [['a'], [1]] },
  metricsKind: { metrics: [1, 2, 3] },
  comparisonKind: { columns: [1, 2] },
  processKind: { steps: [1, 2, 3] },
  splitKind: { imagePath: 'a.png' },
  statement: { kind: 'statement', metrics: [1], body: 'x' },
  closing: { kind: 'closing', title: 'Thanks' },
  unknownKind: { kind: 'diagram' },
  modelPlan: { kind: 'content', plan: { name: 'grid', units: 'percent', regions: [{ role: 'title', x: 1.4, y: 2, w: 50.5, h: 9 }, { role: 'body', box: [10.2, 20.7, 80, '30'], direction: 'row' }, { left: 5, top: 6, width: 7, height: 8, layout: 'col' }, null, { x: null, left: 3 }], readingOrder: ['title', 'body'] } },
  modelPlanBare: { kind: 'chart', plan: { visualType: 'bar', regions: [] } },
  modelPlanNoRegions: { kind: 'chart', plan: { name: 'x' } },
  modelPlanUnits: { kind: 'content', plan: { units: 'px', regions: [{ role: 'r', x: 'a' }], readingOrder: 0 } },
};

const plans = [];
for (const [format, operations] of [['docx', DOC_OPERATIONS], ['xlsx', SHEET_OPERATIONS], ['pptx', SLIDE_OPERATIONS], ['pdf', { plain: { op: 'x', title: 'T' } }], ['', { plain: {} }]]) {
  const designNames = format === 'docx' ? DESIGN_NAMES.filter((name) => !name.startsWith('sheet') && !name.startsWith('deck')) : format === 'xlsx' ? ['sheet', 'sheetCompare', 'sheetRecent', 'bare', 'odd'] : format === 'pptx' ? ['deck', 'deckDivergent', 'biased', 'odd', 'bare'] : ['bare', 'executive'];
  for (const [name, operation] of Object.entries(operations)) {
    for (const design of designNames) {
      plans.push({
        input: { name, format, operation: plain(operation), design },
        ...attempt(() => composition.planOfficeComposition(format, plain(operation), designs[design])),
      });
    }
  }
}

// ---- batches: the plans of an operation list with the usage counted across it, and their review ---------------------
const batchCases = [];
const batch = (name, format, design, operations) => {
  const usage = new Map();
  const planned = operations.map((operation) => composition.planOfficeComposition(format, plain(operation), designs[design], { usage }));
  const wrapped = planned.map((entry, index) => (index % 2 ? { op: 'x', composition: entry } : entry));
  const summary = composition.summarizeOfficeCompositions(format, planned);
  const recentTwin = [{ fingerprint: summary.fingerprint, compositionIds: summary.compositionIds }, ...RECENT];
  batchCases.push({
    input: { name, format, design, operations: plain(operations), recent: plain(recentTwin) },
    value: plain({
      plans: planned,
      usage: [...usage.entries()],
      summary,
      wrappedSummary: composition.summarizeOfficeCompositions(format, wrapped),
      emptySummary: composition.summarizeOfficeCompositions(format, []),
      notAList: composition.summarizeOfficeCompositions(format, 'x'),
      review: composition.reviewOfficeCompositionSequence({ format, compositions: planned, recentCompositions: recentTwin }),
      reviewWrapped: composition.reviewOfficeCompositionSequence({ format, compositions: wrapped, recentCompositions: RECENT }),
      reviewAllowed: composition.reviewOfficeCompositionSequence({ format, compositions: planned, recentCompositions: recentTwin, allowRepetition: true }),
      reviewNone: composition.reviewOfficeCompositionSequence({ format, compositions: [], recentCompositions: recentTwin }),
      reviewDefault: composition.reviewOfficeCompositionSequence({ format }),
    }),
  });
};
const repeat = (operation, count) => Array.from({ length: count }, () => operation);
batch('deckRepeated', 'pptx', 'deck', [SLIDE_OPERATIONS.cover, { kind: 'cover' }, ...repeat(SLIDE_OPERATIONS.content, 6), SLIDE_OPERATIONS.closing]);
batch('deckMixed', 'pptx', 'deckDivergent', [SLIDE_OPERATIONS.cover, SLIDE_OPERATIONS.content, SLIDE_OPERATIONS.chartKind, SLIDE_OPERATIONS.tableKind, SLIDE_OPERATIONS.metricsKind, SLIDE_OPERATIONS.processKind, SLIDE_OPERATIONS.closing]);
batch('deckModel', 'pptx', 'deck', [SLIDE_OPERATIONS.modelPlan, SLIDE_OPERATIONS.modelPlan, SLIDE_OPERATIONS.modelPlan, SLIDE_OPERATIONS.modelPlan]);
batch('docs', 'docx', 'decide', [DOC_OPERATIONS.brief, DOC_OPERATIONS.brief, DOC_OPERATIONS.brief, DOC_OPERATIONS.evidence, DOC_OPERATIONS.narrative]);
batch('docsRecent', 'docx', 'recent', repeat(DOC_OPERATIONS.brief, 6));
batch('sheets', 'xlsx', 'sheetRecent', repeat(SHEET_OPERATIONS.dashboard, 5));
batch('single', 'xlsx', 'sheet', [SHEET_OPERATIONS.chart]);
batch('empty', 'docx', 'bare', []);
batch('other', 'pdf', 'bare', repeat({ op: 'x' }, 4));

// ---- expansions ---------------------------------------------------------------------------------------------------
const requests = [];
const request = (name, input) => requests.push({ name, input });
const DOC_BRIEF = { op: 'compose_document', title: 'Preset brief', sections: [] };
request('nativeDocx', { format: 'docx', operations: [{ op: 'add_paragraph', text: 'x' }, { op: 'append_text', text: 'y' }], created: true });
request('nativeXlsx', { format: 'xlsx', operations: [{ op: 'set_cell', cell: 'A1', value: 1 }], created: true });
request('nativePdf', { format: 'pdf', operations: [], created: true });
request('nativeWithContent', { format: 'docx', operations: [{ op: 'add_paragraph', text: { factId: 'f1' }, claimId: 'c1' }], design: { intent: 'i', audience: 'a', palette: { accent: '112233' }, typography: { body: 'Calibri' }, review: false, content: { facts: [{ id: 'f1', label: 'Rate', value: 0.9 }], claims: [{ id: 'c1', text: 'Rate is high', factIds: ['f1'] }] } } });
request('nativeBadContent', { format: 'docx', operations: [], design: { content: 5 } });
request('nativeUnknownFact', { format: 'docx', operations: [{ op: 'add_paragraph', text: { factId: 'nope' } }], design: { content: { facts: [] } } });
request('nativeDefaults', { format: 'docx' });
request('presetDocx', { format: 'docx', operations: [DOC_BRIEF], created: true });
request('presetDocxDesign', { format: 'DOCX', operations: [{ op: 'compose_document', title: 'Report', meta: ['Prepared by A', 'Version 2'], sections: [{ heading: 'H', callout: 'Approve the plan.', paragraphs: ['text'] }, { heading: 'T', table: { headers: ['a', 'b'], rows: [['1', '2']] } }] }], design: { profile: 'data' }, created: true });
request('presetDocxString', { format: 'docx', operations: [DOC_BRIEF, { op: 'add_paragraph', text: 'after' }], design: 'editorial' });
request('presetDocxTwo', { format: 'docx', operations: [DOC_BRIEF, { ...DOC_BRIEF, title: 'Second', sections: [{ heading: 'A', paragraphs: ['a'] }] }, DOC_OPERATIONS.evidence, DOC_OPERATIONS.dense], design: { profile: 'technical', intent: 'Review', audience: 'team' } });
request('presetDocxContent', { format: 'docx', operations: [{ op: 'compose_document', title: 'Bound', decision: { factId: 'f1', field: 'label' }, sections: [{ heading: 'H', paragraphs: [{ factId: 'f1' }] }] }], design: { profile: 'executive', content: { decision: 'Ship it.', facts: [{ id: 'f1', label: 'Rate', value: 0.9 }], claims: [{ id: 'c1', text: 'Rate is high', factIds: ['f1'] }] } } });
request('presetDocxBadTable', { format: 'docx', operations: [DOC_OPERATIONS.badTable], design: { profile: 'data' } });
request('presetDocxRecent', { format: 'docx', operations: [DOC_OPERATIONS.brief, DOC_OPERATIONS.brief], design: { profile: 'data' }, library: LIBRARY_WITH_RECENT });
request('presetUnknownProfile', { format: 'docx', operations: [DOC_BRIEF], design: { profile: 'nope' } });
request('presetUnsupportedFormat', { format: 'rtf', operations: [DOC_BRIEF], design: { profile: 'data' } });
request('presetProfileNoComposer', { format: 'docx', operations: [{ op: 'add_paragraph', text: 'x' }], design: { profile: 'technical' } });
request('presetXlsx', { format: 'xlsx', operations: [{ op: 'compose_sheet', rows: [['A', 1]] }], created: true });
request('presetXlsxFresh', { format: 'xlsx', operations: [SHEET_OPERATIONS.dashboard, SHEET_OPERATIONS.chart, { ...SHEET_OPERATIONS.dashboard, sheet: 'data' }, { op: 'compose_sheet', rows: [[1]] }, { op: 'compose_sheet', sheet: 0, rows: [[1]] }, { op: 'set_cell', cell: 'A1', value: 1 }], design: {}, created: true, snapshotVersion: 0 });
request('presetXlsxExisting', { format: 'xlsx', operations: [SHEET_OPERATIONS.dashboard, SHEET_OPERATIONS.chart], design: { profile: 'data' }, created: true, snapshotVersion: 3 });
request('presetXlsxNotCreated', { format: 'xlsx', operations: [SHEET_OPERATIONS.dashboard], design: { profile: 'data' }, created: false, snapshotVersion: 0 });
request('presetXlsxNaN', { format: 'xlsx', operations: [SHEET_OPERATIONS.dashboard], design: {}, created: true, snapshotVersion: 'x' });
request('presetXlsxPurposed', { format: 'xlsx', operations: [SHEET_OPERATIONS.scorecard, SHEET_OPERATIONS.variant, SHEET_OPERATIONS.table], design: { purpose: 'compare', expressionMode: 'divergent', content: { decision: 'Go.' } }, created: true });
request('presetXlsxKorean', { format: 'xlsx', operations: [{ op: 'compose_sheet', sheet: '결정', title: '도크 4 증설 결정', headers: ['안', '비용', '야간 대응', '판정'], rows: [['주간 전용', '낮음', '불가', '기각'], ['야간 전용', '중간', '가능', '채택']], metrics: [{ label: '처리량 증가', value: 1.6 }], decision: '야간 전용안을 10월 운영 회의에 올린다.', gates: [{ track: '야간 셔틀', release: '2대 증차 확정', stop: '증차 불가 시 보류' }] }], design: {}, created: true });
request('presetXlsxMixedOps', { format: 'xlsx', operations: [{ op: 'set_cell', cell: 'A1', value: 1 }, SHEET_OPERATIONS.chart, null, 'x', 5], design: { profile: 'executive' }, created: true });
request('presetXlsxDocxOp', { format: 'xlsx', operations: [DOC_BRIEF], design: { profile: 'executive' } });
request('presetPptxRefused', { format: 'pptx', operations: [{ op: 'compose_slide', kind: 'cover' }], design: {} });
request('presetPptxOther', { format: 'pptx', operations: [{ op: 'add_slide' }, { op: 'add_textbox', text: 'x' }], design: { profile: 'editorial' } });
request('presetPptxPlain', { format: 'pptx', operations: [{ op: 'add_slide' }] });
request('presetPdfProfile', { format: 'pdf', operations: [{ op: 'x' }], design: { profile: 'data' } });
request('presetCsv', { format: 'csv', operations: [{ op: 'set_cell', cell: 'A1', value: 1 }], design: 'data' });
const expands = requests.map(({ name, input }) => ({ input: { name, request: plain(input) }, ...attempt(() => system.expandOfficeDesignOperations(plain(input))) }));

// ---- the design of a PDF ------------------------------------------------------------------------------------------
const PDF_BLOCKS = [
  { type: 'heading', text: 'An essay', size: 19, color: '29231F', after: 0 },
  { type: 'paragraph', text: 'Opening paragraph', size: 11, lineHeight: 16, after: 0 },
  { type: 'table', rows: [['Label', 'Value']], headerFill: 'FFFFFF', borderColor: 'EEEEEE' },
];
const PDF_ANATOMY = [
  { type: 'cover', title: 'Cover', eyebrow: 'E' },
  { type: 'heading', text: 'Title' },
  { type: 'heading', text: 'Second', level: 2 },
  { type: 'heading', text: 'Third', level: 3 },
  { type: 'heading', text: 'First level', level: '1' },
  { type: 'heading', text: 'Deep', level: 5, color: 'AA0000' },
  { type: 'HEADING', text: 'Upper' },
  { text: 'no type' },
  { type: 'paragraph', text: 'p', color: '000000', lineHeight: 0, after: null },
  { type: 'table', rows: [['a']] },
  { type: 'stats', items: [] },
  { type: 'quote', text: 'q', accent: 'FF0000' },
  { type: 'callout', label: 'Note', text: 'b' },
  { type: 'callout', labelColor: '111111', fill: '222222' },
  { type: 'image', path: 'a.png' },
  { type: 'list', items: ['a'] },
  { type: '  paragraph ', text: 'spaced' },
  5,
];
const pdfCases = [];
const pdf = (name, blocks, design, library) => pdfCases.push({ input: { name, blocks: plain(blocks), design: design ?? null, library: library ?? null }, ...attempt(() => system.applyPdfDesign(plain(blocks), design === null ? undefined : design, { library })) });
pdf('native', PDF_BLOCKS, undefined);
pdf('nativeDesign', PDF_BLOCKS, { intent: 'i', palette: { accent: '112233' }, content: { facts: [] }, review: false });
pdf('nativeBadContent', PDF_BLOCKS, { content: 'x' });
pdf('nativeEmpty', [], {});
pdf('nativeAnatomy', [...PDF_ANATOMY, null, 'text'], {});
for (const profile of ['executive', 'editorial', 'technical', 'data']) {
  pdf(`preset-${profile}`, PDF_BLOCKS, { profile });
  pdf(`anatomy-${profile}`, PDF_ANATOMY, { profile, purpose: 'decide' });
}
pdf('string', PDF_ANATOMY, 'data');
pdf('unknown', PDF_BLOCKS, { profile: 'nope' });
pdf('library', PDF_ANATOMY, { profile: 'data' }, LIBRARY_WITH_RECENT);
pdf('noBlocks', [], { profile: 'data' });

// ---- the native design --------------------------------------------------------------------------------------------
const nativeCases = [];
const nativeCase = (format, request, operations) => {
  const input = { format, request: request ?? null, operations: plain(operations) };
  const uses = native.usesNativeOfficeDesign(format, request, plain(operations));
  const built = attempt(() => {
    const design = native.nativeOfficeDesign(format, request);
    return { design, receipt: native.nativeDesignReceipt(design) };
  });
  nativeCases.push({ input, uses, ...built });
};
for (const format of ['docx', 'xlsx', 'pdf', 'pptx', 'csv']) {
  for (const request of [undefined, {}, 'editorial', '', { profile: 'data' }, { profile: '' }, { intent: 'Plan', audience: 'Board', palette: { accent: '123456' }, typography: { body: 'Calibri' }, review: false }, { review: true, palette: null, typography: '' }, null, 5, ['x'], { content: { decision: 'Go.', facts: [{ id: 'f1', label: 'L', value: 1 }] } }, { content: 'bad' }, { intent: 7, audience: 0 }]) {
    for (const operations of [[], [{ op: 'compose_document' }], [{ op: 'compose_sheet' }], [{}], [null], [{ op: 'x' }], [{ op: null }]]) {
      nativeCase(format, request, operations);
    }
  }
}

// ---- resolveOfficeDesign (the glue: the composition context of the request) ---------------------------------------
const resolveCases = [];
const resolveCase = (format, request, library) => resolveCases.push({ input: { format, request: request ?? null, library: library ?? null }, ...attempt(() => system.resolveOfficeDesign(format, request, { library })) });
for (const format of ['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'tsv', 'DOCX', 'rtf']) {
  for (const request of [undefined, {}, 'data', { profile: 'editorial', purpose: 'compare', expressionMode: 'divergent' }, { composition: { purpose: 'inspect' } }, { content: { decision: 'Go.' } }, null, 5, ['x'], { profile: 'nope' }, { purpose: 'decide', composition: { expressionMode: 'conservative' } }]) {
    resolveCase(format, request, null);
  }
  resolveCase(format, { purpose: 'decide' }, LIBRARY_WITH_RECENT);
}

const out = {
  note: 'Recorded from the Node composition, design and native-design modules; tests/twin_composition.rs replays it.',
  designs,
  contexts,
  plans,
  batches: batchCases,
  expands,
  pdfs: pdfCases,
  natives: nativeCases,
  resolves: resolveCases,
};

const fixtures = path.join(FIXTURES_ROOT, 'office-composition');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-composition', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes, ${contexts.length} contexts, ${plans.length} plans, ${batchCases.length} batches, ${expands.length} expansions, ${pdfCases.length} pdf, ${nativeCases.length} native, ${resolveCases.length} resolves`);
