//! Twin test `sheet_xml`: the recording of Node's portable worksheet modules (`native/core/fixtures/office-sheet-xml/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-sheet-xml.mjs`) against this crate. `pure` replays the helpers of
//! portable-sheet-styles, portable-sheet-xml, portable-xlsx-cell-values and portable-sheet-parts on their recorded
//! arguments; `sequences` replays the cell/style write sequences (the style index each step returns and the styles.xml text
//! it leaves), the drawing and note steps over a package (what each step answered, then every part's text) and the cell
//! labels of a sheet with dates. Re-recording is `twin_live_sheet_xml` (ignored: it runs Node).

use mixdog_fsio::Unlaned;
use mixdog_js::{json_number, to_number, value_to_string};
use mixdog_office_base::twin;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_ooxml::cells::{CellValue, workbook_sheets};
use mixdog_ooxml::package::{CreateOptions, create_portable_ooxml_document, load_package};
use mixdog_ooxml::sheet_parts::{NoteRequest, ensure_worksheet_drawing, excel_password_hash, write_worksheet_note};
use mixdog_ooxml::sheet_styles::{
    apply_cell_style, is_general_number_format, normalize_color_value, normalize_excel_cell_style, number_format_id,
    resolve_cell_styles, style_has_number_format,
};
use mixdog_ooxml::sheet_xml::{
    Area, absolute_range, append_differential_format, append_worksheet_section, area_reference, cell_width_scale,
    compose_sheet_view, conditional_scale_rule, display_width, formatted_number_width, freeze_pane_xml, hidden_sheet_areas,
    merged_cell_anchor, merged_ranges, parse_area_range, quote_sheet_name, safe_workbook_table_name, sheet_qualified_areas,
    sheet_view_parts, shift_worksheet_columns, shift_worksheet_rows, update_sheet_view, upsert_defined_name,
    upsert_worksheet_section, workbook_defined_name_fault, worksheet_section, write_column_visibility, write_column_widths,
    write_merged_ranges,
};
use mixdog_ooxml::xlsx_cell_values::{SheetCellLabels, SheetCellValues, formatted_date_text};
use mixdog_ooxml::zipio::Package;
use serde_json::{Map, Value, json};

fn golden() -> Value {
    twin::load_golden("office-sheet-xml")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string argument")
}

/// `String(value ?? '')`.
fn string_of(value: &Value) -> String {
    if value.is_null() { String::new() } else { value_to_string(value) }
}

fn number(value: &Value) -> f64 {
    to_number(value)
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("a list argument").iter().map(|item| text(item).to_owned()).collect()
}

fn options(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn attempt(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    }
}

fn area_json(area: &Area) -> Value {
    json!({
        "startCol": json_number(area.start_col), "endCol": json_number(area.end_col),
        "startRow": json_number(area.start_row), "endRow": json_number(area.end_row),
    })
}

fn cell_value_json(value: Option<CellValue>) -> Value {
    value.map_or(Value::Null, |value| value.to_json())
}

