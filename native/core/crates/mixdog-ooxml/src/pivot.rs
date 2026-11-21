//! `portable/portable-pivot.mjs`: a pivot table written into a workbook as Excel keeps it, twice over: the definition a
//! refresh recomputes (the cache definition and its records, the table part, their relationships and content types) and
//! the cells a reader sees before any refresh happens (the computed grid, written into the destination sheet). A
//! destination with the definition alone opens empty in Excel and holds nothing for a snapshot, an autofit or a fit audit
//! to read.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_sort_by, json_number, locale_compare_en, number_to_string, string_to_number, to_number, to_number_of, value_to_string};
use serde_json::Value;

use crate::cells::{column_label, column_number, parse_cell_ref, set_cell_in_sheet};
use crate::opc::{add_package_relationship, ensure_content_type_override, part_relationship_path, posix};
use crate::xml::{OFFICE_RELATIONSHIP_BASE as RELATIONSHIP_BASE, SPREADSHEET_MAIN, XML_HEADER, xml_encode};
use crate::zipio::Package;

const CACHE_DEFINITION_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml";
const CACHE_RECORDS_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml";
const PIVOT_TABLE_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml";

static PIVOT_CACHE_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<pivotCache\b", "g"));
static PIVOT_CACHES_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<pivotCaches>", ""));
static CALC_PR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(<calcPr\b[^>]*\/>)", ""));

/// One source column of a pivot: its caption, what kind of items it holds and the items themselves.
#[derive(Debug, Clone, PartialEq)]
pub struct PivotField {
    pub name: String,
    /// A figure summed in the pivot (a numeric column that is on no axis).
    pub numeric: bool,
    /// A numeric column on an axis: "Year" across the top is 2013 and 2014, not a sum, so its values are numeric items.
    pub numeric_items: bool,
    /// The range of a numeric column; zero for a text column.
    pub min: f64,
    pub max: f64,
    pub integer: bool,
    /// The distinct items, in the order first seen (empty for a figure).
    pub items: Vec<String>,
}

/// `String(value ?? '')`.
fn string_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// `[...new Set(items)]`: each item once, in the order first seen.
fn distinct(items: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    items.filter(|item| seen.insert(item.clone())).collect()
}

/// `summarizePivotFields(headers, records, axes)`: the fields of a source range. `axes` holds the field indexes laid out
/// as rows or columns. A numeric field on an axis is still a set of items; left as a bare number range it had no items
/// to lay out, and the pivot showed a lone "Grand Total" column under the "Year" heading.
pub fn summarize_pivot_fields(headers: &[String], records: &[Vec<Value>], axes: &[usize]) -> Vec<PivotField> {
    headers
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let column: Vec<Option<&Value>> = records.iter().map(|record| record.get(index)).collect();
            let numeric = !column.is_empty()
                && column.iter().all(|value| match value {
                    None | Some(Value::Null) => false,
                    Some(Value::String(text)) if text.is_empty() => false,
                    Some(value) => to_number(value).is_finite(),
                });
            if numeric {
                let numbers: Vec<f64> = column.iter().map(|value| to_number_of(*value)).collect();
                let min = numbers.iter().copied().fold(f64::INFINITY, f64::min);
                let max = numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let integer = numbers.iter().all(|value| value.is_finite() && value.trunc() == *value);
                if axes.contains(&index) {
                    let items = distinct(numbers.iter().map(|number| number_to_string(*number)));
                    return PivotField { name: name.clone(), numeric: false, numeric_items: true, min, max, integer, items };
                }
                return PivotField { name: name.clone(), numeric: true, numeric_items: false, min, max, integer, items: Vec::new() };
            }
            let items = distinct(column.iter().map(|value| string_of(*value)));
            PivotField { name: name.clone(), numeric: false, numeric_items: false, min: 0.0, max: 0.0, integer: false, items }
        })
        .collect()
}

