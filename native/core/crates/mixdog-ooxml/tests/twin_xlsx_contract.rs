//! Twin test `xlsx_contract`: the recording of Node's XLSX contract and audit modules
//! (`native/core/fixtures/office-xlsx-contract/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-xlsx-contract.mjs`) against this crate. `pure` replays the reading
//! helpers, the formula and range helpers and the operation checks on their recorded arguments (the result or the error
//! message each gave); `audits` replays the hygiene and layout audits of each fixture workbook sheet by sheet and its
//! convention summary, and compares them as JSON text, so the order of findings and of keys is the recorded one.
//! Re-recording is `twin_live_xlsx_contract` (ignored: it runs Node).

use mixdog_js::{json_number, to_number};
use mixdog_office_base::twin;
use mixdog_ooxml::sheet_xml::Area;
use mixdog_ooxml::xlsx_audit_support::{
    IssueList, MAX_ISSUES_PER_CODE, Position, escape_reg_exp, false_value, formula_body, general_format, has_visible_style,
    inside_area, inside_table_body, is_marked_input_style, is_numeric_cell, list, locate, merged_areas, noted_refs,
    numeric_value, position, sheet_path, table_areas, text_or_empty, text_or_empty_nullish,
};
use mixdog_ooxml::xlsx_audit_support::cell_path;
use mixdog_ooxml::xlsx_contract::{
    AutofitRange, conditional_format_kind, expand_filled_formulas, filled_formula, list_validation_choices,
    normalize_xlsx_formula, parse_xlsx_autofit_range, quote_unquoted_sheet_references, validate_xlsx_operations,
};
use mixdog_ooxml::xlsx_conventions::summarize_xlsx_conventions;
use mixdog_ooxml::xlsx_sheet_hygiene::{audit_sheet_hygiene, audit_sheet_layout, external_defined_names};
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-xlsx-contract")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string argument")
}

/// The engine's shared-formula move of the recorder: the formula it is given and the deltas.
fn translate(formula: &str, rows: i64, columns: i64) -> String {
    format!("T({formula}|{rows}|{columns})")
}

fn number_json(value: Option<f64>) -> Value {
    value.map_or(Value::Null, json_number)
}

fn position_json(at: &Position) -> Value {
    json!({ "row": json_number(at.row), "column": json_number(at.column) })
}

fn area_fields(area: &Area) -> serde_json::Map<String, Value> {
    let mut fields = serde_json::Map::new();
    fields.insert("startCol".to_owned(), json_number(area.start_col));
    fields.insert("endCol".to_owned(), json_number(area.end_col));
    fields.insert("startRow".to_owned(), json_number(area.start_row));
    fields.insert("endRow".to_owned(), json_number(area.end_row));
    fields
}

fn area_of(value: &Value) -> Area {
    Area {
        start_col: to_number(&value["startCol"]),
        end_col: to_number(&value["endCol"]),
        start_row: to_number(&value["startRow"]),
        end_row: to_number(&value["endRow"]),
    }
}

fn autofit_json(range: &AutofitRange) -> Value {
    let cell = |cell: &mixdog_office_base::a1::XlsxCell| json!({ "ref": cell.reference, "row": cell.row, "column": cell.column });
    match range {
        AutofitRange::Columns { start, end } => json!({ "type": "columns", "start": json_number(*start), "end": json_number(*end) }),
        AutofitRange::Rows { start, end } => json!({ "type": "rows", "start": json_number(*start), "end": json_number(*end) }),
        AutofitRange::Cells(area) => json!({
            "type": "cells", "start": cell(&area.start), "end": cell(&area.end),
            "rows": area.rows, "columns": area.columns, "cells": area.cells,
        }),
    }
}

fn issue_list(pushes: &[Value]) -> Value {
    let mut issues = IssueList::new();
    let many = pushes.len() > 20;
    for push in pushes {
        let severity = if text(&push[0]) == "warning" { "warning" } else { "info" };
        let code = match text(&push[1]) {
            "a" => "a",
            "b" => "b",
            "x" => "x",
            "y" => "y",
            other => panic!("the recording pushes a code this test does not know: {other}"),
        };
        if many {
            issues.push(severity, code, "/p", "m");
        } else {
            issues.push(severity, code, format!("/p/{code}"), format!("m {code}"));
        }
    }
    if many {
        let first = issues.issues.first().map_or(Value::Null, |issue| issue.to_json());
        let last = issues.issues.last().map_or(Value::Null, |issue| issue.to_json());
        json!({ "issues": issues.issues.len(), "omitted": issues.omitted, "first": first, "last": last })
    } else {
        issues.to_json()
    }
}

