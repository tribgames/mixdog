//! `portable/portable-xlsx-pivot-ops.mjs`: the `add_pivot_table` operation. Which field names the portable writer can lay out,
//! the source range read as a header row plus cached data rows, and the destination the pivot part is written to. The pivot
//! part itself is written by [`crate::pivot`].

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, js_trim, number_to_string, value_to_string};
use mixdog_office_base::a1::column_label;
use serde_json::{Map, Value, json};

use crate::cells::{CellStyle, CellValue, Sheet, cell_style_indexes, set_cell_styles_in_sheet, workbook_sheets};
use crate::pivot::{PivotLayout, PivotRequest, summarize_pivot_fields, write_pivot_table};
use crate::sheet_styles::{apply_cell_style, number_format_id, resolve_cell_styles};
use crate::sheet_xml::{Area, area_reference, parse_area_range};
use crate::text_metrics::TextMeasurer;
use crate::xlsx_audit_support::{js_text, text_or_empty, truthy};
use crate::xlsx_cell_values::SheetCellValues;
use crate::xlsx_range_layout::autofit_worksheet_range;
use crate::zipio::Package;

static PIVOT_TABLE_PART: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^xl\/pivotTables\/pivotTable\d+\.xml$", ""));

/// The row, column and value field names an `add_pivot_table` op names.
struct FieldNames {
    rows: Vec<String>,
    columns: Vec<String>,
    values: Vec<String>,
}

/// A name or a list of names as the non-empty trimmed texts of it.
fn as_list(value: Option<&Value>) -> Vec<String> {
    let names: Vec<&Value> = match value {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(list)) => list.iter().collect(),
        Some(single) => vec![single],
    };
    names
        .into_iter()
        .map(|entry| if entry.is_null() { String::new() } else { js_trim(&value_to_string(entry)).to_owned() })
        .filter(|name| !name.is_empty())
        .collect()
}

/// The row, column and value field names an `add_pivot_table` op names, within what the portable writer can lay out.
fn pivot_field_names(op: &Map<String, Value>) -> Result<FieldNames, String> {
    let names = FieldNames { rows: as_list(op.get("rows")), columns: as_list(op.get("columns")), values: as_list(op.get("values")) };
    if names.values.is_empty() {
        return Err("add_pivot_table requires at least one value field".to_owned());
    }
    if names.rows.len() > 1 || names.columns.len() > 1 {
        return Err("Portable add_pivot_table supports one row field and one column field; run the edit with Microsoft Excel for deeper nesting".to_owned());
    }
    if names.values.len() > 1 && !names.columns.is_empty() {
        return Err("Portable add_pivot_table supports multiple value fields only without a column field".to_owned());
    }
    Ok(names)
}

/// What a cell shows as a pivot source value.
fn source_value(value: Option<CellValue>) -> Value {
    value.map_or(Value::Null, |value| value.to_json())
}

/// The source range as its header row plus data rows of cached values.
fn pivot_source_table(zip: &Package, xml: &str, area: &Area) -> Result<(Vec<String>, Vec<Vec<Value>>), String> {
    let cell_value = SheetCellValues::new(zip, xml);
    let mut headers: Vec<String> = Vec::new();
    let mut column = area.start_col;
    while column <= area.end_col {
        headers.push(match cell_value.value(column, area.start_row) {
            None => String::new(),
            Some(value) => value_to_string(&value.to_json()),
        });
        column += 1.0;
    }
    if headers.iter().any(String::is_empty) {
        return Err("add_pivot_table requires a field name in every column of the first source row".to_owned());
    }
    let mut records: Vec<Vec<Value>> = Vec::new();
    let mut row = area.start_row + 1.0;
    while row <= area.end_row {
        records.push((0..headers.len()).map(|index| source_value(cell_value.value(area.start_col + index as f64, row))).collect());
        row += 1.0;
    }
    Ok((headers, records))
}

/// What `formatPivotValues` is told of the pivot just written.
struct WrittenPivot<'a> {
    value_fields: &'a [usize],
    column_field: i64,
    rows: usize,
    columns: usize,
    table_part: &'a str,
}

