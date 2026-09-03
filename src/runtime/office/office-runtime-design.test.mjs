import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applyPdfDesign,
  expandOfficeDesignOperations,
  officeDesignCatalog,
  resolveOfficeDesign,
} from './design/design-system.mjs';
import { normalizePptxModelPlan } from './design/pptx/design-pptx-plan.mjs';
import { summarizeOfficeCompositions } from './design/composition-system.mjs';
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
} from './design/library/design-library.mjs';
import {
  inferPptxSlideRoles,
  isPptxStatementSlide,
  pptxVisualReviewAcknowledged,
  reviewOfficeDesign,
  reviewPptxVisualCritique,
} from './quality/design-review.mjs';
import { value, workspace, writeZip } from './office-test-support.mjs';

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
  const synthesized = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [{ op: 'compose_slide', kind: 'cover', title: 'Missing plan' }],
  });
  assert.equal(synthesized.semantic[0].plan.name, 'frontier-editorial-opening');
  assert.equal(synthesized.design.creative.standard, 'frontier-office-v1');
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

test('Creative Director synthesizes editable frontier visuals when scratch plans are omitted', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [
      {
        op: 'compose_slide',
        kind: 'chart',
        title: 'Revenue growth cleared the investment gate',
        chart: {
          categories: ['May', 'June', 'July'],
          series: [{ name: 'Revenue', values: [100, 110, 124] }],
        },
        annotations: [{ label: 'July', value: 124, note: '+12.7% vs prior' }],
      },
      {
        op: 'compose_slide',
        kind: 'statement',
        title: 'Three measures support the decision',
        metrics: [
          { label: 'Revenue', value: 124 },
          { label: 'Profit', value: 18, detail: '백만원' },
          { label: 'Margin', value: '14.5%', detail: '%' },
        ],
      },
      {
        op: 'compose_slide',
        kind: 'comparison',
        title: 'Fund both tracks',
        allocations: [
          { label: 'Growth', value: 50, displayValue: '$0.9m', detail: 'Release ≥ 13.5% margin · Stop < 13.5%' },
          { label: 'Retention', value: 50, displayValue: '$0.9m', detail: 'Release ≤ 2.4% churn · Stop < NPS 52' },
        ],
      },
      {
        op: 'compose_slide',
        kind: 'process',
        title: 'Recheck the decision in 30 days',
        steps: [
          { phase: 'D1', title: 'Owner', detail: 'Assign accountability' },
          { phase: 'D30', title: 'Gate', detail: 'Release or stop' },
        ],
      },
    ],
  });
  assert.equal(expanded.design.creative.standard, 'frontier-office-v1');
  assert.deepEqual(
    expanded.semantic.map((entry) => entry.plan.visualType),
    ['annotated-chart', 'scorecard', 'allocation', 'timeline'],
  );
  assert.deepEqual(
    expanded.semantic.map((entry) => entry.backgroundRole),
    ['canvas', 'canvas', 'inverse', 'canvas'],
  );
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart');
  assert.equal(chart.showValues, true);
  assert.deepEqual(chart.series[0].pointColors, [
    expanded.design.tokens.colors.accent,
    expanded.design.tokens.colors.accent,
    expanded.design.tokens.colors.accent2,
  ]);
  const renderedText = expanded.operations
    .filter((entry) => entry.op === 'add_textbox')
    .map((entry) => String(entry.text));
  assert.ok(renderedText.includes('124'));
  assert.ok(renderedText.includes('18'));
  assert.ok(renderedText.includes('14.5%'));
  assert.equal(renderedText.includes('%'), false);
  assert.ok(renderedText.includes('DECISION SIGNALS'));
  assert.ok(renderedText.includes('PRIMARY PROOF'));
  assert.ok(renderedText.includes('SUPPORTING PROOF 02'));
  assert.ok(renderedText.includes('SUPPORTING PROOF 03'));
  assert.ok(renderedText.includes('RELEASE'));
  assert.ok(renderedText.includes('STOP'));
  assert.ok(renderedText.includes('CHECKPOINT'));
  assert.ok(renderedText.includes('ACTION'));
  assert.ok(renderedText.includes('Assign accountability'));
  assert.ok(renderedText.includes('Release or stop'));
  const allocationValue = expanded.operations.find((entry) => (
    entry.op === 'add_textbox' && entry.slide === 3 && entry.text === '$0.9m'
  ));
  const allocationGate = expanded.operations.find((entry) => (
    entry.op === 'add_textbox' && entry.slide === 3 && entry.text === '≥ 13.5% margin'
  ));
  assert.equal(allocationValue.properties.color, expanded.design.tokens.colors.inverse);
  assert.equal(allocationGate.properties.color, expanded.design.tokens.colors.inverse);
  const chartValue = expanded.operations.find((entry) => (
    entry.op === 'add_textbox' && entry.slide === 1 && entry.text === '124'
  ));
  const chartNote = expanded.operations.find((entry) => (
    entry.op === 'add_textbox' && entry.slide === 1 && entry.text === '+12.7% vs prior'
  ));
  const profitValue = expanded.operations.find((entry) => (
    entry.op === 'add_textbox' && entry.slide === 2 && entry.text === '18'
  ));
  const profitUnit = expanded.operations.find((entry) => (
    entry.op === 'add_textbox' && entry.slide === 2 && entry.text === '백만원'
  ));
  assert.ok(chartNote.properties.top - (chartValue.properties.top + chartValue.properties.height) >= 7);
  assert.ok(profitValue.properties.left + profitValue.properties.width <= profitUnit.properties.left);
  const allocationConnectors = expanded.operations.filter((entry) => (
    entry.op === 'add_shape'
    && entry.slide === 3
    && entry.properties.width <= 3
    && entry.properties.height >= 8
  ));
  const timelineConnectors = expanded.operations.filter((entry) => (
    entry.op === 'add_shape'
    && entry.slide === 4
    && entry.properties.width <= 3
    && entry.properties.height >= 8
  ));
  assert.equal(allocationConnectors.length, 3);
  assert.equal(timelineConnectors.length, 2);
  assert.ok(expanded.operations.filter((entry) => entry.op === 'add_shape').length >= 22);
  assert.equal(expanded.operations.some((entry) => entry.op === 'import_slides'), false);
});

