//! Twin test `chart_sheets`: the recording of `portable-chart.mjs`, `portable-sheet-page.mjs` and
//! `portable-shared-formulas.mjs` (`native/core/fixtures/office-chart-sheets/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-chart-sheets.mjs`) against this crate. `charts` replays every chart
//! specification (the chart part's text and the errors), `workbookRows` the rows a chart's workbook carries, `digitWidths`,
//! `characters`, `widths`, `geometries` and `fits` the column and row geometry and the fit-to-page rewrite, `scenarios`
//! the `set_page_setup` sequences over a package (the report of each step, then the worksheet and workbook text) and the
//! drawings they read, and `sharedFormulas` the formulas the cells of a shared or array formula take. Text widths are
//! measured in the fixture faces of `office-measure` registered on both sides and must agree within 1e-3. Re-recording is
//! `twin_live_chart_sheets` (ignored: it runs Node).

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::{json_number, to_number};
use mixdog_office_base::twin;
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_ooxml::cells::{Sheet, cell_records, workbook_sheets};
use mixdog_ooxml::chart::{CategoryDates, ChartReferences, ChartSpec, SLIDE_CHART_TEXT, chart_workbook_rows, chart_xml};
use mixdog_ooxml::opc::part_relationship_path;
use mixdog_ooxml::package::{CreateOptions, create_portable_ooxml_document, load_package};
use mixdog_ooxml::shared_formulas::expand_shared_formulas;
use mixdog_ooxml::sheet_page::{
    WorksheetDrawing, apply_worksheet_page_setup, column_file_width, column_pixels, fit_drawing_sheet_one_page_wide, maximum_digit_width,
    text_characters, worksheet_drawings, worksheet_geometry,
};
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

const TOLERANCE: f64 = 1e-3;

fn golden() -> Value {
    twin::load_golden("office-chart-sheets")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[][..], Vec::as_slice)
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn attempt(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    }
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

fn strings(value: &Value) -> Vec<String> {
    list(value).iter().map(|item| text(item).to_owned()).collect()
}

fn chart_case(case: &Value) {
    let name = text(&case["name"]);
    let spec = &case["spec"];
    let names = strings(&spec["references"]["names"]);
    let values = strings(&spec["references"]["values"]);
    let references = spec.get("references").map(|found| ChartReferences {
        sheet: text(&found["sheet"]),
        category: text(&found["category"]),
        names: &names,
        values: &values,
    });
    let dates = spec.get("categoryDates").map(|found| CategoryDates { values: list(&found["values"]), format: text(&found["format"]) });
    let chart = ChartSpec {
        chart_type: text(&spec["chartType"]),
        title: text(&spec["title"]),
        categories: list(&spec["categories"]),
        series: list(&spec["series"]),
        references,
        show_values: truthy(&spec["showValues"]),
        data_label_position: text(&spec["dataLabelPosition"]),
        data_label_color: text(&spec["dataLabelColor"]),
        value_number_format: text(&spec["valueNumberFormat"]),
        show_legend: spec["showLegend"].as_bool(),
        zero_baseline: spec["zeroBaseline"].as_bool(),
        axis: spec.get("axis"),
        external_data_id: text(&spec["externalDataId"]),
        font: text(&spec["font"]),
        text: if text(&spec["textKind"]) == "slide" { SLIDE_CHART_TEXT } else { ChartSpec::default().text },
        category_dates: dates,
    };
    let produced = attempt(chart_xml(&chart).map(Value::from));
    twin::assert_matches(&format!("chart {name}"), &case["output"], &produced);
}

fn workbook_rows_case(case: &Value) {
    let rows = chart_workbook_rows(list(&case["categories"]), list(&case["series"]));
    let produced = json!({ "result": rows });
    twin::assert_matches("chartWorkbookRows", &case["output"], &produced);
}

