#!/usr/bin/env node
// Golden of the office engine's model-facing digest (crate mixdog-office, modules digest and bounded): what Node's
// `finalizeOfficeResult`, `officeDocumentDigest`, `bounded` and `stableJson` of `runtime/office/core/office-core.mjs`
// answer to a fixed corpus of raw results. Writes native/core/fixtures/office-digest/golden.json and the set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-digest.mjs --tree <product tree>
//
// Each digest case is { name, action, session, elapsedMs, input, output }: `input` is the raw result as parsed JSON,
// `output` the exact text `JSON.stringify` gives for what the function returns when it is run on a copy of `input`.
// A session is named by `session` (null for none) and keeps its delivered-design state from case to case, in the order
// of the list, so the corpus covers "once per session". `performance.now` is fixed, so `elapsedMs` is the duration the
// result reports (dyadic values only: they print the same after the subtraction). The corpus is constants; the output is
// byte-stable.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, productIdentity, resolveTree, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-digest.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = productIdentity(tree);
const core = await importFrom(tree, 'src/runtime/office/core/office-core.mjs');

const NOW = 1_000_000;
Object.defineProperty(performance, 'now', { value: () => NOW, configurable: true });

const SESSIONS = {
  docx: { target: 'C:/work/report.docx', format: 'docx', fileKind: 'docx' },
  docm: { target: 'C:/work/macro.docm', format: 'docx', fileKind: 'docm' },
  pptx: { target: 'C:/work/deck.pptx', format: 'pptx', fileKind: 'pptx' },
  sample: { target: 'C:/work/sample.pptx', format: 'pptx', fileKind: 'pptx', factsSample: true },
  authored: { target: 'C:/work/authored.pptx', format: 'pptx', fileKind: 'pptx', authored: true },
  xlsx: { target: 'C:/work/book.xlsx', format: 'xlsx', fileKind: 'xlsx' },
  csv: { target: 'C:/work/data.csv', format: 'csv', fileKind: 'csv' },
  tsv: { target: 'C:/work/data.tsv', format: 'tsv', fileKind: 'tsv' },
  pdf: { target: 'C:/work/doc.pdf', format: 'pdf', fileKind: 'pdf' },
  bare: {},
};

const live = new Map();
const sessionFor = (key) => {
  if (key === null) return null;
  if (!live.has(key)) {
    const spec = SESSIONS[key];
    live.set(key, {
      ...(spec.target ? { target: spec.target } : {}),
      ...(spec.format ? { format: spec.format } : {}),
      ...(spec.fileKind ? { fileKind: spec.fileKind } : {}),
      ...(spec.authored ? { authored: true } : {}),
      ...(spec.factsSample ? { authoredBrief: { factsMode: 'sample' } } : {}),
    });
  }
  return live.get(key);
};

const digestCases = [];
const run = (name, action, session, elapsedMs, input) => {
  const text = JSON.stringify(input);
  const copy = text === undefined ? undefined : JSON.parse(text);
  const startedAt = NOW - elapsedMs;
  const result = core.finalizeOfficeResult(copy, { action, session: sessionFor(session), startedAt });
  digestCases.push({ name, action, session, elapsedMs, input: copy === undefined ? null : JSON.parse(text), output: JSON.stringify(result) ?? null });
};

// ---- designs -------------------------------------------------------------------------------------------------------
const design = (profile, extra = {}) => ({
  profile,
  authoring: 'preset',
  format: 'docx',
  intent: '',
  audience: null,
  layouts: [{ name: 'a' }, { name: 'b' }],
  recentCompositions: [{ id: 1 }],
  artDirection: {
    candidates: [{ id: 1 }, { id: 2 }, { id: 3 }],
    applyTokens: false,
    selected: { style: 'quiet', motif: 'rule', palette: { a: '#fff' }, typography: { h: 'x' }, deck: { d: 1 } },
    candidateCount: 9,
  },
  library: { source: 'pack', pack: 'p1', template: '', pinned: false, warning: null, templateIndexRevision: 'abc', recentCompositionCount: 4 },
  tokens: { color: { accent: '#123456' } },
  creative: { thesis: 'one', discipline: { rules: ['r1'], typographyRoles: { h: 1 }, paletteSlots: ['a'], colorRoles: ['b'] } },
  ...extra,
});

