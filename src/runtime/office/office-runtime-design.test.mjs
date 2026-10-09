import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { defaultRenderOutput } from './core/office-sessions.mjs';
import { applyPdfDesign, expandOfficeDesignOperations, resolveOfficeDesign } from './design/design-system.mjs';
import { summarizeOfficeCompositions } from './design/composition-system.mjs';
import { wrapWords } from './design/xlsx/design-xlsx-components.mjs';
import {
  canonicalOfficeDesignPack,
  indexOfficeTemplates,
  persistOfficeDesignBinding,
  readOfficeCompositionHistory,
  recordOfficeCompositionHistory,
  resolveOfficeDesignLibrary,
  syncOfficeDesignLibrary,
} from './design/library/design-library.mjs';
import {
  inferPptxSlideRoles,
  isPptxDiagramSlide,
  isPptxPictureSlide,
  isPptxStatementSlide,
  pptxVisualReviewAcknowledged,
  reviewOfficeDesign,
  reviewPptxVisualCritique,
} from './quality/design-review.mjs';
import { annotatePptxSnapshotRoles, inducePptxSampleRoles } from './design/library/design-template-induct.mjs';
import { selectTemplatePage, templatePageFill } from './design/library/design-template-fill.mjs';
import { parts, value, workspace } from './office-test-support.mjs';
import { executeOfficeTool } from './index.mjs';
import { assertOfficeOperationContracts } from './capabilities.mjs';
import { finalizeOfficeResult, serializedToolValue, sessions } from './core/office-core.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

// Every batch and finalize used to echo the whole design context back, so the
// catalogue a direction was chosen from cost several times the audit it rode
// with. The result keeps the design in force and drops the input-side lists.
// The metric strip shipped operations the runtime's own validation refused
// (a cell alignment the catalog never declared), so every preset was refused
// for any caller who asked for metrics. The presets are held to the contract
// they enforce, across the profiles and purposes that change what they emit.
test('a preset never emits an operation its own contract refuses', () => {
  const content = {
    packageId: 'sweep',
    objective: 'Night shift decision',
    decision: 'Approve 12 crew',
    facts: [
      { id: 'on-time', label: 'On time', value: 0.928, numberFormat: '0.0%' },
      { id: 'throughput', label: 'Throughput', value: 47210, unit: 'orders' },
    ],
    claims: [{ id: 'approve', text: 'Approve the crew', factIds: ['on-time', 'throughput'] }],
  };
  const presets = {
    docx: [
      {
        op: 'compose_document',
        title: 'Night shift',
        subtitle: 'Operations',
        summary: 'Approve the crew.',
        claimId: 'approve',
        metrics: [{ factId: 'on-time' }, { factId: 'throughput' }],
        meta: ['October 2026'],
        footer: 'Operations',
        pageNumbers: true,
        sections: [
          { heading: 'Decision', kind: 'decision', paragraphs: ['Approve the crew.'], callout: 'Review in 30 days.' },
          {
            heading: 'Evidence',
            paragraphs: ['On-time delivery fell.'],
            bullets: ['Daejeon at 68%'],
            table: { headers: ['Item', 'Count'], rows: [['Crew', '12']] },
          },
          { heading: 'Voice', quote: 'The night shift is short-handed.', eyebrow: 'Floor', pageBreak: true },
          {
            heading: 'Plan',
            steps: [
              { title: 'Hire', detail: 'Nov 1' },
              { title: 'Review', detail: 'Dec 1' },
            ],
          },
        ],
      },
    ],
    xlsx: [
      {
        op: 'compose_sheet',
        title: 'Night shift metrics',
        kind: 'dashboard',
        claimId: 'approve',
        headers: ['Hub', 'Throughput', 'On time'],
        rows: [
          ['Daejeon', 128400, 0.928],
          ['Gwangju', 84200, 0.961],
        ],
        columnFormats: ['', '#,##0', '0.0%'],
        metrics: [{ factId: 'on-time' }, { factId: 'throughput' }],
        insights: ['Daejeon explains the drop.'],
        decision: 'Approve 12 crew',
        gates: [
          ['Metric', 'Gate'],
          ['On time', '95%+'],
        ],
        actions: [
          ['Action', 'Due'],
          ['Hire', 'Nov 1'],
        ],
        chart: { title: 'Throughput by hub', chartType: 'column' },
        source: { document: 'Ops dashboard', target: 'October' },
      },
    ],
  };
  let checked = 0;
  for (const profile of ['executive', 'editorial', 'technical', 'data']) {
    for (const purpose of ['monitor', 'decide', 'compare', 'explain', 'inspect']) {
      for (const expressionMode of ['conservative', 'strong-fit', 'divergent']) {
        for (const [format, operations] of Object.entries(presets)) {
          for (const backend of ['microsoft-office-com', 'mixdog-ooxml']) {
            const expanded = expandOfficeDesignOperations({
              format,
              backend,
              created: true,
              design: { profile, purpose, expressionMode, content },
              operations,
            });
            assertOfficeOperationContracts({ format, backend, operations: expanded.operations });
            checked += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, 240);
});

test('an office result returns the design in force, not the catalogue it was chosen from', () => {
  const design = resolveOfficeDesign('pptx', {
    profile: 'technical',
    intent: 'Launch a local-first coding harness for product leaders',
    audience: 'product and engineering leaders',
    purpose: 'decide',
    expressionMode: 'strong-fit',
  });
  assert.ok(design.artDirection.candidates.length >= 2, 'the resolved design still carries its candidates');
  const before = serializedToolValue({ design }).length;
  const result = finalizeOfficeResult(
    { design, batch: { design } },
    { action: 'finalize', startedAt: performance.now() }
  );
  assert.equal(result.design.layouts, undefined);
  assert.equal(result.design.recentCompositions, undefined);
  assert.equal(result.design.artDirection.candidates, undefined);
  assert.equal(result.design.artDirection.candidateCount, design.artDirection.candidates.length);
  assert.equal(result.design.artDirection.selected.id, design.artDirection.selected.id);
  assert.equal(result.design.profile, design.profile);
  assert.deepEqual(result.design.tokens, design.tokens);
  if (design.creative?.discipline) {
    assert.equal(result.design.creative.discipline.paletteSlots, undefined, 'the brief does not restate the tokens');
    assert.deepEqual(result.design.creative.discipline.rules, design.creative.discipline.rules);
  }
  // A direction that was not applied keeps its style id, not a palette the tokens contradict.
  const unapplied = finalizeOfficeResult(
    {
      design: {
        tokens: design.tokens,
        artDirection: {
          applyTokens: false,
          selected: {
            id: 'x',
            label: 'X',
            palette: { accent: '2764A5' },
            typography: { display: 'Cambria' },
            deck: {},
            style: { id: 'x' },
          },
        },
      },
    },
    { action: 'create' }
  );
  assert.deepEqual(unapplied.design.artDirection.selected, { id: 'x', label: 'X', style: { id: 'x' } });
  const receipt = finalizeOfficeResult(
    {
      design: {
        library: {
          source: 'mixdog-starter',
          pack: null,
          template: null,
          templateIndexRevision: 'd3af',
          recentCompositionCount: 2,
          pinned: false,
          warning: '',
        },
      },
    },
    { action: 'create' }
  );
  assert.deepEqual(
    receipt.design.library,
    { source: 'mixdog-starter' },
    'the library receipt keeps where the design came from'
  );
  assert.equal(result.batch.design.layouts, undefined, 'a finalize that carries its batch trims that design too');
  // The design the caller resolved is untouched; only the returned copy is trimmed.
  assert.ok(design.artDirection.candidates.length >= 2);
  assert.ok(
    serializedToolValue({ design: result.design }).length * 2 < before,
    `trimmed ${before} -> ${serializedToolValue({ design: result.design }).length}`
  );
  assert.doesNotMatch(
    serializedToolValue({ a: { b: 1 } }),
    /\n/,
    'results are serialized for a reader that parses them'
  );
});

test('an overwriting create replaces the document and closes the session that held it', async (t) => {
  const cwd = await workspace(t);
  const pdf = join(cwd, 'summary.pdf');
  const first = value(
    await executeOfficeTool(
      { action: 'create', path: pdf, format: 'pdf', blocks: [{ type: 'paragraph', text: 'First draft' }] },
      { cwd }
    )
  );
  const second = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: pdf,
        format: 'pdf',
        overwrite: true,
        blocks: [{ type: 'paragraph', text: 'Second draft' }],
      },
      { cwd }
    )
  );
  assert.notEqual(second.session, first.session);
  assert.equal(sessions.has(first.session), false, 'the replaced PDF session is not left open');
  const reread = value(await executeOfficeTool({ action: 'snapshot', session: second.session }, { cwd }));
  assert.match(reread.document.pages[0].text, /Second draft/);

  const docx = join(cwd, 'report.docx');
  const draft = value(
    await executeOfficeTool(
      { action: 'create', path: docx, mode: 'portable', operations: [{ op: 'append_text', text: 'Old body' }] },
      { cwd }
    )
  );
  const rewritten = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: docx,
        mode: 'portable',
        overwrite: true,
        operations: [{ op: 'append_text', text: 'New body' }],
      },
      { cwd }
    )
  );
  assert.notEqual(rewritten.session, draft.session, 'an overwrite writes a new document, not the old session');
  assert.notEqual(rewritten.reused, true);
  assert.equal(sessions.has(draft.session), false);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: rewritten.session }, { cwd }));
  const text = snapshot.document.paragraphs.map((paragraph) => paragraph.text).join('\n');
  assert.match(text, /New body/);
  assert.doesNotMatch(text, /Old body/);
  // A session in the middle of a transaction is not closed under it.
  value(await executeOfficeTool({ action: 'begin', session: rewritten.session }, { cwd }));
  const refused = await executeOfficeTool(
    {
      action: 'create',
      path: docx,
      mode: 'portable',
      overwrite: true,
      operations: [{ op: 'append_text', text: 'Third' }],
    },
    { cwd }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /open transaction; commit or roll it back/);
  assert.equal(sessions.has(rewritten.session), true, 'the transaction keeps its session');
  value(await executeOfficeTool({ action: 'rollback', session: rewritten.session }, { cwd }));
});

test('a session receives its review guidance once, and again only when it changes', () => {
  const session = {};
  const qaWith = (modelReview) => ({
    fixes: [],
    issuesAfter: [],
    review: { design: { status: 'diagnostics-only', modelReview } },
  });
  const first = finalizeOfficeResult(qaWith(['Read the pages.']), { action: 'qa', session });
  assert.deepEqual(first.review.design.modelReview, ['Read the pages.']);
  const second = finalizeOfficeResult(qaWith(['Read the pages.']), { action: 'qa', session });
  assert.equal(second.review.design.modelReview, undefined);
  assert.equal(second.review.design.status, 'diagnostics-only');
  const changed = finalizeOfficeResult(qaWith(['Read the pages.', 'Trace every number.']), { action: 'qa', session });
  assert.equal(changed.review.design.modelReview.length, 2);
  const otherSession = finalizeOfficeResult(qaWith(['Read the pages.']), { action: 'qa', session: {} });
  assert.deepEqual(otherSession.review.design.modelReview, ['Read the pages.']);
});

// stores.docx, stores.pdf and stores.xlsx in one folder rendered to one stores.mixdog-preview*, each render
// overwriting the pages the last one was reviewed from.
test('each source renders to its own preview beside it', () => {
  const docx = defaultRenderOutput(join('C:', 'work', 'stores.docx'));
  const xlsx = defaultRenderOutput(join('C:', 'work', 'stores.xlsx'));
  assert.notEqual(docx, xlsx);
  assert.equal(basename(docx), 'stores.docx.mixdog-preview.pdf');
});

// The design rode on every batch of a session, four kilobytes the create had already delivered.
test('a session receives its design once, and again only when it changes', () => {
  const session = {};
  const design = { profile: 'editorial', label: 'Editorial', tokens: { colors: { accent: 'C43E2F' } } };
  const first = finalizeOfficeResult({ batch: { design } }, { action: 'create', session });
  assert.deepEqual(first.batch.design.tokens, design.tokens);
  const again = finalizeOfficeResult({ design }, { action: 'batch', session });
  assert.deepEqual(again.design, { profile: 'editorial', unchanged: true });
  // A later batch rebuilds the creative brief for its own operations; the design in force is the same one.
  const rebriefed = finalizeOfficeResult(
    { design: { ...design, creative: { thesis: '', briefs: [] } } },
    { action: 'batch', session }
  );
  assert.deepEqual(rebriefed.design, { profile: 'editorial', unchanged: true });
  const changed = finalizeOfficeResult(
    { design: { ...design, tokens: { colors: { accent: '2764A5' } } } },
    { action: 'batch', session }
  );
  assert.equal(changed.design.tokens.colors.accent, '2764A5');
  assert.deepEqual(finalizeOfficeResult({ design }, { action: 'batch', session: {} }).design.tokens, design.tokens);
});

