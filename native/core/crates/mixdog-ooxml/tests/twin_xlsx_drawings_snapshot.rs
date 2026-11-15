//! Twin test `xlsx_drawings_snapshot`: the recording of Node's workbook read model, sheet audits and drawing operations
//! (`native/core/fixtures/office-xlsx-drawings-snapshot/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-xlsx-drawings-snapshot.mjs`) against this crate. `snapshots` reads each
//! recorded workbook at each recorded page request and compares the JSON text with the one `snapshotXlsx` produced, key order
//! included; `audits` the four issue lists of each workbook; `drawings` replays the add / move / resize / delete of pictures and
//! chart frames step by step (the answer, then the worksheet, the drawing, its relationships and the content types as text);
//! `pure` the anchor helpers. Text widths are measured in the fixture faces of `office-measure` registered on both sides.
//! The tests ported from `src/runtime/office/xlsx-portable-snapshot.test.mjs` that read a part of the workbook without the office
//! tool around it follow the replay. Re-recording is `twin_live_xlsx_drawings_snapshot` (ignored: it runs Node).

use std::collections::BTreeMap;

use base64::Engine;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_js::{json_number, to_number_of};
use mixdog_office_base::twin;
use mixdog_ooxml::cells::{Sheet, cell_records, sheet_formula_totals, workbook_sheets};
use mixdog_ooxml::sheet_audits::{cell_ink_issues, column_fit_issues, formula_consistency_issues, protected_input_issues};
use mixdog_ooxml::sheet_page::{column_file_width, column_pixels, worksheet_drawings};
use mixdog_ooxml::snapshot_shared::chart_part_snapshot;
use mixdog_ooxml::snapshot_xlsx::{FULL_READ_CELL_LIMIT, snapshot_xlsx, worksheet_validations};
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::xlsx_drawings::{FramePlacement, add_worksheet_image, count_drawing_anchors, delete_worksheet_drawing, frame_anchor_xml, set_worksheet_drawing};
use mixdog_ooxml::zipio::Package;
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-xlsx-drawings-snapshot")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[][..], Vec::as_slice)
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

fn package_of(golden: &Value, workbook: &str) -> Package {
    let mut package = Package::new();
    for (name, content) in golden["workbooks"][workbook].as_object().unwrap_or_else(|| panic!("workbook {workbook}")) {
        package.set(name, text(content));
    }
    package
}

/// The first place two texts differ, with what lies around it.
fn first_difference(expected: &str, produced: &str) -> String {
    let at = expected.chars().zip(produced.chars()).position(|(a, b)| a != b).unwrap_or_else(|| expected.chars().count().min(produced.chars().count()));
    let around = |text: &str| text.chars().skip(at.saturating_sub(80)).take(180).collect::<String>();
    format!("at character {at} ({} recorded, {} produced):\n recorded: {}\n produced: {}", expected.chars().count(), produced.chars().count(), around(expected), around(produced))
}

/// What Node's `text()` of the recorder keeps of a call: `{ result: <JSON text> }` or `{ error }` with the work directory named
/// `$DIR` and the separators forward slashes.
fn recorded_text(outcome: Result<Value, String>, work: &str) -> Value {
    match outcome {
        Ok(value) => json!({ "result": serde_json::to_string(&value).expect("the answer as JSON") }),
        Err(error) => {
            let named = if work.is_empty() { error } else { error.replace(work, "$DIR") };
            json!({ "error": named.replace('\\', "/") })
        }
    }
}

fn assert_text(what: &str, expected: &Value, produced: &Value) {
    if let Some(error) = expected.get("error") {
        assert_eq!(Some(error), produced.get("error"), "{what}: the error");
        return;
    }
    let (want, got) = (text(&expected["result"]), text(&produced["result"]));
    assert!(produced.get("error").is_none(), "{what} failed: {}", produced["error"]);
    assert!(want == got, "{what} differs from the recording {}", first_difference(want, got));
}

fn snapshots(golden: &Value, measurer: &TextMeasurer<'_, Unlaned>) {
    let cases = list(&golden["snapshots"]);
    assert!(cases.len() >= 53, "the recording lost snapshots: {}", cases.len());
    for case in cases {
        let package = package_of(golden, text(&case["workbook"]));
        let what = format!("snapshot of \"{}\" at {}", text(&case["workbook"]), case["options"]);
        assert_text(&what, &case["output"], &recorded_text(snapshot_xlsx(measurer, &package, &case["options"]), ""));
    }
}

