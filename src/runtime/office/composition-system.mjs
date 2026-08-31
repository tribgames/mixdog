import { createHash } from 'node:crypto';

const PURPOSES = new Set(['monitor', 'decide', 'compare', 'explain', 'inspect']);
const EXPRESSION_MODES = new Set(['conservative', 'strong-fit', 'divergent']);

const FORMAT_CANDIDATES = Object.freeze({
  docx: Object.freeze([
    Object.freeze({
      id: 'decision-brief',
      family: 'decision',
      purposes: ['decide'],
      modes: ['conservative', 'strong-fit'],
      evidence: ['claims', 'facts'],
      densities: ['balanced', 'dense'],
      novelty: 0,
    }),
    Object.freeze({
      id: 'evidence-brief',
      family: 'evidence',
      purposes: ['decide', 'compare', 'inspect'],
      modes: ['strong-fit', 'divergent'],
      evidence: ['table', 'facts'],
      densities: ['balanced', 'dense'],
      novelty: 1,
    }),
    Object.freeze({
      id: 'editorial-report',
      family: 'narrative',
      purposes: ['explain'],
      modes: ['strong-fit', 'divergent'],
      evidence: ['narrative', 'claims'],
      densities: ['light', 'balanced'],
      novelty: 1,
    }),
    Object.freeze({
      id: 'compact-memo',
      family: 'memo',
      purposes: ['decide', 'inspect'],
      modes: ['conservative'],
      evidence: ['narrative'],
      densities: ['balanced', 'dense'],
      novelty: 0,
    }),
  ]),
  xlsx: Object.freeze([
    Object.freeze({
      id: 'monitor-dashboard',
      family: 'monitor',
      purposes: ['monitor'],
      modes: ['conservative', 'strong-fit'],
      evidence: ['metrics', 'table'],
      densities: ['balanced', 'dense'],
      novelty: 0,
    }),
    Object.freeze({
      id: 'trend-dashboard',
      family: 'trend',
      purposes: ['monitor', 'explain'],
      modes: ['strong-fit', 'divergent'],
      evidence: ['chart', 'table'],
      densities: ['balanced'],
      novelty: 1,
    }),
    Object.freeze({
      id: 'comparison-board',
      family: 'comparison',
      purposes: ['compare', 'decide'],
      modes: ['strong-fit', 'divergent'],
      evidence: ['chart', 'metrics'],
      densities: ['balanced', 'dense'],
      novelty: 1,
    }),
    Object.freeze({
      id: 'analysis-sheet',
      family: 'analysis',
      purposes: ['inspect', 'explain'],
      modes: ['conservative', 'strong-fit'],
      evidence: ['table', 'facts'],
      densities: ['dense'],
      novelty: 0,
    }),
    Object.freeze({
      id: 'narrative-scorecard',
      family: 'scorecard',
      purposes: ['monitor', 'decide'],
      modes: ['divergent'],
      evidence: ['metrics', 'claims'],
      densities: ['light', 'balanced'],
      novelty: 2,
    }),
  ]),
});

