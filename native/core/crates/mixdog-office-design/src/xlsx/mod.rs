//! `design/xlsx/design-xlsx.mjs`: `expand_xlsx_sheet` turns a `compose_sheet` operation (a dashboard or a report sheet:
//! eyebrow, title and subtitle bands, metric cards, an insight band, the data table with its number formats, a chart,
//! a decision panel with gates and actions) into the portable xlsx operations that write it, as `{ op, ... }` values
//! in the order, and with the members in the order, Node writes them.
//!
//! The sizes the bands take are estimates of wrapped text (`components::wrap_words`, Hangul and CJK at 1.1 em, Latin
//! at 0.6), so the output is plain data and the same on every host.

mod components;
mod sheet;

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, json_stringify, math, value_to_string};
use mixdog_office_base::labels::preset_labels;
use mixdog_office_base::values::truthy;
use mixdog_ooxml::opc::provenance_citation;
use serde_json::{Map, Value};

pub use components::{band_height, wrap_words};
use components::{num, operation, props, text_value};
use sheet::{Layout, PrintEnd, number_or};

use crate::prop;
use crate::tokens::{provenance_text, strings};

static LATIN_OFFICE_FACE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:calibri|arial|cambria|bookman old style|courier new|times new roman|georgia|segoe ui|aptos)$", "i"));
static SERIF_FACE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:cambria|georgia|bookman old style|times new roman|garamond|book antiqua|palatino linotype|constantia)$", "i"));

/// The Latin faces the presets assign carry no Hangul, and set beside it their digits print smaller than the Korean
/// face the reader substitutes, so a Korean sheet sets each such role in the Korean face of its class (a sheet cell
/// holds one face, so a serif role takes Batang). Any other face is the author's and stays.
fn korean_design(design: &Value, text: &str) -> Value {
    let typography = design.get("tokens").and_then(|tokens| tokens.get("typography"));
    let Some(Value::Object(faces)) = typography.filter(|value| truthy(value)) else { return design.clone() };
    if !text.chars().any(|c| matches!(c, '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' | '\u{AC00}'..='\u{D7AF}')) {
        return design.clone();
    }
    let mut korean = Map::new();
    for (role, face) in faces {
        let name = if truthy(face) { js_trim(&value_to_string(face)).to_owned() } else { String::new() };
        let kept = if !LATIN_OFFICE_FACE.is_match(&name) {
            face.clone()
        } else if SERIF_FACE.is_match(&name) {
            text_value("Batang")
        } else {
            text_value("Malgun Gothic")
        };
        korean.insert(role.clone(), kept);
    }
    let mut result = design.clone();
    if let Some(tokens) = result.get_mut("tokens").and_then(Value::as_object_mut) {
        tokens.insert("typography".to_owned(), Value::Object(korean));
    }
    result
}

/// One full-width band: the value in column A, merged across the bands' width when that is more than one column,
/// styled as a unit.
fn push_band(output: &mut Vec<Value>, sheet: &str, last_column: &str, row: usize, value: &str, properties: Value) {
    output.push(operation("set_cell", vec![("sheet", text_value(sheet)), ("cell", text_value(&format!("A{row}"))), ("value", text_value(value))]));
    if last_column != "A" {
        output.push(operation("merge_cells", vec![("sheet", text_value(sheet)), ("range", text_value(&format!("A{row}:{last_column}{row}")))]));
    }
    output.push(operation(
        "set_style",
        vec![("sheet", text_value(sheet)), ("range", text_value(&format!("A{row}:{last_column}{row}"))), ("properties", properties)],
    ));
}

/// Hangul, kana and Han have no italic: the renderer slants them synthetically.
fn has_no_italic_script(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '\u{1100}'..='\u{11FF}' | '\u{3040}'..='\u{30FF}' | '\u{3130}'..='\u{318F}' | '\u{3400}'..='\u{9FFF}' | '\u{AC00}'..='\u{D7AF}'))
}