fn audits(golden: &Value, measurer: &TextMeasurer<'_, Unlaned>) {
    let cases = list(&golden["audits"]);
    assert!(cases.len() >= 8, "the recording lost audits: {}", cases.len());
    for case in cases {
        let name = text(&case["workbook"]);
        let package = package_of(golden, name);
        let sheets: Vec<Sheet> = workbook_sheets(&package);
        let issues = |outcome: Result<Vec<Value>, String>| recorded_text(outcome.map(Value::Array), "");
        assert_text(&format!("{name}: protected inputs"), &case["protectedInputIssues"], &issues(protected_input_issues(&package, &sheets)));
        assert_text(&format!("{name}: column fit"), &case["columnFitIssues"], &issues(column_fit_issues(measurer, &package, &sheets)));
        assert_text(&format!("{name}: formula consistency"), &case["formulaConsistencyIssues"], &issues(Ok(formula_consistency_issues(&package, &sheets))));
        assert_text(&format!("{name}: cell ink"), &case["cellInkIssues"], &issues(cell_ink_issues(&package, &sheets)));
    }
}

fn names_of(package: &Package) -> Vec<String> {
    let mut names: Vec<String> = package.names().into_iter().filter(|name| !name.ends_with('/')).collect();
    names.sort();
    names
}

fn drawings(golden: &Value, measurer: &TextMeasurer<'_, Unlaned>) {
    let scenarios = list(&golden["drawings"]);
    assert!(scenarios.len() >= 3, "the recording lost scenarios: {}", scenarios.len());
    let dir = tempfile::tempdir().expect("work directory");
    let work = dir.path().to_str().expect("a UTF-8 work directory").to_owned();
    for (file, data) in scenarios[0]["images"].as_object().expect("images") {
        std::fs::write(dir.path().join(file), base64::engine::general_purpose::STANDARD.decode(text(data)).expect("image bytes")).expect("an image");
    }
    for scenario in scenarios {
        let name = text(&scenario["name"]);
        let mut package = package_of(golden, text(&scenario["workbook"]));
        let sheet = workbook_sheets(&package).into_iter().find(|sheet| sheet.name == text(&scenario["sheet"])).expect("the sheet");
        for (index, step) in list(&scenario["steps"]).iter().enumerate() {
            let what = format!("{name}, step {index} ({})", step["op"]);
            let mut op = step["op"].clone();
            if let Some(path) = op.get("path").and_then(Value::as_str) {
                op["path"] = Value::from(path.replace("$DIR", &work));
            }
            let xml = package.text(&sheet.path);
            let outcome = match text(&step["kind"]) {
                "set" => set_worksheet_drawing(measurer, &mut package, &sheet, &xml, &op),
                "add" => add_worksheet_image(&Unlaned, &mut package, &sheet, &xml, &op),
                "delete" => delete_worksheet_drawing(&mut package, &sheet, &op),
                other => panic!("the recording has a step this test does not replay: {other}"),
            };
            assert_text(&format!("{what}: the answer"), &step["output"], &recorded_text(outcome, &work));
            let recorded_names: Vec<String> = list(&step["names"]).iter().map(|name| text(name).to_owned()).collect();
            assert_eq!(recorded_names, names_of(&package), "{what}: the parts");
            for (key, part) in [("worksheet", sheet.path.as_str()), ("drawing", "xl/drawings/drawing1.xml"), ("drawingRels", "xl/drawings/_rels/drawing1.xml.rels"), ("types", "[Content_Types].xml")] {
                let (want, got) = (text(&step[key]), package.text(part));
                assert!(want == got, "{what}: {key} differs from the recording {}", first_difference(want, &got));
            }
            let sheet_xml = package.text(&sheet.path);
            let placed = match worksheet_drawings(measurer, &package, &sheet, &sheet_xml) {
                Ok(found) => serde_json::to_string(
                    &found
                        .iter()
                        .map(|entry| {
                            json!({
                                "kind": entry.kind,
                                "startColumn": json_number(entry.start_column),
                                "startRow": json_number(entry.start_row),
                                "endColumn": json_number(entry.end_column),
                                "endRow": json_number(entry.end_row),
                            })
                        })
                        .collect::<Vec<_>>(),
                )
                .expect("the placements as JSON"),
                Err(error) => error,
            };
            assert_eq!(text(&step["placed"]), placed, "{what}: where the drawings sit");
        }
    }
}

fn pure(golden: &Value) {
    let cases = list(&golden["pure"]);
    assert!(cases.len() >= 20, "the recording lost cases: {}", cases.len());
    for case in cases {
        let name = text(&case["fn"]);
        let args = list(&case["args"]);
        let what = format!("{name}({})", Value::Array(args.to_vec()));
        let produced = match name {
            "frameAnchorXml" => {
                let placement = &args[0];
                let frame = FramePlacement {
                    cell: placement.get("cell"),
                    left: placement.get("left"),
                    top: placement.get("top"),
                    width: to_number_of(placement.get("width")),
                    height: to_number_of(placement.get("height")),
                };
                recorded_text(frame_anchor_xml(&frame, text(&args[1])).map(Value::from), "")
            }
            "countDrawingAnchors" => recorded_text(Ok(Value::from(count_drawing_anchors(text(&args[0])))), ""),
            "worksheetValidations" => recorded_text(Ok(Value::Array(worksheet_validations(text(&args[0]), text(&args[1])))), ""),
            "FULL_READ_CELL_LIMIT" => recorded_text(Ok(json_number(FULL_READ_CELL_LIMIT)), ""),
            other => panic!("the recording has a function this test does not replay: {other}"),
        };
        assert_text(&what, &case["output"], &produced);
    }
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let registry = registry(&golden);
    let measurer = TextMeasurer::new(&Unlaned, &registry);
    snapshots(&golden, &measurer);
    audits(&golden, &measurer);
    drawings(&golden, &measurer);
    pure(&golden);
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_xlsx_drawings_snapshot -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_xlsx_drawings_snapshot() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-xlsx-drawings-snapshot.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}