const PPTX_VARIANTS = Object.freeze({
  cover: Object.freeze([
    Object.freeze({ variant: 'editorial-left', family: 'editorial', modes: ['conservative', 'strong-fit'], novelty: 0 }),
    Object.freeze({ variant: 'minimal-focus', family: 'minimal', modes: ['strong-fit', 'divergent'], novelty: 1 }),
  ]),
  statement: Object.freeze([
    Object.freeze({ variant: 'metric-statement', family: 'evidence', purposes: ['decide', 'monitor'], evidence: ['metrics'], novelty: 0 }),
    Object.freeze({ variant: 'typographic-statement', family: 'typography', purposes: ['decide', 'explain'], evidence: ['narrative'], novelty: 1 }),
  ]),
  metrics: Object.freeze([
    Object.freeze({ variant: 'asymmetric-metrics', family: 'evidence', purposes: ['decide', 'monitor'], modes: ['conservative', 'strong-fit'], novelty: 0 }),
    Object.freeze({ variant: 'metric-band', family: 'rhythm', purposes: ['monitor', 'explain'], modes: ['strong-fit', 'divergent'], novelty: 1 }),
  ]),
  comparison: Object.freeze([
    Object.freeze({ variant: 'contrast-panels', family: 'comparison', modes: ['conservative', 'strong-fit'], novelty: 0 }),
    Object.freeze({ variant: 'aligned-evidence', family: 'evidence', modes: ['strong-fit', 'divergent'], novelty: 1 }),
  ]),
  process: Object.freeze([
    Object.freeze({ variant: 'horizontal-flow', family: 'process', modes: ['conservative', 'strong-fit'], novelty: 0 }),
    Object.freeze({ variant: 'staggered-flow', family: 'rhythm', modes: ['strong-fit', 'divergent'], novelty: 1 }),
  ]),
  chart: Object.freeze([
    Object.freeze({ variant: 'commentary-chart', family: 'evidence', purposes: ['decide', 'explain'], evidence: ['narrative'], novelty: 0 }),
    Object.freeze({ variant: 'chart-led', family: 'data', purposes: ['monitor', 'compare'], evidence: ['chart'], modes: ['strong-fit', 'divergent'], novelty: 1 }),
  ]),
  table: Object.freeze([
    Object.freeze({ variant: 'table-led', family: 'evidence', modes: ['conservative', 'strong-fit'], novelty: 0 }),
    Object.freeze({ variant: 'table-callout', family: 'comparison', modes: ['strong-fit', 'divergent'], novelty: 1 }),
  ]),
  split: Object.freeze([
    Object.freeze({ variant: 'visual-right', family: 'split', modes: ['conservative', 'strong-fit'], novelty: 0 }),
    Object.freeze({ variant: 'visual-left', family: 'editorial', modes: ['strong-fit', 'divergent'], novelty: 1 }),
  ]),
  content: Object.freeze([
    Object.freeze({ variant: 'evidence-right', family: 'evidence', purposes: ['decide', 'inspect'], evidence: ['visual'], novelty: 0 }),
    Object.freeze({ variant: 'editorial-wide', family: 'typography', purposes: ['explain'], evidence: ['narrative'], modes: ['strong-fit', 'divergent'], novelty: 1 }),
  ]),
  closing: Object.freeze([
    Object.freeze({ variant: 'decision-left', family: 'decision', modes: ['conservative', 'strong-fit'], novelty: 0 }),
    Object.freeze({ variant: 'decision-focus', family: 'minimal', modes: ['strong-fit', 'divergent'], novelty: 1 }),
  ]),
});

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function bucket(value, boundaries = [0, 1, 3, 8]) {
  const count = Math.max(0, Number(value) || 0);
  if (count <= boundaries[0]) return '0';
  if (count <= boundaries[1]) return '1';
  if (count <= boundaries[2]) return 'few';
  if (count <= boundaries[3]) return 'several';
  return 'many';
}

function rowsOf(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.values) ? value.values : [];
}

function textCount(value) {
  if (Array.isArray(value)) return value.filter((entry) => String(entry ?? '').trim()).length;
  return value == null || value === '' ? 0 : 1;
}

function normalizePurpose(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return PURPOSES.has(normalized) ? normalized : fallback;
}

function normalizeExpressionMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return EXPRESSION_MODES.has(normalized) ? normalized : 'strong-fit';
}

function defaultPurpose(format, input) {
  if (format === 'xlsx') return 'monitor';
  if (format === 'csv' || format === 'tsv') return 'inspect';
  if (input?.content?.decision) return 'decide';
  return 'explain';
}

