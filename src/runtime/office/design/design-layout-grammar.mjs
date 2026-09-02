import { selectPptxLayoutCandidate } from './design-layout-tournament.mjs';
import { compilePptxReferenceGenome, directPptxAssetIntent } from './design-reference-genome.mjs';
import { plainObject } from '../shared/values.mjs';

function plan(name, rationale, visualType, regions, readingOrder, options = {}) {
  return {
    name,
    rationale,
    visualType,
    variant: options.variant || name,
    tags: Array.isArray(options.tags) ? options.tags : [],
    capacity: plainObject(options.capacity) ? options.capacity : {},
    assetKinds: Array.isArray(options.assetKinds) ? options.assetKinds : [],
    decorativeEdges: false,
    focalRegion: 'evidence',
    regions,
    readingOrder,
  };
}

function openingSignal(operation, geometry) {
  if (!operation?.visualText) return [];
  return [{
    id: 'signal',
    role: 'visual',
    ...geometry,
    style: {
      align: 'center',
      fillRole: 'accent',
      colorRole: 'onAccent',
    },
  }];
}

function openingPlan(operation = {}) {
  return plan(
    'frontier-editorial-opening',
    'Open with one editorial thesis, quiet context, and a deliberate asymmetric field.',
    'editorial-opening',
    [
      { id: 'eyebrow', role: 'eyebrow', x: 6, y: 8, w: 42, h: 5 },
      { id: 'message', role: 'title', x: 6, y: 21, w: 66, h: 28 },
      { id: 'support', role: 'subtitle', x: 6, y: 58, w: 55, h: 13 },
      ...openingSignal(operation, { x: 74, y: 24, w: 18, h: 32 }),
      { id: 'context', role: 'meta', x: 72, y: 77, w: 22, h: 6, style: { align: 'right' } },
    ],
    ['eyebrow', 'message', ...(operation.visualText ? ['signal'] : []), 'support', 'context'],
  );
}

function annotatedChartPlan() {
  return plan(
    'frontier-annotated-evidence',
    'Let the native chart carry the proof and reserve a commentary rail for the decision-relevant deltas.',
    'annotated-chart',
    [
      { id: 'message', role: 'title', x: 6, y: 7, w: 88, h: 15 },
      { id: 'evidence', role: 'annotated-chart', x: 6, y: 27, w: 88, h: 61 },
    ],
    ['message', 'evidence'],
  );
}

function scorecardPlan() {
  return plan(
    'frontier-asymmetric-scorecard',
    'Use one dominant proof and a numbered supporting evidence wall instead of equal cards.',
    'scorecard',
    [
      { id: 'message', role: 'title', x: 6, y: 7, w: 88, h: 17 },
      { id: 'support', role: 'subtitle', x: 6, y: 25.2, w: 62, h: 7 },
      { id: 'evidence', role: 'scorecard', x: 6, y: 36, w: 88, h: 51 },
    ],
    ['message', 'support', 'evidence'],
  );
}

function allocationPlan() {
  return plan(
    'frontier-allocation-field',
    'Turn competing options into a proportional allocation field with explicit release and stop logic.',
    'allocation',
    [
      { id: 'message', role: 'title', x: 6, y: 7, w: 88, h: 16 },
      { id: 'support', role: 'subtitle', x: 6, y: 23, w: 70, h: 8 },
      { id: 'evidence', role: 'allocation', x: 6, y: 34, w: 88, h: 55 },
    ],
    ['message', 'support', 'evidence'],
  );
}

function timelinePlan() {
  return plan(
    'frontier-operating-timeline',
    'Stage execution as one continuous operating timeline with distinct checkpoints and ownership.',
    'timeline',
    [
      { id: 'message', role: 'title', x: 6, y: 7, w: 88, h: 16 },
      { id: 'evidence', role: 'timeline', x: 6, y: 28, w: 88, h: 59 },
    ],
    ['message', 'evidence'],
  );
}