test('a QA verdict reaches the model without repeated fields or raw page measurements', () => {
  const issue = { severity: 'warning', code: 'heading_hierarchy_missing', path: '/body', message: 'No headings.' };
  const visualReview = { format: 'docx', status: 'not-reviewed', blockers: ['page 1: no critique entry'] };
  const images = [{ page: 1, path: 'doc-page-1.png', width: 1191, height: 1684 }];
  const coverage = { reviewed: 1, total: 1, complete: true };
  const record = {
    output: 'doc.pdf',
    visualCoverage: coverage,
    images,
    render: {
      ok: true,
      pages: [{ page: 1, inkCoverage: 0.05 }],
      aesthetics: { score: 0.87, dimensions: { contrast: 0.9 }, pages: [{ page: 1, entropy: 0.28 }] },
      issues: [],
    },
    quality: { score: 0.88, visualReview: { ...visualReview } },
    checklist: {
      items: [
        { id: 'heading-hierarchy', status: 'fail' },
        { id: 'table-integrity', status: 'pass' },
      ],
      summary: { total: 2, passed: 1, failed: 1 },
    },
  };
  const qaResult = () => ({
    fixes: [],
    issuesBefore: [issue],
    issuesAfter: [issue],
    review: record,
    preview: { output: 'doc.pdf', visualCoverage: coverage, images },
  });

  const qa = finalizeOfficeResult(qaResult(), { action: 'qa' });
  assert.equal(qa.issuesBefore, undefined, 'without fixes the pre-fix list repeats issuesAfter');
  assert.deepEqual(qa.issuesAfter, [issue]);
  assert.equal(qa.review.images, undefined);
  assert.equal(qa.review.visualCoverage, undefined);
  assert.deepEqual(qa.preview.images, images);
  assert.equal(qa.review.render.pages, undefined);
  assert.equal(qa.review.render.aesthetics.pages, undefined);
  assert.equal(qa.review.render.aesthetics.score, 0.87);
  assert.deepEqual(qa.review.render.aesthetics.dimensions, { contrast: 0.9 });
  assert.deepEqual(
    qa.review.checklist.items.map((item) => item.id),
    ['heading-hierarchy']
  );
  assert.deepEqual(qa.review.checklist.summary, record.checklist.summary);
  assert.deepEqual(qa.review.quality.visualReview, visualReview, 'nothing else in a qa result carries it');
  assert.equal(record.render.pages.length, 1, 'the transaction record keeps every measurement');
  assert.equal(record.images, images);

  const fixed = finalizeOfficeResult({ ...qaResult(), fixes: [{ op: 'autofit_range' }] }, { action: 'qa' });
  assert.deepEqual(fixed.issuesBefore, [issue], 'a fix keeps the list it started from');

  const finalized = finalizeOfficeResult(
    { visualReview, review: { ...qaResult(), visualReview } },
    { action: 'finalize' }
  );
  assert.deepEqual(finalized.visualReview, visualReview);
  assert.equal(finalized.review.visualReview, undefined);
  assert.deepEqual(finalized.review.review.quality.visualReview, { status: 'not-reviewed' });
  assert.equal(finalized.review.issuesBefore, undefined);

  // A finalized document is closed: next-pass guidance goes, the findings stay once.
  const closedRecord = {
    ...record,
    design: { status: 'diagnostics-only', issues: [issue], modelReview: ['Read the pages again.'] },
    polishPlan: { status: 'needs-polish', targets: [] },
  };
  closedRecord.trust = {
    policy: 'untrusted-data',
    source: 'structured-snapshot+office-file',
    risk: 'none',
    findingCount: 0,
    findings: [],
    scannedStrings: 116,
    complete: true,
  };
  const critiqueEntry = { slide: 1, verdict: 'pass', note: 'The statement lands on the accent.', checks: [] };
  const closed = finalizeOfficeResult(
    {
      finalized: true,
      review: {
        ...qaResult(),
        review: closedRecord,
        advisoryIssues: [issue],
        visualCritique: { ok: true, status: 'pass', pageCount: 1, entries: [critiqueEntry] },
      },
    },
    { action: 'finalize' }
  );
  assert.deepEqual(closed.review.visualCritique, { ok: true, status: 'pass', pageCount: 1, entryCount: 1 });
  assert.deepEqual(
    closed.review.review.trust,
    { risk: 'none', policy: 'untrusted-data' },
    'a read file keeps its policy'
  );
  const own = finalizeOfficeResult(
    {
      trust: {
        policy: 'untrusted-data',
        source: 'created-document',
        risk: 'none',
        findingCount: 0,
        findings: [],
        complete: true,
      },
      design: { authoring: 'native', intent: '', audience: '', content: null, review: { required: true } },
    },
    { action: 'batch' }
  );
  assert.deepEqual(own.trust, { risk: 'none' }, "this session's own writing needs no policy note");
  assert.deepEqual(own.design, { authoring: 'native', review: { required: true } });
  // A deck snapshot keeps a shape's run summary only where the runs disagree.
  const shapes = [
    {
      index: 1,
      text: 'Title',
      font: { size: 36, name: 'Noto Sans KR', color: '172B24' },
      sizes: [36],
      fonts: ['Noto Sans KR'],
      colors: ['172B24'],
    },
    {
      index: 2,
      text: '2곳',
      font: { size: 54, name: 'Noto Sans KR', color: '955318' },
      sizes: [22, 54],
      fonts: ['Noto Sans KR'],
      colors: ['955318'],
    },
  ];
  const opened = finalizeOfficeResult(
    { document: { format: 'pptx', slides: [{ index: 1, text: ['Title', '2곳'], shapes }] } },
    { action: 'open' }
  );
  assert.deepEqual(Object.keys(opened.document.slides[0].shapes[0]).sort(), ['font', 'index', 'text']);
  assert.deepEqual(opened.document.slides[0].shapes[1].sizes, [22, 54], 'a mixed run keeps its sizes');
  assert.equal(opened.document.slides[0].shapes[1].fonts, undefined);
  assert.deepEqual(shapes[0].sizes, [36], 'the snapshot handed in is not mutated');
  // A PowerPoint (COM) shape keeps what it has: no null facets, no MSO sentinel,
  // no invisible shadow or unfilled fill, runs only where they differ, points to the hundredth.
  const comShape = {
    path: '/slide[2]/shape[1]',
    index: 1,
    type: 1,
    text: 'Title',
    placeholder: null,
    chart: null,
    left: 43.20000076293945,
    top: 62.63999938964844,
    width: 873.3599853515625,
    height: 54,
    fillColor: 16777215,
    fillVisible: false,
    fillTransparency: 1,
    lineColor: 16777215,
    lineVisible: false,
    lineTransparency: -2147483648,
    rotation: 0,
    geometry: '',
    textFrame: { marginLeft: 7.2, marginTop: 3.6, marginRight: 7.2, marginBottom: 3.6, paragraphSpacing: 0 },
    shadow: { visible: 0, color: -2147483648, blur: 5 },
    textBounds: { width: 685.3750610351562, height: 46.56999969482422 },
    font: { name: 'Noto Sans KR', size: 36, bold: -1, color: '172B24' },
    runs: { sizes: [36], colors: [2370327] },
  };
  const comDeck = finalizeOfficeResult(
    {
      document: {
        format: 'pptx',
        slides: [
          {
            path: '/slide[2]',
            index: 2,
            notes: '',
            comments: [],
            transition: { effect: 0, advanceOnTime: false, advanceTime: 0 },
            shapes: [comShape],
          },
        ],
      },
    },
    { action: 'snapshot' }
  );
  assert.deepEqual(comDeck.document.slides[0], {
    path: '/slide[2]',
    index: 2,
    notes: '',
    shapes: [
      {
        path: '/slide[2]/shape[1]',
        index: 1,
        type: 1,
        text: 'Title',
        left: 43.2,
        top: 62.64,
        width: 873.36,
        height: 54,
        textBounds: { width: 685.38, height: 46.57 },
        font: { name: 'Noto Sans KR', size: 36, bold: -1, color: '172B24' },
      },
    ],
  });
  // A deck opened as it is keeps its own look: the profile palette and default direction the runtime never applied
  // do not reach the model, only where the design stands and whether a page review is owed.
  const openedDeck = finalizeOfficeResult(
    {
      design: {
        source: 'existing-document',
        format: { title: 40 },
        tokens: { colors: { accent: '1F7A55' } },
        artDirection: { source: 'profile-default', applyTokens: false, selected: { id: 'editorial-contrast' } },
        review: { required: true, allowTextOnly: false },
      },
    },
    { action: 'batch' }
  );
  assert.deepEqual(openedDeck.design, { source: 'existing-document', review: { required: true } });
  // A measured qa (render:false) drew nothing: no render-based score, aesthetic of no confidence, or render-coverage
  // failure reaches the model; the coverage entry says the render is owed.
  const measured = finalizeOfficeResult(
    {
      ok: true,
      issuesAfter: [{ severity: 'warning', code: 'literal_bullet', path: '/body/p[1]' }],
      preview: { pageCount: 0, images: [], visualCoverage: { mode: 'measure-only', complete: true } },
      review: {
        quality: { score: 0.41, releaseReady: false },
        render: { ok: true, issues: [], aesthetics: { score: 0.2, confidence: 0 } },
        checklist: {
          ok: false,
          items: [
            { id: 'heading-hierarchy', status: 'fail' },
            { id: 'full-render-coverage', status: 'fail' },
            { id: 'fonts', status: 'pass' },
          ],
          summary: { total: 3, passed: 1, failed: 2 },
        },
      },
    },
    { action: 'qa' }
  );
  assert.equal(measured.review.quality, undefined);
  assert.equal(measured.review.render.aesthetics, undefined);
  assert.deepEqual(measured.review.checklist.items, [{ id: 'heading-hierarchy', status: 'fail' }]);
  assert.deepEqual(measured.review.checklist.summary, { total: 2, passed: 1, failed: 1 });
  assert.equal(measured.preview.images, undefined);
  assert.equal(measured.preview.visualCoverage.mode, 'measure-only');
  // A COM chart names its kind as add_chart does and keeps a series' non-default facets; a COM slide with no shapes
  // is still read as one (its empty lists and still transition go, its notes stay).
  const comChart = finalizeOfficeResult(
    {
      document: {
        format: 'pptx',
        slides: [
          {
            path: '/slide[1]',
            index: 1,
            notes: '',
            shapes: [
              {
                index: 1,
                type: 3,
                textFrame: { marginLeft: 0, marginTop: 0 },
                textBounds: { width: 0, height: 0 },
                font: { name: '', size: 0, color: '000000' },
                chart: {
                  chartType: 51,
                  series: [
                    {
                      index: 1,
                      name: '건수',
                      formula: '',
                      chartType: 51,
                      axisGroup: 1,
                      trendlineCount: 0,
                      hasErrorBars: false,
                      hasDataLabels: false,
                      dataLabels: null,
                    },
                    { index: 2, name: '목표', chartType: 4, axisGroup: 2 },
                  ],
                },
              },
            ],
          },
          {
            path: '/slide[2]',
            index: 2,
            notes: '',
            comments: [],
            animations: [],
            transition: { effect: 0, advanceOnTime: false, advanceTime: 0 },
            shapes: [],
          },
        ],
      },
    },
    { action: 'snapshot' }
  ).document;
  assert.deepEqual(comChart.slides[0].shapes[0], {
    index: 1,
    type: 3,
    chart: {
      chartType: 'column',
      series: [
        { index: 1, name: '건수', chartType: 'column' },
        { index: 2, name: '목표', chartType: 'line', axisGroup: 2 },
      ],
    },
  });
  assert.deepEqual(comChart.slides[1], { path: '/slide[2]', index: 2, notes: '' });
  const shadowed = finalizeOfficeResult(
    {
      document: {
        format: 'pptx',
        slides: [
          {
            index: 1,
            shapes: [{ ...comShape, shadow: { visible: -1, color: 0, blur: 4.000001 }, runs: { sizes: [20, 36] } }],
          },
        ],
      },
    },
    { action: 'snapshot' }
  ).document.slides[0].shapes[0];
  assert.deepEqual(shadowed.shadow, { visible: -1, color: 0, blur: 4 });
  assert.deepEqual(shadowed.runs, { sizes: [20, 36] }, 'mixed run sizes stay');
  // A workbook cell in the default style reads the same without it; a styled one keeps its style.
  const defaultStyle = { fontName: 'Calibri', fontSize: 11, color: '000000' };
  const book = finalizeOfficeResult(
    {
      document: {
        format: 'xlsx',
        defaultStyle,
        definedNameCount: 0,
        definedNames: [],
        calculation: { mode: '', fullCalcOnLoad: false, forceFullCalc: false },
        sheets: [
          {
            name: 'S',
            cells: [
              { ref: 'A1', value: 'x', style: { color: '000000', fontName: 'Calibri', fontSize: 11 } },
              { ref: 'B1', value: 0.05, style: { ...defaultStyle, numberFormat: '0.0%' } },
            ],
          },
        ],
      },
    },
    { action: 'snapshot' }
  );
  // No defined names and no calculation settings read the same absent.
  assert.equal(book.document.definedNames, undefined);
  assert.equal(book.document.definedNameCount, undefined);
  assert.equal(book.document.calculation, undefined);
  assert.equal(book.document.sheets[0].cells[0].style, undefined);
  assert.equal(book.document.sheets[0].cells[1].style.numberFormat, '0.0%');
  assert.deepEqual(book.document.defaultStyle, defaultStyle);
  // A Word paragraph of one plain run and the main part's text say what the paragraphs say.
  const words = finalizeOfficeResult(
    {
      document: {
        format: 'docx',
        paragraphs: [
          {
            path: '/body/p[1]',
            index: 1,
            text: 'Plain',
            runs: [{ path: '/body/p[1]/run[1]', index: 1, text: 'Plain' }],
          },
          {
            path: '/body/p[2]',
            index: 2,
            text: 'A\nB',
            runs: [
              { index: 1, text: 'A' },
              { index: 2, text: 'B' },
            ],
          },
          { path: '/body/p[3]', index: 3, text: 'Bold', runs: [{ index: 1, text: 'Bold', bold: true }] },
        ],
        parts: [
          { part: 'word/document.xml', text: 'Plain\nA\nB\nBold' },
          { part: 'word/header1.xml', text: 'Running head' },
        ],
      },
    },
    { action: 'snapshot' }
  );
  assert.equal(words.document.paragraphs[0].runs, undefined);
  const comWords = finalizeOfficeResult(
    {
      document: {
        format: 'docx',
        paragraphs: [
          {
            path: '/body/p[1]',
            index: 1,
            text: 'x',
            format: { spacingAfter: 4, lineSpacing: 12.949999809265137, tabStops: [] },
          },
        ],
      },
    },
    { action: 'snapshot' }
  );
  assert.deepEqual(comWords.document.paragraphs[0].format, { spacingAfter: 4, lineSpacing: 12.95 });
  assert.equal(words.document.paragraphs[1].runs.length, 2);
  assert.equal(words.document.paragraphs[2].runs[0].bold, true, 'a formatted run stays');
  assert.deepEqual(words.document.parts, [{ part: 'word/header1.xml', text: 'Running head' }]);
  // Sections read alike on both backends: Word's \r inside a story is a line, an empty story says nothing.
  const sectioned = finalizeOfficeResult(
    {
      document: {
        format: 'docx',
        paragraphs: [{ path: '/body/p[1]', index: 1, text: 'x' }],
        parts: [{ part: 'word/document.xml', text: 'x' }],
        sections: [
          {
            path: '/section[1]',
            index: 1,
            orientation: 0,
            topMargin: 70.9000015258789,
            stories: [
              {
                path: '/section[1]/header[primary]',
                kind: 'primary',
                location: 'header',
                text: '',
                linkToPrevious: false,
              },
              {
                path: '/section[1]/footer[primary]',
                kind: 'primary',
                location: 'footer',
                text: '팀\r1',
                linkToPrevious: false,
              },
            ],
          },
          {
            path: '/section[2]',
            index: 2,
            orientation: 1,
            stories: [{ path: '/section[2]/header[primary]', kind: 'primary', location: 'header', text: '' }],
          },
        ],
      },
    },
    { action: 'snapshot' }
  );
  assert.equal(sectioned.document.parts, undefined, 'the body part adds nothing to the paragraphs');
  assert.deepEqual(sectioned.document.sections, [
    {
      path: '/section[1]',
      index: 1,
      orientation: 'portrait',
      topMargin: 70.9,
      stories: [{ path: '/section[1]/footer[primary]', kind: 'primary', location: 'footer', text: '팀\n1' }],
    },
    { path: '/section[2]', index: 2, orientation: 'landscape' },
  ]);
  const paged = finalizeOfficeResult(
    {
      document: {
        format: 'docx',
        pagination: { hasMore: true },
        paragraphs: [{ path: '/body/p[1]', index: 1, text: 'Page one' }],
        parts: [{ part: 'word/document.xml', text: 'Page one\nPage two' }],
      },
    },
    { action: 'snapshot' }
  );
  assert.equal(paged.document.parts[0].text, 'Page one\nPage two', 'a paged snapshot keeps the body text');
  // create/open with finalize:true carry a finalize result and read the same way.
  const oneStep = finalizeOfficeResult(
    {
      finalized: true,
      session: 's1',
      path: 'p',
      validation: { ok: true, missing: [] },
      review: { ...qaResult(), review: closedRecord },
    },
    { action: 'create' }
  );
  assert.deepEqual(oneStep.validation, { ok: true });
  const unmatched = finalizeOfficeResult(
    {
      finalized: true,
      composition: { format: 'docx', fingerprint: '', compositionIds: [], count: 0 },
      compositionHistory: null,
      review: {
        ...qaResult(),
        baseline: { available: false, output: '', reason: 'No active transaction baseline.' },
        review: { ...record, visualDiff: { available: false, pages: [], changedPercent: 0, images: [] } },
      },
    },
    { action: 'finalize' }
  );
  assert.equal(unmatched.review.baseline, undefined);
  assert.equal(unmatched.review.review.visualDiff, undefined);
  assert.equal(unmatched.composition, undefined);
  assert.equal(Object.hasOwn(unmatched, 'compositionHistory'), false);
  const compared = finalizeOfficeResult(
    {
      review: { ...record, visualDiff: { available: true, pages: [1], changedPercent: 3.2, images: [] } },
      fixes: [],
      issuesAfter: [],
    },
    { action: 'qa' }
  );
  assert.equal(compared.review.visualDiff.changedPercent, 3.2, 'a real comparison stays');
  const recalculated = finalizeOfficeResult(
    {
      recalculation: {
        needed: true,
        recalculated: true,
        backend: 'libreoffice',
        status: 'success',
        formulaCount: 8,
        totalErrors: 0,
        errorSummary: {},
        normalized: { removedParts: ['xl/charts/style1.xml'], restoredFonts: 4 },
        outputBytes: 11790,
        refittedColumns: null,
      },
    },
    { action: 'render' }
  );
  assert.deepEqual(recalculated.recalculation, {
    needed: true,
    recalculated: true,
    backend: 'libreoffice',
    status: 'success',
    formulaCount: 8,
    totalErrors: 0,
  });
  const failing = finalizeOfficeResult(
    {
      recalculation: {
        status: 'errors_found',
        totalErrors: 1,
        errorSummary: { '#DIV/0!': { count: 1, cells: ['S!A3'] } },
      },
    },
    { action: 'finalize' }
  );
  assert.deepEqual(failing.recalculation.errorSummary['#DIV/0!'].cells, ['S!A3'], 'every error location stays');
  assert.equal(oneStep.review.review.polishPlan, undefined);
  const flagged = { risk: 'high', findingCount: 1, findings: [{ category: 'instruction' }] };
  assert.equal(
    finalizeOfficeResult({ trust: flagged }, { action: 'open' }).trust,
    flagged,
    'a finding keeps the whole report'
  );
  assert.deepEqual(closed.review.issuesAfter, [issue]);
  assert.equal(closed.review.advisoryIssues, undefined);
  assert.deepEqual(closed.review.advisoryCodes, ['heading_hierarchy_missing']);
  assert.equal(closed.review.review.design.issues, undefined, 'every design finding is already in issuesAfter');
  assert.equal(closed.review.review.design.modelReview, undefined);
  assert.equal(closed.review.review.design.status, 'diagnostics-only');
  assert.equal(closed.review.review.polishPlan, undefined);
  assert.deepEqual(closedRecord.design.modelReview, ['Read the pages again.'], 'the stored record keeps its guidance');

  // The package check keeps what it found and drops the families it found empty.
  const validation = {
    session: 's1',
    path: 'C:/deck.pptx',
    mode: 'portable',
    backend: 'mixdog-ooxml',
    ok: true,
    missing: [],
    macros: [],
    security: { macros: [], signatures: [], macroExecution: 'disabled', digitalSignatureInvalidated: false },
    presentationFaults: [{ code: 'layout_orphan', part: 'ppt/slideLayouts/slideLayout9.xml' }],
    redlining: null,
    schema: { ok: true, rawValid: true, errors: [], path: 'C:/validator.exe', version: '0.3.0' },
    native: { ok: true, documentSaved: true, snapshot: { slides: [] }, snapshotFingerprint: 'abc' },
    postSaveGate: { ok: true, blocking: [] },
  };
  const checked = finalizeOfficeResult(
    {
      finalized: true,
      session: 's1',
      path: 'C:/deck.pptx',
      review: { ...qaResult(), mode: 'portable', backend: 'mixdog-ooxml' },
      validation,
    },
    { action: 'finalize' }
  );
  // A passed check answers with its verdict; default security and a passed post-save gate say nothing.
  assert.deepEqual(checked.validation, {
    ok: true,
    presentationFaults: [{ code: 'layout_orphan', part: 'ppt/slideLayouts/slideLayout9.xml' }],
    schema: { ok: true },
    native: { ok: true },
  });
  assert.equal(validation.schema.path, 'C:/validator.exe', 'the validation handed in is not mutated');
  // A refused redline keeps what it found; Word's own added parts and the baseline's bookkeeping go.
  const refused = finalizeOfficeResult(
    {
      finalized: false,
      reason: 'validation_failed',
      recalculation: null,
      review: null,
      stepMetrics: { saveMs: 7 },
      validation: {
        ok: false,
        format: 'docx',
        entries: 24,
        mainPart: 'word/document.xml',
        mainContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        mainContentTypeMissing: false,
        security: { macroExecution: 'enabled', digitalSignatureInvalidated: false },
        baseline: {
          compared: true,
          original: 'C:/a.docx',
          savedBy: 'microsoft-office-com',
          applicationSaved: true,
          originalEntries: 7,
          addedParts: ['word/theme/theme1.xml'],
          digitalSignatureInvalidated: false,
        },
        redlining: { ok: false, addedParts: ['word/footer1.xml'], reason: '1 paragraph(s) differ' },
        schema: { ok: false, errors: [{ description: 'bad' }], version: '0.3.0' },
        native: { ok: true, issues: [{ code: 'unresolved_revisions' }], issueCount: 1, snapshotFingerprint: 'abc' },
        postSaveGate: { ok: true, persisted: true, criticalCount: 0 },
      },
    },
    { action: 'finalize' }
  );
  assert.deepEqual(refused.validation, {
    ok: false,
    security: { macroExecution: 'enabled', digitalSignatureInvalidated: false },
    baseline: { applicationSaved: true },
    redlining: { ok: false, addedParts: ['word/footer1.xml'], reason: '1 paragraph(s) differ' },
    schema: { ok: false, errors: [{ description: 'bad' }], version: '0.3.0' },
    native: { ok: true, issues: [{ code: 'unresolved_revisions' }] },
  });
  assert.equal('recalculation' in refused || 'review' in refused, false);
  // A workbook read states its default once: a cell keeps only what differs from it, a sheet only the families that
  // hold something, and lineage names the cell and the cells it reads (the formula is already on the cell).
  const workbook = finalizeOfficeResult(
    {
      document: {
        format: 'xlsx',
        defaultStyle: { fontName: 'Calibri', fontSize: 11 },
        sheets: [
          {
            name: '실적',
            visibility: 'visible',
            hiddenRows: [],
            notes: [],
            noteCount: 0,
            cellCount: 2,
            protection: { protected: false },
            pageSetup: { orientation: '', zoom: 100, fitToPage: false, fitToPagesWide: 1, header: '' },
            freezePanes: { frozen: false, splitRow: 0, splitColumn: 0 },
            cells: [
              { ref: 'A1', value: '지점', formula: null, style: { fontName: 'Calibri', fontSize: 11, bold: false } },
              {
                ref: 'B1',
                value: 0.3,
                formula: '=A1',
                style: { fontName: 'Calibri', fontSize: 11, numberFormat: '0.0%', bold: true },
              },
            ],
            lineageCount: 1,
            formulaLineage: [
              {
                path: '/sheet[실적]/cell[B1]/lineage',
                from: '/sheet[실적]/cell[B1]',
                formula: '=A1+요약!B2',
                precedents: [
                  { sheet: '실적', ref: 'A1', path: '/sheet[실적]/cell[A1]' },
                  { sheet: '요약', ref: 'B2', path: '/sheet[요약]/cell[B2]' },
                ],
              },
            ],
          },
        ],
      },
    },
    { action: 'snapshot' }
  );
  assert.deepEqual(workbook.document.sheets[0], {
    name: '실적',
    cellCount: 2,
    pageSetup: { fitToPagesWide: 1 },
    cells: [
      { ref: 'A1', value: '지점' },
      { ref: 'B1', value: 0.3, formula: '=A1', style: { numberFormat: '0.0%', bold: true } },
    ],
    formulaLineage: [{ cell: 'B1', precedents: ['A1', '요약!B2'] }],
  });
  // A Word read lists the body's order block by block and Word's resolved zeros on every paragraph: the order keeps
  // where a table falls between runs of paragraphs, a paragraph keeps what it sets, and the contract fields stay.
  const bodyRead = finalizeOfficeResult(
    {
      document: {
        format: 'docx',
        trackChanges: false,
        comments: [],
        commentCount: 0,
        sections: [
          {
            path: '/section[1]',
            orientation: 0,
            topMargin: 70.9000015258789,
            stories: [{ location: 'header', text: '대외비', linkToPrevious: false }],
          },
        ],
        blockOrder: [
          { type: 'paragraph', index: 1, path: '/body/p[1]', start: 0 },
          { type: 'paragraph', index: 2, path: '/body/p[2]', start: 40 },
          { type: 'table', index: 1, path: '/body/tbl[1]', start: 80 },
          { type: 'paragraph', index: 3, path: '/body/p[3]', start: 120 },
        ],
        paragraphs: [
          {
            path: '/body/p[1]',
            index: 1,
            text: '본문',
            style: 'Normal',
            start: 0,
            end: 3,
            inTable: false,
            pageStart: 1,
            pageEnd: 1,
            format: { alignment: 0, spacingBefore: 0, spacingAfter: 8, keepWithNext: 0, pageBreakBefore: 0 },
            font: { name: '', size: 11, bold: false },
          },
        ],
      },
    },
    { action: 'snapshot' }
  );
  assert.deepEqual(bodyRead.document.blockOrder, ['/body/p[1..2]', '/body/tbl[1]', '/body/p[3]']);
  assert.deepEqual(bodyRead.document.paragraphs[0], {
    path: '/body/p[1]',
    index: 1,
    text: '본문',
    style: 'Normal',
    inTable: false,
    pageStart: 1,
    format: { spacingAfter: 8 },
    font: { size: 11 },
  });
  assert.deepEqual(bodyRead.document.sections, [
    {
      path: '/section[1]',
      orientation: 'portrait',
      topMargin: 70.9,
      stories: [{ location: 'header', text: '대외비' }],
    },
  ]);
  assert.equal(bodyRead.document.trackChanges, false, 'the backend contract names the tracking state');
  assert.equal(bodyRead.document.comments, undefined);
  assert.equal(bodyRead.document.commentCount, 0);
  // A live session's unsaved document is news and stays.
  const unsaved = finalizeOfficeResult(
    {
      finalized: true,
      validation: { ok: true, native: { ok: true, documentSaved: false, issueCount: 3, issues: [] } },
    },
    { action: 'finalize' }
  );
  assert.deepEqual(unsaved.validation.native, { ok: true, documentSaved: false, issueCount: 3 });
});

