//! `assurance-checklist.mjs`: the assurance checklist of a document, derived from the review issues by format rules,
//! plus the task's own checklist items the author answers.

use mixdog_js::{js_to_lowercase, js_trim, to_number_of};
use serde_json::{Map, Value, json};

use crate::issue::issue_with;
use crate::{field, is_true, is_truthy, strict_equals, template_text, text_or};

/// One format rule: the checklist item fails when an issue carries one of its codes or starts with one of its prefixes.
struct Rule {
    id: &'static str,
    label: &'static str,
    codes: &'static [&'static str],
    prefixes: &'static [&'static str],
}

const fn rule(id: &'static str, label: &'static str, codes: &'static [&'static str]) -> Rule {
    Rule { id, label, codes, prefixes: &[] }
}

const PAGE_UTILIZATION: Rule = rule(
    "page-utilization",
    "Rendered pages do not contain accidental blank or sparse pages.",
    &["blank_page", "sparse_page", "page_bottom_empty"],
);

const DOCX_RULES: &[Rule] = &[
    rule(
        "heading-hierarchy",
        "Heading hierarchy is present and does not skip levels.",
        &["heading_hierarchy_missing", "heading_hierarchy_jump"],
    ),
    rule(
        "orphan-headings",
        "Headings stay with the content or table they introduce.",
        &["orphan_heading", "heading_table_separation"],
    ),
    rule(
        "heading-type",
        "Headings lead the body type, and one level carries one type.",
        &["heading_not_distinct", "heading_style_inconsistent"],
    ),
    // The Office backend's name and the portable audit's for one table running past the margins.
    rule(
        "table-integrity",
        "Short tables are not split and fit inside page margins.",
        &["short_table_split", "table_width", "table_wider_than_page"],
    ),
    PAGE_UTILIZATION,
    rule("ink-legibility", "Text is readable against the field it sits on.", &["low_contrast"]),
];

const XLSX_RULES: &[Rule] = &[
    Rule {
        id: "formula-integrity",
        label: "Formula results, dependencies, and repeated formula regions are consistent.",
        codes: &[],
        prefixes: &["formula_", "assertion_"],
    },
    rule(
        "chart-scope",
        "Charts contain valid series and exclude total or subtotal rows.",
        &["empty_chart", "broken_chart", "chart_includes_total_row", "chart_stops_short_of_data"],
    ),
    rule(
        "worksheet-hierarchy",
        "Data sheets have a visible title, header, table, or styled hierarchy.",
        &["worksheet_hierarchy_missing"],
    ),
    rule(
        "print-readability",
        "Rendered worksheets use the page area at a readable scale.",
        &[
            "worksheet_print_too_small",
            "worksheet_print_fit_missing",
            "drawing_outside_print_area",
            "drawing_overlap",
            "drawing_covers_cells",
        ],
    ),
    rule("ink-legibility", "Cell text is readable against its fill.", &["low_contrast", "label_truncated"]),
    rule("input-usability", "Entry cells stay editable once the sheet is protected.", &["protected_input_locked"]),
];

const PPTX_RULES: &[Rule] = &[
    // text_outside_slide is PowerPoint's measure of a text box past the canvas, shape_out_of_bounds the portable one.
    rule(
        "slide-geometry",
        "Text and visual shapes respect margins, spacing, and non-overlap constraints.",
        &["shape_overlap", "text_outside_slide", "shape_out_of_bounds", "edge_margin", "text_spacing_tight"],
    ),
    rule(
        "slide-legibility",
        "Text fits, meets minimum size, and has sufficient contrast.",
        &["text_overflow", "small_font", "low_contrast"],
    ),
    rule(
        "slide-type-discipline",
        "Peers of one row share their type, and no page projects a wall of prose.",
        &["peer_style_inconsistent", "slide_text_dense", "slide_hierarchy_flat"],
    ),
    rule(
        "visual-evidence",
        "Content slides use subject-specific native evidence instead of generic repetition.",
        &["meaningful_visual_missing", "native_evidence_too_weak", "repetitive_composition", "card_grid_overuse"],
    ),
    rule(
        "source-provenance",
        "Material numbers and claims cite a source in notes or provenance metadata.",
        &["number_without_source"],
    ),
];