function normalizedRecentCompositions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(plainObject)
    .slice(0, 24)
    .map((entry) => ({
      fingerprint: String(entry.fingerprint || ''),
      format: String(entry.format || ''),
      profile: String(entry.profile || ''),
      purpose: String(entry.purpose || ''),
      expressionMode: String(entry.expressionMode || ''),
      compositionIds: Array.isArray(entry.compositionIds)
        ? entry.compositionIds.map((id) => String(id || '')).filter(Boolean).slice(0, 64)
        : [],
      createdAt: String(entry.createdAt || ''),
    }));
}

export function resolveOfficeCompositionContext(format, input = {}, {
  recentCompositions = [],
} = {}) {
  const normalizedFormat = String(format || '').toLowerCase();
  const composition = plainObject(input.composition) ? input.composition : {};
  const fallbackPurpose = defaultPurpose(normalizedFormat, input);
  return {
    purpose: normalizePurpose(input.purpose || composition.purpose, fallbackPurpose),
    expressionMode: normalizeExpressionMode(input.expressionMode || composition.expressionMode),
    recentCompositions: normalizedRecentCompositions(recentCompositions),
  };
}

export function officeContentTopology(format, operation = {}, design = {}) {
  const sections = Array.isArray(operation.sections) ? operation.sections : [];
  const tableRows = Math.max(
    rowsOf(operation.table).length,
    ...sections.map((section) => rowsOf(section?.table).length),
  );
  const metrics = Array.isArray(operation.metrics) ? operation.metrics.length : 0;
  const columns = Array.isArray(operation.columns) ? operation.columns.length : 0;
  const steps = Array.isArray(operation.steps) ? operation.steps.length : 0;
  const rows = Array.isArray(operation.rows) ? operation.rows.length : 0;
  const chartSeries = Array.isArray(operation.chart?.series) ? operation.chart.series.length : 0;
  const paragraphs = textCount(operation.body)
    + textCount(operation.bullets)
    + sections.reduce((total, section) => (
      total + textCount(section?.paragraphs || section?.body) + textCount(section?.bullets)
    ), 0);
  const facts = Array.isArray(design.content?.facts) ? design.content.facts.length : 0;
  const claims = Array.isArray(design.content?.claims) ? design.content.claims.length : 0;
  const evidence = [];
  if (metrics) evidence.push('metrics');
  if (tableRows || rows) evidence.push('table');
  if (operation.chart || chartSeries) evidence.push('chart');
  if (operation.image || operation.imagePath) evidence.push('image');
  if (operation.visualText) evidence.push('visual');
  if (columns) evidence.push('comparison');
  if (steps) evidence.push('process');
  if (paragraphs) evidence.push('narrative');
  if (facts) evidence.push('facts');
  if (claims) evidence.push('claims');
  const weight = metrics * 2 + columns * 2 + steps + Math.ceil((rows + tableRows) / 4) + paragraphs + claims;
  const density = weight >= 14 ? 'dense' : weight <= 4 ? 'light' : 'balanced';
  const signature = [
    String(format || '').toLowerCase(),
    `m:${bucket(metrics)}`,
    `c:${bucket(columns)}`,
    `s:${bucket(steps)}`,
    `r:${bucket(rows + tableRows, [0, 3, 10, 24])}`,
    `p:${bucket(paragraphs)}`,
    `e:${evidence.sort().join(',')}`,
  ].join('|');
  return {
    metrics,
    columns,
    steps,
    rows,
    tableRows,
    chartSeries,
    paragraphs,
    sections: sections.length,
    facts,
    claims,
    evidence,
    density,
    signature,
  };
}

function recentPenalty(context, candidateId) {
  return context.recentCompositions.slice(0, 8).reduce((total, entry, index) => (
    entry.compositionIds.includes(candidateId)
      ? total + Math.max(1, 4 - Math.floor(index / 2))
      : total
  ), 0);
}

function stableTie(seed, id) {
  return Number.parseInt(sha256(`${seed}\0${id}`).slice(0, 8), 16) / 0xFFFFFFFF;
}

