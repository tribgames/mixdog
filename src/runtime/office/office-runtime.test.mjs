import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import {
  officeBenchmarkSnapshotRequest,
  officeBenchmarkVisualPolicy,
} from './benchmark.mjs';
import {
  assertOfficeOperationContracts,
  describeOfficeCapabilities,
  OFFICE_ACTIONS,
} from './capabilities.mjs';
import { runOfficeContractBenchmark } from './contract-benchmark.mjs';
import { resolveMicrosoftOfficeHostScriptPath } from './com-adapter.mjs';
import { executeOfficeTool, resetOfficeSessionsForTest } from './index.mjs';
import { createOfficeSnapshotRequest, finalizeOfficeSnapshotPage } from './pagination.mjs';
import { recalculateLibreOfficeWorkbook } from './portable-ooxml.mjs';
import { renderPdfPages } from './pdf-render.mjs';
import {
  inferPdfTables,
  parseOcrBlocks,
  parseOcrTsv,
} from './pdf-analysis.mjs';
import {
  classifyOoxmlValidationErrors,
  ensureOoxmlValidator,
  ooxmlValidatorManifest,
} from './ooxml-validator.mjs';
import { TOOL_DEFS } from './tool-defs.mjs';
import { parseXlsxAutofitRange } from './xlsx-contract.mjs';
import {
  applyPdfDesign,
  expandOfficeDesignOperations,
  officeDesignCatalog,
  pptxVisualReviewAcknowledged,
  resolveOfficeDesign,
  reviewOfficeDesign,
  reviewPptxVisualCritique,
} from './design-system.mjs';
import { normalizePptxModelPlan } from './design-pptx-plan.mjs';
import { summarizeOfficeCompositions } from './composition-system.mjs';
import {
  canonicalOfficeDesignPack,
  createPptxSlideSelection,
  defaultOfficeTemplateDirectories,
  indexOfficeTemplates,
  inspectOfficeTemplate,
  persistOfficeDesignBinding,
  readOfficeCompositionHistory,
  recordOfficeCompositionHistory,
  resolveOfficeDesignLibrary,
  syncOfficeDesignLibrary,
} from './design-library.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

async function workspace(t) {
  const path = await mkdtemp(join(tmpdir(), 'mixdog-office-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(path, 'mixdog-data');
  t.after(async () => {
    resetOfficeSessionsForTest();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

function value(result) {
  assert.equal(result?.isError, undefined, result?.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function writeZip(path, entries) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function unicodeFontPath() {
  const candidates = [
    process.env.WINDIR ? join(process.env.WINDIR, 'Fonts', 'malgun.ttf') : '',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return '';
}

test('office is a first-class built-in tool with stateful document actions', () => {
  assert.equal(TOOL_DEFS.length, 1);
  assert.equal(TOOL_DEFS[0].name, 'office');
  assert.deepEqual(
    TOOL_DEFS[0].inputSchema.properties.action.enum,
    OFFICE_ACTIONS,
  );
  for (const removed of ['set', 'add', 'remove', 'move']) {
    assert.equal(TOOL_DEFS[0].inputSchema.properties.action.enum.includes(removed), false);
  }
  for (const removed of ['type', 'text', 'value', 'values', 'formula', 'to', 'index']) {
    assert.equal(Object.hasOwn(TOOL_DEFS[0].inputSchema.properties, removed), false);
  }
  assert.match(TOOL_DEFS[0].description, /\bsecure\b/);
  assert.match(TOOL_DEFS[0].description, /Direct:/);
  assert.match(TOOL_DEFS[0].description, /finalize:true/);
  assert.match(TOOL_DEFS[0].description, /all known operations in one ordered array/);
  assert.match(TOOL_DEFS[0].description, /Inspect unfamiliar existing files first/);
  assert.match(TOOL_DEFS[0].description, /no snapshot unless/);
  assert.match(TOOL_DEFS[0].description, /Describe only unknown/);
  const deferredLead = TOOL_DEFS[0].description.slice(0, 220);
  assert.match(deferredLead, /finalize:true/);
  assert.match(deferredLead, /XLSX\/CSV\/TSV set_range/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.action.description, /\bsecure\b/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.operations.description, /every operation whose inputs are known/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.operations.description, /Call describe only when/);
  assert.equal(TOOL_DEFS[0].inputSchema.properties.finalize.type, 'boolean');
  assert.match(TOOL_DEFS[0].inputSchema.properties.review.description, /Keep enabled for deliverables/);
  assert.ok(TOOL_DEFS[0].inputSchema.properties.mode.enum.includes('visible'));
  assert.ok(TOOL_DEFS[0].inputSchema.properties.mode.enum.includes('attach'));
  assert.match(TOOL_DEFS[0].inputSchema.properties.mode.description, /auto defaults to background/);
  assert.match(TOOL_DEFS[0].inputSchema.properties.mode.description, /Only explicit attach/);
  assert.equal(TOOL_DEFS[0].inputSchema.properties.requireChanges.type, 'boolean');
  assert.deepEqual(TOOL_DEFS[0].inputSchema.properties.failOn.enum, ['error', 'warning']);
  const descriptionChars = [
    TOOL_DEFS[0].description,
    ...Object.values(TOOL_DEFS[0].inputSchema.properties).map((property) => property.description || ''),
  ].reduce((total, description) => total + description.length, 0);
  assert.ok(descriptionChars <= 5000, `Office schema descriptions grew to ${descriptionChars} characters`);
  assert.ok(JSON.stringify(TOOL_DEFS[0].inputSchema).length <= 7000, 'Office input schema exceeded its size budget');
});

test('Office design profiles expose semantic composition without decorative defaults', () => {
  assert.deepEqual(officeDesignCatalog('pptx').map((entry) => entry.id), ['executive', 'editorial', 'technical', 'data']);
  const design = resolveOfficeDesign('pptx', {
    profile: 'technical',
    intent: 'Explain an Office runtime optimization',
    audience: 'product and engineering leaders',
    palette: { accent: '#00A896' },
    signature: 'large operation traces',
  });
  assert.equal(design.tokens.colors.accent, '00A896');
  assert.equal(design.intent, 'Explain an Office runtime optimization');
  assert.equal(design.deck.backgroundMode, 'sandwich');
  assert.equal(design.deck.roles.content, 'canvas');
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [
      {
        op: 'compose_slide',
        kind: 'cover',
        title: 'One clear argument',
        subtitle: 'A designed report',
        plan: {
          visualType: 'statement',
          regions: [
            { id: 'message', role: 'title', x: 6, y: 22, w: 70, h: 28 },
            { id: 'support', role: 'subtitle', x: 6, y: 60, w: 62, h: 12 },
          ],
        },
      },
      {
        op: 'compose_slide',
        kind: 'metrics',
        title: 'The result',
        metrics: [
          { value: '22 → 3', label: 'calls' },
          { value: '−44.6%', label: 'runtime' },
          { value: '100%', label: 'accuracy' },
        ],
        plan: {
          visualType: 'metrics',
          regions: [
            { id: 'message', role: 'title', x: 6, y: 7, w: 84, h: 14 },
            { id: 'evidence', role: 'metrics', x: 6, y: 30, w: 88, h: 56, direction: 'row' },
          ],
        },
      },
    ],
    design,
  });
  assert.deepEqual(expanded.semantic.map((entry) => entry.kind), ['cover', 'metrics']);
  assert.deepEqual(expanded.semantic.map((entry) => entry.backgroundRole), ['inverse', 'canvas']);
  assert.deepEqual(expanded.semantic.map((entry) => entry.plan.visualType), ['statement', 'metrics']);
  assert.equal(expanded.semantic[1].plan.message, 'The result');
  assert.deepEqual(expanded.semantic[1].plan.evidence, ['22 → 3', '−44.6%', '100%']);
  assert.equal(expanded.operations.filter((operation) => operation.op === 'add_slide').length, 2);
  assert.equal(expanded.operations.some((operation) => {
    if (operation.op !== 'add_shape') return false;
    const width = Number(operation.properties?.width) || 0;
    const height = Number(operation.properties?.height) || 0;
    return (width <= 14 && height >= 180) || (height <= 7 && width >= 320);
  }), false);
});

test('model-first PPTX rendering enforces readable type and internal component spacing', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [{
      op: 'compose_slide',
      kind: 'process',
      title: 'One decision with readable evidence',
      meta: ['July review'],
      metrics: [{
        value: '1.8억',
        label: '승인 요청',
        detail: '두 트랙 합계',
      }],
      steps: [
        { title: 'Owner 확정', detail: '책임 지정' },
        { title: 'Gate 판정', detail: 'release / stop' },
      ],
      plan: {
        regions: [
          { id: 'message', role: 'title', x: 6, y: 5, w: 88, h: 12 },
          { id: 'context', role: 'meta', x: 6, y: 20, w: 32, h: 6, style: { fontSize: 8 } },
          {
            id: 'metric',
            role: 'metric',
            x: 6,
            y: 32,
            w: 28,
            h: 50,
            style: { labelSize: 8, detailSize: 8 },
          },
          { id: 'process', role: 'process', x: 42, y: 30, w: 52, h: 54 },
        ],
      },
    }, {
      op: 'compose_slide',
      kind: 'closing',
      title: 'Approve the next move',
      visualText: 'GO',
      visualLabel: '승인',
      plan: {
        regions: [
          { id: 'message', role: 'title', x: 7, y: 18, w: 56, h: 28 },
          { id: 'decision', role: 'visual', x: 72, y: 28, w: 20, h: 38 },
        ],
      },
    }],
  });
  const textboxes = expanded.operations.filter((operation) => operation.op === 'add_textbox');
  const fontSizes = textboxes.flatMap((operation) => [
    operation.properties?.fontSize,
    ...(operation.paragraphs || []).map((paragraph) => paragraph.fontSize),
  ]).filter((fontSize) => Number.isFinite(Number(fontSize)));
  assert.ok(fontSizes.length > 0);
  assert.ok(fontSizes.every((fontSize) => Number(fontSize) >= 12), JSON.stringify(fontSizes));

  const metricValue = textboxes.find((operation) => operation.text === '1.8억');
  const metricLabel = textboxes.find((operation) => operation.text === '승인 요청');
  const metricDetail = textboxes.find((operation) => operation.text === '두 트랙 합계');
  assert.ok(metricLabel.properties.top - (metricValue.properties.top + metricValue.properties.height) >= 8);
  assert.ok(metricDetail.properties.top - (metricLabel.properties.top + metricLabel.properties.height) >= 8);

  for (const [title, detail] of [['Owner 확정', '책임 지정'], ['Gate 판정', 'release / stop']]) {
    const titleBox = textboxes.find((operation) => operation.text === title);
    const detailBox = textboxes.find((operation) => operation.text === detail);
    assert.ok(detailBox.properties.top - (titleBox.properties.top + titleBox.properties.height) >= 8);
  }
  const visualText = textboxes.find((operation) => operation.text === 'GO');
  const visualLabel = textboxes.find((operation) => operation.text === '승인');
  assert.ok(visualLabel.properties.top - (visualText.properties.top + visualText.properties.height) >= 8);
});

test('model-first PPTX plans preserve authored geometry, repair safe bounds, and never use template fallback', () => {
  const first = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    design: { purpose: 'explain' },
    operations: [{
      op: 'compose_slide',
      kind: 'chart',
      title: 'Demand moved ahead of capacity',
      body: ['Backlog growth is concentrated in one queue.'],
      chart: {
        categories: ['Jan', 'Feb', 'Mar'],
        series: [{ name: 'Backlog', values: [20, 31, 48] }],
      },
      plan: {
        name: 'commentary-left-chart-right',
        rationale: 'Keep the operational claim beside its native evidence.',
        regions: [
          { id: 'message', role: 'title', x: -2, y: 1, w: 54, h: 13 },
          { id: 'support', role: 'body', x: 6, y: 30, w: 27, h: 42 },
          { id: 'evidence', role: 'chart', x: 39, y: 25, w: 61, h: 68 },
        ],
        readingOrder: ['message', 'support', 'evidence'],
      },
    }],
  });
  const chart = first.operations.find((operation) => operation.op === 'add_chart');
  assert.equal(first.semantic[0].renderMode, 'model-plan');
  assert.equal(first.semantic[0].plan.source, 'model');
  assert.equal(first.semantic[0].plan.repairs.some((repair) => repair.type === 'bounds'), true);
  assert.equal(first.operations.some((operation) => operation.op === 'import_slides'), false);
  assert.ok(chart.left >= 360 && chart.width >= 500, JSON.stringify(chart));

  const second = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [{
      op: 'compose_slide',
      kind: 'chart',
      title: 'Demand moved ahead of capacity',
      chart: {
        categories: ['Jan', 'Feb', 'Mar'],
        series: [{ name: 'Backlog', values: [20, 31, 48] }],
      },
      plan: {
        name: 'chart-led-bottom-message',
        regions: [
          { id: 'evidence', role: 'chart', x: 6, y: 8, w: 88, h: 60 },
          { id: 'message', role: 'title', x: 6, y: 76, w: 88, h: 14 },
        ],
        readingOrder: ['evidence', 'message'],
      },
    }],
  });
  assert.notEqual(first.semantic[0].composition.id, second.semantic[0].composition.id);
  assert.throws(() => expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [{ op: 'compose_slide', kind: 'cover', title: 'Missing plan' }],
  }), /MODEL_COMPOSITION_PLAN_REQUIRED.*No template fallback was applied/);
  assert.throws(() => normalizePptxModelPlan({
    kind: 'chart',
    title: 'Broken geometry',
    chart: { series: [] },
    plan: {
      regions: [
        { id: 'message', role: 'title', x: 5, y: 5, w: 85, h: 34 },
        { id: 'evidence', role: 'chart', x: 8, y: 8, w: 85, h: 82 },
      ],
    },
  }, resolveOfficeDesign('pptx', {}), 2), /MODEL_COMPOSITION_PLAN_OVERLAP.*No template fallback was applied/);
});