test('authored statement slides are read from their shapes so breathing beats are not penalised', () => {
  const statement = {
    index: 2,
    shapes: [
      { index: 1, type: 1, text: '문제', font: { size: 11 } },
      { index: 2, type: 1, text: '지금까지의 덱은 주제가 무엇이든 같은 카드 세 장으로 끝났다.', font: { size: 28 } },
      { index: 3, type: 1, text: '2/8', font: { size: 9 } },
    ],
  };
  const dense = {
    index: 3,
    shapes: Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      type: 1,
      text: `항목 ${index + 1} 설명 문장입니다.`,
      font: { size: 14 },
    })),
  };
  assert.equal(isPptxStatementSlide(statement), true);
  assert.equal(isPptxStatementSlide(dense), false);
  assert.deepEqual(inferPptxSlideRoles({ slides: [{ index: 1, shapes: [] }, statement, dense] }), {
    2: { slideRole: 'statement' },
  });
});

test('authored diagram slides are read from their native shapes so shape-filled fields are not judged empty', () => {
  // A cycle: four block arcs spanning the content field, labels inside, one connector.
  const diagram = {
    index: 4,
    shapes: [
      {
        index: 1,
        type: 'p:sp',
        geometry: 'rect',
        text: 'Cycle',
        font: { size: 32 },
        left: 43,
        top: 72,
        width: 870,
        height: 60,
      },
      ...[0, 1, 2, 3].map((i) => ({
        index: 2 + i,
        type: 'p:sp',
        geometry: 'blockArc',
        text: `Step ${i + 1}`,
        font: { size: 14 },
        left: 200 + (i % 2) * 300,
        top: 150 + Math.floor(i / 2) * 170,
        width: 280,
        height: 160,
      })),
      { index: 6, type: 'p:cxnSp', text: '', left: 480, top: 300, width: 120, height: 0.5 },
    ],
  };
  // Text boxes only: the same count of shapes, none drawn.
  const text = {
    index: 5,
    shapes: Array.from({ length: 6 }, (_, i) => ({
      index: i + 1,
      type: 'p:sp',
      geometry: 'rect',
      text: `Line ${i + 1}`,
      font: { size: 14 },
      left: 43,
      top: 160 + i * 40,
      width: 870,
      height: 32,
    })),
  };
  // Shapes drawn, but in one small corner: a badge, not a diagram.
  const corner = {
    index: 6,
    shapes: [
      {
        index: 1,
        type: 'p:sp',
        geometry: 'rect',
        text: 'Title',
        font: { size: 20 },
        left: 43,
        top: 72,
        width: 870,
        height: 60,
      },
      ...[0, 1, 2].map((i) => ({
        index: 2 + i,
        type: 'p:sp',
        geometry: 'ellipse',
        text: '',
        left: 700 + i * 30,
        top: 400,
        width: 24,
        height: 24,
      })),
    ],
  };
  // A side picture with a short claim: few words, but the frame owns the slide.
  const pictureSide = {
    index: 7,
    shapes: [
      { index: 1, type: 'p:pic', text: '', left: 0, top: 0, width: 446, height: 540 },
      {
        index: 2,
        type: 'p:sp',
        geometry: 'rect',
        text: 'Night volume passed daytime',
        font: { size: 32 },
        left: 490,
        top: 72,
        width: 420,
        height: 60,
      },
      {
        index: 3,
        type: 'p:sp',
        geometry: 'rect',
        text: 'Two more shuttles.',
        font: { size: 18 },
        left: 490,
        top: 160,
        width: 420,
        height: 40,
      },
    ],
  };
  // A statement with a small inset picture stays a statement.
  const inset = {
    index: 8,
    shapes: [
      { index: 1, type: 'p:pic', text: '', left: 700, top: 380, width: 160, height: 100 },
      {
        index: 2,
        type: 'p:sp',
        geometry: 'rect',
        text: 'One claim in air',
        font: { size: 40 },
        left: 43,
        top: 120,
        width: 600,
        height: 80,
      },
    ],
  };
  assert.equal(isPptxDiagramSlide(diagram), true);
  assert.equal(isPptxDiagramSlide(text), false);
  assert.equal(isPptxDiagramSlide(corner), false);
  assert.equal(isPptxPictureSlide(pictureSide), true);
  assert.equal(isPptxPictureSlide(inset), false);
  assert.deepEqual(
    inferPptxSlideRoles({
      slideWidth: 960,
      slideHeight: 540,
      slides: [{ index: 1, shapes: [] }, diagram, text, corner, pictureSide, inset],
    }),
    { 4: { visualType: 'diagram' }, 7: { visualType: 'picture' }, 8: { slideRole: 'statement' } }
  );
});

// The decision panel sits to the right of the data; with a four-column table its Stop gate lands in column R
// while the dashboard canvas ends at L. Print and PDF export clip to the print area, so the area follows the panel.
test('a composed dashboard keeps its decision gates inside the print area', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: '결정',
        title: '도크 4 증설 결정',
        headers: ['안', '비용', '야간 대응', '판정'],
        rows: [
          ['주간 전용', '낮음', '불가', '기각'],
          ['야간 전용', '중간', '가능', '채택'],
        ],
        metrics: [{ label: '처리량 증가', value: 1.6 }],
        decision: '야간 전용안을 10월 운영 회의에 올린다.',
        gates: [{ track: '야간 셔틀', release: '2대 증차 확정', stop: '증차 불가 시 보류' }],
      },
    ],
    design: {},
  });
  const column = (label) => [...label].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
  const page = expanded.operations.find((entry) => entry.op === 'set_page_setup');
  const area = /^A1:([A-Z]+)(\d+)$/.exec(String(page.printArea));
  assert.ok(area, `unexpected print area ${page.printArea}`);
  const stop = expanded.operations.find((entry) => entry.op === 'set_cell' && entry.value === '증차 불가 시 보류');
  assert.ok(stop, 'the Stop gate is written');
  const merged = expanded.operations.find(
    (entry) => entry.op === 'merge_cells' && entry.range.startsWith(`${stop.cell}:`)
  );
  const gateEnd = /:([A-Z]+)\d+$/.exec(merged.range)[1];
  assert.ok(
    column(area[1]) >= column(gateEnd),
    `print area stops at column ${area[1]} but the Stop gate reaches ${gateEnd}`
  );
  assert.ok(Number(area[2]) >= Number(/\d+$/.exec(stop.cell)[0]), 'the print area reaches the gate rows');
  const autofit = expanded.operations.find((entry) => entry.op === 'autofit_range' && !entry.rows);
  assert.ok(column(autofit.range.split(':')[1]) >= column(gateEnd), 'the column autofit covers the panel');
});

// The table's columns are the canvas's columns: a metric strip that took two
// columns per card made the title, the strip and the insight band twice the
// width of the table below them, and fit-to-page (which only scales down) then
// printed the whole thing as a small block in the corner of the page.
test('a composed dashboard gives every band the width of its table', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: '야간',
        kind: 'dashboard',
        title: '10월 야간 운영 현황',
        headers: ['허브', '처리량', '정시 출고율', '지연 건수'],
        rows: [
          ['대전', 128400, 0.928, 96],
          ['광주', 84200, 0.961, 42],
        ],
        metrics: [
          { label: '정시 출고율', value: 0.928, format: 'percent' },
          { label: '야간 증원 요청', value: 12, unit: '명' },
          { label: '지연 건수', value: 210 },
        ],
        insights: ['대전 허브의 야간 처리량이 4분기 목표를 좌우합니다.'],
      },
    ],
    design: {},
  });
  const merges = expanded.operations.filter((entry) => entry.op === 'merge_cells').map((entry) => entry.range);
  const bandEnds = new Set(merges.map((range) => /:([A-Z]+)\d+$/.exec(range)?.[1]));
  assert.ok(bandEnds.has('D'), `the bands reach the table's last column: ${[...bandEnds].join(', ')}`);
  assert.ok(!bandEnds.has('E') && !bandEnds.has('F'), `no band runs past the table: ${[...bandEnds].join(', ')}`);
  // The leading card carries the spare column, so three cards over four columns
  // read as a headline metric beside two supporting ones.
  const headline = merges.filter((range) => range.startsWith('A'));
  assert.ok(
    headline.some((range) => /^A\d+:B\d+$/.test(range)),
    headline.join(', ')
  );
  const fit = expanded.operations.find((entry) => entry.op === 'autofit_range' && !entry.rows);
  assert.equal(fit.range, 'A:D');
  assert.ok(fit.minWidth >= 12, `the columns carry the printed width: ${JSON.stringify(fit)}`);
});

// Round-5 sheet: a Korean gate cell ("1% 미만") drew its digits in Calibri beside fallback Hangul. A Korean sheet
// sets the preset's Latin roles in the Korean face of the same class; a Latin sheet and an author's face stay.
test('a Korean composed sheet sets the preset roles in Korean faces', () => {
  const sheetFonts = (title, design) =>
    new Set(
      expandOfficeDesignOperations({
        format: 'xlsx',
        backend: 'mixdog-ooxml',
        created: true,
        design,
        operations: [
          {
            op: 'compose_sheet',
            sheet: 'S',
            title,
            headers: ['A', 'B'],
            rows: [['x', 1]],
            decision: 'Go',
            gates: [{ track: 'Error', release: '< 1%', stop: '> 2%' }],
          },
        ],
      })
        .operations.map((entry) => entry.properties?.fontName)
        .filter(Boolean)
    );
  const korean = [...sheetFonts('출시 판단', { profile: 'editorial' })];
  assert.ok(korean.length > 0);
  assert.ok(
    korean.every((face) => ['Malgun Gothic', 'Batang'].includes(face)),
    korean.join(', ')
  );
  assert.ok(korean.includes('Batang'), 'the serif display role takes the serif Korean face');
  const latin = [...sheetFonts('Launch review', { profile: 'editorial' })];
  assert.ok(
    latin.every((face) => !['Malgun Gothic', 'Batang'].includes(face)),
    latin.join(', ')
  );
});

// Round-6 sheet: three percentage cards over a three-column table beside a decision panel printed "###" (a 27 pt
// "47.0%" in a column fitted to the table's text) on a portrait page three quarters empty.
test('a narrow dashboard beside its decision panel prints landscape with room for its card values', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { profile: 'executive', purpose: 'decide' },
    operations: [
      {
        op: 'compose_sheet',
        sheet: '출시',
        title: '베타 지표',
        headers: ['지표', '기준', '결과'],
        rows: [
          ['주간 활성', 0.4, 0.47],
          ['오류율', 0.01, 0.018],
        ],
        metrics: [
          { value: 0.47, format: 'percent', label: '주간 활성' },
          { value: 0.34, format: 'percent', label: '7일 잔존' },
          { value: 0.018, format: 'percent', label: '오류율' },
        ],
        decision: '11월에 출시합니다.',
      },
    ],
  });
  const ops = expanded.operations;
  assert.equal(ops.find((entry) => entry.op === 'set_page_setup').orientation, 'landscape');
  // Each card column is fitted to its content with the card's value as the floor, after the sheet-wide fit.
  const sheetFit = ops.findIndex(
    (entry) => entry.op === 'autofit_range' && !entry.rows && entry.range.startsWith('A:') && entry.range !== 'A:A'
  );
  const floors = ops.filter(
    (entry, index) => entry.op === 'autofit_range' && index > sheetFit && /^([A-Z]+):\1$/.test(entry.range)
  );
  assert.deepEqual(
    floors.map((entry) => entry.range),
    ['A:A', 'B:B', 'C:C']
  );
  // "47.0%" at 27 pt needs about twelve 11 pt characters; each card is one column here.
  assert.ok(
    floors.every((entry) => entry.minWidth >= 12),
    JSON.stringify(floors)
  );
});

// Round-7 report: "20시", "70%" and the table's "320" printed in Calibri beside Malgun Gothic Hangul. A Korean
// document sets its sans roles in the Korean face and keeps a serif role's Latin face paired run by run.
test('a Korean composed document sets its sans roles in the Korean face', () => {
  const fonts = (title, profile) => {
    const operations = expandOfficeDesignOperations({
      format: 'docx',
      backend: 'mixdog-ooxml',
      created: true,
      design: { profile },
      operations: [
        {
          op: 'compose_document',
          title,
          metrics: [{ value: '690', label: 'n' }],
          sections: [{ heading: 'H', paragraphs: ['20 70%'], table: { headers: ['a', 'b'], rows: [['1', '2']] } }],
        },
      ],
    }).operations;
    return new Set(operations.flatMap((entry) => [entry.properties?.name, entry.properties?.fontName]).filter(Boolean));
  };
  const eastAsiaFaces = (title, profile, extra = {}) =>
    new Set(
      expandOfficeDesignOperations({
        format: 'docx',
        backend: 'mixdog-ooxml',
        created: true,
        design: { profile },
        operations: [
          {
            op: 'compose_document',
            title,
            ...extra,
            sections: [{ heading: 'H', paragraphs: ['20 70%'], table: { headers: ['a', 'b'], rows: [['1', '2']] } }],
          },
        ],
      })
        .operations.flatMap((entry) => [entry.properties?.nameEastAsia, entry.properties?.fontNameEastAsia])
        .filter(Boolean)
    );
  // The Latin face is never replaced; Hangul takes a Korean face of its class beside it.
  const korean = [...fonts('도서관 야간 이용', 'data')];
  assert.ok(korean.some((face) => /^(calibri|arial)$/i.test(face)), korean.join(', '));
  assert.ok(eastAsiaFaces('도서관 야간 이용', 'data').has('Malgun Gothic'));
  assert.ok(eastAsiaFaces('도서관 야간 이용', 'editorial').has('Batang'));
  // An East Asian face the author named is kept.
  const named = eastAsiaFaces('도서관 야간 이용', 'editorial', { nameEastAsia: 'Noto Serif KR' });
  assert.ok(named.has('Noto Serif KR') && !named.has('Batang') && !named.has('Malgun Gothic'), [...named].join(', '));
  const editorial = [...fonts('도서관 야간 이용', 'editorial')];
  assert.ok(editorial.includes('Bookman Old Style'), `the serif display keeps its Latin face: ${editorial.join(', ')}`);
  const latin = [...fonts('Library night use', 'data')];
  assert.ok(
    latin.some((face) => /^(calibri|arial)$/i.test(face)),
    latin.join(', ')
  );
});

// Round-8 sheet: thirty stores as horizontal bars in the 280 pt default frame drew hairline bars and labelled every
// other store. A bar chart's frame grows with its categories; a column chart keeps the default.
test('a composed horizontal bar chart is as tall as its categories need', () => {
  const chartOf = (type, count) =>
    expandOfficeDesignOperations({
      format: 'xlsx',
      backend: 'mixdog-ooxml',
      created: true,
      design: { profile: 'data' },
      operations: [
        {
          op: 'compose_sheet',
          sheet: 'S',
          title: 'Stores',
          headers: ['Store', 'Sales'],
          rows: Array.from({ length: count }, (_, index) => [`S${index + 1}`, 100 + index]),
          chart: { type },
        },
      ],
    }).operations.find((entry) => entry.op === 'add_chart');
  const tall = chartOf('bar', 30);
  assert.ok(tall.height >= 30 * 15, `30 bars: ${tall.height} pt`);
  // Beside the table it ends with the table's rows (15 pt each in the print area), so the page count holds.
  assert.ok(tall.height <= 31 * 15, `the frame stops with the table: ${tall.height} pt`);
  assert.equal(chartOf('bar', 5).height, chartOf('column', 5).height, 'a short bar chart keeps the default frame');
  assert.equal(chartOf('column', 30).height, chartOf('column', 5).height);
});

// Round-12 sheet: ISO dates land as Excel dates, set right; read as labels, "2026-01-31" ran into "본사" beside it
// and the date header sat left of its values.
test('a composed sheet treats ISO dates as figures', () => {
  const ops = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { profile: 'data' },
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'S',
        title: '예산',
        headers: ['마감일', '조직', '예산'],
        rows: [
          ['2026-01-31', '본사', 12450],
          ['2026-02-28', '부산 지사', 8300],
        ],
      },
    ],
  }).operations;
  const styleAt = (range, key) =>
    ops.filter((entry) => entry.op === 'set_style' && entry.range === range && entry.properties?.[key] !== undefined);
  const table = ops.find((entry) => entry.op === 'add_table');
  const headerRow = /\d+/.exec(table.range)[0];
  assert.equal(styleAt(`A${headerRow}`, 'horizontalAlignment').at(-1)?.properties.horizontalAlignment, 'right');
  assert.ok(
    ops.some(
      (entry) => entry.op === 'set_style' && entry.range.startsWith(`B${headerRow}:`) && entry.properties?.indent === 1
    ),
    'the label column after the dates starts one indent in'
  );
});

