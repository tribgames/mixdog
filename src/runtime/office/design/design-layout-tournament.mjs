import { clamp } from '../shared/values.mjs';


function rounded(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function titleDemand(operation) {
  return String(operation?.title || operation?.takeaway || '').trim().length;
}

function contentDemand(operation = {}) {
  const chart = operation.chart || {};
  const annotations = operation.chart
    ? count(operation.annotations) || count(chart.annotations) || Math.max(1, count(chart.series))
    : 0;
  return {
    titleChars: titleDemand(operation),
    annotations,
    metrics: count(operation.metrics),
    allocations: count(operation.allocations) || count(operation.columns),
    steps: count(operation.steps),
    tableRows: Math.max(0, count(operation.table?.rows || operation.table) - 1),
  };
}

function capacityFit(demand, capacity = {}) {
  const active = Object.entries(demand).filter(([, value]) => value > 0);
  if (!active.length) return 1;
  const ratios = active.map(([key, value]) => {
    const available = Math.max(0, Number(capacity[key]) || 0);
    if (!available) return 0;
    return Math.min(1, available / value);
  });
  return ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
}

function geometryMetrics(candidate, whitespaceTarget) {
  const regions = Array.isArray(candidate?.regions) ? candidate.regions : [];
  const weighted = regions.map((region) => {
    const area = Math.max(0, Number(region?.w) || 0) * Math.max(0, Number(region?.h) || 0);
    const weight = ['annotated-chart', 'allocation', 'timeline', 'scorecard', 'chart', 'table', 'image', 'visual']
      .includes(String(region?.role || '').toLowerCase())
      ? 1
      : 0.62;
    return {
      area: area * weight,
      x: (Number(region?.x) || 0) + ((Number(region?.w) || 0) / 2),
      y: (Number(region?.y) || 0) + ((Number(region?.h) || 0) / 2),
      evidence: weight === 1,
    };
  });
  const total = weighted.reduce((sum, entry) => sum + entry.area, 0) || 1;
  const centerX = weighted.reduce((sum, entry) => sum + (entry.x * entry.area), 0) / total;
  const centerY = weighted.reduce((sum, entry) => sum + (entry.y * entry.area), 0) / total;
  const whitespace = clamp(1 - (total / 10_000));
  const evidenceArea = weighted.filter((entry) => entry.evidence).reduce((sum, entry) => sum + entry.area, 0);
  return {
    whitespace: rounded(whitespace),
    whitespaceFit: rounded(1 - clamp(Math.abs(whitespace - whitespaceTarget) / 0.42)),
    balance: rounded(1 - clamp(((Math.abs(centerX - 50) / 50) * 0.7) + ((Math.abs(centerY - 50) / 50) * 0.3))),
    evidenceDominance: rounded(clamp(evidenceArea / total)),
  };
}

function referenceFit(candidate, genome) {
  const reference = [
    genome?.grid,
    genome?.shapeLanguage,
    ...(Array.isArray(genome?.layoutPatterns) ? genome.layoutPatterns : []),
  ].join(' ').toLowerCase();
  const tags = Array.isArray(candidate?.tags) ? candidate.tags : [];
  const matches = tags.filter((tag) => reference.includes(String(tag).toLowerCase())).length;
  return tags.length ? clamp(0.55 + ((matches / tags.length) * 0.45)) : 0.65;
}

function assetFit(candidate, assetIntent) {
  if (!assetIntent?.required) return 1;
  const supported = Array.isArray(candidate?.assetKinds) ? candidate.assetKinds : [];
  return supported.includes(assetIntent.kind) || supported.includes(assetIntent.evidenceKind) ? 1 : 0.55;
}

function candidateReview(candidate, context, index, total) {
  const demand = contentDemand(context.operation);
  const density = String(context.brief?.density || 'balanced').toLowerCase();
  const whitespaceTarget = Number(context.genome?.whitespaceTargets?.[density]) || 0.33;
  const geometry = geometryMetrics(candidate, whitespaceTarget);
  const capacity = rounded(capacityFit(demand, candidate.capacity));
  const reference = rounded(referenceFit(candidate, context.genome));
  const assets = rounded(assetFit(candidate, context.assetIntent));
  const expectedIndex = Math.max(0, (Number(context.brief?.sequence) || 1) - 1) % Math.max(1, total);
  const rhythm = index === expectedIndex ? 1 : 0.74;
  const motifSafety = candidate.decorativeEdges === true ? 0 : 1;
  const score = rounded(
    (capacity * 0.32)
      + (geometry.whitespaceFit * 0.18)
      + (geometry.balance * 0.18)
      + (geometry.evidenceDominance * 0.1)
      + (reference * 0.1)
      + (assets * 0.07)
      + (rhythm * 0.04)
      + (motifSafety * 0.01),
  );
  return {
    id: candidate.name,
    variant: candidate.variant,
    score,
    metrics: {
      capacity,
      whitespace: geometry.whitespace,
      whitespaceFit: geometry.whitespaceFit,
      balance: geometry.balance,
      evidenceDominance: geometry.evidenceDominance,
      referenceFit: reference,
      assetFit: assets,
      rhythm,
      motifSafety,
    },
    capacity: { ...candidate.capacity },
    demand,
  };
}

export function selectPptxLayoutCandidate(candidates = [], context = {}) {
  if (!Array.isArray(candidates) || candidates.length < 3) {
    throw new Error('Adaptive PPTX layout search requires at least three candidates.');
  }
  const evaluated = candidates.map((candidate, index) => ({
    candidate,
    review: candidateReview(candidate, context, index, candidates.length),
    index,
  })).sort((left, right) => (
    right.review.score - left.review.score
      || left.index - right.index
      || left.review.id.localeCompare(right.review.id)
  ));
  const winner = evaluated[0];
  return {
    ...winner.candidate,
    sourceContract: 'adaptive-tournament-fallback',
    referenceGenome: {
      id: context.genome?.id || '',
      directionId: context.genome?.directionId || '',
      coordinatePolicy: context.genome?.coordinatePolicy || 'constraints-only',
    },
    assetIntent: context.assetIntent || null,
    tournament: {
      method: 'verifiable-layout-v1',
      candidateCount: candidates.length,
      selected: winner.review.variant,
      selectedId: winner.review.id,
      score: winner.review.score,
      metrics: winner.review.metrics,
      candidates: evaluated
        .sort((left, right) => left.index - right.index)
        .map(({ review }) => review),
    },
  };
}