fn near(what: &str, expected: &Value, produced: &Value) {
    match (expected.get("result").and_then(Value::as_f64), produced.get("result").and_then(Value::as_f64)) {
        (Some(want), Some(got)) => assert!((want - got).abs() <= TOLERANCE, "{what}: recorded {want}, produced {got}"),
        _ => twin::assert_matches(what, expected, produced),
    }
}

fn geometry_case(case: &Value) {
    let xml = text(&case["xml"]);
    let digit = to_number(&case["digit"]);
    let geometry = worksheet_geometry(xml, digit);
    let columns: Vec<Value> = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 100.0].iter().map(|index| json_number(geometry.column_points(*index))).collect();
    let rows: Vec<Value> = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 1000.0].iter().map(|index| json_number(geometry.row_points(*index))).collect();
    twin::assert_matches(&format!("column points of {xml} at {digit}"), &case["columnPoints"], &Value::Array(columns));
    twin::assert_matches(&format!("row points of {xml} at {digit}"), &case["rowPoints"], &Value::Array(rows));
    for entry in list(&case["at"]) {
        let points = to_number(&entry["points"]);
        let trailing = entry["trailing"].as_bool() == Some(true);
        let label = format!("{xml} at {digit}, {points} points, trailing {trailing}");
        twin::assert_matches(&format!("column of {label}"), &entry["column"], &attempt(geometry.column_at(points, trailing).map(json_number)));
        twin::assert_matches(&format!("row of {label}"), &entry["row"], &attempt(geometry.row_at(points, trailing).map(json_number)));
    }
}

fn drawing_json(drawing: &WorksheetDrawing) -> Value {
    let mut out = Map::new();
    out.insert("part".to_owned(), json!(drawing.part));
    out.insert("kind".to_owned(), json!(drawing.kind));
    out.insert("body".to_owned(), json!(drawing.body));
    for (key, value) in [
        ("startColumn", drawing.start_column),
        ("startRow", drawing.start_row),
        ("endColumn", drawing.end_column),
        ("endRow", drawing.end_row),
        ("cornerColumn", drawing.corner_column),
        ("cornerRow", drawing.corner_row),
    ] {
        out.insert(key.to_owned(), json_number(value));
    }
    if let Some(frame) = drawing.frame {
        for (key, value) in [("left", frame.left), ("top", frame.top), ("width", frame.width), ("height", frame.height)] {
            out.insert(key.to_owned(), json_number(value));
        }
    }
    Value::Object(out)
}

fn scenario_package(work: &std::path::Path, scenario: &Value, ordinal: usize) -> (Package, Sheet, Vec<Sheet>) {
    let path = work.join(format!("scenario-{ordinal}.xlsx"));
    let options = CreateOptions { file_kind: "xlsx", title: "t", sheet_name: "Data" };
    create_portable_ooxml_document(&Unlaned, &NoWriteNote, &path, &options).expect("a blank workbook");
    let mut zip = load_package(&Unlaned, &path).expect("the workbook loads");
    zip.set("xl/styles.xml", text(&scenario["styles"]));
    let sheets = workbook_sheets(&zip);
    let sheet = sheets[0].clone();
    zip.set(&sheet.path, text(&scenario["sheet"]));
    if let Some(names) = scenario.get("definedNames").and_then(Value::as_str) {
        let workbook = zip.text("xl/workbook.xml").replace("</sheets>", &format!("</sheets>{names}"));
        zip.set("xl/workbook.xml", workbook);
    }
    if let Some(rels) = scenario.get("rels").and_then(Value::as_str) {
        zip.set(&part_relationship_path(&sheet.path), rels);
    }
    if let Some(drawing) = scenario.get("drawing").and_then(Value::as_str) {
        zip.set("xl/drawings/drawing1.xml", drawing);
    }
    (zip, sheet, sheets)
}

