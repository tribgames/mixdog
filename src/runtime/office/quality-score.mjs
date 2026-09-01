const HARD_WARNING_CODES = new Set([
  'blank_page',
  'content_touches_page_edge',
  'edge_margin',
  'heading_table_separation',
  'low_contrast',
  'number_without_source',
  'orphan_heading',
  'shape_overlap',
  'short_table_split',
  'small_font',
  'text_outside_slide',
  'text_overflow',
  'text_spacing_tight',
  'worksheet_print_too_small',
]);

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function rounded(value, digits = 4) {
  return Number((Number(value) || 0).toFixed(digits));
}

function issuePenalty(issue) {
  const severity = String(issue?.severity || '').toLowerCase();
  if (severity === 'error') return 0.18;
  if (severity !== 'warning') return 0;
  return HARD_WARNING_CODES.has(String(issue?.code || '')) ? 0.07 : 0.03;
}

export function scoreOfficeReleaseQuality({
  format = '',
  aesthetics = null,
  issues = [],
  renderedPages = 0,
  expectedPages = 0,
  structuralAvailable = false,
  planCoverage = 0,
} = {}) {
  const renderScore = Number.isFinite(Number(aesthetics?.score))
    ? clamp(Number(aesthetics.score))
    : 0;
  const issueList = Array.isArray(issues) ? issues : [];
  const structuralPenalty = Math.min(0.85, issueList.reduce(
    (total, issue) => total + issuePenalty(issue),
    0,
  ));
  const structuralScore = clamp(1 - structuralPenalty);
  const score = aesthetics
    ? (renderScore * 0.72) + (structuralScore * 0.28)
    : structuralScore * 0.55;
  const pageCoverage = expectedPages > 0
    ? clamp(Number(renderedPages) / Number(expectedPages))
    : renderedPages > 0 ? 1 : 0;
  const normalizedFormat = String(format || '').toLowerCase();
  const normalizedPlanCoverage = normalizedFormat === 'pptx' ? clamp(planCoverage) : 1;
  const confidence = (aesthetics ? 0.45 : 0)
    + (structuralAvailable ? 0.3 : 0)
    + (pageCoverage * 0.15)
    + (normalizedPlanCoverage * 0.1);
  const blocking = issueList.filter((issue) => ['error', 'warning'].includes(
    String(issue?.severity || '').toLowerCase(),
  ));
  return {
    version: 2,
    score: rounded(score),
    confidence: rounded(clamp(confidence)),
    releaseReady: blocking.length === 0 && score >= 0.7,
    dimensions: {
      render: rounded(renderScore),
      structural: rounded(structuralScore),
    },
    evidence: {
      renderedPages: Math.max(0, Number(renderedPages) || 0),
      expectedPages: Math.max(0, Number(expectedPages) || 0),
      pageCoverage: rounded(pageCoverage),
      planCoverage: rounded(normalizedPlanCoverage),
      structuralAvailable: structuralAvailable === true,
      blockingIssueCount: blocking.length,
    },
  };
}
