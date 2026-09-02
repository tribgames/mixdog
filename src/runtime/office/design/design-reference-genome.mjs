import { compact, plainObject } from '../shared/values.mjs';

const PROHIBITED_MOTIFS = Object.freeze([
  'decorative-stripe',
  'one-sided-border',
  'title-underline',
  'equal-card-grid',
  'generic-stock-image',
]);

function strings(value) {
  return (Array.isArray(value) ? value : [value])
    .map((entry) => compact(entry, 180))
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function layoutPatterns(design, selected) {
  const referenced = (Array.isArray(design?.layouts) ? design.layouts : []).flatMap((layout) => [
    layout?.kind,
    layout?.family,
    layout?.variant,
    ...(Array.isArray(layout?.tags) ? layout.tags : []),
  ]);
  return unique([
    ...strings(selected?.deck?.layoutBias),
    ...strings(referenced),
  ]).slice(0, 12);
}

export function compilePptxReferenceGenome(design = {}) {
  const direction = plainObject(design?.artDirection) ? design.artDirection : {};
  const selected = plainObject(direction.selected) ? direction.selected : {};
  const deck = plainObject(selected.deck)
    ? selected.deck
    : plainObject(selected.creativeSystem)
      ? selected.creativeSystem
      : {};
  const referenceId = compact(
    design?.library?.template?.id
      || design?.library?.pack?.id
      || selected.id
      || design.profile
      || 'mixdog-reference',
    80,
  );
  const motifRules = unique(strings(deck.motifRules || selected.creativeSystem?.motifRules))
    .filter((rule) => !/(decorative stripe|one-sided border|title underline|equal card grid)/iu.test(rule));
  return {
    version: 1,
    id: `${referenceId}:${direction.seedFingerprint || 'default'}`,
    source: compact(design?.library?.source || direction.source || design.source || 'mixdog-reference', 120),
    subjectDomain: compact(direction.subjectDomain || 'subject-seeded', 80),
    directionId: compact(selected.id || design.profile, 80),
    grid: compact(deck.grid || selected.creativeSystem?.grid, 240),
    shapeLanguage: compact(deck.shapeLanguage || selected.creativeSystem?.shapeLanguage, 240),
    chartTreatment: compact(deck.chartTreatment || selected.creativeSystem?.chartTreatment, 240),
    imageTreatment: compact(deck.imageTreatment || 'source-contained', 120),
    layoutPatterns: layoutPatterns(design, selected),
    densityPattern: strings(deck.densityPattern || selected.creativeSystem?.densityPattern).slice(0, 8),
    motifRules,
    typographyRatio: {
      titleToBody: 2.65,
      dataToBody: 1.45,
      captionToBody: 0.8,
    },
    whitespaceTargets: {
      light: 0.46,
      balanced: 0.33,
      dense: 0.23,
    },
    margins: {
      outer: 6,
      inner: 2.2,
    },
    prohibitedMotifs: [...PROHIBITED_MOTIFS],
    coordinatePolicy: 'constraints-only',
  };
}

function operationEvidenceKind(operation = {}) {
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

export function directPptxAssetIntent(operation = {}, brief = {}) {
  const evidenceKind = operationEvidenceKind(operation);
  const source = compact(
    operation.source
      || operation.image?.source
      || brief?.evidence?.source,
    240,
  );
  const kind = evidenceKind === 'chart'
    ? 'native-chart'
    : evidenceKind === 'allocation' || evidenceKind === 'comparison'
      ? 'native-relationship-diagram'
      : evidenceKind === 'timeline'
        ? 'native-process-diagram'
        : evidenceKind === 'scorecard'
          ? 'native-metric-composition'
          : evidenceKind === 'decision-matrix'
            ? 'native-decision-matrix'
            : evidenceKind === 'image'
              ? 'source-image'
              : 'typographic-statement';
  const sourceSpecific = kind === 'source-image'
    ? Boolean(operation.image?.path || operation.imagePath || source)
    : kind !== 'typographic-statement';
  return {
    kind,
    evidenceKind,
    required: !['opening', 'decision-close'].includes(String(brief?.role || ''))
      && kind !== 'typographic-statement',
    dominance: ['opening', 'decision-close'].includes(String(brief?.role || '')) ? 'supporting' : 'dominant',
    editability: kind === 'source-image' ? 'raster-source' : 'native-editable',
    sourceSpecific,
    source,
    fallback: kind === 'source-image' ? 'fail-without-source' : 'native-evidence',
    prohibitedFallbacks: ['generic-stock-image', 'decorative-motif'],
  };
}