fn scenario_case(measurer: &TextMeasurer<'_, Unlaned>, work: &std::path::Path, ordinal: usize, scenario: &Value) {
    let name = text(&scenario["name"]);
    let (mut zip, sheet, sheets) = scenario_package(work, scenario, ordinal);
    let steps = list(&scenario["steps"]);
    let recorded = list(&scenario["outputs"]);
    assert_eq!(steps.len(), recorded.len(), "{name}");
    for (index, (step, expected)) in steps.iter().zip(recorded).enumerate() {
        let xml = zip.text(&sheet.path);
        let op = step.as_object().cloned().unwrap_or_default();
        let result = attempt(apply_worksheet_page_setup(measurer, &mut zip, &sheets, &sheet, &xml, &op));
        twin::assert_matches(&format!("{name}, step {index}: the report"), &expected["result"], &result);
        assert_eq!(text(&expected["worksheet"]), zip.text(&sheet.path), "{name}, step {index}: the worksheet");
        assert_eq!(text(&expected["workbook"]), zip.text("xl/workbook.xml"), "{name}, step {index}: the workbook");
    }
    if let Some(expected) = scenario.get("drawingsOutput") {
        let xml = zip.text(&sheet.path);
        let found = worksheet_drawings(measurer, &zip, &sheet, &xml).map(|drawings| Value::Array(drawings.iter().map(drawing_json).collect()));
        twin::assert_matches(&format!("{name}: the drawings"), expected, &attempt(found));
    }
}

fn shared_case(case: &Value) {
    let xml = text(&case["xml"]);
    let mut records = cell_records(xml, &[], None);
    let outcome = expand_shared_formulas(xml, &mut records).map(|failures| {
        let formulas: Vec<Value> = records
            .iter()
            .filter_map(|record| record.formula.as_ref().map(|info| json!([record.reference, info.formula])))
            .collect();
        let failures: Vec<Value> = failures.iter().map(|failure| json!({ "ref": failure.reference, "reason": failure.reason })).collect();
        json!({ "failures": failures, "formulas": formulas })
    });
    twin::assert_matches(&format!("shared formulas of {xml}"), &case["output"], &attempt(outcome));
}

fn every_output_equals_the_recording() {
    let golden = golden();
    for case in list(&golden["charts"]) {
        chart_case(case);
    }
    for case in list(&golden["workbookRows"]) {
        workbook_rows_case(case);
    }
    let registry = registry(&golden);
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    for case in list(&golden["digitWidths"]) {
        let produced = attempt(maximum_digit_width(&measurer, text(&case["styles"])).map(json_number));
        twin::assert_matches(&format!("digit width of {}", text(&case["styles"])), &case["output"], &produced);
    }
    for case in list(&golden["characters"]) {
        let produced = attempt(text_characters(&measurer, &case["text"], Some(&case["style"]), to_number(&case["digit"])).map(json_number));
        near(&format!("characters of {}", case["text"]), &case["output"], &produced);
    }
    for case in list(&golden["widths"]) {
        let (count, digit) = (to_number(&case["characters"]), to_number(&case["digit"]));
        let file = column_file_width(count, digit);
        assert_eq!(to_number(&case["file"]), file, "file width of {count} at {digit}");
        assert_eq!(to_number(&case["pixels"]), column_pixels(file, digit), "pixels of {count} at {digit}");
        assert_eq!(to_number(&case["raw"]), column_pixels(count, digit), "raw pixels of {count} at {digit}");
    }
    for case in list(&golden["geometries"]) {
        geometry_case(case);
    }
    for case in list(&golden["fits"]) {
        let fitted = fit_drawing_sheet_one_page_wide(text(&case["xml"]));
        twin::assert_matches(&format!("fit of {}", text(&case["xml"])), &case["output"], &attempt(Ok(json!({ "xml": fitted.xml, "applied": fitted.applied }))));
    }
    let work = tempfile::tempdir().expect("work directory");
    for (ordinal, scenario) in list(&golden["scenarios"]).iter().enumerate() {
        scenario_case(&measurer, work.path(), ordinal, scenario);
    }
    for case in list(&golden["sharedFormulas"]) {
        shared_case(case);
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_chart_sheets -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_chart_sheets() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-chart-sheets.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
