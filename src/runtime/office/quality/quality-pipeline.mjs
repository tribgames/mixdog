import { extname } from 'node:path';

// Measurable integrity faults: the file is broken, unreadable, or lies about
// its own fit. Only these block a submission.
const CRITICAL_CODES = new Set([
  'accent_hue_overuse',
  'blank_page',
  'broken_chart',
  'chart_axis_undeclared',
  'chart_stacked_label_position',
  'empty_chart',
  'font_family_overuse',
  'formula_error',
  'formula_error_truncated',
  'missing_relationship',
  'package_corrupt',
  'render_failed',
  'text_outside_slide',
  'unsafe_font_family',
]);

// Taste and layout judgements. The author (the model) owns composition; the
// runtime reports these as information and never grades a layout choice,
// blocks on them, or lists them as polish targets. They stay in the issue list
// so a reviewer can read them, and a caller may still fail on them explicitly.
export const ADVISORY_CODES = new Set([
  'adaptive_layout_rhythm_flat',
  'adaptive_layout_selection_missing',
  'art_direction_candidates_missing',
  'card_grid_overuse',
  'creative_direction_missing',
  'default_chart_treatment',
  'emphasis_mismatch',
  'excessive_slide_text',
  'flat_visual_rhythm',
  'frontier_aesthetic_score_low',
  'generic_motif_selected',
  'generic_visual_treatment',
  'layout_visual_imbalance',
  'layout_whitespace_mismatch',
  'meaningful_visual_missing',
  'narrative_arc_weak',
  'native_evidence_too_weak',
  'opening_closing_grammar_repeat',
  'plan_count_mismatch',
  'plan_promise_missing',
  'raw_table_slide',
  'recent_composition_repeat',
  'reference_genome_missing',
  'repeated_layout_grammar',
  'repeated_render_composition',
  'repetitive_composition',
  'semantic_visual_plan_missing',
  'slide_visual_density_low',
  'theme_body_backgrounds',
  'under_composed_slide',
  'under_composed_structure',
  'vertical_imbalance',
  'visual_reference_selection_missing',
  'visual_role_variety_low',
]);