// Round-4 sheet: August and September drew in two saturated hues, so the change the title named was unmarked.
test('a composed chart of several periods accents the last and mutes the rest', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { profile: 'editorial' },
    operations: [
      {
        op: 'compose_sheet',
        sheet: '지연',
        title: '결제 경로만 늘었다',
        headers: ['엔드포인트', '8월 (ms)', '9월 (ms)'],
        rows: [
          ['/login', 180, 175],
          ['/checkout', 310, 520],
        ],
        chart: { type: 'column' },
      },
    ],
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  assert.equal(chart.seriesColors.length, 2);
  assert.notEqual(chart.seriesColors[0], chart.seriesColors[1]);
  assert.equal(chart.seriesColors[1], expanded.design.tokens.colors.accent, JSON.stringify(chart.seriesColors));
});

// A preset's expansion comes back as counts; what a later call names, a write
// that changed nothing, and a plain batch's results stay one per operation.
test('a preset batch reports its routine writes as counts', () => {
  const results = [
    { op: 'set_page', changed: true, orientation: 'portrait' },
    { op: 'append_text', changed: true, style: 'Title' },
    { op: 'append_text', changed: true, style: 'Normal' },
    { op: 'add_table', changed: true, table: 1 },
    { op: 'set_table_cell_style', changed: true, table: 1, row: 1, col: 1 },
    { op: 'set_style', changed: false, range: 'A1' },
    { op: 'set_cell', changed: true, cell: 'A1', warning: 'clipped' },
  ];
  const preset = finalizeOfficeResult(
    { batch: { results, semanticOperations: [{ op: 'compose_document' }] } },
    { action: 'batch' }
  );
  assert.deepEqual(preset.batch.results, [
    results[0],
    results[3],
    results[5],
    results[6],
    { applied: { append_text: 2, set_table_cell_style: 1 } },
  ]);
  const plain = finalizeOfficeResult({ batch: { results, semanticOperations: [] } }, { action: 'batch' });
  assert.deepEqual(plain.batch.results, results);
});

// Round-1 review of a composed sheet: the chart drew 만 원 and 건 on one axis,
// the two insights ran together around a dangling "•", and the first card took
// the accent whichever figure the sheet was about.
test('a composed sheet charts one unit, lists insights by line, and leads with the marked figure', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { profile: 'data' },
    operations: [
      {
        op: 'compose_sheet',
        sheet: '채널',
        title: '채널 성과',
        headers: ['채널', '지출 (만 원)', '전환 (건)'],
        rows: [
          ['검색', 1200, 480],
          ['SNS', 950, 260],
        ],
        metrics: [
          { value: '3,400만 원', label: '총 지출' },
          { value: '1,100건', label: '총 전환', emphasis: true },
        ],
        insights: ['검색이 가장 낮습니다.', '디스플레이가 가장 적습니다.'],
        decision: '디스플레이 예산 300만 원을 검색 광고로 옮깁니다.',
        chart: { type: 'bar' },
      },
    ],
  });
  const ops = expanded.operations;
  // A decision panel beside the table spans rows instead of growing one of the table's.
  const table = ops.find((entry) => entry.op === 'add_table');
  const [, first, last] = /(\d+):[A-Z]+(\d+)$/.exec(table.range).map(Number);
  const decisionCell = ops.find(
    (entry) => entry.op === 'set_cell' && String(entry.value).startsWith('디스플레이 예산')
  ).cell;
  assert.ok(
    Number(/\d+/.exec(decisionCell)[0]) <= last,
    `the panel sits beside the table: ${decisionCell} vs ${table.range}`
  );
  const grown = ops.filter((entry) => entry.op === 'set_row_height' && entry.row >= first && entry.row <= last);
  assert.deepEqual(grown, [], `no table row is resized by the panel beside it: ${JSON.stringify(grown)}`);
  // The unfilled dashboard title spans the panel beside the table, not the table alone.
  const titleCell = ops.find((entry) => entry.op === 'set_cell' && entry.value === '채널 성과').cell;
  const titleMerge = ops.find((entry) => entry.op === 'merge_cells' && entry.range.startsWith(`${titleCell}:`)).range;
  const decisionMerge = ops.find(
    (entry) => entry.op === 'merge_cells' && entry.range.startsWith(`${decisionCell}:`)
  ).range;
  assert.equal(
    /:([A-Z]+)\d+$/.exec(titleMerge)[1],
    /:([A-Z]+)\d+$/.exec(decisionMerge)[1],
    `${titleMerge} vs ${decisionMerge}`
  );
  const titleStyle = ops.find((entry) => entry.op === 'set_style' && entry.range === titleMerge).properties;
  assert.equal(
    titleStyle.fillColor,
    undefined,
    'the widened title is unfilled, so it never outruns the bands beside it'
  );
  const chart = ops.find((entry) => entry.op === 'add_chart');
  assert.match(chart.range, /^A\d+:B\d+$/, `one unit on the axis: ${chart.range}`);
  const band = ops.find((entry) => entry.op === 'set_cell' && String(entry.value).includes('검색이'));
  assert.equal(band.value, '• 검색이 가장 낮습니다.\n• 디스플레이가 가장 적습니다.');
  const valueStyle = (text) => {
    const cell = ops.find((entry) => entry.op === 'set_cell' && entry.value === text).cell;
    return ops.find((entry) => entry.op === 'set_style' && entry.range.startsWith(`${cell}:`)).properties;
  };
  assert.notEqual(valueStyle('1,100건').fillColor, valueStyle('3,400만 원').fillColor, 'the marked card leads');
});

// A card reading the table by name held no value while the columns were floored, and its headline "204,300건"
// printed ###; the two insights stood in a band Excel sized by its first column, a hand tall.
test('a composed card that reads the table is floored like the value it shows, and the insight band takes its lines', () => {
  const expand = (metric) =>
    expandOfficeDesignOperations({
      format: 'xlsx',
      backend: 'mixdog-ooxml',
      created: true,
      operations: [
        {
          op: 'compose_sheet',
          sheet: 'Sheet1',
          kind: 'dashboard',
          title: '야간 처리량',
          tableName: 'Hubs',
          headers: ['권역', '처리량 (건)', '가동률'],
          rows: [
            ['수도권', 82400, 0.81],
            ['부산', 71600, 0.94],
            ['호남', 50300, 0.67],
          ],
          metrics: [
            { label: '3분기 야간 처리량', numberFormat: '#,##0"건"', emphasis: true, ...metric },
            { label: '가동률', value: 0.94, numberFormat: '0%' },
          ],
          insights: ['증가분의 절반 이상을 부산 허브가 받았습니다.', '부산 허브 가동률이 설계 한계를 넘었습니다.'],
        },
      ],
    }).operations;
  const floors = (ops) =>
    ops
      .filter((entry) => entry.op === 'autofit_range' && entry.minWidth && /^[A-Z]+:[A-Z]+$/.test(entry.range))
      .map((entry) => `${entry.range}=${entry.minWidth}`);
  const read = expand({ formula: '=SUM(Hubs[처리량 (건)])' });
  assert.deepEqual(floors(read), floors(expand({ value: 204300 })));
  const cell = read.find((entry) => entry.op === 'set_cell' && String(entry.value).startsWith('• 증가분')).cell;
  const row = Number(/\d+$/.exec(cell)[0]);
  const band = read.find((entry) => entry.op === 'set_row_height' && entry.row === row);
  assert.ok(band && band.height >= 2 * 10.5 * 1.3, `the band holds both lines: ${JSON.stringify(band)}`);
});

// A table takes no space above itself: under a bullet list its header sat on the last item, 3 pt below it.
test('a composed section leaves the paragraph gap between its list and the table or callout under it', () => {
  const lastBulletAfter = (section) => {
    const ops = expandOfficeDesignOperations({
      format: 'docx',
      backend: 'mixdog-ooxml',
      created: true,
      design: { profile: 'executive' },
      operations: [
        {
          op: 'compose_document',
          title: '운영 보고',
          sections: [{ heading: '현황', bullets: ['첫째', '둘째'], ...section }],
        },
      ],
    }).operations;
    const bullets = ops.filter((entry) => entry.op === 'append_text' && entry.properties?.listKind === 'bullet');
    return bullets.map((entry) => entry.properties.spacingAfter);
  };
  const [first, last] = lastBulletAfter({
    table: [
      ['권역', '물량'],
      ['부산', '4,200'],
    ],
  });
  assert.equal(first, 3, 'items keep their tight step');
  assert.ok(last > 3, `the last item leaves the paragraph gap: ${last}`);
  assert.ok(lastBulletAfter({ callout: '증설을 승인합니다.' })[1] > 3);
  assert.deepEqual(lastBulletAfter({}), [3, 3], 'a list the next heading follows keeps its step');
});

// A callout straight under a section table sat on the table's last rule: the 2 pt spacer after a table was all
// that stood between the two boxes.
test('a callout under a section table stands apart from it', () => {
  const spacerAfterTable = (section) => {
    const ops = expandOfficeDesignOperations({
      format: 'docx',
      backend: 'mixdog-ooxml',
      created: true,
      design: { profile: 'executive' },
      operations: [
        {
          op: 'compose_document',
          title: '운영 보고',
          sections: [
            {
              heading: '대안 비교',
              table: [
                ['대안', '비용'],
                ['분류기 증설', '24억 원'],
              ],
              ...section,
            },
          ],
        },
      ],
    }).operations;
    const table = ops.findIndex((entry) => entry.op === 'add_table');
    return ops.slice(table).find((entry) => entry.op === 'append_text' && entry.text === '\u00A0').properties
      .spacingAfter;
  };
  assert.equal(spacerAfterTable({ callout: '분류기 증설만이 성수기 물량을 흡수합니다.' }), 10);
  assert.equal(spacerAfterTable({}), 2, 'a table the next heading follows keeps its spacer');
  assert.equal(
    spacerAfterTable({ callout: '분류기 증설만이 성수기 물량을 흡수합니다.', source: '자료: 운영관리시스템' }),
    2,
    'the source line under the table stands between them'
  );
});

// An executive dashboard with a decision printed "[object Object]" under an English "DECISION WINDOW" when the decision
// came as { label, text }, ran its panel thirteen columns wide beside a four-column table with the chart held to the
// table, floored only the columns under the widest card (7월 narrow, 8월 and 9월 wide), and kept "+18%" as text.
test('a dashboard decision panel matches the table, the bands and chart span it, and card figures are numbers', () => {
  const operation = {
    op: 'compose_sheet',
    sheet: '대시보드',
    title: '부산 권역 증설로 정시 출고율을 회복합니다',
    subtitle: '물류운영팀',
    headers: ['권역', '7월', '8월', '9월'],
    rows: [
      ['부산', 4200, 4550, 4960],
      ['서울', 3100, 3080, 3150],
    ],
    metrics: [
      { value: '92.8%', label: '정시 출고율', emphasis: true },
      { value: '11,510건', label: '9월 출고' },
      { value: '+18%', label: '부산 증가율' },
    ],
    insights: ['부산 물량이 늘었습니다.'],
    decision: { label: '결정 요청', text: '도크 2개 증설을 승인합니다.' },
    chart: { type: 'column' },
  };
  const expand = (entry) =>
    expandOfficeDesignOperations({
      format: 'xlsx',
      backend: 'mixdog-ooxml',
      created: true,
      design: { profile: 'executive' },
      operations: [entry],
    }).operations;
  const ops = expand(operation);
  const cellOf = (value) => ops.find((entry) => entry.op === 'set_cell' && entry.value === value)?.cell;
  assert.ok(cellOf('도크 2개 증설을 승인합니다.'), 'the decision text is written');
  assert.ok(cellOf('결정 요청'), 'the panel carries the label it was given');
  assert.equal(
    ops.some((entry) => /object Object|DECISION/.test(String(entry.value ?? ''))),
    false
  );
  assert.throws(
    () => expand({ ...operation, decision: { note: '승인' } }),
    /decision takes a sentence, or \{ text, label \}/
  );
  // Card figures written as text land as numbers in a format that shows them the same way.
  const plus = ops.find((entry) => entry.op === 'set_cell' && entry.value === 0.18);
  assert.ok(plus, 'the "+18%" card holds 0.18');
  const plusStyle = ops.find((entry) => entry.op === 'set_style' && entry.range.startsWith(`${plus.cell}:`)).properties;
  assert.equal(plusStyle.numberFormat, '+0%;-0%;0%');
  assert.ok(
    ops.some((entry) => entry.op === 'set_cell' && entry.value === 0.928),
    'the "92.8%" card holds 0.928'
  );
  // The month columns share one width; the label column keeps its own.
  const floors = new Map(
    ops
      .filter((entry) => entry.op === 'autofit_range' && entry.minWidth)
      .map((entry) => [entry.range.split(':')[0], entry.minWidth])
  );
  assert.equal(new Set(['B', 'C', 'D'].map((column) => floors.get(column))).size, 1, JSON.stringify([...floors]));
  // The panel is about the table's width, and the chart runs to the bands' right edge beside it.
  const decisionCell = cellOf('도크 2개 증설을 승인합니다.');
  const decisionMerge = ops.find(
    (entry) => entry.op === 'merge_cells' && entry.range.startsWith(`${decisionCell}:`)
  ).range;
  const panelEnd = /:([A-Z]+)\d+$/.exec(decisionMerge)[1];
  assert.ok(panelEnd.length === 1 && panelEnd < 'R', `the panel stops short of R: ${decisionMerge}`);
  assert.equal(ops.find((entry) => entry.op === 'add_chart').toColumn, panelEnd);
  const subtitleCell = cellOf('물류운영팀');
  const subtitleMerge = ops.find(
    (entry) => entry.op === 'merge_cells' && entry.range.startsWith(`${subtitleCell}:`)
  ).range;
  assert.equal(/:([A-Z]+)\d+$/.exec(subtitleMerge)[1], panelEnd, 'the subtitle band spans the panel too');
});

// A plan section named its steps and the writer drew only the heading: the steps
// reached the page solely under kind:'roadmap', so the composer produced the
// orphan heading its own audit then reported.
test('a section that names steps writes them without declaring a roadmap', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { profile: 'executive', purpose: 'decide' },
    operations: [
      {
        op: 'compose_document',
        title: '10월 야간 운영 검토',
        sections: [
          {
            heading: '실행 계획',
            steps: [
              { title: '채용 공고', detail: '10월 20일' },
              { title: '교육 입과', detail: '11월 1일' },
            ],
          },
        ],
      },
    ],
  });
  const table = expanded.operations.find((entry) => entry.op === 'add_table');
  assert.ok(table, JSON.stringify(expanded.operations.map((entry) => entry.op)));
  assert.deepEqual(
    table.values.map((row) => row[1]),
    ['채용 공고\n10월 20일', '교육 입과\n11월 1일']
  );
  // Its first row is a step, not a header: repeating it on a continuation page
  // showed step one twice and hid the step it replaced.
  assert.equal(table.properties.repeatHeader, false);
  assert.ok(
    table.properties.rowHeights.every((height) => height <= 48),
    `a step is a row, not a page band: ${JSON.stringify(table.properties.rowHeights)}`
  );
  // Steps the writer cannot read are refused rather than dropped.
  assert.throws(
    () =>
      expandOfficeDesignOperations({
        format: 'docx',
        backend: 'mixdog-ooxml',
        created: true,
        operations: [{ op: 'compose_document', title: '계획', sections: [{ heading: '실행', steps: [{ note: '' }] }] }],
      }),
    /steps this writer cannot read/
  );
});

// A report sheet sets its chart beside the table. Held to the table's three columns, the title broke onto a second
// line in an 86 pt band while the chart's top stood bare beside it: the header bands run over both.
test('a chart beside the table shares the header bands with it', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: '추이',
        title: '월별 야간 처리량과 지연율',
        subtitle: '1월 ~ 9월, 전 허브 합계',
        insights: ['9개월 연속 지연율이 낮아졌습니다.'],
        headers: ['월', '처리량 (건)', '지연율'],
        rows: [
          ['1월', 612000, 0.041],
          ['2월', 598000, 0.039],
        ],
        chart: { type: 'line', title: '월별 처리량 (건)' },
      },
    ],
    design: {},
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  assert.equal(chart.cell.replace(/\d+$/, ''), 'E', 'the chart sits a column past the three-column table');
  const merges = expanded.operations.filter((entry) => entry.op === 'merge_cells').map((entry) => entry.range);
  // The chart ends at a column, not a width in points, and the bands end with it, whatever a column measures in
  // the workbook's font.
  const end = chart.toColumn;
  assert.ok(end > 'E' && chart.width === undefined, JSON.stringify(chart));
  assert.deepEqual(merges, [`A1:${end}1`, `A2:${end}2`, `A4:${end}4`]);
  const title = expanded.operations.find((entry) => entry.op === 'set_row_height' && entry.row === 1);
  assert.ok(title.height < 40, `the title takes one line across the bands: ${title.height} pt`);
});

// Three cards over a two-column table pulled the canvas - and every band on it -
// half again past the table. The strip wraps instead.
test('a metric strip wider than the table wraps onto a second strip', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: '야간',
        kind: 'dashboard',
        title: '10월 야간 운영 현황',
        headers: ['허브', '처리량'],
        rows: [
          ['대전', 128400],
          ['광주', 84200],
        ],
        metrics: [
          { label: '정시 출고율', value: 0.928, format: 'percent' },
          { label: '야간 증원 요청', value: 12, unit: '명' },
          { label: '지연 건수', value: 210 },
        ],
      },
    ],
    design: {},
  });
  const merges = expanded.operations.filter((entry) => entry.op === 'merge_cells').map((entry) => entry.range);
  assert.ok(
    merges.every((range) => /:B\d+$/.test(range)),
    `no band runs past the table's last column: ${merges.join(', ')}`
  );
  const cards = expanded.operations
    .filter((entry) => entry.op === 'set_cell' && ['정시 출고율', '야간 증원 요청', '지연 건수'].includes(entry.value))
    .map((entry) => Number(/(\d+)$/.exec(entry.cell)[1]));
  assert.equal(new Set(cards).size, 2, `the three cards sit on two strips: rows ${cards.join(', ')}`);
  // The sheet that cannot fill a landscape page is printed on the narrow one.
  const page = expanded.operations.find((entry) => entry.op === 'set_page_setup');
  assert.equal(page.orientation, 'portrait');
});

// Every data column became a series, so a count (128,400), a rate (0.928) and a
// tally (96) shared one axis: the legend named three series and the chart drew
// one, with the other two flattened onto the baseline.
test('a composed chart drops series that cannot share its axis', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: '야간',
        kind: 'dashboard',
        title: '10월 야간 운영 현황',
        headers: ['허브', '처리량', '정시 출고율', '지연 건수'],
        rows: [
          ['대전', 128400, 0.928, 96],
          ['광주', 84200, 0.961, 42],
        ],
        chart: { title: '허브별 처리량', chartType: 'column' },
      },
    ],
    design: {},
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  assert.match(chart.range, /^A\d+:B\d+$/, `the chart plots the throughput column alone: ${chart.range}`);
  // The chart is a band of the same composition: it starts at the canvas edge and
  // ends where the table ends, at a column rather than a width a workbook's font would change.
  assert.match(chart.cell, /^A\d+$/);
  assert.equal(chart.toColumn, 'D', `the chart spans the four canvas columns: ${JSON.stringify(chart)}`);
  assert.equal(chart.width, undefined);
});