function selectCandidate(candidates, {
  context,
  topology,
  density,
  seed,
  usage,
  explicitVariant = '',
}) {
  const evidence = new Set(topology.evidence);
  const ranked = candidates.map((candidate) => {
    const candidateId = String(candidate.id || candidate.variant || '');
    let score = 0;
    if (candidate.purposes?.includes(context.purpose)) score += 18;
    else if (candidate.purposes?.length) score -= 6;
    if (candidate.modes?.includes(context.expressionMode)) score += 5;
    if (candidate.densities?.includes(density || topology.density)) score += 3;
    score += (candidate.evidence || []).filter((entry) => evidence.has(entry)).length * 3;
    if (context.expressionMode === 'divergent') score += Number(candidate.novelty || 0) * 3;
    if (context.expressionMode === 'conservative') score -= Number(candidate.novelty || 0) * 2;
    if (explicitVariant && (candidate.variant === explicitVariant || candidate.id === explicitVariant)) score += 100;
    const historyPenalty = recentPenalty(context, candidateId);
    score -= historyPenalty;
    score -= (usage.get(candidateId) || 0) * 7;
    score += stableTie(seed, candidateId);
    return { candidate, candidateId, score, historyPenalty };
  });
  ranked.sort((left, right) => right.score - left.score || left.candidateId.localeCompare(right.candidateId));
  return ranked[0];
}

function resolvedPptxKind(operation, topology) {
  const requested = String(operation.kind || 'content').toLowerCase();
  if (requested !== 'content' || operation.layoutId) return requested;
  if (operation.chart) return 'chart';
  if (operation.table) return 'table';
  if (topology.metrics >= 2) return 'metrics';
  if (topology.columns >= 2) return 'comparison';
  if (topology.steps >= 2) return 'process';
  if (operation.image || operation.imagePath) return 'split';
  return 'content';
}

export function planOfficeComposition(format, operation = {}, design = {}, {
  usage = new Map(),
} = {}) {
  const normalizedFormat = String(format || '').toLowerCase();
  const topology = officeContentTopology(normalizedFormat, operation, design);
  const context = {
    purpose: normalizePurpose(operation.purpose, design.purpose || 'explain'),
    expressionMode: normalizeExpressionMode(operation.expressionMode || design.expressionMode),
    recentCompositions: normalizedRecentCompositions(design.recentCompositions),
  };
  const seed = design.content?.fingerprint
    || [design.intent, design.audience, design.signature, operation.title, topology.signature].join('|');
  if (normalizedFormat === 'pptx') {
    const kind = resolvedPptxKind(operation, topology);
    if (plainObject(operation.plan) && Array.isArray(operation.plan.regions)) {
      const regionSignature = operation.plan.regions.map((region) => ({
        role: String(region?.role || ''),
        box: Array.isArray(region?.box)
          ? region.box.map((value) => Math.round(Number(value) || 0))
          : [
              region?.x ?? region?.left,
              region?.y ?? region?.top,
              region?.w ?? region?.width,
              region?.h ?? region?.height,
            ].map((value) => Math.round(Number(value) || 0)),
        direction: String(region?.direction || region?.layout || ''),
      }));
      const fingerprint = sha256({
        kind,
        units: String(operation.plan.units || 'percent'),
        regions: regionSignature,
        readingOrder: operation.plan.readingOrder || [],
      }).slice(0, 16);
      const result = {
        id: `${kind}:model:${fingerprint}`,
        family: 'model-authored',
        kind,
        variant: String(operation.plan.name || operation.plan.visualType || 'custom'),
        purpose: context.purpose,
        expressionMode: context.expressionMode,
        topology,
        historyPenalty: recentPenalty(context, `${kind}:model:${fingerprint}`),
        source: 'model-plan',
      };
      usage.set(result.id, (usage.get(result.id) || 0) + 1);
      return result;
    }
    const explicitVariant = String(operation.variant || '').trim().toLowerCase();
    const variants = PPTX_VARIANTS[kind] || PPTX_VARIANTS.content;
    const candidates = explicitVariant && !variants.some((entry) => entry.variant === explicitVariant)
      ? [...variants, { variant: explicitVariant, family: kind, novelty: 0 }]
      : variants;
    const selected = selectCandidate(candidates.map((entry) => ({
      ...entry,
      id: `${kind}:${entry.variant}`,
      purposes: entry.purposes || [context.purpose],
    })), {
      context,
      topology,
      density: design.density,
      seed,
      usage,
      explicitVariant,
    });
    const result = {
      id: selected.candidateId,
      family: selected.candidate.family,
      kind,
      variant: selected.candidate.variant,
      purpose: context.purpose,
      expressionMode: context.expressionMode,
      topology,
      historyPenalty: selected.historyPenalty,
      source: explicitVariant ? 'explicit' : 'content-planner',
    };
    usage.set(result.id, (usage.get(result.id) || 0) + 1);
    return result;
  }
  const candidates = FORMAT_CANDIDATES[normalizedFormat] || [{
    id: `${normalizedFormat || 'office'}-default`,
    family: 'default',
    purposes: [context.purpose],
    modes: [context.expressionMode],
    novelty: 0,
  }];
  const selected = selectCandidate(candidates, {
    context,
    topology,
    density: design.density,
    seed,
    usage,
    explicitVariant: String(operation.variant || '').trim().toLowerCase(),
  });
  const result = {
    id: selected.candidateId,
    family: selected.candidate.family,
    purpose: context.purpose,
    expressionMode: context.expressionMode,
    topology,
    historyPenalty: selected.historyPenalty,
    source: operation.variant ? 'explicit' : 'content-planner',
  };
  usage.set(result.id, (usage.get(result.id) || 0) + 1);
  return result;
}

