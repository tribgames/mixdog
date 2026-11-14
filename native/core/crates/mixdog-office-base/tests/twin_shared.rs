//! Twin test `shared`: the recording of Node's office shared modules, the head of `core/office-core.mjs` and the cell
//! reference parsers (`native/core/fixtures/office-shared/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-shared.mjs`) against this crate. Every output value is compared, and
//! the exact JSON text of each envelope. Re-recording is `twin_live_shared` (ignored: it runs Node).

use mixdog_js::{json_number, json_stringify};
use mixdog_office_base::a1::{self, XLSX_MAX_RANGE_CELLS, XlsxCell};
use mixdog_office_base::column_alignments::figure_column_alignments;
use mixdog_office_base::column_widths::natural_column_widths;
use mixdog_office_base::envelope::{CONFLICT_MESSAGE, ToolImage, tool_result};
use mixdog_office_base::formats::{self, FILE_KIND_TO_FORMAT, FORMATS, OOXML_FORMATS, TABULAR_FORMATS};
use mixdog_office_base::korean_particles::korean_particle_replacements;
use mixdog_office_base::labels::{PresetLabels, preset_labels};
use mixdog_office_base::line_breaks::{without_runt, wrap_units};
use mixdog_office_base::page_sizes::page_size_points;
use mixdog_office_base::values;
use mixdog_office_base::{asar_path::physical_asar_path, twin};
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-shared")
}

fn cases<'a>(golden: &'a Value, section: &str) -> &'a [Value] {
    golden[section].as_array().unwrap_or_else(|| panic!("section {section}"))
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("array").iter().map(|item| item.as_str().expect("string").to_owned()).collect()
}

fn table(value: &Value) -> Vec<Vec<String>> {
    value.as_array().expect("rows").iter().map(strings).collect()
}

/// Node's `{ value }` / `{ error }` of an attempt.
fn attempt(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "value": value }),
        Err(error) => json!({ "error": error }),
    }
}

/// The recorded `{ value }` or `{ error }` of a case.
fn recorded(case: &Value) -> Value {
    if case.get("error").is_some() { json!({ "error": case["error"] }) } else { json!({ "value": case["value"] }) }
}

fn numbers(list: &[f64]) -> Value {
    Value::Array(list.iter().map(|number| json_number(*number)).collect())
}

/// The recorder's `MEASURE`: 2 for a character at or above U+1100, 1 for any other, plus 2 and the column.
fn measure(text: &str, _row: usize, column: usize) -> f64 {
    text.chars().map(|c| if c as u32 >= 0x1100 { 2.0 } else { 1.0 }).sum::<f64>() + 2.0 + column as f64
}

fn line_width(text: &str) -> f64 {
    text.chars().map(|c| if c as u32 >= 0x1100 { 2.0 } else { 1.0 }).sum()
}

fn labels_value(labels: &PresetLabels) -> Value {
    json!({
        "eyebrow": labels.eyebrow, "decision": labels.decision, "recommendation": labels.recommendation,
        "checkpoint": labels.checkpoint, "source": labels.source, "gate": labels.gate,
    })
}

fn check(what: &str, case: &Value, expected: &Value, actual: &Value) {
    let found = twin::differences(expected, actual);
    assert!(found.is_empty(), "{what} {}: {}", json_stringify(&case["input"]), found.join("; "));
}

fn replay_values(g: &Value) {
    let v = &g["values"];
    for case in v["clone"].as_array().expect("clone") {
        assert_eq!(json_stringify(&values::clone(&case["input"])), case["json"].as_str().expect("json"), "clone {}", case["input"]);
    }
    for case in v["stable"].as_array().expect("stable") {
        assert_eq!(json_stringify(&values::stable_value(&case["input"])), case["json"].as_str().expect("json"), "stable {}", case["input"]);
    }
    for case in v["plainObject"].as_array().expect("plainObject") {
        assert_eq!(values::plain_object(&case["input"]), case["plain"].as_bool().expect("plain"));
    }
    for case in v["sha256"].as_array().expect("sha256") {
        assert_eq!(values::sha256(case["input"].as_str().expect("input")), case["hex"].as_str().expect("hex"));
    }
    for case in v["clamp"].as_array().expect("clamp") {
        let (min, max) = (case["minimum"].as_f64().expect("min"), case["maximum"].as_f64().expect("max"));
        let actual = json_number(values::clamp_of(Some(&case["input"]), min, max));
        check("clamp", case, &case["value"], &actual);
    }
    for case in v["compact"].as_array().expect("compact") {
        let maximum = usize::try_from(case["maximum"].as_u64().expect("maximum")).expect("usize");
        assert_eq!(values::compact_value(&case["input"], maximum), case["text"].as_str().expect("text"), "compact {}", case["input"]);
    }
}