test('a composed sheet keeps its chart inside the print area', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'Sheet1',
        title: 'Regional revenue',
        headers: ['Region', 'Revenue'],
        rows: [
          ['Korea', 200],
          ['Japan', 210],
          ['US', 290],
        ],
        chart: { title: 'Revenue' },
      },
    ],
    design: {},
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  const page = expanded.operations.find((entry) => entry.op === 'set_page_setup');
  const area = /^A1:([A-Z]+)(\d+)$/.exec(String(page.printArea));
  assert.ok(area, `unexpected print area ${page.printArea}`);
  assert.equal(page.fitToContent, true);
  const columnNumber = (letters) => [...letters].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
  const endColumn = columnNumber(area[1]);
  // The chart sits beside the table, a column apart, on the header row.
  const anchor = /^([A-Z]+)(\d+)$/.exec(String(chart.cell));
  assert.ok(anchor, `the chart is anchored to a cell: ${JSON.stringify(chart)}`);
  assert.equal(columnNumber(anchor[1]), 4);
  const top = (Number(anchor[2]) - 1) * 15;
  // Print and PDF export clip to the print area; a chart outside it disappears
  // from every exported copy while still looking correct on screen.
  assert.ok(
    endColumn >= columnNumber(chart.toColumn),
    `print area stops at column ${area[1]} but the chart reaches ${chart.toColumn}`
  );
  assert.ok(
    Number(area[2]) * 15 >= top + chart.height,
    `print area stops at row ${area[2]} but the chart reaches ${top + chart.height}pt`
  );
});

// A dashboard beside its decision panel runs its metric cards over the panel's columns, as every band under them runs:
// held to the table, the cards left the page's top right bare above the panel. The table keeps its card floors.
test('a dashboard with a decision panel runs its metric cards over the panel', () => {
  const ops = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'Sheet1',
        kind: 'dashboard',
        title: '야간 처리량',
        headers: ['권역', '처리량 (건)', '가동률'],
        rows: [
          ['수도권', 82400, 0.81],
          ['부산', 71600, 0.94],
        ],
        metrics: [
          { value: '154,000건', label: '처리량' },
          { value: '94%', label: '가동률' },
          { value: '1.2%', label: '지연률' },
        ],
        decision: '부산 허브 증설을 승인해 주십시오.',
      },
    ],
  }).operations;
  const rightEdge = (text) => {
    const cell = ops.find((entry) => entry.op === 'set_cell' && String(entry.value).startsWith(text)).cell;
    return /:([A-Z]+)\d+$/.exec(
      ops.find((entry) => entry.op === 'merge_cells' && entry.range.startsWith(`${cell}:`)).range
    )[1];
  };
  // The last card, found by its label (its figure is written as a number under its format).
  assert.equal(rightEdge('지연률'), rightEdge('부산 허브 증설'), 'the last card ends where the panel ends');
  const floors = ops.filter(
    (entry) => entry.op === 'autofit_range' && entry.minWidth && /^([A-Z]+):\1$/.test(entry.range)
  );
  assert.ok(floors.length > 0, 'the table columns keep their card floors');
});

// A composed sheet cites its source as add_provenance does, in the copy's language, and a source written with its
// own label keeps it: the note read "Source: 자료: 운영관리시스템", an English label in front of the caller's.
test('a composed sheet cites its source in the copy language without a second label', () => {
  const note = (source) =>
    expandOfficeDesignOperations({
      format: 'xlsx',
      backend: 'mixdog-ooxml',
      created: true,
      operations: [
        {
          op: 'compose_sheet',
          sheet: 'Sheet1',
          kind: 'dashboard',
          title: '야간 처리량',
          source,
          headers: ['권역', '처리량 (건)'],
          rows: [['수도권', 82400]],
        },
      ],
    }).operations.find((entry) => entry.op === 'add_note')?.text;
  assert.equal(note('자료: 운영관리시스템, 9월 30일 마감'), '자료: 운영관리시스템, 9월 30일 마감');
  assert.equal(note('운영관리시스템'), '출처: 운영관리시스템');
  assert.equal(note('Operations system'), 'Source: Operations system');
});

// A composed band is broken between words, and words that read as one stay together: a decision read
// "…을 10월 / 14일 투자심의에서" across Excel's lines.
test('a composed band breaks between words but never inside a date, a fraction, or a sum', () => {
  for (const text of [
    '부산 허브 분류기 증설(24억 원)을 10월 14일 투자심의에서 3분의 1 이상 승인해 주십시오.',
    '제휴 카페는 이용료로 한 달 12만 6천 원을 아끼고, 본사는 1억 3,500만 원의 월 매출을 낸다.',
  ]) {
    for (const width of [160, 200, 240, 280, 320, 360]) {
      const lines = wrapWords(text, 15, width).split('\n');
      assert.equal(lines.join(' '), text, `${width}: only spaces break`);
      assert.ok(!lines.some((line) => /(?:\d월|\d분의|\d억|\d만)$/.test(line)), `${width}: ${lines.join(' / ')}`);
    }
  }
  // A band never ends on one word alone under a full line: the word before it comes along, the lines stay two.
  assert.equal(
    wrapWords('야간 처리량 34% 증가, 부산 허브 증설이 필요합니다', 10, 300),
    '야간 처리량 34% 증가, 부산 허브\n증설이 필요합니다'
  );
});

test('a composed report sheet keeps its decision, gates, and actions under the table, in the copy language', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'Decision',
        title: '야간 셔틀 증차안',
        headers: ['안', '대기 시간 (분)', '월 비용 (만 원)'],
        rows: [
          ['현행 유지', 18, 0],
          ['2대 증차', 7, 2460],
        ],
        decision: '2대 증차를 승인해 주십시오. 대기 시간이 18분에서 7분으로 줄어듭니다.',
        gates: [{ track: '예산', release: '4.2억 원 이내', stop: '추가 예산 필요' }],
        actions: ['10월 1주 차량 계약'],
      },
    ],
    design: {},
  });
  const cells = expanded.operations.filter((entry) => entry.op === 'set_cell');
  // A long decision is broken into lines between its words, never inside one: Excel broke "주십 / 시오." at a
  // syllable. Joined at its breaks it reads as written.
  const at = (text) => cells.find((entry) => String(entry.value).split('\n').join(' ') === text);
  const decision = at('2대 증차를 승인해 주십시오. 대기 시간이 18분에서 7분으로 줄어듭니다.');
  assert.ok(decision, 'the decision is on the sheet');
  assert.match(decision.value, /\n/, 'the decision is broken into lines at its spaces');
  // Under the table (rows through 3 hold the title band and the table's header and two rows), from column A.
  const [, column, row] = /^([A-Z]+)(\d+)$/.exec(decision.cell);
  assert.equal(column, 'A');
  assert.ok(Number(row) > 3);
  for (const label of ['항목', '진행', '보류']) assert.ok(at(label), `the gate header "${label}" is Korean`);
  assert.ok(at('• 10월 1주 차량 계약'), 'the actions follow the gates');
  // The merged decision row takes the height of its lines.
  assert.ok(
    expanded.operations.some((entry) => entry.op === 'set_row_height' && entry.row === Number(row) && entry.height > 30)
  );
});

test('a wide composed dashboard keeps its chart clear of the data table', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'Dashboard',
        kind: 'dashboard',
        headers: ['Month', 'Revenue', 'Profit', 'Margin', 'Churn', 'NPS', 'Growth', 'Retention'],
        rows: [['January', 5000, 650, 0.13, 0.031, 49, 60, 55]],
        chart: { title: 'Performance', left: 440, width: 520 },
      },
    ],
    design: {},
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  // The chart clears the rows the table actually occupies. A fixed 300pt floor
  // read as an empty band between the two on every short dashboard.
  const lastRow = Math.max(
    ...expanded.operations
      .flatMap((entry) => [entry.cell, entry.range?.split(':')?.[1]])
      .map((reference) => Number(/(\d+)$/.exec(String(reference || ''))?.[1] || 0))
  );
  assert.ok(chart.top >= (lastRow + 1) * 20, `chart begins at ${chart.top}pt but the table runs to row ${lastRow}`);
  assert.ok(
    chart.left + chart.width <= 960,
    'moving the chart must preserve the requested right edge and one-page scale'
  );
});

test('composition review blocks repeated and recently duplicated document structures', () => {
  const compositions = Array.from({ length: 4 }, () => ({
    id: 'content:evidence-right',
    family: 'evidence',
    kind: 'content',
    purpose: 'decide',
    topology: { signature: 'pptx|m:0|c:0|s:0|r:0|p:few|e:visual' },
  }));
  const summary = summarizeOfficeCompositions('pptx', compositions);
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: { slides: [] },
    design: {
      purpose: 'decide',
      compositions,
      review: { allowTextOnly: true, allowSyntheticVisuals: true },
    },
    library: {
      source: 'mixdog-starter',
      recentCompositions: [
        {
          ...summary,
          purpose: 'decide',
          expressionMode: 'strong-fit',
        },
      ],
    },
  });
  assert.ok(review.issues.some((entry) => entry.code === 'repetitive_composition'));
  assert.ok(review.issues.some((entry) => entry.code === 'recent_composition_repeat'));
  assert.equal(review.composition.fingerprint, summary.fingerprint);
});

test('Office composition history is bounded, replaces a document record, and excludes the active path', async (t) => {
  const cwd = await workspace(t);
  const dataDir = join(cwd, 'data');
  const documentPath = join(cwd, 'brief.docx');
  await recordOfficeCompositionHistory(dataDir, {
    documentPath,
    format: 'docx',
    profile: 'editorial',
    purpose: 'decide',
    expressionMode: 'strong-fit',
    fingerprint: 'first',
    compositionIds: ['decision-brief'],
  });
  await recordOfficeCompositionHistory(dataDir, {
    documentPath,
    format: 'docx',
    profile: 'editorial',
    purpose: 'decide',
    expressionMode: 'divergent',
    fingerprint: 'second',
    compositionIds: ['evidence-brief'],
  });
  const history = await readOfficeCompositionHistory(dataDir, { format: 'docx' });
  assert.equal(history.length, 1);
  assert.equal(history[0].fingerprint, 'second');
  assert.deepEqual(history[0].compositionIds, ['evidence-brief']);
  assert.deepEqual(
    await readOfficeCompositionHistory(dataDir, { format: 'docx', excludeDocumentPath: documentPath }),
    []
  );
});

test('PPTX review exempts the cover while a short deck still owes evidence', () => {
  const textOnly = (index) => ({
    index,
    background: { color: 'F5F2EC', followMaster: false, source: 'slide' },
    shapes: [
      {
        type: 17,
        text: `Slide ${index} carries only body copy`,
        left: 60,
        top: 80,
        width: 700,
        height: 90,
        font: { size: 20 },
      },
    ],
  });
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: { slides: [textOnly(1), textOnly(2)] },
    design: { deck: { backgroundMode: 'custom' } },
  });
  assert.deepEqual(
    review.issues.filter((issue) => issue.code === 'meaningful_visual_missing').map((issue) => issue.path),
    ['/slide[2]'],
    'a cover never owes a chart, but the content slide of a two-slide deck still does'
  );
});

test('PPTX visual critique requires distinct per-slide evidence across five axes', () => {
  const entry = (slide, note, overrides = {}) => ({
    slide,
    verdict: 'pass',
    hierarchy: 4,
    balance: 4,
    legibility: 4,
    cohesion: 4,
    evidence: 4,
    note,
    fixes: [],
    ...overrides,
  });
  const passing = reviewPptxVisualCritique({
    pageCount: 3,
    critique: [
      entry(1, 'Cover establishes one dark focal statement and a clear numeric transition.'),
      entry(2, 'Body uses one dominant comparison axis with readable supporting labels.'),
      entry(3, 'Closing repeats the dark frame and lands one concise executive action.'),
    ],
  });
  assert.equal(passing.status, 'pass');
  const incomplete = reviewPptxVisualCritique({
    pageCount: 3,
    critique: [
      entry(1, 'Repeated generic note that does not distinguish the slide composition.'),
      entry(2, 'Repeated generic note that does not distinguish the slide composition.'),
    ],
  });
  assert.ok(incomplete.issues.some((issue) => issue.code === 'visual_critique_missing_slide'));
  // A template answer is not a review: swapping the slide number into one
  // sentence, or asking every slide the same three questions, says nothing
  // about the page it judges.
  const numbered = reviewPptxVisualCritique({
    pageCount: 3,
    critique: [1, 2, 3].map((slide) =>
      entry(slide, `슬라이드 ${slide}: 계획한 역할대로 읽히고 제목과 근거의 위계가 분리되어 보입니다.`)
    ),
  });
  assert.ok(numbered.issues.some((issue) => issue.code === 'visual_critique_repeated_note'));
  const sameChecks = reviewPptxVisualCritique({
    pageCount: 2,
    requireChecks: true,
    critique: [
      entry(1, 'Cover establishes one dark focal statement and a clear numeric transition.', {
        checks: [
          { item: 'the slide is readable', pass: true },
          { item: 'the figures match the fact sheet', pass: true },
          { item: 'the accent marks the conclusion', pass: true },
        ],
      }),
      entry(2, 'Body uses one dominant comparison axis with readable supporting labels.', {
        checks: [
          { item: 'the slide is readable', pass: true },
          { item: 'the figures match the fact sheet', pass: true },
          { item: 'the accent marks the conclusion', pass: true },
        ],
      }),
    ],
  });
  assert.ok(sameChecks.issues.some((issue) => issue.code === 'visual_critique_repeated_note'));
  assert.match(
    sameChecks.issues.find((issue) => issue.code === 'visual_critique_repeated_note').message,
    /own plan line/
  );
  const failed = reviewPptxVisualCritique({
    pageCount: 1,
    critique: [
      entry(1, 'The focal visual remains too weak and needs a larger evidence area.', {
        verdict: 'needs-polish',
        balance: 2,
        fixes: ['Enlarge the evidence visual.'],
      }),
    ],
  });
  assert.ok(failed.issues.some((issue) => issue.code === 'visual_critique_needs_polish'));
  const anchor = reviewPptxVisualCritique({
    pageCount: 1,
    critique: [
      entry(1, 'A section anchor: one statement on a receded picture, no evidence by design.', {
        role: 'section',
        evidence: 2,
      }),
    ],
  });
  assert.equal(anchor.status, 'pass', 'an anchor is not gated on evidence');
  const anchorWeak = reviewPptxVisualCritique({
    pageCount: 1,
    critique: [
      entry(1, 'A section anchor whose statement does not read at thumbnail size on the picture.', {
        role: 'section',
        legibility: 2,
      }),
    ],
  });
  assert.ok(
    anchorWeak.issues.some((issue) => issue.code === 'visual_critique_needs_polish'),
    'the other axes still gate an anchor'
  );
  assert.equal(
    pptxVisualReviewAcknowledged({
      reviewed: true,
      providedToken: 'office_1:2',
      expectedToken: 'office_1:2',
      renderedVersion: 2,
      snapshotVersion: 2,
      critiqueOk: true,
    }),
    true
  );
  assert.equal(
    pptxVisualReviewAcknowledged({
      reviewed: true,
      providedToken: 'office_1:1',
      expectedToken: 'office_1:2',
      renderedVersion: 2,
      snapshotVersion: 2,
      critiqueOk: true,
    }),
    false
  );
  assert.equal(
    pptxVisualReviewAcknowledged({
      reviewed: true,
      providedToken: 'office_1:2',
      expectedToken: 'office_1:2',
      renderedVersion: 1,
      snapshotVersion: 2,
      critiqueOk: true,
    }),
    false
  );
});

test('signed Office design packs hot-update model tokens while existing bindings stay pinned', async (t) => {
  const cwd = await workspace(t);
  const dataDir = join(cwd, 'design-library-data');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trustedKeys = {
    'test-key': publicKey.export({ type: 'spki', format: 'pem' }),
  };
  const config = {
    manifestUrl: 'https://design.example.test/stable.json',
    trustedKeys,
    channel: 'stable',
    templateDirectories: [],
  };
  const makePack = (version, accent) => ({
    schemaVersion: 1,
    id: 'verified-layouts',
    version,
    channel: 'stable',
    profiles: {
      brand: {
        extends: 'technical',
        label: 'Verified Brand',
        tokens: { colors: { accent } },
      },
    },
    defaultProfiles: { pptx: 'brand' },
    layouts: [
      {
        id: `statement-${version.replaceAll('.', '-')}`,
        format: 'pptx',
        kind: 'statement',
        profile: 'brand',
        defaults: { titleSize: 42 },
      },
    ],
    templates: [],
  });
  const envelopeFor = (pack, signingKey = privateKey) => ({
    schemaVersion: 1,
    keyId: 'test-key',
    pack,
    signature: signBytes(null, Buffer.from(canonicalOfficeDesignPack(pack)), signingKey).toString('base64'),
  });
  let envelope = envelopeFor(makePack('1.0.0', 'C43E2F'));
  const fetchImpl = async () =>
    new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const firstSync = await syncOfficeDesignLibrary({
    dataDir,
    config,
    fetchImpl,
    force: true,
  });
  assert.equal(firstSync.ok, true, firstSync.warning);
  assert.equal(firstSync.active.version, '1.0.0');
  const firstDocument = join(cwd, 'first.pptx');
  const firstLibrary = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: firstDocument,
    format: 'pptx',
    created: true,
    request: {},
    config,
    fetchImpl,
  });
  await persistOfficeDesignBinding(dataDir, firstDocument, firstLibrary.binding);
  assert.equal(firstLibrary.binding.packVersion, '1.0.0');

  envelope = envelopeFor(makePack('2.0.0', '7C3AED'));
  const secondSync = await syncOfficeDesignLibrary({
    dataDir,
    config,
    fetchImpl,
    force: true,
  });
  assert.equal(secondSync.ok, true, secondSync.warning);
  assert.equal(secondSync.active.version, '2.0.0');
  const pinned = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: firstDocument,
    format: 'pptx',
    created: false,
    request: {},
    config,
    fetchImpl,
  });
  assert.equal(pinned.pack.version, '1.0.0');
  assert.equal(pinned.pinned, true);
  const secondLibrary = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: join(cwd, 'second.pptx'),
    format: 'pptx',
    created: true,
    request: {},
    config,
    fetchImpl,
  });
  assert.equal(secondLibrary.pack.version, '2.0.0');
  const resolved = resolveOfficeDesign('pptx', {}, { library: secondLibrary });
  assert.equal(resolved.profile, 'brand');
  assert.equal(resolved.tokens.colors.accent, '7C3AED');
  // The pinned pack's palette resolves for a deck even though decks are authored, not composed.
  assert.equal(resolveOfficeDesign('pptx', {}, { library: secondLibrary }).tokens.colors.accent, '7C3AED');

  const tampered = makePack('3.0.0', 'DC2626');
  envelope = {
    ...envelopeFor(makePack('2.0.0', '7C3AED')),
    pack: tampered,
  };
  const rejected = await syncOfficeDesignLibrary({
    dataDir,
    config,
    fetchImpl,
    force: true,
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.warning, /signature verification failed/);
  assert.equal(rejected.active.version, '2.0.0');
});