/// Eyebrow (dashboards), title and subtitle bands, and the source line; the first free row.
fn push_title_bands(output: &mut Vec<Value>, layout: &Layout, input: &Value) -> usize {
    let (last_column, band_points, widened) = layout.panel_band();
    let tokens = &layout.tokens;
    let sheet = layout.sheet.as_str();
    let dashboard = layout.dashboard;
    // The source of the sheet's figures, in the gap row under the bands, muted, across their width: a cell note alone
    // never reached a printed or rendered page.
    let push_source = |output: &mut Vec<Value>, at: usize| -> bool {
        let Some(source) = prop(input, "source").filter(|source| truthy(source)) else { return false };
        let cited = provenance_text(Some(source));
        let shown = if cited.is_empty() { value_to_string(source) } else { cited };
        push_band(
            output,
            sheet,
            &last_column,
            at,
            &shown,
            props(vec![
                ("fontName", tokens.face("body")),
                ("fontSize", Some(num(8.5))),
                ("color", tokens.color("muted")),
                ("verticalAlignment", Some(text_value("center"))),
            ]),
        );
        true
    };
    let mut row = 1;
    if let Some(title) = prop(input, "title").filter(|title| truthy(title)) {
        if dashboard {
            let eyebrow = match prop(input, "eyebrow") {
                Some(value) if truthy(value) => value_to_string(value),
                _ => {
                    let headers = Value::Array(layout.headers.iter().map(|header| text_value(header)).collect());
                    let sample =
                        Value::Array(vec![title.clone(), prop(input, "subtitle").cloned().unwrap_or(Value::Null), headers, Value::Array(layout.rows.to_vec())]);
                    preset_labels(&sample).eyebrow.to_owned()
                }
            };
            push_band(
                output,
                sheet,
                &last_column,
                row,
                &eyebrow,
                props(vec![
                    ("fontName", tokens.face("data")),
                    ("fontSize", Some(num(9.0))),
                    ("bold", Some(Value::Bool(true))),
                    ("color", tokens.color("accent")),
                    ("fillColor", tokens.color("canvas")),
                    ("verticalAlignment", Some(text_value("center"))),
                ]),
            );
            row += 1;
        }
        let (ink, fill) = if layout.analysis_sheet || dashboard {
            (tokens.color("ink"), tokens.color("canvas"))
        } else if layout.narrative_scorecard {
            (tokens.color("onAccent"), tokens.color("accent"))
        } else {
            (tokens.color("onInverse"), tokens.color("inverse"))
        };
        let title_size = number_or(prop(input, "titleSize"), layout.title_size() + if dashboard { 2.0 } else { 0.0 });
        // With the decision panel beside the table the title spans the panel too: held to the table, a one-line claim
        // broke in two over a page whose right half stood empty. A widened title takes no fill: a tinted canvas drew
        // the long title band as a block of its own.
        let wrapped = wrap_words(&value_to_string(title), title_size, band_points);
        push_band(
            output,
            sheet,
            &last_column,
            row,
            &wrapped,
            props(vec![
                ("fontName", tokens.face("display")),
                ("fontSize", Some(num(title_size))),
                ("bold", Some(Value::Bool(true))),
                ("color", ink),
                ("fillColor", if widened { None } else { fill }),
                ("verticalAlignment", Some(text_value("center"))),
                ("wrapText", Some(Value::Bool(true))),
            ]),
        );
        // A merged band never grows to its wrapped lines: the band takes the lines the title needs across its width.
        output.push(operation(
            "set_row_height",
            vec![("sheet", text_value(sheet)), ("row", num(row as f64)), ("height", num(band_height(&wrapped, title_size, band_points)))],
        ));
        row += 1;
    }
    if let Some(subtitle) = prop(input, "subtitle").filter(|subtitle| truthy(subtitle)) {
        let written = value_to_string(subtitle);
        let size = if dashboard { math::max(10.5, layout.body_size()) } else { layout.body_size() };
        push_band(
            output,
            sheet,
            &last_column,
            row,
            &written,
            props(vec![
                ("fontName", tokens.face("body")),
                ("fontSize", Some(num(size))),
                ("italic", Some(Value::Bool(!has_no_italic_script(&written)))),
                ("color", tokens.color("muted")),
                ("fillColor", tokens.color("surface")),
                ("wrapText", Some(Value::Bool(true))),
            ]),
        );
        push_source(output, row + 1);
        return row + 2;
    }
    if prop(input, "title").is_some_and(truthy) {
        push_source(output, row);
        return row + 1;
    }
    if push_source(output, row) { row + 1 } else { row }
}

