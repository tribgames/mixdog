//! `portable/portable-xlsx-charts.mjs`: the add_chart operation (the block of the sheet a chart reads, the categories and series
//! it projects out of that block, the sheet references the chart part cites, and the graphic frame the drawing anchors) and the
//! refresh of the copy of its cells every chart part carries once the workbook has been calculated.

use std::sync::LazyLock;

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, js_to_lowercase, js_trim, json_number, math, number_to_string, string_to_number, to_number, value_to_string};
use mixdog_office_base::a1::{column_label, column_number, parse_cell_ref};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

use crate::cells::{CellValue, Sheet, workbook_sheets};
use crate::chart::{CategoryDates, ChartReferences, ChartSpec, DEFAULT_SERIES_COLORS, chart_xml};
use crate::opc::{CHART_CONTENT_TYPE, add_package_relationship, ensure_content_type_override, part_relationship_path, posix};
use crate::sheet_page::{fit_drawing_sheet_one_page_wide, workbook_digit_width, worksheet_geometry};
use crate::sheet_parts::ensure_worksheet_drawing;
use crate::sheet_xml::{Area, parse_area_range, quote_sheet_name, sheet_qualified_areas};
use crate::text_metrics::TextMeasurer;
use crate::xlsx_cell_values::{SheetCellLabels, SheetCellValues};
use crate::xlsx_drawings::{FramePlacement, count_drawing_anchors, frame_anchor_xml};
use crate::xml::{OFFICE_RELATIONSHIP_BASE, xml_decode, xml_encode};
use crate::zipio::Package;

