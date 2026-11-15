//! Twin test `xlsx_layout_audits`: the recording of Node's portable range-layout, pivot-operation, formula-audit and
//! assertion modules (`native/core/fixtures/office-xlsx-layout-audits/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-xlsx-layout-audits.mjs`) against this crate. `layouts` replays each workbook
//! with its sorts, autofits and pivot tables: what each step answered, the names of the package afterwards and the text of
//! every part that changed (every other part must be as it was). `audits`, `merges` and `assertions` replay the formula audit,
//! its merge into a host's answer and the workbook assertions on their recorded snapshots and compare them as JSON text, so
//! the order of findings and of keys is the recorded one. `pure` replays the helpers on their recorded arguments. Text widths
//! are measured in the fixture faces of `office-measure` registered on both sides. Re-recording is
//! `twin_live_xlsx_layout_audits` (ignored: it runs Node).
//!
//! The second half ports `src/runtime/office/xlsx-formula-audit.test.mjs` for what this crate holds: the audit and its
//! helpers, the workbook conventions, the formula normalisation and the Excel style shape. (Its recalculation error summary
//! and structure review belong to the modules that hold them.)

use std::collections::HashMap;

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::json_number;
use mixdog_office_base::twin;
use mixdog_ooxml::cells::{Sheet, workbook_sheets};
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::xlsx_assertions::evaluate_xlsx_assertions;
use mixdog_ooxml::xlsx_formula_audit::{
    AuditOptions, audit_xlsx_formulas, inline_constants, is_checks_sheet_name, merge_xlsx_formula_audit, relative_formula_signature,
    single_cell_references, unguarded_division,
};
use mixdog_ooxml::xlsx_pivot_ops::add_worksheet_pivot_table;
use mixdog_ooxml::xlsx_range_layout::{autofit_worksheet_range, sort_worksheet_range};
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-xlsx-layout-audits")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[][..], Vec::as_slice)
}

fn parts_of(value: &Value) -> Vec<(String, String)> {
    list(value).iter().map(|pair| (text(&pair[0]).to_owned(), text(&pair[1]).to_owned())).collect()
}

fn package(parts: &[(String, String)]) -> Package {
    let mut zip = Package::new();
    for (name, content) in parts {
        zip.set(name, content.as_bytes().to_vec());
    }
    zip
}

fn file_names(zip: &Package) -> Vec<String> {
    zip.names().into_iter().filter(|name| zip.file(name).is_some()).collect()
}

/// The first place two texts differ, with what lies around it.
fn difference(expected: &str, actual: &str) -> String {
    let at = expected.chars().zip(actual.chars()).take_while(|(a, b)| a == b).count();
    let around = |text: &str| text.chars().skip(at.saturating_sub(60)).take(160).collect::<String>();
    format!("at character {at}\n recorded: {}\n produced: {}", around(expected), around(actual))
}

fn registry(golden: &Value) -> Registry {
    let mut registry = Registry::new();
    let dir = twin::repo_root().join("native/core/fixtures/office-measure");
    for (alias, faces) in golden["faces"].as_object().expect("faces") {
        for face in list(faces) {
            let path = dir.join(text(&face["file"]));
            registry.register_file(&Unlaned, &path, Some(alias)).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        }
    }
    registry
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn attempt(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    }
}

fn run_step(measurer: &TextMeasurer<'_, Unlaned>, zip: &mut Package, step: &Value) -> Result<Value, String> {
    let sheets = workbook_sheets(zip);
    let sheet: Sheet = sheets.iter().find(|entry| entry.name == text(&step["sheet"])).expect("a sheet of the workbook").clone();
    let xml = zip.text(&sheet.path);
    let op: &Map<String, Value> = step["op"].as_object().expect("an operation");
    match text(&step["kind"]) {
        "sort" => sort_worksheet_range(zip, &sheet, &xml, op),
        "autofit" => autofit_worksheet_range(measurer, zip, &sheet, &xml, op),
        "pivot" => add_worksheet_pivot_table(measurer, zip, &sheet, &xml, op),
        other => panic!("the recording has a step this test does not replay: {other}"),
    }
}

fn replay_layout(measurer: &TextMeasurer<'_, Unlaned>, case: &Value, workbooks: &Value) {
    let name = text(&case["name"]);
    let before = parts_of(&workbooks[text(&case["workbook"])]);
    let mut zip = package(&before);
    let steps = list(&case["steps"]);
    let outputs = list(&case["outputs"]);
    assert_eq!(steps.len(), outputs.len(), "{name}");
    for (index, (step, recorded)) in steps.iter().zip(outputs).enumerate() {
        let produced = attempt(run_step(measurer, &mut zip, step));
        assert_eq!(recorded.to_string(), produced.to_string(), "{name}: step {index}");
    }
    let recorded_names: Vec<String> = list(&case["names"]).iter().map(|entry| text(entry).to_owned()).collect();
    assert_eq!(file_names(&zip), recorded_names, "{name}: the parts of the package");
    let changed = parts_of(&case["changed"]);
    let untouched: HashMap<&str, &str> = before.iter().map(|(part, content)| (part.as_str(), content.as_str())).collect();
    for (part, content) in &changed {
        let produced = zip.text(part);
        assert!(produced == *content, "{name}: {part} {}", difference(content, &produced));
    }
    let changed_names: Vec<&str> = changed.iter().map(|(part, _)| part.as_str()).collect();
    for part in &recorded_names {
        if changed_names.contains(&part.as_str()) {
            continue;
        }
        let produced = zip.text(part);
        let was = untouched.get(part.as_str()).copied().unwrap_or("");
        assert!(produced == was, "{name}: {part} changed although Node left it as it was {}", difference(was, &produced));
    }
}