/// The item indexes of a field in the order a pivot lists them.
fn display_order(field: &PivotField) -> Vec<usize> {
    let mut order: Vec<usize> = (0..field.items.len()).collect();
    if field.numeric_items {
        js_sort_by(&mut order, |left, right| string_to_number(&field.items[*left]) - string_to_number(&field.items[*right]));
    } else {
        js_sort_by(&mut order, |left, right| match locale_compare_en(&field.items[*left], &field.items[*right]) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Greater => 1.0,
        });
    }
    order
}

fn shared_items_xml(field: &PivotField) -> String {
    let integer = if field.integer { " containsInteger=\"1\"" } else { "" };
    if field.numeric {
        return format!(
            "<sharedItems containsSemiMixedTypes=\"0\" containsString=\"0\" containsNumber=\"1\"{integer} minValue=\"{}\" maxValue=\"{}\"/>",
            number_to_string(field.min),
            number_to_string(field.max)
        );
    }
    if field.numeric_items {
        let items: String = field.items.iter().map(|item| format!("<n v=\"{}\"/>", number_to_string(string_to_number(item)))).collect();
        return format!(
            "<sharedItems containsSemiMixedTypes=\"0\" containsString=\"0\" containsNumber=\"1\"{integer} minValue=\"{}\" maxValue=\"{}\" count=\"{}\">{items}</sharedItems>",
            number_to_string(field.min),
            number_to_string(field.max),
            field.items.len()
        );
    }
    let items: String = field.items.iter().map(|item| format!("<s v=\"{}\"/>", xml_encode(item))).collect();
    format!("<sharedItems count=\"{}\">{items}</sharedItems>", field.items.len())
}

fn cache_definition_xml(fields: &[PivotField], record_count: usize, source_sheet: &str, source_ref: &str, records_relationship_id: &str) -> String {
    let cache_fields: String = fields
        .iter()
        .map(|field| format!("<cacheField name=\"{}\" numFmtId=\"0\">{}</cacheField>", xml_encode(&field.name), shared_items_xml(field)))
        .collect();
    format!(
        "{XML_HEADER}<pivotCacheDefinition xmlns=\"{SPREADSHEET_MAIN}\" xmlns:r=\"{RELATIONSHIP_BASE}\" r:id=\"{records_relationship_id}\" createdVersion=\"8\" refreshedVersion=\"8\" minRefreshableVersion=\"3\" refreshOnLoad=\"1\" recordCount=\"{record_count}\"><cacheSource type=\"worksheet\"><worksheetSource ref=\"{}\" sheet=\"{}\"/></cacheSource><cacheFields count=\"{}\">{cache_fields}</cacheFields></pivotCacheDefinition>",
        xml_encode(source_ref),
        xml_encode(source_sheet),
        fields.len()
    )
}

/// The key a record's value is filed under: a numeric item compares as the number it is (`"2013"` and `2013` alike).
fn item_key(field: &PivotField, value: Option<&Value>) -> String {
    if field.numeric_items { number_to_string(to_number_of(value)) } else { string_of(value) }
}

/// Each text item's position among its field's shared items (the first, when an item repeats), read once per field
/// instead of searched for every cell.
fn item_positions(field: &PivotField) -> HashMap<&str, usize> {
    let mut positions = HashMap::new();
    for (index, item) in field.items.iter().enumerate() {
        positions.entry(item.as_str()).or_insert(index);
    }
    positions
}