export function summarizeOfficeCompositions(format, compositions = []) {
  const normalized = (Array.isArray(compositions) ? compositions : [])
    .map((entry) => entry?.composition || entry)
    .filter((entry) => plainObject(entry) && entry.id)
    .map((entry) => ({
      id: String(entry.id),
      family: String(entry.family || ''),
      kind: String(entry.kind || ''),
      purpose: String(entry.purpose || ''),
      topology: String(entry.topology?.signature || ''),
    }));
  if (!normalized.length) {
    return {
      format: String(format || '').toLowerCase(),
      fingerprint: '',
      compositionIds: [],
      count: 0,
    };
  }
  return {
    format: String(format || '').toLowerCase(),
    fingerprint: sha256({ format: String(format || '').toLowerCase(), sequence: normalized }),
    compositionIds: normalized.map((entry) => entry.id),
    count: normalized.length,
  };
}

export function reviewOfficeCompositionSequence({
  format,
  compositions = [],
  recentCompositions = [],
  allowRepetition = false,
} = {}) {
  const plans = (Array.isArray(compositions) ? compositions : [])
    .map((entry) => entry?.composition || entry)
    .filter((entry) => plainObject(entry) && entry.id);
  const summary = summarizeOfficeCompositions(format, plans);
  if (allowRepetition || !plans.length) return { summary, repeated: null, recentMatch: null };
  const eligible = plans.filter((entry) => !['cover', 'closing'].includes(String(entry.kind || '')));
  const counts = new Map();
  for (const entry of eligible) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
  const [repeatedId = '', repeatedCount = 0] = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0] || [];
  const repeated = eligible.length >= 4 && repeatedCount / eligible.length >= 0.75
    ? { id: repeatedId, count: repeatedCount, total: eligible.length }
    : null;
  const recentMatch = normalizedRecentCompositions(recentCompositions)
    .find((entry) => entry.fingerprint && entry.fingerprint === summary.fingerprint) || null;
  return { summary, repeated, recentMatch };
}