fn audit_options(options: &Value) -> (String, Vec<String>, Vec<Value>) {
    let profile = options.get("auditProfile").and_then(Value::as_str).unwrap_or("").to_owned();
    let names = list(options.get("sheetNames").unwrap_or(&Value::Null)).iter().map(|name| text(name).to_owned()).collect();
    let defined = list(options.get("definedNames").unwrap_or(&Value::Null)).to_vec();
    (profile, names, defined)
}

fn replay_audit(case: &Value) {
    let name = text(&case["name"]);
    let (profile, names, defined) = audit_options(&case["options"]);
    let found = audit_xlsx_formulas(list(&case["sheets"]), &AuditOptions { audit_profile: &profile, sheet_names: &names, defined_names: &defined });
    let produced = Value::Array(found.iter().map(|issue| issue.to_json()).collect());
    assert_eq!(case["output"]["result"].to_string(), produced.to_string(), "{name}");
}

fn replay_merge(case: &Value) {
    let name = text(&case["name"]);
    let options = &case["options"];
    let produced = merge_xlsx_formula_audit(
        &case["result"],
        &case["document"],
        options.get("auditProfile").and_then(Value::as_str).unwrap_or(""),
        options.get("sheet").and_then(Value::as_str).unwrap_or(""),
    );
    assert_eq!(case["output"]["result"].to_string(), produced.to_string(), "{name}");
}

fn replay_assertions(case: &Value) {
    let name = text(&case["name"]);
    let produced = attempt(evaluate_xlsx_assertions(&case["document"], list(&case["assertions"])));
    assert_eq!(case["output"].to_string(), produced.to_string(), "{name}");
}