fn cache_records_xml(fields: &[PivotField], records: &[Vec<Value>]) -> String {
    let positions: Vec<Option<HashMap<&str, usize>>> = fields.iter().map(|field| if field.numeric { None } else { Some(item_positions(field)) }).collect();
    let rows: String = records
        .iter()
        .map(|record| {
            let cells: String = record
                .iter()
                .enumerate()
                .filter_map(|(index, value)| fields.get(index).map(|field| (index, field, value)))
                .map(|(index, field, value)| {
                    let Some(positions) = &positions[index] else {
                        return format!("<n v=\"{}\"/>", number_to_string(to_number(value)));
                    };
                    let position = positions.get(item_key(field, Some(value)).as_str()).copied();
                    format!("<x v=\"{}\"/>", position.unwrap_or(0))
                })
                .collect();
            format!("<r>{cells}</r>")
        })
        .collect();
    format!(
        "{XML_HEADER}<pivotCacheRecords xmlns=\"{SPREADSHEET_MAIN}\" xmlns:r=\"{RELATIONSHIP_BASE}\" count=\"{}\">{rows}</pivotCacheRecords>",
        records.len()
    )
}

/// The captions a pivot prints, in the language of its fields: Korean Excel heads a sum "합계 : 매출" and its totals
/// "총합계"; written in English beside Hangul fields, a pivot read "Sum of 매출" over "Grand Total".
struct Captions {
    korean: bool,
}

impl Captions {
    fn of(fields: &[PivotField]) -> Self {
        Self { korean: fields.iter().any(|field| field.name.chars().any(|c| ('\u{ac00}'..='\u{d7af}').contains(&c))) }
    }

    fn sum(&self, name: &str) -> String {
        if self.korean { format!("합계 : {name}") } else { format!("Sum of {name}") }
    }

    fn grand(&self) -> &'static str {
        if self.korean { "총합계" } else { "Grand Total" }
    }

    fn total(&self) -> &'static str {
        if self.korean { "합계" } else { "Total" }
    }
}

/// What a pivot is made of: which source fields lie on its rows, its columns and as its values (`-1` for no field).
#[derive(Debug, Clone, Copy)]
pub struct PivotLayout<'a> {
    pub fields: &'a [PivotField],
    pub row_field: i64,
    pub column_field: i64,
    pub value_fields: &'a [usize],
}

/// The sum of a source column over the records that match, with a non-number counted as zero.
fn sum(records: &[Vec<Value>], value_index: usize, matches: impl Fn(&[Value]) -> bool) -> f64 {
    records.iter().fold(0.0, |total, record| {
        if !matches(record) {
            return total;
        }
        let number = to_number_of(record.get(value_index));
        total + if number.is_nan() { 0.0 } else { number }
    })
}

fn pivot_grid(layout: &PivotLayout<'_>, records: &[Vec<Value>]) -> Vec<Vec<Value>> {
    let PivotLayout { fields, row_field, column_field, value_fields } = *layout;
    let field_at = |index: i64| &fields[index as usize];
    let items_of = |index: i64| -> Vec<String> {
        let field = field_at(index);
        display_order(field).into_iter().map(|item| field.items[item].clone()).collect()
    };
    // A numeric item heads its row or column as the number it is, so it sorts and formats as one.
    let shown = |index: i64, label: &str| -> Value {
        if field_at(index).numeric_items { json_number(string_to_number(label)) } else { Value::String(label.to_owned()) }
    };
    let row_labels = if row_field >= 0 { items_of(row_field) } else { Vec::new() };
    let column_labels = if column_field >= 0 { items_of(column_field) } else { Vec::new() };
    let captions = Captions::of(fields);
    let grand = captions.grand();
    let heading = |value_index: usize| captions.sum(&fields[value_index].name);
    let in_row = |record: &[Value], label: &str| item_key(field_at(row_field), record.get(row_field as usize)) == label;
    let number = |value: f64| json_number(value);
    let text = |value: &str| Value::String(value.to_owned());
    let mut rows: Vec<Vec<Value>> = Vec::new();
    if column_field >= 0 {
        let value_index = value_fields[0];
        let in_column = |record: &[Value], label: &str| item_key(field_at(column_field), record.get(column_field as usize)) == label;
        rows.push(vec![text(&heading(value_index)), text(&field_at(column_field).name)]);
        let mut head = vec![if row_field >= 0 { text(&field_at(row_field).name) } else { text("") }];
        head.extend(column_labels.iter().map(|label| shown(column_field, label)));
        head.push(text(grand));
        rows.push(head);
        for label in &row_labels {
            let mut line = vec![shown(row_field, label)];
            line.extend(column_labels.iter().map(|column| number(sum(records, value_index, |record| in_row(record, label) && in_column(record, column)))));
            line.push(number(sum(records, value_index, |record| in_row(record, label))));
            rows.push(line);
        }
        let mut totals = vec![text(grand)];
        totals.extend(column_labels.iter().map(|column| number(sum(records, value_index, |record| in_column(record, column)))));
        totals.push(number(sum(records, value_index, |_| true)));
        rows.push(totals);
        return rows;
    }
    let mut head = vec![if row_field >= 0 { text(&field_at(row_field).name) } else { text("") }];
    head.extend(value_fields.iter().map(|index| text(&heading(*index))));
    rows.push(head);
    for label in &row_labels {
        let mut line = vec![shown(row_field, label)];
        line.extend(value_fields.iter().map(|value_index| number(sum(records, *value_index, |record| in_row(record, label)))));
        rows.push(line);
    }
    let mut totals = vec![text(if row_field >= 0 { grand } else { captions.total() })];
    totals.extend(value_fields.iter().map(|value_index| number(sum(records, *value_index, |_| true))));
    rows.push(totals);
    rows
}