function closingPlan(operation) {
  if (Array.isArray(operation.allocations) && operation.allocations.length) {
    return plan(
      'frontier-decision-close',
      'Land the decision with the exact allocation and a compact approval stamp.',
      'allocation',
      [
        { id: 'message', role: 'title', x: 7, y: 15, w: 55, h: 28 },
        { id: 'support', role: 'subtitle', x: 7, y: 54, w: 54, h: 13 },
        { id: 'evidence', role: 'allocation', x: 66, y: 16, w: 27, h: 57, style: { compact: true } },
      ],
      ['message', 'evidence', 'support'],
    );
  }
  return plan(
    'frontier-decision-stamp',
    'Close on one approval sentence and a numeric decision stamp without repeating the opening composition.',
    'decision-stamp',
    [
      { id: 'message', role: 'title', x: 7, y: 19, w: 58, h: 27 },
      { id: 'support', role: 'subtitle', x: 7, y: 61, w: 56, h: 12 },
      { id: 'decision', role: 'visual', x: 72, y: 25, w: 20, h: 40, style: { align: 'center', fillRole: 'accent', colorRole: 'onAccent' } },
    ],
    ['message', 'decision', 'support'],
  );
}

function evidenceStyle(regions, variant, style = {}) {
  return regions.map((region) => (
    region.id === 'evidence'
      ? { ...region, style: { ...region.style, ...style, variant } }
      : region
  ));
}

function asCandidate(base, {
  name = base.name,
  rationale = base.rationale,
  variant,
  tags,
  capacity,
  assetKinds,
  regions = base.regions,
  readingOrder = base.readingOrder,
} = {}) {
  return plan(name, rationale, base.visualType, regions, readingOrder, {
    variant,
    tags,
    capacity,
    assetKinds,
  });
}

function openingCandidates(operation = {}) {
  const base = openingPlan(operation);
  return [
    asCandidate(base, {
      variant: 'thesis-left',
      tags: ['editorial', 'asymmetric', 'whitespace'],
      capacity: { titleChars: 105 },
    }),
    asCandidate(base, {
      name: 'frontier-split-opening',
      rationale: 'Set the thesis against a compressed context field while preserving a quiet opening.',
      variant: 'thesis-split',
      tags: ['split', 'immersive', 'minimal'],
      capacity: { titleChars: 78 },
      regions: [
        { id: 'eyebrow', role: 'eyebrow', x: 6, y: 8, w: 38, h: 5 },
        { id: 'message', role: 'title', x: 6, y: 20, w: 54, h: 34 },
        { id: 'support', role: 'subtitle', x: 66, y: 23, w: 28, h: 20 },
        ...openingSignal(operation, { x: 72, y: 49, w: 20, h: 22 }),
        { id: 'context', role: 'meta', x: 67, y: 76, w: 27, h: 6, style: { align: 'right' } },
      ],
    }),
    asCandidate(base, {
      name: 'frontier-bottom-anchored-opening',
      rationale: 'Use a low editorial anchor and broad negative space to create a distinct first beat.',
      variant: 'thesis-bottom',
      tags: ['editorial', 'rhythm', 'minimal'],
      capacity: { titleChars: 92 },
      regions: [
        { id: 'eyebrow', role: 'eyebrow', x: 6, y: 9, w: 48, h: 5 },
        ...openingSignal(operation, { x: 75, y: 9, w: 17, h: 24 }),
        { id: 'message', role: 'title', x: 6, y: 43, w: 78, h: 27 },
        { id: 'support', role: 'subtitle', x: 6, y: 74, w: 58, h: 11 },
        { id: 'context', role: 'meta', x: 73, y: 80, w: 21, h: 5, style: { align: 'right' } },
      ],
    }),
  ];
}

function annotatedChartCandidates() {
  const base = annotatedChartPlan();
  const capacity = { titleChars: 96, annotations: 4 };
  const assets = ['native-chart', 'chart'];
  return [
    asCandidate(base, {
      variant: 'signal-right',
      tags: ['evidence', 'data', 'analytical'],
      capacity,
      assetKinds: assets,
      regions: evidenceStyle(base.regions, 'signal-right'),
    }),
    asCandidate(base, {
      name: 'frontier-chart-editorial-split',
      rationale: 'Move the claim into a narrow editorial column and let the chart-plus-signal field dominate.',
      variant: 'signal-left',
      tags: ['editorial', 'asymmetric', 'split'],
      capacity: { titleChars: 70, annotations: 3 },
      assetKinds: assets,
      regions: evidenceStyle([
        { id: 'message', role: 'title', x: 6, y: 13, w: 28, h: 36 },
        { id: 'support', role: 'subtitle', x: 6, y: 56, w: 26, h: 18 },
        { id: 'evidence', role: 'annotated-chart', x: 38, y: 8, w: 56, h: 80 },
      ], 'signal-left', { gutter: 16 }),
      readingOrder: ['message', 'support', 'evidence'],
    }),
    asCandidate(base, {
      name: 'frontier-chart-signal-band',
      rationale: 'Use a wide native chart and a horizontal evidence band when category comparison needs width.',
      variant: 'signal-bottom',
      tags: ['immersive', 'data', 'rhythm'],
      capacity: { titleChars: 88, annotations: 3 },
      assetKinds: assets,
      regions: evidenceStyle([
        { id: 'message', role: 'title', x: 6, y: 6, w: 76, h: 14 },
        { id: 'evidence', role: 'annotated-chart', x: 6, y: 24, w: 88, h: 65 },
      ], 'signal-bottom'),
      readingOrder: ['message', 'evidence'],
    }),
  ];
}