fn pure(name: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |at: usize| &args[at];
    Ok(match name {
        "normalizeColor" => json!(normalize_color_value(Some(arg(0)))),
        "applyCellStyle" => {
            let styled = apply_cell_style(text(arg(0)), number(arg(1)), &options(arg(2)))?;
            json!({ "xml": styled.xml, "index": styled.index })
        }
        "resolveCellStyles" => Value::Array(resolve_cell_styles(text(arg(0)))),
        "numberFormatId" => json_number(number_format_id(text(arg(0)), text(arg(1)))),
        "styleHasNumberFormat" => json!(style_has_number_format(text(arg(0)), number(arg(1)))),
        "isGeneralNumberFormat" => json!(is_general_number_format(text(arg(0)))),
        "normalizeExcelCellStyle" => normalize_excel_cell_style(arg(0)),
        "safeWorkbookTableName" => json!(safe_workbook_table_name(text(arg(0)))),
        "workbookDefinedNameFault" => json!(workbook_defined_name_fault(text(arg(0)))),
        "worksheetSection" => worksheet_section(text(arg(0)), text(arg(1)))
            .map_or(Value::Null, |range| json!({ "index": range.start, "text": &text(arg(0))[range] })),
        "upsertWorksheetSection" => json!(upsert_worksheet_section(text(arg(0)), text(arg(1)), text(arg(2)))),
        "mergedRanges" => json!(merged_ranges(text(arg(0)))),
        "writeMergedRanges" => json!(write_merged_ranges(text(arg(0)), &strings(arg(1)))),
        "shiftWorksheetRows" => json!(shift_worksheet_rows(text(arg(0)), number(arg(1)), number(arg(2)))?),
        "shiftWorksheetColumns" => json!(shift_worksheet_columns(text(arg(0)), number(arg(1)), number(arg(2)))?),
        "appendWorksheetSection" => json!(append_worksheet_section(text(arg(0)), text(arg(1)), text(arg(2)))),
        "conditionalScaleRule" => {
            let priority = arg(2).as_u64().map_or(1, |priority| priority as u32);
            json!(conditional_scale_rule(text(arg(0)), &options(arg(1)), priority))
        }
        "appendDifferentialFormat" => {
            let colors = options(arg(1));
            let color = |key: &str| colors.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
            let added = append_differential_format(text(arg(0)), &color("color"), &color("fillColor"));
            json!({ "xml": added.xml, "id": added.id })
        }
        "mergedCellAnchor" => json!(merged_cell_anchor(text(arg(0)), text(arg(1)))?),
        "sheetViewParts" => {
            let parts = sheet_view_parts(text(arg(0)))?;
            json!({ "attrs": parts.attrs, "body": parts.body })
        }
        "composeSheetView" => json!(compose_sheet_view(text(arg(0)), text(arg(1)))),
        "updateSheetView" => {
            let spec = arg(1);
            let mutate = |view: &str| -> Result<String, String> {
                if spec["parts"].as_bool() == Some(true) {
                    let parts = sheet_view_parts(view)?;
                    return Ok(compose_sheet_view(&format!("{} showGridLines=\"0\"", parts.attrs), &format!("{}<pane/>", parts.body)));
                }
                let replace = strings(&spec["replace"]);
                Ok(view.replacen(&replace[0], &replace[1], 1))
            };
            json!(update_sheet_view(text(arg(0)), mutate)?)
        }
        "freezePaneXml" => json!(freeze_pane_xml(number(arg(0)), number(arg(1)))),
        "parseAreaRange" => area_json(&parse_area_range(text(arg(0)))?),
        "areaReference" => {
            let field = |key: &str| number(&arg(0)[key]);
            json!(area_reference(&Area {
                start_col: field("startCol"),
                end_col: field("endCol"),
                start_row: field("startRow"),
                end_row: field("endRow"),
            }))
        }
        "displayWidth" => json!(display_width(&string_of(arg(0)))),
        "cellWidthScale" => {
            let style = (!arg(0).is_null()).then(|| arg(0));
            json_number(cell_width_scale(style, number(arg(1)), arg(2).as_bool().expect("a flag")))
        }
        "formattedNumberWidth" => {
            let value = (!arg(0).get("undefined").is_some_and(|flag| flag == &json!(true))).then(|| arg(0));
            json!(formatted_number_width(value, text(arg(1))))
        }
        "writeColumnWidths" => {
            let widths: Vec<(u32, f64)> = arg(1)
                .as_array()
                .expect("widths")
                .iter()
                .map(|pair| (number(&pair[0]) as u32, number(&pair[1])))
                .collect();
            json!(write_column_widths(text(arg(0)), &widths))
        }
        "hiddenSheetAreas" => {
            let hidden = hidden_sheet_areas(text(arg(0)));
            json!({ "rows": hidden.rows.iter().collect::<Vec<_>>(), "columns": hidden.columns.iter().collect::<Vec<_>>() })
        }
        "writeColumnVisibility" => {
            let columns: Vec<u32> = arg(1).as_array().expect("columns").iter().map(|column| number(column) as u32).collect();
            json!(write_column_visibility(text(arg(0)), &columns, arg(2).as_bool().expect("a flag")))
        }
        "quoteSheetName" => json!(quote_sheet_name(text(arg(0)))),
        "sheetQualifiedAreas" => Value::Array(
            sheet_qualified_areas(&string_of(arg(0)))
                .into_iter()
                .map(|found| json!({ "sheet": found.sheet, "area": found.area }))
                .collect(),
        ),
        "absoluteRange" => json!(absolute_range(text(arg(0)))),
        "upsertDefinedName" => {
            let spec = arg(2);
            let contains = spec["contains"].as_str().map(str::to_owned);
            let always = spec["always"].as_bool() == Some(true);
            let matches = move |item: &str| contains.as_deref().map_or(always, |needle| item.contains(needle));
            json!(upsert_defined_name(text(arg(0)), arg(1).as_str(), matches))
        }
        "formattedDateText" => formatted_date_text(number(arg(0)), text(arg(1)))?.map_or(Value::Null, Value::from),
        "excelPasswordHash" => {
            let password = if arg(0).get("undefined").is_some() { String::new() } else { string_of(arg(0)) };
            json!(excel_password_hash(&password))
        }
        other => panic!("the recording has a function this test does not replay: {other}"),
    })
}