test('purpose-aware composition varies structure from content topology and recent output history', () => {
  const content = {
    packageId: 'composition-review',
    audience: 'executive committee',
    objective: 'decide the next investment',
    decision: 'approve the evidence-backed plan',
    facts: [{ id: 'revenue', label: 'Revenue', value: 120 }],
    claims: [{ id: 'decision', text: 'Approve the plan', factIds: ['revenue'] }],
  };
  const request = {
    purpose: 'decide',
    expressionMode: 'strong-fit',
    content,
  };
  const operation = {
    op: 'compose_document',
    title: 'Decision brief',
    summary: 'Approve the plan.',
    sections: [{
      heading: 'Evidence',
      paragraphs: ['Revenue supports the decision.'],
      table: [['Metric', 'Value'], ['Revenue', 120]],
    }],
  };
  const first = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'microsoft-office-com',
    created: true,
    design: request,
    operations: [operation],
  });
  const firstId = first.semantic[0].composition.id;
  const second = expandOfficeDesignOperations({
    format: 'docx',
    backend: 'microsoft-office-com',
    created: true,
    design: request,
    library: {
      source: 'mixdog-starter',
      recentCompositions: [{
        fingerprint: 'recent',
        format: 'docx',
        compositionIds: [firstId],
      }],
    },
    operations: [operation],
  });
  assert.notEqual(second.semantic[0].composition.id, firstId);
  assert.equal(first.design.purpose, 'decide');
  assert.equal(first.design.expressionMode, 'strong-fit');
  assert.equal(first.operations.some((entry) => entry.properties?.border?.side === 'left'), false);

  const deck = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    design: { purpose: 'monitor', expressionMode: 'strong-fit', deck: { compositionMode: 'legacy' } },
    operations: [{
      op: 'compose_slide',
      kind: 'content',
      title: 'Revenue is accelerating',
      chart: {
        categories: ['May', 'June', 'July'],
        series: [{ name: 'Revenue', values: [100, 110, 120] }],
      },
    }],
  });
  assert.equal(deck.semantic[0].requestedKind, 'content');
  assert.equal(deck.semantic[0].kind, 'chart');
  assert.equal(deck.semantic[0].composition.variant, 'chart-led');
  assert.equal(deck.operations.find((entry) => entry.op === 'add_chart').left, 318);
  assert.equal(deck.operations.find((entry) => entry.op === 'add_chart').width, 582);

  const workbook = expandOfficeDesignOperations({
    format: 'xlsx',
    backend: 'microsoft-office-com',
    created: true,
    design: { purpose: 'monitor' },
    operations: [{
      op: 'compose_sheet',
      variant: 'trend-dashboard',
      title: 'Monthly trend',
      headers: ['Month', 'Revenue'],
      rows: [['May', 100], ['June', 110], ['July', 120]],
      chart: { title: 'Revenue' },
    }],
  });
  assert.equal(workbook.semantic[0].composition.id, 'trend-dashboard');
  assert.equal(workbook.operations.find((entry) => entry.op === 'add_chart').left, 360);
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

test('scratch slides keep a fourth metric inside the slide and retain explicit statement visuals', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    design: { deck: { templateMode: 'scratch', compositionMode: 'legacy' } },
    operations: [
      {
        op: 'compose_slide',
        kind: 'metrics',
        variant: 'stacked',
        title: 'Four metrics',
        subtitle: 'Financial capacity is confirmed',
        metrics: [
          { label: 'Revenue', value: 120, detail: 'Revenue detail' },
          { label: 'Profit', value: 32, detail: 'Profit detail' },
          { label: 'Churn', value: 0.02, detail: 'Churn detail' },
          { label: 'NPS', value: 61, detail: 'NPS detail' },
        ],
      },
      {
        op: 'compose_slide',
        kind: 'statement',
        variant: 'typographic-statement',
        title: 'Stop threshold',
        metrics: [{ label: 'Margin stop', value: 13.5, unit: '%' }],
      },
      {
        op: 'compose_slide',
        kind: 'process',
        title: 'Four bounded steps',
        steps: [
          { title: 'Owner', detail: 'Assign ownership' },
          { title: 'Signal', detail: 'Inspect leading indicators' },
          { title: 'Reallocate', detail: 'Move the budget' },
          { title: 'Gate', detail: 'Make the decision' },
        ],
      },
    ],
  });
  const fourthDetail = expanded.operations.find((operation) => operation.text === 'NPS detail');
  assert.ok(fourthDetail);
  assert.ok(
    fourthDetail.properties.top + fourthDetail.properties.height <= 522,
    'the fourth metric detail must preserve the 18pt bottom safe margin',
  );
  const secondaryDetails = ['Profit detail', 'Churn detail']
    .map((text) => expanded.operations.find((operation) => operation.text === text));
  const followingValues = ['0.02', '61']
    .map((text) => expanded.operations.find((operation) => operation.text === text));
  const subtitle = expanded.operations.find((operation) => operation.text === 'Financial capacity is confirmed');
  const firstSecondaryValue = expanded.operations.find((operation) => operation.text === '32');
  assert.ok(subtitle);
  assert.ok(firstSecondaryValue);
  assert.ok(
    subtitle.properties.top + subtitle.properties.height + 6 <= firstSecondaryValue.properties.top,
    'the subtitle and first metric must preserve at least 6pt vertical spacing',
  );
  const firstSecondaryLabel = expanded.operations.find((operation) => operation.text === 'Profit');
  const firstSecondaryDetail = expanded.operations.find((operation) => operation.text === 'Profit detail');
  assert.ok(firstSecondaryLabel);
  assert.ok(firstSecondaryDetail);
  assert.ok(
    firstSecondaryValue.properties.top + firstSecondaryValue.properties.height + 6
      <= firstSecondaryLabel.properties.top,
    'the metric value and label must preserve at least 6pt vertical spacing',
  );
  assert.ok(
    firstSecondaryLabel.properties.top + firstSecondaryLabel.properties.height + 6
      <= firstSecondaryDetail.properties.top,
    'the metric label and detail must preserve at least 6pt vertical spacing',
  );
  secondaryDetails.forEach((detail, index) => {
    assert.ok(detail);
    assert.ok(followingValues[index]);
    assert.ok(
      detail.properties.top + detail.properties.height + 6 <= followingValues[index].properties.top,
      'adjacent metric text boxes must preserve at least 6pt vertical spacing',
    );
  });
  assert.ok(
    expanded.operations.some((operation) => (
      operation.slide === 2
      && operation.op === 'add_shape'
      && operation.shapeType === 'rounded_rectangle'
    )),
    'an explicit statement metric must remain a visual even in a typographic composition',
  );
  assert.ok(
    expanded.operations.some((operation) => (
      operation.slide === 2
      && operation.text === 'PRIMARY SIGNAL'
    )),
    'the statement visual must explain why the metric matters',
  );
  const processCards = expanded.operations.filter((operation) => (
    operation.slide === 3
    && operation.op === 'add_shape'
    && operation.shapeType === 'rounded_rectangle'
  ));
  assert.equal(processCards.length, 4);
  processCards.forEach((card) => {
    assert.ok(card.properties.left >= 58);
    assert.ok(card.properties.left + card.properties.width <= 902);
  });
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