fn axis_items_xml(order: &[usize]) -> String {
    let items: String = order.iter().map(|item| format!("<item x=\"{item}\"/>")).collect();
    format!("<items count=\"{}\">{items}<item t=\"default\"/></items>", order.len() + 1)
}

fn axis_entries_xml(count: usize) -> String {
    (0..count).map(|position| if position == 0 { "<i><x/></i>".to_owned() } else { format!("<i><x v=\"{position}\"/></i>") }).collect()
}

fn pivot_table_xml(name: &str, cache_id: usize, layout: &PivotLayout<'_>, destination: &str) -> Result<String, String> {
    let PivotLayout { fields, row_field, column_field, value_fields } = *layout;
    let row_order = if row_field >= 0 { display_order(&fields[row_field as usize]) } else { Vec::new() };
    let column_order = if column_field >= 0 { display_order(&fields[column_field as usize]) } else { Vec::new() };
    let pivot_fields: String = (0..fields.len())
        .map(|index| {
            let at = index as i64;
            if at == row_field {
                format!("<pivotField axis=\"axisRow\" showAll=\"0\">{}</pivotField>", axis_items_xml(&row_order))
            } else if at == column_field {
                format!("<pivotField axis=\"axisCol\" showAll=\"0\">{}</pivotField>", axis_items_xml(&column_order))
            } else if value_fields.contains(&index) {
                "<pivotField dataField=\"1\" showAll=\"0\"/>".to_owned()
            } else {
                "<pivotField showAll=\"0\"/>".to_owned()
            }
        })
        .collect();

    let row_section = if row_field >= 0 {
        format!(
            "<rowFields count=\"1\"><field x=\"{row_field}\"/></rowFields><rowItems count=\"{}\">{}<i t=\"grand\"><x/></i></rowItems>",
            row_order.len() + 1,
            axis_entries_xml(row_order.len())
        )
    } else {
        "<rowItems count=\"1\"><i/></rowItems>".to_owned()
    };

    let value_item_xml = |position: usize| {
        let index = if position > 0 { format!(" i=\"{position}\"") } else { String::new() };
        let value = if position == 0 { "<x/>".to_owned() } else { format!("<x v=\"{position}\"/>") };
        format!("<i{index}>{value}</i>")
    };
    let mut column_section = "<colItems count=\"1\"><i/></colItems>".to_owned();
    if column_field >= 0 {
        column_section = format!(
            "<colFields count=\"1\"><field x=\"{column_field}\"/></colFields><colItems count=\"{}\">{}<i t=\"grand\"><x/></i></colItems>",
            column_order.len() + 1,
            axis_entries_xml(column_order.len())
        );
    } else if value_fields.len() > 1 {
        let items: String = (0..value_fields.len()).map(value_item_xml).collect();
        column_section = format!("<colFields count=\"1\"><field x=\"-2\"/></colFields><colItems count=\"{}\">{items}</colItems>", value_fields.len());
    }

    let captions = Captions::of(fields);
    let data_fields: String = value_fields
        .iter()
        .map(|index| format!("<dataField name=\"{}\" fld=\"{index}\" baseField=\"0\" baseItem=\"0\"/>", xml_encode(&captions.sum(&fields[*index].name))))
        .collect();
    let data_fields = format!("<dataFields count=\"{}\">{data_fields}</dataFields>", value_fields.len());

    let anchor = parse_cell_ref(destination)?;
    let header_rows: u64 = if column_field >= 0 { 2 } else { 1 };
    let body_rows = row_order.len().max(1) as u64 + u64::from(row_field >= 0);
    let width = 1 + if column_field >= 0 { column_order.len() + 1 } else { value_fields.len() };
    let reference =
        format!("{}{}:{}{}", anchor.col, anchor.row, column_label(column_number(&anchor.col) + width as f64 - 1.0), anchor.row + header_rows + body_rows - 1);

    // The row header names its field, as the cells written here do; a refresh otherwise prints "Row Labels" (행 레이블)
    // over the regions. The column header too: a refresh otherwise prints "Column Labels" (열 레이블) over the months.
    let row_caption = if row_field >= 0 { format!(" rowHeaderCaption=\"{}\"", xml_encode(&fields[row_field as usize].name)) } else { String::new() };
    let column_caption = if column_field >= 0 { format!(" colHeaderCaption=\"{}\"", xml_encode(&fields[column_field as usize].name)) } else { String::new() };

    Ok(format!(
        "{XML_HEADER}<pivotTableDefinition xmlns=\"{SPREADSHEET_MAIN}\" name=\"{}\" cacheId=\"{cache_id}\" dataCaption=\"Values\" grandTotalCaption=\"{}\"{row_caption}{column_caption} applyNumberFormats=\"0\" applyBorderFormats=\"0\" applyFontFormats=\"0\" applyPatternFormats=\"0\" applyAlignmentFormats=\"0\" applyWidthHeightFormats=\"1\" updatedVersion=\"8\" minRefreshableVersion=\"3\" useAutoFormatting=\"1\" itemPrintTitles=\"1\" createdVersion=\"8\" indent=\"0\" outline=\"1\" outlineData=\"1\" multipleFieldFilters=\"0\"><location ref=\"{reference}\" firstHeaderRow=\"1\" firstDataRow=\"{header_rows}\" firstDataCol=\"1\"/><pivotFields count=\"{}\">{pivot_fields}</pivotFields>{row_section}{column_section}{data_fields}<pivotTableStyleInfo name=\"PivotStyleLight16\" showRowHeaders=\"1\" showColHeaders=\"1\" showRowStripes=\"0\" showColStripes=\"0\" showLastColumn=\"1\"/></pivotTableDefinition>",
        xml_encode(name),
        xml_encode(captions.grand()),
        fields.len()
    ))
}

