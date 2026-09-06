import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyPdfDesign,
  expandOfficeDesignOperations,
  resolveOfficeDesign,
} from './design/design-system.mjs';
import { summarizeOfficeCompositions } from './design/composition-system.mjs';
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
import { workspace } from './office-test-support.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

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
    shapes: Array.from({ length: 6 }, (_, index) => ({ index: index + 1, type: 1, text: `항목 ${index + 1} 설명 문장입니다.`, font: { size: 14 } })),
  };
  assert.equal(isPptxStatementSlide(statement), true);
  assert.equal(isPptxStatementSlide(dense), false);
  assert.deepEqual(inferPptxSlideRoles({ slides: [{ index: 1, shapes: [] }, statement, dense] }), { 2: { slideRole: 'statement' } });
});

test('authored diagram slides are read from their native shapes so shape-filled fields are not judged empty', () => {
  // A cycle: four block arcs spanning the content field, labels inside, one connector.
  const diagram = {
    index: 4,
    shapes: [
      { index: 1, type: 'p:sp', geometry: 'rect', text: 'Cycle', font: { size: 32 }, left: 43, top: 72, width: 870, height: 60 },
      ...[0, 1, 2, 3].map((i) => ({ index: 2 + i, type: 'p:sp', geometry: 'blockArc', text: `Step ${i + 1}`, font: { size: 14 }, left: 200 + (i % 2) * 300, top: 150 + Math.floor(i / 2) * 170, width: 280, height: 160 })),
      { index: 6, type: 'p:cxnSp', text: '', left: 480, top: 300, width: 120, height: 0.5 },
    ],
  };
  // Text boxes only: the same count of shapes, none drawn.
  const text = {
    index: 5,
    shapes: Array.from({ length: 6 }, (_, i) => ({ index: i + 1, type: 'p:sp', geometry: 'rect', text: `Line ${i + 1}`, font: { size: 14 }, left: 43, top: 160 + i * 40, width: 870, height: 32 })),
  };
  // Shapes drawn, but in one small corner: a badge, not a diagram.
  const corner = {
    index: 6,
    shapes: [
      { index: 1, type: 'p:sp', geometry: 'rect', text: 'Title', font: { size: 20 }, left: 43, top: 72, width: 870, height: 60 },
      ...[0, 1, 2].map((i) => ({ index: 2 + i, type: 'p:sp', geometry: 'ellipse', text: '', left: 700 + i * 30, top: 400, width: 24, height: 24 })),
    ],
  };
  // A side picture with a short claim: few words, but the frame owns the slide.
  const pictureSide = {
    index: 7,
    shapes: [
      { index: 1, type: 'p:pic', text: '', left: 0, top: 0, width: 446, height: 540 },
      { index: 2, type: 'p:sp', geometry: 'rect', text: 'Night volume passed daytime', font: { size: 32 }, left: 490, top: 72, width: 420, height: 60 },
      { index: 3, type: 'p:sp', geometry: 'rect', text: 'Two more shuttles.', font: { size: 18 }, left: 490, top: 160, width: 420, height: 40 },
    ],
  };
  // A statement with a small inset picture stays a statement.
  const inset = {
    index: 8,
    shapes: [
      { index: 1, type: 'p:pic', text: '', left: 700, top: 380, width: 160, height: 100 },
      { index: 2, type: 'p:sp', geometry: 'rect', text: 'One claim in air', font: { size: 40 }, left: 43, top: 120, width: 600, height: 80 },
    ],
  };
  assert.equal(isPptxDiagramSlide(diagram), true);
  assert.equal(isPptxDiagramSlide(text), false);
  assert.equal(isPptxDiagramSlide(corner), false);
  assert.equal(isPptxPictureSlide(pictureSide), true);
  assert.equal(isPptxPictureSlide(inset), false);
  assert.deepEqual(
    inferPptxSlideRoles({ slideWidth: 960, slideHeight: 540, slides: [{ index: 1, shapes: [] }, diagram, text, corner, pictureSide, inset] }),
    { 4: { visualType: 'diagram' }, 7: { visualType: 'picture' }, 8: { slideRole: 'statement' } },
  );
});