test('native Office templates expose sample-slide slots and drive strict template-first composition', async (t) => {
  const cwd = await workspace(t);
  const templates = join(cwd, 'templates');
  const template = join(templates, 'executive.potx');
  await mkdir(templates, { recursive: true });
  const textShape = (id, name, text, placeholder = '') => `
    <p:sp>
      <p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${placeholder ? `<p:ph type="${placeholder}"/>` : ''}</p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>
    </p:sp>`;
  const slide = (body) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
  await writeZip(template, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="300" r:id="rId7"/><p:sldId id="256" r:id="rId3"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="slides/slide1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Id="rId3"/><Relationship Id="rId7" Target="slides/slide2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>',
    'ppt/slides/slide2.xml': slide([
      textShape(1, 'Title', '{{TITLE}}', 'title'),
      textShape(2, 'Subtitle', '{{SUBTITLE}}', 'subTitle'),
    ].join('')),
    'ppt/slides/slide1.xml': slide([
      textShape(1, 'Title', '{{TITLE}}', 'title'),
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Chart"/></p:nvGraphicFramePr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm><a:graphic><a:graphicData><c:chart/></a:graphicData></a:graphic></p:graphicFrame>',
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/></p:nvGraphicFramePr><a:xfrm><a:off x="500" y="200"/><a:ext cx="300" cy="400"/></a:xfrm><a:graphic><a:graphicData><a:tbl/></a:graphicData></a:graphic></p:graphicFrame>',
    ].join('')),
    'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="title"><p:cSld name="Executive title"><p:spTree/></p:cSld></p:sldLayout>',
    'ppt/theme/theme1.xml': '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Executive"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>',
  });
  await writeFile(`${template}.mixdog.json`, JSON.stringify({
    id: 'executive-native',
    label: 'Executive Native',
    profile: 'editorial',
    samples: [
      { slide: 1, id: 'executive-cover', kind: 'cover', density: 'light', strict: true, defaults: { background: '16191D' }, roles: { 1: 'title', 2: 'subtitle' } },
      { slide: 2, id: 'executive-metrics', kind: 'metrics', density: 'light', strict: true, roles: { 1: 'title', 2: 'chart', 3: 'table' } },
    ],
  }));
  await cp(template, join(templates, 'executive.mixdog-edit.pptx'));

  const inspected = await inspectOfficeTemplate(template, { format: 'pptx' });
  assert.equal(inspected.sampleSlides.length, 2);
  assert.deepEqual(inspected.sampleSlides.map((entry) => entry.part), [2, 1]);
  assert.deepEqual(inspected.sampleSlides[0].slots.map((slot) => slot.role), ['title', 'subtitle']);
  assert.ok(inspected.sampleSlides[1].capabilities.includes('chart'));
  assert.equal(inspected.nativeLayouts[0].name, 'Executive title');
  assert.deepEqual(inspected.theme.fonts, ['Georgia', 'Arial']);
  const selectedTemplate = join(templates, 'selected.mixdog-edit.pptx');
  await createPptxSlideSelection(template, [1, 2, 1], selectedTemplate);
  const selectedInspection = await inspectOfficeTemplate(selectedTemplate, { format: 'pptx' });
  assert.deepEqual(selectedInspection.sampleSlides.map((entry) => entry.part), [1, 2, 3]);
  assert.deepEqual(
    selectedInspection.sampleSlides.map((entry) => entry.capabilities),
    [[], ['chart', 'table'], []],
  );

  const config = {
    templateDirectories: [templates],
    discoverInstalledTemplates: false,
    defaultTemplates: { pptx: 'executive-native' },
  };
  const indexed = await indexOfficeTemplates({ dataDir: join(cwd, 'data'), config });
  assert.equal(indexed.count, 1);
  assert.equal(indexed.templates[0].sampleSlides.length, 2);
  assert.equal(indexed.templates[0].layouts[0].slots[0].role, 'title');
  const library = await resolveOfficeDesignLibrary({
    dataDir: join(cwd, 'data'),
    documentPath: join(cwd, 'output.pptx'),
    format: 'pptx',
    created: true,
    request: { template: 'executive-native', profile: 'editorial' },
    config,
  });
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    design: {
      template: 'executive-native',
      profile: 'editorial',
      density: 'light',
      deck: { templateMode: 'strict' },
    },
    library,
    operations: [{
      op: 'compose_slide',
      kind: 'cover',
      title: 'One native argument',
      subtitle: 'Preserve the approved source formatting',
    }],
  });
  assert.equal(expanded.operations[0].op, 'import_slides');
  assert.equal(expanded.operations[0].path, template);
  assert.deepEqual(expanded.operations[1], { op: 'set_slide_background', slide: 1, color: '16191D' });
  assert.deepEqual(
    expanded.operations.filter((operation) => operation.op === 'set_text').map((operation) => operation.text),
    ['One native argument', 'Preserve the approved source formatting'],
  );
  assert.equal(expanded.semantic[0].renderMode, 'native-template');
  const scratchExpanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    design: {
      template: 'executive-native',
      profile: 'editorial',
      density: 'light',
      deck: { templateMode: 'scratch', compositionMode: 'legacy' },
    },
    library,
    operations: [{
      op: 'compose_slide',
      kind: 'metrics',
      title: 'All four metrics',
      metrics: [
        { label: 'Revenue', value: 120 },
        { label: 'Profit', value: 32 },
        { label: 'Churn', value: 0.02 },
        { label: 'NPS', value: 61 },
      ],
    }],
  });
  assert.equal(scratchExpanded.operations.some((operation) => operation.op === 'import_slides'), false);
  assert.equal(scratchExpanded.operations.some((operation) => operation.op === 'add_slide'), true);
  assert.equal(scratchExpanded.semantic[0].renderMode, 'legacy-scratch');
  const tableExpanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    design: {
      template: 'executive-native',
      density: 'light',
      deck: { templateMode: 'strict' },
    },
    library,
    operations: [{
      op: 'compose_slide',
      kind: 'metrics',
      title: 'Native table',
      table: { values: [['Metric', 'Value'], ['Calls', '1']] },
      layoutId: 'executive-metrics',
    }],
  });
  assert.deepEqual(
    tableExpanded.operations.find((operation) => operation.op === 'set_table_data')?.values,
    [['Metric', 'Value'], ['Calls', '1']],
  );
  const coalesced = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    design: {
      template: 'executive-native',
      density: 'light',
      deck: { templateMode: 'strict' },
    },
    library,
    operations: [
      { op: 'compose_slide', kind: 'cover', layoutId: 'executive-cover', title: 'First' },
      { op: 'compose_slide', kind: 'metrics', layoutId: 'executive-metrics', title: 'Second' },
      { op: 'compose_slide', kind: 'cover', layoutId: 'executive-cover', title: 'Third' },
    ],
  });
  assert.deepEqual(
    coalesced.operations.filter((operation) => operation.op === 'import_slides'),
    [{ op: 'import_slides', path: template, slides: [1, 2, 1] }],
  );
  assert.throws(() => expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    design: { deck: { templateMode: 'strict' } },
    operations: [{ op: 'compose_slide', kind: 'cover', title: 'No fallback' }],
  }), /requires an explicit native template layout/);

  const discovered = defaultOfficeTemplateDirectories({
    platform: 'win32',
    environment: {
      ProgramFiles: 'C:\\Program Files',
      APPDATA: 'C:\\Users\\User\\AppData\\Roaming',
    },
    home: 'C:\\Users\\User',
  });
  assert.ok(discovered.some((entry) => entry.endsWith('Microsoft Office\\root\\Templates')));
  assert.ok(discovered.some((entry) => entry.endsWith('Microsoft\\Templates')));
});