function scorecardCandidates() {
  const base = scorecardPlan();
  const assets = ['native-metric-composition', 'scorecard'];
  return [
    asCandidate(base, {
      variant: 'proof-left',
      tags: ['evidence', 'data', 'asymmetric'],
      capacity: { titleChars: 96, metrics: 5 },
      assetKinds: assets,
      regions: evidenceStyle(base.regions, 'proof-left'),
    }),
    asCandidate(base, {
      name: 'frontier-scorecard-editorial-split',
      rationale: 'Keep a concise implication beside a mirrored proof wall for a stronger editorial beat.',
      variant: 'proof-right',
      tags: ['editorial', 'split', 'asymmetric'],
      capacity: { titleChars: 72, metrics: 4 },
      assetKinds: assets,
      regions: evidenceStyle([
        { id: 'message', role: 'title', x: 6, y: 13, w: 29, h: 31 },
        { id: 'support', role: 'subtitle', x: 6, y: 51, w: 27, h: 19 },
        { id: 'evidence', role: 'scorecard', x: 39, y: 8, w: 55, h: 79 },
      ], 'proof-right'),
      readingOrder: ['message', 'support', 'evidence'],
    }),
    asCandidate(base, {
      name: 'frontier-scorecard-proof-band',
      rationale: 'Compress the title and expand the proof field when several measures must read in one scan.',
      variant: 'proof-band',
      tags: ['immersive', 'data', 'rhythm'],
      capacity: { titleChars: 82, metrics: 5 },
      assetKinds: assets,
      regions: evidenceStyle([
        { id: 'message', role: 'title', x: 6, y: 6, w: 82, h: 14 },
        { id: 'support', role: 'subtitle', x: 66, y: 7, w: 28, h: 10, style: { align: 'right' } },
        { id: 'evidence', role: 'scorecard', x: 6, y: 25, w: 88, h: 63 },
      ], 'proof-band'),
      readingOrder: ['message', 'support', 'evidence'],
    }),
  ];
}

function allocationCandidates() {
  const base = allocationPlan();
  const assets = ['native-relationship-diagram', 'allocation', 'comparison'];
  return [
    asCandidate(base, {
      variant: 'decision-field',
      tags: ['evidence', 'comparison', 'analytical'],
      capacity: { titleChars: 92, allocations: 4 },
      assetKinds: assets,
      regions: evidenceStyle(base.regions, 'decision-field'),
    }),
    asCandidate(base, {
      name: 'frontier-allocation-editorial-split',
      rationale: 'Set the decision thesis beside the allocation field so the release logic reads as the dominant proof.',
      variant: 'decision-sidebar',
      tags: ['editorial', 'split', 'decision'],
      capacity: { titleChars: 68, allocations: 3 },
      assetKinds: assets,
      regions: evidenceStyle([
        { id: 'message', role: 'title', x: 6, y: 13, w: 29, h: 30 },
        { id: 'support', role: 'subtitle', x: 6, y: 50, w: 27, h: 18 },
        { id: 'evidence', role: 'allocation', x: 40, y: 8, w: 54, h: 80 },
      ], 'decision-sidebar', { gutter: 12 }),
      readingOrder: ['message', 'support', 'evidence'],
    }),
    asCandidate(base, {
      name: 'frontier-allocation-ledger',
      rationale: 'Use a broad decision ledger when more tracks or longer gate language require capacity.',
      variant: 'decision-ledger',
      tags: ['immersive', 'comparison', 'rhythm'],
      capacity: { titleChars: 82, allocations: 5 },
      assetKinds: assets,
      regions: evidenceStyle([
        { id: 'message', role: 'title', x: 6, y: 6, w: 80, h: 14 },
        { id: 'support', role: 'subtitle', x: 6, y: 21, w: 70, h: 7 },
        { id: 'evidence', role: 'allocation', x: 6, y: 31, w: 88, h: 58 },
      ], 'decision-ledger'),
      readingOrder: ['message', 'support', 'evidence'],
    }),
  ];
}