run('create docx with a design', 'create', 'docx', 12.5, {
  session: 'office_0123456789abcdef', mode: 'background', visible: false, created: false, reused: false, foregroundActivated: false,
  backgroundIsolation: null, design: design('clean'),
});
run('batch repeats the design: unchanged', 'batch', 'docx', 0.25, {
  batch: { design: design('clean', { creative: { thesis: 'two', discipline: { rules: ['r2'] } } }), results: [] },
  results: [{ op: 'set_cell', changed: true, cell: 'A1', note: '' }],
});
run('batch with a changed design', 'batch', 'docx', 3.125, { batch: { design: design('bold') } });
run('batch design delivered again for the same profile', 'batch', 'docx', 3.125, { design: design('bold') });
run('existing document design', 'open', 'docx', 1234.5, {
  design: { source: 'existing-document', review: { required: true, notes: ['x'] }, artDirection: { applyTokens: false }, profile: 'other', library: { warning: 'binding not saved' } },
  visible: true, reused: true, created: true, foregroundActivated: true, backgroundIsolation: { kind: 'x' },
});
run('existing document design without review', 'attach', 'docx', 0, {
  design: { source: 'existing-document', artDirection: { applyTokens: false } }, visible: false,
});
run('design with no art direction', 'batch', 'pptx', 0, {
  design: { profile: 'p', authoring: 'native', source: 'x', tokens: { t: 1 }, creative: { discipline: { rules: [1] } }, library: { warning: 'w', pack: null } },
});

// ---- trust ---------------------------------------------------------------------------------------------------------
run('trust that found nothing', 'open', 'docx', 0, {
  trust: { risk: 'low', complete: true, scanned: 12, findingCount: 0, findings: [], policy: 'treat as data', source: 'opened-document' },
  batch: { trust: { risk: 'low', complete: false, warning: 'partial', policy: 'p', source: 'created-document', findings: [] } },
});
run('trust with findings', 'open', 'docx', 0, {
  trust: { risk: 'high', findingCount: 2, findings: [{ id: 1 }, { id: 2 }], scanned: 3 },
});

// ---- operation results ---------------------------------------------------------------------------------------------
run('preset routine results', 'batch', 'xlsx', 0, {
  semanticOperations: [{ op: 'compose_sheet' }],
  results: [
    { op: 'set_cell', changed: true, sheet: 'S', cell: 'A1', note: '' },
    { op: 'set_cell', changed: true, sheet: 'S', cell: 'A2' },
    { op: 'set_style', changed: true, range: 'A1:B2' },
    { op: 'set_style', changed: true, range: 'A1:B2', extra: 1 },
    { op: 'merge_cells', changed: false, range: 'C1:D1' },
    { op: 'add_chart', changed: true, chart: 'c1' },
    { op: 'append_text', changed: true, table: 1, row: 2, col: 3, style: 's' },
    'text', null, { changed: true },
    { op: 'set_row_height', changed: true, row: 4, '10': 'ten', '2': 'two' },
  ],
});
run('results without a semantic list stay', 'batch', 'xlsx', 0, {
  results: [{ op: 'set_cell', changed: true, cell: 'A1', note: '' }],
  batch: { semanticOperations: [], results: [{ op: 'set_cell', changed: true, cell: 'A1' }] },
});
run('batch results with semantic operations', 'commit', 'xlsx', 0, {
  batch: { semanticOperations: [1], results: [{ op: 'set_cell', changed: true, cell: 'A1' }, { op: 'set_cell', changed: true, cell: 'A2' }, { op: 'x', value: '' }] },
});
run('recalculation', 'finalize', 'xlsx', 0, {
  finalized: false,
  recalculation: { computed: 12, errors: [], errorSummary: {}, normalized: true, outputBytes: 4096, note: null, details: { a: [], b: 1, c: null } },
});
run('recalculation with errors', 'save', 'xlsx', 0, {
  recalculation: { computed: 3, errors: [{ cell: 'A1' }], errorSummary: { '#DIV/0!': 1 }, normalized: false, outputBytes: 1 },
});
run('metrics already present', 'rollback', 'docx', 0, { metrics: { calls: 3, durationMs: 99 }, ok: true });
run('artifact actions', 'save', 'docm', 0, { ok: true });
run('commit artifact', 'commit', 'pptx', 0, { ok: true });
run('secure artifact', 'secure', null, 0, { output: 'C:/out/secured.pdf', ok: true });
run('secure with a session', 'secure', 'pdf', 0, { output: 'C:/out/secured.pdf' });
run('secure without output', 'secure', null, 0, { ok: true });
run('render artifact', 'render', 'pptx', 0, { output: 'C:/out/render.png', pages: 3 });
run('render without output', 'render', 'pptx', 0, { pages: 1 });
run('author with output', 'author', 'pptx', 0, { output: 'C:/out/deck.pptx', design: design('authored') });
run('author without output', 'author', 'pptx', 0, { ok: true });
run('create without a session', 'create', null, 0, { ok: true });
run('create on a session with nothing', 'create', 'bare', 0, { ok: true });
run('csv create', 'create', 'csv', 0, { design: design('csv'), batch: { design: design('csv'), results: [] } });
run('tsv batch', 'batch', 'tsv', 0, { batch: { design: design('tsv'), trust: { risk: 'low', findings: [] } }, design: null });
run('pdf create', 'create', 'pdf', 0, { design: design('pdf') });
run('sample deck facts', 'author', 'sample', 0, { ok: true });
run('sample deck qa', 'qa', 'sample', 0, { ok: true });
run('sample deck batch carries no disclosure', 'batch', 'sample', 0, { ok: true });
run('sample deck finalize', 'finalize', 'sample', 0, { ok: true, finalized: true });
run('authored deck finalize', 'finalize', 'authored', 0, { finalized: true, design: design('x'), review: { ok: true } });
run('not an object: string', 'batch', null, 0, 'plain');
run('not an object: number', 'batch', null, 0, 5);
run('not an object: null', 'batch', null, 0, null);
run('not an object: array', 'batch', null, 0, [1, { a: 2 }]);
run('no action', '', null, 0, { x: 1 });