test('PPTX deck plans enforce sandwich backgrounds while custom decks opt out', () => {
  const request = {
    profile: 'technical',
    signature: 'native operation traces',
    deck: { backgroundMode: 'sandwich' },
  };
  const design = resolveOfficeDesign('pptx', request);
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [
      {
        op: 'compose_slide',
        kind: 'cover',
        title: 'Cover',
        plan: { regions: [{ id: 'message', role: 'title', x: 6, y: 30, w: 80, h: 20 }] },
      },
      {
        op: 'compose_slide',
        kind: 'content',
        title: 'Body',
        plan: { regions: [{ id: 'message', role: 'title', x: 6, y: 8, w: 80, h: 16 }] },
      },
      {
        op: 'compose_slide',
        kind: 'closing',
        title: 'Close',
        plan: { regions: [{ id: 'message', role: 'title', x: 6, y: 30, w: 80, h: 20 }] },
      },
    ],
    design: request,
  });
  assert.deepEqual(
    expanded.operations.filter((operation) => operation.op === 'set_slide_background').map((operation) => operation.color),
    [design.tokens.colors.inverse, design.tokens.colors.canvas, design.tokens.colors.inverse],
  );
  const slide = (index, color) => ({
    index,
    background: { color, followMaster: false, source: 'slide' },
    shapes: [{ type: 17, text: `Slide ${index}`, left: 50, top: 40, width: 800, height: 80, font: { size: 42 } }],
  });
  const passing = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        slide(1, design.tokens.colors.inverse),
        slide(2, design.tokens.colors.canvas),
        slide(3, design.tokens.colors.inverse),
      ],
    },
    design: request,
  });
  assert.equal(passing.status, 'pass');
  const shortDeck = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        slide(1, design.tokens.colors.inverse),
        slide(2, design.tokens.colors.canvas),
      ],
    },
    design: request,
  });
  assert.equal(shortDeck.issues.some((issue) => issue.code === 'theme_background_drift'), false);
  const drifting = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        slide(1, design.tokens.colors.inverse),
        slide(2, '7A5CFF'),
        slide(3, design.tokens.colors.inverse),
      ],
    },
    design: request,
  });
  assert.ok(drifting.issues.some((issue) => issue.code === 'theme_background_drift'));
  const custom = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        slide(1, '111111'),
        slide(2, '7A5CFF'),
        slide(3, 'F5F2EC'),
      ],
    },
    design: { ...request, deck: { backgroundMode: 'custom' } },
  });
  assert.equal(custom.issues.some((issue) => issue.code.startsWith('theme_')), false);
  const semanticProcess = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        slide(1, design.tokens.colors.inverse),
        {
          ...slide(2, design.tokens.colors.canvas),
          shapes: [
            { type: 17, text: 'Frame → Select → Compose → Prove', font: { size: 24 } },
            { type: 1, text: '', left: 80, top: 220, width: 700, height: 60 },
          ],
        },
        slide(3, design.tokens.colors.inverse),
      ],
    },
    design: {
      ...request,
      slidePlans: [{ slide: 2, visualType: 'process' }],
    },
  });
  assert.equal(semanticProcess.issues.some((issue) => issue.code === 'meaningful_visual_missing'), false);
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
  const composed = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [{
      op: 'compose_slide',
      kind: 'statement',
      title: 'Pinned model palette',
      plan: {
        regions: [{
          id: 'message',
          role: 'title',
          x: 8,
          y: 28,
          w: 76,
          h: 24,
          style: { colorRole: 'accent' },
        }],
      },
    }],
    design: {},
    library: secondLibrary,
  });
  assert.equal(composed.semantic[0].layout, undefined);
  assert.equal(composed.semantic[0].renderMode, 'model-plan');
  assert.equal(
    composed.operations.find((operation) => operation.op === 'add_textbox' && operation.text === 'Pinned model palette')?.properties?.color,
    '7C3AED',
  );

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
      { type: 1, text: 'A', left: 60, top: 160, width: 240, height: 120 },
      { type: 1, text: 'B', left: 330, top: 160, width: 240, height: 120 },
      { type: 1, text: 'C', left: 600, top: 160, width: 240, height: 120 },
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

test('XLSX autofit accepts bounded cell, whole-column, and whole-row selectors', () => {
  assert.equal(parseXlsxAutofitRange('A1:D5').type, 'cells');
  assert.deepEqual(parseXlsxAutofitRange('A:D'), { type: 'columns', start: 1, end: 4 });
  assert.deepEqual(parseXlsxAutofitRange('2:8'), { type: 'rows', start: 2, end: 8 });
  assert.throws(() => parseXlsxAutofitRange('D:A'), /Invalid XLSX column range/);
});

test('create initial operations and finalize collapse a portable workflow into one call', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'workflow.csv');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'csv',
    operations: [
      { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], ['alpha', 1]] },
    ],
    finalize: true,
  }, { cwd }));
  assert.equal(created.document, undefined);
  assert.equal(created.batch.changeSummary.changed, 1);
  assert.equal(created.finalized, true);
  assert.equal(created.failOn, 'warning');
  assert.equal(created.saved, true);
  assert.equal(created.saveSkipped, true);
  assert.equal(created.closed, true);
});

test('batch with finalize completes an inspected portable workflow in one remaining call', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'inspected.csv');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'csv',
  }, { cwd }));
  const completed = value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], ['alpha', 1]] },
    ],
    finalize: true,
  }, { cwd }));
  assert.equal(completed.batch.changeSummary.changed, 1);
  assert.equal(completed.finalized, true);
  assert.equal(completed.saveSkipped, true);
  assert.equal(completed.closed, true);
});

test('removed mutation actions remain rejected', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'removed-actions.csv');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'csv',
    operations: [
      { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], ['alpha', 1]] },
    ],
  }, { cwd }));
  for (const removed of ['set', 'add', 'remove', 'move']) {
    const rejected = await executeOfficeTool({
      action: removed,
      session: created.session,
    }, { cwd });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Unsupported Office Use action/);
  }
  const finalized = value(await executeOfficeTool({
    action: 'finalize',
    session: created.session,
    review: false,
  }, { cwd }));
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.failOn, 'warning');
  assert.equal(finalized.saved, true);
  assert.equal(finalized.closed, true);
});

test('persistent Office validation inspects the open document with bounded Excel busy retries', async () => {
  const source = await readFile(new URL('./office-com-session-host.ps1', import.meta.url), 'utf8');
  const start = source.indexOf("'validate' {");
  const end = source.indexOf("'checkpoint' {", start);
  const validation = source.slice(start, end);
  assert.match(validation, /Snapshot-SessionDocument \$document/);
  assert.match(validation, /Issues-SessionDocument \$document/);
  assert.match(source, /Invoke-ExcelComRetry[\s\S]+Excel session snapshot/);
  assert.match(source, /Invoke-ExcelComRetry[\s\S]+Excel session issue inspection/);
  assert.doesNotMatch(validation, /Validate-NativeDocument/);
});

test('Office COM host resolves to the physical ASAR sidecar for external PowerShell', () => {
  const packaged = 'C:\\Program Files\\Mixdog\\resources\\runtime.asar\\node_modules\\mixdog\\src\\runtime\\office\\office-com-host.ps1';
  assert.equal(
    resolveMicrosoftOfficeHostScriptPath(packaged),
    'C:\\Program Files\\Mixdog\\resources\\runtime.asar.unpacked\\node_modules\\mixdog\\src\\runtime\\office\\office-com-host.ps1',
  );
  const development = 'C:\\Project\\mixdog\\src\\runtime\\office\\office-com-host.ps1';
  assert.equal(resolveMicrosoftOfficeHostScriptPath(development), development);
});

test('Office benchmark inherits adaptive cursor limits and separates large spreadsheet visuals', () => {
  assert.deepEqual(officeBenchmarkSnapshotRequest('office_1'), {
    action: 'snapshot',
    session: 'office_1',
    limit: 10000,
    maxChars: 100000,
  });
  assert.deepEqual(officeBenchmarkSnapshotRequest('office_1', 'cursor_1'), {
    action: 'snapshot',
    session: 'office_1',
    cursor: 'cursor_1',
    maxChars: 100000,
  });
  assert.deepEqual(officeBenchmarkVisualPolicy({ format: 'xlsx', totalCells: 50_000 }), { mode: 'full' });
  assert.equal(officeBenchmarkVisualPolicy({ format: 'xlsx', totalCells: 50_001 }).mode, 'performance-only');
  assert.deepEqual(officeBenchmarkVisualPolicy({ format: 'pptx', totalCells: 500_000 }), { mode: 'full' });
});

test('styled XLSX cursors keep their selector and cap detailed pages at 500 cells', () => {
  const session = { id: 'office_1', format: 'xlsx', snapshotVersion: 0 };
  const request = createOfficeSnapshotRequest(session, { includeStyles: true, includeSelection: true, limit: 10_000 });
  assert.equal(request.limit, 500);
  assert.equal(request.includeSelection, true);
  const document = { pagination: { nextOffset: 500 } };
  finalizeOfficeSnapshotPage(document, session, request);
  const continued = createOfficeSnapshotRequest(session, { cursor: document.pagination.nextCursor });
  assert.equal(continued.limit, 500);
  assert.equal(continued.includeStyles, true);
  assert.equal(continued.includeSelection, true);
});

test('describe exposes backend-aware advanced object operations', async () => {
  const summary = value(await executeOfficeTool({ action: 'describe' }));
  assert.equal(summary.formats.xlsx.operations, undefined);
  assert.ok(summary.formats.xlsx.operationCount > 0);
  assert.match(summary.nextAction, /When discovery is needed/);
  const described = value(await executeOfficeTool({ action: 'describe', format: 'xlsx' }));
  assert.match(described.nextAction, /If exact fields are unknown/);
  for (const action of ['create', 'attach', 'secure']) assert.ok(described.actions.includes(action), action);
  assert.ok(described.operations.includes('add_chart'));
  assert.ok(described.operations.includes('add_pivot_table'));
  assert.ok(described.operations.includes('insert_rows'));
  assert.ok(described.operations.includes('define_name'));
  assert.ok(described.operations.includes('add_provenance'));
  assert.ok(described.operations.includes('set_sheet_visibility'));
  assert.deepEqual(described.properties.cellStyle, [
    'fontName',
    'fontSize',
    'bold',
    'italic',
    'color',
    'fillColor',
    'numberFormat',
    'horizontalAlignment',
    'verticalAlignment',
    'wrapText',
  ]);
  const powerpoint = value(await executeOfficeTool({ action: 'describe', format: 'pptx' }));
  assert.ok(powerpoint.operations.includes('add_shape'));
  assert.ok(powerpoint.operations.includes('add_table'));
  assert.ok(powerpoint.operations.includes('set_chart_data'));
  assert.ok(powerpoint.operations.includes('add_provenance'));
  const word = value(await executeOfficeTool({ action: 'describe', format: 'docx' }));
  assert.ok(word.operations.includes('insert_toc'));
  assert.ok(word.operations.includes('add_page_numbers'));
  assert.ok(word.operations.includes('add_provenance'));
  assert.match(word.observation.selection, /active/i);
  const macroWorkbook = value(await executeOfficeTool({ action: 'describe', format: 'xlsm' }));
  assert.ok(macroWorkbook.operations.includes('insert_rows'));
  const csv = value(await executeOfficeTool({ action: 'describe', format: 'csv' }));
  assert.ok(csv.operations.includes('set_range'));
  assert.ok(!csv.operations.includes('set_style'));
});