fn sheet_json(sheet: &mixdog_ooxml::cells::Sheet) -> Value {
    json!({ "name": sheet.name, "path": sheet.path, "rid": sheet.rid, "visibility": sheet.visibility })
}

/// `{ names, parts }`: every entry name in order and the text of every file.
fn snapshot(package: &Package) -> Value {
    let mut parts = Map::new();
    for entry in package.entries() {
        if !entry.dir {
            parts.insert(entry.name.clone(), Value::from(package.text(&entry.name)));
        }
    }
    json!({ "names": package.names(), "parts": parts })
}

struct PartsState {
    zip: Option<Package>,
    sheet: Option<mixdog_ooxml::cells::Sheet>,
    xml: String,
}

fn blank_workbook(work: &std::path::Path, name: &str) -> Result<Package, String> {
    let path = work.join(name);
    let options = CreateOptions { file_kind: "xlsx", title: "t", sheet_name: "Data" };
    create_portable_ooxml_document(&Unlaned, &NoWriteNote, &path, &options)?;
    load_package(&Unlaned, &path)
}

fn parts_step(state: &mut PartsState, work: &std::path::Path, step: &Value) -> Result<Value, String> {
    let field = |name: &str| step.get(name).and_then(Value::as_str).unwrap_or("");
    match field("op") {
        "create" => {
            let zip = blank_workbook(work, "created.xlsx")?;
            let sheet = workbook_sheets(&zip).remove(0);
            state.xml = zip.text(&sheet.path);
            let described = sheet_json(&sheet);
            state.zip = Some(zip);
            state.sheet = Some(sheet);
            Ok(json!({ "sheet": described }))
        }
        "drawing" => {
            let sheet = state.sheet.as_ref().expect("a sheet");
            let made = ensure_worksheet_drawing(state.zip.as_mut().expect("a package"), sheet, &state.xml);
            state.xml.clone_from(&made.worksheet);
            Ok(json!({ "part": made.part, "worksheet": made.worksheet }))
        }
        "note" => {
            let request = &step["request"];
            let mut note = NoteRequest::new(text(&request["cell"]), text(&request["text"]));
            if let Some(author) = request["author"].as_str() {
                note.author = author;
            }
            note.append = request["append"].as_bool() == Some(true);
            let sheet = state.sheet.as_ref().expect("a sheet");
            let made = write_worksheet_note(state.zip.as_mut().expect("a package"), sheet, &state.xml, &note)?;
            state.xml.clone_from(&made.worksheet);
            let mut out = json!({ "worksheet": made.worksheet, "changed": made.changed });
            if let Some(cell) = made.cell {
                out["cell"] = Value::from(cell);
            }
            Ok(out)
        }
        "setSheet" => {
            state.xml = field("xml").to_owned();
            Ok(Value::Null)
        }
        "set" => {
            state.zip.as_mut().expect("a package").set(field("name"), field("text"));
            Ok(Value::Null)
        }
        other => panic!("the recording has a step this test does not replay: {other}"),
    }
}