/// The insight band: one insight per line, wrapped across the bands' width; the first free row.
fn push_insight_band(output: &mut Vec<Value>, layout: &Layout, input: &Value, row: usize) -> usize {
    let (last_column, band_points, _) = layout.panel_band();
    let insights = strings(prop(input, "insights"));
    if insights.is_empty() {
        return row;
    }
    let tokens = &layout.tokens;
    let fill = if layout.narrative_scorecard {
        tokens.color("inverse")
    } else if layout.trend_dashboard {
        tokens.color("surface")
    } else {
        tokens.color("surface2")
    };
    // One insight per line: joined inline, the wrap left a separator dangling at the end of the first line.
    let size = if layout.dashboard { math::max(10.5, layout.body_size()) } else { layout.body_size() };
    let listed = if insights.len() > 1 { insights.iter().map(|entry| format!("• {entry}")).collect::<Vec<_>>().join("\n") } else { insights[0].clone() };
    let text = wrap_words(&listed, size, band_points);
    push_band(
        output,
        &layout.sheet,
        &last_column,
        row,
        &text,
        props(vec![
            ("fontName", tokens.face("body")),
            ("fontSize", Some(num(size))),
            ("bold", Some(Value::Bool(true))),
            ("color", if layout.narrative_scorecard { tokens.color("onInverse") } else { tokens.color("ink") }),
            ("fillColor", fill),
            ("wrapText", Some(Value::Bool(true))),
        ]),
    );
    // A merged band never grows to its lines, and Excel sized this one by its first column when the wrap was set: the
    // band takes each line it holds, wrapped across its width, as the title band does.
    let height = text.split('\n').fold(8.0, |total, line| total + band_height(line, size, band_points) - 8.0);
    output.push(operation("set_row_height", vec![("sheet", text_value(&layout.sheet)), ("row", num(row as f64)), ("height", num(math::min(409.0, height)))]));
    row + 2
}

/// `expandXlsxSheet(operation, design, composition)`: the portable operations of a composed sheet. `composition` is
/// the composition the sheet was planned as (only its `id` is read); an error is the message Node throws.
pub fn expand_xlsx_sheet(input: &Value, source_design: &Value, composition: Option<&Value>) -> Result<Vec<Value>, String> {
    let mut output: Vec<Value> = Vec::new();
    // A cell holds one face: a Korean sheet sets the preset's Latin roles in Korean faces.
    let design = korean_design(source_design, &json_stringify(input));
    let layout = Layout::new(input, &design, composition)?;
    let mut row = push_title_bands(&mut output, &layout, input);
    row = layout.push_metric_strips(&mut output, row);
    row = push_insight_band(&mut output, &layout, input, row);
    let start_row = row;
    let values: Vec<Value> = if layout.headers.is_empty() {
        layout.rows.to_vec()
    } else {
        let mut all = vec![Value::Array(layout.headers.iter().map(|header| text_value(header)).collect())];
        all.extend(layout.rows.iter().cloned());
        all
    };
    let mut data_end_row = start_row;
    let mut chart = (0.0, 0.0);
    if !values.is_empty() {
        data_end_row = layout.push_data_table(&mut output, input, &values, start_row)?;
        layout.push_column_formats(&mut output, input, start_row, data_end_row)?;
        if let Some(chart_input) = prop(input, "chart").filter(|chart| chart.is_object()) {
            chart = layout.push_chart(&mut output, chart_input, start_row, data_end_row);
        }
    }
    // A metric card's formula reads the data table ("=SUM(Hubs[처리량 (건)])"), and Microsoft Excel checks a formula the
    // moment it is written: set before add_table named Hubs, it was refused and the whole composed sheet failed on
    // Excel while the portable file, which stores the text, went through. The formulas land once the table exists.
    move_to_end(&mut output, "set_formula");
    let (decision_last_row, decision_last_column) = layout.push_decision_panel(&mut output, input, start_row, data_end_row);
    // The citation reads as add_provenance writes one, in the copy's language: "Source: 자료: 운영관리시스템…" put an
    // English label the caller never wrote in front of the one they did.
    let citation = provenance_citation(prop(input, "source").unwrap_or(&Value::Null));
    if !citation.is_empty() {
        output.push(operation("add_note", vec![("sheet", text_value(&layout.sheet)), ("cell", text_value("A1")), ("text", text_value(&citation))]));
    }
    layout.push_autofit(&mut output, decision_last_row.max(data_end_row).max(row), layout.canvas_columns().max(decision_last_column));
    // The chart lands once the columns have their widths: sized in points, it then moves and sizes with its cells, so a
    // chart added before the autofit stretched with the columns under it and ended five columns past the table.
    move_to_end(&mut output, "add_chart");
    layout.push_print_setup(
        &mut output,
        input,
        PrintEnd { row, start_row, value_count: values.len(), decision_last_row, decision_last_column, chart_bottom: chart.0, chart_right: chart.1 },
    );
    Ok(output)
}