/// What `writePivotTable` is given.
#[derive(Debug, Clone, Copy)]
pub struct PivotRequest<'a> {
    pub layout: PivotLayout<'a>,
    /// The source records: one row per record, one value per field.
    pub records: &'a [Vec<Value>],
    pub source_sheet: &'a str,
    pub source_ref: &'a str,
    pub destination_sheet_path: &'a str,
    /// The cell the pivot's top-left corner is written at.
    pub destination: &'a str,
    pub name: &'a str,
}

/// What `writePivotTable` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PivotWritten {
    pub definition_part: String,
    pub records_part: String,
    pub table_part: String,
    pub cache_id: usize,
    pub rows: usize,
    /// The widest row of the grid (the first row of a pivot with a column field holds two cells: the value heading and the
    /// field's name).
    pub columns: usize,
}

fn first_free_ordinal(zip: &Package, part_prefix: &str) -> usize {
    (1..).find(|ordinal| zip.file(&format!("{part_prefix}{ordinal}.xml")).is_none()).unwrap_or(1)
}

/// Relates the cache definition to the workbook and lists it in `<pivotCaches>`; answers the id the workbook gave it.
fn register_workbook_pivot_cache(zip: &mut Package, definition_part: &str) -> usize {
    let relationship_id = add_package_relationship(
        zip,
        "xl/_rels/workbook.xml.rels",
        &format!("{RELATIONSHIP_BASE}/pivotCacheDefinition"),
        &posix::relative("xl", definition_part),
        "",
    );
    let mut workbook = zip.text("xl/workbook.xml");
    let cache_id = PIVOT_CACHE_OPEN.find_iter(&workbook).count() + 1;
    let entry = format!("<pivotCache cacheId=\"{cache_id}\" r:id=\"{relationship_id}\"/>");
    if PIVOT_CACHES_OPEN.is_match(&workbook) {
        workbook = workbook.replacen("</pivotCaches>", &format!("{entry}</pivotCaches>"), 1);
    } else {
        let block = format!("<pivotCaches>{entry}</pivotCaches>");
        workbook = match CALC_PR.find(&workbook) {
            Some(range) => format!("{}{block}{}", &workbook[..range.end], &workbook[range.end..]),
            None => workbook.replacen("</sheets>", &format!("</sheets>{block}"), 1),
        };
    }
    zip.set("xl/workbook.xml", workbook);
    cache_id
}