// ---- qa and finalize reviews ---------------------------------------------------------------------------------------
const issue = (code, extra = {}) => ({ code, path: `/p/${code}`, message: `message ${code}`, ...extra });
const qaReview = (extra = {}) => ({
  ok: false,
  issuesBefore: [issue('before')],
  issuesAfter: [issue('a'), issue('b')],
  advisoryIssues: [issue('a')],
  fixes: [],
  visualReview: { status: 'reviewed', score: 3 },
  baseline: { available: false },
  preview: { images: [{ name: 'p1.png' }], visualCoverage: { mode: 'full', pages: 2 }, output: 'o' },
  review: {
    images: [1], output: 'x', visualCoverage: { mode: 'full' },
    design: { issues: [issue('a'), issue('b')], modelReview: ['look at spacing', 'check contrast'], verdict: 'ok' },
    polishPlan: ['p'],
    trust: { risk: 'low', findingCount: 0, findings: [], scanned: 4 },
    visualDiff: { available: false, pages: [], images: [] },
    render: { pages: [{ n: 1 }], aesthetics: { confidence: 0.8, score: 4, pages: [{ n: 1 }] } },
    quality: { score: 5, visualReview: { status: 'reviewed', score: 3 } },
    checklist: {
      items: [{ id: 'a', status: 'pass' }, { id: 'full-render-coverage', status: 'fail' }, { id: 'b', status: 'fail' }],
      summary: { total: 3, failed: 2, passed: 1 },
    },
  },
  ...extra,
});
run('qa first review', 'qa', 'pptx', 0, qaReview());
run('qa second review: guidance not repeated', 'qa', 'pptx', 0, qaReview());
run('qa measure-only', 'qa', 'xlsx', 0, {
  ok: true, issuesAfter: [], fixes: [{ id: 1 }], issuesBefore: [issue('z')],
  preview: { images: [], visualCoverage: { mode: 'measure-only' } },
  review: {
    quality: { score: 1 }, render: { aesthetics: { confidence: 0 }, pages: [] },
    checklist: { items: [{ id: 'full-render-coverage', status: 'fail' }, { id: 'q', status: 'warn' }], summary: { total: 2, failed: 1 } },
  },
});
run('qa zero-confidence aesthetics', 'qa', 'pptx', 0, {
  review: { render: { aesthetics: { confidence: 0, score: 1 }, other: 1 }, checklist: { items: [{ status: 'pass' }] } },
});
run('qa advisory not a subset', 'qa', 'docx', 0, {
  issuesAfter: [issue('a')], advisoryIssues: [issue('a'), issue('c')], review: { ok: true },
});
run('qa advisory codes deduplicated', 'qa', 'docx', 0, {
  issuesAfter: [issue('a'), issue('b'), { code: 'a', path: '/other', message: 'm2' }],
  advisoryIssues: [issue('a'), issue('b'), { code: 'a', path: '/other', message: 'm2' }, { path: 'no-code' }], review: { ok: true },
});
run('qa advisory with no codes', 'qa', 'docx', 0, { issuesAfter: [{ path: 'p' }], advisoryIssues: [{ path: 'p' }], review: {} });
run('qa without a review', 'qa', 'docx', 0, { ok: true, issuesBefore: [] });
run('qa visual review repeated at the top', 'qa', 'docx', 0, {
  visualReview: { status: 'ok' }, review: { quality: { visualReview: { status: 'ok' } } },
});
run('qa nested visual review equal to the result one', 'qa', 'docx', 0, {
  visualReview: { status: 'ok', n: 2 }, review: { quality: { visualReview: { status: 'ok', n: 2 }, score: 1 } },
});
run('qa baseline and diff kept', 'qa', 'docx', 0, {
  baseline: { available: true, same: true },
  review: { visualDiff: { available: false, pages: [1], images: [] }, design: { issues: 'x' }, render: { pages: [], aesthetics: 'n/a' } },
});
run('qa checklist without summary', 'qa', 'pptx', 0, {
  preview: { visualCoverage: { mode: 'measure-only' }, images: [{ a: 1 }] },
  review: { checklist: { items: [{ id: 'full-render-coverage', status: 'x' }, { id: 'y', status: 'pass' }] } },
});
run('qa fixes list', 'qa', 'docx', 0, { fixes: [{ id: 1 }], issuesBefore: [issue('k')], review: { ok: true } });