// A deck someone brings carries no {{TOKEN}} slots and no placeholders: its
// pages are drawn boxes, so the placeholder rules find no title on them and
// never a column. The page's own geometry is what says which box is which.
test('PPTX page roles are induced from the geometry of a deck that has no placeholders', () => {
  const box = (shape, left, top, width, height, text, fontSize) => ({
    shape,
    type: 'text',
    text,
    placeholderType: '',
    geometry: { left, top, width, height },
    fontSize,
  });
  const columns = inducePptxSampleRoles({
    shapes: [
      box(1, 600_000, 400_000, 8_000_000, 900_000, '분기별 처리량 비교', 32),
      box(2, 600_000, 1_800_000, 3_400_000, 600_000, '기존 방식', 18),
      box(3, 4_400_000, 1_800_000, 3_400_000, 600_000, '개선 후', 18),
      box(4, 600_000, 2_600_000, 3_400_000, 1_200_000, '평균 3.4초가 걸렸다', 14),
      box(5, 4_400_000, 2_600_000, 3_400_000, 1_200_000, '평균 1.3초로 줄었다', 14),
    ],
  });
  assert.equal(columns.get(1), 'title');
  assert.equal(columns.get(2), 'column-title-1');
  assert.equal(columns.get(3), 'column-title-2');
  assert.equal(columns.get(4), 'column-body-1');
  assert.equal(columns.get(5), 'column-body-2');

  const metrics = inducePptxSampleRoles({
    shapes: [
      box(1, 600_000, 2_000_000, 2_400_000, 800_000, '38%', 40),
      box(2, 3_400_000, 2_000_000, 2_400_000, 800_000, '12건', 40),
      box(3, 600_000, 2_900_000, 2_400_000, 500_000, '재작업 비율', 12),
      box(4, 3_400_000, 2_900_000, 2_400_000, 500_000, '지연 건수', 12),
    ],
  });
  assert.equal(metrics.get(1), 'metric-value-1');
  assert.equal(metrics.get(3), 'metric-label-1');
  assert.equal(metrics.get(4), 'metric-label-2');
  // A Korean unit spaced from its multiplier is still a figure: one "14만 건" turned three metrics into columns.
  const spaced = inducePptxSampleRoles({
    shapes: [
      box(1, 600_000, 2_000_000, 2_400_000, 800_000, '99.95%', 40),
      box(2, 3_400_000, 2_000_000, 2_400_000, 800_000, '14만 건', 40),
      box(3, 600_000, 2_900_000, 2_400_000, 500_000, '월 가용성', 12),
      box(4, 3_400_000, 2_900_000, 2_400_000, 500_000, '피크 시간 결제', 12),
    ],
  });
  assert.equal(spaced.get(2), 'metric-value-2');
  assert.equal(spaced.get(4), 'metric-label-2');
  // A second row of peers under the metrics is named too, so a fill that does not write it empties it.
  const banded = inducePptxSampleRoles({
    shapes: [
      box(1, 600_000, 2_000_000, 2_400_000, 800_000, '99.95%', 40),
      box(2, 3_400_000, 2_000_000, 2_400_000, 800_000, '320ms', 40),
      box(3, 600_000, 2_900_000, 2_400_000, 500_000, '월 가용성', 12),
      box(4, 3_400_000, 2_900_000, 2_400_000, 500_000, 'p95 응답', 12),
      box(5, 600_000, 4_200_000, 2_400_000, 500_000, '확장', 18),
      box(6, 3_400_000, 4_200_000, 2_400_000, 500_000, '배포', 18),
    ],
  });
  assert.deepEqual([banded.get(5), banded.get(6)], ['aside-1', 'aside-2']);
  const fill = templatePageFill(
    {
      index: 2,
      role: 'metrics',
      shapes: [...banded].map(([index, slot]) => ({ index, slot, text: 'template words' })),
    },
    {
      items: [
        { value: '12분', label: '평균 대기' },
        { value: '38%', label: '점심 비중' },
      ],
    }
  );
  assert.ok(
    fill.deletes.includes(5) && fill.deletes.includes(6),
    `the second row is emptied: ${JSON.stringify(fill.deletes)}`
  );

  // The numerals of a metrics page are the loudest type on the canvas and there
  // are several of them, so the largest box is not the title there. A row of
  // peers is the page's structure; the title is the largest box standing alone,
  // and without it the page could not be filled by role at all.
  const titled = inducePptxSampleRoles({
    shapes: [
      box(9, 600_000, 500_000, 8_000_000, 900_000, '3분기 지표', 28),
      box(1, 600_000, 2_000_000, 2_400_000, 800_000, '38%', 40),
      box(2, 3_400_000, 2_000_000, 2_400_000, 800_000, '12건', 40),
      box(3, 600_000, 2_900_000, 2_400_000, 500_000, '재작업 비율', 12),
      box(4, 3_400_000, 2_900_000, 2_400_000, 500_000, '지연 건수', 12),
    ],
  });
  assert.equal(titled.get(9), 'title');
  assert.equal(titled.get(1), 'metric-value-1');
  assert.equal(titled.get(2), 'metric-value-2');
  assert.equal(titled.get(3), 'metric-label-1');

  // A chevron flow sizes every marker to the word it carries, so the row is
  // peers by band and height and never by width; the markers name the structure
  // and the labels drawn on them fill the slots.
  const marker = (shape, left, width) => ({
    shape,
    type: 'text',
    text: '',
    geometry: { left, top: 148, width, height: 101 },
    preset: 'chevron',
  });
  const steps = inducePptxSampleRoles(
    {
      shapes: [
        marker(1, 43, 221),
        box(2, 68, 148, 170, 101, '초안', 12),
        marker(3, 239, 231),
        box(4, 264, 148, 181, 101, '검토', 12),
        marker(5, 445, 282),
        box(6, 470, 148, 231, 101, '승인', 12),
      ],
    },
    { width: 960, height: 540 }
  );
  assert.equal(steps.get(2), 'step-title-1');
  assert.equal(steps.get(4), 'step-title-2');
  assert.equal(steps.get(6), 'step-title-3');

  // Two stacked rows of equal boxes are a grid, not six columns: a role names
  // exactly one box to fill, so only the page's strongest row speaks. The other
  // row is named aside — never filled, emptied when a fill leaves it unwritten.
  const grid = inducePptxSampleRoles({
    shapes: [
      box(1, 600_000, 1_000_000, 2_000_000, 700_000, '가', 14),
      box(2, 3_000_000, 1_000_000, 2_000_000, 700_000, '나', 14),
      box(3, 5_400_000, 1_000_000, 2_000_000, 700_000, '다', 14),
      box(4, 600_000, 4_000_000, 2_000_000, 700_000, '라', 14),
      box(5, 3_000_000, 4_000_000, 2_000_000, 700_000, '마', 14),
      box(6, 5_400_000, 4_000_000, 2_000_000, 700_000, '바', 14),
    ],
  });
  const fillable = [...grid.values()].filter((role) => !role.startsWith('aside-'));
  assert.equal(fillable.length, 3);
  assert.equal(new Set(fillable).size, 3);
  assert.deepEqual(
    [...grid.values()].filter((role) => role.startsWith('aside-')),
    ['aside-1', 'aside-2', 'aside-3']
  );
});

// Reading a deck to reuse it: the page answers with the job it does and each
// box with the slot it fills, on either backend, so the page the user already
// owns can be chosen and filled instead of composed again.
test('a PPTX snapshot reports each page job and the slot every box fills', () => {
  const box = (index, left, top, width, height, text, size) => ({
    index,
    left,
    top,
    width,
    height,
    text,
    font: { size },
  });
  const document = annotatePptxSnapshotRoles({
    format: 'pptx',
    slideCount: 2,
    slideWidth: 13.333,
    slideHeight: 7.5,
    slides: [
      {
        index: 1,
        shapes: [box(1, 0.8, 2.6, 9, 1.4, '야간 출고 개선 보고', 40), box(2, 0.8, 4.2, 6, 0.5, '운영지원팀', 14)],
      },
      {
        index: 2,
        shapes: [
          box(1, 0.7, 0.5, 11.9, 0.9, '도입 전후 비교', 30),
          box(2, 0.7, 2, 5.6, 0.6, '도입 전', 20),
          box(3, 6.9, 2, 5.6, 0.6, '도입 후', 20),
          box(4, 0.7, 2.8, 5.6, 1.6, '평균 3.4초가 걸렸다', 14),
          box(5, 6.9, 2.8, 5.6, 1.6, '평균 1.3초로 줄었다', 14),
        ],
      },
    ],
  });
  assert.equal(document.slides[0].role, 'cover');
  assert.equal(document.slides[0].shapes[0].slot, 'title');
  assert.equal(document.slides[1].role, 'comparison');
  assert.equal(document.slides[1].shapes[1].slot, 'column-title-1');
  assert.equal(document.slides[1].shapes[4].slot, 'column-body-2');

  // The first page is the cover only when it carries nothing a cover never has:
  // a deck that opens on its comparison page answers with that job.
  const single = annotatePptxSnapshotRoles({
    format: 'pptx',
    slideCount: 1,
    slideWidth: 13.333,
    slideHeight: 7.5,
    slides: [
      {
        index: 1,
        shapes: [
          box(1, 0.7, 0.5, 11.9, 0.9, '도입 전후 비교', 30),
          box(2, 0.7, 2, 5.6, 0.6, '도입 전', 20),
          box(3, 6.9, 2, 5.6, 0.6, '도입 후', 20),
          box(4, 0.7, 2.8, 5.6, 1.6, '묶음으로 실어 대기가 길었다', 14),
          box(5, 6.9, 2.8, 5.6, 1.6, '도크별로 나눠 대기가 사라졌다', 14),
        ],
      },
    ],
  });
  assert.equal(single.slides[0].role, 'comparison');

  // A table's words live inside the table, so a page carrying one reads as
  // wordless and was answered as a statement page — one thesis and air. It does
  // the job a chart page does: it carries the quantities.
  const tabular = annotatePptxSnapshotRoles({
    format: 'pptx',
    slideCount: 2,
    slideWidth: 13.333,
    slideHeight: 7.5,
    slides: [
      { index: 1, shapes: [box(1, 0.8, 2.6, 9, 1.4, '야간 출고 개선 보고', 40)] },
      {
        index: 2,
        shapes: [
          box(1, 0.7, 0.5, 11.9, 0.9, '세 안을 나란히 둔다', 28),
          {
            index: 2,
            left: 0.7,
            top: 1.8,
            width: 11.9,
            height: 3.4,
            text: '',
            table: { rows: 4, columns: 3 },
          },
        ],
      },
    ],
  });
  assert.equal(tabular.slides[1].role, 'metrics');

  // A signed timeline is a process page: its labels sit above and below its spine, and read by rows alone the page
  // was a two-column comparison.
  const signed = (text, left, top) => ({
    ...box(0, left, top, 2.6, 0.6, text, 14),
    name: 'mixdog-spec:structure:timeline',
  });
  const timeline = annotatePptxSnapshotRoles({
    format: 'pptx',
    slideCount: 2,
    slideWidth: 13.333,
    slideHeight: 7.5,
    slides: [
      { index: 1, shapes: [box(1, 0.8, 2.6, 9, 1.4, '이전 계획', 40)] },
      {
        index: 2,
        shapes: [
          box(1, 0.7, 0.5, 11.9, 0.9, '6주 동안 네 단계로 옮긴다', 28),
          { ...signed('1–2주', 1.0, 4.0), index: 2 },
          { ...signed('3주', 4.0, 2.6), index: 3 },
          { ...signed('4–5주', 7.0, 4.0), index: 4 },
          { ...signed('6주', 10.0, 2.6), index: 5 },
        ],
      },
    ],
  });
  assert.equal(timeline.slides[1].role, 'process');
  assert.equal(tabular.slides[1].shapes[1].slot, 'table');
});

// Capacity decides which page answers and whether it can answer at all: a page
// takes another item by being replaced, never by shrinking its type.
test('a template page refuses more items than it holds and the closest fitting page answers', () => {
  const page = (index, columns) => ({
    index,
    role: 'comparison',
    shapes: [
      { index: 1, slot: 'title', text: '' },
      ...Array.from({ length: columns }, (_, position) => [
        { index: 2 + position * 2, slot: `column-title-${position + 1}`, text: '' },
        { index: 3 + position * 2, slot: `column-body-${position + 1}`, text: '' },
      ]).flat(),
    ],
  });
  const document = { slides: [page(1, 4), page(2, 2)] };
  assert.equal(selectTemplatePage(document, { role: 'comparison', items: [{}, {}] }).index, 2);
  assert.equal(selectTemplatePage(document, { role: 'comparison', items: [{}, {}, {}] }).index, 1);
  // Items with a second line go to the page that has a box for it, even when a one-line page of the same size
  // comes first.
  const titlesOnlyPage = {
    index: 3,
    role: 'comparison',
    shapes: [
      { index: 1, slot: 'title', text: '' },
      { index: 2, slot: 'column-title-1', text: '' },
      { index: 3, slot: 'column-title-2', text: '' },
    ],
  };
  const withBodies = { slides: [titlesOnlyPage, { ...page(4, 2), index: 4 }] };
  assert.equal(
    selectTemplatePage(withBodies, { role: 'comparison', items: [{ title: '가', body: '설명' }, { title: '나' }] })
      .index,
    4
  );
  assert.equal(
    selectTemplatePage(withBodies, { role: 'comparison', items: [{ title: '가' }, { title: '나' }] }).index,
    3
  );
  assert.throws(
    () => templatePageFill(page(1, 2), { items: [{}, {}, {}] }),
    /holds 2 column slots and 3 items were given/
  );
  const fill = templatePageFill(page(1, 3), { title: '비교', items: [{ title: '가', body: '가 설명' }] });
  assert.deepEqual(
    fill.sets.map((entry) => entry.shape),
    [1, 2, 3]
  );
  assert.deepEqual(fill.deletes, [7, 6, 5, 4]);

  // A page whose columns are one line each has nowhere to put an item's second
  // line: the fill wrote the first line and dropped the rest without a word.
  const oneLine = {
    index: 3,
    role: 'comparison',
    shapes: [
      { index: 1, slot: 'title', text: '' },
      { index: 2, slot: 'column-title-1', text: '' },
      { index: 3, slot: 'column-title-2', text: '' },
    ],
  };
  assert.throws(
    () => templatePageFill(oneLine, { title: '비교', items: [{ title: '가', body: '가 설명' }] }),
    /no column body box for item 1/
  );
  // The same page takes the items it can hold whole.
  const titlesOnly = templatePageFill(oneLine, { title: '비교', items: [{ title: '가' }, { title: '나' }] });
  assert.deepEqual(
    titlesOnly.sets.map((entry) => entry.text),
    ['비교', '가', '나']
  );
});

test('compose presets refuse a section field they cannot draw and size the title band they wrap', async (t) => {
  const cwd = await workspace(t);
  const refused = await executeOfficeTool(
    {
      action: 'create',
      path: join(cwd, 'brief.docx'),
      mode: 'portable',
      operations: [
        {
          op: 'compose_document',
          title: '도크 분리안',
          sections: [{ heading: '실행 계획', roadmap: ['1주차: 표지'] }],
        },
      ],
    },
    { cwd }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /cannot draw: roadmap.*steps/);
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: join(cwd, 'board.xlsx'),
        mode: 'portable',
        operations: [
          {
            op: 'compose_sheet',
            title: '허브별 야간 출고 실적과 지연 원인을 한눈에 보는 운영 대시보드',
            headers: ['허브', '처리량 (건)'],
            rows: [
              ['대전', 128400],
              ['부산', 97300],
            ],
          },
        ],
      },
      { cwd }
    )
  );
  const results = created.batch.results;
  const band = results.find((entry) => entry.op === 'set_row_height');
  assert.ok(band && band.height > 30, JSON.stringify(band));
  value(await executeOfficeTool({ action: 'close', session: created.session }, { cwd }));
});

test('a figure set louder than the headline is read as evidence, not as the page title', () => {
  const box = (shape, text, fontSize, left, top, width, height) => ({
    shape,
    type: 'text',
    text,
    fontSize,
    geometry: { left, top, width, height },
  });
  const roles = inducePptxSampleRoles(
    {
      shapes: [
        box(1, 'NATIVE BY DEFAULT', 10, 58, 48, 400, 20),
        box(2, 'The result stays editable where teams already work.', 40, 58, 100, 520, 142),
        box(3, '18', 82, 650, 132, 250, 138),
        box(4, '−86%', 38, 452, 300, 170, 64),
      ],
    },
    { width: 960, height: 540 }
  );
  assert.equal(roles.get(2), 'title');
  assert.notEqual(roles.get(3), 'title');
});

// The template's own eyebrow, subtitle, and detail lines are its words, not the deck's: a fill that gives them
// no text empties them, and one that names an eyebrow writes it.
test('a template page fill empties the template words no content claimed', () => {
  const page = {
    index: 3,
    role: 'metrics',
    shapes: [
      { index: 1, slot: 'eyebrow', text: 'PERFORMANCE' },
      { index: 2, slot: 'title', text: '' },
      { index: 3, slot: 'visual-text', text: 'VS' },
      { index: 4, slot: 'metric-value-1', text: '' },
      { index: 5, slot: 'metric-label-1', text: '' },
      { index: 6, slot: 'metric-detail-1', text: 'Create · edit · review · save' },
      { index: 7, slot: 'subtitle', text: 'Illustrative' },
    ],
  };
  const fill = templatePageFill(page, {
    title: '흑자 전환',
    eyebrow: '실적',
    items: [{ value: '4.2배', label: 'LTV / CAC' }],
  });
  assert.deepEqual(
    fill.sets.map((entry) => [entry.shape, entry.text]),
    [
      [2, '흑자 전환'],
      [1, '실적'],
      [4, '4.2배'],
      [5, 'LTV / CAC'],
    ]
  );
  assert.deepEqual(fill.deletes, [7, 6], 'the detail and the subtitle go; the decorative VS stays');
  // A word or a figure in the accent block is the template's content, not a sign: the bundled closing page kept
  // "MIXDOG" and its cover "18" on every deck built from it.
  const branded = templatePageFill(
    {
      index: 18,
      role: 'closing',
      shapes: [
        { index: 2, slot: 'title', text: '' },
        { index: 5, slot: 'visual-text', text: 'MIXDOG' },
        { index: 7, slot: 'visual-text', text: '18' },
      ],
    },
    { title: '승인해 주세요' }
  );
  assert.deepEqual(branded.deletes, [7, 5]);
});

