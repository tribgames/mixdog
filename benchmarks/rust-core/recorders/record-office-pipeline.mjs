#!/usr/bin/env node
// Golden of the office quality pipeline (crate mixdog-office-quality): what Node's `runtime/office/quality/*` answers
// to a fixed corpus of review issue lists and review inputs: the normalised issues, the polish plan, the submission
// gate, the render output path, the release score, the page review of a document, the document and presentation
// acceptance verdicts and the assurance checklist. Writes native/core/fixtures/office-pipeline/golden.json and the
// set's manifest.
//
//   node benchmarks/rust-core/recorders/record-office-pipeline.mjs --tree <product tree>
//
// Every section is a list of cases { input, output }; the corpus is constants and a seeded generator, every input is
// plain JSON (the replay reads it back), and keys are written in the order the modules produce them. The corpus
// carries the inputs of the quality suites (quality-pipeline.test.mjs, presentation-acceptance.test.mjs,
// document-acceptance.test.mjs) and the codes the polish guidance and the checklist rules name.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-office-pipeline.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'office-pipeline');
const stage = stageSet(finalDir);
const load = (name) => importFrom(tree, `src/runtime/office/quality/${name}`);

const pipeline = await load('quality-pipeline.mjs');
const score = await load('quality-score.mjs');
const documents = await load('document-acceptance.mjs');
const presentations = await load('presentation-acceptance.mjs');
const checklists = await load('assurance-checklist.mjs');
const issues = await load('assurance-issue.mjs');