test('describe returns compact operation contracts and actionable input errors', async () => {
  const chart = value(await executeOfficeTool({
    action: 'describe',
    format: 'xlsx',
    backend: 'microsoft-office-com',
    operation: 'add_chart',
  }));
  assert.deepEqual(chart.operation.input.required, ['op', 'range']);
  assert.ok(chart.operation.input.optional.includes('chartType'));
  assert.equal(chart.operation.supported, true);
  assert.deepEqual(chart.operation.supportedBackends, ['microsoft-office-com', 'mixdog-ooxml']);
  assert.deepEqual(chart.operation.properties.chart, [
    'chartType',
    'left',
    'top',
    'width',
    'height',
    'title',
    'seriesColors',
    'showValues',
    'showLegend',
    'zeroBaseline',
    'valueNumberFormat',
    'dataLabelPosition',
    'dataLabelColor',
  ]);

  const portableAnimation = value(await executeOfficeTool({
    action: 'describe',
    format: 'pptx',
    backend: 'mixdog-ooxml',
    operation: 'add_animation',
  }));
  assert.equal(portableAnimation.operation.supported, true);
  assert.deepEqual(portableAnimation.operation.supportedBackends, ['microsoft-office-com', 'mixdog-ooxml']);
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const portable = describeOfficeCapabilities({ format, backend: 'mixdog-ooxml' });
    assert.deepEqual(
      portable.unsupportedInBackend,
      [],
      `every ${format} operation runs without Microsoft Office`,
    );
  }

  const invalid = await executeOfficeTool({
    action: 'describe',
    format: 'xlsx',
    operation: 'add_chrt',
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Did you mean: add_chart/);
});

test('operation registry matches every COM implementation and rejects unknown fields before dispatch', async () => {
  const source = await readFile(new URL('./office-com-host.ps1', import.meta.url), 'utf8');
  const sections = [
    ['docx', 'function Apply-WordOperation', 'function Excel-Sheet'],
    ['xlsx', 'function Apply-ExcelOperation', 'function Ppt-Slide'],
    ['pptx', 'function Apply-PowerPointOperation', 'function Apply-Operations'],
  ];
  for (const [format, startMarker, endMarker] of sections) {
    const start = source.indexOf(startMarker);
    const block = source.slice(start, source.indexOf(endMarker, start + startMarker.length));
    const implemented = [...block.matchAll(/^\s{4}'([a-z][a-z0-9_]*)'\s*\{/gm)]
      .map((match) => match[1])
      .sort();
    const described = describeOfficeCapabilities({
      format,
      backend: 'microsoft-office-com',
    }).operations.sort();
    const native = described.filter((operation) => !describeOfficeCapabilities({
      format,
      backend: 'microsoft-office-com',
      operation,
    }).operation.virtual);
    assert.deepEqual(native, implemented, `${format} registry drifted from the COM backend`);
    for (const operation of described) {
      const targeted = describeOfficeCapabilities({
        format,
        backend: 'microsoft-office-com',
        operation,
      }).operation;
      assert.equal(targeted.input.required[0], 'op');
      assert.ok(targeted.supportedBackends.includes('microsoft-office-com'));
    }
  }
  assert.throws(
    () => assertOfficeOperationContracts({
      format: 'pdf',
      backend: 'mixdog-pdf',
      operations: [{ op: 'compress', alowNoChange: true }],
    }),
    /unknown field\(s\): alowNoChange.*alowNoChange→allowNoChange/,
  );
});

test('Office contract benchmark avoids broad catalogs and retries', async () => {
  const report = await runOfficeContractBenchmark();
  assert.equal(report.accurate, true);
  assert.equal(report.retries, 0);
  assert.equal(report.unnecessaryRereads, 0);
  assert.equal(report.broadCatalogMaterializations, 0);
  assert.deepEqual(report.requirementFulfillment, { passed: 4, total: 4, rate: 1 });
});

test('portable workbook recalculation is skipped without formulas and blocks unsafe containers', async (t) => {
  const cwd = await workspace(t);
  const plain = join(cwd, 'plain.xlsx');
  await writeZip(plain, {
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
  });
  const skipped = await recalculateLibreOfficeWorkbook(plain, { force: true });
  assert.deepEqual(skipped, {
    needed: false,
    recalculated: false,
    formulaCount: 0,
    missingCachedValues: 0,
  });

  const macro = join(cwd, 'formula.xlsm');
  await writeZip(macro, {
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData></worksheet>',
  });
  const blocked = await recalculateLibreOfficeWorkbook(macro, { force: true });
  assert.equal(blocked.needed, true);
  assert.equal(blocked.recalculated, false);
  assert.match(blocked.reason, /supports \.xlsx only/);
});

test('CSV and TSV sessions preserve delimiters, transactions, and formula-like value warnings', async (t) => {
  const cwd = await workspace(t);
  for (const format of ['csv', 'tsv']) {
    const path = join(cwd, `table.${format}`);
    const created = value(await executeOfficeTool({
      action: 'create',
      path,
      format,
    }, { cwd }));
    assert.equal(created.backend, 'mixdog-tabular');
    assert.equal(created.fileKind, format);
    value(await executeOfficeTool({
      action: 'batch',
      session: created.session,
      operations: [
        { op: 'set_range', range: 'A1:B2', values: [['name', 'value'], [format === 'csv' ? 'alpha,quoted' : 'alpha\tquoted', 1]] },
        { op: 'append_row', values: ['formula', '=SUM(1,2)'] },
        { op: 'insert_columns', column: 2, count: 1 },
        { op: 'set_cell', cell: 'B1', value: 'inserted' },
      ],
    }, { cwd }));
    const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: created.session }, { cwd }));
    assert.equal(snapshot.document.sheets[0].cells.find((cell) => cell.ref === 'A2').value, format === 'csv' ? 'alpha,quoted' : 'alpha\tquoted');
    assert.equal(snapshot.document.sheets[0].cells.find((cell) => cell.ref === 'B1').value, 'inserted');
    const validation = value(await executeOfficeTool({ action: 'validate', session: created.session }, { cwd }));
    assert.equal(validation.ok, true);
    const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
    assert.ok(issues.issues.some((issue) => issue.code === 'formula_like_value'));
    value(await executeOfficeTool({ action: 'begin', session: created.session }, { cwd }));
    value(await executeOfficeTool({
      action: 'batch',
      session: created.session,
      operations: [{ op: 'set_cell', sheet: 'table', cell: 'A1', value: 'temporary' }],
    }, { cwd }));
    value(await executeOfficeTool({ action: 'rollback', session: created.session }, { cwd }));
    const restored = value(await executeOfficeTool({
      action: 'get',
      session: created.session,
      target: '/sheet[table]/cell[A1]',
    }, { cwd }));
    assert.equal(restored.element.value, 'name');
    value(await executeOfficeTool({
      action: 'batch',
      session: created.session,
      operations: [{ op: 'set_cell', cell: 'C3', value: 'formula text' }],
    }, { cwd }));
    const finalized = value(await executeOfficeTool({
      action: 'finalize',
      session: created.session,
    }, { cwd }));
    assert.equal(finalized.finalized, true);
    assert.equal(finalized.closed, true);
    assert.equal(finalized.review.preview.visualCoverage.mode, 'structural');
    assert.equal(finalized.review.preview.visualCoverage.complete, true);
    assert.equal(finalized.review._images, undefined);
  }
});

test('portable XLSM edits preserve VBA payload and strict package relationships', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'macro.xlsm');
  const output = join(cwd, 'macro-copy.xlsm');
  const vba = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 1, 2, 3, 4]);
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="vbaProject" Target="vbaProject.bin"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
    'xl/vbaProject.bin': vba,
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  assert.equal(opened.fileKind, 'xlsm');
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'macro-safe' }],
  }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.macros, ['xl/vbaProject.bin']);
  assert.deepEqual(validation.baseline.lostProtectedParts, []);
  const zip = await JSZip.loadAsync(await readFile(output));
  assert.deepEqual(await zip.file('xl/vbaProject.bin').async('nodebuffer'), vba);
});