test('use_template_page reads the bundled template by its sidecar roles', async (t) => {
  const cwd = await workspace(t);
  const office = async (args) => {
    const raw = await executeOfficeTool(args, { cwd });
    if (raw.isError) throw new Error(raw.content[0].text);
    return value(raw);
  };
  const deck = join(cwd, 'deck.pptx');
  const created = await office({
    action: 'author',
    path: deck,
    mode: 'portable',
    render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      p.addSlide().addText('모아페이 IR', {x:0.8,y:2.6,w:9,h:1.4,fontSize:40});
      await p.writeFile({fileName:OUTPUT});`,
  });
  await office({ action: 'close', session: created.session });
  const opened = await office({ action: 'open', path: deck, mode: 'portable' });
  t.after(async () => {
    await office({ action: 'close', session: opened.session }).catch(() => {});
  });
  // The executive metric pages step their figures down a diagonal: the geometry reading finds no metric row on
  // them, and the sidecar is what names their three metric slots.
  await office({
    action: 'batch',
    session: opened.session,
    operations: [
      {
        op: 'use_template_page',
        path: fileURLToPath(new URL('./design/library/templates/mixdog-executive.pptx', import.meta.url)),
        role: 'metrics',
        after: 1,
        title: '세 지표가 모두 흑자 전환을 가리킨다',
        items: [
          { value: '4.2배', label: 'LTV / CAC' },
          { value: '81%', label: '유지율' },
          { value: '14개월', label: '회수 기간' },
        ],
      },
    ],
  });
  const snapshot = await office({ action: 'snapshot', session: opened.session });
  const text = snapshot.document.slides[1].text.join(' ');
  for (const words of ['세 지표가 모두 흑자 전환을 가리킨다', '4.2배', '81%', '14개월', '회수 기간'])
    assert.ok(text.includes(words), text);
  for (const leftover of ['PERFORMANCE', 'Create · edit']) assert.ok(!text.includes(leftover), text);
  // A page with a chart arrives holding the template's own series: the result names that chart, where it now
  // stands, and the operation that replaces its data.
  const charted = await office({
    action: 'batch',
    session: opened.session,
    operations: [
      {
        op: 'use_template_page',
        path: fileURLToPath(new URL('./design/library/templates/mixdog-executive.pptx', import.meta.url)),
        slide: 16,
        after: 2,
        title: '결정까지 걸리는 시간이 줄었다',
        items: [{ value: '3일', label: '평균 결정 시간' }],
      },
    ],
  });
  assert.equal(charted.templateData?.length, 1, JSON.stringify(charted.templateData));
  const [kept] = charted.templateData;
  assert.deepEqual([kept.slide, kept.holds, kept.replaceWith], [3, 'chart', 'set_chart_data']);
  // Its title is the template's words too, and new numbers alone keep it: the record names it for the caller.
  assert.equal(kept.title, 'Workstream time · seconds');
  const after = await office({ action: 'snapshot', session: opened.session });
  assert.ok(
    after.document.slides[2].shapes.find((shape) => shape.index === kept.shape)?.chart,
    'the named shape is the chart'
  );
  // Its series take their colours from the theme (accent1, accent2): new data keeps them, resolved through the
  // deck's theme, where the rebuilt chart had fallen back to the default blue.
  const refreshed = await office({
    action: 'batch',
    session: opened.session,
    operations: [
      {
        op: kept.replaceWith,
        slide: kept.slide,
        shape: kept.shape,
        categories: ['1월', '2월', '3월'],
        series: [{ name: '결정 시간 (일)', values: [7, 5, 3] }],
        title: '월별 결정 시간 (일)',
      },
    ],
  });
  assert.ok(refreshed.results[0].preserved?.includes('seriesColors'), JSON.stringify(refreshed.results[0]));
  // The title takes the new words in the template's own treatment (18.62 pt, not bold), not the runtime's bold.
  const packaged = await parts(opened.output || deck);
  const rels = await packaged.text('ppt/slides/_rels/slide3.xml.rels');
  const chartXml = await packaged.text(`ppt/charts/${/charts\/(chart\d+\.xml)/.exec(rels)[1]}`);
  const title = /<c:title>[\s\S]*?<\/c:title>/.exec(chartXml)[0];
  assert.match(title, /월별 결정 시간 \(일\)/);
  assert.match(title, /sz="1862" b="0"/);
});

// A new title is words in the chart's own title block. Rebuilt for it, a template's bar chart turned its categories
// over — PowerPoint's copy of the same page kept them — and redrew its legend in the runtime's own treatment.
test('new numbers and a title keep a template chart as it stands but for its words', async (t) => {
  const cwd = await workspace(t);
  const office = async (args) => {
    const raw = await executeOfficeTool(args, { cwd });
    if (raw.isError) throw new Error(raw.content[0].text);
    return value(raw);
  };
  const deck = join(cwd, 'retitled.pptx');
  const created = await office({ action: 'create', path: deck, format: 'pptx', mode: 'portable' });
  t.after(async () => {
    await office({ action: 'close', session: created.session }).catch(() => {});
  });
  const filled = await office({
    action: 'batch',
    session: created.session,
    operations: [
      {
        op: 'use_template_page',
        path: fileURLToPath(new URL('./design/library/templates/mixdog-executive.pptx', import.meta.url)),
        slide: 6,
        after: 0,
        title: '월별 오류 건수가 석 달 연속 줄었다',
      },
    ],
  });
  const [chart] = filled.templateData;
  assert.equal(chart.title, 'Cycle time · seconds');
  const chartXml = async () => {
    const packaged = await parts(created.output || deck);
    const rels = await packaged.text(`ppt/slides/_rels/slide${chart.slide}.xml.rels`);
    return packaged.text(`ppt/charts/${/charts\/(chart\d+\.xml)/.exec(rels)[1]}`);
  };
  const before = await chartXml();
  await office({
    action: 'batch',
    session: created.session,
    operations: [
      {
        op: 'set_chart_data',
        slide: chart.slide,
        shape: chart.shape,
        categories: ['6월', '7월', '8월', '9월'],
        series: [{ name: '오류 (건)', values: [8400, 6100, 3900, 2700] }],
        title: '월별 결제 오류 (건)',
      },
    ],
  });
  const after = await chartXml();
  const legend = (xml) => /<c:legend>[\s\S]*?<\/c:legend>/.exec(xml)?.[0];
  const order = (xml) => /<c:catAx>[\s\S]*?<c:orientation val="(\w+)"/.exec(xml)?.[1];
  const title = (xml) => /<c:chart>(?:(?!<c:plotArea>)[\s\S])*?(<c:title>[\s\S]*?<\/c:title>)/.exec(xml)?.[1] || '';
  const runProperties = (xml) => /<a:r><a:rPr\b[^>]*>/.exec(title(xml))?.[0];
  assert.ok(legend(before), 'the template chart has a legend');
  assert.equal(legend(after), legend(before), 'the legend stands as designed');
  assert.equal(order(after), order(before), 'the categories keep their order');
  assert.match(title(after), /월별 결제 오류 \(건\)/);
  assert.doesNotMatch(title(after), /Cycle time/);
  assert.equal(runProperties(after), runProperties(before), "in the title's own treatment");
  // Value labels rebuild the chart; its categories still read in the order the template set, as PowerPoint keeps it.
  await office({
    action: 'batch',
    session: created.session,
    operations: [
      {
        op: 'set_chart_data',
        slide: chart.slide,
        shape: chart.shape,
        categories: ['6월', '7월', '8월', '9월'],
        series: [{ name: '오류 (건)', values: [8400, 6100, 3900, 2700] }],
        showValues: true,
      },
    ],
  });
  const labelled = await chartXml();
  assert.match(labelled, /<c:showVal val="1"\/>/);
  assert.equal(order(labelled), order(before), 'the categories keep their order through the rebuild');
});

// Reuse, end to end: the page is chosen by the job it does, its slots take the
// words, and the slots no item claimed are emptied rather than left carrying the
// template's own words.
test('use_template_page takes the page whose job matches and fills its slots', async (t) => {
  const cwd = await workspace(t);
  const office = async (args) => {
    const raw = await executeOfficeTool(args, { cwd });
    if (raw.isError) throw new Error(raw.content[0].text);
    return value(raw);
  };
  const template = join(cwd, 'template.pptx');
  const built = await office({
    action: 'author',
    path: template,
    mode: 'portable',
    render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      const cover = p.addSlide();
      cover.addText('브랜드 덱', {x:0.8,y:2.6,w:9,h:1.4,fontSize:40});
      cover.addText('디자인팀', {x:0.8,y:4.2,w:6,h:0.5,fontSize:14});
      const compare = p.addSlide();
      compare.addText('세 방식 비교', {x:0.7,y:0.5,w:11.9,h:0.9,fontSize:30});
      compare.addText('가 방식', {x:0.7,y:2,w:3.8,h:0.6,fontSize:20});
      compare.addText('나 방식', {x:4.8,y:2,w:3.8,h:0.6,fontSize:20});
      compare.addText('다 방식', {x:8.9,y:2,w:3.8,h:0.6,fontSize:20});
      compare.addText('가 설명', {x:0.7,y:2.8,w:3.8,h:1.6,fontSize:14});
      compare.addText('나 설명', {x:4.8,y:2.8,w:3.8,h:1.6,fontSize:14});
      compare.addText('다 설명', {x:8.9,y:2.8,w:3.8,h:1.6,fontSize:14});
      await p.writeFile({fileName:OUTPUT});`,
  });
  await office({ action: 'close', session: built.session });
  const deck = join(cwd, 'deck.pptx');
  const created = await office({
    action: 'author',
    path: deck,
    mode: 'portable',
    render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      const s = p.addSlide();
      s.addText('야간 출고 보고', {x:0.8,y:2.6,w:9,h:1.4,fontSize:40});
      await p.writeFile({fileName:OUTPUT});`,
  });
  await office({ action: 'close', session: created.session });
  const opened = await office({ action: 'open', path: deck, mode: 'portable' });
  t.after(async () => {
    await office({ action: 'close', session: opened.session }).catch(() => {});
  });
  await office({
    action: 'batch',
    session: opened.session,
    operations: [
      {
        op: 'use_template_page',
        path: template,
        role: 'comparison',
        after: 1,
        title: '출고 방식 비교',
        items: [
          { title: '기존', body: '묶음으로 실어 대기가 길었다' },
          { title: '개선', body: '도크별로 나눠 대기가 사라졌다' },
        ],
      },
    ],
  });
  const snapshot = await office({ action: 'snapshot', session: opened.session });
  assert.equal(snapshot.document.slides.length, 2);
  const page = snapshot.document.slides[1];
  const texts = page.shapes.map((shape) => shape.text);
  assert.equal(page.role, 'comparison');
  assert.ok(texts.includes('출고 방식 비교'), texts.join(' | '));
  assert.ok(texts.includes('기존'), texts.join(' | '));
  assert.ok(texts.includes('도크별로 나눠 대기가 사라졌다'), texts.join(' | '));
  // The third column claimed no item, so its boxes left with it.
  assert.equal(page.shapes.length, 5);
  assert.ok(!texts.includes('다 방식'), texts.join(' | '));
  assert.ok(!texts.includes('다 설명'), texts.join(' | '));
});

// A drawn page carries more words than its title and its row: the kicker over
// the title, the sentence under it, and the source at its foot are the old
// page's, so they are written or emptied — never left stating the old summary.
test('use_template_page writes or empties the kicker, lead, and source of a drawn page', async (t) => {
  const cwd = await workspace(t);
  const office = async (args) => {
    const raw = await executeOfficeTool(args, { cwd });
    if (raw.isError) throw new Error(raw.content[0].text);
    return value(raw);
  };
  const template = join(cwd, 'template.pptx');
  const built = await office({
    action: 'author',
    path: template,
    mode: 'portable',
    render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      p.addSlide().addText('브랜드 덱', {x:0.8,y:2.6,w:9,h:1.4,fontSize:40});
      const s = p.addSlide();
      s.addText('SUMMARY', {x:0.7,y:0.6,w:3,h:0.3,fontSize:10});
      s.addText('월 거래자 1,420만 명', {x:0.7,y:0.95,w:8,h:0.9,fontSize:34});
      s.addText('송금으로 들어온 사용자가 결제와 대출로 이어지며 처음으로 영업이익을 냈다.', {x:0.7,y:2.0,w:8,h:0.8,fontSize:15});
      s.addText('1,420', {x:0.7,y:4.2,w:2.6,h:0.8,fontSize:40});
      s.addText('38.2', {x:4.0,y:4.2,w:2.6,h:0.8,fontSize:40});
      s.addText('월 거래자', {x:0.7,y:5.05,w:2.6,h:0.4,fontSize:11});
      s.addText('분기 거래액', {x:4.0,y:5.05,w:2.6,h:0.4,fontSize:11});
      s.addText('출처: 내부 집계 (예시 수치)', {x:0.7,y:6.7,w:8,h:0.3,fontSize:9});
      await p.writeFile({fileName:OUTPUT});`,
  });
  await office({ action: 'close', session: built.session });
  const opened = await office({ action: 'open', path: template, mode: 'portable' });
  t.after(async () => {
    await office({ action: 'close', session: opened.session }).catch(() => {});
  });
  const slots = (await office({ action: 'snapshot', session: opened.session })).document.slides[1].shapes.map(
    (shape) => shape.slot
  );
  assert.deepEqual(
    slots.filter((slot) => !/^metric-/.test(slot || '')),
    ['eyebrow', 'title', 'subtitle', 'source']
  );
  await office({
    action: 'batch',
    session: opened.session,
    operations: [
      {
        op: 'use_template_page',
        path: template,
        role: 'metrics',
        after: 2,
        title: '월 거래자 2,000만 명',
        body: '해외 송금 출시 한 달 만에 2,000만 명을 넘었다.',
        items: [
          { value: '2,010', label: '월 거래자' },
          { value: '41.5', label: '분기 거래액' },
        ],
      },
    ],
  });
  const texts = (await office({ action: 'snapshot', session: opened.session })).document.slides[2].shapes.map(
    (shape) => shape.text
  );
  assert.ok(texts.includes('해외 송금 출시 한 달 만에 2,000만 명을 넘었다.'), texts.join(' | '));
  for (const stale of [
    'SUMMARY',
    '출처: 내부 집계 (예시 수치)',
    '송금으로 들어온 사용자가 결제와 대출로 이어지며 처음으로 영업이익을 냈다.',
  ]) {
    assert.ok(!texts.includes(stale), `${stale} stayed: ${texts.join(' | ')}`);
  }
  await assert.rejects(
    office({
      action: 'batch',
      session: opened.session,
      operations: [
        {
          op: 'use_template_page',
          path: template,
          role: 'metrics',
          after: 3,
          eyebrow: 'Q3',
          title: 'x',
          source: '출처: 없음',
          subtitle: 'a',
          body: 'b',
        },
      ],
    }),
    /no body box/
  );
});

