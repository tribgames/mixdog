const COMPOSE_OPERATION = Object.freeze({
  pptx: 'compose_slide',
  docx: 'compose_document',
  xlsx: 'compose_sheet',
});

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function compact(value, maximum = 120) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function strings(value) {
  if (Array.isArray(value)) return value.map((entry) => compact(entry)).filter(Boolean);
  const normalized = compact(value);
  return normalized ? [normalized] : [];
}

function evidenceKind(operation = {}) {
  if (operation.chart) return 'chart';
  if (Array.isArray(operation.allocations) && operation.allocations.length) return 'allocation';
  if (Array.isArray(operation.steps) && operation.steps.length) return 'timeline';
  if (Array.isArray(operation.metrics) && operation.metrics.length) return 'scorecard';
  if (operation.table) return 'decision-matrix';
  if (Array.isArray(operation.columns) && operation.columns.length) return 'comparison';
  if (operation.image || operation.imagePath) return 'image';
  if (operation.visualText) return 'statement';
  return 'narrative';
}

function narrativeRole(operation, index, total) {
  const kind = compact(operation.kind, 32).toLowerCase();
  if (kind === 'cover') return 'opening';
  if (kind === 'closing') return 'decision-close';
  if (index === 0 && total > 1 && evidenceKind(operation) === 'narrative') return 'opening';
  if (index === total - 1 && total > 1 && evidenceKind(operation) === 'narrative') return 'decision-close';
  if (['chart', 'metrics', 'statement'].includes(kind)) return index <= 1 ? 'premise' : 'proof';
  if (['comparison', 'table'].includes(kind)) return 'choice';
  if (kind === 'process') return 'execution';
  return index < total / 2 ? 'context' : 'implication';
}

function recommendedVisual(operation, role) {
  const evidence = evidenceKind(operation);
  if (evidence === 'chart') return 'annotated-chart';
  if (evidence === 'allocation') return 'allocation';
  if (evidence === 'timeline') return 'timeline';
  if (evidence === 'scorecard') return 'scorecard';
  if (evidence === 'decision-matrix') return 'scorecard';
  if (evidence === 'comparison') return 'allocation';
  if (role === 'decision-close') return operation.visualText ? 'decision-stamp' : 'allocation';
  return evidence;
}

function operationEvidence(operation, content) {
  const claimId = compact(operation.claimId, 80).toLowerCase();
  const claim = content?.claims?.find((entry) => entry.id === claimId) || null;
  const factIds = new Set(claim?.factIds || []);
  for (const metric of Array.isArray(operation.metrics) ? operation.metrics : []) {
    if (metric?.factId) factIds.add(String(metric.factId).toLowerCase());
  }
  return {
    claimId,
    factIds: [...factIds],
    source: compact(operation.source, 240),
    evidenceKind: evidenceKind(operation),
  };
}

export function directOfficeStory(format, operations = [], design = {}) {
  const normalized = String(format || '').toLowerCase();
  const composeName = COMPOSE_OPERATION[normalized];
  const authored = (Array.isArray(operations) ? operations : [])
    .map((operation, operationIndex) => ({ operation, operationIndex }))
    .filter(({ operation }) => plainObject(operation) && operation.op === composeName);
  const content = design.content || null;
  const thesis = compact(
    content?.decision
      || content?.objective
      || authored[0]?.operation?.title
      || design.intent,
    220,
  );
  const motif = compact(
    design.artDirection?.selected?.deck?.motif
      || design.artDirection?.selected?.motif
      || design.signature
      || thesis,
    160,
  );
  const briefs = authored.map(({ operation, operationIndex }, index) => {
    const role = narrativeRole(operation, index, authored.length);
    const evidence = operationEvidence(operation, content);
    return {
      operationIndex,
      sequence: index + 1,
      role,
      message: compact(operation.title || operation.takeaway || thesis, 220),
      implication: compact(operation.takeaway || operation.subtitle || operation.body, 220),
      evidence,
      recommendedVisual: recommendedVisual(operation, role),
      focalPoint: role === 'opening'
        ? 'thesis'
        : role === 'decision-close'
          ? 'decision'
          : evidence.evidenceKind === 'narrative'
            ? 'message'
            : 'evidence',
      density: ['opening', 'decision-close'].includes(role) ? 'light' : 'balanced',
      motif,
    };
  });
  return {
    version: 1,
    standard: 'frontier-office-v1',
    format: normalized,
    thesis,
    audience: compact(design.audience || content?.audience, 160),
    objective: compact(content?.objective || design.intent, 220),
    decision: compact(content?.decision, 220),
    motif,
    narrativeArc: briefs.map((brief) => brief.role),
    evidenceCoverage: {
      claims: content?.claims?.length || 0,
      facts: content?.facts?.length || 0,
      sourcedBriefs: briefs.filter((brief) => brief.evidence.source || brief.evidence.factIds.length).length,
      totalBriefs: briefs.length,
    },
    qualityFloor: {
      nativeEvidence: true,
      semanticVisuals: true,
      noDefaultChartTreatment: true,
      noRawTableSlides: true,
      noUnderComposedContentSlides: true,
      distinctOpeningAndClosing: true,
    },
    briefs,
  };
}

export function applyOfficeCreativeBrief(operation, creative, operationIndex) {
  if (!plainObject(operation) || !creative) return operation;
  const brief = creative.briefs?.find((entry) => entry.operationIndex === operationIndex);
  if (!brief) return operation;
  const directedBackground = operation.op === 'compose_slide'
    && !operation.backgroundRole
    && brief.role === 'choice'
    ? 'inverse'
    : operation.backgroundRole;
  return {
    ...operation,
    ...(directedBackground ? { backgroundRole: directedBackground } : {}),
    creativeBrief: {
      role: brief.role,
      message: brief.message,
      implication: brief.implication,
      recommendedVisual: brief.recommendedVisual,
      focalPoint: brief.focalPoint,
      density: brief.density,
      motif: brief.motif,
      evidence: brief.evidence,
    },
  };
}

export function creativeBriefForOperation(creative, operationIndex) {
  return creative?.briefs?.find((entry) => entry.operationIndex === operationIndex) || null;
}