// The decision panel sits to the right of the data; with a four-column table its Stop gate lands in column R
// while the dashboard canvas ends at L. Print and PDF export clip to the print area, so the area follows the panel.
test('a composed dashboard keeps its decision gates inside the print area', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [{
      op: 'compose_sheet',
      sheet: '결정',
      title: '도크 4 증설 결정',
      headers: ['안', '비용', '야간 대응', '판정'],
      rows: [['주간 전용', '낮음', '불가', '기각'], ['야간 전용', '중간', '가능', '채택']],
      metrics: [{ label: '처리량 증가', value: 1.6 }],
      decision: '야간 전용안을 10월 운영 회의에 올린다.',
      gates: [{ track: '야간 셔틀', release: '2대 증차 확정', stop: '증차 불가 시 보류' }],
    }],
    design: {},
  });
  const column = (label) => [...label].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
  const page = expanded.operations.find((entry) => entry.op === 'set_page_setup');
  const area = /^A1:([A-Z]+)(\d+)$/.exec(String(page.printArea));
  assert.ok(area, `unexpected print area ${page.printArea}`);
  const stop = expanded.operations.find((entry) => entry.op === 'set_cell' && entry.value === '증차 불가 시 보류');
  assert.ok(stop, 'the Stop gate is written');
  const merged = expanded.operations.find((entry) => entry.op === 'merge_cells' && entry.range.startsWith(`${stop.cell}:`));
  const gateEnd = /:([A-Z]+)\d+$/.exec(merged.range)[1];
  assert.ok(column(area[1]) >= column(gateEnd), `print area stops at column ${area[1]} but the Stop gate reaches ${gateEnd}`);
  assert.ok(Number(area[2]) >= Number(/\d+$/.exec(stop.cell)[0]), 'the print area reaches the gate rows');
  const autofit = expanded.operations.find((entry) => entry.op === 'autofit_range' && !entry.rows);
  assert.ok(column(autofit.range.split(':')[1]) >= column(gateEnd), 'the column autofit covers the panel');
});

test('a composed sheet keeps its chart inside the print area', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [{
      op: 'compose_sheet',
      sheet: 'Sheet1',
      title: 'Regional revenue',
      headers: ['Region', 'Revenue'],
      rows: [['Korea', 200], ['Japan', 210], ['US', 290]],
      chart: { title: 'Revenue' },
    }],
    design: {},
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  const page = expanded.operations.find((entry) => entry.op === 'set_page_setup');
  const area = /^A1:([A-Z]+)(\d+)$/.exec(String(page.printArea));
  assert.ok(area, `unexpected print area ${page.printArea}`);
  assert.equal(page.fitToContent, true);
  const endColumn = [...area[1]].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
  // Print and PDF export clip to the print area; a chart outside it disappears
  // from every exported copy while still looking correct on screen.
  assert.ok(
    endColumn * 48 >= chart.left + chart.width,
    `print area stops at column ${area[1]} but the chart reaches ${chart.left + chart.width}pt`,
  );
  assert.ok(
    Number(area[2]) * 15 >= chart.top + chart.height,
    `print area stops at row ${area[2]} but the chart reaches ${chart.top + chart.height}pt`,
  );
});

test('a wide composed dashboard keeps its chart clear of the data table', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'mixdog-ooxml',
    created: true,
    operations: [{
      op: 'compose_sheet',
      sheet: 'Dashboard',
      kind: 'dashboard',
      headers: ['Month', 'Revenue', 'Profit', 'Margin', 'Churn', 'NPS', 'Growth', 'Retention'],
      rows: [['January', 5000, 650, 0.13, 0.031, 49, 60, 55]],
      chart: { title: 'Performance', left: 440, width: 520 },
    }],
    design: {},
  });
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  const estimatedTableRight = 8 * 60;
  assert.ok(
    chart.top >= 300,
    `chart begins at ${chart.top}pt instead of moving below the ${estimatedTableRight}pt-wide table`,
  );
  assert.ok(
    chart.left + chart.width <= 960,
    'moving the chart must preserve the requested right edge and one-page scale',
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
      recentCompositions: [{
        ...summary,
        purpose: 'decide',
        expressionMode: 'strong-fit',
      }],
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
    [],
  );
});