fn replay_styles(sequence: &Value) {
    let name = text(&sequence["name"]);
    let mut xml = text(&sequence["start"]).to_owned();
    let steps = sequence["steps"].as_array().expect("steps");
    let recorded = sequence["outputs"].as_array().expect("outputs");
    assert_eq!(steps.len(), recorded.len(), "{name}");
    for (index, (step, expected)) in steps.iter().zip(recorded).enumerate() {
        let outcome = apply_cell_style(&xml, number(&step["base"]), &options(&step["props"]));
        let produced = match outcome {
            Ok(styled) => {
                xml = styled.xml;
                json!({ "result": { "index": styled.index } })
            }
            Err(error) => json!({ "error": error }),
        };
        twin::assert_matches(&format!("{name}, step {index}"), expected, &produced);
    }
    twin::assert_matches(&format!("{name}, the styles part"), &sequence["final"], &Value::from(xml.as_str()));
    twin::assert_matches(&format!("{name}, the resolved styles"), &sequence["resolved"], &Value::Array(resolve_cell_styles(&xml)));
}

fn replay_parts(sequence: &Value) {
    let name = text(&sequence["name"]);
    let work = tempfile::tempdir().expect("work directory");
    let mut state = PartsState { zip: None, sheet: None, xml: String::new() };
    let steps = sequence["steps"].as_array().expect("steps");
    let recorded = sequence["outputs"].as_array().expect("outputs");
    assert_eq!(steps.len(), recorded.len(), "{name}");
    for (index, (step, expected)) in steps.iter().zip(recorded).enumerate() {
        let produced = attempt(parts_step(&mut state, work.path(), step));
        twin::assert_matches(&format!("{name}, step {index} ({})", text(&step["op"])), expected, &produced);
    }
    let held = state.zip.as_ref().map_or(Value::Null, snapshot);
    twin::assert_matches(&format!("{name}, the package"), &sequence["snapshot"], &held);
    let worksheet = if state.zip.is_some() { Value::from(state.xml.as_str()) } else { Value::Null };
    twin::assert_matches(&format!("{name}, the worksheet"), &sequence["worksheet"], &worksheet);
}

fn replay_labels(sequence: &Value) {
    let name = text(&sequence["name"]);
    let work = tempfile::tempdir().expect("work directory");
    let mut zip = blank_workbook(work.path(), "labels.xlsx").expect("a blank workbook");
    zip.set("xl/styles.xml", text(&sequence["styles"]));
    zip.set("xl/sharedStrings.xml", text(&sequence["sharedStrings"]));
    let sheet_path = workbook_sheets(&zip).remove(0).path;
    let worksheet = text(&sequence["worksheet"]);
    zip.set(&sheet_path, worksheet);
    let labels = SheetCellLabels::new(&zip, worksheet);
    let values = SheetCellValues::new(&zip, worksheet);
    let cells = sequence["cells"].as_array().expect("cells");
    let recorded = sequence["outputs"].as_array().expect("outputs");
    assert_eq!(cells.len(), recorded.len(), "{name}");
    for (pair, expected) in cells.iter().zip(recorded) {
        let (column, row) = (number(&pair[0]), number(&pair[1]));
        let produced = json!({
            "label": attempt(labels.label(column, row).map(cell_value_json)),
            "dated": attempt(labels.dated(column, row).map(|found| {
                found.map_or(Value::Null, |date| json!({ "serial": json_number(date.serial), "format": date.format }))
            })),
            "value": attempt(Ok(cell_value_json(values.value(column, row)))),
        });
        twin::assert_matches(&format!("{name}, cell {pair}"), expected, &produced);
    }
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let pure_cases = golden["pure"].as_array().expect("pure cases");
    assert!(pure_cases.len() > 500, "the recording lost cases: {}", pure_cases.len());
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
    let sequences = golden["sequences"].as_array().expect("sequences");
    assert!(sequences.len() >= 11, "the recording lost sequences: {}", sequences.len());
    for sequence in sequences {
        match text(&sequence["kind"]) {
            "styles" => replay_styles(sequence),
            "parts" => replay_parts(sequence),
            "labels" => replay_labels(sequence),
            other => panic!("the recording has a sequence kind this test does not replay: {other}"),
        }
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_sheet_xml -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_sheet_xml() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-sheet-xml.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