const PDF_RULES: &[Rule] = &[PAGE_UTILIZATION];

fn rules_for(format: &str) -> &'static [Rule] {
    match format {
        "docx" => DOCX_RULES,
        "xlsx" => XLSX_RULES,
        "pptx" => PPTX_RULES,
        "pdf" => PDF_RULES,
        _ => &[],
    }
}

fn issue_matches(rule: &Rule, entry: &Value) -> bool {
    let code = text_or(field(entry, "code"), "");
    rule.codes.contains(&code.as_str()) || rule.prefixes.iter().any(|prefix| code.starts_with(prefix))
}

/// `value.replace(/[^a-z0-9가-힣]+/g, '-')`: every run of other characters becomes one dash.
fn dashed(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || ('\u{AC00}'..='\u{D7A3}').contains(&c) {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out
}

fn normalized_checklist_item(value: &Value, index: usize) -> Option<Map<String, Value>> {
    let fallback = format!("task-{}", index + 1);
    let mut item = Map::new();
    match value {
        Value::String(text) => {
            item.insert("id".to_owned(), Value::String(fallback));
            item.insert("label".to_owned(), Value::String(js_trim(text).to_owned()));
            item.insert("required".to_owned(), Value::Bool(true));
            item.insert("manual".to_owned(), Value::Bool(true));
        }
        Value::Object(map) => {
            let id = dashed(&js_to_lowercase(js_trim(&text_or(map.get("id"), &fallback))));
            let label = [map.get("label"), map.get("text"), map.get("id")]
                .into_iter()
                .find(|candidate| is_truthy(*candidate))
                .map_or_else(|| format!("Task check {}", index + 1), |candidate| text_or(candidate, ""));
            item.insert("id".to_owned(), Value::String(id));
            item.insert("label".to_owned(), Value::String(js_trim(&label).to_owned()));
            item.insert("required".to_owned(), Value::Bool(map.get("required") != Some(&Value::Bool(false))));
            item.insert("manual".to_owned(), Value::Bool(true));
            let status = map.get("status").and_then(Value::as_str);
            if map.get("passed") == Some(&Value::Bool(true)) || status == Some("pass") {
                item.insert("passed".to_owned(), Value::Bool(true));
            }
            if map.get("passed") == Some(&Value::Bool(false)) || status == Some("fail") {
                item.insert("passed".to_owned(), Value::Bool(false));
            }
            if is_truthy(map.get("evidence")) {
                item.insert("evidence".to_owned(), Value::String(text_or(map.get("evidence"), "")));
            }
        }
        _ => return None,
    }
    Some(item)
}

fn rule_checklist_item(id: &str, label: &str, matched: &[&Value]) -> Value {
    json!({
        "id": id,
        "label": label,
        "required": true,
        "status": if matched.is_empty() { "pass" } else { "fail" },
        "evidence": matched.iter().map(|entry| field(entry, "code").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
    })
}

fn render_coverage_item(visual_coverage: &Value) -> Value {
    let complete = is_true(field(visual_coverage, "complete")) && to_number_of(field(visual_coverage, "total")) > 0.0;
    let evidence = if complete {
        format!("{}/{}", template_text(field(visual_coverage, "reviewed")), template_text(field(visual_coverage, "total")))
    } else {
        "visual coverage is incomplete".to_owned()
    };
    json!({
        "id": "full-render-coverage",
        "label": "Every page or slide has a rendered image; visual acceptance is recorded separately.",
        "required": true,
        "status": if complete { "pass" } else { "fail" },
        "evidence": [evidence],
    })
}

fn default_checklist_items(format: &str, audit_profile: &str, issues: &[Value], visual_coverage: &Value) -> Vec<Value> {
    let mut items: Vec<Value> = rules_for(format)
        .iter()
        .map(|item| {
            let matched: Vec<&Value> = issues.iter().filter(|entry| issue_matches(item, entry)).collect();
            rule_checklist_item(item.id, item.label, &matched)
        })
        .collect();
    if audit_profile == "financial-model" && format == "xlsx" {
        let missing = Value::String("missing_checks_sheet".to_owned());
        let matched: Vec<&Value> =
            issues.iter().filter(|entry| strict_equals(field(entry, "code"), Some(&missing))).collect();
        items.push(rule_checklist_item(
            "checks-sheet",
            "Financial model includes a Checks sheet with explicit tie-outs.",
            &matched,
        ));
    }
    if !matches!(format, "csv" | "tsv") {
        items.push(render_coverage_item(visual_coverage));
    }
    items
}

/// The task's own checklist entries as items: a string is a manual required item, an object carries its own answer;
/// an entry without a label is dropped. Status is `pass`, `fail`, or `pending` while unanswered.
fn custom_checklist_items(checklist: &[Value]) -> Vec<Map<String, Value>> {
    checklist
        .iter()
        .enumerate()
        .filter_map(|(index, value)| normalized_checklist_item(value, index))
        .filter(|entry| is_truthy(entry.get("label")))
        .map(|mut entry| {
            let status = match entry.get("passed") {
                Some(Value::Bool(true)) => "pass",
                Some(Value::Bool(false)) => "fail",
                _ => "pending",
            };
            let evidence = match entry.get("evidence") {
                Some(text) if is_truthy(Some(text)) => json!([text]),
                _ => json!([]),
            };
            entry.insert("status".to_owned(), json!(status));
            entry.insert("evidence".to_owned(), evidence);
            entry
        })
        .collect()
}

fn custom_checklist_issues(custom: &[Map<String, Value>]) -> Vec<Value> {
    custom
        .iter()
        .filter(|entry| entry.get("required") == Some(&Value::Bool(true)) && entry.get("status") != Some(&json!("pass")))
        .map(|entry| {
            let status = text_or(entry.get("status"), "");
            issue_with(
                if status == "pending" { "checklist_item_pending" } else { "checklist_item_failed" },
                &format!("/checklist/{}", text_or(entry.get("id"), "")),
                &format!("Required task checklist item is {status}: {}", text_or(entry.get("label"), "")),
                "checklist-review",
                "warning",
            )
        })
        .collect()
}

/// `evaluateOfficeChecklist(input)`: `input` is the options object (`format`, `task`, `auditProfile`, `checklist`,
/// `issues`, `visualCoverage`). The format's rule items pass when no issue matches them; the render-coverage item
/// passes when every page or slide has a rendered image; the task's own items are answered by the author.
pub fn evaluate_office_checklist(input: &Value) -> Value {
    let format = js_to_lowercase(&text_or(field(input, "format"), ""));
    let audit_profile = text_or(field(input, "auditProfile"), "");
    let empty = Vec::new();
    let checklist = field(input, "checklist").and_then(Value::as_array).unwrap_or(&empty);
    let issues = field(input, "issues").and_then(Value::as_array).unwrap_or(&empty);
    let visual_coverage = field(input, "visualCoverage").unwrap_or(&Value::Null);
    let custom = custom_checklist_items(checklist);
    let mut items = default_checklist_items(&format, &audit_profile, issues, visual_coverage);
    items.extend(custom.iter().cloned().map(Value::Object));
    let count = |status: &str| items.iter().filter(|entry| field(entry, "status").and_then(Value::as_str) == Some(status)).count();
    let (passed, failed, pending) = (count("pass"), count("fail"), count("pending"));
    json!({
        "ok": failed == 0 && pending == 0,
        "task": text_or(field(input, "task"), ""),
        "auditProfile": audit_profile,
        "items": items,
        "summary": { "total": items.len(), "passed": passed, "failed": failed, "pending": pending },
        "issues": custom_checklist_issues(&custom),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn statuses(result: &Value) -> Vec<(String, String)> {
        result["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| (item["id"].as_str().expect("id").to_owned(), item["status"].as_str().expect("status").to_owned()))
            .collect()
    }

    #[test]
    fn a_rule_item_fails_with_the_codes_that_matched_it() {
        let result = evaluate_office_checklist(&json!({
            "format": "DOCX",
            "issues": [{ "code": "orphan_heading" }, { "code": "table_wider_than_page" }, { "code": "unrelated" }],
            "visualCoverage": { "complete": true, "reviewed": 3, "total": 3 }
        }));
        let items = statuses(&result);
        assert_eq!(items.iter().filter(|(_, status)| status == "fail").count(), 2);
        assert!(items.contains(&("orphan-headings".to_owned(), "fail".to_owned())));
        assert_eq!(result["items"][1]["evidence"], json!(["orphan_heading"]));
        assert_eq!(result["items"][6]["evidence"], json!(["3/3"]));
        assert_eq!(result["ok"], false);
    }

    #[test]
    fn a_prefix_rule_and_the_financial_model_sheet_rule_apply_to_a_workbook() {
        let result = evaluate_office_checklist(&json!({
            "format": "xlsx", "auditProfile": "financial-model",
            "issues": [{ "code": "formula_error" }, { "code": "assertion_failed" }, { "code": "missing_checks_sheet" }]
        }));
        let items = statuses(&result);
        assert!(items.contains(&("formula-integrity".to_owned(), "fail".to_owned())));
        assert!(items.contains(&("checks-sheet".to_owned(), "fail".to_owned())));
        assert_eq!(result["items"][7]["evidence"], json!(["visual coverage is incomplete"]));
        assert_eq!(result["auditProfile"], "financial-model");
    }

    #[test]
    fn tabular_formats_carry_no_render_coverage_item() {
        let result = evaluate_office_checklist(&json!({ "format": "csv" }));
        assert_eq!(result["summary"], json!({ "total": 0, "passed": 0, "failed": 0, "pending": 0 }));
        assert_eq!(result["ok"], true);
    }

    #[test]
    fn the_task_checklist_is_normalised_and_unanswered_required_items_become_issues() {
        let result = evaluate_office_checklist(&json!({
            "format": "pdf",
            "checklist": [
                "  Check the numbers  ",
                { "id": "Brand Voice!", "label": "Voice", "passed": true, "evidence": "p3" },
                { "id": "가나 다", "text": "From text", "status": "fail", "required": false },
                { "label": "   " },
                null
            ],
            "visualCoverage": { "complete": true, "reviewed": 1, "total": 1 }
        }));
        let items = result["items"].as_array().expect("items");
        assert_eq!(items.len(), 5);
        assert_eq!(items[2]["id"], "task-1");
        assert_eq!(items[2]["status"], "pending");
        assert_eq!(items[3]["id"], "brand-voice-");
        assert_eq!(items[3]["evidence"], json!(["p3"]));
        assert_eq!(items[4]["id"], "가나-다");
        assert_eq!(items[4]["status"], "fail");
        assert_eq!(result["summary"], json!({ "total": 5, "passed": 3, "failed": 1, "pending": 1 }));
        let issues = result["issues"].as_array().expect("issues");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["code"], "checklist_item_pending");
        assert_eq!(issues[0]["path"], "/checklist/task-1");
        assert_eq!(issues[0]["message"], "Required task checklist item is pending: Check the numbers");
        assert_eq!(issues[0]["source"], "checklist-review");
    }

    #[test]
    fn a_run_of_other_characters_becomes_one_dash() {
        assert_eq!(dashed("a  b__c"), "a-b-c");
        assert_eq!(dashed("é-ü"), "-");
        assert_eq!(dashed("가나다 라"), "가나다-라");
    }
}