function timelineCandidates() {
  const base = timelinePlan();
  const assets = ['native-process-diagram', 'timeline'];
  return [
    asCandidate(base, {
      variant: 'operating-board',
      tags: ['evidence', 'process', 'analytical'],
      capacity: { titleChars: 92, steps: 6 },
      assetKinds: assets,
      regions: evidenceStyle(base.regions, 'operating-board'),
    }),
    asCandidate(base, {
      name: 'frontier-timeline-editorial-split',
      rationale: 'Place the execution claim beside a tall operating board for a distinct process beat.',
      variant: 'process-sidebar',
      tags: ['editorial', 'split', 'process'],
      capacity: { titleChars: 66, steps: 4 },
      assetKinds: assets,
      regions: evidenceStyle([
        { id: 'message', role: 'title', x: 6, y: 14, w: 26, h: 34 },
        { id: 'support', role: 'subtitle', x: 6, y: 55, w: 25, h: 17 },
        { id: 'evidence', role: 'timeline', x: 36, y: 8, w: 58, h: 80 },
      ], 'process-sidebar', { titleSize: 14 }),
      readingOrder: ['message', 'support', 'evidence'],
    }),
    asCandidate(base, {
      name: 'frontier-timeline-cadence-band',
      rationale: 'Use a wide cadence band when checkpoint count and action detail need horizontal capacity.',
      variant: 'cadence-band',
      tags: ['immersive', 'rhythm', 'process'],
      capacity: { titleChars: 82, steps: 6 },
      assetKinds: assets,
      regions: evidenceStyle([
        { id: 'message', role: 'title', x: 6, y: 6, w: 82, h: 14 },
        { id: 'evidence', role: 'timeline', x: 6, y: 25, w: 88, h: 64 },
      ], 'cadence-band', { titleSize: 14 }),
      readingOrder: ['message', 'evidence'],
    }),
  ];
}

function sourceImageCandidates() {
  const base = plan(
    'frontier-source-image',
    'Use the supplied source image as the dominant visual rather than substituting generic stock.',
    'source-image',
    [
      { id: 'message', role: 'title', x: 6, y: 7, w: 54, h: 17 },
      { id: 'support', role: 'subtitle', x: 6, y: 27, w: 44, h: 12 },
      { id: 'evidence', role: 'image', x: 55, y: 7, w: 39, h: 81 },
    ],
    ['message', 'support', 'evidence'],
  );
  const assets = ['source-image', 'image'];
  return [
    asCandidate(base, {
      variant: 'image-right',
      tags: ['editorial', 'image', 'asymmetric'],
      capacity: { titleChars: 82 },
      assetKinds: assets,
    }),
    asCandidate(base, {
      name: 'frontier-source-image-left',
      variant: 'image-left',
      tags: ['split', 'image', 'immersive'],
      capacity: { titleChars: 76 },
      assetKinds: assets,
      regions: [
        { id: 'evidence', role: 'image', x: 6, y: 7, w: 49, h: 81 },
        { id: 'message', role: 'title', x: 61, y: 18, w: 33, h: 29 },
        { id: 'support', role: 'subtitle', x: 61, y: 54, w: 31, h: 17 },
      ],
      readingOrder: ['message', 'support', 'evidence'],
    }),
    asCandidate(base, {
      name: 'frontier-source-image-hero',
      variant: 'image-hero',
      tags: ['immersive', 'image', 'rhythm'],
      capacity: { titleChars: 68 },
      assetKinds: assets,
      regions: [
        { id: 'evidence', role: 'image', x: 6, y: 7, w: 88, h: 59 },
        { id: 'message', role: 'title', x: 6, y: 70, w: 67, h: 17 },
        { id: 'support', role: 'subtitle', x: 76, y: 72, w: 18, h: 12, style: { align: 'right' } },
      ],
      readingOrder: ['message', 'support', 'evidence'],
    }),
  ];
}