test('reference-conditioned PPTX plans run a verifiable Top-K tournament and render the selected variant', () => {
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    design: {
      artDirection: 'editorial-contrast',
      content: {
        objective: 'Choose the investment path from source evidence',
        facts: [{ id: 'fact-revenue', value: 124, source: 'finance ledger' }],
        claims: [{ id: 'claim-growth', text: 'Growth cleared the gate', factIds: ['fact-revenue'] }],
      },
    },
    operations: [
      {
        op: 'compose_slide',
        kind: 'chart',
        title: 'Growth cleared the evidence gate',
        claimId: 'claim-growth',
        source: 'finance ledger',
        chart: {
          categories: ['May', 'June', 'July'],
          series: [{ name: 'Revenue', values: [100, 110, 124] }],
        },
        annotations: [
          { label: 'July', value: 124, note: '+12.7% vs prior' },
          { label: 'Gate', value: 'PASS', note: 'Source-confirmed' },
        ],
      },
      {
        op: 'compose_slide',
        kind: 'metrics',
        title: 'Three measures support the decision',
        source: 'finance ledger',
        metrics: [
          { label: 'Revenue', value: 124 },
          { label: 'Profit', value: 18 },
          { label: 'Margin', value: '14.5%' },
        ],
      },
    ],
  });
  assert.equal(expanded.design.creative.version, 2);
  assert.equal(expanded.design.creative.layoutSearch, 'adaptive-top-k');
  assert.equal(expanded.design.creative.referenceGenome.coordinatePolicy, 'constraints-only');
  assert.equal(expanded.design.creative.assetManifest.length, 2);
  for (const entry of expanded.semantic) {
    const plan = entry.plan;
    assert.equal(plan.sourceContract, 'adaptive-tournament-fallback');
    assert.equal(plan.referenceGenome.coordinatePolicy, 'constraints-only');
    assert.equal(plan.assetIntent.sourceSpecific, true);
    assert.equal(plan.tournament.method, 'verifiable-layout-v1');
    assert.equal(plan.tournament.candidateCount, 3);
    assert.equal(plan.tournament.candidates.length, 3);
    assert.ok(plan.tournament.candidates.every((candidate) => Number.isFinite(candidate.score)));
    assert.ok(plan.tournament.metrics.capacity >= 0.78);
    assert.ok(plan.tournament.metrics.whitespaceFit >= 0.52);
    assert.ok(plan.tournament.metrics.balance >= 0.62);
    assert.equal(plan.tournament.metrics.motifSafety, 1);
    const winningScore = Math.max(...plan.tournament.candidates.map((candidate) => candidate.score));
    assert.equal(plan.tournament.score, winningScore);
  }
  const chartPlan = expanded.semantic[0].plan;
  const chart = expanded.operations.find((entry) => entry.op === 'add_chart' && entry.slide === 1);
  const railLabel = expanded.operations.find((entry) => (
    entry.op === 'add_textbox'
      && entry.slide === 1
      && entry.text === 'DECISION SIGNALS'
  ));
  assert.ok(chart);
  assert.ok(railLabel);
  if (chartPlan.variant === 'signal-left') {
    assert.ok(railLabel.properties.left < chart.left);
  } else if (chartPlan.variant === 'signal-bottom') {
    assert.ok(railLabel.properties.top > chart.top + chart.height);
  } else {
    assert.ok(railLabel.properties.left > chart.left + chart.width);
  }
  const scorecardEdgeStripes = expanded.operations.filter((entry) => (
    entry.op === 'add_shape'
      && entry.slide === 2
      && Number(entry.properties?.width) <= 14
      && Number(entry.properties?.height) >= 180
  ));
  assert.equal(scorecardEdgeStripes.length, 0);
});