test('portable DOCX preserves the package while replacing split runs and appending text', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.docx');
  const output = join(cwd, 'edited.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    'word/media/untouched.bin': Buffer.from([1, 2, 3, 4]),
  });

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  assert.equal(opened.mode, 'portable');
  assert.equal(opened.backend, 'mixdog-ooxml');
  const described = value(await executeOfficeTool({
    action: 'describe',
    session: opened.session,
  }, { cwd }));
  assert.ok(described.operations.includes('set_paragraph_style'));
  assert.ok(described.operations.includes('fill_template'));
  assert.ok(!described.unsupportedInBackend.includes('set_paragraph_style'));
  assert.deepEqual(described.unsupportedInBackend, []);

  const begun = value(await executeOfficeTool({
    action: 'begin',
    session: opened.session,
  }, { cwd }));
  assert.equal(begun.transaction.diff.summary.total, 0);
  const temporary = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Temporary transaction text' }],
  }, { cwd }));
  assert.ok(temporary.transaction.diff.summary.modified > 0);
  const blockedSave = await executeOfficeTool({ action: 'save', session: opened.session }, { cwd });
  assert.equal(blockedSave.isError, true);
  assert.match(blockedSave.content[0].text, /Commit or roll back/);
  const blockedClose = await executeOfficeTool({ action: 'close', session: opened.session }, { cwd });
  assert.equal(blockedClose.isError, true);
  const transactionDiff = value(await executeOfficeTool({
    action: 'diff',
    session: opened.session,
  }, { cwd }));
  assert.ok(transactionDiff.transaction.diff.changes.some((change) => change.path === '/body/p[1]'));
  resetOfficeSessionsForTest();
  const pending = value(await executeOfficeTool({ action: 'transactions' }, { cwd }));
  assert.equal(pending.transactions[0].id, begun.transaction.id);
  assert.equal(pending.transactions[0].phase, 'active');
  const rolledBack = value(await executeOfficeTool({
    action: 'recover',
    transaction: begun.transaction.id,
    strategy: 'rollback',
  }, { cwd }));
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(rolledBack.remainingDiff.summary.total, 0);
  assert.equal(value(await executeOfficeTool({ action: 'transactions' }, { cwd })).transactions.length, 0);

  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'replace_text', find: 'Hello World', replace: '안녕하세요' },
      { op: 'append_text', text: 'Tail paragraph' },
      { op: 'set_table_cell', table: 1, row: 1, col: 1, text: 'Path cell' },
    ],
  }, { cwd }));
  assert.equal(edited.atomic, true);
  assert.equal(edited.results[0].count, 1);

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  const text = JSON.stringify(snapshot.document);
  assert.match(text, /안녕하세요/);
  assert.match(text, /Tail paragraph/);
  assert.equal(snapshot.document.paragraphs[0].path, '/body/p[1]');
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].path, '/body/tbl[1]/row[1]/cell[1]');
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].text, 'Path cell');

  const firstParagraph = value(await executeOfficeTool({
    action: 'get',
    session: opened.session,
    target: '/body/p[1]',
  }, { cwd }));
  assert.equal(firstParagraph.element.text, '안녕하세요');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_paragraph_text', paragraph: 1, text: 'Path edited' },
      { op: 'set_paragraph_style', paragraph: 1, style: 'Heading1' },
    ],
  }, { cwd }));
  const queried = value(await executeOfficeTool({
    action: 'query',
    session: opened.session,
    query: 'Path edited',
  }, { cwd }));
  assert.equal(queried.matches[0].path, '/body/p[1]');

  const validation = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
  }, { cwd }));
  assert.equal(validation.ok, true);
  assert.equal(validation.validation, 'opc-relationships-content-types-xml');
  assert.deepEqual(validation.missingRelationships, []);
  assert.deepEqual(validation.malformedXml, []);

  const zip = await JSZip.loadAsync(await readFile(output));
  assert.match(await zip.file('word/document.xml').async('string'), /<w:pStyle w:val="Heading1"\/>/);
  assert.deepEqual(await zip.file('word/media/untouched.bin').async('nodebuffer'), Buffer.from([1, 2, 3, 4]));

  const beforeExternalEdit = await readFile(output);
  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  const externalZip = await JSZip.loadAsync(beforeExternalEdit);
  externalZip.file('word/document.xml', (await externalZip.file('word/document.xml').async('string')).replace('Path edited', 'Outside edit'));
  await writeFile(output, await externalZip.generateAsync({ type: 'nodebuffer' }));
  const conflicted = await executeOfficeTool({ action: 'diff', session: opened.session }, { cwd });
  assert.equal(conflicted.isError, true);
  const conflictValue = JSON.parse(conflicted.content[0].text);
  assert.equal(conflictValue.code, 'transaction_conflict');
  assert.ok(conflictValue.externalDiff.summary.modified > 0);
  await writeFile(output, beforeExternalEdit);
  value(await executeOfficeTool({ action: 'rollback', session: opened.session }, { cwd }));
});

test('portable DOCX set creates editable runs in empty paragraphs', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'empty-paragraphs.docx');
  const output = join(cwd, 'edited-empty-paragraphs.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Self-closing paragraph' }],
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 2, text: 'Styled empty paragraph' }],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.equal(snapshot.document.paragraphs[0].text, 'Self-closing paragraph');
  assert.equal(snapshot.document.paragraphs[1].text, 'Styled empty paragraph');
  assert.equal(snapshot.document.paragraphs[1].style, 'Normal');
});

test('portable DOCX authors professional tables and paragraph layout', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'professional.docx');
  const output = join(cwd, 'professional-output.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Summary</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      {
        op: 'add_table',
        values: [['Metric', 'Value'], ['Revenue', '120']],
        properties: {
          style: 'TableGrid',
          columnWidths: [120, 60],
          borders: { style: 'single', color: '808080', size: 4 },
        },
      },
      { op: 'set_table_cell_style', table: 1, row: 1, col: 1, properties: { fillColor: 'D9EAF7', bold: true } },
      { op: 'merge_table_cells', table: 1, row: 2, col: 1, colSpan: 2 },
      {
        op: 'set_paragraph_format',
        paragraph: 1,
        properties: {
          alignment: 'center',
          spacingAfter: 120,
          border: { side: 'bottom', style: 'single', color: '2F5597', size: 8 },
          tabStops: [{ position: 360, alignment: 'right', leader: 'dot' }],
        },
      },
    ],
  }, { cwd }));
  assert.equal(edited.changeSummary.changed, 4);
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.equal(snapshot.document.tables.length, 1);
  assert.equal(snapshot.document.tables[0].rows[0].cells[0].text, 'Metric');
  const xml = await (await JSZip.loadAsync(await readFile(output))).file('word/document.xml').async('string');
  assert.match(xml, /<w:tblStyle w:val="TableGrid"\/>/);
  assert.match(xml, /<w:gridSpan w:val="2"\/>/);
  assert.match(xml, /<w:gridCol w:w="2400"\/><w:gridCol w:w="1200"\/>/, 'point widths convert to twips');
  assert.match(xml, /<w:tab w:val="right" w:pos="7200" w:leader="dot"\/>/, '360pt lands on the 5in tab stop');
});

test('DOCX redlining audit rejects untracked text edits', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'redline-source.docx');
  const output = join(cwd, 'redline-output.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Original text</w:t></w:r></w:p></w:body></w:document>',
  });
  const opened = value(await executeOfficeTool({ action: 'open', path: source, output, mode: 'portable' }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_paragraph_text', paragraph: 1, text: 'Untracked replacement' }],
  }, { cwd }));
  const validation = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
    auditProfile: 'redlining',
  }, { cwd }));
  assert.equal(validation.ok, false);
  assert.equal(validation.redlining.ok, false);
  assert.match(validation.redlining.reason, /untracked/i);
});

test('strict OOXML validation rejects missing relationship targets', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'broken.docx');
  const output = join(cwd, 'broken-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="image" Target="media/missing.png"/></Relationships>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, false);
  assert.equal(validation.missingRelationships[0].resolved, 'word/media/missing.png');
});

test('portable DOCX snapshots structured comments and revisions', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'review.docx');
  const output = join(cwd, 'review-copy.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Anchored text</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p><w:p><w:ins w:id="8" w:author="Editor" w:date="2026-08-27T00:00:00Z"><w:r><w:t>Inserted</w:t></w:r></w:ins><w:del w:id="9" w:author="Editor"><w:r><w:delText>Deleted</w:delText></w:r></w:del></w:p></w:body></w:document>',
    'word/comments.xml': '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="7" w:author="Reviewer" w:initials="RV" w:date="2026-08-27T00:00:00Z"><w:p><w:r><w:t>Needs source</w:t></w:r></w:p></w:comment></w:comments>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  assert.equal(opened.document.commentCount, 1);
  assert.deepEqual(opened.document.comments[0], {
    path: '/body/comment[1]',
    index: 1,
    id: '7',
    author: 'Reviewer',
    initials: 'RV',
    date: '2026-08-27T00:00:00Z',
    text: 'Needs source',
    anchoredText: 'Anchored text',
    part: 'word/document.xml',
  });
  assert.equal(opened.document.revisionCount, 2);
  assert.equal(opened.document.revisions[0].type, 'insertion');
  assert.equal(opened.document.revisions[0].text, 'Inserted');
  assert.equal(opened.document.revisions[1].type, 'deletion');
  assert.equal(opened.document.revisions[1].text, 'Deleted');
  const issues = value(await executeOfficeTool({ action: 'issues', session: opened.session }, { cwd }));
  assert.ok(issues.issues.some((issue) => issue.code === 'unresolved_comments'));
  assert.ok(issues.issues.some((issue) => issue.code === 'unresolved_revisions'));
});

test('portable DOCX fills split template tokens across stories and rolls back strict failures', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'template.docx');
  const output = join(cwd, 'filled.docx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{ na</w:t></w:r><w:r><w:t>me }}</w:t></w:r></w:p><w:p><w:r><w:t>{{missing}}</w:t></w:r></w:p></w:body></w:document>',
    'word/header1.xml': '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Owner: {{ owner }}</w:t></w:r></w:p></w:hdr>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const rejected = await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_template', tokens: { name: 'Ada', owner: 'Team' }, strict: true }],
  }, { cwd });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /missing/);
  const beforeFill = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.match(JSON.stringify(beforeFill.document), /\{\{ name }}/);

  const filled = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'fill_template', tokens: { name: 'Ada', owner: 'Team', missing: 'Done' }, strict: true }],
  }, { cwd }));
  assert.deepEqual(filled.results[0].unfilledTokens, []);
  assert.deepEqual(filled.results[0].filled, { name: 1, missing: 1, owner: 1 });
  const snapshot = value(await executeOfficeTool({ action: 'snapshot', session: opened.session }, { cwd }));
  assert.match(JSON.stringify(snapshot.document), /Ada/);
  assert.match(JSON.stringify(snapshot.document), /Owner: Team/);
  assert.doesNotMatch(JSON.stringify(snapshot.document), /\{\{/);
});

