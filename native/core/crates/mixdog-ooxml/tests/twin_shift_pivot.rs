//! Twin test `shift_pivot`: the recording of Node's portable reference-shift and pivot modules
//! (`native/core/fixtures/office-shift-pivot/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-shift-pivot.mjs`) against this crate. `cases` replays each workbook with
//! its steps (rows and columns inserted and deleted, sheets renamed, deleted and copied, pivot tables written): what each
//! step answered, the names of the package afterwards and the text of every part that changed (every other part must be as
//! it was). `pure` replays the sorted formulas, the inherited rows and the pivot field summaries on their recorded
//! arguments. Re-recording is `twin_live_shift_pivot` (ignored: it runs Node).

use std::collections::HashMap;

use mixdog_js::json_number;
use mixdog_office_base::twin;
use mixdog_ooxml::cells::{Sheet, workbook_sheets};
use mixdog_ooxml::pivot::{PivotField, PivotLayout, PivotRequest, summarize_pivot_fields, write_pivot_table};
use mixdog_ooxml::xlsx_reference_shift::{
    ShiftRequest, copied_sheet_xml, copy_sheet_parts, drop_calculation_chain, inherited_rows, rename_sheet_references,
    shift_worksheet_cells, sorted_formula,
};
use mixdog_ooxml::zipio::Package;
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-shift-pivot")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string")
}