const finalizeValidation = (extra = {}) => ({
  session: 'office_0123456789abcdef',
  path: 'C:/work/report.docx',
  mode: 'visible',
  backend: 'microsoft-office-com',
  format: 'docx',
  entries: 14,
  mainPart: 'word/document.xml',
  mainContentType: 'application/x',
  mainContentTypeMissing: false,
  validation: 'package',
  parts: [],
  duplicates: [],
  missingRelationshipTargets: [],
  schema: {
    ok: true, path: 'C:/work/report.docx', rawValid: true, version: '2019', available: true, cached: true, downloaded: false,
    officeVersion: '16', validation: 'ok', omittedErrors: 0, errors: [],
  },
  native: {
    ok: true, opened: true, reopened: true, persisted: true, documentSaved: false, snapshot: { shapes: [1, 2] }, snapshotFingerprint: 'f',
    excelDpiRepairs: 0, issueCount: 0, issues: [],
  },
  security: { macroExecution: 'disabled' },
  postSaveGate: { ok: true, criticalCount: 0 },
  baseline: { original: 'o', originalEntries: 3, savedBy: 'x', compared: true, applicationSaved: true, addedParts: ['p1'], digitalSignatureInvalidated: false, changedParts: ['word/document.xml'] },
  ...extra,
});
run('finalize passed validation', 'finalize', 'docx', 0, {
  session: 'office_0123456789abcdef', path: 'C:/work/report.docx', finalized: true, saved: true,
  validation: finalizeValidation(), review: { ok: true, issuesAfter: [], review: { design: { modelReview: ['m'], issues: [issue('z')] } } },
  recalculation: null, composition: { count: 0 }, compositionHistory: null, design: design('clean'),
});
run('finalize passed validation again', 'finalize', 'docx', 0, {
  finalized: true, validation: finalizeValidation(), review: { ok: true, issuesAfter: [], review: { design: { modelReview: ['m'] } } },
  composition: { count: 2 }, compositionHistory: [1],
});
run('finalize failed validation keeps its detail', 'finalize', 'docx', 0, {
  finalized: false,
  validation: finalizeValidation({
    mainContentTypeMissing: true,
    schema: { ok: false, path: 'p', rawValid: false, version: '2019', errors: [{ m: 1 }], omittedErrors: 3 },
    native: { ok: false, opened: false, documentSaved: true, issueCount: 2, issues: [{ i: 1 }], excelDpiRepairs: 1, snapshotFingerprint: 'g' },
    security: { macroExecution: 'enabled' },
    postSaveGate: { ok: false, criticalCount: 2 },
    baseline: { compared: false, digitalSignatureInvalidated: true, applicationSaved: false, addedParts: ['q'] },
  }),
  review: null,
});
run('finalize native issue count differs', 'finalize', 'docx', 0, {
  finalized: true,
  validation: { native: { ok: true, issueCount: 1, issues: [{ i: 1 }, { i: 2 }], opened: true }, security: { macroExecution: 'disabled', digitalSignatureInvalidated: true }, postSaveGate: { ok: true, criticalCount: 1 }, schema: { ok: true, omittedErrors: 4, path: 'x' } },
});
run('finalize validation path equals the session target', 'finalize', 'docx', 0, {
  finalized: true, session: 'office_aaaaaaaaaaaaaaaa', validation: { session: 'office_bbbbbbbbbbbbbbbb', path: 'C:/work/report.docx', native: { ok: true, snapshot: null } },
  review: { mode: 'x', backend: 'y' },
});
run('finalize with a review mode keeps the check mode off', 'finalize', 'docx', 0, {
  finalized: true, validation: { mode: 'visible', backend: 'b', path: 'other.docx' }, review: { mode: 'visible', backend: 'b' },
});
run('create with finalize true', 'create', 'xlsx', 0, {
  finalized: true, review: qaReview({ visualReview: { status: 'reviewed', score: 3 } }), visualReview: { status: 'reviewed', score: 3 },
  visualCritique: { status: 'accepted', entries: [{ page: 1 }, { page: 2 }] },
});
run('finalize review with a critique', 'finalize', 'xlsx', 0, {
  finalized: true,
  review: {
    ok: true, visualCritique: { status: 'accepted', entries: [{ page: 1 }, { page: 2 }] }, visualReview: { status: 'ok' },
    review: { design: { modelReview: ['n'], issues: [], verdict: 'v' }, polishPlan: ['x'], quality: { visualReview: { status: 'ok' } } },
  },
  visualReview: { status: 'ok' },
});
run('refused finalize', 'finalize', 'docx', 0, { finalized: false, review: null, recalculation: null, error: 'x' });
run('finalize with a review of a csv session', 'finalize', 'csv', 0, {
  finalized: true, review: { ok: true, issuesAfter: [], fixes: [], preview: { visualCoverage: { mode: 'structural', gaps: [] }, images: [{ a: 1 }] }, extra: 1 },
  design: design('csv'), batch: { design: design('csv') },
});
run('finalize a csv review without coverage', 'finalize', 'csv', 0, { finalized: false, review: { ok: false, issuesAfter: [issue('c')] } });
run('finalize with a string review', 'finalize', 'docx', 0, { finalized: true, review: 'refused' });

