import { extname } from 'node:path';

const CRITICAL_CODES = new Set([
  'blank_page',
  'broken_chart',
  'empty_chart',
  'formula_error',
  'formula_error_truncated',
  'missing_relationship',
  'package_corrupt',
  'recent_composition_repeat',
  'repeated_layout_grammar',
  'repeated_render_composition',
  'render_failed',
  'repetitive_composition',
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
  art_direction_candidates_missing: 'Create three subject-specific art directions, select one, and carry its palette, typography, motif, and image treatment through the deck.',
  flat_visual_rhythm: 'Vary background roles, density, focal scale, and evidence treatment while preserving the selected art direction.',
  low_visual_contrast: 'Increase figure-ground contrast without adding decoration; verify the rendered page again.',
  repeated_layout_grammar: 'Replace repeated spatial grammar with a different evidence-led composition.',
  repeated_render_composition: 'Recompose the repeated slides so their rendered reading paths and evidence structures are visibly distinct.',
  slide_visual_density_low: 'Add claim-bearing evidence or strengthen the focal hierarchy instead of filling the slide with ornament.',
  visual_role_variety_low: 'Use at least three evidence roles across the deck, such as image, chart, process, comparison, table, or typographic statement.',
  creative_direction_missing: 'Define the thesis, narrative arc, evidence map, motif, and per-slide creative brief before authoring the deck.',
  semantic_visual_plan_missing: 'Assign a semantic visual treatment that directly explains the slide claim.',
  generic_visual_treatment: 'Replace the generic chart, table, process, metric, or comparison treatment with a subject-specific annotated visual.',
  default_chart_treatment: 'Add decision-relevant annotations, native data labels, and a commentary rail to the chart.',
  raw_table_slide: 'Convert the raw table into a scorecard, decision matrix, or proportional allocation field.',
  under_composed_structure: 'Strengthen the focal evidence and supporting visual hierarchy instead of leaving the canvas structurally empty.',
  under_composed_slide: 'Recompose the slide so the rendered canvas carries a deliberate focal field and supporting evidence.',
  frontier_aesthetic_score_low: 'Raise contrast, palette discipline, role-aware composition, and deck rhythm before release.',
  opening_closing_grammar_repeat: 'Give the closing a distinct decision grammar instead of repeating the opening composition.',
  narrative_arc_weak: 'Rebuild the sequence around distinct opening, proof, choice, execution, and decision-close beats.',
  worksheet_visual_clutter: 'Separate the decision dashboard from supporting calculations and simplify the visible grid.',
  repetitive_composition: 'Choose a different semantic layout that matches this slide’s evidence and role.',
  recent_composition_repeat: 'Recompose the document-level hierarchy and evidence sequence while preserving the Brand kit tokens and facts.',
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