// ---- the tests of `xlsx-portable-snapshot.test.mjs` that read a part of the workbook on its own ------------------------

/// A series named in text reports no name formula, not its category range.
#[test]
fn a_series_named_in_text_reports_no_name_formula_not_its_category_range() {
    let chart = chart_part_snapshot(
        "<c:chartSpace><c:chart><c:plotArea><c:barChart><c:ser><c:idx val=\"0\"/><c:tx><c:v>Value</c:v></c:tx>\
         <c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f></c:strRef></c:cat>\
         <c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:ptCount val=\"2\"/></c:numCache></c:numRef></c:val>\
         </c:ser><c:ser><c:idx val=\"1\"/><c:tx><c:strRef><c:f>Sheet1!$C$1</c:f><c:strCache><c:pt idx=\"0\"><c:v>Target</c:v></c:pt></c:strCache></c:strRef></c:tx>\
         <c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$C$2:$C$3</c:f></c:numRef></c:val>\
         </c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>",
    );
    let rows: Vec<Value> = list(&chart["series"]).iter().map(|series| json!([series["name"], series["formula"], series["categoryFormula"], series["valueFormula"]])).collect();
    assert_eq!(
        rows,
        vec![json!(["Value", "", "Sheet1!$A$2:$A$3", "Sheet1!$B$2:$B$3"]), json!(["Target", "Sheet1!$C$1", "Sheet1!$A$2:$A$3", "Sheet1!$C$2:$C$3"])]
    );
}

/// An empty-string formula result counts as a cached value.
#[test]
fn an_empty_string_formula_result_counts_as_a_cached_value() {
    let xml = "<sheetData><row r=\"7\">\
        <c r=\"E7\" t=\"n\"><f>IF(C7=0,0,D7/C7)</f><v>0</v></c>\
        <c r=\"F7\" t=\"str\"><f>IF(C7=0,\"\",IF(E7&gt;=200,\"정상\",\"보강\"))</f><v></v></c>\
        <c r=\"G7\"><f>E7*2</f></c>\
        </row></sheetData>";
    let states: Vec<(String, Value, Value)> = cell_records(xml, &[], None)
        .iter()
        .map(|cell| {
            let info = cell.formula.as_ref().expect("a formula");
            (cell.reference.clone(), json!(info.cache_state), info.cached_value.as_ref().map_or(Value::Null, |value| value.to_json()))
        })
        .collect();
    assert_eq!(
        states,
        vec![
            ("E7".to_owned(), json!("present"), json!(0)),
            ("F7".to_owned(), json!("present"), json!("")),
            ("G7".to_owned(), json!("missing"), Value::Null),
        ]
    );
    // Microsoft Excel writes the same empty result as a self-closing <v/>, and the sheet totals read it the same way.
    let excel = "<sheetData><row r=\"6\"><c r=\"D6\" t=\"str\"><f>IF(C6=\"\",\"\",C6*0.1)</f><v/></c><c r=\"E6\"><f>D6*2</f></c></row></sheetData>";
    let cache: BTreeMap<String, &str> = cell_records(excel, &[], None).iter().map(|cell| (cell.reference.clone(), cell.formula.as_ref().expect("a formula").cache_state)).collect();
    assert_eq!(cache, BTreeMap::from([("D6".to_owned(), "present"), ("E6".to_owned(), "missing")]));
    assert_eq!(sheet_formula_totals(excel), (2, 1));
}

/// A column width is stored as Excel stores it: the characters asked for and its padding, in the default digit.
#[test]
fn a_column_width_is_stored_as_excel_stores_it() {
    // The values Excel itself wrote for ColumnWidth 9 and 5.2 in 맑은 고딕 11 (a column snaps to whole pixels).
    assert_eq!(column_file_width(9.0, 8.0), 9.625);
    assert_eq!(column_file_width(5.2, 8.0), 5.875);
    assert_eq!(column_file_width(9.0, 7.0), 9.710_937_5);
    assert_eq!(column_pixels(9.625, 8.0), 77.0);
    assert_eq!(column_pixels(9.710_937_5, 7.0), 68.0);
}