static REFERENCE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"<c:(num|str)Ref>\s*(<c:f>([^<]*)<\/c:f>)\s*<c:\1Cache>([\s\S]*?)<\/c:\1Cache>\s*<\/c:\1Ref>", "g"));
static CHART_PART: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^xl\/charts\/chart\d+\.xml$", "i"));
static BOUNDED_CELLS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Z]+\d+(?::[A-Z]+\d+)?$", "i"));
static FORMAT_CODE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<c:formatCode>[\s\S]*?<\/c:formatCode>", ""));
static FIRST_FONT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<font\b[^>]*>[\s\S]*?<\/font>", ""));
static FONT_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"<name\s+val="([^"]*)""#, ""));

/// The bar the chart is about takes the series colour and the rest recede, as the Word and PDF charts draw it.
const HIGHLIGHT_MUTED: &str = "C9CED6";

/// `String(value ?? '')` of an operation field.
fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// `String(cell ?? '')`.
fn cell_text(value: Option<&CellValue>) -> String {
    match value {
        None => String::new(),
        Some(CellValue::Text(text)) => text.clone(),
        Some(CellValue::Number(number)) => number_to_string(*number),
        Some(CellValue::Bool(flag)) => flag.to_string(),
    }
}

/// `Number(cell)`: a missing cell (null in Node) and an empty text are 0.
fn cell_number(value: Option<&CellValue>) -> f64 {
    match value {
        None => 0.0,
        Some(CellValue::Text(text)) => string_to_number(text),
        Some(CellValue::Number(number)) => *number,
        Some(CellValue::Bool(flag)) => f64::from(u8::from(*flag)),
    }
}

/// A number as the series list carries it: a finite one as a JSON number, NaN and the infinities as the text the chart part reads
/// back as the same non-finite number (JSON has no spelling for them, and null would read as 0).
fn series_number(number: f64) -> Value {
    if number.is_finite() { json_number(number) } else { Value::String(number_to_string(number)) }
}

/// The block a chart reads.
struct DataBlock {
    plot_by_rows: bool,
    area: Area,
    lanes: Vec<f64>,
    source_sheet: String,
}

/// One bounded area, or several joined by commas the way Excel's own Range("A7:A12,D7:D12") reads them: the first column of the
/// first area holds the categories, every other column of every area is a series, so a chart can skip the columns between its
/// category and its value. `plotBy:'rows'` reads the same block turned a quarter.
fn chart_data_block(op: &Value) -> Result<DataBlock, String> {
    let plot_by_rows = js_to_lowercase(&match op.get("plotBy") {
        None | Some(Value::Null) => "columns".to_owned(),
        Some(value) => value_to_string(value),
    }) == "rows";
    let sourced = sheet_qualified_areas(&text_of(op.get("range")));
    let areas = sourced.iter().map(|entry| parse_area_range(&entry.area)).collect::<Result<Vec<Area>, String>>()?;
    let area = areas[0];
    let mut series_columns = Vec::new();
    for (index, entry) in areas.iter().enumerate() {
        let from = if index == 0 { entry.start_col + 1.0 } else { entry.start_col };
        let count = math::max(0.0, entry.end_col - from + 1.0) as usize;
        series_columns.extend((0..count).map(|offset| from + offset as f64));
    }
    let row_count = math::max(0.0, area.end_row - area.start_row) as usize;
    let series_rows: Vec<f64> = (0..row_count).map(|offset| area.start_row + 1.0 + offset as f64).collect();
    let whole_block = if plot_by_rows {
        areas.len() == 1 && area.end_col > area.start_col
    } else {
        areas.iter().all(|entry| entry.start_row != 0.0 && entry.start_col != 0.0 && entry.start_row == area.start_row && entry.end_row == area.end_row)
    };
    let lanes = if plot_by_rows { series_rows } else { series_columns };
    if area.start_row == 0.0 || area.start_col == 0.0 || lanes.is_empty() || !whole_block {
        return Err(if plot_by_rows {
            "add_chart plotBy:'rows' requires one bounded range whose first row holds the categories and whose first column names each series".to_owned()
        } else {
            "add_chart requires a bounded range whose first column holds categories (comma-joined areas must share the same rows)".to_owned()
        });
    }
    Ok(DataBlock { plot_by_rows, area, lanes, source_sheet: sourced[0].sheet.clone() })
}

/// The sheet the source names, or the one the chart stands on; a summary sheet charts the calculation behind it.
fn chart_source_sheet<'a>(zip: &Package, sheet: &'a Sheet, xml: &str, sheets: &'a [Sheet], name: &str) -> Result<(&'a Sheet, String), String> {
    if name.is_empty() || js_to_lowercase(name) == js_to_lowercase(&sheet.name) {
        return Ok((sheet, xml.to_owned()));
    }
    let Some(source) = sheets.iter().find(|entry| js_to_lowercase(&entry.name) == js_to_lowercase(name)) else {
        let known: Vec<String> = sheets.iter().map(|entry| format!("\"{}\"", entry.name)).collect();
        return Err(format!("XLSX add_chart reads sheet \"{name}\", which the workbook does not hold; it has {}", known.join(", ")));
    };
    Ok((source, zip.text(&source.path)))
}

/// The numbers of one lane: its row (plotted by rows) or its column.
fn lane_values(cells: &SheetCellValues, area: &Area, plot_by_rows: bool, lane: f64) -> Vec<Value> {
    let mut numbers = Vec::new();
    if plot_by_rows {
        let mut column = area.start_col + 1.0;
        while column <= area.end_col {
            numbers.push(series_number(cell_number(cells.value(column, lane).as_ref())));
            column += 1.0;
        }
    } else {
        let mut row = area.start_row + 1.0;
        while row <= area.end_row {
            numbers.push(series_number(cell_number(cells.value(lane, row).as_ref())));
            row += 1.0;
        }
    }
    numbers
}

/// The dated categories of a column in one format: their serials and that format.
struct DatedCategories {
    values: Vec<Value>,
    format: String,
}

/// Categories, series values and the sheet references the chart part cites.
struct ChartData {
    categories: Vec<String>,
    category_dates: Option<DatedCategories>,
    series: Vec<Value>,
    sheet_reference: String,
    category: String,
    names: Vec<String>,
    values: Vec<String>,
}

fn category_labels(labels: &SheetCellLabels, area: &Area, plot_by_rows: bool) -> Result<Vec<String>, String> {
    let mut categories = Vec::new();
    if plot_by_rows {
        let mut column = area.start_col + 1.0;
        while column <= area.end_col {
            categories.push(cell_text(labels.label(column, area.start_row)?.as_ref()));
            column += 1.0;
        }
    } else {
        let mut row = area.start_row + 1.0;
        while row <= area.end_row {
            categories.push(cell_text(labels.label(area.start_col, row)?.as_ref()));
            row += 1.0;
        }
    }
    Ok(categories)
}

/// A column of dated categories in one format is written as dates in that format.
fn dated_categories(labels: &SheetCellLabels, area: &Area) -> Result<Option<DatedCategories>, String> {
    let mut dates = Vec::new();
    let mut row = area.start_row + 1.0;
    while row <= area.end_row {
        dates.push(labels.dated(area.start_col, row)?);
        row += 1.0;
    }
    if let Some(Some(first)) = dates.first()
        && dates.iter().all(|date| date.as_ref().is_some_and(|date| date.format == first.format))
    {
        return Ok(Some(DatedCategories { values: dates.iter().flatten().map(|date| json_number(date.serial)).collect(), format: first.format.clone() }));
    }
    Ok(None)
}

/// The sheet references one series cites: its name cell and its value cells.
fn series_references(sheet_reference: &str, area: &Area, plot_by_rows: bool, lane: f64) -> (String, String) {
    if plot_by_rows {
        (
            format!("{sheet_reference}!${}${}", column_label(area.start_col), number_to_string(lane)),
            format!(
                "{sheet_reference}!${}${}:${}${}",
                column_label(area.start_col + 1.0),
                number_to_string(lane),
                column_label(area.end_col),
                number_to_string(lane)
            ),
        )
    } else {
        let label = column_label(lane);
        (
            format!("{sheet_reference}!${label}${}", number_to_string(area.start_row)),
            format!("{sheet_reference}!${label}${}:${label}${}", number_to_string(area.start_row + 1.0), number_to_string(area.end_row)),
        )
    }
}

fn category_reference(sheet_reference: &str, area: &Area, plot_by_rows: bool) -> String {
    if plot_by_rows {
        format!(
            "{sheet_reference}!${}${}:${}${}",
            column_label(area.start_col + 1.0),
            number_to_string(area.start_row),
            column_label(area.end_col),
            number_to_string(area.start_row)
        )
    } else {
        let label = column_label(area.start_col);
        format!("{sheet_reference}!${label}${}:${label}${}", number_to_string(area.start_row + 1.0), number_to_string(area.end_row))
    }
}

fn read_chart_data(zip: &Package, xml: &str, sheet: &Sheet, op: &Value, block: &DataBlock) -> Result<ChartData, String> {
    let area = &block.area;
    let plot_by_rows = block.plot_by_rows;
    let cells = SheetCellValues::new(zip, xml);
    let labels = SheetCellLabels::new(zip, xml);
    let categories = category_labels(&labels, area, plot_by_rows)?;
    let category_dates = if plot_by_rows { None } else { dated_categories(&labels, area)? };
    let palette: &[Value] = op.get("seriesColors").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let slices = matches!(js_to_lowercase(&text_of(op.get("chartType"))).as_str(), "pie" | "doughnut" | "donut");
    let point_colors = slices && !palette.is_empty();
    let sheet_reference = quote_sheet_name(&sheet.name);
    let (mut series, mut names, mut values) = (Vec::new(), Vec::new(), Vec::new());
    for (index, &lane) in block.lanes.iter().enumerate() {
        let named = if plot_by_rows { cells.value(area.start_col, lane) } else { cells.value(lane, area.start_row) };
        let mut entry = Map::new();
        entry.insert(
            "name".to_owned(),
            Value::String(match named {
                Some(named) => cell_text(Some(&named)),
                None => format!("Series {}", index + 1),
            }),
        );
        entry.insert("values".to_owned(), Value::Array(lane_values(&cells, area, plot_by_rows, lane)));
        if !palette.is_empty() {
            entry.insert("color".to_owned(), palette[index % palette.len()].clone());
        }
        if point_colors {
            entry.insert("pointColors".to_owned(), Value::Array((0..categories.len()).map(|point| palette[point % palette.len()].clone()).collect()));
        }
        series.push(Value::Object(entry));
        let (name, lane_range) = series_references(&sheet_reference, area, plot_by_rows, lane);
        names.push(name);
        values.push(lane_range);
    }
    let category = category_reference(&sheet_reference, area, plot_by_rows);
    Ok(ChartData { categories, category_dates, series, sheet_reference, category, names, values })
}
/// What one sheet's cells show: the values a number cache takes and the labels a text cache takes.
struct SheetReader {
    path: String,
    numbers: SheetCellValues,
    labels: SheetCellLabels,
}

/// The cells a chart reference reads, in order; `None` for one that names no sheet here or no bounded block of cells.
fn referenced_cells(
    zip: &Package,
    sheets: &[Sheet],
    readers: &mut Vec<SheetReader>,
    formula: &str,
    numbers: bool,
) -> Result<Option<Vec<Option<CellValue>>>, String> {
    let mut cells = Vec::new();
    for entry in sheet_qualified_areas(&xml_decode(formula)) {
        let sheet =
            if entry.sheet.is_empty() { None } else { sheets.iter().find(|candidate| js_to_lowercase(&candidate.name) == js_to_lowercase(&entry.sheet)) };
        let bounds = if BOUNDED_CELLS.is_match(&entry.area) { Some(parse_area_range(&entry.area)?) } else { None };
        let (Some(sheet), Some(bounds)) = (sheet, bounds) else { return Ok(None) };
        let at = match readers.iter().position(|reader| reader.path == sheet.path) {
            Some(at) => at,
            None => {
                let sheet_xml = zip.text(&sheet.path);
                readers.push(SheetReader {
                    path: sheet.path.clone(),
                    numbers: SheetCellValues::new(zip, &sheet_xml),
                    labels: SheetCellLabels::new(zip, &sheet_xml),
                });
                readers.len() - 1
            }
        };
        let mut row = bounds.start_row;
        while row <= bounds.end_row {
            let mut column = bounds.start_col;
            while column <= bounds.end_col {
                cells.push(if numbers { readers[at].numbers.value(column, row) } else { readers[at].labels.label(column, row)? });
                column += 1.0;
            }
            row += 1.0;
        }
    }
    Ok(Some(cells))
}

/// A chart part carries a copy of the cells it reads, and a viewer that draws from the copy (a mail or phone preview) shows the
/// chart as it was written: a column of formulas written before it had values stood there as zeros. Once the workbook is
/// calculated each copy is taken again from its cells.
pub fn refresh_chart_caches(zip: &mut Package) -> Result<(), String> {
    let sheets = workbook_sheets(zip);
    let mut readers: Vec<SheetReader> = Vec::new();
    for name in zip.files_matching(&CHART_PART) {
        let xml = zip.text(&name);
        let mut next = String::new();
        let mut last = 0_usize;
        for found in REFERENCE.captures_iter(&xml) {
            let kind = found.get(1).unwrap_or("");
            let Some(cells) = referenced_cells(zip, &sheets, &mut readers, found.get(3).unwrap_or(""), kind == "num")? else { continue };
            let cache = found.get(4).unwrap_or("");
            let format_code = if kind == "num" { FORMAT_CODE.find(cache).map_or("", |range| &cache[range]) } else { "" };
            let mut points = String::new();
            for (index, value) in cells.iter().enumerate() {
                if kind == "str" {
                    points.push_str(&format!("<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>", xml_encode(&cell_text(value.as_ref()))));
                    continue;
                }
                let number = match value {
                    None => f64::NAN,
                    Some(CellValue::Text(text)) if text.is_empty() => f64::NAN,
                    other => cell_number(other.as_ref()),
                };
                if number.is_finite() {
                    points.push_str(&format!("<c:pt idx=\"{index}\"><c:v>{}</c:v></c:pt>", number_to_string(number)));
                }
            }
            let range = found.range();
            next.push_str(&xml[last..range.start]);
            next.push_str(&format!(
                "<c:{kind}Ref>{}<c:{kind}Cache>{format_code}<c:ptCount val=\"{}\"/>{points}</c:{kind}Cache></c:{kind}Ref>",
                found.get(2).unwrap_or(""),
                cells.len()
            ));
            last = range.end;
        }
        if last != 0 {
            let refreshed = format!("{next}{}", &xml[last..]);
            if refreshed != xml {
                zip.set(&name, refreshed);
            }
        }
    }
    Ok(())
}

fn next_chart_part(zip: &Package) -> String {
    let mut ordinal = 1_u64;
    while zip.file(&format!("xl/charts/chart{ordinal}.xml")).is_some() {
        ordinal += 1;
    }
    format!("xl/charts/chart{ordinal}.xml")
}

/// A frame placed at cell and ended at toColumn takes the width of the columns it spans, as the sheet has them now.
fn spanned_width(xml: &str, op: &Value, digit_width: f64) -> Result<Option<f64>, String> {
    let Some(to_column) = op.get("toColumn").filter(|value| truthy(value)) else { return Ok(None) };
    let Some(cell) = op.get("cell").filter(|value| truthy(value)) else {
        return Err("XLSX add_chart toColumn ends a frame placed at cell; give cell as well".to_owned());
    };
    let first = column_number(&parse_cell_ref(&value_to_string(cell))?.col);
    let last = column_number(&js_trim(&value_to_string(to_column)).to_uppercase());
    if !(last >= first) {
        return Err(format!("XLSX add_chart toColumn {} lies left of {}", value_to_string(to_column), value_to_string(cell)));
    }
    let geometry = worksheet_geometry(xml, digit_width);
    let mut width = 0.0;
    let mut column = first;
    while column <= last {
        width += geometry.column_points(column);
        column += 1.0;
    }
    Ok(Some(width))
}

/// The graphic frame a chart hangs in. Without a cell or a point position the frame keeps its old default spot beside A1.
fn chart_frame_anchor(op: &Value, width: Option<&Value>, anchor_count: usize, chart_relationship_id: &str) -> Result<String, String> {
    let placed = op.get("cell").is_some_and(truthy) || op.get("left").is_some() || op.get("top").is_some();
    let (default_left, default_top) = (Value::from(300), Value::from(20));
    let size = |value: Option<&Value>, default: f64| value.filter(|value| !value.is_null()).map_or(default, to_number);
    let frame = format!(
        "<xdr:graphicFrame macro=\"\"><xdr:nvGraphicFramePr><xdr:cNvPr id=\"{}\" name=\"Chart {}\"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>\
         <xdr:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></xdr:xfrm>\
         <a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/chart\">\
         <c:chart xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\" r:id=\"{chart_relationship_id}\"/>\
         </a:graphicData></a:graphic></xdr:graphicFrame>",
        anchor_count + 2,
        anchor_count + 1
    );
    frame_anchor_xml(
        &FramePlacement {
            cell: op.get("cell"),
            left: if placed { op.get("left") } else { Some(&default_left) },
            top: if placed { op.get("top") } else { Some(&default_top) },
            width: size(width, 480.0),
            height: size(op.get("height"), 280.0),
        },
        &frame,
    )
}

/// The bar the chart is about (highlight: a 0-based index or a category's text); -1 for none.
fn chart_highlight_index(highlight: Option<&Value>, categories: &[String]) -> f64 {
    match highlight {
        None | Some(Value::Null) => -1.0,
        Some(Value::String(text)) if text.is_empty() => -1.0,
        Some(Value::Number(number)) => {
            let index = number.as_f64().unwrap_or(f64::NAN);
            if index.is_finite() && index.fract() == 0.0 && index < categories.len() as f64 { index } else { -1.0 }
        }
        Some(wanted) => {
            let wanted = value_to_string(wanted);
            categories.iter().position(|category| *category == wanted).map_or(-1.0, |at| at as f64)
        }
    }
}

/// The workbook's own face: the first font, the one the Normal style and every unstyled cell use.
fn workbook_font_name(zip: &Package) -> String {
    let styles = zip.text("xl/styles.xml");
    let first = FIRST_FONT.find(&styles).map_or("", |range| &styles[range]);
    xml_decode(FONT_NAME.captures(first).and_then(|found| found.get(1).map(str::to_owned)).as_deref().unwrap_or(""))
}

fn highlight_single_series(op: &Value, categories: &[String], series: &mut [Value]) {
    let lit = chart_highlight_index(op.get("highlight"), categories);
    if lit < 0.0 || series.len() != 1 {
        return;
    }
    let accent = series[0].get("color").filter(|color| truthy(color)).cloned().unwrap_or_else(|| Value::from(DEFAULT_SERIES_COLORS[0]));
    let muted = op.get("mutedColor").filter(|color| truthy(color)).cloned().unwrap_or_else(|| Value::from(HIGHLIGHT_MUTED));
    let colors: Vec<Value> = (0..categories.len()).map(|point| if point as f64 == lit { accent.clone() } else { muted.clone() }).collect();
    if let Value::Object(entry) = &mut series[0] {
        entry.insert("pointColors".to_owned(), Value::Array(colors));
    }
}

/// `addWorksheetChart(zip, sheet, xml, op, sheets)`: a chart part, its drawing anchor, and the series read out of the sheet.
pub fn add_worksheet_chart<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    zip: &mut Package,
    sheet: &Sheet,
    xml: &str,
    op: &Value,
    sheets: &[Sheet],
) -> Result<Value, String> {
    let block = chart_data_block(op)?;
    let (source_sheet, source_xml) = chart_source_sheet(zip, sheet, xml, sheets, &block.source_sheet)?;
    let ChartData { categories, category_dates, mut series, sheet_reference, category, names, values } =
        read_chart_data(zip, &source_xml, source_sheet, op, &block)?;
    highlight_single_series(op, &categories, &mut series);
    let chart_part = next_chart_part(zip);
    let category_values: Vec<Value> = categories.iter().cloned().map(Value::String).collect();
    let dates = category_dates.as_ref().map(|dates| CategoryDates { values: &dates.values, format: &dates.format });
    let flag = |name: &str| op.get(name).and_then(Value::as_bool);
    // The quiet plot a labelled chart wants: no gridlines, no value axis, when asked.
    let mut axis = Map::new();
    axis.insert("gridlines".to_owned(), Value::Bool(flag("gridlines") != Some(false)));
    axis.insert("hideValueAxis".to_owned(), Value::Bool(flag("valueAxis") == Some(false)));
    let axis = Value::Object(axis);
    let font = match op.get("fontName").filter(|value| truthy(value)) {
        Some(font) => value_to_string(font),
        None => workbook_font_name(zip),
    };
    let chart = chart_xml(&ChartSpec {
        chart_type: &text_of(op.get("chartType")),
        title: &text_of(op.get("title")),
        categories: &category_values,
        category_dates: dates,
        series: &series,
        references: Some(ChartReferences { sheet: &sheet_reference, category: &category, names: &names, values: &values }),
        show_values: flag("showValues") == Some(true),
        data_label_position: &text_of(op.get("dataLabelPosition")),
        data_label_color: &text_of(op.get("dataLabelColor")),
        value_number_format: &text_of(op.get("valueNumberFormat")),
        show_legend: match op.get("showLegend") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(shown)) => Some(*shown),
            Some(_) => Some(true),
        },
        zero_baseline: match op.get("zeroBaseline") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_bool() == Some(true)),
        },
        axis: Some(&axis),
        font: &font,
        ..ChartSpec::default()
    })?;
    zip.set(&chart_part, chart);
    ensure_content_type_override(zip, &format!("/{chart_part}"), CHART_CONTENT_TYPE);
    let drawing = ensure_worksheet_drawing(zip, sheet, xml);
    let drawing_part = drawing.part;
    let chart_fit = fit_drawing_sheet_one_page_wide(&drawing.worksheet);
    let xml = chart_fit.xml;
    zip.set(&sheet.path, xml.as_str());
    let chart_relationship_id = add_package_relationship(
        zip,
        &part_relationship_path(&drawing_part),
        &format!("{OFFICE_RELATIONSHIP_BASE}/chart"),
        &posix::relative(&posix::dirname(&drawing_part), &chart_part),
        "",
    );
    let drawing_xml = zip.text(&drawing_part);
    let anchor_count = count_drawing_anchors(&drawing_xml);
    let digit_width = workbook_digit_width(measurer, zip)?;
    let spanned = spanned_width(&xml, op, digit_width)?.map(Value::from);
    let anchor = chart_frame_anchor(op, spanned.as_ref().or_else(|| op.get("width")), anchor_count, &chart_relationship_id)?;
    zip.set(&drawing_part, drawing_xml.replacen("</xdr:wsDr>", &format!("{anchor}</xdr:wsDr>"), 1));
    let mut report = Map::new();
    if let Some(op_name) = op.get("op") {
        report.insert("op".to_owned(), op_name.clone());
    }
    report.insert("changed".to_owned(), Value::Bool(true));
    report.insert("sheet".to_owned(), Value::String(sheet.name.clone()));
    report.insert("chart".to_owned(), Value::String(chart_part));
    report.insert("series".to_owned(), Value::from(series.len()));
    if chart_fit.applied {
        report.insert("pageFit".to_owned(), Value::from("one-page-wide"));
    }
    Ok(Value::Object(report))
}