test('model plans balance long titles and render closing allocations as a decision stamp', () => {
  const coverTitle = 'July performance proves we can fund growth without sacrificing retention';
  const expanded = expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'microsoft-office-com',
    created: true,
    operations: [
      {
        op: 'compose_slide',
        kind: 'cover',
        title: coverTitle,
        subtitle: 'A two-track investment decision',
      },
      {
        op: 'compose_slide',
        kind: 'closing',
        title: 'Approve both investment tracks today',
        subtitle: 'Recheck the release gates in 30 days',
        visualText: '$1.8m',
        visualLabel: 'Approval request',
        allocations: [
          { label: 'Growth', value: 50, displayValue: '$0.9m' },
          { label: 'Retention', value: 50, displayValue: '$0.9m' },
        ],
      },
    ],
  });
  const coverTitleOperation = expanded.operations.find((entry) => (
    entry.op === 'add_textbox'
    && entry.slide === 1
    && String(entry.text).includes('July performance')
  ));
  assert.ok(coverTitleOperation);
  assert.match(String(coverTitleOperation.text), /\n/u);
  assert.equal(String(coverTitleOperation.text).replace(/\s*\n\s*/gu, ' '), coverTitle);
  const closingText = expanded.operations
    .filter((entry) => entry.op === 'add_textbox' && entry.slide === 2)
    .map((entry) => String(entry.text));
  assert.ok(closingText.includes('2 TRACKS · DECISION STAMP'));
  assert.equal(closingText.filter((entry) => entry === '$0.9m').length, 2);
  assert.ok(expanded.operations.some((entry) => (
    entry.op === 'add_shape'
    && entry.slide === 2
    && entry.properties?.fillColor === expanded.design.tokens.colors.canvas
  )));
  const closingPlan = expanded.semantic.find((entry) => entry.slide === 2)?.plan;
  const allocationRegion = closingPlan?.regions?.find((region) => region.role === 'allocation');
  assert.ok(allocationRegion);
  const allocationBottom = allocationRegion.top + allocationRegion.height;
  const compactShapes = expanded.operations.filter((entry) => (
    entry.op === 'add_shape'
      && entry.slide === 2
      && Number(entry.properties?.left) >= allocationRegion.left
      && Number(entry.properties?.top) >= allocationRegion.top
      && Number(entry.properties?.left) + Number(entry.properties?.width)
        <= allocationRegion.left + allocationRegion.width + 0.01
  ));
  assert.ok(compactShapes.length >= 4);
  assert.ok(compactShapes.every((entry) => (
    Number(entry.properties.top) + Number(entry.properties.height) <= allocationBottom + 0.01
  )));
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
  const intentionalChoiceBackground = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slides: [
        slide(1, design.tokens.colors.inverse),
        slide(2, design.tokens.colors.canvas),
        slide(3, design.tokens.colors.canvas),
        slide(4, design.tokens.colors.inverse),
        slide(5, design.tokens.colors.canvas),
        slide(6, design.tokens.colors.inverse),
      ],
    },
    design: {
      ...request,
      slidePlans: [
        { slide: 1, slideRole: 'cover', backgroundRole: 'inverse' },
        { slide: 2, slideRole: 'content', backgroundRole: 'canvas' },
        { slide: 3, slideRole: 'content', backgroundRole: 'canvas' },
        { slide: 4, slideRole: 'content', backgroundRole: 'inverse' },
        { slide: 5, slideRole: 'content', backgroundRole: 'canvas' },
        { slide: 6, slideRole: 'closing', backgroundRole: 'inverse' },
      ],
    },
  });
  assert.equal(
    intentionalChoiceBackground.issues.some((issue) => issue.code === 'theme_body_backgrounds'),
    false,
  );
  const partialIntentionalChoiceBackground = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slideCount: 6,
      slides: [
        slide(1, design.tokens.colors.inverse),
        slide(2, design.tokens.colors.canvas),
        slide(3, design.tokens.colors.canvas),
        slide(4, design.tokens.colors.inverse),
      ],
    },
    design: {
      ...request,
      slidePlans: [
        { slide: 1, slideRole: 'cover', backgroundRole: 'inverse' },
        { slide: 2, slideRole: 'content', backgroundRole: 'canvas' },
        { slide: 3, slideRole: 'content', backgroundRole: 'canvas' },
        { slide: 4, slideRole: 'content', backgroundRole: 'inverse' },
        { slide: 5, slideRole: 'content', backgroundRole: 'canvas' },
        { slide: 6, slideRole: 'closing', backgroundRole: 'inverse' },
      ],
    },
  });
  assert.equal(
    partialIntentionalChoiceBackground.issues.some((issue) => issue.code === 'theme_body_backgrounds'),
    false,
  );
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
});