// ---- documents -----------------------------------------------------------------------------------------------------
const documents = [];
const document = (name, input) => {
  const text = JSON.stringify(input);
  documents.push({ name, input: JSON.parse(text), output: JSON.stringify(core.officeDocumentDigest(JSON.parse(text))) ?? null });
};

document('docx snapshot', {
  format: 'docx', title: 'T',
  paragraphs: [
    { index: 1, path: '/body/p[1]', text: 'Hello', runs: [{ path: '/body/p[1]/r[1]', index: 1, text: 'Hello' }], start: 0, end: 5, pageStart: 1, pageEnd: 1, font: { name: '', bold: false, italic: false, underline: false, size: 11 } },
    { index: 2, path: '/body/p[2]', text: 'Two', runs: [{ path: '/body/p[2]/r[1]', index: 1, text: 'Two', bold: true }], pageStart: 1, pageEnd: 2, format: { alignment: 0, spacingBefore: 0, spacingAfter: 7.9000000953674, keepWithNext: 0, tabs: [], leftIndent: 36.0000002 } },
    { index: 3, text: 'Three', runs: [{ text: 'Three', index: 1 }, { text: 'x' }], font: { name: 'Arial', bold: true } },
    { index: 4, text: '', runs: [{ text: '' }] },
    'odd',
  ],
  parts: [{ part: 'word/document.xml', text: 'Hello Two' }, { part: 'word/header1.xml', text: 'H' }, { part: 'word/document.xml', text: 'x', extra: 1 }, { part: 'word/footer1.xml' }],
  comments: [{ id: 1, resolved: false, replies: [], text: 'c' }, { id: 2, resolved: true, replies: [{ t: 1 }] }, 'x'],
  revisions: [], notes: [], controls: [], images: [],
  tables: [{ start: 3, end: 9, alignment: 0, pageStart: 1, pageEnd: 1, rows: 2 }, { alignment: 1, pageStart: 1, pageEnd: 2 }, 'x'],
  sections: [
    { topMargin: 70.9000015258789, bottomMargin: 70.9000015258789, leftMargin: 'x', orientation: 0, columns: 1, columnSpacing: 36.0000001, stories: [{ kind: 'header', text: '', linkToPrevious: false }, { kind: 'footer', text: 'a\r\nb\rc', linkToPrevious: false }, { kind: 'x', text: 'z', linkToPrevious: true }, 'odd'] },
    { orientation: 1, columns: 2, stories: [{ text: '' }] },
    { orientation: 'portrait', stories: [] },
    'odd',
  ],
  blockOrder: [
    { type: 'paragraph', index: 1, path: '/body/p[1]' }, { type: 'paragraph', index: 2, path: '/body/p[2]' }, { type: 'paragraph', index: 3, path: '/body/p[3]' },
    { type: 'table', index: 1, path: '/body/tbl[1]' }, { type: 'paragraph', index: 4, path: '/body/p[4]' }, { type: 'paragraph', index: 6, path: '/body/p[6]' }, { type: 'sdt' },
  ],
  pagination: { hasMore: false },
});
document('docx paged snapshot keeps the main part', {
  format: 'docx', paragraphs: [{ index: 1, text: 'a' }], parts: [{ part: 'word/document.xml', text: 'a' }], pagination: { hasMore: true, offset: 0 },
});
document('docx truncated snapshot keeps the main part', {
  format: 'docx', paragraphs: [{ index: 1, text: 'a' }], parts: [{ part: 'word/document.xml', text: 'a' }], truncated: true,
});
document('docx without paragraphs', { format: 'docx', paragraphs: [], parts: [{ part: 'word/document.xml', text: 'a' }], blockOrder: [] });
document('docx without a paragraphs list', { format: 'docx', title: 'x' });
document('docx part list of one kept part', { format: 'docx', paragraphs: [{ text: 'a' }], parts: [{ part: 'word/document.xml', text: 'a' }] });
document('docx block order of one table', { format: 'docx', paragraphs: [{ text: 'a' }], blockOrder: [{ type: 'table', index: 1, path: '/body/tbl[1]' }] });
document('xlsx workbook', {
  format: 'xlsx', defaultStyle: { fontName: 'Calibri', fontSize: 11 }, definedNames: [], definedNameCount: 0, calculation: { mode: '', fullCalcOnLoad: false, forceFullCalc: false },
  sheets: [
    {
      name: 'Data', visibility: 'visible', index: 1, cellCount: 0, tableCount: 0, chartCount: 2, imageCount: 0, mergeCount: 0, tables: [], charts: [], notes: null,
      protection: { sheet: false, workbook: false }, freezePanes: { frozen: false }, pageSetup: { orientation: '', zoom: 100, fitToPage: false, fitToPagesWide: 0, fitToPagesTall: 0, paperSize: 9 },
      cells: [
        { ref: 'A1', value: 1, formula: '', style: { bold: false, italic: false, underline: false, numberFormat: 'General', fontSize: 11, fontName: 'Calibri' } },
        { ref: 'B2', value: 3, formula: 'A1+2', style: { bold: true, numberFormat: '0.0', fontSize: 12 } },
        { ref: 'C3', formula: null, value: 'x', style: null },
        { ref: 'D4', style: {} }, 'odd',
      ],
      formulaLineage: [
        { from: '/sheet[Data]/cell[B2]', precedents: [{ sheet: 'Data', ref: 'A1' }, { sheet: 'Other', ref: 'C3' }, { ref: 'D1' }, 'E1', null] },
        { from: '/x/cell[A]/cell[Z9]', precedents: [] }, { from: 'no cell', precedents: [{ sheet: 'Other' }] }, { from: '/cell[]' }, { precedents: [{ sheet: 'Data', ref: null }] },
      ],
      lineageCount: 2,
    },
    { name: 'Hidden', visibility: 'hidden', protection: { sheet: true }, freezePanes: { frozen: true, row: 1 }, pageSetup: { orientation: 'landscape', zoom: 80, fitToPage: true } },
    'odd',
  ],
});
document('xlsx workbook with names', {
  format: 'xlsx', definedNames: [{ name: 'N', ref: 'A1' }], definedNameCount: 1, calculation: { mode: 'auto' }, sheets: [{ name: 'S', cellCount: 4 }],
});
document('xlsx without sheets', { format: 'xlsx', definedNames: [] });
document('pptx portable deck', {
  format: 'pptx',
  layouts: [{ index: 3, name: 'Title', part: 'ppt/slideLayouts/slideLayout1.xml', path: '/layout[1]' }, { name: 'Body' }, 'x', { index: null, name: null }],
  slides: [
    { index: 1, hidden: false, shapes: [{ id: 1, font: { size: 18, name: 'Arial', color: 'FF0000' }, sizes: [18], fonts: ['Arial'], colors: ['FF0000'] }, { id: 2, font: { size: 12 }, sizes: [12, 14] }, { id: 3 }, 'x'] },
    { index: 2, hidden: true, shapes: [] },
    { index: 3 },
    'x',
  ],
});
document('pptx COM deck', {
  format: 'pptx',
  slides: [
    {
      index: 1, name: 'S', hidden: false, notes: '', comments: [], animations: [], transition: { effect: 0, advanceOnTime: false },
      shapes: [
        {
          type: 1, name: 'Title', left: 10.123456, top: 20.5, width: 300.00001, height: 50, rotation: 0, geometry: '', text: 'Hello', mixed: -2147483648, nothing: null,
          textFrame: { marginLeft: 7.2, marginTop: 3.6, marginRight: 7.2, marginBottom: 3.6, paragraphSpacing: 0, wordWrap: true, autoSize: -2147483648 },
          textBounds: { left: 1.234, top: 2.345, width: 3.456, height: 4.567 },
          font: { name: 'Arial', size: 18, bold: 0, italic: false, underline: 1, color: 'FF0000' },
          runs: { sizes: [18], fonts: ['Arial'], colors: [255] },
          shadow: { visible: 1, offsetX: 1.23456, blur: 2 }, fillVisible: true, fillColor: 'AA', lineVisible: false, lineColor: 'BB', lineTransparency: 0,
        },
        { type: 3, name: 'Chart', text: '', textFrame: { marginLeft: 7.2 }, textBounds: { left: 0 }, font: { name: '', size: 0 }, shadow: { visible: false }, fillVisible: false, fillColor: 'CC', fillTransparency: 1, chart: { chartType: 51, series: [{ name: 'S1', formula: '', axisGroup: 1, trendlineCount: 0, hasErrorBars: false, hasDataLabels: false, dataLabels: null, chartType: 4 }, { name: 'S2', formula: '=Sheet1!A1', axisGroup: 2, chartType: 99, trendlineCount: 1 }, 'x'] } },
        { type: 4, chart: { chartType: -4120 } }, { type: 5, chart: { chartType: 'pie' } }, { type: 6, chart: { series: 'x' } },
        { type: 7, text: 'T', runs: { sizes: [11], colors: [16711680] }, font: { size: 11, color: '0000ff' } },
        { type: 8, text: 'U', runs: { sizes: [11, 12], colors: [1] }, font: { size: 12, color: 'zz' } },
        { type: 9, text: 'V', runs: { sizes: [10] }, font: 'bold' },
      ],
    },
    { index: 2, hidden: true, notes: 'n', comments: [{ c: 1 }], animations: [{ a: 1 }], transition: { effect: 2, advanceOnTime: false }, shapes: [] },
    { index: 3, transition: { effect: 0, advanceOnTime: true }, animations: [] },
    { index: 4, transition: { effect: 0 }, animations: [], notes: '' },
  ],
});
document('pptx without slides', { format: 'pptx', layouts: [{ name: 'x' }] });
document('pdf read', {
  format: 'pdf', pageCount: 0, totalPages: 12, attachmentCount: 0, attachments: [], outlineCount: 0, outline: [], scannedPageCount: 1, encrypted: false, passwordRequired: false, linearized: false,
  metadata: { title: '', author: 'A', subject: null, keywords: '' }, pagination: { hasMore: false, offset: 0, limit: 20 },
  pages: [{ number: 1, width: 595.27559, height: 841.8899, rotation: 0, text: 'x', scanned: false }, { number: 2, width: 612, height: 792, rotation: 90 }, null, { rotation: 0 }],
  fields: [
    { name: 'f1', type: 'text', readOnly: false, required: true, multiline: false, value: false, widgets: [{ page: 1, x: 1.23456, y: 2.5, width: 10, height: 20.005, rect: [1, 2] }, null] },
    { name: 'f2', options: [], value: null, widgets: [] },
  ],
});
document('pdf paged read keeps its pagination', { format: 'pdf', pagination: { hasMore: true, offset: 0 }, metadata: {} });
document('pdf offset read keeps its pagination', { format: 'pdf', pagination: { hasMore: false, offset: 20 }, passwordRequired: true });
document('pdf pagination of a read with no offset', { format: 'pdf', pagination: { limit: 5 } });
document('csv sheets', { format: 'csv', sheets: [{ name: 'a', cells: [{ ref: 'A1', row: 1, column: 1, value: 'x' }, 'x', { row: 2 }] }, { name: 'b' }, 'x'] });
document('tsv without sheets', { format: 'tsv', title: 'x' });
document('unknown format', { format: 'rtf', paragraphs: [] });
document('no format', { paragraphs: [] });
document('not an object', 'text');
document('null', null);