fn parts_of(value: &Value) -> Vec<(String, String)> {
    value
        .as_array()
        .expect("a list of parts")
        .iter()
        .map(|pair| (text(&pair[0]).to_owned(), text(&pair[1]).to_owned()))
        .collect()
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

fn pivot_field_json(field: &PivotField) -> Value {
    if field.numeric {
        json!({ "name": field.name, "numeric": true, "min": json_number(field.min), "max": json_number(field.max), "integer": field.integer, "items": [] })
    } else if field.numeric_items {
        json!({
            "name": field.name, "numeric": false, "numericItems": true,
            "min": json_number(field.min), "max": json_number(field.max), "integer": field.integer, "items": field.items,
        })
    } else {
        json!({ "name": field.name, "numeric": false, "items": field.items })
    }
}

fn headers_of(value: &Value) -> Vec<String> {
    value.as_array().expect("headers").iter().map(|header| text(header).to_owned()).collect()
}

fn records_of(value: &Value) -> Vec<Vec<Value>> {
    value.as_array().expect("records").iter().map(|record| record.as_array().expect("a record").clone()).collect()
}

fn indexes_of(value: &Value) -> Vec<usize> {
    value.as_array().expect("indexes").iter().map(|index| index.as_u64().expect("an index") as usize).collect()
}

fn run_step(zip: &mut Package, step: &Value) -> Result<Value, String> {
    let sheets = workbook_sheets(zip);
    let named = |name: &str| -> Sheet { sheets.iter().find(|sheet| sheet.name == name).expect("a sheet of the workbook").clone() };
    match text(&step["kind"]) {
        "shift" => {
            let sheet = named(text(&step["sheet"]));
            let xml = zip.text(&sheet.path);
            let request = ShiftRequest {
                rows: step["rows"].as_bool().expect("rows"),
                from: step["from"].as_i64().expect("from"),
                amount: step["amount"].as_i64().expect("amount"),
                insert: step["insert"].as_bool().expect("insert"),
                op: text(&step["op"]),
            };
            shift_worksheet_cells(zip, &sheets, &sheet, &xml, request).map(|count| json!(count))
        }
        "rename" => {
            let sheet = named(text(&step["sheet"]));
            rename_sheet_references(zip, &sheets, &sheet, step["to"].as_str(), text(&step["op"])).map(|count| json!(count))
        }
        "copy" => {
            let source = named(text(&step["sheet"]));
            let copy = Sheet { name: text(&step["name"]).to_owned(), path: text(&step["path"]).to_owned(), rid: String::new(), visibility: "visible" };
            let xml = copied_sheet_xml(&zip.text(&source.path), &source.name, &copy.name)?;
            zip.set(&copy.path, xml.into_bytes());
            copy_sheet_parts(zip, &sheets, &source, &copy)?;
            Ok(Value::Null)
        }
        "dropchain" => {
            drop_calculation_chain(zip);
            Ok(Value::Null)
        }
        "replace" => {
            let part = text(&step["part"]);
            let replaced = zip.text(part).replacen(text(&step["find"]), text(&step["with"]), 1);
            zip.set(part, replaced.into_bytes());
            Ok(Value::Null)
        }
        "pivot" => {
            let headers = headers_of(&step["headers"]);
            let records = records_of(&step["records"]);
            let fields = summarize_pivot_fields(&headers, &records, &indexes_of(&step["axes"]));
            let value_fields = indexes_of(&step["valueFields"]);
            let layout = PivotLayout {
                fields: &fields,
                row_field: step["rowField"].as_i64().expect("rowField"),
                column_field: step["columnField"].as_i64().expect("columnField"),
                value_fields: &value_fields,
            };
            let request = PivotRequest {
                layout,
                records: &records,
                source_sheet: text(&step["sourceSheet"]),
                source_ref: text(&step["sourceRef"]),
                destination_sheet_path: text(&step["destinationSheetPath"]),
                destination: text(&step["destination"]),
                name: text(&step["name"]),
            };
            let written = write_pivot_table(zip, &request)?;
            Ok(json!({
                "fields": fields.iter().map(pivot_field_json).collect::<Vec<_>>(),
                "written": {
                    "definitionPart": written.definition_part, "recordsPart": written.records_part, "tablePart": written.table_part,
                    "cacheId": written.cache_id, "rows": written.rows, "columns": written.columns,
                },
            }))
        }
        other => panic!("the recording has a step this test does not replay: {other}"),
    }
}

fn replay_case(case: &Value, workbooks: &Value) {
    let name = text(&case["name"]);
    let before = parts_of(&workbooks[text(&case["workbook"])]);
    let mut zip = package(&before);
    let steps = case["steps"].as_array().expect("steps");
    let outputs = case["outputs"].as_array().expect("outputs");
    for (index, (step, recorded)) in steps.iter().zip(outputs).enumerate() {
        let produced = match run_step(&mut zip, step) {
            Ok(value) => json!({ "result": value }),
            Err(error) => json!({ "error": error }),
        };
        match (recorded.get("error"), produced.get("error")) {
            (Some(want), Some(got)) => assert_eq!(want, got, "{name}: step {index}: the refusal"),
            _ => twin::assert_matches(&format!("{name}: step {index}"), recorded, &produced),
        }
    }
    let recorded_names: Vec<String> = case["names"].as_array().expect("names").iter().map(|entry| text(entry).to_owned()).collect();
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

fn replay_pure(case: &Value) {
    let args = case["args"].as_array().expect("arguments");
    let produced = match text(&case["fn"]) {
        "sortedFormula" => match sorted_formula(text(&args[0]), args[1].as_i64().expect("a delta")) {
            Ok(formula) => json!({ "result": formula }),
            Err(error) => json!({ "error": error.reason }),
        },
        "inheritedRows" => match inherited_rows(text(&args[0]), args[1].as_i64().expect("from"), args[2].as_i64().expect("amount")) {
            Ok(xml) => json!({ "result": xml }),
            Err(error) => json!({ "error": error }),
        },
        "summarizePivotFields" => {
            let fields = summarize_pivot_fields(&headers_of(&args[0]), &records_of(&args[1]), &indexes_of(&args[2]));
            json!({ "result": fields.iter().map(pivot_field_json).collect::<Vec<_>>() })
        }
        other => panic!("the recording has a helper this test does not replay: {other}"),
    };
    let expected = match case.get("error") {
        Some(error) => json!({ "error": error }),
        None => json!({ "result": case["result"] }),
    };
    let shown: String = Value::Array(args.clone()).to_string().chars().take(160).collect();
    twin::assert_matches(&format!("{}({shown})", text(&case["fn"])), &expected, &produced);
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() >= 60, "the recording lost cases: {}", cases.len());
    for case in cases {
        replay_case(case, &golden["workbooks"]);
    }
    let pure = golden["pure"].as_array().expect("pure helpers");
    assert!(pure.len() >= 30, "the recording lost helper cases: {}", pure.len());
    for case in pure {
        replay_pure(case);
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_shift_pivot -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_shift_pivot() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-shift-pivot.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