function matrixCandidates() {
  const base = plan(
    'frontier-decision-matrix',
    'Keep the source data native while framing it as decision evidence rather than a raw table.',
    'decision-matrix',
    [
      { id: 'message', role: 'title', x: 6, y: 7, w: 88, h: 15 },
      { id: 'evidence', role: 'table', x: 6, y: 27, w: 88, h: 61 },
    ],
    ['message', 'evidence'],
  );
  const assets = ['native-decision-matrix', 'decision-matrix'];
  return [
    asCandidate(base, {
      variant: 'matrix-wide',
      tags: ['evidence', 'comparison', 'data'],
      capacity: { titleChars: 92, tableRows: 8 },
      assetKinds: assets,
    }),
    asCandidate(base, {
      name: 'frontier-decision-matrix-split',
      variant: 'matrix-split',
      tags: ['editorial', 'split', 'comparison'],
      capacity: { titleChars: 64, tableRows: 6 },
      assetKinds: assets,
      regions: [
        { id: 'message', role: 'title', x: 6, y: 13, w: 29, h: 34 },
        { id: 'support', role: 'subtitle', x: 6, y: 54, w: 27, h: 18 },
        { id: 'evidence', role: 'table', x: 39, y: 8, w: 55, h: 80 },
      ],
      readingOrder: ['message', 'support', 'evidence'],
    }),
    asCandidate(base, {
      name: 'frontier-decision-matrix-band',
      variant: 'matrix-band',
      tags: ['immersive', 'data', 'rhythm'],
      capacity: { titleChars: 78, tableRows: 10 },
      assetKinds: assets,
      regions: [
        { id: 'message', role: 'title', x: 6, y: 6, w: 82, h: 14 },
        { id: 'evidence', role: 'table', x: 6, y: 25, w: 88, h: 64 },
      ],
      readingOrder: ['message', 'evidence'],
    }),
  ];
}

function statementCandidates() {
  const base = plan(
    'frontier-editorial-statement',
    'Use typography and controlled whitespace when the source contains no visual evidence to invent.',
    'editorial-statement',
    [
      { id: 'message', role: 'title', x: 6, y: 18, w: 66, h: 28 },
      { id: 'support', role: 'body', x: 6, y: 55, w: 54, h: 24 },
    ],
    ['message', 'support'],
  );
  return [
    asCandidate(base, {
      variant: 'statement-left',
      tags: ['editorial', 'whitespace', 'asymmetric'],
      capacity: { titleChars: 110 },
      assetKinds: ['typographic-statement'],
    }),
    asCandidate(base, {
      name: 'frontier-statement-split',
      variant: 'statement-split',
      tags: ['split', 'minimal', 'rhythm'],
      capacity: { titleChars: 84 },
      assetKinds: ['typographic-statement'],
      regions: [
        { id: 'message', role: 'title', x: 6, y: 17, w: 52, h: 35 },
        { id: 'support', role: 'body', x: 65, y: 24, w: 29, h: 35 },
      ],
    }),
    asCandidate(base, {
      name: 'frontier-statement-bottom',
      variant: 'statement-bottom',
      tags: ['immersive', 'whitespace', 'minimal'],
      capacity: { titleChars: 96 },
      assetKinds: ['typographic-statement'],
      regions: [
        { id: 'message', role: 'title', x: 6, y: 43, w: 78, h: 26 },
        { id: 'support', role: 'body', x: 6, y: 73, w: 62, h: 15 },
      ],
    }),
  ];
}

