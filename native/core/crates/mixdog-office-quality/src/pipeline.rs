//! `quality-pipeline.mjs`: issue normalisation, the split between blocking integrity faults and advisory taste
//! observations, the polish plan, and the submission gate.
//!
//! Measurable integrity faults (the file is broken, unreadable, or lies about its own fit) are the only codes that
//! block a submission. Two blocks in each other's space, and words the box cannot hold, are measured collisions rather
//! than layout taste, and a text box past the canvas is one as PowerPoint measures it and as the portable audit does.
//! Taste and layout judgements stay in the issue list as information: the author owns composition, so the runtime
//! never grades a layout choice, blocks on it, or lists it as a polish target. `plan_promise_missing` is deliberately
//! absent from the advisory codes: the page was designed for the carrier its own plan line named, so a page without it
//! is a defect the author gate already refuses.

use std::collections::HashMap;

use mixdog_js::{js_sort_by, js_to_lowercase, locale_compare};
use serde_json::{Map, Value, json};

use crate::issue::issue_with;
use crate::{field, is_truthy, template_text, text_or};

/// Measurable integrity faults: the only codes that block a submission.
const CRITICAL_CODES: &[&str] = &[
    "blank_image",
    "blank_page",
    "broken_chart",
    "chart_axis_undeclared",
    "chart_stacked_label_position",
    "empty_chart",
    "formula_error",
    "formula_error_truncated",
    "missing_relationship",
    "package_corrupt",
    "render_failed",
    "shape_overlap",
    "shape_out_of_bounds",
    "text_outside_slide",
    "text_overflow",
];

/// Taste and layout judgements: reported as information, never graded, blocked on or polished.
const ADVISORY_CODES: &[&str] = &[
    "accent_hue_overuse",
    "adaptive_layout_rhythm_flat",
    "adaptive_layout_selection_missing",
    "art_direction_candidates_missing",
    "beat_share_high",
    "card_grid_overuse",
    "page_underfill",
    "consecutive_beats",
    "consecutive_composition_repeat",
    "creative_direction_missing",
    "decorative_stripe",
    "default_chart_treatment",
    "emphasis_mismatch",
    "excessive_slide_text",
    "fact_without_locator",
    "facts_illustrative",
    "flat_visual_rhythm",
    "font_family_overuse",
    "frontier_aesthetic_score_low",
    "generic_motif_selected",
    "generic_visual_treatment",
    "layout_visual_imbalance",
    "layout_whitespace_mismatch",
    "meaningful_visual_missing",
    "narrative_arc_weak",
    "native_evidence_too_weak",
    "opening_closing_grammar_repeat",
    "plan_count_mismatch",
    "raw_table_slide",
    "recent_composition_repeat",
    "reference_genome_missing",
    "repeated_layout_grammar",
    "repeated_render_composition",
    "repetitive_composition",
    "semantic_visual_plan_missing",
    "slide_visual_density_low",
    "theme_body_backgrounds",
    "title_line_hollow",
    "under_composed_slide",
    "under_composed_structure",
    "vertical_imbalance",
    "visual_reference_selection_missing",
    "visual_role_variety_low",
];