fn pure(name: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |at: usize| &args[at];
    Ok(match name {
        "escapeRegExp" => json!(escape_reg_exp(text(arg(0)))),
        "sheetPath" => json!(sheet_path(arg(0))),
        "cellPath" => json!(cell_path(arg(0), arg(1))),
        "formulaBody" => json!(formula_body(Some(arg(0)))),
        "numericValue" => number_json(numeric_value(arg(0))),
        "isNumericCell" => json!(is_numeric_cell(arg(0))),
        "falseValue" => json!(false_value(arg(0))),
        "position" => position(arg(0)).map_or(Value::Null, |at| position_json(&at)),
        "locate" => Value::Array(
            locate(arg(0).as_array().expect("cells"))
                .iter()
                .map(|entry| json!({ "cell": entry.cell, "at": position_json(&entry.at) }))
                .collect(),
        ),
        "generalFormat" => json!(general_format(Some(arg(0)))),
        "isMarkedInputStyle" => json!(is_marked_input_style(Some(arg(0)))),
        "hasVisibleStyle" => json!(has_visible_style(Some(arg(0)))),
        "tableAreas" => Value::Array(
            table_areas(arg(0))
                .iter()
                .map(|entry| {
                    let mut fields = area_fields(&entry.area);
                    fields.insert("table".to_owned(), entry.table.clone());
                    Value::Object(fields)
                })
                .collect(),
        ),
        "mergedAreas" => Value::Array(merged_areas(arg(0)).iter().map(|area| Value::Object(area_fields(area))).collect()),
        "insideArea" | "insideTableBody" => {
            let areas: Vec<Area> = arg(0).as_array().expect("areas").iter().map(area_of).collect();
            let at = Position { row: to_number(&arg(1)["row"]), column: to_number(&arg(1)["column"]) };
            json!(if name == "insideArea" { inside_area(&areas, &at) } else { inside_table_body(&areas, &at) })
        }
        "notedRefs" => {
            let mut refs: Vec<String> = noted_refs(arg(0), arg(1).as_array().expect("cells")).into_iter().collect();
            refs.sort();
            json!(refs)
        }
        "issueList" => issue_list(arg(0).as_array().expect("pushes")),
        "filledFormula" => json!(filled_formula(
            &text_or_empty_nullish(Some(arg(0))),
            to_number(arg(1)) as i64,
            to_number(arg(2)) as i64,
            &translate
        )),
        "expandFilledFormulas" => Value::Array(expand_filled_formulas(arg(0).as_array().expect("operations"), &translate)?),
        "parseXlsxAutofitRange" => autofit_json(&parse_xlsx_autofit_range(text(arg(0)))?),
        "quoteUnquotedSheetReferences" => json!(quote_unquoted_sheet_references(text(arg(0)))),
        "normalizeXlsxFormula" => {
            let options = arg(1);
            let names: Option<Vec<String>> = options
                .get("sheetNames")
                .and_then(Value::as_array)
                .map(|names| names.iter().map(|name| text_or_empty(Some(name))).collect());
            let backend = options.get("backend").and_then(Value::as_str).unwrap_or("");
            json!(normalize_xlsx_formula(arg(0), backend, names.as_deref())?)
        }
        "listValidationChoices" => json!(list_validation_choices(arg(0))),
        "conditionalFormatKind" => json!(conditional_format_kind(arg(0))?),
        "validateXlsxOperation" => {
            let mut operations = vec![arg(0).clone()];
            validate_xlsx_operations(&mut operations)?;
            Value::Array(operations)
        }
        "validateXlsxOperations" => match arg(0) {
            Value::Array(operations) => {
                let mut operations = operations.clone();
                validate_xlsx_operations(&mut operations)?;
                Value::Array(operations)
            }
            _ => Value::Null,
        },
        other => panic!("the recording has a function this test does not replay: {other}"),
    })
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn attempt(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    }
}

fn replay_audit(audit: &Value) {
    let name = text(&audit["name"]);
    let document = &audit["document"];
    let sheets = list(document.get("sheets"));
    let sheet_names: Vec<String> = sheets.iter().map(|sheet| text_or_empty(sheet.get("name"))).collect();
    let external = external_defined_names(list(document.get("definedNames")));
    assert_eq!(audit["externalNames"].to_string(), json!(external).to_string(), "{name}: external names");
    let recorded = audit["sheets"].as_array().expect("sheets");
    assert_eq!(recorded.len(), sheets.len(), "{name}");
    for (sheet, expected) in sheets.iter().zip(recorded) {
        let cells = list(sheet.get("cells"));
        let mut found = IssueList::new();
        audit_sheet_hygiene(&mut found, sheet, cells, &sheet_names, &external);
        audit_sheet_layout(&mut found, sheet, cells);
        assert_eq!(expected.to_string(), found.to_json().to_string(), "{name}: sheet {}", text_or_empty(sheet.get("name")));
    }
    let conventions = summarize_xlsx_conventions(document).unwrap_or(Value::Null);
    assert_eq!(audit["conventions"].to_string(), conventions.to_string(), "{name}: conventions");
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let pure_cases = golden["pure"].as_array().expect("pure cases");
    assert!(pure_cases.len() > 400, "the recording lost cases: {}", pure_cases.len());
    for case in pure_cases {
        let name = text(&case["fn"]);
        let args = case["args"].as_array().expect("arguments");
        let produced = attempt(pure(name, args));
        let expected = match case.get("error") {
            Some(error) => json!({ "error": error }),
            None => json!({ "result": case["result"] }),
        };
        let shown = Value::Array(args.clone()).to_string();
        let cut: String = shown.chars().take(160).collect();
        twin::assert_matches(&format!("{name}({cut})"), &expected, &produced);
    }
    let audits = golden["audits"].as_array().expect("audits");
    assert!(audits.len() >= 7, "the recording lost audits: {}", audits.len());
    for audit in audits {
        replay_audit(audit);
    }
    let capped = audits.iter().find(|audit| text(&audit["name"]) == "capped").expect("the capped workbook");
    assert_eq!(capped["sheets"][0]["omitted"], 30);
    assert_eq!(capped["sheets"][0]["issues"].as_array().map(Vec::len), Some(MAX_ISSUES_PER_CODE));
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_xlsx_contract -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_xlsx_contract() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-xlsx-contract.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