test('PPTX review exempts the cover while a short deck still owes evidence', () => {
  const textOnly = (index) => ({
    index,
    background: { color: 'F5F2EC', followMaster: false, source: 'slide' },
    shapes: [{
      type: 17,
      text: `Slide ${index} carries only body copy`,
      left: 60,
      top: 80,
      width: 700,
      height: 90,
      font: { size: 20 },
    }],
  });
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: { slides: [textOnly(1), textOnly(2)] },
    design: { deck: { backgroundMode: 'custom' } },
  });
  assert.deepEqual(
    review.issues.filter((issue) => issue.code === 'meaningful_visual_missing').map((issue) => issue.path),
    ['/slide[2]'],
    'a cover never owes a chart, but the content slide of a two-slide deck still does',
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
  const failed = reviewPptxVisualCritique({
    pageCount: 1,
    critique: [entry(1, 'The focal visual remains too weak and needs a larger evidence area.', {
      verdict: 'needs-polish',
      balance: 2,
      fixes: ['Enlarge the evidence visual.'],
    })],
  });
  assert.ok(failed.issues.some((issue) => issue.code === 'visual_critique_needs_polish'));
  const anchor = reviewPptxVisualCritique({
    pageCount: 1,
    critique: [entry(1, 'A section anchor: one statement on a receded picture, no evidence by design.', { role: 'section', evidence: 2 })],
  });
  assert.equal(anchor.status, 'pass', 'an anchor is not gated on evidence');
  const anchorWeak = reviewPptxVisualCritique({
    pageCount: 1,
    critique: [entry(1, 'A section anchor whose statement does not read at thumbnail size on the picture.', { role: 'section', legibility: 2 })],
  });
  assert.ok(anchorWeak.issues.some((issue) => issue.code === 'visual_critique_needs_polish'), 'the other axes still gate an anchor');
  assert.equal(pptxVisualReviewAcknowledged({
    reviewed: true,
    providedToken: 'office_1:2',
    expectedToken: 'office_1:2',
    renderedVersion: 2,
    snapshotVersion: 2,
    critiqueOk: true,
  }), true);
  assert.equal(pptxVisualReviewAcknowledged({
    reviewed: true,
    providedToken: 'office_1:1',
    expectedToken: 'office_1:2',
    renderedVersion: 2,
    snapshotVersion: 2,
    critiqueOk: true,
  }), false);
  assert.equal(pptxVisualReviewAcknowledged({
    reviewed: true,
    providedToken: 'office_1:2',
    expectedToken: 'office_1:2',
    renderedVersion: 1,
    snapshotVersion: 2,
    critiqueOk: true,
  }), false);
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
    layouts: [{
      id: `statement-${version.replaceAll('.', '-')}`,
      format: 'pptx',
      kind: 'statement',
      profile: 'brand',
      defaults: { titleSize: 42 },
    }],
    templates: [],
  });
  const envelopeFor = (pack, signingKey = privateKey) => ({
    schemaVersion: 1,
    keyId: 'test-key',
    pack,
    signature: signBytes(
      null,
      Buffer.from(canonicalOfficeDesignPack(pack)),
      signingKey,
    ).toString('base64'),
  });
  let envelope = envelopeFor(makePack('1.0.0', 'C43E2F'));
  const fetchImpl = async () => new Response(JSON.stringify(envelope), {
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

test('local Office template indexing detects changes without rebinding existing documents', async (t) => {
  const cwd = await workspace(t);
  const dataDir = join(cwd, 'design-library-data');
  const templates = join(cwd, 'templates');
  const template = join(templates, 'brand.pptx');
  await mkdir(templates, { recursive: true });
  await writeFile(template, Buffer.from('template-v1'));
  await writeFile(`${template}.mixdog.json`, JSON.stringify({
    id: 'brand-deck',
    label: 'Brand Deck',
    layouts: [{
      id: 'brand-statement',
      format: 'pptx',
      kind: 'statement',
      defaults: { titleSize: 44 },
    }],
  }));
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
    operations: [{
      op: 'compose_document',
      title: 'Decision brief',
      subtitle: 'Prepared for review',
      sections: [{
        heading: 'Recommendation',
        paragraphs: ['Adopt semantic composition.'],
        bullets: ['Preserve native styles.'],
        table: [['Owner', 'Status'], ['Mixdog', 'Ready']],
      }],
      footer: 'Source: operating model',
      pageNumbers: true,
    }],
  });
  assert.ok(word.operations.some((operation) => operation.op === 'set_page'));
  assert.ok(word.operations.some((operation) => operation.op === 'append_text' && operation.properties.listKind === 'bullet'));
  assert.ok(word.operations.some((operation) => operation.op === 'set_table_cell_style'));
  assert.ok(word.operations.some((operation) => (
    operation.op === 'add_page_numbers'
    && operation.alignment === 'center'
    && operation.prefix === 'Source: operating model · Page '
  )));
  assert.ok(!word.operations.some((operation) => operation.op === 'set_header_footer'));
  const workbook = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [{
      op: 'compose_sheet',
      sheet: 'Summary',
      title: 'Operating summary',
      headers: ['Metric', 'Value'],
      rows: [['Calls', 3], ['Accuracy', 1]],
    }],
  });
  assert.ok(workbook.operations.some((operation) => operation.op === 'merge_cells'));
  assert.ok(workbook.operations.some((operation) => operation.op === 'add_table'));
  assert.ok(workbook.operations.some((operation) => operation.op === 'autofit_range'));
  const pdf = applyPdfDesign([
    { type: 'heading', text: 'Report' },
    { type: 'table', rows: [['Metric', 'Value'], ['Calls', '3']] },
  ], { profile: 'data' });
  assert.equal(pdf.blocks[0].color, '1F2933');
  assert.equal(pdf.blocks[1].headerFill, '183028');
});