// The same reading through the session a user actually opens: an authored deck
// carries no placeholder at all, so every role here is induced from geometry.
test('a session snapshot answers with the page job and the slots of a drawn deck', async (t) => {
  const cwd = await workspace(t);
  const office = async (args) => {
    const raw = await executeOfficeTool(args, { cwd });
    if (raw.isError) throw new Error(raw.content[0].text);
    return value(raw);
  };
  const authored = await office({
    action: 'author',
    path: join(cwd, 'roles.pptx'),
    mode: 'portable',
    render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      const cover = p.addSlide();
      cover.addText('야간 출고 개선 보고', {x:0.8,y:2.6,w:9,h:1.4,fontSize:40});
      cover.addText('운영지원팀', {x:0.8,y:4.2,w:6,h:0.5,fontSize:14});
      const compare = p.addSlide();
      compare.addText('도입 전후 비교', {x:0.7,y:0.5,w:11.9,h:0.9,fontSize:30});
      compare.addText('도입 전', {x:0.7,y:2,w:5.6,h:0.6,fontSize:20});
      compare.addText('도입 후', {x:6.9,y:2,w:5.6,h:0.6,fontSize:20});
      compare.addText('묶음 단위로 실어 대기가 길었다', {x:0.7,y:2.8,w:5.6,h:1.6,fontSize:14});
      compare.addText('도크별로 나눠 대기가 사라졌다', {x:6.9,y:2.8,w:5.6,h:1.6,fontSize:14});
      await p.writeFile({fileName:OUTPUT});`,
  });
  t.after(async () => {
    await office({ action: 'close', session: authored.session }).catch(() => {});
  });
  const snapshot = await office({ action: 'snapshot', session: authored.session });
  const [cover, compare] = snapshot.document.slides;
  assert.equal(cover.role, 'cover');
  assert.equal(compare.role, 'comparison');
  assert.equal(compare.shapes[0].slot, 'title');
  assert.equal(compare.shapes[1].slot, 'column-title-1');
  assert.equal(compare.shapes[4].slot, 'column-body-2');
});

test('local Office template indexing detects changes without rebinding existing documents', async (t) => {
  const cwd = await workspace(t);
  const dataDir = join(cwd, 'design-library-data');
  const templates = join(cwd, 'templates');
  const template = join(templates, 'brand.pptx');
  await mkdir(templates, { recursive: true });
  await writeFile(template, Buffer.from('template-v1'));
  await writeFile(
    `${template}.mixdog.json`,
    JSON.stringify({
      id: 'brand-deck',
      label: 'Brand Deck',
      layouts: [
        {
          id: 'brand-statement',
          format: 'pptx',
          kind: 'statement',
          defaults: { titleSize: 44 },
        },
      ],
    })
  );
  const config = { templateDirectories: [templates] };
  const first = await indexOfficeTemplates({ dataDir, config });
  const firstTemplate = first.templates.find((entry) => entry.id === 'brand-deck');
  assert.ok(firstTemplate);
  const document = join(cwd, 'bound.pptx');
  const selected = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: document,
    format: 'pptx',
    created: true,
    request: { template: 'brand-deck' },
    config,
  });
  assert.equal(selected.template.id, 'brand-deck');
  assert.equal(selected.layouts[0].id, 'brand-statement');
  await persistOfficeDesignBinding(dataDir, document, selected.binding);

  await writeFile(template, Buffer.from('template-v2-with-new-content'));
  const second = await indexOfficeTemplates({ dataDir, config });
  const secondTemplate = second.templates.find((entry) => entry.id === 'brand-deck');
  assert.equal(second.changed, true);
  assert.notEqual(secondTemplate.version, firstTemplate.version);
  const existing = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: document,
    format: 'pptx',
    created: false,
    request: {},
    config,
  });
  assert.equal(existing.binding.templateVersion, firstTemplate.version);
  assert.equal(existing.template, null);
  assert.match(existing.warning, /remains unchanged/);
  const next = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: join(cwd, 'next.pptx'),
    format: 'pptx',
    created: true,
    request: { template: 'brand-deck' },
    config,
  });
  assert.equal(next.template.version, secondTemplate.version);

  await writeFile(`${template}.mixdog.json`, JSON.stringify({ id: 'invalid template id' }));
  const degraded = await syncOfficeDesignLibrary({
    dataDir,
    config,
    allowRemote: false,
    indexTemplates: true,
  });
  assert.equal(degraded.ok, false);
  assert.match(degraded.warning, /template index was not updated/);
  assert.equal(degraded.templates.revision, second.revision);
  const fallback = await resolveOfficeDesignLibrary({
    dataDir,
    documentPath: join(cwd, 'fallback.pptx'),
    format: 'pptx',
    created: true,
    request: {},
    config,
  });
  assert.equal(fallback.source, 'mixdog-starter');
  assert.match(fallback.warning, /template index was not updated/);
});

test('Office design composition maps Word, Excel, and PDF to native structures', () => {
  const word = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [
      {
        op: 'compose_document',
        title: 'Decision brief',
        subtitle: 'Prepared for review',
        sections: [
          {
            heading: 'Recommendation',
            paragraphs: ['Adopt semantic composition.'],
            bullets: ['Preserve native styles.'],
            table: [
              ['Owner', 'Status'],
              ['Mixdog', 'Ready'],
            ],
          },
        ],
        footer: 'Source: operating model',
        pageNumbers: true,
      },
    ],
  });
  assert.ok(word.operations.some((operation) => operation.op === 'set_page'));
  assert.ok(
    word.operations.some((operation) => operation.op === 'append_text' && operation.properties.listKind === 'bullet')
  );
  assert.ok(word.operations.some((operation) => operation.op === 'set_table_cell_style'));
  assert.ok(
    word.operations.some(
      (operation) =>
        operation.op === 'add_page_numbers' &&
        operation.alignment === 'center' &&
        operation.prefix === 'Source: operating model · ' &&
        operation.separator === ' / '
    )
  );
  assert.ok(!word.operations.some((operation) => operation.op === 'set_header_footer'));
  // A section table the composer cannot write is refused, because a dropped
  // table reads as a finished document; the shape it does take still writes.
  const composeWith = (table) =>
    expandOfficeDesignOperations({
      format: 'docx',
      backend: 'microsoft-office-com',
      created: true,
      operations: [{ op: 'compose_document', title: 'Cost', sections: [{ heading: 'Ask', table }] }],
    });
  assert.throws(
    () =>
      composeWith({
        values: [
          ['Item', 'Cost'],
          ['Crew', '12'],
        ],
      }),
    /sections\[1\]\.table does not take values.*headers/s
  );
  assert.throws(() => composeWith({ rows: 'Crew' }), /rows must be an array of row arrays/);
  const keyed = composeWith({ headers: ['Item', 'Cost'], rows: [['Crew', '12']] });
  const keyedTable = keyed.operations.find((operation) => operation.op === 'add_table');
  assert.deepEqual(keyedTable.values, [
    ['Item', 'Cost'],
    ['Crew', '12'],
  ]);
  // A bound fact is written the way the prose writes it, and the cell style the
  // composer asks for is one the contract accepts — the metric strip was
  // refused by the runtime's own validation until both agreed.
  const measured = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'microsoft-office-com',
    created: true,
    design: {
      purpose: 'decide',
      content: {
        packageId: 'ops',
        facts: [
          { id: 'on-time', label: 'On time', value: 0.928, numberFormat: '0.0%' },
          { id: 'throughput', label: 'Throughput', value: 47210, unit: 'orders' },
        ],
        claims: [{ id: 'approve', text: 'Approve the crew', factIds: ['on-time', 'throughput'] }],
      },
    },
    operations: [
      {
        op: 'compose_document',
        title: 'Night shift',
        claimId: 'approve',
        metrics: [{ factId: 'on-time' }, { factId: 'throughput' }],
        sections: [{ heading: 'Evidence', paragraphs: ['Throughput reached 47,210 orders.'] }],
      },
    ],
  });
  const strip = measured.operations.find((operation) => operation.op === 'add_table');
  // The unit is part of the figure it counts, not a line under it: parked on the
  // detail row it rendered as an orphan word beside empty cells, and the value
  // above it lost its unit. A Latin unit keeps the space it is read with.
  assert.deepEqual(strip.values[1], ['92.8%', '47,210 orders']);
  // A detail row nobody filled rendered as a blank band under the figures, so
  // the strip stops at the values unless a metric says something there.
  assert.equal(strip.values.length, 2, JSON.stringify(strip.values));
  const detailless = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'mixdog-ooxml',
    created: true,
    design: {
      purpose: 'decide',
      content: { facts: [{ id: 'on-time', label: 'On time', value: 0.928, numberFormat: '0.0%' }] },
    },
    operations: [{ op: 'compose_document', title: 'Night shift', metrics: [{ factId: 'on-time' }] }],
  });
  const bare = detailless.operations.find((operation) => operation.op === 'add_table');
  assert.equal(bare.values.length, 2, JSON.stringify(bare.values));
  assert.ok(!detailless.operations.some((operation) => operation.op === 'set_table_cell_style' && operation.row === 3));
  // The claim is the sentence the memo exists to make. Binding it to a titled
  // operation put it in the title it already had, so the document shipped with
  // its metrics and evidence and no recommendation in it.
  const recommendation = measured.operations
    .filter((operation) => operation.op === 'append_text')
    .map((operation) => operation.text);
  assert.ok(recommendation.includes('Approve the crew'), JSON.stringify(recommendation));
  assert.equal(recommendation[0], 'Night shift');

  // A fact key the model does not read was dropped, and the figure then shipped
  // in the wrong notation: format:'percent' printed 0.928 beside "92.8%".
  const spoken = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'mixdog-ooxml',
    created: true,
    design: {
      purpose: 'decide',
      content: {
        packageId: 'ops',
        facts: [{ id: 'on-time', label: '정시 출고율', value: 0.928, format: 'percent' }],
        claims: [{ id: 'approve', text: '야간 인력 12명 증원을 승인해 주십시오.', factIds: ['on-time'] }],
      },
    },
    operations: [
      { op: 'compose_document', title: '야간 운영 확대 검토', claimId: 'approve', metrics: [{ factId: 'on-time' }] },
    ],
  });
  assert.deepEqual(spoken.operations.find((operation) => operation.op === 'add_table').values[1], ['92.8%']);
  // A metric written straight into the preset reads the same spellings as a
  // bound fact: `format: 'percent'` printed 0.928 in the strip, and the unit
  // sat on its own row under an otherwise empty band.
  const written = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { purpose: 'decide' },
    operations: [
      {
        op: 'compose_document',
        title: '10월 야간 운영 보고',
        metrics: [
          { label: '정시 출고율', value: 0.928, format: 'percent' },
          { label: '야간 증원', value: 12, unit: '명' },
          { label: '지연 건수', value: 210, detail: '4분기' },
        ],
      },
    ],
  });
  const writtenStrip = written.operations.find((operation) => operation.op === 'add_table');
  assert.deepEqual(writtenStrip.values[1], ['92.8%', '12명', '210']);
  assert.deepEqual(writtenStrip.values[2], ['', '', '4분기']);
  // In a cell the unit rides in the number format, so the value stays a number
  // a formula can use and the sheet still shows "12명".
  const sheet = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    design: { purpose: 'monitor' },
    operations: [
      {
        op: 'compose_sheet',
        title: '야간 운영',
        kind: 'dashboard',
        metrics: [
          { label: '정시 출고율', value: 0.928, format: 'percent' },
          { label: '야간 증원', value: 12, unit: '명' },
        ],
      },
    ],
  });
  const formats = sheet.operations
    .filter((operation) => operation.op === 'set_style' && operation.properties?.numberFormat)
    .map((operation) => operation.properties.numberFormat);
  assert.ok(formats.includes('0.0%'), JSON.stringify(formats));
  assert.ok(formats.includes('#,##0"명"'), JSON.stringify(formats));
  assert.throws(
    () =>
      expandOfficeDesignOperations({
        format: 'docx',
        backend: 'mixdog-ooxml',
        created: true,
        design: { content: { facts: [{ id: 'on-time', label: 'On time', value: 0.928, formatting: '0.0%' }] } },
        operations: [{ op: 'compose_document', title: 'Night shift' }],
      }),
    /unknown key\(s\): formatting.*A fact takes: /s
  );
  assertOfficeOperationContracts({
    format: 'docx',
    backend: 'microsoft-office-com',
    operations: measured.operations,
  });
  const workbook = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'Summary',
        title: 'Operating summary',
        headers: ['Metric', 'Value'],
        rows: [
          ['Calls', 3],
          ['Accuracy', 1],
        ],
      },
    ],
  });
  assert.ok(workbook.operations.some((operation) => operation.op === 'merge_cells'));
  assert.ok(workbook.operations.some((operation) => operation.op === 'add_table'));
  assert.ok(workbook.operations.some((operation) => operation.op === 'autofit_range'));
  // Excel checks a formula when it is written, so a metric that reads the table is written after the table exists.
  const withMetrics = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [
      {
        op: 'compose_sheet',
        sheet: 'Summary',
        title: 'Hubs',
        tableName: 'Hubs',
        headers: ['Hub', 'Volume'],
        rows: [
          ['Daejeon', 128400],
          ['Gwangju', 84200],
        ],
        metrics: [{ label: 'Total', formula: '=SUM(Hubs[Volume])' }],
      },
    ],
  }).operations.map((operation) => operation.op);
  assert.ok(withMetrics.indexOf('set_formula') > withMetrics.indexOf('add_table'), withMetrics.join(', '));
  const pdf = applyPdfDesign(
    [
      { type: 'heading', text: 'Report' },
      {
        type: 'table',
        rows: [
          ['Metric', 'Value'],
          ['Calls', '3'],
        ],
      },
    ],
    { profile: 'data' }
  );
  assert.equal(pdf.blocks[0].color, '1F2933');
  assert.equal(pdf.blocks[1].headerFill, '183028');
});

test('Office design review reports decorative stripes and repeated grids without requiring a redesign', () => {
  const cardSlide = (index) => ({
    index,
    shapes: [
      { type: 17, text: `Slide ${index}`, left: 50, top: 40, width: 800, height: 50, font: { size: 34 } },
      { type: 1, text: 'Card A explains the first pillar in a sentence.', left: 60, top: 160, width: 240, height: 120 },
      {
        type: 1,
        text: 'Card B explains the second pillar in a sentence.',
        left: 330,
        top: 160,
        width: 240,
        height: 120,
      },
      {
        type: 1,
        text: 'Card C explains the third pillar in a sentence.',
        left: 600,
        top: 160,
        width: 240,
        height: 120,
      },
      { type: 1, text: '', left: 40, top: 90, width: 7, height: 340 },
    ],
  });
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: { slides: [cardSlide(1), cardSlide(2), cardSlide(3), cardSlide(4), cardSlide(5), cardSlide(6)] },
    design: { profile: 'editorial' },
  });
  assert.equal(review.status, 'pass');
  assert.ok(review.issues.some((issue) => issue.code === 'decorative_stripe'));
  assert.ok(review.issues.some((issue) => issue.code === 'card_grid_overuse'));
  assert.ok(review.issues.some((issue) => issue.code === 'repetitive_composition'));
});

test('Office design review judges an authored deck by its own ladder and geometry', () => {
  const title = (index) => ({
    type: 17,
    text: `Slide ${index}`,
    left: 43,
    top: 72,
    width: 800,
    height: 50,
    font: { size: 32 },
  });
  const heroBand = (index) => ({
    index,
    background: { color: 'F9F4F1' },
    shapes: [
      title(index),
      ...[0, 1, 2, 3].map((column) => ({
        type: 1,
        text: String(40 + column),
        left: 43 + column * 220,
        top: 173,
        width: 200,
        height: 80,
        font: { size: 56 },
      })),
      { type: 1, text: '', left: 43, top: 306, width: 873, height: 1 }, // hairline between rows
      ...[0, 1, 2, 3].map((column) => ({
        type: 1,
        text: 'One line of context under the number.',
        left: 43 + column * 220,
        top: 324,
        width: 195,
        height: 90,
      })),
    ],
  });
  const steps = (index) => ({
    index,
    background: { color: 'F9F4F1' },
    shapes: [
      title(index),
      ...[0, 1, 2, 3, 4].map((step) => ({
        type: 1,
        text: `Stage ${step} with a short note under the lead.`,
        left: 43 + step * 176,
        top: 389 - step * 61,
        width: 158,
        height: 94,
      })),
    ],
  });
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        {
          index: 1,
          background: { color: '1F1512' },
          shapes: [{ type: 17, text: 'Cover', left: 43, top: 180, width: 600, height: 120, font: { size: 44 } }],
        },
        heroBand(2),
        steps(3),
        {
          index: 4,
          background: { color: '1F1512' },
          shapes: [title(4), { type: 1, text: '97%', left: 130, top: 260, width: 230, height: 60, font: { size: 40 } }],
        },
        heroBand(5),
        {
          index: 6,
          background: { color: '1F1512' },
          shapes: [{ type: 17, text: 'Closing', left: 43, top: 180, width: 600, height: 120, font: { size: 36 } }],
        },
      ],
    },
    design: { profile: 'editorial' },
  });
  const codes = new Set(review.issues.map((issue) => issue.code));
  assert.equal(codes.has('theme_background_drift'), false);
  assert.equal(codes.has('decorative_stripe'), false);
  assert.equal(codes.has('card_grid_overuse'), false);
  // An authored deck may open light and close dark: its own two backgrounds are
  // the ladder, whichever slide takes which. Only a third field is drift.
  const lightCover = (slides) =>
    reviewOfficeDesign({
      format: 'pptx',
      document: { slides },
      design: { profile: 'editorial' },
    }).issues.filter((issue) => issue.code === 'theme_background_drift');
  const authored = [
    {
      index: 1,
      background: { color: 'F7FAF9' },
      shapes: [{ type: 17, text: '야간 운영 보고', left: 43, top: 180, width: 600, height: 120, font: { size: 44 } }],
    },
    { index: 2, background: { color: 'F7FAF9' }, shapes: [title(2)] },
    { index: 3, background: { color: 'F7FAF9' }, shapes: [title(3)] },
    {
      index: 4,
      background: { color: '0F241A' },
      shapes: [
        { type: 17, text: '승인을 요청드립니다', left: 43, top: 180, width: 600, height: 120, font: { size: 36 } },
      ],
    },
  ];
  assert.deepEqual(lightCover(authored), []);
  const thirdField = lightCover([
    ...authored.slice(0, 3),
    { ...authored[3], index: 4 },
    { index: 5, background: { color: '7A4E1F' }, shapes: [title(5)] },
  ]);
  assert.equal(thirdField.length, 1);
  assert.match(thirdField[0].message, /5:7A4E1F/);
  const edgeStripe = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        { index: 1, background: { color: '1F1512' }, shapes: [] },
        {
          index: 2,
          background: { color: 'F9F4F1' },
          shapes: [title(2), { type: 1, text: '', left: 0, top: 0, width: 960, height: 6 }],
        },
        { index: 3, background: { color: '1F1512' }, shapes: [] },
      ],
    },
    design: { profile: 'editorial' },
  });
  assert.ok(edgeStripe.issues.some((issue) => issue.code === 'decorative_stripe'));
  // A level line in a diagram column is not an underline of the hero numeral beside it: they share no columns.
  const beside = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        { index: 1, background: { color: '1F1512' }, shapes: [] },
        {
          index: 2,
          background: { color: 'F9F4F1' },
          shapes: [
            title(2),
            { type: 1, text: '0', left: 660, top: 210, width: 250, height: 80, font: { size: 65 } },
            { type: 1, text: '', left: 80, top: 288, width: 540, height: 0 },
          ],
        },
        { index: 3, background: { color: '1F1512' }, shapes: [] },
      ],
    },
    design: { profile: 'editorial' },
  });
  assert.equal(
    beside.issues.some((issue) => issue.code === 'decorative_stripe'),
    false
  );
  const underline = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        { index: 1, background: { color: '1F1512' }, shapes: [] },
        {
          index: 2,
          background: { color: 'F9F4F1' },
          shapes: [title(2), { type: 1, text: '', left: 43, top: 130, width: 540, height: 2 }],
        },
        { index: 3, background: { color: '1F1512' }, shapes: [] },
      ],
    },
    design: { profile: 'editorial' },
  });
  assert.ok(
    underline.issues.some((issue) => issue.code === 'decorative_stripe'),
    'a rule under the title is still an underline'
  );
});

// The bundled template's chart workbooks each held a table of four columns (" ", "계열 1"…) over a two- or
// three-column range headed "Stage" / "Cycle time": Excel asks to repair such a workbook, so PowerPoint's
// set_chart_data failed on ChartData.Activate (0xB0D7019E). Every table must name the header row it covers.
test('the bundled template’s chart workbooks hold tables that match their header rows', async () => {
  const template = fileURLToPath(new URL('./design/library/templates/mixdog-executive.pptx', import.meta.url));
  const deck = await JSZip.loadAsync(await readFile(template));
  const embedded = Object.keys(deck.files).filter((name) => /^ppt\/embeddings\/.+\.xlsx$/.test(name));
  assert.ok(embedded.length > 0);
  for (const name of embedded) {
    const book = await JSZip.loadAsync(await deck.file(name).async('nodebuffer'));
    const sheet = await book.file('xl/worksheets/sheet1.xml').async('string');
    for (const tablePart of Object.keys(book.files).filter((part) => /^xl\/tables\/table\d+\.xml$/.test(part))) {
      const table = await book.file(tablePart).async('string');
      const [, from, row, to] = /\bref="([A-Z])(\d+):([A-Z])\d+"/.exec(table);
      const headers = [];
      for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code += 1) {
        const cell =
          new RegExp(`<c r="${String.fromCharCode(code)}${row}"[^>]*>([\\s\\S]*?)</c>`).exec(sheet)?.[1] || '';
        headers.push(/<t[^>]*>([\s\S]*?)<\/t>/.exec(cell)?.[1] || '');
      }
      const columns = [...table.matchAll(/<tableColumn\b[^>]*\bname="([^"]*)"/g)].map((match) => match[1]);
      assert.deepEqual(columns, headers, `${name} ${tablePart}`);
    }
  }
});

// A template repeats its phrases from page to page, and replace_text rewrote every one of them: "slide" was
// refused as an unknown field, so a caller could not keep a correction on the page it was meant for.
test('a deck replace_text scoped to a slide leaves the same phrase on other slides alone', async (t) => {
  const cwd = await workspace(t);
  const office = async (args) => {
    const raw = await executeOfficeTool(args, { cwd });
    if (raw.isError) throw new Error(raw.content[0].text);
    return value(raw);
  };
  const deck = join(cwd, 'repeat.pptx');
  const created = await office({
    action: 'author',
    path: deck,
    mode: 'portable',
    render: false,
    script: `const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
      p.addSlide().addText('분기 목표 12%', {x:0.8,y:2.6,w:9,h:1.4,fontSize:32});
      const second = p.addSlide(); second.addText('분기 목표 12%', {x:0.8,y:2.6,w:9,h:1.4,fontSize:32});
      second.addNotes('분기 목표 12%를 먼저 말한다');
      await p.writeFile({fileName:OUTPUT});`,
  });
  const edited = await office({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'replace_text', slide: 2, find: '12%', replace: '15%' }],
  });
  assert.equal(edited.results[0].count, 2, 'the page and its speaker notes');
  const read = await office({ action: 'snapshot', session: created.session });
  const texts = read.document.slides.map((slide) => slide.shapes.map((shape) => shape.text).join(' '));
  assert.match(texts[0], /12%/);
  assert.match(texts[1], /15%/);
  assert.match(read.document.slides[1].notes, /15%/);
  await office({ action: 'close', session: created.session });
});