/// What to do about each code, shown in the polish plan.
const POLISH_GUIDANCE: &[(&str, &str)] = &[
    ("blank_page", "Remove the accidental page or rebalance preceding content so the page has a clear purpose."),
    ("sparse_page", "Rebalance sections, tables, and page breaks instead of padding the page with decoration."),
    ("page_bottom_empty", "Let a long table break across the page, move a shorter block up, or tighten the blocks above; never pad the foot with decoration."),
    ("broken_chart", "Rebuild the native chart from source-bound data, save, close, and verify the series after reopen."),
    ("empty_chart", "Populate the chart embedded workbook from the cited source range, then verify seriesCount after reopen."),
    ("formula_error", "Trace the formula to its source cells, fix the calculation, recalculate, and verify the displayed value."),
    ("unquoted_sheet_reference", "Quote the sheet name in the reference ('My Sheet'!B5); an unquoted multi-word name evaluates to #VALUE!."),
    ("external_link_reference", "Copy the linked value into a sourced input cell and reference that cell; the external workbook is not available here."),
    ("percentage_stored_as_whole", "Store the percentage as a fraction (0.15 for 15%) or change the number format; a whole number under a % format renders ×100."),
    ("number_stored_as_text", "Write the figure as a number and put the separators or percent sign in the column format; text never sums or sorts as a number."),
    ("header_not_frozen", "Freeze the header row (freeze_panes) so the column names stay in view while the reader scrolls."),
    ("numeric_column_unformatted", "Give the numeric column an explicit number format (#,##0, 0.0%, yyyy-mm-dd) through set_style or columnFormats."),
    ("year_with_thousands_separator", "Format year cells as text or 0 so 2024 does not render as 2,024."),
    ("inline_constant_in_formula", "Move the constant into its own labelled assumption cell and reference it from the formula."),
    ("unguarded_division", "Wrap the division in IFERROR or guard the denominator with IF so a zero input does not spread #DIV/0!."),
    ("formula_pattern_inconsistency", "Copy the row or column pattern back over the odd cell, or document why this period is computed differently."),
    ("formula_reads_beyond_data", "Point the reference at the populated cell it was meant to read; snapshot the range and check the value the formula pulls."),
    ("formula_inconsistency", "Replace the hardcoded value with the formula its neighbours use, or move the override into an assumption cell."),
    ("rogue_hardcode", "Replace the pasted result with the formula that produces it, or mark the cell as an input with its source."),
    ("input_cells_unmarked", "Mark input cells (blue font, or a fill where the reader edits) and add a short legend naming the convention."),
    ("chart_includes_total_row", "Separate comparison rows from total or subtotal rows and narrow the chart source range."),
    ("chart_stops_short_of_data", "Widen the series range to the last data row, or move the rows the chart leaves out if they do not belong to it."),
    ("worksheet_print_too_small", "Recompose the sheet for one-page-wide reading; move support data off the dashboard if needed."),
    ("worksheet_print_fit_missing", "Set a deliberate print area, landscape orientation when useful, and one-page-wide fitting."),
    ("drawing_outside_print_area", "Set a print area that contains the chart or picture (set_page_setup with fitToContent, or an explicit printArea); an export otherwise splits or drops it."),
    ("drawing_overlap", "Anchor the second chart or picture below or beside the first (its cell past the rows or columns the first one spans — a 230 pt chart covers about 15 rows); one drawing over another hides both."),
    ("drawing_covers_cells", "Move the chart or picture clear of the filled cells (set_drawing, or a cell past the rows it spans — a 230 pt chart covers about 15 rows), or move the cells; the page shows the drawing and hides what is under it."),
    ("label_truncated", "Widen the column (autofit_range) or shorten the label; the cell beside it has content, so the reader sees only part of the text."),
    ("protected_input_locked", "Unlock the entry range (set_style with properties { locked: false }) before protect_sheet; a protected sheet locks every cell by default, so the form cannot be filled in."),
    ("heading_hierarchy_missing", "Create a clear title and heading hierarchy that matches the document reading path."),
    ("orphan_heading", "Keep the heading with the paragraph or table it introduces."),
    ("heading_not_distinct", "Set the heading apart from the body by size, weight, colour, letter-spacing or caps, or spacing; a heading the reader cannot see is not a heading."),
    ("heading_style_inconsistent", "Set every heading of one level in the same type; a level that changes size mid-document reads as two levels."),
    ("short_table_split", "Keep the short table together or move it intact to the next page."),
    ("table_label_oversized", "Set the table's labels at caption size and keep display size for its figures: add_table properties.rowStyles, or set_table_cell_style on the label row."),
    ("total_row_unmarked", "Set the total apart from the rows it sums: add_table properties.totalRow:true in Word, set_style bold with borders.top on the row in Excel."),
    ("header_alignment_mismatch", "Align the header with its column: a column of figures stands on its right edge, so its header takes horizontalAlignment:'right'."),
    ("shape_overlap", "Move or resize the reported shapes while preserving a consistent alignment grid."),
    ("text_overflow", "Shorten the copy or enlarge the text area before reducing type size."),
    ("small_font", "Reduce content density or split the slide; keep presentation body text at least 12 pt."),
    ("meaningful_visual_missing", "Replace generic text blocks with a chart, table, image, or subject-specific diagram that proves the claim."),
    ("native_evidence_too_weak", "Add source-bound native evidence to the slides carrying material claims."),
    ("art_direction_candidates_missing", "Compare two or more subject-specific art directions, select one, and carry its palette, typography, motif, and image treatment through the deck."),
    ("flat_visual_rhythm", "Vary background roles, density, focal scale, and evidence treatment while preserving the selected art direction."),
    ("font_family_overuse", "Advisory: keep the page to the display, body, and data faces (fontRole in a deck); drop every extra typeface unless the concept calls for it."),
    ("slide_hierarchy_flat", "Give the page one voice the eye reaches first — set its claim above the rest of the type — or carry it with a chart, table, or picture."),
    ("slide_text_dense", "Split the page or cut it to its claim and its evidence; a page of prose is read, not presented, and shrinking the type only hides it."),
    ("peer_style_inconsistent", "Set the boxes of one row in the same size and face; make an odd one deliberate by changing what it says, never by a stray size."),
    ("unsafe_font_family", "Advisory: the face is fine if it is installed, but recipients without it see a substitute in Word, PowerPoint, or Excel; use a safe-list face, or embed or ship the font. Not raised for PDF."),
    ("accent_hue_overuse", "Advisory: if the palette is not deliberately multi-hued, recolor cards, labels, and chips to palette roles so one accent dominates; chart series colours are not counted."),
    ("emphasis_mismatch", "Enlarge the evidence or thesis the brief names as primary and shrink the element that currently outweighs it."),
    ("low_visual_contrast", "Increase figure-ground contrast without adding decoration; verify the rendered page again."),
    ("repeated_layout_grammar", "Replace repeated spatial grammar with a different evidence-led composition."),
    ("repeated_decoration", "Draw the next device of the deck's set on the later page (`motif(slide, '', …)` takes it), or leave that page undecorated; one drawing on consecutive pages reads as the same page twice."),
    ("consecutive_composition_repeat", "Change the structure where the meaning changes (a different relationship takes a different kit structure), or merge the pages that say the same thing; a deliberate series declares design.review.allowRepetition."),
    ("repeated_render_composition", "Recompose the repeated slides so their rendered reading paths and evidence structures are visibly distinct."),
    ("slide_visual_density_low", "Add claim-bearing evidence or strengthen the focal hierarchy instead of filling the slide with ornament."),
    ("visual_role_variety_low", "Use at least three evidence roles across the deck, such as image, chart, process, comparison, table, or typographic statement."),
    ("creative_direction_missing", "Define the thesis, narrative arc, evidence map, motif, and per-slide creative brief before authoring the deck."),
    ("semantic_visual_plan_missing", "Assign a semantic visual treatment that directly explains the slide claim."),
    ("generic_visual_treatment", "Replace the generic chart, table, process, metric, or comparison treatment with a subject-specific annotated visual."),
    ("default_chart_treatment", "Add decision-relevant annotations, native data labels, and a commentary rail to the chart."),
    ("raw_table_slide", "Convert the raw table into a scorecard, decision matrix, or proportional allocation field."),
    ("under_composed_structure", "Strengthen the focal evidence and supporting visual hierarchy instead of leaving the canvas structurally empty."),
    ("under_composed_slide", "Recompose the slide so the rendered canvas carries a deliberate focal field and supporting evidence."),
    ("frontier_aesthetic_score_low", "Raise contrast, palette discipline, role-aware composition, and deck rhythm before release."),
    ("opening_closing_grammar_repeat", "Give the closing a distinct decision grammar instead of repeating the opening composition."),
    ("narrative_arc_weak", "Rebuild the sequence around distinct opening, proof, choice, execution, and decision-close beats."),
    ("worksheet_visual_clutter", "Separate the decision dashboard from supporting calculations and simplify the visible grid."),
    ("repetitive_composition", "Choose a different semantic layout that matches this slide’s evidence and role."),
    ("recent_composition_repeat", "Recompose the document-level hierarchy and evidence sequence while preserving the Brand kit tokens and facts."),
    ("card_grid_overuse", "Replace repeated cards with one dominant hierarchy, comparison, process, chart, or table."),
    ("number_without_source", "Add a source note that identifies the workbook cell, range, or external document."),
    ("number_without_fact", "Add the figure to the brief facts line with its source (F<n> <value> — <source>), or remove it from the slide."),
    ("facts_missing", "Write the brief facts line: every figure the deck shows, each with a source, before authoring again."),
    ("fact_without_locator", "Advisory: the brief names sources, so each fact cites where to open it — a page, a cell, a section, or a URL; say so in the line if a figure comes from somewhere else."),
    ("facts_illustrative", "Advisory: the brief declares the figures illustrative (facts: sample); say so in the delivery and never present them as measured."),
    ("plan_promise_missing", "Draw the carrier the plan line names, or change the line to what the page carries; author refuses a deck whose page does not carry what its own plan named."),
    ("plan_count_mismatch", "Advisory: the slide plan and the deck disagree on the slide count; update whichever is stale."),
    ("plan_missing", "Write the brief slide plan before authoring again: one line per slide, each naming the job the page does and what carries it."),
    ("plan_slide_unplanned", "Give every slide in the deck its own plan line, or drop the slides the plan does not want; a page nobody planned is a page nobody designed."),
    ("plan_incomplete", "Name the job and the carriers on every plan line, so the page is decided before it is drawn."),
    ("chart_stacked_label_position", "Set dataLabelPosition to ctr, inEnd, or inBase on the stacked chart; outEnd makes PowerPoint refuse the file."),
    ("chart_axis_undeclared", "Give the combo chart valAxes and catAxes with two entries each, or drop secondaryValAxis / secondaryCatAxis from the series; PowerPoint discards the chart otherwise."),
    ("text_fragmentation", "Merge the stacked single-line text boxes into one text box with paragraphs (breakLine between items) so the copy reflows and edits as a unit."),
    ("dead_vector_chart", "Replace the rectangles with a native chart (addChart / the kit chart()) so the values stay editable and re-sortable."),
    ("number_format_inconsistent", "Give the whole table column one number format (set_style numberFormat over the column) so every row shows the quantity the same way."),
    ("table_header_not_repeated", "Mark the header row to repeat (add_table properties.repeatHeader) so a table that crosses a page keeps its column labels."),
    ("subtotal_double_counted", "Sum the detail rows only (=SUM(B2:B9) beside the subtotal, not over it), or exclude the subtotal cell from the range."),
    ("chart_data_unlinked", "Write the chart with add_chart / set_chart_data so its embedded workbook stays in the package and Edit Data opens the numbers."),
    ("chart_series_unnamed", "Name the series where the reader looks: turn the chart's legend on, label the series names, or write the names on the page beside the colours they stand for."),
    ("text_clipped", "Enlarge the box or shorten the copy; text cut at a box edge is always visible to the reader."),
    ("text_box_too_narrow", "Widen the text box so lines wrap at a readable measure instead of one or two words per line."),
    ("shape_out_of_bounds", "Move or resize the shape inside the slide canvas; nothing past the edge is shown."),
    ("oversized_heading_text", "Set the paragraph in the body style, or lift its first line out as a heading over body text: prose at heading size reads as one shouted block."),
    ("shapes_too_close", "Open the gap between the shapes to at least 0.3 in, or merge them into one block."),
    ("vertical_imbalance", "Move the content down into the field or enlarge the containers so the canvas is filled with intent, not a hollow bottom."),
    ("stat_label_detached", "Bring the label to within 36 pt of its numeral so the pair reads as one unit."),
    ("low_contrast", "Raise the text or its field to 4.5:1 (3:1 at 18 pt or bold 14 pt): the on-dark ink on a dark fill, a darker ink on a light one, or a scrim under text on a picture."),
    ("font_unavailable", "Use a face from the safe list so the fit review and the recipient render the same widths."),
    ("placeholder_text", "Replace or delete the leftover template wording; placeholder copy never ships."),
    ("unfilled_token", "Fill or remove the unresolved template token before finalize."),
    ("literal_bullet", "Remove the typed bullet character and give the paragraph list formatting (listKind on append_text, or set_list) so the marker is real."),
    ("newline_in_text", "Split the text at the newline into separate paragraphs; a newline inside a paragraph renders as a space."),
    ("image_aspect_distorted", "Crop the picture to the frame ratio (the kit picture() does) instead of stretching it."),
    ("blank_image", "Replace the picture with the artwork it was meant to carry, or remove the frame and its caption; an empty circle reads as a page that failed to finish."),
    ("image_low_resolution", "Use a picture with about 150 pixels per inch at the size it is placed, or place it smaller; enlarging a small raster only softens it."),
    ("content_touches_page_edge", "Pull the content inside the safe margin; nothing sits against the canvas edge unless it bleeds on purpose (a picture, a band)."),
    ("edge_margin", "Keep at least 0.5 in between content and the canvas edge, or make the element a deliberate bleed."),
    ("axis_drift", "Snap the element to the axis its neighbours share (the kit mid()/band() of the same spans() result), or move it clear enough that the offset reads as a decision."),
    ("cjk_letter_spacing", "Drop charSpacing on the Hangul or CJK run (the kit kicker() adds tracking to Latin only); tracking separates the syllables of a word."),
    ("peer_gap_uneven", "Place the row from one set of columns (the kit spans() result) so every gap is the same, or make the odd gap large enough to read as a break between groups."),
    ("text_spacing_tight", "Raise the line spacing to at least 1.05× the size (the kit leading: dense 1.4, body 1.5)."),
    ("text_crosses_edge", "Move the text clear of the surface edge it dips over, or set it wholly inside that surface."),
    ("dense_paragraph", "Split the paragraph, cut the copy, or give it a slide of its own as prose; a wall of text is not evidence."),
    ("heading_hierarchy_jump", "Restore the skipped heading level so the outline reads in order."),
    ("worksheet_hierarchy_missing", "Give the sheet a title row, labelled headers, and one reading order before the data."),
    ("theme_background_drift", "Use only the ladder backgrounds (paper, paperAlt, dark, darkAlt); recolor the drifting slide."),
    ("theme_body_backgrounds", "Advisory: body slides use several background colours; keep them to the concept's declared palette ladder, or declare the concept or palette in the brief when the colour fields are the design."),
    ("excessive_slide_text", "Cut the copy to the reading mode's budget (composition.md §4) or split the slide."),
    ("decorative_stripe", "Remove the ornamental bar; a stripe that encodes nothing is decoration (composition.md §10)."),
    ("visual_critique_incomplete", "Give every slide five 1-5 scores, a slide-specific note of 40+ characters, and three checks derived from its plan line."),
    ("visual_critique_missing_slide", "Add the critique entry for the slide the finalize call left out."),
    ("visual_critique_invalid_slide", "Point each critique entry at an existing slide index, once."),
    ("visual_critique_needs_polish", "Apply the listed fixes and failed checks in the script, author again, and critique the slide again."),
    ("visual_critique_repeated_note", "Write each note from that slide's own content; a copied note is not a review."),
    ("adaptive_layout_selection_missing", "Decide each slide's composition move from its relationship and job (composition.md §0-§2) and name it in the plan."),
    ("layout_capacity_overflow", "Cut or split the content that exceeds the structure's capacity; never shrink the type to fit."),
    ("layout_whitespace_mismatch", "Match the air to the role: beats breathe, evidence slides fill the field."),
    ("layout_visual_imbalance", "Rebalance the slide so the focal element and its support share the canvas by weight."),
    ("generic_motif_selected", "Replace the generic motif with the style's own device, tied to the subject."),
    ("reference_genome_missing", "Select and record the visual style the deck follows (direction.md §3-§4) before composing."),
    ("visual_reference_selection_missing", "Select and record the visual style the deck follows (direction.md §3-§4) before composing."),
    ("source_specific_asset_missing", "Add the subject-specific asset (picture, diagram, chart from the source) where the plan promised one."),
    ("adaptive_layout_rhythm_flat", "Alternate composition moves and densities across adjacent slides so the deck has rhythm."),
    ("beat_share_high", "Keep the dark or field pages for the cover, the section marks, and the closing; give every other page its chart, table, picture, or structure at half the canvas."),
    ("consecutive_beats", "Replace the middle beat of the run with the content page it stands in for, or merge the three into one section mark."),
    ("page_underfill", "Give the page its payload: a chart, table, picture, or structure with the readings beside it (composition.md §8) — or fold the sentence into the page it introduces."),
    ("post_save_reopen_missing", "Reopen the saved file and verify the review evidence after saving."),
    ("visual_coverage_incomplete", "Render and inspect every page before finalize; the visual coverage must be complete."),
];