test('portable XLSX edits cells, ranges, formulas, and appended rows', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.xlsx');
  const output = join(cwd, 'edited.xlsx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="InputRange">Data!$B$1:$C$2</definedName></definedNames></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Old</t></is></c></row></sheetData><dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="E1:E3"><formula1>"Yes,No"</formula1></dataValidation></dataValidations></worksheet>',
  });

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'New' },
      { op: 'set_range', sheet: 'Data', range: 'B1:C2', values: [[1, 2], [3, 4]] },
      { op: 'set_formula', sheet: 'Data', cell: 'D1', formula: '=SUM(B1:C2)' },
      { op: 'append_row', sheet: 'Data', values: ['tail', 5] },
    ],
  }, { cwd }));

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  const cells = snapshot.document.sheets[0].cells;
  assert.equal(cells.find((cell) => cell.ref === 'A1').value, 'New');
  assert.equal(cells.find((cell) => cell.ref === 'C2').value, '4');
  assert.equal(cells.find((cell) => cell.ref === 'D1').formula, 'SUM(B1:C2)');
  assert.equal(cells.find((cell) => cell.ref === 'D1').cachedValue, null);
  assert.equal(cells.find((cell) => cell.ref === 'D1').cacheState, 'missing');
  assert.equal(cells.find((cell) => cell.value === 'tail').ref, 'A3');
  assert.equal(cells.find((cell) => cell.ref === 'A1').path, '/sheet[Data]/cell[A1]');
  assert.equal(snapshot.document.formulaCount, 1);
  assert.equal(snapshot.document.formulaCacheMissing, 1);
  assert.equal(snapshot.document.needsRecalculation, true);
  assert.deepEqual(snapshot.document.calculation, {
    mode: 'auto',
    fullCalcOnLoad: true,
    forceFullCalc: true,
  });
  assert.equal(snapshot.document.definedNameCount, 1);
  assert.equal(snapshot.document.definedNames[0].name, 'InputRange');
  assert.equal(snapshot.document.definedNames[0].refersTo, 'Data!$B$1:$C$2');
  assert.equal(snapshot.document.sheets[0].validationCount, 1);
  assert.deepEqual(snapshot.document.sheets[0].validations[0].ranges, ['E1:E3']);
  assert.equal(snapshot.document.sheets[0].validations[0].formula1, '"Yes,No"');

  for (const operation of [
    { op: 'set_range', sheet: 'Data', range: 'A1:XFD1048576', values: [] },
    { op: 'set_range', sheet: 'Data', range: 'C2:B1', values: [] },
    { op: 'set_range', sheet: 'Data', range: 'B5:C6', values: [[1, 2]] },
    { op: 'set_cell', sheet: 'Data', cell: 'XFE1', value: 'outside' },
  ]) {
    const rejected = await executeOfficeTool({
      action: 'batch',
      session: opened.session,
      operations: [operation],
    }, { cwd });
    assert.equal(rejected.isError, true);
  }

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'Path set' }],
  }, { cwd }));
  const cell = value(await executeOfficeTool({
    action: 'get',
    session: opened.session,
    target: '/sheet[Data]/cell[A1]',
  }, { cwd }));
  assert.equal(cell.element.value, 'Path set');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'E1', value: '#REF!' }],
  }, { cwd }));
  const issues = value(await executeOfficeTool({
    action: 'issues',
    session: opened.session,
  }, { cwd }));
  assert.equal(issues.ok, false);
  assert.ok(issues.issues.some((issue) => issue.code === 'formula_cache_missing' && issue.path === '/sheet[Data]/cell[D1]'));
  assert.ok(issues.issues.some((issue) => issue.code === 'formula_error' && issue.path === '/sheet[Data]/cell[E1]'));

  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'F1', value: 'Committed' }],
  }, { cwd }));
  const committed = value(await executeOfficeTool(
    { action: 'commit', session: opened.session },
    { cwd },
  ));
  assert.equal(committed.committed, true);
  assert.ok(committed.transaction.diff.summary.added > 0);
});

test('XLSX finalize assertions prove values, formulas, tie-outs, and errors', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'assertions-source.xlsx');
  const output = join(cwd, 'assertions.xlsx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
  });
  const created = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [
      { op: 'set_range', sheet: 'Sheet1', range: 'A1:B2', values: [['Actual', 'Plan'], [120, 120]] },
      { op: 'set_formula', sheet: 'Sheet1', cell: 'C2', formula: '=A2-B2' },
    ],
  }, { cwd }));
  const passed = value(await executeOfficeTool({
    action: 'validate',
    session: created.session,
    assertions: [
      { kind: 'cell-value', sheet: 'Sheet1', cell: 'A2', equals: 120 },
      { kind: 'cell-formula', sheet: 'Sheet1', cell: 'C2', equals: '=A2-B2' },
      { kind: 'tie-out', sheet: 'Sheet1', left: 'A2', right: 'B2', tolerance: 0 },
      { kind: 'no-errors', sheet: 'Sheet1' },
    ],
  }, { cwd }));
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.equal(passed.assertions.passed, 4);
  const failed = value(await executeOfficeTool({
    action: 'validate',
    session: created.session,
    assertions: [{ kind: 'cell-value', sheet: 'Sheet1', cell: 'A2', equals: 999 }],
  }, { cwd }));
  assert.equal(failed.ok, false);
  assert.equal(failed.assertions.issues[0].code, 'assertion_value_mismatch');
});

test('portable PPTX fills template tokens while preserving masters and layouts', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.pptx');
  const output = join(cwd, 'edited.pptx');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{{ti</a:t></a:r><a:r><a:t>tle}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/notesSlides/notesSlide1.xml': '<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Owner {{owner}}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    'ppt/slideMasters/slideMaster1.xml': '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Master"/></p:sldMaster>',
    'ppt/slideLayouts/slideLayout1.xml': '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Layout"/></p:sldLayout>',
  });

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'fill_template', tokens: { title: 'Mixdog', owner: '재영' }, strict: true },
      { op: 'add_textbox', slide: 1, text: 'Second box', left: 20, top: 40, width: 200, height: 50 },
    ],
  }, { cwd }));

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.deepEqual(snapshot.document.slides[0].text, ['Mixdog', 'Second box']);
  assert.equal(snapshot.document.slides[0].shapes[0].path, '/slide[1]/shape[1]');
  assert.equal(snapshot.document.layoutCount, 1);
  assert.equal(snapshot.document.layouts[0].name, 'Brand Layout');
  const packageAfterFill = await JSZip.loadAsync(await readFile(output));
  assert.equal(await packageAfterFill.file('ppt/slideMasters/slideMaster1.xml').async('string'), '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Brand Master"/></p:sldMaster>');
  assert.match(await packageAfterFill.file('ppt/notesSlides/notesSlide1.xml').async('string'), /Owner 재영/);

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'set_text', slide: 1, shape: 1, text: 'Path shape' },
      { op: 'delete_shape', slide: 1, shape: 2 },
    ],
  }, { cwd }));
  const updated = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.equal(updated.document.slides[0].shapes[0].text, 'Path shape');
  assert.equal(updated.document.slides[0].shapes.length, 1);
});

test('PDF backend edits and validates without Microsoft Office', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'source.pdf');
  const output = join(cwd, 'edited.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await writeFile(source, await pdf.save());

  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'auto',
  }, { cwd }));
  assert.equal(opened.mode, 'portable');
  assert.equal(opened.backend, 'mixdog-pdf');

  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [
      { op: 'add_text', page: 1, text: 'PDF edited', x: 20, y: 20, size: 14 },
      { op: 'rotate_pages', pages: [1], rotation: 90 },
      { op: 'set_metadata', properties: { title: 'Mixdog PDF' } },
    ],
  }, { cwd }));

  const validation = value(await executeOfficeTool({
    action: 'validate',
    session: opened.session,
  }, { cwd }));
  assert.equal(validation.ok, true);
  assert.equal(validation.pages, 1);

  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
  }, { cwd }));
  assert.equal(snapshot.document.pageCount, 1);
  assert.equal(snapshot.document.pages[0].path, '/page[1]');

  value(await executeOfficeTool({ action: 'begin', session: opened.session }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'add_text', page: 1, text: 'Visual QA delta', x: 30, y: 60, size: 16 }],
  }, { cwd }));
  const qaResult = await executeOfficeTool({
    action: 'qa',
    session: opened.session,
    output: join(cwd, 'qa-preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd });
  const qa = value(qaResult);
  assert.equal(qa.review.visualDiff.available, true);
  assert.ok(qa.review.visualDiff.changedPercent > 0);
  assert.ok(qaResult.content.filter((item) => item.type === 'image').length >= 2);
  value(await executeOfficeTool({ action: 'rollback', session: opened.session }, { cwd }));

  const renderedResult = await executeOfficeTool({
    action: 'render',
    session: opened.session,
    output: join(cwd, 'preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd });
  const rendered = value(renderedResult);
  assert.equal(rendered.images.length, 1);
  assert.equal(renderedResult.content[1].type, 'image');
  assert.equal(renderedResult.content[1].source.media_type, 'image/png');

  const finalizedResult = await executeOfficeTool({
    action: 'finalize',
    session: opened.session,
    output: join(cwd, 'final-preview.pdf'),
    pages: [1],
    maxWidth: 640,
  }, { cwd });
  const finalized = value(finalizedResult);
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.review._images, undefined);
  assert.equal(finalizedResult.content.filter((item) => item.type === 'image').length, 1);
});

test('PDF rendering compresses long documents into at most 12 contact sheets with full coverage', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'thirteen-pages.pdf');
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= 13; page += 1) pdf.addPage([200, 120]);
  await writeFile(path, await pdf.save());

  const rendered = await renderPdfPages(path, { maxWidth: 200 });
  assert.equal(rendered.pageCount, 13);
  assert.equal(rendered.images.length, 7);
  assert.deepEqual(rendered.images[0].pages, [1, 2]);
  assert.deepEqual(rendered.visualCoverage, {
    reviewedPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    reviewed: 13,
    total: 13,
    complete: true,
    remainingPages: [],
  });
});

