#!/usr/bin/env node
// Golden of the office design layer (crate mixdog-office-design): what Node's `runtime/office/design/` modules
// design-discipline, design-tokens, design-art-direction, design-creative-director, content-model and
// design-table-input answer to a fixed corpus of design requests per format (with and without a library), palettes,
// typography requests, catalogue queries, content models and bindings, stories and table inputs. Writes
// native/core/fixtures/office-discipline/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-discipline.mjs --tree <product tree>
//
// Every section is a list of cases { input, ...output }; an entry that throws is recorded as { error: message }.
// A design case also records the composition context (purpose, expression mode, recent compositions) the Node
// composition system makes of the request: the composition system is a later port, so the Rust resolver takes that
// context as an input. The output is byte-stable: the corpus is constants and keys are written in the order the
// modules produce them.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-discipline.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const load = (name) => importFrom(tree, `src/runtime/office/design/${name}`);

const discipline = await load('design-discipline.mjs');
const tokens = await load('design-tokens.mjs');
const art = await load('design-art-direction.mjs');
const director = await load('design-creative-director.mjs');
const content = await load('content-model.mjs');
const tableInput = await load('design-table-input.mjs');
const composition = await load('composition-system.mjs');

const attempt = (run) => {
  try {
    return { value: run() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
// A value as the corpus writes it: what JSON keeps.
const plain = (value) => JSON.parse(JSON.stringify(value));

const out = {
  note: 'Recorded from the Node office design modules; tests/twin_discipline.rs replays it.',
};

// ---- discipline ---------------------------------------------------------------------------------------------------
const FONTS = [
  'Arial', 'arial', '  Calibri  ', '"Segoe UI"', 'Segoe UI Semilight', 'Calibri Light', 'Aptos Display', 'Consolas', '맑은 고딕',
  'Noto Sans KR', 'Noto Sans KR Medium', 'Noto Sans', '본고딕', 'Times New Roman', 'Courier  New', 'Yu Gothic', '微软雅黑', 'メイリオ',
  'Hiragino Sans', 'Cambria Display', 'Black', '', '   ', 'Century Schoolbook', 'Noto Serif JP', 'NOTO SANS ARABIC',
];
const TYPOGRAPHY = [
  { requested: { display: 'Aptos Display', body: 'Segoe UI', data: 'Courier New' }, fallback: { display: 'Cambria', body: 'Calibri', data: 'Arial' } },
  { requested: { display: 'Consolas' }, fallback: { display: 'Cambria', body: 'Calibri', data: 'Arial' } },
  { requested: { display: '  ', body: '' }, fallback: { display: 'Cambria', body: 'Calibri', data: 'Arial' } },
  { requested: { display: '맑은 고딕', body: 'Noto Sans KR', data: 'Noto Sans KR Light' }, fallback: {} },
  { requested: null, fallback: { display: 'Cambria', body: 'Calibri', data: 'Cambria' } },
  { requested: 'x', fallback: null },
  { requested: { display: 'Calibri' }, fallback: { display: 'Cambria', mono: 'Consolas' } },
  { requested: { body: 5 }, fallback: { display: 'Cambria' } },
];
const PACK_COLORS = [
  { canvas: 'F8F9F6', ink: '17221C', muted: '66716B', accent: '1F7A55', accent2: 'D89224', surface: 'E8F1EC', surface2: 'DDE4DF', inverse: '132C24', onAccent: 'FFFFFF', onInverse: 'FFFFFF' },
  { canvas: 'FFFFFF', ink: '171717', muted: '5F6368', accent: 'C43E2F', accent2: 'D89B2B', surface: 'F1F2F4', surface2: 'E7E9EC', inverse: '151515', onAccent: 'FFFFFF', onInverse: 'FFFFFF' },
  { canvas: 'F7FAFC', ink: '102A43', muted: '627D98', accent: '008C8C', accent2: 'E0A526', surface: 'E8F1F5', surface2: 'D9E7EC', inverse: '0B1F33', onAccent: 'FFFFFF', onInverse: 'F7FAFC' },
  { canvas: 'FFFFFF', ink: '1F2933', muted: '66788A', accent: '287A4B', accent2: 'D97706', surface: 'EDF5F0', surface2: 'E3EAF0', inverse: '183028', onAccent: 'FFFFFF', onInverse: 'FFFFFF' },
];
const PALETTES = [
  ...PACK_COLORS,
  { canvas: 'FFFFFF', ink: '111111', muted: 'A0A0A0', accent: '2563EB', accent2: 'F59E0B', surface: 'F1F5F9', surface2: 'E2E8F0', inverse: '000000', onAccent: 'FFFFFF', onInverse: 'FFFFFF' },
  { canvas: 'FFFFFF', ink: '111111', critical: 'B00020' },
  ...['73A527', '27A56A', 'D89224', '1F7A55', 'FFD400', '0B0B0B', '7C3AED'].map((accent) => ({
    canvas: 'F8F9F6', ink: '17221C', muted: '66716B', accent, inverse: '132C24', onAccent: 'FFFFFF', onInverse: 'FFFFFF',
  })),
  { canvas: '#ffffff', ink: '#222222', muted: '#888888', accent: '#c0392b', inverse: '#222222', onAccent: '#ffffff', onInverse: '#eeeeee' },
  { canvas: '3366CC', ink: '123456', muted: 'EEEEEE', accent: 'FFFFFF', accent2: '000000', inverse: '808080', onAccent: '808080', onInverse: '777777' },
  { canvas: '0B1220', ink: 'F5F7FA', muted: '9FB0C8', accent: '60A5FA', inverse: '0B1220', onInverse: 'F5F7FA' },
  { canvas: 'FFFFFF', ink: 'FFFFFF', muted: 'FFFFFF', accent: 'FFFF00', accent2: 'FFFF66', surface: 'FFFFE0', surface2: 'FFFF99', inverse: 'FFFFFF', onAccent: 'FFFFFF', onInverse: 'FFFFFF' },
  { canvas: 'FFFFFF', ink: 'GGGGGG', muted: 123456, accent: null, inverse: '#1a1a1a' },
  { inverse: '2A2A2E', accent: '1F7A55' },
  { inverse: '010101', accent: 'not a colour' },
  { canvas: 'F0E8FF', ink: '000000' },
  { canvas: 'ﬀ1234', ink: '#abcdef' },
  { positive: '00AA00', positiveWeak: 'EEFFEE', positiveText: '006600', warning: 'AA8800', informative: '0033CC', accentLight: 'FFFFFF', accentDeep: '000000', accent: '1F7A55', accent2: 'D89224', canvas: 'FFFFFF', ink: '101010', inverse2: '222222', inverse: '111111' },
  {},
  null,
  'text',
];
const HSL = [[0, 100, 50], [120, 100, 50], [240, 100, 50], [-120, 100, 50], [360, 0, 100], [59.9, 80, 41.3], [300.5, 33, 77], [721, 50, 50], [210, 62, 40], [123.456, 7.5, 92.25], [180, 150, -5], ['90', '50', '50'], [null, 20, 20]];
const CONTRAST = [['FFFFFF', '000000'], ['#17221C', 'F8F9F6'], ['1F7A55', 'FFFFFF'], ['808080', '808080'], ['zzzzzz', 'FFFFFF'], ['FFFFFF', ''], ['ffffff', '#000000'], ['A0A0A0', 'E2E8F0']];
const HUE_LISTS = [['60A5FA', 'A3E635', 'A78BFA'], ['F5F7FA', '0B1220'], ['1F7A55', '1F7A55', 'D89224'], ['nope', '#C43E2F', 'c43e2f'], [], ['FF0000', 'FFFF00', '00FF00', '00FFFF', '0000FF', 'FF00FF']];
const BRIEF_TOKENS = [
  { typography: { display: 'Cambria', body: 'Calibri', data: 'Arial' }, colors: PACK_COLORS[0] },
  { typography: { display: 'Cambria' }, colors: { accent: '1F7A55', canvas: 'FFFFFF' } },
  { colors: { 2: 'a', b: 'b', 1: 'c' } },
  {}, null, { typography: 5, colors: 'x' },
];
const SHAPES = [
  { name: 'Mixdog Motif 1' }, { name: 'Title' }, {}, { type: 13 }, { type: '13' }, { type: 'p:pic' }, { type: 'p:sp' }, { type: null }, { type: 12.9 },
];
const SLIDES = [
  { shapes: [{ name: 'mixdog-spec:structure:timeline' }, { name: 'mixdog-spec:table' }] },
  { shapes: [{ name: 'mixdog-spec:structure' }, { name: 'mixdog-spec:chevrons' }] },
  { shapes: [{ name: 'mixdog-spec:structure:' }, { name: 'mixdog-spec:stat' }] },
  { shapes: [{ name: 'mixdog-spec:table:x' }, { name: 'mixdog-spec:stat' }] },
  { shapes: [{ name: 'mixdog-spec:stat' }] },
  { shapes: [{ name: 'Title' }, { name: 'mixdog-spec:other' }] },
  { shapes: [{ name: 'mixdog-spec:structure:a:b' }] },
  { shapes: [] }, {}, null,
];
out.discipline = {
  constants: {
    maxFontFamiliesPerSlide: discipline.MAX_FONT_FAMILIES_PER_SLIDE,
    maxAccentHueFamilies: discipline.MAX_ACCENT_HUE_FAMILIES,
    stateRoles: discipline.STATE_ROLES,
  },
  fonts: FONTS.map((input) => ({ input, key: discipline.fontFamilyKey(input), safe: discipline.isSafeFontFamily(input) })),
  typography: TYPOGRAPHY.map((input) => ({ input, ...attempt(() => plain(discipline.normalizeTypographyTokens(input.requested, input.fallback))) })),
  palettes: PALETTES.map((input) => ({ input, ...attempt(() => plain(discipline.normalizePaletteTokens(input))) })),
  hsl: HSL.map((input) => ({ input, hex: discipline.hslToHex(...input) })),
  contrast: CONTRAST.map((input) => ({
    input, ratio: discipline.contrastRatio(...input), foreground: discipline.relativeLuminance(input[0]), background: discipline.relativeLuminance(input[1]),
  })),
  hueFamilies: HUE_LISTS.map((input) => ({ input, families: discipline.saturatedHueFamilies(input) })),
  brief: BRIEF_TOKENS.map((input) => ({ input, ...attempt(() => plain(discipline.designDisciplineBrief(input))) })),
  motif: SHAPES.map((input) => ({ input, motif: discipline.isMotifShape(input), picture: discipline.isPictureShape(input) })),
  signed: SLIDES.map((input) => ({ input, type: discipline.signedVisualType(input) })),
};

// ---- art direction ------------------------------------------------------------------------------------------------
const ART_INPUTS = [
  { format: 'pptx', input: {}, options: {} },
  { format: 'xlsx', input: { signature: 'quarterly review', tone: 'bold dramatic launch', expressionMode: 'divergent' }, options: { expressionMode: 'divergent' } },
  { format: 'pptx', input: { signature: 'quarterly review', tone: 'bold dramatic launch', expressionMode: 'divergent' }, options: { expressionMode: 'divergent' } },
  { format: 'pptx', input: { intent: 'Launch a local-first coding harness for product leaders', audience: 'product and engineering leaders', signature: 'local-first evidence loop' }, options: { profile: 'technical', purpose: 'decide', expressionMode: 'strong-fit' } },
  { format: 'docx', input: { intent: '매출 성장 보고서', tone: '보고서 서사' }, options: { profile: 'executive', purpose: 'explain', expressionMode: 'strong-fit' } },
  { format: 'docx', input: { intent: 'Clinical patient outcomes', audience: '병원 의료진' }, options: { purpose: 'monitor', expressionMode: 'conservative' } },
  { format: 'pdf', input: { signature: 'Energy transition', tone: 'editorial narrative story' }, options: { purpose: 'compare', expressionMode: 'divergent' } },
  { format: 'pptx', input: { artDirection: 'editorial-contrast' }, options: { purpose: 'decide' } },
  { format: 'pptx', input: { artDirection: { id: 'immersive-signal', seed: 'abc' } }, options: { purpose: 'inspect', expressionMode: 'conservative' } },
  { format: 'pptx', input: { artDirection: { seed: 'only-a-seed' } }, options: {} },
  { format: 'pptx', input: { artDirection: false, signature: 'off' }, options: {} },
  { format: 'pptx', input: { artDirection: { enabled: false, id: 'evidence-grid' } }, options: {} },
  { format: 'xlsx', input: { artDirection: 'immersive-signal', signature: 'sheet' }, options: { purpose: 'monitor' } },
  { format: 'pptx', input: { content: { objective: 'Reduce wait times', decision: 'Split docks', packageId: 'ops_review', claims: [{ text: 'Software platform adoption grew' }, null, 'x'] }, signature: '  spaced   out   signature  with   a   very   long   tail   that   keeps   going   past   seventy   two   characters  ' }, options: { profile: 'data', purpose: 'decide' } },
  { format: 'PPTX', input: { intent: 'Climate energy plan', audience: 'board' }, options: { purpose: 'explain' } },
  { format: 'pptx', input: { artDirection: 'unknown-direction', intent: 'Product tech' }, options: { purpose: 'compare', expressionMode: 'divergent' } },
  { format: 'pptx', input: 'text', options: {} },
  { format: 'pptx', input: null, options: { profile: 'x' } },
  { format: 'pptx', input: { tone: 5, signature: 0, intent: false }, options: {} },
];
out.artDirection = ART_INPUTS.map((input) => ({ input, ...attempt(() => plain(art.resolveOfficeArtDirection(input.format, input.input, input.options))) }));

// ---- table input --------------------------------------------------------------------------------------------------
const TABLES = [
  { table: [['a', 1], ['b', 2]] },
  { table: [] },
  { table: ['a', 'b'] },
  { table: [['a'], 'b'] },
  { table: { headers: ['h1', 'h2'], rows: [['a', 1]] } },
  { table: { rows: [['a']] } },
  { table: { headers: ['h'] } },
  { table: { headers: [], rows: [] } },
  { table: {} },
  { table: { rows: 'x' } },
  { table: { rows: null, headers: ['h'] } },
  { table: { rows: [['a'], 1] } },
  { table: { cells: 1, rows: [], caption: 'c' } },
  { table: { 2: 1, b: 2, 1: 3 } },
  { table: 'x' },
  { table: 5 },
  { table: true },
  { table: null },
  { table: [['a']], field: 'blocks[2].table' },
  { table: 'x', field: 'blocks[2].table' },
  { table: { rows: 'x' }, field: 'sheet.table' },
  { table: { headers: 'h', rows: [['a']] } },
];
out.tableInput = TABLES.flatMap((input) =>
  [true, false].map((strict) => ({
    input: { ...input, strict },
    ...attempt(() => plain(tableInput.composeTableRows(input.table, { ...(input.field ? { field: input.field } : {}), strict }))),
  }))
);
out.tableInput.push({ input: { omitted: true }, ...attempt(() => plain(tableInput.composeTableRows())) });

// ---- content model ------------------------------------------------------------------------------------------------
const FACTS = [
  { id: 'rev', label: 'Revenue', value: 47210, unit: 'orders', numberFormat: '#,##0', source: { document: 'q3.xlsx', target: 'B2', label: 'sales' } },
  { id: 'rate', label: '정시 출고율', value: 0.928, format: 'percent', detail: 'on time', source: 'ops.xlsx#C4' },
  { id: 'gone', label: 'Gone' },
  { id: 'nullv', value: null },
];
const GOOD_MODEL = {
  packageId: 'ops_review',
  facts: FACTS,
  claims: [
    { id: 'up', text: 'Revenue grew', factIds: ['rev', 'rate'], implication: 'Invest' },
    { id: 'c2', text: ' second ', facts: ['REV', 'rev'] },
  ],
  objective: 'Reduce wait',
  decision: 'Split docks',
  audience: 'ops',
  period: 5,
};
const CONTENT_MODELS = [
  GOOD_MODEL,
  { packageId: '운영_리뷰', facts: [{ id: '정시_출고율', label: '정시 출고율', value: 0.928, numberFormat: '0.0%' }], claims: [{ id: '출고율_상승', text: '정시 출고율이 올랐다', factIds: ['정시_출고율'] }] },
  { packageId: '운영_리뷰', facts: [{ id: '정시_출고율', label: '정시 출고율', value: 0.928 }], claims: [{ id: '출고율_상승', text: '정시 출고율이 올랐다', facts: ['정시_출고율'] }] },
  { packageId: '운영_리뷰', facts: [{ label: '정시 출고율', value: 0.928 }], claims: [] },
  { packageId: '운영_리뷰', facts: [{ id: '정시 출고율', value: 0.928 }], claims: [] },
  { facts: [{ id: 'a' }, { id: 'A' }] },
  { facts: [{ id: 'a', colour: 'red', size: 2 }] },
  { facts: [{ id: 'a' }], claims: [{ id: 'c', factIds: ['b'] }] },
  { facts: [{ id: 'a' }], claims: [{ id: 'c' }, { id: 'C' }] },
  { facts: [{ id: 'a' }], claims: [{ id: 'c', factIds: [' ', 'a'] }] },
  { facts: [{ id: 'a' }], claims: [{ id: '' }] },
  { facts: [1] },
  { facts: ['x'], claims: [] },
  { claims: [null] },
  { packageId: '-bad', facts: [] },
  { packageId: 'x'.repeat(65) },
  { packageId: 'Ab.c_d-9', facts: [{ id: '1.2' }, { id: 'x'.repeat(64) }, { id: 'ÄÖ' }] },
  { facts: [{ id: 'f', numberFormat: 'Percent' }, { id: 'g', format: ' MONEY ' }, { id: 'h', numberFormat: ' 0.00 ', format: 'integer' }, { id: 'i', source: { document: '  ' } }, { id: 'j', source: { document: 'd' } }, { id: 'k', source: 5 }, { id: 'l', unit: 0, detail: '' }] },
  { facts: Array.from({ length: 1001 }, (_, index) => ({ id: `f${index}` })) },
  { facts: [], claims: Array.from({ length: 501 }, (_, index) => ({ id: `c${index}` })) },
  { facts: 5, claims: 'x', packageId: 0 },
  {},
  [],
  'x',
  5,
  true,
  null,
  { facts: [{ id: 'a', value: { z: 1, 2: 2, a: [1.5, 1e21, -0] } }, { id: 'b', value: [1, 2] }] },
];
out.contentModel = CONTENT_MODELS.map((input) => ({ input, ...attempt(() => plain(content.normalizeOfficeContentModel(input))) }));
out.contentModel.push({ input: { omitted: true }, ...attempt(() => plain(content.normalizeOfficeContentModel())) });
out.numberFormat = [{}, { numberFormat: 'percent' }, { format: 'Percentage' }, { format: ' decimal ' }, { numberFormat: '0.00', format: 'money' }, { numberFormat: '', format: 'Number' }, { format: 'x,y' }, { numberFormat: 5 }].map((input) => ({ input, format: content.officeNumberFormat(input) }));
out.numberFormat.push({ input: { omitted: true }, format: content.officeNumberFormat() });
const OPERATIONS = [
  { op: 'compose_document', claimId: 'UP', title: 'Own title', metrics: [{ factId: 'rev', label: '' }, { label: 'plain', value: 1 }, { factId: 'rate', value: 5, unit: 'pt', detail: 'x', numberFormat: '0' }, 7, null], rows: [[{ factId: 'rev' }, { factId: 'rate', field: 'label' }], [{ factId: 'gone' }]] },
  { op: 'compose_sheet', claimId: 'c2', table: { headers: ['a'], rows: [[{ factId: 'rev', field: 'unit' }]] }, chart: { series: [{ values: [{ factId: 'rate' }] }] } },
  { op: 'compose_document', claimId: 'up', summary: 'kept', takeaway: 'kept too' },
  { op: 'compose_document', claimId: 'up', title: 'Revenue grew' },
  { claimId: 'nope' },
  { rows: [{ factId: 'rev', field: 'colour' }] },
  { rows: [{ factId: 'ghost' }] },
  { metrics: [{ factId: 'ghost' }] },
  { metrics: [{ factId: 'gone' }, { factId: 'nullv', value: null }, { factId: 'rate', label: 'L', unit: 0 }] },
  { claimId: ' UP ' },
  { claimId: 5 },
  { rows: [{ factId: 'rev', field: 'value' }], columns: [{ factId: 'rate' }], steps: [], annotations: null, gates: [{ a: { factId: 'rev' } }], actions: [{ factId: 'gone', field: 'label' }], allocations: 'text', table: 0 },
  { source: 'given', rows: [{ factId: 'rev' }] },
  { rows: [{ factId: '  REV  ' }] },
  { rows: [{ factId: 'rev', field: 0 }, { factId: 'rev', field: '' }] },
  { rows: { 2: { factId: 'rev' }, b: 1, 1: { factId: 'rate' } } },
  { rows: [{ factId: 'nullv' }, { x: { factId: 'gone' } }] },
  'text',
  null,
  [],
  {},
];
const GOOD = content.normalizeOfficeContentModel(GOOD_MODEL);
out.bind = [
  ...OPERATIONS.map((operation) => ({ operation, model: 'good', ...attempt(() => plain(content.bindOfficeContent(operation, GOOD))) })),
  { operation: OPERATIONS[0], model: 'none', ...attempt(() => plain(content.bindOfficeContent(OPERATIONS[0], null))) },
  { operation: OPERATIONS[0], model: 'empty', ...attempt(() => plain(content.bindOfficeContent(OPERATIONS[0], content.normalizeOfficeContentModel({ facts: [], claims: [] })))) },
];
out.goodModel = GOOD_MODEL;
out.summary = [GOOD_MODEL, CONTENT_MODELS[1], {}, null].map((input) => ({
  input, ...attempt(() => plain(content.summarizeOfficeContentModel(content.normalizeOfficeContentModel(input)))),
}));

// ---- design requests ----------------------------------------------------------------------------------------------
const PACK_LIBRARY = {
  source: 'brand-pack',
  pack: {
    id: 'brand', version: '2.0.0', keyId: 'key-1',
    defaultProfiles: { pptx: 'brand', docx: 'Brand-Docs' },
    profiles: {
      brand: { extends: 'technical', label: 'Brand', bestFor: 'Brand decks.', tokens: { colors: { accent: '7C3AED', accent2: 'F59E0B' }, typography: { display: 'Aptos Display' } }, formats: { pptx: { title: 44 } } },
      'brand-docs': { extends: 'editorial', formats: { docx: { margin: 72 } } },
      executive: { tokens: { colors: { accent: '0F766E' } } },
      orphan: { label: 'Orphan' },
      data: 'not an object',
    },
  },
  template: { id: 'tmpl-1', version: '3', source: 'workspace' },
  coverage: { layouts: 4, placeholders: { title: 1 } },
  templateIndexRevision: 'rev-9',
  layouts: [{ name: 'Title', placeholders: ['title'] }, { name: 'Body' }],
  recentCompositions: [
    { fingerprint: 'f1', format: 'pptx', profile: 'brand', purpose: 'decide', expressionMode: 'strong-fit', compositionIds: ['a', '', 'b'], createdAt: '2026-01-02T03:04:05Z' },
    'skip', { fingerprint: 5 },
  ],
  pinned: true,
  warning: 'pack pinned',
};
const LIBRARIES = {
  pack: PACK_LIBRARY,
  bare: { source: 'workspace', pinned: false },
  empty: {},
  notObject: 'x',
  noProfiles: { pack: { id: 'p', defaultProfiles: { xlsx: 'data' } } },
  defaultsOnly: { pack: { defaultProfiles: { pptx: 'Technical' } }, template: { id: 't' }, pinned: 'yes' },
};
const LONG_DECK = {
  profile: 'technical', intent: 'Launch a local-first coding harness for product leaders', audience: 'product and engineering leaders',
  purpose: 'decide', expressionMode: 'strong-fit', palette: { accent: '#00A896' }, signature: 'local-first evidence loop',
};
const DESIGN_CASES = [
  { format: 'pptx', request: {} },
  { format: 'docx', request: {} },
  { format: 'xlsx', request: {} },
  { format: 'pdf', request: {} },
  { format: 'csv', request: {} },
  { format: 'tsv', request: {} },
  { format: 'PPTX', request: 'technical' },
  { format: 'docx', request: 'Data' },
  { format: 'pptx', request: LONG_DECK },
  { format: 'pptx', request: { typography: { display: 'Aptos Display', body: 'Consolas' }, palette: { inverse: '#07080B' } } },
  { format: 'xlsx', request: { purpose: 'financial analysis' } },
  { format: 'xlsx', request: { purpose: 'narrative report' } },
  { format: 'xlsx', request: { purpose: 'technical spec' } },
  { format: 'xlsx', request: { purpose: 'financial', profile: 'technical' } },
  { format: 'xlsx', request: { purpose: '재무 분석' } },
  { format: 'docx', request: { purpose: 'financial analysis' } },
  { format: 'docx', request: { profile: 'editorial', intent: 'Annual report', tone: 'editorial narrative', density: 'DENSE', source: 'sales deck', signature: 'annual', creative: { thesis: 'x' }, compositions: [{ id: 'a' }], review: false } },
  { format: 'docx', request: { density: 'loud', review: false, allowTextOnly: true, allowRepetition: true, allowDecorativeLines: true, allowSyntheticVisuals: true, allowFlatRhythm: true, allowUnsafeFonts: true } },
  { format: 'csv', request: { review: true, frontier: false } },
  { format: 'pdf', request: { palette: { canvas: 'FFFFFF', ink: 'zz', muted: '#abcdef', brand: '12', extra: 'ABCDEF' }, typography: { body: 'Noto Sans KR' } } },
  { format: 'pdf', request: { palette: { 2: 'FF0000', accent: 'bad' } } },
  { format: 'pptx', request: { artDirection: 'immersive-signal', intent: 'Cinematic reveal', purpose: 'explain', expressionMode: 'divergent' } },
  { format: 'pptx', request: { artDirection: false, signature: 'off' } },
  { format: 'pptx', request: { signature: 'loop', deck: { backgroundMode: 'DARK', roles: { cover: 'accent', content: 'nope', closing: ' canvas ' }, sectionSlides: [3, '2', 2, 0, 1.5, -1, 1e21], layoutBias: ['a', null, ''], motifRules: 'single', densityPattern: [], templateMode: ' Strict ', compositionMode: 'LEGACY', enforce: false, requireSlidePlan: false, motif: 'own motif', spacingScale: 'tight', grid: 'g', chartTreatment: 'c', shapeLanguage: 's', imageTreatment: 'i', dominantColorRole: 'accent' }, slidePlans: [{ n: 1 }], brief: { facts: ['x'] } } },
  { format: 'pptx', request: { deck: { backgroundMode: 'light', dominantColorRole: 'ghost' }, content: { decision: 'Go', facts: [{ id: 'a', value: 1 }], claims: [{ id: 'c', text: 'T', factIds: ['a'] }] } } },
  { format: 'pptx', request: { deck: { backgroundMode: 'custom', templateMode: 'bogus', compositionMode: 'model' }, brief: 'not an object', slidePlans: 'x', compositions: 'x', creative: 5 } },
  { format: 'pptx', request: { deck: 'x', content: { objective: 'Plan' } } },
  { format: 'docx', request: { content: { packageId: 'ops', objective: 'Reduce wait', decision: 'Split docks', facts: FACTS, claims: [{ id: 'up', text: 'Revenue grew', factIds: ['rev'] }] } } },
  { format: 'docx', request: { content: 'not an object' } },
  { format: 'docx', request: { content: { facts: [{ id: 'a', bogus: 1 }] } } },
  { format: 'docx', request: { profile: 'zine' } },
  { format: 'odt', request: {} },
  { format: '', request: {} },
  { format: 'docx', request: 5 },
  { format: 'docx', request: null },
  { format: 'docx', request: ['x'] },
  ...Object.keys(LIBRARIES).flatMap((library) => [
    { format: 'pptx', request: {}, library },
    { format: 'docx', request: {}, library },
    { format: 'xlsx', request: { purpose: 'financial' }, library },
    { format: 'pptx', request: { profile: 'brand-docs', signature: 'x' }, library },
    { format: 'pptx', request: { profile: 'orphan' }, library },
  ]),
  { format: 'pptx', request: { profile: 'data' }, library: 'pack' },
  { format: 'docx', request: { profile: 'executive', intent: 'Brand review' }, library: 'pack' },
];
const requestObject = (request) => (typeof request === 'string' ? { profile: request } : request && typeof request === 'object' && !Array.isArray(request) ? request : {});
out.designs = DESIGN_CASES.map((input) => {
  const library = input.library ? LIBRARIES[input.library] : null;
  const context = attempt(() => plain(composition.resolveOfficeCompositionContext(input.format, requestObject(input.request), { recentCompositions: library?.recentCompositions })));
  return {
    input: { ...input, library: input.library ?? null },
    composition: context.value ?? null,
    ...attempt(() => plain(tokens.resolveOfficeDesign(input.format, input.request, { library }))),
  };
});
out.libraries = LIBRARIES;

// ---- catalogue ----------------------------------------------------------------------------------------------------
const CATALOG_CASES = [
  { omitted: true }, { format: '' }, { format: 'docx' }, { format: 'XLSX' }, { format: 'pptx' }, { format: 'pdf' }, { format: 'csv' }, { format: 'tsv' }, { format: 'odt' },
  ...Object.keys(LIBRARIES).flatMap((library) => [{ format: 'docx', library }, { format: '', library }, { format: 'pptx', library }]),
];
out.catalog = CATALOG_CASES.map((input) => ({
  input: { ...input, library: input.library ?? null },
  ...attempt(() => plain(input.omitted ? tokens.officeDesignCatalog() : tokens.officeDesignCatalog(input.format, { library: input.library ? LIBRARIES[input.library] : null }))),
}));

// ---- helpers of design-tokens -------------------------------------------------------------------------------------
out.merge = [
  { base: { a: { b: 1, c: 2 }, d: [1] }, override: { a: { b: 3 }, d: 5, e: null } },
  { base: { a: 1 }, override: null },
  { base: { a: 1 }, override: [1] },
  { base: { a: { x: 1 } }, override: { a: 'text', b: { c: { d: 1 } } } },
  { base: { a: 'text' }, override: { a: { x: 1 } } },
  { base: { 10: 1, b: 2, 2: 3 }, override: { 2: 4, a: 5 } },
  { base: { a: [{ b: 1 }] }, override: { a: [{ c: 2 }] } },
  { base: {}, override: { a: {} } },
].map((input) => ({ input, ...attempt(() => plain(tokens.merge(input.base, input.override))) }));
out.hex = [['#1f7a55', '0'], ['1F7A55', '0'], ['nope', 'fallback'], ['', 'fb'], [null, 'fb'], [0, 'fb'], [123456, 'fb'], ['#abc', 'fb'], ['##123456', 'fb'], ['ABCDEF1', 'fb'], ['ﬀ1234', 'fb'], ['  123456', 'fb'], ['12345G', 'fb']].map(([value, fallback]) => ({ input: { value, fallback }, hex: tokens.hex(value, fallback) }));
out.strings = [['a', null, '', 3, [1, 2], { k: 1 }], 'x', '', null, 0, 5, true, [], [[]], [false, 0]].map((input) => ({ input, strings: tokens.strings(input) }));
out.provenance = [
  { document: ' a.xlsx ', target: 'B2' }, { document: 'a.xlsx' }, { label: 'L', target: 't' }, { label: 'L' }, { target: 't' }, ' s ', '', 5, null, [], { document: '  ' }, { document: 'd', target: ' x ' },
].map((input) => ({ input, text: tokens.provenanceText(input) }));
const COMPACT_REQUESTS = [
  { format: 'docx', request: { content: { packageId: 'p', facts: [{ id: 'a', value: 1, source: 's' }] } } },
  { format: 'pptx', request: LONG_DECK },
  { format: 'xlsx', request: {} },
  { format: 'docx', request: { intent: 'x', creative: { thesis: 'y' } }, library: 'pack' },
];
out.compact = COMPACT_REQUESTS.map((input) => {
  const library = input.library ? LIBRARIES[input.library] : null;
  const context = plain(composition.resolveOfficeCompositionContext(input.format, requestObject(input.request), { recentCompositions: library?.recentCompositions }));
  return {
    input: { ...input, library: input.library ?? null, composition: context },
    ...attempt(() => plain(tokens.compactDesign(tokens.resolveOfficeDesign(input.format, input.request, { library })))),
  };
});
out.compactDesigns = [{}, { content: null, deck: null, review: { required: true } }].map((input) => ({ input, ...attempt(() => plain(tokens.compactDesign(input))) }));

// ---- creative director --------------------------------------------------------------------------------------------
const STORY_DESIGN = {
  format: 'docx',
  request: { intent: 'Quarterly review', audience: 'leaders', signature: 'evidence loop', content: { packageId: 'ops', decision: 'Invest in docks', objective: 'obj', audience: 'ops', facts: FACTS, claims: [{ id: 'c1', text: 'T', factIds: ['rev'] }, { id: 'c2', text: 'U', factIds: ['rate', 'gone'] }] } },
};
const STORY_RESOLVED = tokens.resolveOfficeDesign(STORY_DESIGN.format, STORY_DESIGN.request, { library: null });
out.storyDesign = { ...STORY_DESIGN, composition: plain(composition.resolveOfficeCompositionContext(STORY_DESIGN.format, STORY_DESIGN.request)) };
const OPERATION_SETS = [
  [{ op: 'set_title' }, { op: 'compose_document', kind: 'cover', title: '  Cover   title ' }, { op: 'compose_document', claimId: 'C1', metrics: [{ factId: 'REV' }, { label: 'x' }, { factId: 'rate' }], source: 'a.xlsx', kind: 'metrics' }, { op: 'compose_document', table: { rows: [['a']] }, kind: 'table', title: 'T', takeaway: 'so' }, { op: 'compose_document', kind: 'closing', visualText: 'go', body: 'b' }, 'text', null],
  [{ op: 'compose_document', body: 'a' }, { op: 'compose_document', chart: { type: 'bar' } }, { op: 'compose_document', steps: [1], kind: 'process' }, { op: 'compose_document', allocations: [1] }, { op: 'compose_document', columns: [1], kind: 'comparison' }, { op: 'compose_document', image: 'x.png' }, { op: 'compose_document', visualText: 't', kind: 'statement' }, { op: 'compose_document', body: 'z', kind: 'text' }],
  [{ op: 'compose_document', claimId: 'c2', title: 'Only' }],
  [{ op: 'compose_document', title: 'One' }, { op: 'compose_document', title: 'Two' }],
  [{ op: 'compose_document', kind: ' CLOSING ' }, { op: 'compose_document', kind: 'Cover' }, { op: 'compose_document', kind: 'x'.repeat(60) }],
  [{ op: 'compose_sheet', title: 'Sheet', metrics: [{ factId: 'rev' }] }, { op: 'compose_document', title: 'Doc' }],
  [{ title: 'no op' }, { op: 'compose_document' }],
  [],
  'not a list',
  null,
];
out.storyOperations = OPERATION_SETS;
out.story = ['docx', 'xlsx', 'pptx', 'pdf', 'DOCX'].flatMap((format) =>
  OPERATION_SETS.map((operations, index) => ({ input: { format, operations: index }, ...attempt(() => plain(director.directOfficeStory(format, operations, STORY_RESOLVED))) }))
);
const DEFAULT_DESIGNS = [
  { intent: 'Sheet intent', audience: 'a', tokens: { colors: { accent: '1F7A55' }, typography: { display: 'Cambria' } }, artDirection: { selected: { motif: 'm', deck: { motif: 'deck motif' } } } },
  { artDirection: { selected: { motif: 'only motif' } }, content: { decision: 'D' } },
];
out.storyDefaults = [
  { input: { format: 'docx', operations: [], design: null }, ...attempt(() => plain(director.directOfficeStory('docx'))) },
  { input: { format: 'docx', operations: [{ op: 'compose_document', title: 'T', claimId: 'x' }], design: null }, ...attempt(() => plain(director.directOfficeStory('docx', [{ op: 'compose_document', title: 'T', claimId: 'x' }]))) },
  { input: { format: 'xlsx', operations: [{ op: 'compose_sheet', title: 'A' }, { op: 'compose_sheet' }], design: DEFAULT_DESIGNS[0] }, ...attempt(() => plain(director.directOfficeStory('xlsx', [{ op: 'compose_sheet', title: 'A' }, { op: 'compose_sheet' }], DEFAULT_DESIGNS[0]))) },
  { input: { format: 'xlsx', operations: [{ op: 'compose_sheet', title: 'A' }, { op: 'compose_sheet', takeaway: 'tk', subtitle: 'sub', body: 'bd' }], design: DEFAULT_DESIGNS[1] }, ...attempt(() => plain(director.directOfficeStory('xlsx', [{ op: 'compose_sheet', title: 'A' }, { op: 'compose_sheet', takeaway: 'tk', subtitle: 'sub', body: 'bd' }], DEFAULT_DESIGNS[1]))) },
];
const BRIEF_OPERATION = { op: 'compose_document', title: 'A', creativeBrief: 'old', z: 1 };
const FIRST_STORY = director.directOfficeStory('docx', OPERATION_SETS[0], STORY_RESOLVED);
const BRIEF_CREATIVES = { story: FIRST_STORY, none: null, emptyBriefs: { briefs: [] }, noBriefs: {} };
out.briefCreatives = BRIEF_CREATIVES;
const BRIEF_CASES = [
  ...[1, 2, 3, 4, 0, 5, 6].map((index) => ({ operation: OPERATION_SETS[0][index], index, creative: 'story' })),
  { operation: BRIEF_OPERATION, index: 1, creative: 'story' },
  { operation: BRIEF_OPERATION, index: 1, creative: 'none' },
  { operation: BRIEF_OPERATION, index: 1, creative: 'emptyBriefs' },
  { operation: BRIEF_OPERATION, index: 1, creative: 'noBriefs' },
  { operation: 'text', index: 1, creative: 'story' },
  { operation: [], index: 1, creative: 'story' },
];
out.applyBrief = BRIEF_CASES.map((input) => ({ input, ...attempt(() => plain(director.applyOfficeCreativeBrief(input.operation, BRIEF_CREATIVES[input.creative], input.index))) }));
out.composeOperation = { docx: director.COMPOSE_OPERATION.docx, xlsx: director.COMPOSE_OPERATION.xlsx, keys: Object.keys(director.COMPOSE_OPERATION) };

const fixtures = path.join(FIXTURES_ROOT, 'office-discipline');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(out, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-discipline', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes`);