/// The operations named `name`, in their order, after every other one.
fn move_to_end(output: &mut Vec<Value>, name: &str) {
    let (moved, kept): (Vec<Value>, Vec<Value>) = std::mem::take(output).into_iter().partition(|entry| entry.get("op").and_then(Value::as_str) == Some(name));
    output.extend(kept);
    output.extend(moved);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn design() -> Value {
        json!({
            "format": { "title": 18, "heading": 11, "body": 10, "tableStyle": "TableStyleMedium4" },
            "tokens": {
                "colors": { "canvas": "FFFFFF", "ink": "111111", "muted": "666666", "accent": "1F7A55", "accent2": "D89224", "surface": "EEEEEE", "surface2": "DDDDDD", "inverse": "132C24", "onAccent": "FFFFFF", "onInverse": "FFFFFF" },
                "typography": { "display": "Cambria", "body": "Calibri", "data": "Arial" }
            }
        })
    }

    fn ops(value: &Value) -> Vec<Value> {
        expand_xlsx_sheet(value, &design(), Some(&json!({ "id": "monitor-dashboard" }))).expect("a sheet")
    }

    fn kinds(list: &[Value]) -> Vec<&str> {
        list.iter().filter_map(|entry| entry["op"].as_str()).collect()
    }

    #[test]
    fn a_report_sheet_is_title_table_autofit_and_page() {
        let list = ops(&json!({ "title": "Sales", "headers": ["Menu", "Sales"], "rows": [["Coffee", 30], ["Cake", 20]] }));
        assert_eq!(
            kinds(&list),
            [
                "set_cell",
                "merge_cells",
                "set_style",
                "set_row_height",
                "set_range",
                "set_style",
                "set_style",
                "add_table",
                "freeze_panes",
                "set_style",
                "set_style",
                "autofit_range",
                "autofit_range",
                "set_page_setup",
                "set_sheet_view"
            ]
        );
        // The title band, then the gap row under it: the table starts on row 3.
        assert_eq!(list[4]["range"], json!("A3:B5"));
        assert_eq!(list[7]["name"], json!("Sheet1Data"));
        assert_eq!(list[7]["style"], json!("TableStyleMedium4"));
        // The integer column takes the thousands form.
        assert_eq!(list[10]["properties"]["numberFormat"], json!("#,##0"));
    }

    #[test]
    fn a_korean_sheet_sets_its_latin_faces_in_korean() {
        let list = ops(&json!({ "title": "야간 운영", "headers": ["허브"], "rows": [["대전"]] }));
        let title = list.iter().find(|entry| entry["op"] == "set_style").expect("a style");
        assert_eq!(title["properties"]["fontName"], json!("Batang"));
        assert_eq!(korean_design(&design(), "abc")["tokens"]["typography"]["display"], json!("Cambria"));
        assert_eq!(korean_design(&design(), "한")["tokens"]["typography"]["body"], json!("Malgun Gothic"));
    }

    #[test]
    fn a_figure_written_as_text_lands_as_the_number_it_shows() {
        let list = ops(
            &json!({ "kind": "dashboard", "headers": ["a", "b"], "rows": [["x", 1]], "metrics": [{ "label": "L", "value": "92.8%" }, { "label": "M", "value": "+1,240" }] }),
        );
        let formats: Vec<&Value> = list.iter().filter_map(|entry| entry.get("properties")?.get("numberFormat")).collect();
        assert!(formats.contains(&&json!("0.0%")));
        assert!(formats.contains(&&json!("+#,##0;-#,##0;#,##0")));
        let card = list.iter().find(|entry| entry["op"] == "set_cell" && entry["value"] == json!(0.928)).expect("92.8% stored as 0.928");
        assert_eq!(card["sheet"], json!("Sheet1"));
    }

    #[test]
    fn formulas_follow_the_table_and_charts_the_autofit() {
        let list = ops(&json!({
            "headers": ["허브", "처리량"], "rows": [["대전", 10], ["광주", 20]],
            "metrics": [{ "label": "합", "formula": "=SUM(Hubs[처리량])" }],
            "chart": { "type": "column" }
        }));
        let names = kinds(&list);
        let table = names.iter().position(|name| *name == "add_table").expect("table");
        let formula = names.iter().position(|name| *name == "set_formula").expect("formula");
        let chart = names.iter().position(|name| *name == "add_chart").expect("chart");
        let autofit = names.iter().rposition(|name| *name == "autofit_range").expect("autofit");
        assert!(table < formula && autofit < chart);
        assert_eq!(names.last(), Some(&"set_sheet_view"));
    }

    #[test]
    fn a_decision_without_a_sentence_or_a_label_is_refused_and_columnformats_must_land() {
        assert!(expand_xlsx_sheet(&json!({ "decision": 5 }), &design(), None).unwrap_err().contains("decision takes a sentence"));
        let missed = expand_xlsx_sheet(&json!({ "headers": ["a"], "rows": [[1]], "columnFormats": { "zzz": "0.0" } }), &design(), None);
        assert!(missed.unwrap_err().contains("matched no column"));
    }
}