fn replay_pure(case: &Value) {
    let args = list(&case["args"]);
    let produced = match text(&case["fn"]) {
        "relativeFormulaSignature" => json!(relative_formula_signature(text(&args[0]), text(&args[1]))),
        "inlineConstants" => json!(inline_constants(text(&args[0]))),
        "unguardedDivision" => json!(unguarded_division(text(&args[0]))),
        "singleCellReferences" => Value::Array(
            single_cell_references(text(&args[0]))
                .iter()
                .map(|found| json!({ "ref": found.reference, "column": json_number(found.column), "row": json_number(found.row) }))
                .collect(),
        ),
        "isChecksSheetName" => json!(is_checks_sheet_name(args[0].as_str().unwrap_or(""))),
        other => panic!("the recording has a helper this test does not replay: {other}"),
    };
    let shown: String = Value::Array(args.to_vec()).to_string().chars().take(160).collect();
    assert_eq!(case["result"].to_string(), produced.to_string(), "{}({shown})", text(&case["fn"]));
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let registry = registry(&golden);
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    let layouts = list(&golden["layouts"]);
    assert!(layouts.len() >= 40, "the recording lost layouts: {}", layouts.len());
    for case in layouts {
        replay_layout(&measurer, case, &golden["workbooks"]);
    }
    let audits = list(&golden["audits"]);
    assert!(audits.len() >= 30, "the recording lost audits: {}", audits.len());
    for case in audits {
        replay_audit(case);
    }
    for case in list(&golden["merges"]) {
        replay_merge(case);
    }
    for case in list(&golden["assertions"]) {
        replay_assertions(case);
    }
    let pure = list(&golden["pure"]);
    assert!(pure.len() >= 25, "the recording lost helper cases: {}", pure.len());
    for case in pure {
        replay_pure(case);
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_xlsx_layout_audits -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_xlsx_layout_audits() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-xlsx-layout-audits.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}

// ---- src/runtime/office/xlsx-formula-audit.test.mjs

/// `sheet(name, cells)` of the Node test: a snapshot sheet whose cells carry their path.
fn sheet(name: &str, cells: &[(&str, Value)]) -> Value {
    let cells: Vec<Value> = cells
        .iter()
        .map(|(reference, entry)| {
            let mut cell = Map::new();
            cell.insert("ref".to_owned(), json!(reference));
            cell.insert("path".to_owned(), json!(format!("/sheet[{name}]/cell[{reference}]")));
            cell.extend(entry.as_object().expect("a cell").clone());
            Value::Object(cell)
        })
        .collect();
    json!({ "name": name, "path": format!("/sheet[{name}]"), "cells": cells })
}

fn with(sheet: &Value, extra: Value) -> Value {
    let mut merged = sheet.as_object().expect("a sheet").clone();
    merged.extend(extra.as_object().expect("fields").clone());
    Value::Object(merged)
}

fn audit(sheets: &[Value], profile: &str, names: &[&str], defined: &[Value]) -> Vec<mixdog_ooxml::xlsx_audit_support::Issue> {
    let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
    audit_xlsx_formulas(sheets, &AuditOptions { audit_profile: profile, sheet_names: &names, defined_names: defined })
}

fn codes_at(issues: &[mixdog_ooxml::xlsx_audit_support::Issue], code: &str) -> Vec<String> {
    issues.iter().filter(|issue| issue.code == code).map(|issue| issue.path.clone()).collect()
}

#[test]
fn a_formula_reading_a_defined_name_that_links_to_another_workbook_is_an_external_link() {
    let rates = sheet(
        "Plan",
        &[
            ("B2", json!({ "formula": "=FxRate*A2", "value": 1300 })),
            ("B3", json!({ "formula": "=FxRateLocal*A3", "value": 1 })),
            ("B4", json!({ "formula": "=\"FxRate\"&A4", "value": "FxRate1" })),
            ("B5", json!({ "formula": "=Local*A5", "value": 2 })),
        ],
    );
    let defined = [
        json!({ "name": "FxRate", "refersTo": "[1]Rates!$B$2" }),
        json!({ "name": "FxRateLocal", "refersTo": "Plan!$A$1" }),
        json!({ "name": "Local", "refersTo": "Plan!$A$1" }),
    ];
    let findings = audit(std::slice::from_ref(&rates), "", &[], &defined);
    assert_eq!(codes_at(&findings, "external_link_reference"), ["/sheet[Plan]/cell[B2]"]);
    let message = &findings.iter().find(|issue| issue.code == "external_link_reference").expect("a finding").message;
    assert!(message.contains("reads FxRate, a defined name"), "{message}");
    assert!(codes_at(&audit(&[rates], "", &[], &[]), "external_link_reference").is_empty());
}

#[test]
fn relative_formula_signatures_match_a_pattern_copied_along_a_row_and_ignore_string_literals() {
    assert_eq!(relative_formula_signature("=B2*(1+$B$10)", "C2"), relative_formula_signature("=C2*(1+$B$10)", "D2"));
    assert_ne!(relative_formula_signature("=B2*(1+$B$10)", "C2"), relative_formula_signature("=B2*1.1", "C2"));
    assert_eq!(relative_formula_signature("=IF(A1=\"B2\",LOG10(A1),0)", "C1"), "IF(R[0]C[-2]=\"\",LOG10(R[0]C[-2]),0)");
}

#[test]
fn inline_constants_and_unguarded_division_follow_the_modelling_rules() {
    assert_eq!(inline_constants("=B5*1.05"), ["1.05"]);
    assert_eq!(inline_constants("=B5*(1+0.05)"), ["0.05"]);
    assert!(inline_constants("=ROUND(B5/12,2)*100").is_empty());
    assert!(inline_constants("=B5*(1+$B$6)").is_empty());
    assert!(unguarded_division("=B5/C5"));
    assert!(unguarded_division("=B5/(C5-D5)"));
    assert!(!unguarded_division("=B5/100"));
    assert!(!unguarded_division("=IFERROR(B5/C5,0)"));
    assert!(!unguarded_division("=IF(C5=0,0,B5/C5)"));
    // A discount factor's base is zero only at a -100% rate; a second division in the same formula still counts.
    assert!(!unguarded_division("=1/(1+Assumptions!$B$9)^(C$3-$B$3)"));
    assert!(!unguarded_division("=C7/(1+$B$9)"));
    assert!(unguarded_division("=C7/(1+$B$9)/D7"));
}

#[test]
fn a_table_column_where_one_row_wears_another_number_format_is_reported() {
    let table = |style: Value| {
        with(
            &sheet(
                "Sales",
                &[
                    ("A1", json!({ "value": "Region" })),
                    ("B1", json!({ "value": "Revenue" })),
                    ("A2", json!({ "value": "서울" })),
                    ("B2", json!({ "value": 1200, "style": { "numberFormat": "#,##0" } })),
                    ("A3", json!({ "value": "부산" })),
                    ("B3", json!({ "value": 900, "style": { "numberFormat": "#,##0" } })),
                    ("A4", json!({ "value": "대구" })),
                    ("B4", json!({ "value": 640, "style": { "numberFormat": "#,##0" } })),
                    ("A5", json!({ "value": "대전" })),
                    ("B5", json!({ "value": 480, "style": style })),
                ],
            ),
            json!({ "tables": [{ "name": "Sales", "range": "A1:B5" }] }),
        )
    };
    let drifted = audit(&[table(json!({ "numberFormat": "0.00" }))], "", &[], &[]);
    assert_eq!(codes_at(&drifted, "number_format_inconsistent"), ["/sheet[Sales]/table[1]"]);
    assert!(drifted.iter().find(|issue| issue.code == "number_format_inconsistent").expect("a finding").message.contains("B5 under a format"));
    assert!(codes_at(&audit(&[table(json!({ "numberFormat": "#,##0" }))], "", &[], &[]), "number_format_inconsistent").is_empty());
}

#[test]
fn a_total_whose_range_covers_a_subtotal_of_the_same_rows_is_reported_under_every_profile() {
    let doubled = sheet(
        "Ops",
        &[
            ("A1", json!({ "value": "Region" })),
            ("B2", json!({ "value": 10 })),
            ("B3", json!({ "value": 20 })),
            ("B4", json!({ "value": 30 })),
            ("B5", json!({ "formula": "SUM(B2:B4)", "value": 60 })),
            ("B6", json!({ "formula": "SUM(B2:B5)", "value": 120 })),
        ],
    );
    let issues = audit(&[doubled], "", &[], &[]);
    assert_eq!(codes_at(&issues, "subtotal_double_counted"), ["/sheet[Ops]/cell[B6]"]);
    assert!(issues.iter().find(|issue| issue.code == "subtotal_double_counted").expect("a finding").message.contains("covers B5"));
}

#[test]
fn running_totals_detail_only_totals_and_derived_rows_are_never_read_as_double_counting() {
    let clean = sheet(
        "Ops",
        &[
            ("B2", json!({ "value": 10 })),
            ("B3", json!({ "formula": "C3*D3", "value": 20 })),
            ("B4", json!({ "value": 30 })),
            ("B5", json!({ "formula": "SUM(B2:B4)", "value": 60 })),
            ("C2", json!({ "formula": "SUM($B$2:B2)", "value": 10 })),
            ("C3", json!({ "formula": "SUM($B$2:B3)", "value": 30 })),
            ("C4", json!({ "formula": "SUM($B$2:B4)", "value": 60 })),
            ("E5", json!({ "formula": "SUM('Detail Rows'!B2:B4)", "value": 60 })),
        ],
    );
    assert!(codes_at(&audit(&[clean], "", &[], &[]), "subtotal_double_counted").is_empty());
}

fn model_sheet() -> Value {
    sheet(
        "Model",
        &[
            ("A1", json!({ "value": "Growth", "style": { "bold": true } })),
            ("B1", json!({ "value": 0.05 })),
            ("B2", json!({ "value": 100 })),
            ("C2", json!({ "formula": "B2*(1+$B$1)", "value": 105 })),
            ("D2", json!({ "formula": "C2*(1+$B$1)", "value": 110.25 })),
            ("E2", json!({ "formula": "D2*1.1", "value": 121.3 })),
            ("F2", json!({ "formula": "E2*(1+$B$1)", "value": 127.3 })),
            ("G2", json!({ "formula": "F2*(1+$B$1)", "value": 133.7 })),
            ("B3", json!({ "value": 10 })),
            ("C3", json!({ "formula": "B3+1", "value": 11 })),
            ("D3", json!({ "value": 12 })),
            ("E3", json!({ "formula": "D3+1", "value": 13 })),
            ("F3", json!({ "value": 14 })),
            ("B4", json!({ "formula": "B2/B3", "value": 10 })),
            ("B5", json!({ "value": 15, "style": { "numberFormat": "0.0%" } })),
            ("B6", json!({ "value": 2024, "style": { "numberFormat": "#,##0" } })),
            ("B7", json!({ "formula": "Input Sheet!B2+'Input Sheet'!B3", "value": 3 })),
            ("B8", json!({ "formula": "'[1]Returns Analysis'!$B$2", "value": 9 })),
            ("B9", json!({ "value": 7 })),
            ("B10", json!({ "value": 8 })),
        ],
    )
}

#[test]
fn financial_model_audit_reports_modelling_discipline_and_every_profile_reports_workbook_hygiene() {
    let model = model_sheet();
    let names = ["Model", "Input Sheet"];
    let financial = audit(std::slice::from_ref(&model), "financial-model", &names, &[]);
    assert_eq!(codes_at(&financial, "inline_constant_in_formula"), ["/sheet[Model]/cell[E2]"]);
    assert_eq!(codes_at(&financial, "formula_pattern_inconsistency"), ["/sheet[Model]/cell[E2]"]);
    assert_eq!(codes_at(&financial, "formula_inconsistency"), ["/sheet[Model]/cell[D3]"]);
    // A schedule whose periods run down the page carries the same defect in the other direction: a pasted result between the
    // formulas of one column was read only as an input without a source, never as the break in the schedule.
    let downward = sheet(
        "Schedule",
        &[
            ("A1", json!({ "value": "분기", "dataType": "text" })),
            ("B1", json!({ "value": "매출", "dataType": "text" })),
            ("C1", json!({ "value": "누계", "dataType": "text" })),
            ("A2", json!({ "value": "1분기", "dataType": "text" })),
            ("B2", json!({ "value": 100 })),
            ("C2", json!({ "formula": "SUM($B$2:B2)", "value": 100 })),
            ("A3", json!({ "value": "2분기", "dataType": "text" })),
            ("B3", json!({ "value": 110 })),
            ("C3", json!({ "formula": "SUM($B$2:B3)", "value": 210 })),
            ("A4", json!({ "value": "3분기", "dataType": "text" })),
            ("B4", json!({ "value": 120 })),
            ("C4", json!({ "value": 330 })),
            ("A5", json!({ "value": "4분기", "dataType": "text" })),
            ("B5", json!({ "value": 130 })),
            ("C5", json!({ "formula": "SUM($B$2:B5)", "value": 460 })),
        ],
    );
    let schedule = audit(&[downward], "financial-model", &["Schedule"], &[]);
    assert_eq!(codes_at(&schedule, "formula_inconsistency"), ["/sheet[Schedule]/cell[C4]"]);
    // The inputs the schedule reads are not interruptions: only the cell the formulas of one column bracket is.
    assert!(codes_at(&schedule, "rogue_hardcode").is_empty());
    assert_eq!(codes_at(&financial, "rogue_hardcode"), ["/sheet[Model]/cell[F3]"]);
    assert_eq!(codes_at(&financial, "unguarded_division"), ["/sheet[Model]/cell[B4]"]);
    assert_eq!(codes_at(&financial, "percentage_stored_as_whole"), ["/sheet[Model]/cell[B5]"]);
    assert_eq!(codes_at(&financial, "year_with_thousands_separator"), ["/sheet[Model]/cell[B6]"]);
    assert_eq!(codes_at(&financial, "unquoted_sheet_reference"), ["/sheet[Model]/cell[B7]"]);
    assert_eq!(codes_at(&financial, "external_link_reference"), ["/sheet[Model]/cell[B8]"]);
    assert_eq!(codes_at(&financial, "input_cells_unmarked"), ["/sheet[Model]"]);
    assert_eq!(financial.iter().find(|issue| issue.code == "input_cells_unmarked").expect("a finding").severity, "info");

    let plain = audit(std::slice::from_ref(&model), "", &names, &[]);
    let mut plain_codes: Vec<&str> = plain.iter().map(|issue| issue.code).collect();
    plain_codes.sort_unstable();
    plain_codes.dedup();
    assert_eq!(plain_codes, ["external_link_reference", "percentage_stored_as_whole", "unquoted_sheet_reference", "year_with_thousands_separator"]);

    // A column of figures under #,##0 passes through the year range sooner or later, and every such figure was reported as a
    // year rendered with a separator; the column beside it says which it is.
    let quantities = sheet(
        "Volume",
        &[
            ("A1", json!({ "value": "월", "dataType": "text" })),
            ("B1", json!({ "value": "처리량 (건)", "dataType": "text" })),
            ("B2", json!({ "value": 1000, "style": { "numberFormat": "#,##0" } })),
            ("B3", json!({ "value": 2096, "style": { "numberFormat": "#,##0" } })),
            ("B4", json!({ "value": 2507, "style": { "numberFormat": "#,##0" } })),
        ],
    );
    assert!(codes_at(&audit(&[quantities], "", &[], &[]), "year_with_thousands_separator").is_empty());
    // A column whose numbers are all in the year range is a year column, and the separator is the defect.
    let years = sheet(
        "Plan",
        &[
            ("A1", json!({ "value": "연도", "dataType": "text" })),
            ("A2", json!({ "value": 2024, "style": { "numberFormat": "#,##0" } })),
            ("A3", json!({ "value": 2025, "style": { "numberFormat": "#,##0" } })),
        ],
    );
    assert_eq!(codes_at(&audit(&[years], "", &[], &[]), "year_with_thousands_separator"), ["/sheet[Plan]/cell[A2]", "/sheet[Plan]/cell[A3]"]);

    // Numbers stored as text never sum; a year written as text is deliberate.
    let textual = sheet(
        "Text",
        &[
            ("A2", json!({ "value": "1,234", "dataType": "text" })),
            ("B2", json!({ "value": "15%", "dataType": "text" })),
            ("C2", json!({ "value": "2024", "dataType": "text" })),
            ("D2", json!({ "value": "Q1 2024", "dataType": "text" })),
            ("E2", json!({ "value": "42" })),
        ],
    );
    assert_eq!(codes_at(&audit(&[textual], "", &[], &[]), "number_stored_as_text"), ["/sheet[Text]/cell[A2]", "/sheet[Text]/cell[B2]"]);

    // A marked input (blue font in the COM color encoding) satisfies the legend rule.
    let marked_cells: Vec<Value> = model
        .get("cells")
        .and_then(Value::as_array)
        .expect("cells")
        .iter()
        .map(|cell| if cell["ref"] == "B2" { with(cell, json!({ "style": { "color": 16_711_680 } })) } else { cell.clone() })
        .collect();
    let marked = with(&model, json!({ "cells": marked_cells }));
    assert!(!audit(&[marked], "financial-model", &[], &[]).iter().any(|issue| issue.code == "input_cells_unmarked"));
}

#[test]
fn excel_cell_styles_normalize_to_the_portable_shape() {
    use mixdog_ooxml::sheet_styles::normalize_excel_cell_style;
    assert_eq!(
        normalize_excel_cell_style(&json!({
            "fontName": "Arial", "fontSize": 11, "bold": true, "italic": false, "color": 16_711_680, "fillColor": 65_535, "numberFormat": "0.0%"
        })),
        json!({ "fontName": "Arial", "fontSize": 11, "bold": true, "numberFormat": "0.0%", "color": "0000FF", "fillColor": "FFFF00" })
    );
    assert_eq!(
        normalize_excel_cell_style(&json!({
            "fontName": "Calibri", "fontSize": 11, "bold": false, "italic": false, "color": 0, "fillColor": 16_777_215, "numberFormat": "General"
        })),
        json!({ "fontName": "Calibri", "fontSize": 11 })
    );
    // Korean Excel reports the General format as G/표준.
    assert_eq!(
        normalize_excel_cell_style(&json!({ "fontName": "맑은 고딕", "fontSize": 11, "color": 0, "fillColor": 16_777_215, "numberFormat": "G/표준" })),
        json!({ "fontName": "맑은 고딕", "fontSize": 11 })
    );
}

#[test]
fn layout_hygiene_reports_an_unfrozen_header_on_a_long_sheet_and_unformatted_numeric_table_columns_as_information() {
    let mut rows: Vec<(String, Value)> = Vec::new();
    for row in 2..=30 {
        rows.push((format!("A{row}"), json!({ "value": format!("item {row}"), "dataType": "text" })));
        rows.push((format!("B{row}"), json!({ "value": row * 10 })));
        rows.push((format!("C{row}"), json!({ "value": 2000 + (row % 5) })));
    }
    let mut entries: Vec<(&str, Value)> = vec![
        ("A1", json!({ "value": "Item", "dataType": "text" })),
        ("B1", json!({ "value": "Amount", "dataType": "text" })),
        ("C1", json!({ "value": "Year", "dataType": "text" })),
    ];
    entries.extend(rows.iter().map(|(reference, entry)| (reference.as_str(), entry.clone())));
    let long = with(
        &sheet("Long", &entries),
        json!({
            "freezePanes": { "frozen": false, "splitRow": 0, "splitColumn": 0 },
            "tables": [{ "path": "/sheet[Long]/table[1]", "index": 1, "name": "Items", "range": "A1:C30" }]
        }),
    );
    let findings = audit(std::slice::from_ref(&long), "", &[], &[]);
    assert_eq!(codes_at(&findings, "header_not_frozen"), ["/sheet[Long]"]);
    assert_eq!(codes_at(&findings, "numeric_column_unformatted"), ["/sheet[Long]/table[1]"]);
    assert!(findings.iter().find(|issue| issue.code == "numeric_column_unformatted").expect("a finding").message.starts_with("Column B of Items"));
    // Several unformatted columns are one finding about that table: repeated per column they all carry the table's path and
    // read as duplicates.
    let long_cells = long["cells"].as_array().expect("cells").clone();
    let two_columns_cells: Vec<Value> = long_cells
        .iter()
        .map(|cell| {
            let reference = cell["ref"].as_str().unwrap_or("");
            if reference.starts_with('C') && reference != "C1" {
                let digits = cell["value"].to_string();
                let last_two: String = digits.chars().rev().take(2).collect::<Vec<_>>().into_iter().rev().collect();
                let value: i64 = last_two.parse().unwrap_or(0);
                with(cell, json!({ "value": if value == 0 { 12 } else { value } }))
            } else {
                cell.clone()
            }
        })
        .collect();
    let grouped: Vec<_> = audit(&[with(&long, json!({ "cells": two_columns_cells }))], "", &[], &[])
        .into_iter()
        .filter(|issue| issue.code == "numeric_column_unformatted")
        .collect();
    assert_eq!(grouped.len(), 1, "{grouped:?}");
    assert!(grouped[0].message.starts_with("Columns B, C of Items"), "{}", grouped[0].message);
    assert!(findings.iter().all(|issue| issue.severity == "info"));

    let formatted_cells: Vec<Value> = long_cells
        .iter()
        .map(|cell| {
            let reference = cell["ref"].as_str().unwrap_or("");
            let in_body = reference.starts_with('B') && reference[1..].parse::<u32>().is_ok_and(|row| (2..=39).contains(&row));
            if in_body { with(cell, json!({ "style": { "numberFormat": "#,##0" } })) } else { cell.clone() }
        })
        .collect();
    let formatted = with(&long, json!({ "freezePanes": { "frozen": true, "splitRow": 1, "splitColumn": 0 }, "cells": formatted_cells }));
    assert!(audit(std::slice::from_ref(&formatted), "", &[], &[]).is_empty());
    // Excel reports freezePanes only for the active sheet; an unknown state is not a finding.
    assert!(audit(&[with(&formatted, json!({ "freezePanes": null }))], "", &[], &[]).is_empty());
}

#[test]
fn financial_model_audit_flags_a_single_reference_past_the_populated_extent_never_a_range_or_another_sheet() {
    let found: Vec<String> =
        single_cell_references("=SUM(B2:B9)/B10+'Other Sheet'!Z99+Other!C40+$D$3").into_iter().map(|entry| entry.reference).collect();
    assert_eq!(found, ["B10", "D3"]);
    let model = sheet(
        "Model",
        &[
            ("A1", json!({ "value": "Revenue", "dataType": "text" })),
            ("B1", json!({ "value": 100 })),
            ("B2", json!({ "value": 110 })),
            ("B3", json!({ "value": 120 })),
            ("C3", json!({ "formula": "SUM(B1:B100)", "value": 330 })),
            // The populated extent ends at row 5, column C: B6 is one row past it, D2 one column.
            ("C4", json!({ "formula": "B6*2", "value": 0 })),
            ("C5", json!({ "formula": "Other!Z99+D2", "value": 0 })),
        ],
    );
    let findings = audit(std::slice::from_ref(&model), "financial-model", &[], &[]);
    assert_eq!(codes_at(&findings, "formula_reads_beyond_data"), ["/sheet[Model]/cell[C4]", "/sheet[Model]/cell[C5]"]);
    assert!(findings.iter().find(|issue| issue.path.ends_with("[C4]")).expect("a finding").message.contains("reads B6,"));
    assert!(findings.iter().find(|issue| issue.path.ends_with("[C5]")).expect("a finding").message.contains("reads D2,"));
    assert!(!audit(&[model], "", &[], &[]).iter().any(|issue| issue.code == "formula_reads_beyond_data"));
}

fn paths_of(result: &Value, code: &str) -> Vec<String> {
    list(&result["issues"]).iter().filter(|entry| entry["code"] == code).map(|entry| text(&entry["path"]).to_owned()).collect()
}

#[test]
fn financial_model_audit_reads_notes_the_checks_sheet_and_merges_into_a_host_result_without_repeats() {
    let model = sheet(
        "Model",
        &[
            ("B1", json!({ "value": 0.05, "note": "user brief 2026-09-06" })),
            ("B2", json!({ "value": 100 })),
            ("C2", json!({ "formula": "B2*(1+$B$1)", "value": 105 })),
            ("E9", json!({ "value": 42 })),
        ],
    );
    let checks = with(
        &sheet(
            "Checks",
            &[
                ("A1", json!({ "value": "Revenue ties" })),
                ("B1", json!({ "formula": "ROUND(Model!C2-105,2)=0", "value": true })),
                ("B2", json!({ "formula": "Model!B2=99", "cachedValue": false, "value": false })),
                ("B3", json!({ "value": 3 })),
            ],
        ),
        json!({ "notes": [{ "cell": "B3", "text": "count of checks" }] }),
    );
    let findings = audit(&[model.clone(), checks.clone()], "financial-model", &[], &[]);
    assert_eq!(codes_at(&findings, "hardcode_missing_source"), ["/sheet[Model]/cell[B2]"]);
    assert_eq!(codes_at(&findings, "failed_check"), ["/sheet[Checks]/cell[B2]"]);

    // Records inside an Excel table are data the table sources, not assumptions.
    let data = with(
        &sheet(
            "Data",
            &[
                ("A1", json!({ "value": "Item" })),
                ("B1", json!({ "value": "Qty" })),
                ("B2", json!({ "value": 4 })),
                ("B3", json!({ "value": 6 })),
                ("B4", json!({ "formula": "SUM(B2:B3)", "value": 10 })),
                ("B9", json!({ "value": 9 })),
            ],
        ),
        json!({ "tables": [{ "path": "/sheet[Data]/table[1]", "index": 1, "name": "Items", "range": "A1:B3", "style": "" }] }),
    );
    assert_eq!(codes_at(&audit(&[data], "financial-model", &[], &[]), "hardcode_missing_source"), ["/sheet[Data]/cell[B9]"]);

    let host = json!({
        "ok": true,
        "issues": [
            { "severity": "warning", "code": "failed_check", "path": "/sheet[Checks]/cell[B2]", "message": "host" },
            // Excel's host calls every uncommented number on a sheet unsourced; the shared audit owns that verdict.
            { "severity": "warning", "code": "hardcode_missing_source", "path": "/sheet[Model]/cell[E9]", "message": "Hardcoded numeric input has no source comment." },
        ]
    });
    let document = json!({ "sheets": [model.clone(), checks.clone()] });
    let merged = merge_xlsx_formula_audit(&host, &document, "financial-model", "");
    assert_eq!(list(&merged["issues"]).iter().filter(|entry| entry["code"] == "failed_check").count(), 1);
    assert_eq!(merged["issues"][0]["message"], "host");
    assert_eq!(paths_of(&merged, "hardcode_missing_source"), ["/sheet[Model]/cell[B2]"]);
    assert_eq!(merged["sharedAudit"]["added"], list(&merged["issues"]).len() - 1);
    let scoped = merge_xlsx_formula_audit(&json!({ "issues": [] }), &document, "financial-model", "Checks");
    assert!(list(&scoped["issues"]).iter().all(|entry| text(&entry["path"]).starts_with("/sheet[Checks]")));

    // Excel's full read carries no cells for a sheet past 500 cells; the host's verdicts for that sheet stay, since the shared
    // audit saw nothing there.
    let unread = merge_xlsx_formula_audit(
        &json!({ "ok": true, "issues": [{ "severity": "warning", "code": "hardcode_missing_source", "path": "/sheet[Big]/cell[B1501]", "message": "host" }] }),
        &json!({ "sheets": [{ "name": "Big", "path": "/sheet[Big]", "rows": 1501, "columns": 10 }, model] }),
        "financial-model",
        "",
    );
    assert_eq!(paths_of(&unread, "hardcode_missing_source"), ["/sheet[Big]/cell[B1501]", "/sheet[Model]/cell[B2]"]);
    // A read cut at its window (a used range running to row 1501) saw only its first cells: the host keeps its verdict for a
    // cell past the cut, and loses it only for a cell the shared audit read itself.
    let big = with(&sheet("Big", &[("A1", json!({ "value": "x" })), ("B1", json!({ "value": 21 }))]), json!({ "truncated": true }));
    let cut = merge_xlsx_formula_audit(
        &json!({ "ok": true, "issues": [
            { "severity": "warning", "code": "hardcode_missing_source", "path": "/sheet[Big]/cell[B1501]", "message": "host" },
            { "severity": "warning", "code": "hardcode_missing_source", "path": "/sheet[Big]/cell[B1]", "message": "host" },
        ] }),
        &json!({ "sheets": [big] }),
        "financial-model",
        "",
    );
    let kept: Vec<(String, String)> = list(&cut["issues"])
        .iter()
        .filter(|entry| entry["code"] == "hardcode_missing_source")
        .map(|entry| (text(&entry["path"]).to_owned(), text(&entry["message"]).to_owned()))
        .collect();
    assert_eq!(kept, [("/sheet[Big]/cell[B1501]".to_owned(), "host".to_owned())]);

    // One unsourced input line is one finding: reported per cell, a four-period input row filled the answer and pushed the
    // model's own faults out of it.
    let row = sheet(
        "Plan",
        &[
            ("A1", json!({ "value": "항목" })),
            ("A2", json!({ "value": "출고 건수" })),
            ("B2", json!({ "value": 11800 })),
            ("C2", json!({ "value": 12100 })),
            ("D2", json!({ "value": 12400 })),
            ("A3", json!({ "value": "1인당" })),
            ("B3", json!({ "formula": "B2/40", "value": 295 })),
            ("C3", json!({ "formula": "C2/40", "value": 302 })),
            ("D3", json!({ "formula": "D2/40", "value": 310 })),
        ],
    );
    let grouped: Vec<_> = audit(&[row], "financial-model", &[], &[]).into_iter().filter(|issue| issue.code == "hardcode_missing_source").collect();
    assert_eq!(grouped.len(), 1, "{grouped:?}");
    assert_eq!(grouped[0].path, "/sheet[Plan]/cell[B2]");
    assert!(grouped[0].message.contains("3 hardcoded inputs (B2:D2)"), "{}", grouped[0].message);
}

/// The unmarked-inputs rule spares a plain dump and speaks to a designed model. It was gated on "the cell has a style object",
/// which every cell acquires once the workbook passes through a recalculation engine: the same file was silent before
/// recalculation and flagged after it.
#[test]
fn unmarked_inputs_are_judged_by_visible_formatting_not_by_a_style_record_recalculation_adds() {
    let cells: Vec<(&str, Value)> = vec![
        ("A1", json!({ "value": "항목" })),
        ("B1", json!({ "value": "단가" })),
        ("B2", json!({ "value": 3_200_000 })),
        ("C2", json!({ "value": 12 })),
        ("B3", json!({ "value": 6_000_000 })),
        ("C3", json!({ "value": 2 })),
        ("B4", json!({ "value": 4_500_000 })),
        ("C4", json!({ "value": 2 })),
        ("D2", json!({ "formula": "B2*C2", "value": 38_400_000 })),
        ("D3", json!({ "formula": "B3*C3", "value": 12_000_000 })),
        ("D4", json!({ "formula": "B4*C4", "value": 9_000_000 })),
    ];
    let unmarked = |entries: &[(&str, Value)]| -> Vec<String> {
        codes_at(&audit(&[sheet("Plan", entries)], "financial-model", &[], &[]), "input_cells_unmarked")
    };
    assert!(unmarked(&cells).is_empty(), "a plain sheet is left alone");
    // What a recalculation engine leaves behind: a style record on every cell, carrying nothing a reader can see.
    let recalculated: Vec<(&str, Value)> = cells
        .iter()
        .map(|(reference, cell)| (*reference, with(cell, json!({ "style": { "fontName": "Calibri", "fontSize": 11, "numberFormat": "General" } }))))
        .collect();
    assert!(unmarked(&recalculated).is_empty(), "the same sheet keeps its verdict after recalculation");
    // A designed sheet (a header the author styled) still hears about inputs that cannot be told apart from the formulas
    // beside them.
    let designed: Vec<(&str, Value)> = recalculated
        .iter()
        .map(|(reference, cell)| {
            if reference.ends_with('1') {
                (*reference, with(cell, json!({ "style": { "fontName": "Calibri", "fontSize": 11, "numberFormat": "General", "bold": true, "fillColor": "1F6F8B", "color": "FFFFFF" } })))
            } else {
                (*reference, cell.clone())
            }
        })
        .collect();
    assert_eq!(unmarked(&designed), ["/sheet[Plan]"]);
}

#[test]
fn workbook_conventions_summarize_faces_formats_by_column_and_input_markers() {
    use mixdog_ooxml::xlsx_conventions::summarize_xlsx_conventions;
    let document = json!({
        "sheets": [sheet("Inputs", &[
            ("A1", json!({ "value": "Growth", "style": { "fontName": "Arial", "fontSize": 11, "bold": true } })),
            ("B1", json!({ "value": 0.05, "style": { "fontName": "Arial", "fontSize": 11, "numberFormat": "0.0%", "color": "0000FF" } })),
            ("B2", json!({ "value": 1200, "style": { "fontName": "Arial", "fontSize": 11, "numberFormat": "#,##0", "color": "0000FF", "fillColor": "FFFF00" } })),
            ("C2", json!({ "formula": "B2*(1+B1)", "value": 1260, "style": { "fontName": "Arial", "fontSize": 11, "numberFormat": "#,##0" } })),
            ("D2", json!({ "value": 7 })),
        ])],
        "defaultStyle": { "fontName": "Calibri", "fontSize": 11 },
    });
    let conventions = summarize_xlsx_conventions(&document).expect("a styled workbook");
    assert_eq!(conventions["defaultFont"], "Calibri");
    assert_eq!(conventions["fonts"], json!([{ "name": "Arial", "cells": 4 }]));
    assert_eq!(
        conventions["numberFormats"],
        json!([{ "format": "#,##0", "cells": 2, "columns": ["B", "C"] }, { "format": "0.0%", "cells": 1, "columns": ["B"] }])
    );
    assert_eq!(conventions["inputMarkers"]["fontColors"], json!([{ "color": "0000FF", "cells": 2 }]));
    assert_eq!(conventions["inputMarkers"]["fills"], json!([{ "color": "FFFF00", "cells": 1 }]));
    assert_eq!(conventions["cells"], json!({ "styled": 4, "formulas": 1, "hardcodes": 3, "markedInputs": 2 }));
    assert_eq!(conventions["sampleInputs"], json!(["Inputs!B1", "Inputs!B2"]));
    assert_eq!(summarize_xlsx_conventions(&json!({ "sheets": [sheet("Raw", &[("A1", json!({ "value": 1 }))])] })), None);
}

#[test]
fn portable_formulas_quote_multi_word_sheet_names_and_prefix_post_2007_functions() {
    use mixdog_ooxml::xlsx_contract::{normalize_xlsx_formula, quote_unquoted_sheet_references};
    let names: Vec<String> = ["Summary", "Input Sheet", "O'Brien"].iter().map(|name| (*name).to_owned()).collect();
    let normalize = |formula: &str| normalize_xlsx_formula(&json!(formula), "", Some(names.as_slice())).expect("a formula");
    assert_eq!(normalize("=Input Sheet!B2+'Input Sheet'!B3&\"Input Sheet!\""), "'Input Sheet'!B2+'Input Sheet'!B3&\"Input Sheet!\"");
    assert_eq!(normalize("=O'Brien!A1"), "'O''Brien'!A1");
    assert_eq!(normalize("=Summary!A1+IFS(A1>0,1,TRUE,0)"), "Summary!A1+_xlfn.IFS(A1>0,1,TRUE,0)");
    // Without a sheet list (an Excel session) a multi-word token before `!` and a reference is still a sheet name.
    assert_eq!(quote_unquoted_sheet_references("=SUM(Data 2024!A1:A5)+My Sheet!$B$2+Plan!C1"), "=SUM('Data 2024'!A1:A5)+'My Sheet'!$B$2+Plan!C1");
    assert_eq!(quote_unquoted_sheet_references("=SUM(A1:C3 Sheet2!B2:D4)&\"My Sheet!A1\""), "=SUM(A1:C3 Sheet2!B2:D4)&\"My Sheet!A1\"");
    assert_eq!(quote_unquoted_sheet_references("=IF(A1=\"x\", Sheet2!B1, 'Input Sheet'!B1)"), "=IF(A1=\"x\", Sheet2!B1, 'Input Sheet'!B1)");
}