const plain = (value) => JSON.parse(JSON.stringify(value));
const attempt = (run) => {
  try {
    return { output: run() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const cases = (inputs, run) => inputs.map((raw) => {
  const input = plain(raw);
  return { input, ...attempt(() => plain(run(plain(input)))) };
});

// A small deterministic generator, so the large grids are the same on every run.
let seed = 20260101;
const next = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(next() * list.length)];

// The codes named by the polish guidance table, read from the source (the table is not exported).
const pipelineSource = readFileSync(join(tree, 'src/runtime/office/quality/quality-pipeline.mjs'), 'utf8');
const guidanceStart = pipelineSource.indexOf('const POLISH_GUIDANCE = Object.freeze(');
const guidanceCodes = [...pipelineSource.slice(guidanceStart, pipelineSource.indexOf('\n});', guidanceStart)).matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
const setCodes = (name) => {
  const start = pipelineSource.indexOf(`const ${name} = new Set([`);
  return [...pipelineSource.slice(start, pipelineSource.indexOf(']);', start)).replace(/\/\/.*$/gm, '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};
const criticalCodes = setCodes('CRITICAL_CODES');
const advisoryCodes = setCodes('ADVISORY_CODES');

const at = (code, path = '/slide[2]', severity = 'warning', message = code) => ({ code, severity, path, message });
const styleCodes = ['accent_hue_overuse', 'font_family_overuse', 'decorative_stripe', 'consecutive_beats', 'consecutive_composition_repeat', 'repeated_layout_grammar', 'vertical_imbalance'];
const style = at('vertical_imbalance');

const issueLists = [
  [],
  styleCodes.map((code) => at(code)),
  ...criticalCodes.map((code) => [style, at(code)]),
  ...['package_corrupt', 'missing_relationship', 'formula_error', 'broken_chart', 'shape_overlap', 'shape_out_of_bounds', 'text_outside_slide', 'text_overflow', 'render_failed'].map((code) => [style, at(code)]),
  [at('blank_page', '/page[1]'), at('blank_page', '/page[1]'), at('blank_page', '/page[2]'), at('blank_page', '/page[1]', 'error')],
  [null, 'text', 5, true, [], ['a', 'b'], {}, { code: 'blank_page' }, { path: '/x' }, { message: 'only a message' }],
  [at('shape_overlap', '/slide[10]'), at('shape_overlap', '/slide[2]'), at('text_overflow', '/Sheet1', 'warning'), at('low_contrast', '/sheet1'), at('small_font', '/'), at('low_contrast', '/가'), at('low_contrast', '/ä'), at('low_contrast', '/z'), at('low_contrast', '/A')],
  [at('low_contrast', '/b', 'ERROR'), at('low_contrast', '/a', 'Warning'), at('low_contrast', '/c', 'info'), at('low_contrast', '/d', 'critical'), at('low_contrast', '/e', '')],
  [at('made_up_code', '/p', 'warning', 'No guidance for this one'), { severity: 'warning', path: '/q', message: 'no code' }, { code: 42, path: '/r', message: 'numeric code' }, { code: null, path: '/s' }, { code: 'made_up_code', path: '/p', message: 'second wording' }],
  [{ code: 'blank_page', severity: 'warning' }, { code: 'blank_page', severity: 'warning', path: '', message: '' }, { code: 'blank_page', path: 0 }, { code: 'blank_page', path: null }],
  [{ code: 'sparse_page', path: '/p', message: 'm', source: 'x', extra: { nested: [1, 2] }, severity: 'warning' }, { code: 'sparse_page', path: '/p', message: 'm', source: 'y', severity: 'warning' }],
  guidanceCodes.map((code, index) => at(code, `/item[${index % 7}]`, index % 5 === 0 ? 'error' : 'warning')),
  guidanceCodes.map((code, index) => at(code, '/one-path', index % 3 === 0 ? 'info' : 'warning')),
  advisoryCodes.map((code) => at(code, '/adv', 'warning')),
  criticalCodes.map((code) => at(code, '/crit', 'info')),
];
for (let round = 0; round < 40; round += 1) {
  const pool = [...criticalCodes, ...advisoryCodes, ...guidanceCodes, 'unknown_a', 'unknown_b'];
  issueLists.push(Array.from({ length: 1 + Math.floor(next() * 14) }, () => at(pick(pool), pick(['/', '/slide[1]', '/slide[2]', '/slide[11]', '/Sheet1!A1', '/page[3]', '/가나', '/Z']), pick(['warning', 'error', 'info', 'warning', 'warning']), pick(['a', 'b', 'c']))));
}

const FORMATS = ['pptx', 'docx', 'xlsx', 'pdf', 'csv', 'PPTX', ''];
const persistedValues = [undefined, null, true, false];
const coverageValues = [undefined, null, { complete: true }, { complete: false }, {}, 0, { complete: 'true' }, { complete: true, reviewed: 3, total: 3 }];

const golden = {
  advisory: cases([...issueLists.flat(), ...issueLists.slice(0, 3)], (issue) => pipeline.isAdvisoryOfficeIssue(issue)),
  renderOutput: cases(
    ['a.pdf', 'a.PDF', 'dir/a.docx', 'dir\\a.pptx', 'C:\\dir.v2\\a', 'C:\\dir.v2\\a.xlsx', 'a', '', 'a.', '.pdf', '.hidden', 'a.b.c', 'x/.pdf', 'x\\y.z.PDF', '/abs/file.docx', 'C:file.pdf', 'C:file.txt', 'a.tar.gz', 'dots...', 'name.with.dots/', 'trail.docx ', '가.docx', 'out\\report.PdF'],
    (path) => ({ path, resolved: pipeline.resolveOfficeRenderOutput(path) })
  ),
  normalize: cases(issueLists, (list) => pipeline.normalizeOfficeReviewIssues(list)),
  polish: cases(
    issueLists.flatMap((list, index) => [{ format: FORMATS[index % FORMATS.length], issues: list }]).concat([{ issues: [at('blank_page')] }, { format: 'docx' }, { format: 'Xlsx', issues: [] }]),
    (input) => pipeline.buildOfficePolishPlan(input)
  ),
  gate: cases(
    issueLists.flatMap((list, index) => {
      const persisted = persistedValues[index % persistedValues.length];
      const visualCoverage = coverageValues[index % coverageValues.length];
      return [
        { issues: list, persisted, visualCoverage },
        { issues: list, persisted: persistedValues[(index + 1) % 4], visualCoverage: coverageValues[(index + 3) % coverageValues.length] },
      ];
    }).concat([{}, { issues: [] }, { persisted: false }, { visualCoverage: { complete: false } }]),
    (input) => pipeline.evaluateOfficeSubmissionGate(input)
  ),
  issue: cases(
    [['a', '/p', 'm'], ['a', '/p', 'm', 'post-save-gate', 'error'], ['a', '/p', 'm', 'format-review', 'info'], ['', '', '']],
    ([code, path, message, source, severity]) => issues.issue(code, path, message, source, severity)
  ),
};

// Release score: the tests' inputs, then a seeded grid over every argument.
const scoreInputs = [
  { format: 'pptx', aesthetics: { score: 1 }, renderedPages: 5, expectedPages: 5, structuralAvailable: true, planCoverage: 1 },
  { format: 'pptx', aesthetics: { score: 0 }, renderedPages: 5, expectedPages: 5, structuralAvailable: true },
  { format: 'xlsx', aesthetics: { score: 0.9 }, renderedPages: 1, expectedPages: 1, structuralAvailable: true },
  { format: 'docx', aesthetics: { score: 1 }, structuralAvailable: true, renderedPages: 2, expectedPages: 2 },
  { format: 'pdf', aesthetics: { score: 1 }, structuralAvailable: true, renderedPages: 2, expectedPages: 2 },
  { format: 'csv' },
  {},
  { format: 'PPTX', issues: [at('shape_overlap', '/x', 'error'), at('low_contrast'), at('made_up')], renderedPages: 3, expectedPages: 4, planCoverage: 0.5 },
];
const aestheticValues = [null, { score: 1 }, { score: 0 }, { score: 0.9 }, { score: 0.123456 }, { score: '0.5' }, { score: 2 }, { score: -1 }, {}, { score: 'x' }, { score: 0.3333333333 }, { score: 0.7 }, 0, 'text', true];
const pageValues = [[5, 5], [0, 0], [3, 5], [1, 0], [7, 5], ['5', '5'], [null, null], [2, 3], [1, 3], [0, 5], [-2, 4], ['x', 4], [4, 'y'], [0.5, 3]];
const issueSets = [
  [], [at('x', '/', 'error')], [at('x', '/', 'warning')], [at('low_contrast'), at('low_contrast', '/b'), at('small_font')],
  [at('x', '/', 'info')], Array.from({ length: 30 }, (_, i) => at(`c${i}`, '/', 'warning')),
  [at('x', '/', 'ERROR'), at('y', '/', 'Warning'), at('z', '/', 'notice')], 'not an array', null,
  [null, 5, 'x', { code: 'blank_page' }, { severity: 'error' }],
  Array.from({ length: 5 }, (_, i) => at(i % 2 ? 'blank_page' : 'plain_one', '/', 'warning')),
  Array.from({ length: 2 }, () => at('shape_overlap', '/', 'warning')),
];
for (let round = 0; round < 700; round += 1) {
  const [renderedPages, expectedPages] = pick(pageValues);
  const input = { format: pick(FORMATS), aesthetics: pick(aestheticValues), issues: pick(issueSets), renderedPages, expectedPages, structuralAvailable: pick([true, false, 'yes', 0, null]), planCoverage: pick([0, 0.5, 1, 2, 'x', -1, null, 0.4567891]) };
  for (const key of Object.keys(input)) if (next() < 0.12) delete input[key];
  scoreInputs.push(input);
}
golden.score = cases(scoreInputs, (input) => score.scoreOfficeReleaseQuality(input));

// Page review of a document.
const baseState = { renderedPageCount: 2, reviewToken: 'current', renderedVersion: 4, snapshotVersion: 4, renderedCoverage: { complete: true } };
const stateVariants = [
  baseState, { ...baseState, snapshotVersion: 5 }, { ...baseState, renderedCoverage: { complete: false } }, { ...baseState, renderedCoverage: undefined },
  { ...baseState, reviewToken: '' }, { ...baseState, reviewToken: undefined }, { ...baseState, renderedPageCount: 0 }, { ...baseState, renderedPageCount: 3 },
  { ...baseState, renderedPageCount: '2' }, { ...baseState, renderedPageCount: 'x' }, { ...baseState, renderedPageCount: 1 }, { ...baseState, renderedPageCount: 2.5 },
  { ...baseState, renderedVersion: undefined, snapshotVersion: undefined }, { ...baseState, renderedVersion: 4, snapshotVersion: '4' }, {}, null, { ...baseState, reviewToken: 7 },
];
const documentCases = [];
for (const [format, checks] of Object.entries(documents.DOCUMENT_VISUAL_CHECKS)) {
  const entry = (page, extra = {}) => ({ page, verdict: 'pass', note: `Reviewed page ${page}`, ...Object.fromEntries(checks.map((check) => [check, true])), ...extra });
  const design = { reviewed: true, reviewToken: 'current', critique: [entry(1), entry(2)] };
  const designs = [
    design, { ...design, reviewToken: 'old' }, { ...design, critique: [entry(1)] }, { ...design, critique: [entry(1), entry(1)] },
    { ...design, critique: [entry(1), entry(2, { [checks[0]]: false })] }, { ...design, critique: [entry(1), entry(2, { [checks[1]]: 3 })] },
    { ...design, critique: [entry(1, { [checks[0]]: 4, [checks[1]]: 5, [checks[2]]: 5 }), entry(2, { [checks[2]]: 3.9 })] },
    { ...design, critique: [entry(1, { [checks[0]]: null }), entry(2, { [checks[1]]: 'yes' })] },
    { ...design, critique: [entry(1, { fixes: ['one', 'two'] }), entry(2, { fixes: [] })] },
    { ...design, critique: [entry(1, { note: '' }), entry(2, { note: '   ' })] }, { ...design, critique: [entry(1, { note: undefined }), entry(2, { note: 5 })] },
    { ...design, critique: [entry(1, { verdict: undefined }), entry(2, { verdict: 'fail' })] }, { ...design, critique: [entry(1, { verdict: 3 }), entry(2, { verdict: { a: 1 } })] },
    { ...design, reviewed: false }, { ...design, reviewed: 'true' }, { ...design, critique: 'nope' }, { ...design, critique: [] }, { reviewed: true }, {}, null,
    { ...design, critique: [entry('1'), entry('2')] }, { ...design, critique: [entry(2), entry(1)] }, { ...design, critique: [entry(1), entry(2), entry(3)] },
    { ...design, critique: [null, entry(1), 'x', entry(2)] }, { ...design, critique: [{ ...entry(1), page: 1.0 }, entry(2, { hierarchy: 5, legibility: 5 })] },
    { ...design, reviewToken: undefined }, { reviewed: true, reviewToken: 'current', critique: [1, 2].map((page) => ({ page, verdict: 'pass', note: `page ${page}`, hierarchy: 5, legibility: 4 })) },
    { reviewed: true, reviewToken: 'current', critique: [1, 2].map((page) => ({ page, verdict: 'pass', note: `page ${page}`, hierarchy: 3, legibility: 3 })) },
    { reviewed: true, reviewToken: 'current', critique: [{ page: 1, verdict: 'pass', note: 'ok' }] },
  ];
  for (const designValue of designs) for (const state of stateVariants.slice(0, 7).concat(stateVariants.slice(7).filter((_, i) => i % 3 === 0))) documentCases.push({ format, design: designValue, state });
}
documentCases.push({ format: 'csv', design: {}, state: {} }, { format: 'tsv', design: {}, state: {} }, { format: 'DOCX', design: {}, state: baseState }, { format: '', design: {}, state: baseState });
golden.documentReview = cases(documentCases, ({ format, design, state }) => documents.reviewDocumentPages(format, design, state));

// Acceptance verdicts.
const evidenceBase = { structuralAvailable: true, expectedPages: 5, pageCoverage: 1, blockingIssueCount: 0 };
const evidenceVariants = [
  evidenceBase, { ...evidenceBase, structuralAvailable: false }, { ...evidenceBase, expectedPages: 0 }, { ...evidenceBase, pageCoverage: 0.8 }, { ...evidenceBase, blockingIssueCount: 1 },
  { ...evidenceBase, structuralAvailable: 'true' }, { ...evidenceBase, expectedPages: '5' }, { ...evidenceBase, pageCoverage: '1' }, { ...evidenceBase, blockingIssueCount: '0' },
  { ...evidenceBase, blockingIssueCount: null }, { ...evidenceBase, blockingIssueCount: undefined }, { ...evidenceBase, pageCoverage: undefined }, {}, null, 'text',
  { structuralAvailable: true, expectedPages: 2, pageCoverage: 1, blockingIssueCount: 0 },
];
golden.automatedReady = cases(evidenceVariants.map((evidence) => ({ evidence })), ({ evidence }) => documents.isAutomatedReady(evidence));
golden.reviewStatus = cases(
  [false, true].flatMap((a) => [false, true].flatMap((b) => [false, true].map((c) => [a, b, c]))),
  ([reviewed, complete, acknowledged]) => documents.reviewStatus(reviewed, complete, acknowledged)
);
const acceptedReview = documents.reviewDocumentPages('docx', { reviewed: true, reviewToken: 'current', critique: [1, 2].map((page) => ({ page, verdict: 'pass', note: `page ${page}`, hierarchy: true, pagination: true, legibility: true })) }, baseState);
const visualVariants = [undefined, null, false, 0, '', acceptedReview, { acknowledged: true, status: 'accepted' }, { acknowledged: true }, { acknowledged: false, status: 'needs-work' }, { acknowledged: 'true' }, {}, 'text'];
golden.documentAcceptance = cases(
  evidenceVariants.flatMap((evidence) => visualVariants.map((visual) => ({ evidence, visual }))),
  ({ evidence, visual }) => documents.assessDocumentAcceptance(evidence, visual)
);
const critiqueVariants = [undefined, null, { ok: true }, { ok: false }, {}, { ok: 'true' }, { ok: 1 }, 'text', 0, [], { ok: true, slides: [] }];
golden.presentationAcceptance = cases(
  evidenceVariants.flatMap((evidence) => critiqueVariants.flatMap((critique) => [true, false].map((acknowledged) => ({ evidence, acknowledged, critique })))).concat([{ evidence: evidenceBase }, { evidence: evidenceBase, acknowledged: true }]),
  ({ evidence, ...options }) => presentations.assessPresentationAcceptance(evidence, options)
);

// Assurance checklist.
const checklistCodes = [
  'heading_hierarchy_missing', 'heading_hierarchy_jump', 'orphan_heading', 'heading_table_separation', 'heading_not_distinct', 'heading_style_inconsistent', 'short_table_split', 'table_width', 'table_wider_than_page',
  'blank_page', 'sparse_page', 'page_bottom_empty', 'low_contrast', 'formula_error', 'formula_x', 'assertion_y', 'assertions', 'empty_chart', 'broken_chart', 'chart_includes_total_row', 'chart_stops_short_of_data',
  'worksheet_hierarchy_missing', 'worksheet_print_too_small', 'worksheet_print_fit_missing', 'drawing_outside_print_area', 'drawing_overlap', 'drawing_covers_cells', 'label_truncated', 'protected_input_locked',
  'shape_overlap', 'text_outside_slide', 'shape_out_of_bounds', 'edge_margin', 'text_spacing_tight', 'text_overflow', 'small_font', 'peer_style_inconsistent', 'slide_text_dense', 'slide_hierarchy_flat',
  'meaningful_visual_missing', 'native_evidence_too_weak', 'repetitive_composition', 'card_grid_overuse', 'number_without_source', 'missing_checks_sheet', 'unrelated_code',
];
const coverageChecklist = [undefined, null, { complete: true, reviewed: 3, total: 3 }, { complete: true, reviewed: 3 }, { complete: true, total: 0, reviewed: 0 }, { complete: false, reviewed: 1, total: 3 }, { complete: true, total: '4', reviewed: '4' }, {}, 'text'];
const customVariants = [
  undefined, [], 'not an array', ['Check the numbers', '  padded  ', '', '   '],
  [{ id: 'Brand Voice!', label: 'Voice is on brand', passed: true }, { id: 'ABC def_ghi', text: 'from text', status: 'fail', evidence: 'p3' }, { label: 'No id', required: false }, { id: '가나다 라', passed: false, evidence: 12 }],
  [{ id: 'x', status: 'pass', passed: false }, { id: 'y', passed: true, status: 'fail' }, { passed: true }, { id: '--', label: '  ' }, {}, null, 7, ['nested'], { id: 5, label: 5 }],
  [{ id: 'é-ü', label: 'accents', required: false, passed: false }, { id: 'A/B\\C', label: 'slashes', passed: true, evidence: '' }, { id: ' padded id ', label: 'x', status: 'pending' }],
];
const checklistInputs = [{}, { format: 'docx' }, { format: 'csv', checklist: ['one'] }, { format: 'tsv', visualCoverage: { complete: true, reviewed: 1, total: 1 } }];
for (const format of ['docx', 'xlsx', 'pptx', 'pdf', 'csv', 'XLSX', '', 'odt']) {
  for (let round = 0; round < 16; round += 1) {
    const input = {
      format,
      task: pick(['', 'Quarterly deck', undefined, 5]),
      auditProfile: pick(['', 'financial-model', 'general', undefined, 'Financial-Model']),
      checklist: pick(customVariants),
      issues: Array.from({ length: Math.floor(next() * 9) }, () => ({ ...at(pick(checklistCodes)), ...(next() < 0.1 ? { code: undefined } : {}) })),
      visualCoverage: pick(coverageChecklist),
    };
    for (const key of Object.keys(input)) if (next() < 0.1) delete input[key];
    checklistInputs.push(input);
  }
  checklistInputs.push({ format, auditProfile: 'financial-model', issues: [at('missing_checks_sheet')], checklist: customVariants[4], visualCoverage: coverageChecklist[2] });
  checklistInputs.push({ format, issues: checklistCodes.map((code) => at(code)), visualCoverage: coverageChecklist[2] });
}
golden.checklist = cases(checklistInputs, (input) => checklists.evaluateOfficeChecklist(input));

writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'office-pipeline', recorder: RECORDER, command: `node ${RECORDER} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`golden.json: ${Object.entries(golden).map(([name, list]) => `${name} ${list.length}`).join(', ')}`);