/// The pivot's figures in the format their source column carries, as Excel lays them out: written plain, 7,043 read 7043 under
/// a source column set #,##0. A pivot with a column field sums one value field across every data column; without one, each data
/// column is its own value field. The value field carries the format too: Excel lays a pivot out again when it opens the file,
/// from its definition, and the cells' own formats alone came back plain.
fn format_pivot_values(zip: &mut Package, xml: &str, area: &Area, destination: &Sheet, anchor: &Area, layout: &WrittenPivot<'_>) -> Result<(), String> {
    let styles_xml = zip.text("xl/styles.xml");
    if styles_xml.is_empty() {
        return Ok(());
    }
    let styles = resolve_cell_styles(&styles_xml);
    let source_format = |field: usize| -> Result<String, String> {
        let reference = format!("{}{}", column_label(area.start_col + field as f64), number_to_string(area.start_row + 1.0));
        let index = cell_style_indexes(xml, &[reference.as_str()])?.first().map_or(0, |(_, index)| *index);
        Ok(text_or_empty(styles.get(index as usize).and_then(|style| style.get("numberFormat"))))
    };
    let formats: Vec<String> = layout.value_fields.iter().map(|field| source_format(*field)).collect::<Result<_, _>>()?;
    if !formats.iter().any(|format| !format.is_empty()) {
        return Ok(());
    }
    let mut sheet_xml = zip.text(&destination.path);
    let header_rows = if layout.column_field >= 0 { 2.0 } else { 1.0 };
    let mut refs: Vec<(String, &str)> = Vec::new();
    let mut row = anchor.start_row + header_rows;
    while row < anchor.start_row + layout.rows as f64 {
        for offset in 1..layout.columns {
            let format = if layout.column_field >= 0 { formats.first() } else { formats.get(offset - 1) };
            if let Some(format) = format.filter(|format| !format.is_empty()) {
                refs.push((format!("{}{}", column_label(anchor.start_col + offset as f64), number_to_string(row)), format.as_str()));
            }
        }
        row += 1.0;
    }
    let names: Vec<&str> = refs.iter().map(|(reference, _)| reference.as_str()).collect();
    let current: HashMap<String, u64> = cell_style_indexes(&sheet_xml, &names)?.into_iter().collect();
    let mut next_styles = styles_xml;
    let mut made: HashMap<(u64, &str), usize> = HashMap::new();
    let mut indexes: Vec<String> = Vec::with_capacity(refs.len());
    for (reference, format) in &refs {
        let base = current.get(reference.as_str()).copied().unwrap_or(0);
        let style = match made.get(&(base, *format)) {
            Some(style) => *style,
            None => {
                let mut properties = Map::new();
                properties.insert("numberFormat".to_owned(), json!(format));
                let applied = apply_cell_style(&next_styles, base as f64, &properties)?;
                next_styles = applied.xml;
                made.insert((base, *format), applied.index);
                applied.index
            }
        };
        indexes.push(style.to_string());
    }
    let entries: Vec<CellStyle<'_>> = refs.iter().zip(&indexes).map(|((reference, _), style)| CellStyle { reference, style }).collect();
    sheet_xml = set_cell_styles_in_sheet(&sheet_xml, &entries)?;
    zip.set("xl/styles.xml", next_styles.clone().into_bytes());
    zip.set(&destination.path, sheet_xml.into_bytes());
    let mut table = zip.text(layout.table_part);
    for (position, field) in layout.value_fields.iter().enumerate() {
        let id = number_format_id(&next_styles, &formats[position]);
        if id == 0.0 || id.is_nan() {
            continue;
        }
        let pattern = JsRegex::new(&format!(r#"(<dataField\b[^>]*\bfld="{field}")([^>]*?)(\/?>)"#), "")?;
        let rewritten = pattern.captures(&table).map(|found| {
            let text = format!("{}{} numFmtId=\"{}\"{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""), number_to_string(id), found.get(3).unwrap_or(""));
            (found.range(), text)
        });
        if let Some((whole, text)) = rewritten {
            table.replace_range(whole, &text);
        }
    }
    zip.set(layout.table_part, table.into_bytes());
    Ok(())
}

/// `addWorksheetPivotTable(zip, sheet, xml, op)`: one row field and one column field over a bounded source range.
pub fn add_worksheet_pivot_table<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    zip: &mut Package,
    sheet: &Sheet,
    xml: &str,
    op: &Map<String, Value>,
) -> Result<Value, String> {
    let source = op.get("source");
    let area = parse_area_range(&text_or_empty(source)).map_err(|error| if truthy(source) { error } else { format!("Unsupported range: {}", js_text(source)) })?;
    if area.start_row == 0.0 || area.start_col == 0.0 || area.end_row <= area.start_row {
        return Err("add_pivot_table requires a bounded source range whose first row holds field names".to_owned());
    }
    let names = pivot_field_names(op)?;
    let (headers, records) = pivot_source_table(zip, xml, &area)?;
    let field_index = |name: &str| -> Result<usize, String> {
        headers
            .iter()
            .position(|header| header == name)
            .ok_or_else(|| format!("add_pivot_table field \"{name}\" is not in the source header row ({})", headers.join(", ")))
    };
    let destination_name = if truthy(op.get("destinationSheet")) { js_text(op.get("destinationSheet")) } else { sheet.name.clone() };
    let destination = workbook_sheets(zip)
        .into_iter()
        .find(|entry| entry.name == destination_name)
        .ok_or_else(|| format!("add_pivot_table destination sheet \"{destination_name}\" was not found"))?;
    let pivot_name = if truthy(op.get("name")) {
        js_text(op.get("name"))
    } else {
        format!("MixdogPivot{}", zip.files_matching(&PIVOT_TABLE_PART).len() + 1)
    };
    let axes: Vec<usize> = names.rows.iter().chain(&names.columns).map(|name| field_index(name)).collect::<Result<_, _>>()?;
    let value_fields: Vec<usize> = names.values.iter().map(|name| field_index(name)).collect::<Result<_, _>>()?;
    let column_field = match names.columns.first() {
        Some(name) => field_index(name)? as i64,
        None => -1,
    };
    let fields = summarize_pivot_fields(&headers, &records, &axes);
    let row_field = match names.rows.first() {
        Some(name) => field_index(name)? as i64,
        None => -1,
    };
    let destination_text = if truthy(op.get("destination")) { js_text(op.get("destination")) } else { "A1".to_owned() };
    let source_ref = area_reference(&area);
    let written = write_pivot_table(
        zip,
        &PivotRequest {
            layout: PivotLayout { fields: &fields, row_field, column_field, value_fields: &value_fields },
            records: &records,
            source_sheet: &sheet.name,
            source_ref: &source_ref,
            destination_sheet_path: &destination.path,
            destination: &destination_text,
            name: &pivot_name,
        },
    )?;
    let anchor = parse_area_range(&destination_text)?;
    format_pivot_values(
        zip,
        xml,
        &area,
        &destination,
        &anchor,
        &WrittenPivot { value_fields: &value_fields, column_field, rows: written.rows, columns: written.columns, table_part: &written.table_part },
    )?;
    // Excel fits a pivot's columns to what they hold when it lays the pivot out ("Autofit column widths on update" is on by
    // default); written at the sheet default, "Channel Partners" and 11,388,173 were cut to ### on the page.
    let fit = area_reference(&Area {
        start_row: anchor.start_row,
        start_col: anchor.start_col,
        end_row: anchor.start_row + written.rows as f64 - 1.0,
        end_col: anchor.start_col + written.columns as f64 - 1.0,
    });
    let mut fit_op = Map::new();
    fit_op.insert("op".to_owned(), json!("autofit_range"));
    fit_op.insert("range".to_owned(), json!(fit));
    let destination_xml = zip.text(&destination.path);
    autofit_worksheet_range(measurer, zip, &destination, &destination_xml, &fit_op)?;
    let mut result = Map::new();
    if let Some(name) = op.get("op") {
        result.insert("op".to_owned(), name.clone());
    }
    result.insert("changed".to_owned(), json!(true));
    result.insert("sheet".to_owned(), json!(destination_name));
    result.insert("name".to_owned(), json!(pivot_name));
    result.insert("rows".to_owned(), json!(records.len()));
    result.insert("fields".to_owned(), json!(headers.len()));
    result.insert("part".to_owned(), json!(written.table_part));
    Ok(Value::Object(result))
}