test('PDF rendering workers ignore parent-only V8 heap flags', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'worker-flags.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 120]);
  await writeFile(path, await pdf.save());
  const original = process.execArgv;
  process.execArgv = ['--max-old-space-size=768'];
  try {
    const rendered = await renderPdfPages(path, { maxWidth: 200 });
    assert.equal(rendered.pageCount, 1);
    assert.equal(rendered.images.length, 1);
  } finally {
    process.execArgv = original;
  }
});

test('PDF specialized queries expose positioned text, inferred tables, and embedded images', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'analysis.pdf');
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  page.drawText('Metric', { x: 40, y: 240, size: 12 });
  page.drawText('Value', { x: 220, y: 240, size: 12 });
  page.drawText('Revenue', { x: 40, y: 210, size: 12 });
  page.drawText('120', { x: 220, y: 210, size: 12 });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2S9sAAAAASUVORK5CYII=', 'base64');
  const image = await pdf.embedPng(png);
  page.drawImage(image, { x: 40, y: 40, width: 20, height: 20 });
  await writeFile(path, await pdf.save());
  const opened = value(await executeOfficeTool({ action: 'open', path, mode: 'portable' }, { cwd }));
  const layout = value(await executeOfficeTool({
    action: 'query',
    session: opened.session,
    queryKind: 'pdf-layout',
  }, { cwd }));
  assert.ok(layout.pages[0].items.some((item) => item.text === 'Metric'));
  const tables = value(await executeOfficeTool({
    action: 'query',
    session: opened.session,
    queryKind: 'pdf-tables',
  }, { cwd }));
  assert.equal(tables.tableCount, 1);
  assert.deepEqual(tables.tables[0].rows[0], ['Metric', 'Value']);
  const imagesResult = await executeOfficeTool({
    action: 'query',
    session: opened.session,
    queryKind: 'pdf-images',
  }, { cwd });
  const images = value(imagesResult);
  assert.ok(images.imageCount >= 1);
  assert.ok(imagesResult.content.some((item) => item.type === 'image'));
});

test('OCR TSV parsing and on-demand OOXML validator manifest stay deterministic', async (t) => {
  const words = parseOcrTsv('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t92.5\tHello');
  assert.deepEqual(words, [{
    text: 'Hello',
    confidence: 92.5,
    left: 10,
    top: 20,
    width: 30,
    height: 12,
  }]);
  assert.deepEqual(parseOcrBlocks([{
    paragraphs: [{ lines: [{ words: [{ text: 'Block', confidence: 88, bbox: { x0: 2, y0: 3, x1: 12, y1: 9 } }] }] }],
  }]), [{
    text: 'Block',
    confidence: 88,
    left: 2,
    top: 3,
    width: 10,
    height: 6,
  }]);
  const manifest = ooxmlValidatorManifest();
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.platforms.length, 6);
  const classified = classifyOoxmlValidationErrors([
    {
      path: '/ppt/charts/chart1.xml',
      xPath: '/c:chartSpace[1]/c:chart[1]/c:extLst[1]/c:ext[1]',
      description: "The 'uri' attribute is not declared.",
    },
    {
      path: '/xl/charts/chart1.xml',
      xPath: '/c:chartSpace[1]/c:chart[1]/c:extLst[1]/c:ext[1]',
      description: "The 'uri' attribute is not declared.",
    },
    { path: '/word/document.xml', xPath: '/w:document[1]', description: 'Invalid child.' },
  ]);
  assert.equal(classified.compatibilityWarnings.length, 2);
  assert.equal(classified.errors.length, 1);
  const unavailable = await ensureOoxmlValidator({
    dataDir: await workspace(t),
    download: false,
  });
  assert.equal(unavailable.disabled, true);
});

test('PDF text edits embed an explicit Unicode font for non-Latin text', async (t) => {
  const fontPath = await unicodeFontPath();
  if (!fontPath) return t.skip('No Unicode TrueType font is installed');
  const cwd = await workspace(t);
  const source = join(cwd, 'unicode-source.pdf');
  const output = join(cwd, 'unicode-edited.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await writeFile(source, await pdf.save());
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  const edited = value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'add_text', page: 1, text: '한글-日本語-中文', x: 30, y: 60, size: 16, fontPath }],
  }, { cwd }));
  assert.equal(edited.results[0].fontEmbedded, true);
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: opened.session,
    pages: [1],
  }, { cwd }));
  assert.match(JSON.stringify(snapshot.document.pages), /한글/);
});

test('snapshot pagination uses opaque cursors and rejects stale continuations', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'large.csv');
  const created = value(await executeOfficeTool({ action: 'create', path, format: 'csv' }, { cwd }));
  const values = Array.from({ length: 2_505 }, (_, index) => [`row-${index + 1}`]);
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'set_range', range: 'A1:A2505', values }],
  }, { cwd }));
  const first = value(await executeOfficeTool({
    action: 'snapshot',
    session: created.session,
    limit: 1_000,
  }, { cwd }));
  const firstReturned = first.document.pagination.returned;
  assert.ok(firstReturned > 0 && firstReturned <= 1_000);
  assert.equal(first.document.sheets[0].cells.length, firstReturned);
  assert.equal(first.document.pagination.hasMore, true);
  assert.ok(first.document.pagination.nextCursor);
  const second = value(await executeOfficeTool({
    action: 'snapshot',
    session: created.session,
    cursor: first.document.pagination.nextCursor,
  }, { cwd }));
  assert.equal(second.document.sheets[0].cells[0].ref, `A${firstReturned + 1}`);
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'set_cell', sheet: 'large', cell: 'A1', value: 'changed' }],
  }, { cwd }));
  const stale = await executeOfficeTool({
    action: 'snapshot',
    session: created.session,
    cursor: second.document.pagination.nextCursor,
  }, { cwd });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /stale/i);
});

test('Office Use returns a typed cancellation result before starting work', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeOfficeTool({ action: 'detect' }, { signal: controller.signal });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false,
    code: 'cancelled',
    message: 'Office Use operation was cancelled',
  });
});

test('PDF create lints forms, reports OCR handoff, and preserves attachments', async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, 'created.pdf');
  const attachment = join(cwd, 'source.txt');
  await writeFile(attachment, 'attached evidence', 'utf8');
  const created = value(await executeOfficeTool({
    action: 'create',
    path,
    format: 'pdf',
    blocks: [
      { type: 'heading', text: 'Frontier PDF' },
      { type: 'paragraph', text: 'Structured document body.' },
      { type: 'pagebreak' },
    ],
    fields: [
      { name: 'Reviewer', type: 'text', page: 1, x: 50, y: 650, width: 180, height: 24, value: 'Mixdog' },
      { name: 'Approved', type: 'checkbox', page: 1, x: 240, y: 650, width: 18, height: 18, value: true },
    ],
    properties: { title: 'Frontier PDF' },
  }, { cwd }));
  assert.equal(created.created, true);
  assert.equal(created.artifacts[0].type, 'pdf');
  assert.equal(created.outputCount, 1);
  assert.equal(created.document.fieldCount, 2);
  assert.ok(created.document.likelyScannedPages.includes(2));
  value(await executeOfficeTool({
    action: 'batch',
    session: created.session,
    operations: [{ op: 'add_attachment', path: attachment, name: 'evidence.txt', description: 'Source evidence' }],
  }, { cwd }));
  const snapshot = value(await executeOfficeTool({
    action: 'snapshot',
    session: created.session,
    pages: [1],
  }, { cwd }));
  assert.equal(snapshot.document.metadata.title, 'Frontier PDF');
  assert.equal(snapshot.document.fieldCount, 2);
  assert.equal(snapshot.document.attachmentCount, 1);
  assert.equal(snapshot.document.attachments[0].name, 'evidence.txt');
  const issues = value(await executeOfficeTool({ action: 'issues', session: created.session }, { cwd }));
  assert.ok(issues.issues.some((issue) => issue.code === 'ocr_required' && issue.path === '/page[2]'));
});

test('macro and digital-signature containers expose security inventory and fail invalidated signatures', async (t) => {
  const cwd = await workspace(t);
  const source = join(cwd, 'signed.xlsm');
  const output = join(cwd, 'signed-copy.xlsm');
  await writeZip(source, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Default Extension="sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="vbaProject" Target="vbaProject.bin"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>',
    'xl/vbaProject.bin': Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 1, 2, 3, 4]),
    '_xmlsignatures/origin.sigs': Buffer.from([1, 2, 3]),
    '_xmlsignatures/sig1.xml': '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>',
  });
  const opened = value(await executeOfficeTool({
    action: 'open',
    path: source,
    output,
    mode: 'portable',
  }, { cwd }));
  value(await executeOfficeTool({
    action: 'batch',
    session: opened.session,
    operations: [{ op: 'set_cell', sheet: 'Data', cell: 'A1', value: 'edited' }],
  }, { cwd }));
  const validation = value(await executeOfficeTool({ action: 'validate', session: opened.session }, { cwd }));
  assert.equal(validation.ok, false);
  assert.equal(validation.security.macroExecution, 'disabled');
  assert.equal(validation.security.macros.length, 1);
  assert.equal(validation.security.signatures.length, 2);
  assert.equal(validation.security.digitalSignatureInvalidated, true);
});