/// `isAdvisoryOfficeIssue`: an advisory code, or a record already marked `info`.
pub fn is_advisory_office_issue(issue: &Value) -> bool {
    ADVISORY_CODES.contains(&text_or(field(issue, "code"), "").as_str()) || text_or(field(issue, "severity"), "") == "info"
}

fn polish_guidance(code: &str) -> Option<&'static str> {
    POLISH_GUIDANCE.iter().find(|(known, _)| *known == code).map(|(_, text)| *text)
}

/// `path.extname`: the extension of the last path segment, either separator, with the dot; empty for a dotfile.
fn extension(path: &str) -> &str {
    let bytes = path.as_bytes();
    let separator = |at: usize| bytes[at] == b'/' || bytes[at] == b'\\';
    let mut start = 0;
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        start = 2;
    }
    let mut start_dot: Option<usize> = None;
    let mut start_part = start;
    let mut end: Option<usize> = None;
    let mut pre_dot_state: i32 = 0;
    for at in (start..bytes.len()).rev() {
        if separator(at) {
            if end.is_some() {
                start_part = at + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            end = Some(at + 1);
        }
        if bytes[at] == b'.' {
            if start_dot.is_none() {
                start_dot = Some(at);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    let (Some(dot), Some(end)) = (start_dot, end) else { return "" };
    if pre_dot_state == 0 || (pre_dot_state == 1 && dot + 1 == end && dot == start_part + 1) {
        return "";
    }
    &path[dot..]
}

/// `resolveOfficeRenderOutput`: a `.pdf` path as it is, any other as the path with its extension replaced by `.pdf`.
pub fn resolve_office_render_output(path: &str) -> String {
    if js_to_lowercase(extension(path)) == ".pdf" {
        return path.to_owned();
    }
    // The pattern `\.[^./\\]+$`: the last dot, when what follows it holds no dot and no separator.
    let stem = match path.rfind('.') {
        Some(dot) if dot + 1 < path.len() && !path[dot + 1..].contains(['/', '\\']) => &path[..dot],
        _ => path,
    };
    format!("{stem}.pdf")
}

/// `normalizeOfficeReviewIssues`: every record an object, its severity forced by its code (an integrity fault is an
/// `error`, an advisory code is `info`, anything else keeps its own or `warning`), a repeated record kept once.
pub fn normalize_office_review_issues(entries: &[Value]) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut output = Vec::new();
    for raw in entries {
        let mut record = match raw {
            Value::Object(map) => map.clone(),
            // An array is an object to `typeof`: its elements are spread as index keys.
            Value::Array(items) => items.iter().enumerate().map(|(at, item)| (at.to_string(), item.clone())).collect(),
            _ => continue,
        };
        let code = text_or(record.get("code"), "");
        let mut severity = text_or(record.get("severity"), "warning");
        if CRITICAL_CODES.contains(&code.as_str()) {
            severity = "error".to_owned();
        } else if ADVISORY_CODES.contains(&code.as_str()) {
            severity = "info".to_owned();
        }
        record.insert("severity".to_owned(), Value::String(severity.clone()));
        let key = format!(
            "{severity}\0{}\0{}\0{}",
            template_text(record.get("code")),
            template_text(record.get("path")),
            template_text(record.get("message"))
        );
        if seen.insert(key) {
            output.push(Value::Object(record));
        }
    }
    output
}

#[derive(Clone)]
struct Target {
    path: String,
    error: bool,
    codes: Vec<Option<Value>>,
    actions: Vec<String>,
}

/// `buildOfficePolishPlan`: the non-advisory issues grouped by path, errors first and then by path.
pub fn build_office_polish_plan(format: &str, issues: &[Value]) -> Value {
    let mut targets: Vec<Target> = Vec::new();
    let mut by_path: HashMap<String, usize> = HashMap::new();
    for issue in normalize_office_review_issues(issues) {
        let severity = text_or(field(&issue, "severity"), "");
        if severity == "info" {
            continue; // advisory: the author's call, not a polish target
        }
        let path = text_or(field(&issue, "path"), "/");
        let at = *by_path.entry(path.clone()).or_insert_with(|| {
            targets.push(Target { path: path.clone(), error: false, codes: Vec::new(), actions: Vec::new() });
            targets.len() - 1
        });
        let current = &mut targets[at];
        if severity == "error" {
            current.error = true;
        }
        // An absent code (`undefined`, written as null) is a different code from a null one, as in `includes`.
        let code = field(&issue, "code").cloned();
        if !current.codes.contains(&code) {
            current.codes.push(code);
        }
        let guidance = polish_guidance(&text_or(field(&issue, "code"), "")).map_or_else(
            || format!("Correct {} at {path}, then render and inspect the affected page again.", template_text(field(&issue, "code"))),
            str::to_owned,
        );
        if !current.actions.contains(&guidance) {
            current.actions.push(guidance);
        }
    }
    let mut ordered = targets;
    js_sort_by(&mut ordered, |left, right| {
        let errors = f64::from(u8::from(right.error)) - f64::from(u8::from(left.error));
        if errors != 0.0 { errors } else { f64::from(locale_compare(&left.path, &right.path) as i8) }
    });
    let critical = ordered.iter().filter(|target| target.error).count();
    let next_action = if ordered.is_empty() {
        "No targeted polish remains."
    } else {
        "Edit only the reported targets in one atomic batch, render the changed pages, then run QA again."
    };
    json!({
        "format": js_to_lowercase(format),
        "status": if ordered.is_empty() { "pass" } else { "needs-polish" },
        "targetCount": ordered.len(),
        "criticalCount": critical,
        "targets": ordered.iter().map(|target| json!({
            "path": target.path,
            "severity": if target.error { "error" } else { "warning" },
            "codes": target.codes,
            "actions": target.actions,
        })).collect::<Vec<_>>(),
        "nextAction": next_action,
    })
}

/// `evaluateOfficeSubmissionGate`: the normalised errors block, and so does a saved document that was not reopened
/// (`persisted` false) or a render review that did not cover every page (`visual_coverage.complete` not true).
pub fn evaluate_office_submission_gate(issues: &[Value], persisted: &Value, visual_coverage: &Value) -> Value {
    let mut blocking: Vec<Value> =
        normalize_office_review_issues(issues).into_iter().filter(|issue| text_or(field(issue, "severity"), "") == "error").collect();
    if *persisted == Value::Bool(false) {
        blocking.push(issue_with(
            "post_save_reopen_missing",
            "/",
            "The saved Office document was not reopened, so persistence is unproven.",
            "post-save-gate",
            "error",
        ));
    }
    if is_truthy(Some(visual_coverage)) && field(visual_coverage, "complete") != Some(&Value::Bool(true)) {
        blocking.push(issue_with(
            "visual_coverage_incomplete",
            "/",
            "Not every rendered page or slide was reviewed.",
            "render-review",
            "error",
        ));
    }
    let mut gate = Map::new();
    gate.insert("ok".to_owned(), Value::Bool(blocking.is_empty()));
    gate.insert("persisted".to_owned(), persisted.clone());
    gate.insert("criticalCount".to_owned(), Value::from(blocking.len()));
    gate.insert("blocking".to_owned(), Value::Array(blocking));
    Value::Object(gate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(code: &str) -> Value {
        json!({ "code": code, "severity": "warning", "path": "/slide[2]", "message": code })
    }

    fn codes(list: &[Value]) -> Vec<&str> {
        list.iter().map(|entry| entry["code"].as_str().expect("code")).collect()
    }

    #[test]
    fn style_observations_remain_visible_without_forcing_a_redesign_or_blocking_delivery() {
        let names = [
            "accent_hue_overuse",
            "font_family_overuse",
            "decorative_stripe",
            "consecutive_beats",
            "consecutive_composition_repeat",
            "repeated_layout_grammar",
            "vertical_imbalance",
        ];
        let issues: Vec<Value> = names.iter().map(|code| at(code)).collect();
        let reviewed = normalize_office_review_issues(&issues);
        assert_eq!(codes(&reviewed), names);
        assert!(reviewed.iter().all(|entry| entry["severity"] == "info"));
        assert_eq!(build_office_polish_plan("pptx", &issues)["status"], "pass");
        let gate = evaluate_office_submission_gate(&issues, &json!(true), &json!({ "complete": true }));
        assert_eq!(gate["ok"], true);
    }

    #[test]
    fn creative_freedom_does_not_waive_corruption_calculation_fit_persistence_or_review_checks() {
        let style = at("vertical_imbalance");
        for code in [
            "package_corrupt",
            "missing_relationship",
            "formula_error",
            "broken_chart",
            "shape_overlap",
            "shape_out_of_bounds",
            "text_outside_slide",
            "text_overflow",
            "render_failed",
        ] {
            let issues = vec![style.clone(), at(code)];
            let gate = evaluate_office_submission_gate(&issues, &json!(true), &json!({ "complete": true }));
            assert_eq!(gate["ok"], false, "{code}");
            assert_eq!(codes(gate["blocking"].as_array().expect("blocking")), [code]);
            let plan = build_office_polish_plan("pptx", &issues);
            assert_eq!(plan["targets"][0]["codes"], json!([code]));
        }
        assert_eq!(evaluate_office_submission_gate(&[style.clone()], &json!(false), &Value::Null)["ok"], false);
        assert_eq!(evaluate_office_submission_gate(&[style], &Value::Null, &json!({ "complete": false }))["ok"], false);
    }

    #[test]
    fn a_repeated_record_is_kept_once_and_an_error_sorts_before_a_warning() {
        let issues = vec![at("blank_page"), at("blank_page"), json!({ "code": "small_font", "path": "/a", "message": "m" })];
        assert_eq!(normalize_office_review_issues(&issues).len(), 2);
        let plan = build_office_polish_plan("PPTX", &issues);
        assert_eq!(plan["format"], "pptx");
        assert_eq!(plan["targetCount"], 2);
        assert_eq!(plan["criticalCount"], 1);
        assert_eq!(plan["targets"][0]["path"], "/slide[2]");
        assert_eq!(plan["targets"][0]["severity"], "error");
        assert_eq!(plan["targets"][1]["severity"], "warning");
        let none = build_office_polish_plan("docx", &[]);
        assert_eq!(none["status"], "pass");
        assert_eq!(none["nextAction"], "No targeted polish remains.");
    }

    #[test]
    fn a_code_without_guidance_gets_the_generic_correction() {
        let plan = build_office_polish_plan("docx", &[json!({ "code": "made_up", "path": "/p" })]);
        assert_eq!(plan["targets"][0]["actions"][0], "Correct made_up at /p, then render and inspect the affected page again.");
        let unnamed = build_office_polish_plan("docx", &[json!({ "path": "/p" }), json!({ "code": null, "path": "/p" })]);
        assert_eq!(unnamed["targets"][0]["codes"], json!([null, null]));
        assert_eq!(unnamed["targets"][0]["actions"], json!([
            "Correct undefined at /p, then render and inspect the affected page again.",
            "Correct null at /p, then render and inspect the affected page again."
        ]));
    }

    #[test]
    fn the_render_output_is_a_pdf_beside_the_document() {
        assert_eq!(resolve_office_render_output("out/a.PDF"), "out/a.PDF");
        assert_eq!(resolve_office_render_output("out/a.docx"), "out/a.pdf");
        assert_eq!(resolve_office_render_output("C:\\dir.v2\\a"), "C:\\dir.v2\\a.pdf");
        assert_eq!(resolve_office_render_output("a.b.c"), "a.b.pdf");
        assert_eq!(resolve_office_render_output(".pdf"), ".pdf");
        assert_eq!(resolve_office_render_output("a."), "a..pdf");
    }

    #[test]
    fn the_tables_do_not_overlap() {
        assert!(CRITICAL_CODES.iter().all(|code| !ADVISORY_CODES.contains(code)));
        assert!(!ADVISORY_CODES.contains(&"plan_promise_missing"));
        assert!(is_advisory_office_issue(&json!({ "code": "x", "severity": "info" })));
    }
}
