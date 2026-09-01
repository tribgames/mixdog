function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function plan(name, rationale, visualType, regions, readingOrder) {
  return {
    name,
    rationale,
    visualType,
    focalRegion: 'evidence',
    regions,
    readingOrder,
  };
}

function openingPlan() {
  return plan(
    'frontier-editorial-opening',
    'Open with one editorial thesis, quiet context, and a deliberate asymmetric field.',
    'editorial-opening',
    [
      { id: 'eyebrow', role: 'eyebrow', x: 6, y: 8, w: 42, h: 5 },
      { id: 'message', role: 'title', x: 6, y: 21, w: 66, h: 28 },
      { id: 'support', role: 'subtitle', x: 6, y: 58, w: 55, h: 13 },
      { id: 'context', role: 'meta', x: 72, y: 77, w: 22, h: 6, style: { align: 'right' } },
    ],
    ['eyebrow', 'message', 'support', 'context'],
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

export function synthesizePptxFrontierPlan(operation = {}, design = {}, brief = null) {
  if (plainObject(operation.plan) && Array.isArray(operation.plan.regions) && operation.plan.regions.length) {
    return operation;
  }
  const kind = String(operation.kind || '').toLowerCase();
  const visual = String(brief?.recommendedVisual || operation.creativeBrief?.recommendedVisual || '').toLowerCase();
  let generated;
  if (kind === 'cover' || brief?.role === 'opening') generated = openingPlan();
  else if (kind === 'closing' || brief?.role === 'decision-close') generated = closingPlan(operation);
  else if (visual === 'annotated-chart' || operation.chart) generated = annotatedChartPlan();
  else if (visual === 'allocation' || operation.allocations || kind === 'comparison') generated = allocationPlan();
  else if (visual === 'timeline' || operation.steps || kind === 'process') generated = timelinePlan();
  else generated = scorecardPlan();
  return {
    ...operation,
    plan: {
      ...generated,
      message: String(operation.title || brief?.message || ''),
      evidence: brief?.evidence?.factIds || [],
      artDirection: design.artDirection?.selected?.id || '',
    },
  };
}