test('Office design review rejects decorative stripes and repeated card grids', () => {
  const cardSlide = (index) => ({
    index,
    shapes: [
      { type: 17, text: `Slide ${index}`, left: 50, top: 40, width: 800, height: 50, font: { size: 34 } },
      { type: 1, text: 'Card A explains the first pillar in a sentence.', left: 60, top: 160, width: 240, height: 120 },
      { type: 1, text: 'Card B explains the second pillar in a sentence.', left: 330, top: 160, width: 240, height: 120 },
      { type: 1, text: 'Card C explains the third pillar in a sentence.', left: 600, top: 160, width: 240, height: 120 },
      { type: 1, text: '', left: 40, top: 90, width: 7, height: 340 },
    ],
  });
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: { slides: [cardSlide(1), cardSlide(2), cardSlide(3), cardSlide(4), cardSlide(5), cardSlide(6)] },
    design: { profile: 'editorial' },
  });
  assert.equal(review.status, 'needs-polish');
  assert.ok(review.issues.some((issue) => issue.code === 'decorative_stripe'));
  assert.ok(review.issues.some((issue) => issue.code === 'card_grid_overuse'));
  assert.ok(review.issues.some((issue) => issue.code === 'repetitive_composition'));
});

test('Office design review judges an authored deck by its own ladder and geometry', () => {
  const title = (index) => ({ type: 17, text: `Slide ${index}`, left: 43, top: 72, width: 800, height: 50, font: { size: 32 } });
  const heroBand = (index) => ({
    index,
    background: { color: 'F9F4F1' },
    shapes: [
      title(index),
      ...[0, 1, 2, 3].map((column) => ({ type: 1, text: String(40 + column), left: 43 + column * 220, top: 173, width: 200, height: 80, font: { size: 56 } })),
      { type: 1, text: '', left: 43, top: 306, width: 873, height: 1 },     // hairline between rows
      ...[0, 1, 2, 3].map((column) => ({ type: 1, text: 'One line of context under the number.', left: 43 + column * 220, top: 324, width: 195, height: 90 })),
    ],
  });
  const steps = (index) => ({
    index,
    background: { color: 'F9F4F1' },
    shapes: [
      title(index),
      ...[0, 1, 2, 3, 4].map((step) => ({ type: 1, text: `Stage ${step} with a short note under the lead.`, left: 43 + step * 176, top: 389 - step * 61, width: 158, height: 94 })),
    ],
  });
  const review = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        { index: 1, background: { color: '1F1512' }, shapes: [{ type: 17, text: 'Cover', left: 43, top: 180, width: 600, height: 120, font: { size: 44 } }] },
        heroBand(2),
        steps(3),
        { index: 4, background: { color: '1F1512' }, shapes: [title(4), { type: 1, text: '97%', left: 130, top: 260, width: 230, height: 60, font: { size: 40 } }] },
        heroBand(5),
        { index: 6, background: { color: '1F1512' }, shapes: [{ type: 17, text: 'Closing', left: 43, top: 180, width: 600, height: 120, font: { size: 36 } }] },
      ],
    },
    design: { profile: 'editorial' },
  });
  const codes = new Set(review.issues.map((issue) => issue.code));
  assert.equal(codes.has('theme_background_drift'), false);
  assert.equal(codes.has('decorative_stripe'), false);
  assert.equal(codes.has('card_grid_overuse'), false);
  const edgeStripe = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        { index: 1, background: { color: '1F1512' }, shapes: [] },
        { index: 2, background: { color: 'F9F4F1' }, shapes: [title(2), { type: 1, text: '', left: 0, top: 0, width: 960, height: 6 }] },
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
        { index: 2, background: { color: 'F9F4F1' }, shapes: [title(2), { type: 1, text: '0', left: 660, top: 210, width: 250, height: 80, font: { size: 65 } }, { type: 1, text: '', left: 80, top: 288, width: 540, height: 0 }] },
        { index: 3, background: { color: '1F1512' }, shapes: [] },
      ],
    },
    design: { profile: 'editorial' },
  });
  assert.equal(beside.issues.some((issue) => issue.code === 'decorative_stripe'), false);
  const underline = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        { index: 1, background: { color: '1F1512' }, shapes: [] },
        { index: 2, background: { color: 'F9F4F1' }, shapes: [title(2), { type: 1, text: '', left: 43, top: 130, width: 540, height: 2 }] },
        { index: 3, background: { color: '1F1512' }, shapes: [] },
      ],
    },
    design: { profile: 'editorial' },
  });
  assert.ok(underline.issues.some((issue) => issue.code === 'decorative_stripe'), 'a rule under the title is still an underline');
});