function closingCandidates(operation) {
  const base = closingPlan(operation);
  const hasAllocation = base.visualType === 'allocation';
  const assets = hasAllocation
    ? ['native-relationship-diagram', 'allocation']
    : ['typographic-statement', 'statement'];
  const capacity = hasAllocation
    ? { titleChars: 78, allocations: 3 }
    : { titleChars: 92 };
  return [
    asCandidate(base, {
      variant: hasAllocation ? 'decision-stamp-right' : 'approval-right',
      tags: ['decision', 'asymmetric', 'editorial'],
      capacity,
      assetKinds: assets,
      regions: hasAllocation ? evidenceStyle(base.regions, 'decision-stamp-right') : base.regions,
    }),
    asCandidate(base, {
      name: 'frontier-centered-decision-close',
      rationale: 'Close with a centered decision and a compact source-specific stamp.',
      variant: hasAllocation ? 'decision-stamp-bottom' : 'approval-bottom',
      tags: ['immersive', 'decision', 'minimal'],
      capacity: hasAllocation ? { titleChars: 70, allocations: 3 } : { titleChars: 82 },
      assetKinds: assets,
      regions: hasAllocation
        ? evidenceStyle([
            { id: 'message', role: 'title', x: 16, y: 10, w: 68, h: 22, style: { align: 'center' } },
            { id: 'support', role: 'subtitle', x: 21, y: 35, w: 58, h: 10, style: { align: 'center' } },
            { id: 'evidence', role: 'allocation', x: 24, y: 50, w: 52, h: 38, style: { compact: true } },
          ], 'decision-stamp-bottom', { compact: true })
        : [
            { id: 'message', role: 'title', x: 13, y: 18, w: 74, h: 24, style: { align: 'center' } },
            { id: 'decision', role: 'visual', x: 39, y: 48, w: 22, h: 25, style: { align: 'center', fillRole: 'accent', colorRole: 'onAccent' } },
            { id: 'support', role: 'subtitle', x: 20, y: 78, w: 60, h: 9, style: { align: 'center' } },
          ],
      readingOrder: hasAllocation
        ? ['message', 'support', 'evidence']
        : ['message', 'decision', 'support'],
    }),
    asCandidate(base, {
      name: 'frontier-editorial-decision-close',
      rationale: 'Use a reversed editorial split so the close cannot repeat the opening grammar.',
      variant: hasAllocation ? 'decision-stamp-left' : 'approval-left',
      tags: ['editorial', 'split', 'decision'],
      capacity: hasAllocation ? { titleChars: 68, allocations: 3 } : { titleChars: 76 },
      assetKinds: assets,
      regions: hasAllocation
        ? evidenceStyle([
            { id: 'evidence', role: 'allocation', x: 7, y: 16, w: 29, h: 57, style: { compact: true } },
            { id: 'message', role: 'title', x: 43, y: 16, w: 50, h: 27 },
            { id: 'support', role: 'subtitle', x: 43, y: 54, w: 49, h: 13 },
          ], 'decision-stamp-left', { compact: true })
        : [
            { id: 'decision', role: 'visual', x: 7, y: 25, w: 20, h: 40, style: { align: 'center', fillRole: 'accent', colorRole: 'onAccent' } },
            { id: 'message', role: 'title', x: 34, y: 19, w: 59, h: 27 },
            { id: 'support', role: 'subtitle', x: 34, y: 61, w: 57, h: 12 },
          ],
      readingOrder: hasAllocation
        ? ['message', 'evidence', 'support']
        : ['message', 'decision', 'support'],
    }),
  ];
}

export function synthesizePptxFrontierPlan(operation = {}, design = {}, brief = null) {
  if (
    plainObject(operation.plan)
    && (
      (Array.isArray(operation.plan.regions) && operation.plan.regions.length)
      || (
        plainObject(operation.plan.authoredScene)
        && Array.isArray(operation.plan.authoredScene.elements)
        && operation.plan.authoredScene.elements.length
      )
    )
  ) {
    return {
      ...operation,
      plan: {
        ...operation.plan,
        sourceContract: operation.plan.sourceContract || 'authored',
      },
    };
  }
  const kind = String(operation.kind || '').toLowerCase();
  const visual = String(brief?.recommendedVisual || operation.creativeBrief?.recommendedVisual || '').toLowerCase();
  let candidates;
  if (kind === 'cover' || brief?.role === 'opening') candidates = openingCandidates(operation);
  else if (kind === 'closing' || brief?.role === 'decision-close') candidates = closingCandidates(operation);
  else if (visual === 'annotated-chart' || operation.chart) candidates = annotatedChartCandidates();
  else if (visual === 'allocation' || operation.allocations || kind === 'comparison') candidates = allocationCandidates();
  else if (visual === 'timeline' || operation.steps || kind === 'process') candidates = timelineCandidates();
  else if ((visual === 'scorecard' || operation.metrics) && Array.isArray(operation.metrics) && operation.metrics.length) {
    candidates = scorecardCandidates();
  } else if (operation.table) candidates = matrixCandidates();
  else if (operation.image || operation.imagePath) candidates = sourceImageCandidates();
  else candidates = statementCandidates();
  const directedBrief = brief || operation.creativeBrief || {};
  const genome = design?.creative?.referenceGenome || compilePptxReferenceGenome(design);
  const assetIntent = directedBrief.assetIntent || directPptxAssetIntent(operation, directedBrief);
  const generated = selectPptxLayoutCandidate(candidates, {
    operation,
    brief: directedBrief,
    genome,
    assetIntent,
  });
  return {
    ...operation,
    plan: {
      ...generated,
      message: String(operation.title || brief?.message || ''),
      evidence: directedBrief?.evidence?.factIds || [],
      artDirection: design.artDirection?.selected?.id || '',
    },
  };
}
