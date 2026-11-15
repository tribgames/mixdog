//! Twin test `structure`: the recording of Node's office structure review (`native/core/fixtures/office-structure/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-structure.mjs`) against this crate. Every recorded snapshot (the
//! decks, documents and workbooks of the office-assurance, slide-quality and type-floors suites, and seeded generated ones
//! that spread the thresholds) is run through `review_office_structure`, and the exact JSON text of the issue list, in
//! Node's order with Node's wording and key order, must equal the recorded one. Re-recording is `twin_live_structure`
//! (ignored: it runs Node).

use mixdog_js::json_stringify;
use mixdog_office_base::twin;
use mixdog_office_quality::structure::review_office_structure;
use serde_json::Value;

fn golden() -> Value {
    twin::load_golden("office-structure")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    golden[name].as_array().unwrap_or_else(|| panic!("section {name}"))
}

fn review(input: &Value) -> Value {
    let format = input.get("format").and_then(Value::as_str);
    let profile = input.get("auditProfile").and_then(Value::as_str).unwrap_or("");
    Value::Array(review_office_structure(format, input.get("document").unwrap_or(&Value::Null), profile))
}

fn cut(text: &str) -> String {
    text.chars().take(500).collect()
}

fn replay(golden: &Value, name: &str) {
    let cases = section(golden, name);
    assert!(!cases.is_empty(), "section {name} is empty");
    let mut failures = Vec::new();
    for case in cases {
        assert!(case.get("error").is_none(), "{name}: Node rejected a recorded input: {}", case["error"]);
        let expected = json_stringify(&case["output"]);
        let actual = json_stringify(&review(&case["input"]));
        if expected != actual {
            let input: String = json_stringify(&case["input"]).chars().take(300).collect();
            failures.push(format!("input {input}\n  recorded {}\n  produced {}", cut(&expected), cut(&actual)));
        }
    }
    assert!(
        failures.is_empty(),
        "{name}: {} of {} cases differ\n{}",
        failures.len(),
        cases.len(),
        failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n")
    );
}

fn every_review_equals_the_recording() {
    let g = golden();
    for name in ["suites", "pptx", "docx", "xlsx", "dispatch"] {
        replay(&g, name);
    }
}

#[test]
fn every_recorded_review_equals_the_recording() {
    every_review_equals_the_recording();
}

#[test]
fn the_recording_covers_every_review_with_a_real_spread() {
    let g = golden();
    for (name, minimum) in [("suites", 100), ("pptx", 250), ("docx", 150), ("xlsx", 100), ("dispatch", 6)] {
        assert!(section(&g, name).len() >= minimum, "{name} has too few cases");
    }
    let codes: Vec<&str> = ["suites", "pptx", "docx", "xlsx"]
        .iter()
        .flat_map(|name| section(&g, name))
        .filter_map(|case| case["output"].as_array())
        .flatten()
        .filter_map(|issue| issue["code"].as_str())
        .collect();
    for wanted in [
        "heading_not_distinct",
        "heading_style_inconsistent",
        "heading_hierarchy_jump",
        "heading_hierarchy_missing",
        "orphan_heading",
        "dense_paragraph",
        "oversized_heading_text",
        "literal_bullet",
        "newline_in_text",
        "short_table_split",
        "table_label_oversized",
        "total_row_unmarked",
        "worksheet_hierarchy_missing",
        "formula_error",
        "chart_includes_total_row",
        "chart_stops_short_of_data",
        "worksheet_print_fit_missing",
        "drawing_outside_print_area",
        "drawing_overlap",
        "drawing_covers_cells",
        "header_alignment_mismatch",
        "empty_chart",
        "chart_series_unnamed",
        "peer_style_inconsistent",
        "slide_hierarchy_flat",
        "slide_text_dense",
        "small_font",
        "low_contrast",
        "edge_margin",
        "shape_overlap",
        "text_spacing_tight",
        "text_crosses_edge",
        "axis_drift",
        "peer_gap_uneven",
        "number_without_source",
    ] {
        assert!(codes.contains(&wanted), "no {wanted} issue among the recorded reviews");
    }
}

/// Records again with Node and compares: `cargo test -p mixdog-office-quality --test twin_structure -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/quality)"]
fn twin_live_structure() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-structure.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_review_equals_the_recording();
}