// ---- bounded and stableJson ----------------------------------------------------------------------------------------
const boundedCases = [];
const bounded = (name, value, maxChars, length = null) => {
  const text = JSON.stringify(value);
  boundedCases.push({ name, value: JSON.parse(text), maxChars, length, output: JSON.stringify(core.bounded(JSON.parse(text), maxChars, length)) ?? null });
};
const snapshot = (extra = {}) => ({
  session: 'office_0123456789abcdef', ok: true,
  document: { format: 'docx', title: 'T', count: 3, flag: true, nothing: null, paragraphs: [{ text: 'x'.repeat(100) }], pagination: { limit: 20, offset: 0, returned: 20, nextCursor: 'c', hasMore: true }, ...extra },
});
bounded('within the limit', snapshot(), 100000);
bounded('exactly at the limit', { a: 1 }, 7);
bounded('one over the limit', { a: 1 }, 6);
bounded('the length decides', snapshot(), 50, 10);
bounded('the length decides over', { a: 'x' }, 100, 1000);
bounded('long snapshot', snapshot(), 120);
bounded('odd page limits', snapshot({ pagination: { limit: 7 } }), 10);
bounded('page limit of one', snapshot({ pagination: { limit: 1 } }), 10);
bounded('no page limit', snapshot({ pagination: {} }), 10);
bounded('string page limit', snapshot({ pagination: { limit: '9' } }), 10);
bounded('zero page limit', snapshot({ pagination: { limit: 0 } }), 10);
bounded('no pagination', { document: { format: 'pdf', pages: [1, 2, 3] }, extra: 1 }, 10);
bounded('no document', { a: 'x'.repeat(50), b: 2 }, 10);
bounded('non-object document', { document: 'text', a: 'x'.repeat(50) }, 10);
bounded('array value', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10);
bounded('wide characters', { text: '한글'.repeat(20) }, 15);
bounded('integer-like keys', { '2': 'b', '1': 'a', z: 'x'.repeat(30), document: { '5': 1, a: 'long'.repeat(10) } }, 20);
bounded('document key order', { b: 1, document: { x: 1 }, a: 2 }, 5);
bounded('zero maximum', { a: 1 }, 0);