fn replay_layout(g: &Value) {
    for case in cases(g, "labels") {
        assert_eq!(labels_value(preset_labels(&case["input"])), case["labels"], "labels {}", case["input"]);
    }
    for case in cases(g, "pageSizes") {
        let actual = attempt(page_size_points(Some(&case["input"]), "page size").map(|size| numbers(&size)));
        check("page size", case, &recorded(case), &actual);
    }
    let named = page_size_points(Some(&json!("x")), "paper");
    assert_eq!(named.unwrap_err(), g["pageSizesNamedLabel"]["error"].as_str().expect("error"));
    for case in cases(g, "columnWidths") {
        let input = &case["input"];
        let rows = table(&input["rows"]);
        let actual = natural_column_widths(&rows, measure, input["available"].as_f64().expect("available")).map_or(Value::Null, |list| numbers(&list));
        check("column widths", case, &case["widths"], &actual);
    }
    for case in cases(g, "columnAlignments") {
        let input = &case["input"];
        let declared: Vec<Value> = input["declared"].as_array().cloned().unwrap_or_default();
        let columns = usize::try_from(input["columns"].as_u64().expect("columns")).expect("usize");
        let header = input["header"].as_bool().unwrap_or(true);
        let actual = figure_column_alignments(&table(&input["rows"]), columns, &declared, header);
        assert_eq!(actual, strings(&case["alignments"]), "alignments {}", json_stringify(input));
    }
    for case in cases(g, "wrapUnits") {
        assert_eq!(wrap_units(&strings(&case["input"])), strings(&case["units"]), "wrapUnits {}", case["input"]);
    }
    for case in cases(g, "withoutRunt") {
        let input = &case["input"];
        let lines = without_runt(&strings(&input["lines"]), line_width, input["limit"].as_f64().expect("limit"));
        assert_eq!(lines, strings(&case["lines"]), "withoutRunt {}", json_stringify(input));
    }
    for case in cases(g, "koreanParticles") {
        let actual: Vec<Value> = korean_particle_replacements(&case["input"])
            .into_iter()
            .map(|r| json!({ "key": r.key, "find": r.find, "replace": r.replace }))
            .collect();
        check("particles", case, &case["replacements"], &Value::Array(actual));
    }
    for case in cases(g, "asarPaths") {
        assert_eq!(physical_asar_path(case["input"].as_str().expect("input")), case["path"].as_str().expect("path"));
    }
}

fn replay_formats(g: &Value) {
    let f = &g["formats"];
    let table_pairs: Vec<Value> = FILE_KIND_TO_FORMAT.iter().map(|(kind, format)| json!([kind, format])).collect();
    assert_eq!(Value::Array(table_pairs), f["fileKindToFormat"]);
    assert_eq!(FORMATS.to_vec(), strings(&f["formats"]));
    assert_eq!(TABULAR_FORMATS.to_vec(), strings(&f["tabular"]));
    assert_eq!(OOXML_FORMATS.to_vec(), strings(&f["ooxml"]));
    for case in f["paths"].as_array().expect("paths") {
        let path = case["input"].as_str().expect("input");
        check("file kind", case, &case["kind"], &attempt(formats::document_file_kind(path).map(Value::from)));
        check("format", case, &case["format"], &attempt(formats::document_format(path).map(Value::from)));
        assert_eq!(formats::legacy_package_kind(path), case["legacy"].as_str().expect("legacy"), "legacy {path}");
    }
    for case in f["normalize"].as_array().expect("normalize") {
        let actual = attempt(formats::normalize_office_format(case["input"].as_str().expect("input")).map(Value::from));
        check("normalize", case, &recorded(case), &actual);
    }
}

fn replay_envelopes(g: &Value) {
    for case in cases(g, "envelopes") {
        let input = &case["input"];
        let images: Vec<ToolImage> = input["images"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|image| ToolImage {
                        mime_type: image["mimeType"].as_str().expect("mimeType").to_owned(),
                        data: image["data"].as_str().expect("data").to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let result = tool_result(&input["value"], input["isError"].as_bool().unwrap_or(false), &images);
        assert_eq!(json_stringify(&result), case["text"].as_str().expect("text"), "envelope {}", json_stringify(input));
        assert_eq!(result, case["result"]);
    }
    assert_eq!(CONFLICT_MESSAGE, g["conflict"]["message"].as_str().expect("message"));
}

fn cell_value(cell: &XlsxCell) -> Value {
    json!({ "ref": cell.reference, "row": cell.row, "column": cell.column })
}

fn replay_a1(g: &Value) {
    let a = &g["a1"];
    for case in a["columnLabel"].as_array().expect("columnLabel") {
        assert_eq!(a1::column_label(case["input"].as_f64().expect("input")), case["label"].as_str().expect("label"), "columnLabel {}", case["input"]);
    }
    for case in a["columnNumber"].as_array().expect("columnNumber") {
        let actual = json_number(a1::column_number(case["input"].as_str().expect("input")));
        check("columnNumber", case, &case["number"], &actual);
    }
    for case in a["cellRef"].as_array().expect("cellRef") {
        let actual = attempt(a1::parse_cell_ref(case["input"].as_str().expect("input")).map(|cell| json!({ "col": cell.col, "row": cell.row, "ref": cell.reference })));
        check("cellRef", case, &recorded(case), &actual);
    }
    for case in a["xlsxCell"].as_array().expect("xlsxCell") {
        let actual = attempt(a1::parse_xlsx_cell(case["input"].as_str().expect("input")).map(|cell| cell_value(&cell)));
        check("xlsxCell", case, &recorded(case), &actual);
    }
    for case in a["xlsxRange"].as_array().expect("xlsxRange") {
        let input = &case["input"];
        let max = input["maxCells"].as_u64().map_or(XLSX_MAX_RANGE_CELLS, |max| usize::try_from(max).expect("usize"));
        let actual = attempt(a1::parse_xlsx_range(input["input"].as_str().expect("input"), max).map(|range| {
            json!({ "start": cell_value(&range.start), "end": cell_value(&range.end), "rows": range.rows, "columns": range.columns, "cells": range.cells })
        }));
        check("xlsxRange", case, &recorded(case), &actual);
    }
}

#[test]
fn every_output_equals_the_recording() {
    let g = golden();
    replay_values(&g);
    replay_layout(&g);
    replay_formats(&g);
    replay_envelopes(&g);
    replay_a1(&g);
}

/// Records again with Node and compares: `cargo test -p mixdog-office-base --test twin_shared -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/shared and core/office-core.mjs)"]
fn twin_live_shared() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-shared.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