export function isAdvisoryOfficeIssue(issue) {
  return ADVISORY_CODES.has(String(issue?.code || '')) || String(issue?.severity || '') === 'info';
}

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
  font_family_overuse: 'Restyle the slide with fontRole display, body, and data only; drop every extra typeface.',
  unsafe_font_family: 'Replace the reported typefaces with the deck typography roles; Aptos, Segoe UI, Consolas, and similar faces substitute unpredictably.',
  accent_hue_overuse: 'Recolor cards, labels, and chips to palette roles so one accent dominates and at most one secondary hue remains.',
  emphasis_mismatch: 'Enlarge the evidence or thesis the brief names as primary and shrink the element that currently outweighs it.',
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
  number_without_fact: 'Add the figure to the brief facts line with its source (F<n> <value> — <source>), or remove it from the slide.',
  facts_missing: 'Write the brief facts line: every figure the deck shows, each with a source, before authoring again.',
  plan_promise_missing: 'Advisory: the slide does not seem to carry what its plan line names; keep it if the composition is deliberate, else update the plan line or the slide.',
  plan_count_mismatch: 'Advisory: the slide plan and the deck disagree on the slide count; update whichever is stale.',
  // Package faults PowerPoint refuses (script-authored charts).
  chart_stacked_label_position: 'Set dataLabelPosition to ctr, inEnd, or inBase on the stacked chart; outEnd makes PowerPoint refuse the file.',
  chart_axis_undeclared: 'Give the combo chart valAxes and catAxes with two entries each, or drop secondaryValAxis / secondaryCatAxis from the series; PowerPoint discards the chart otherwise.',
  // Editability (a slide, not a picture of one).
  text_fragmentation: 'Merge the stacked single-line text boxes into one text box with paragraphs (breakLine between items) so the copy reflows and edits as a unit.',
  dead_vector_chart: 'Replace the rectangles with a native chart (addChart / the kit chart()) so the values stay editable and re-sortable.',
  // Text fit and placement (portable review).
  text_clipped: 'Enlarge the box or shorten the copy; text cut at a box edge is always visible to the reader.',
  text_box_too_narrow: 'Widen the text box so lines wrap at a readable measure instead of one or two words per line.',
  shape_out_of_bounds: 'Move or resize the shape inside the 13.33 × 7.5 canvas; nothing past the edge is shown.',
  shapes_too_close: 'Open the gap between the shapes to at least 0.3 in, or merge them into one block.',
  vertical_imbalance: 'Move the content down into the field or enlarge the containers so the canvas is filled with intent, not a hollow bottom.',
  stat_label_detached: 'Bring the label to within 36 pt of its numeral so the pair reads as one unit.',
  low_contrast: 'Raise the text or background to 4.5:1 (3:1 at 18 pt or bold 14 pt); a scrim under text on a picture, a darker ink, or a lighter field.',
  font_unavailable: 'Use a face from the safe list so the fit review and the recipient render the same widths.',
  placeholder_text: 'Replace or delete the leftover template wording; placeholder copy never ships.',
  unfilled_token: 'Fill or remove the unresolved template token before finalize.',
  image_aspect_distorted: 'Crop the picture to the frame ratio (the kit picture() does) instead of stretching it.',
  // Structure and render review (pptx).
  content_touches_page_edge: 'Pull the content inside the safe margin; nothing sits against the canvas edge unless it bleeds on purpose (a picture, a band).',
  edge_margin: 'Keep at least 0.5 in between content and the canvas edge, or make the element a deliberate bleed.',
  text_spacing_tight: 'Raise the line spacing to at least 1.05× the size (the kit leading: dense 1.4, body 1.5).',
  dense_paragraph: 'Split the paragraph, cut the copy, or give it a slide of its own as prose; a wall of text is not evidence.',
  heading_hierarchy_jump: 'Restore the skipped heading level so the outline reads in order.',
  worksheet_hierarchy_missing: 'Give the sheet a title row, labelled headers, and one reading order before the data.',
  theme_background_drift: 'Use only the ladder backgrounds (paper, paperAlt, dark, darkAlt); recolor the drifting slide.',
  theme_body_backgrounds: 'Keep body slides on the paper ladder; a dark field is a beat (cover, section, statement), not a body page.',
  excessive_slide_text: 'Cut the copy to the reading mode\'s budget (composition.md §4) or split the slide.',
  decorative_stripe: 'Remove the ornamental bar; a stripe that encodes nothing is decoration (composition.md §10).',
  // Visual critique contract (finalize).
  visual_critique_incomplete: 'Give every slide five 1-5 scores, a slide-specific note of 40+ characters, and three checks derived from its plan line.',
  visual_critique_missing_slide: 'Add the critique entry for the slide the finalize call left out.',
  visual_critique_invalid_slide: 'Point each critique entry at an existing slide index, once.',
  visual_critique_needs_polish: 'Apply the listed fixes and failed checks in the script, author again, and critique the slide again.',
  visual_critique_repeated_note: 'Write each note from that slide\'s own content; a copied note is not a review.',
  // Composer-plan review (frontier).
  adaptive_layout_selection_missing: 'Decide each slide\'s composition move from its relationship and job (composition.md §0-§2) and name it in the plan.',
  layout_capacity_overflow: 'Cut or split the content that exceeds the structure\'s capacity; never shrink the type to fit.',
  layout_whitespace_mismatch: 'Match the air to the role: beats breathe, evidence slides fill the field.',
  layout_visual_imbalance: 'Rebalance the slide so the focal element and its support share the canvas by weight.',
  generic_motif_selected: 'Replace the generic motif with the style\'s own device, tied to the subject.',
  reference_genome_missing: 'Select and record the visual style the deck follows (direction.md §3-§4) before composing.',
  visual_reference_selection_missing: 'Select and record the visual style the deck follows (direction.md §3-§4) before composing.',
  source_specific_asset_missing: 'Add the subject-specific asset (picture, diagram, chart from the source) where the plan promised one.',
  freeform_compile_missing: 'Author the slide as a script scene on the kit primitives with its layer contract instead of a placeholder plan.',
  freeform_layer_contract_missing: 'Author the slide as a script scene on the kit primitives with its layer contract instead of a placeholder plan.',
  authored_scene_missing: 'Author the slide as a script scene on the kit primitives with its layer contract instead of a placeholder plan.',
  adaptive_layout_rhythm_flat: 'Alternate composition moves and densities across adjacent slides so the deck has rhythm.',
  post_save_reopen_missing: 'Reopen the saved file and verify the review evidence after saving.',
  visual_coverage_incomplete: 'Render and inspect every page before finalize; the visual coverage must be complete.',
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
    const code = String(raw.code || '');
    const issue = {
      ...raw,
      severity: CRITICAL_CODES.has(code)
        ? 'error'
        : ADVISORY_CODES.has(code)
          ? 'info'
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
    if (issue.severity === 'info') continue;   // advisory: the author's call, not a polish target
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