fn write_pivot_grid(zip: &mut Package, sheet_path: &str, destination: &str, grid: &[Vec<Value>]) -> Result<(), String> {
    let anchor = parse_cell_ref(destination)?;
    let anchor_column = column_number(&anchor.col);
    let mut sheet_xml = zip.text(sheet_path);
    for (row_offset, row) in grid.iter().enumerate() {
        for (column_offset, value) in row.iter().enumerate() {
            if value.is_null() || value.as_str() == Some("") {
                continue;
            }
            let reference = format!("{}{}", column_label(anchor_column + column_offset as f64), anchor.row + row_offset as u64);
            sheet_xml = set_cell_in_sheet(&sheet_xml, &reference, value, "")?;
        }
    }
    zip.set(sheet_path, sheet_xml);
    Ok(())
}

/// `writePivotTable(zip, request)`.
pub fn write_pivot_table(zip: &mut Package, request: &PivotRequest<'_>) -> Result<PivotWritten, String> {
    let PivotRequest { layout, records, source_sheet, source_ref, destination_sheet_path, destination, name } = *request;
    let ordinal = first_free_ordinal(zip, "xl/pivotCache/pivotCacheDefinition");
    let definition_part = format!("xl/pivotCache/pivotCacheDefinition{ordinal}.xml");
    let records_part = format!("xl/pivotCache/pivotCacheRecords{ordinal}.xml");
    let table_part = format!("xl/pivotTables/pivotTable{}.xml", first_free_ordinal(zip, "xl/pivotTables/pivotTable"));

    let records_relationship_id = add_package_relationship(
        zip,
        &part_relationship_path(&definition_part),
        &format!("{RELATIONSHIP_BASE}/pivotCacheRecords"),
        &format!("pivotCacheRecords{ordinal}.xml"),
        "",
    );
    zip.set(&definition_part, cache_definition_xml(layout.fields, records.len(), source_sheet, source_ref, &records_relationship_id));
    zip.set(&records_part, cache_records_xml(layout.fields, records));
    ensure_content_type_override(zip, &format!("/{definition_part}"), CACHE_DEFINITION_CONTENT_TYPE);
    ensure_content_type_override(zip, &format!("/{records_part}"), CACHE_RECORDS_CONTENT_TYPE);

    let cache_id = register_workbook_pivot_cache(zip, &definition_part);

    zip.set(&table_part, pivot_table_xml(name, cache_id, &layout, destination)?);
    ensure_content_type_override(zip, &format!("/{table_part}"), PIVOT_TABLE_CONTENT_TYPE);
    add_package_relationship(
        zip,
        &part_relationship_path(&table_part),
        &format!("{RELATIONSHIP_BASE}/pivotCacheDefinition"),
        &posix::relative(&posix::dirname(&table_part), &definition_part),
        "",
    );
    add_package_relationship(
        zip,
        &part_relationship_path(destination_sheet_path),
        &format!("{RELATIONSHIP_BASE}/pivotTable"),
        &posix::relative(&posix::dirname(destination_sheet_path), &table_part),
        "",
    );

    let grid = pivot_grid(&layout, records);
    write_pivot_grid(zip, destination_sheet_path, destination, &grid)?;

    Ok(PivotWritten { definition_part, records_part, table_part, cache_id, rows: grid.len(), columns: grid.iter().map(Vec::len).max().unwrap_or(0) })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn base() -> Package {
        let mut zip = Package::new();
        zip.set("[Content_Types].xml", "<Types></Types>");
        zip.set("xl/workbook.xml", "<workbook><sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
        zip.set("xl/_rels/workbook.xml.rels", "<Relationships></Relationships>");
        zip.set("xl/worksheets/sheet1.xml", "<worksheet><sheetData></sheetData></worksheet>");
        zip
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|text| (*text).to_owned()).collect()
    }

    #[allow(clippy::too_many_arguments, reason = "one pivot probe's own facts")]
    fn write(zip: &mut Package, fields: &[PivotField], records: &[Vec<Value>], source_ref: &str, row: i64, column: i64, values: &[usize]) -> PivotWritten {
        let layout = PivotLayout { fields, row_field: row, column_field: column, value_fields: values };
        let request = PivotRequest {
            layout,
            records,
            source_sheet: "Sheet1",
            source_ref,
            destination_sheet_path: "xl/worksheets/sheet1.xml",
            destination: "E1",
            name: "Probe",
        };
        write_pivot_table(zip, &request).expect("a pivot table")
    }

    #[test]
    fn pivot_cache_records_index_each_text_value_by_its_position_in_the_shared_items() {
        let mut zip = base();
        let records = vec![
            vec![json!("North"), json!("Web"), json!(10)],
            vec![json!("South"), json!("Store"), json!(20)],
            vec![json!("North"), json!("Store"), json!(5)],
            vec![json!("East"), json!("Web"), json!(7)],
            vec![Value::Null, json!("Web"), json!(1)],
        ];
        let fields = summarize_pivot_fields(&strings(&["Region", "Channel", "Sales"]), &records, &[]);
        let written = write(&mut zip, &fields, &records, "A1:C6", 0, -1, &[2]);
        let xml = zip.text(&written.records_part);
        // Shared items keep first-seen order: Region North, South, East, ''; Channel Web, Store.
        for row in [
            "<r><x v=\"0\"/><x v=\"0\"/><n v=\"10\"/></r>",
            "<r><x v=\"1\"/><x v=\"1\"/><n v=\"20\"/></r>",
            "<r><x v=\"0\"/><x v=\"1\"/><n v=\"5\"/></r>",
            "<r><x v=\"2\"/><x v=\"0\"/><n v=\"7\"/></r>",
            "<r><x v=\"3\"/><x v=\"0\"/><n v=\"1\"/></r>",
        ] {
            assert!(xml.contains(row), "{row} in {xml}");
        }
        assert!(zip.text(&written.definition_part).contains("<worksheetSource ref=\"A1:C6\" sheet=\"Sheet1\"/>"));
        assert_eq!((written.cache_id, written.rows, written.columns), (1, 6, 2));
        assert!(zip.text("xl/workbook.xml").contains("</sheets><pivotCaches><pivotCache cacheId=\"1\" r:id=\"rId1\"/></pivotCaches>"));
    }

    #[test]
    fn a_numeric_field_across_the_top_lays_out_one_column_per_value() {
        let mut zip = base();
        let records = vec![
            vec![json!("Channel Partners"), json!(2014), json!(1026913.86)],
            vec![json!("Government"), json!(2013), json!(2886645.28)],
            vec![json!("Channel Partners"), json!(2013), json!(289889.28)],
            vec![json!("Government"), json!(2014), json!(8501527.89)],
        ];
        let fields = summarize_pivot_fields(&strings(&["Segment", "Year", "Profit"]), &records, &[0, 1]);
        let written = write(&mut zip, &fields, &records, "A1:C5", 0, 1, &[2]);
        let sheet = zip.text("xl/worksheets/sheet1.xml");
        // Heading row, then the years as numbers in order, then the grand total.
        assert!(sheet.contains("<c r=\"F2\"><v>2013</v></c><c r=\"G2\"><v>2014</v></c>"), "{sheet}");
        assert!(sheet.contains("<c r=\"H2\" t=\"inlineStr\"><is><t>Grand Total</t></is></c>"), "{sheet}");
        assert!(zip.text(&written.definition_part).contains(
            "<cacheField name=\"Year\" numFmtId=\"0\"><sharedItems containsSemiMixedTypes=\"0\" containsString=\"0\" containsNumber=\"1\" containsInteger=\"1\" minValue=\"2013\" maxValue=\"2014\" count=\"2\"><n v=\"2014\"/><n v=\"2013\"/></sharedItems>"
        ));
        let table = zip.text(&written.table_part);
        assert!(table.contains("colHeaderCaption=\"Year\""), "{table}");
        assert!(table.contains("rowHeaderCaption=\"Segment\""), "{table}");
        assert!(table.contains("<location ref=\"E1:H5\" firstHeaderRow=\"1\" firstDataRow=\"2\" firstDataCol=\"1\"/>"), "{table}");
        assert_eq!((written.rows, written.columns), (5, 4));
    }

    #[test]
    fn a_pivot_over_korean_fields_prints_its_captions_in_korean() {
        let mut zip = base();
        let records = vec![vec![json!("수도권"), json!(100)], vec![json!("부산"), json!(200)]];
        let fields = summarize_pivot_fields(&strings(&["권역", "매출"]), &records, &[0]);
        let written = write(&mut zip, &fields, &records, "A1:B3", 0, -1, &[1]);
        let sheet = zip.text("xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<t>합계 : 매출</t>") && sheet.contains("<t>총합계</t>"), "{sheet}");
        assert!(zip.text(&written.table_part).contains("grandTotalCaption=\"총합계\""));
    }

    #[test]
    fn fields_are_numeric_only_when_every_value_is_a_finite_number() {
        let records = vec![vec![json!(1), json!("a"), json!("3")], vec![json!(2.5), json!("b"), json!(4)], vec![json!(3), json!("a"), json!(5)]];
        let fields = summarize_pivot_fields(&strings(&["n", "t", "s"]), &records, &[0]);
        assert_eq!(fields[0].items, strings(&["1", "2.5", "3"]));
        assert!(fields[0].numeric_items && !fields[0].numeric && !fields[0].integer);
        assert_eq!(fields[1].items, strings(&["a", "b"]));
        assert!(!fields[1].numeric && !fields[1].numeric_items);
        assert!(fields[2].numeric && fields[2].integer && fields[2].items.is_empty());
        assert_eq!((fields[2].min, fields[2].max), (3.0, 5.0));
        let blanks = summarize_pivot_fields(&strings(&["x"]), &[vec![json!(1)], vec![json!("")]], &[]);
        assert!(!blanks[0].numeric);
        assert_eq!(blanks[0].items, strings(&["1", ""]));
    }
}
