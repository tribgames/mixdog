import { extname } from 'node:path';

const CRITICAL_CODES = new Set([
  'blank_page',
  'broken_chart',
  'empty_chart',
  'formula_error',
  'formula_error_truncated',
  'missing_relationship',
  'package_corrupt',
  'render_failed',
  'text_outside_slide',
]);

const POLISH_GUIDANCE = Object.freeze({
  blank_page: 'Remove the accidental page or rebalance preceding content so the page has a clear purpose.',
  sparse_page: 'Rebalance sections, tables, and page breaks instead of padding the page with decoration.',
  broken_chart: 'Rebuild the native chart from source-bound data, save, close, and verify the series after reopen.',
  empty_chart: 'Populate the chart embedded workbook from the cited source range, then verify seriesCount after reopen.',
  formula_error: 'Trace the formula to its source cells, fix the calculation, recalculate, and verify the displayed value.',
  chart_includes_total_row: 'Separate comparison rows from total or subtotal rows and narrow the chart source range.',
  worksheet_print_too_small: 'Recompose the sheet for one-page-wide reading; move support data off the dashboard if needed.',
  worksheet_print_fit_missing: 'Set a deliberate print area, landscape orientation when useful, and one-page-wide fitting.',
  heading_hierarchy_missing: 'Create a clear title and heading hierarchy that matches the document reading path.',
  orphan_heading: 'Keep the heading with the paragraph or table it introduces.',
  short_table_split: 'Keep the short table together or move it intact to the next page.',
  shape_overlap: 'Move or resize the reported shapes while preserving a consistent alignment grid.',
  text_overflow: 'Shorten the copy or enlarge the text area before reducing type size.',
  small_font: 'Reduce content density or split the slide; keep presentation body text at least 12 pt.',
  meaningful_visual_missing: 'Replace generic text blocks with a chart, table, image, or subject-specific diagram that proves the claim.',
  native_evidence_too_weak: 'Add source-bound native evidence to the slides carrying material claims.',
  repetitive_composition: 'Choose a different semantic layout that matches this slide’s evidence and role.',
  card_grid_overuse: 'Replace repeated cards with one dominant hierarchy, comparison, process, chart, or table.',
  number_without_source: 'Add a source note that identifies the workbook cell, range, or external document.',
  generic_takeaway: 'Rewrite the title as a specific conclusion or decision, not a topic label.',
});

export function resolveOfficeRenderOutput(path) {
  const value = String(path || '');
  if (extname(value).toLowerCase() === '.pdf') return value;
  return value.replace(/\.[^./\\]+$/u, '') + '.pdf';
}

export function normalizeOfficeReviewIssues(entries = []) {
  const seen = new Set();
  const output = [];
  for (const raw of entries || []) {
    if (!raw || typeof raw !== 'object') continue;
    const issue = {
      ...raw,
      severity: CRITICAL_CODES.has(String(raw.code || ''))
        ? 'error'
        : String(raw.severity || 'warning'),
    };
    const key = `${issue.severity}\0${issue.code}\0${issue.path}\0${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(issue);
  }
  return output;
}

export function buildOfficePolishPlan({
  format = '',
  issues = [],
} = {}) {
  const normalized = normalizeOfficeReviewIssues(issues);
  const targets = new Map();
  for (const issue of normalized) {
    const path = String(issue.path || '/');
    const current = targets.get(path) || {
      path,
      severity: 'warning',
      codes: [],
      actions: [],
    };
    if (issue.severity === 'error') current.severity = 'error';
    if (!current.codes.includes(issue.code)) current.codes.push(issue.code);
    const guidance = POLISH_GUIDANCE[issue.code]
      || `Correct ${issue.code} at ${path}, then render and inspect the affected page again.`;
    if (!current.actions.includes(guidance)) current.actions.push(guidance);
    targets.set(path, current);
  }
  const ordered = [...targets.values()].sort((left, right) => (
    Number(right.severity === 'error') - Number(left.severity === 'error')
    || left.path.localeCompare(right.path)
  ));
  return {
    format: String(format || '').toLowerCase(),
    status: ordered.length ? 'needs-polish' : 'pass',
    targetCount: ordered.length,
    criticalCount: ordered.filter((entry) => entry.severity === 'error').length,
    targets: ordered,
    nextAction: ordered.length
      ? 'Edit only the reported targets in one atomic batch, render the changed pages, then run QA again.'
      : 'No targeted polish remains.',
  };
}

export function evaluateOfficeSubmissionGate({
  issues = [],
  persisted = null,
  visualCoverage = null,
} = {}) {
  const normalized = normalizeOfficeReviewIssues(issues);
  const blocking = normalized.filter((issue) => issue.severity === 'error');
  if (persisted === false) {
    blocking.push({
      severity: 'error',
      code: 'post_save_reopen_missing',
      path: '/',
      message: 'The saved Office document was not reopened, so persistence is unproven.',
      source: 'post-save-gate',
    });
  }
  if (visualCoverage && visualCoverage.complete !== true) {
    blocking.push({
      severity: 'error',
      code: 'visual_coverage_incomplete',
      path: '/',
      message: 'Not every rendered page or slide was reviewed.',
      source: 'render-review',
    });
  }
  return {
    ok: blocking.length === 0,
    persisted,
    criticalCount: blocking.length,
    blocking,
  };
}

export function officeCriticalIssueCodes() {
  return [...CRITICAL_CODES].sort();
}