const stableCases = [];
const stable = (name, value) => {
  const text = JSON.stringify(value);
  stableCases.push({ name, value: JSON.parse(text), output: core.stableJson(JSON.parse(text)) });
};
stable('object keys sorted', { b: 1, a: 2, '10': 3, '9': 4, Z: 5 });
stable('nested', { z: [{ y: 1, x: [3, 2, { b: 1, a: 0 }] }], a: { c: null, b: true } });
stable('unicode keys', { 'é': 1, '😀': 2, A: 3, '\uffff': 4, '한': 5 });
stable('escapes', { 'a"b': 'x\ny', 'c\\d': '\u0001\u2028' });
stable('numbers', [1, 1.5, -0, 1e21, 0.1, 123456789.123, 5e-7]);
stable('empty containers', { a: [], b: {}, c: '' });
stable('primitives: null', null);
stable('primitives: string', 'text');
stable('primitives: number', 12);
stable('primitives: bool', false);
stable('array of objects', [{ b: 1, a: 2 }, { a: 1 }]);

const golden = {
  note: 'Recorded from Node core/office-core.mjs; tests/twin_digest.rs replays it.',
  elapsed: 'performance.now is fixed; a case reports elapsedMs as metrics.durationMs (toFixed(2))',
  sessions: SESSIONS,
  digest: digestCases,
  documents,
  bounded: boundedCases,
  stableJson: stableCases,
};

const fixtures = path.join(FIXTURES_ROOT, 'office-digest');
mkdirSync(fixtures, { recursive: true });
const text = `${JSON.stringify(golden, null, 2)}\n`;
writeFileSync(path.join(fixtures, 'golden.json'), text);
writeSetManifest(fixtures, { set: 'office-digest', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identity });
console.log(`golden.json ${text.length} bytes: ${digestCases.length} digest cases, ${documents.length} documents, ${boundedCases.length} bounded, ${stableCases.length} stableJson`);
