//! `portable/portable-sheet-page.mjs`: what a worksheet looks like on paper and on the page grid: the width of a column in
//! the workbook's default font, the geometry of rows and columns that places a chart or a picture on cells, the print area
//! a sheet's content takes, fit-to-page, and `set_page_setup` (orientation, margins, centring, print area, repeated header
//! rows).
//!
//! Widths come from a [`TextMeasurer`] (Node asked the canvas); every function that measures takes the one the caller holds
//! and fails with the reason a face could not be measured.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, js_to_lowercase, js_trim, math, number_to_string, string_to_number, to_number, to_number_of, value_to_string};
use mixdog_office_base::a1::{column_label, column_number, parse_cell_ref};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::cells::{CellValue, Sheet, cell_records, shared_strings};
use crate::opc::{part_relationship_path, posix};
use crate::sheet_xml::{
    absolute_range, area_reference, merged_ranges, parse_area_range, quote_sheet_name, upsert_defined_name, upsert_worksheet_section,
    worksheet_section,
};
use crate::text_metrics::{FontSpec, TextMeasurer};
use crate::xml::{compiled, xml_attribute, xml_encode};
use crate::zipio::Package;

macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

static FIRST_FONT: LazyLock<JsRegex> = regex!(r"<fonts\b[^>]*>\s*<font\b[^>]*>([\s\S]*?)<\/font>", "");
static FONT_NAME: LazyLock<JsRegex> = regex!(r#"<name\b[^>]*\bval="([^"]+)""#, "");
static FONT_SIZE: LazyLock<JsRegex> = regex!(r#"<sz\b[^>]*\bval="([\d.]+)""#, "");
static SHEET_FORMAT: LazyLock<JsRegex> = regex!(r"<sheetFormatPr\b([^>]*?)\/?>", "");
static COLUMN_ELEMENT: LazyLock<JsRegex> = regex!(r"<col\b([^>]*?)\/>", "g");
static ROW_ELEMENT: LazyLock<JsRegex> = regex!(r"<row\b([^>]*?)(?:\/>|>)", "g");
static RELATIONSHIP: LazyLock<JsRegex> = regex!(r"<Relationship\b([^>]*?)\/>", "g");
static ANCHOR: LazyLock<JsRegex> = regex!(r"<xdr:(absoluteAnchor|oneCellAnchor|twoCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>", "g");
static EXTENT: LazyLock<JsRegex> = regex!(r"<xdr:ext\b([^>]*?)\/>", "");
static POSITION: LazyLock<JsRegex> = regex!(r"<xdr:pos\b([^>]*?)\/>", "");
static FIT_TO_PAGE_ON: LazyLock<JsRegex> = regex!(r#"<pageSetUpPr\b[^>]*\bfitToPage="(?:1|true)""#, "");
static SCALE_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bscale=""#, "");
static SHEET_PR_OPEN: LazyLock<JsRegex> = regex!(r"^<sheetPr\b([^>]*?)(?:\/>|>)", "");
static PAGE_SET_UP_PR: LazyLock<JsRegex> = regex!(r"<pageSetUpPr\b[^>]*?\/>", "");
static PAGE_SETUP_OPEN: LazyLock<JsRegex> = regex!(r"^<pageSetup\b([^>]*?)\/?>", "");
static FIT_TO_ATTRIBUTES: LazyLock<JsRegex> = regex!(r#"\s+fitTo(?:Width|Height)="[^"]*""#, "g");

/// Excel counts a column's width in the widest digit of the workbook's default font (the first font, the one the Normal
/// style sets) at 96 dpi in whole pixels: 7 for Calibri 11, 8 for 맑은 고딕 11.
pub fn maximum_digit_width<P: ReadProof>(measurer: &TextMeasurer<'_, P>, styles_xml: &str) -> Result<f64, String> {
    let font = FIRST_FONT.captures(styles_xml).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
    let font_name = FONT_NAME.captures(&font).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_else(|| "Calibri".to_owned());
    let declared = FONT_SIZE.captures(&font).and_then(|found| found.get(1).map(string_to_number)).unwrap_or(f64::NAN);
    let font_size = if declared.is_nan() || declared == 0.0 { 11.0 } else { declared };
    let spec = FontSpec { font_name: Some(font_name), font_size: Some(font_size), bold: false, italic: false };
    let mut widest = f64::NEG_INFINITY;
    for digit in "0123456789".chars() {
        let width = measurer.measure_text_width(&digit.to_string(), &spec).map_err(|error| error.to_string())?;
        widest = math::max(widest, width);
    }
    Ok(math::max(1.0, math::round((widest * 96.0) / 72.0)))
}

/// `workbookDigitWidth(zip)`.
pub fn workbook_digit_width<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package) -> Result<f64, String> {
    maximum_digit_width(measurer, &zip.text("xl/styles.xml"))
}

/// The characters a text takes across a column: its width in the cell's own face, size and weight, counted in the default
/// font's digits. Counted as two for a Hangul letter and one for anything else, and a fifth more when bold: a bold 10 pt
/// "기간 (일)" read as ten characters where Excel prints it in eight, and its column was reported cut. `style` is the
/// cell's style (`fontName`, `fontSize`, `bold`, `italic`).
pub fn text_characters<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    text: &Value,
    style: Option<&Value>,
    digit_width: f64,
) -> Result<f64, String> {
    let field = |name: &str| style.and_then(|style| style.get(name));
    let font_name = field("fontName").filter(|name| truthy(name)).map_or_else(|| "Calibri".to_owned(), value_to_string);
    let size = field("fontSize").map_or(f64::NAN, to_number);
    let spec = FontSpec {
        font_name: Some(font_name),
        font_size: Some(if size.is_nan() || size == 0.0 { 11.0 } else { size }),
        bold: field("bold") == Some(&Value::Bool(true)),
        italic: field("italic") == Some(&Value::Bool(true)),
    };
    let content = if text.is_null() { String::new() } else { value_to_string(text) };
    let points = measurer.measure_text_width(&content, &spec).map_err(|error| error.to_string())?;
    Ok((points * 96.0) / 72.0 / digit_width)
}

/// A width in characters (what set_column_width and Excel's Column Width box take) as the file stores it: the characters in
/// whole pixels plus the 5 pixels Excel pads a cell with, in 1/256 steps. Stored bare, a column set to 9 opened 5 pixels
/// narrower in Excel (8.29) than the same call made through Excel, which stores 9.625 in 맑은 고딕.
pub fn column_file_width(characters: f64, digit_width: f64) -> f64 {
    if !(characters > 0.0) {
        return 0.0;
    }
    (((math::round(characters * digit_width) + 5.0) / digit_width) * 256.0).trunc() / 256.0
}

/// The pixels a stored column width spans, as Excel lays the column out.
pub fn column_pixels(file_width: f64, digit_width: f64) -> f64 {
    (((256.0 * file_width + (128.0 / digit_width).trunc()) / 256.0) * digit_width).trunc()
}

/// A run of columns that declares its own width.
#[derive(Debug, Clone, Copy)]
struct ColumnSpan {
    start: f64,
    end: f64,
    pixels: f64,
}

/// `worksheetGeometry(xml, digitWidth)`: OOXML stores row heights in points and column widths in the default font's digits,
/// padding included. The persisted dimensions are used, including hidden ranges, rather than a uniform grid.
#[derive(Debug, Clone)]
pub struct WorksheetGeometry {
    default_row: f64,
    default_pixels: f64,
    columns: Vec<ColumnSpan>,
    rows: HashMap<u64, f64>,
}

/// `worksheetGeometry(xml, digitWidth)`.
pub fn worksheet_geometry(xml: &str, digit_width: f64) -> WorksheetGeometry {
    let format = SHEET_FORMAT.captures(xml).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
    let number = |attributes: &str, name: &str| string_to_number(&xml_attribute(attributes, name));
    let declared_row = number(&format, "defaultRowHeight");
    let default_row = if declared_row.is_nan() || declared_row == 0.0 { 15.0 } else { declared_row };
    // A column the sheet leaves undeclared: its defaultColWidth, else Excel's own default of eight characters and the
    // padding, rounded up to a multiple of 8 pixels (64 in Calibri 11, 72 in 맑은 고딕 11).
    let declared_default = number(&format, "defaultColWidth");
    let declared_base = number(&format, "baseColWidth");
    let base_characters = if declared_base.is_nan() || declared_base == 0.0 { 8.0 } else { declared_base };
    let default_pixels = if declared_default > 0.0 {
        column_pixels(declared_default, digit_width)
    } else {
        ((base_characters * digit_width + 5.0) / 8.0).ceil() * 8.0
    };
    let columns = COLUMN_ELEMENT
        .captures_iter(xml)
        .map(|found| {
            let attributes = found.get(1).unwrap_or("");
            let width = number(attributes, "width");
            let shown = if width > 0.0 { column_pixels(width, digit_width) } else { default_pixels };
            ColumnSpan {
                start: number(attributes, "min"),
                end: number(attributes, "max"),
                pixels: if xml_attribute(attributes, "hidden") == "1" { 0.0 } else { shown },
            }
        })
        .collect();
    let mut rows = HashMap::new();
    for found in ROW_ELEMENT.captures_iter(xml) {
        let attributes = found.get(1).unwrap_or("");
        let index = number(attributes, "r");
        if !(index.is_finite() && index >= 0.0 && index.fract() == 0.0) {
            continue;
        }
        let height = if xml_attribute(attributes, "hidden") == "1" {
            0.0
        } else {
            let declared = number(attributes, "ht");
            if declared.is_nan() || declared == 0.0 { default_row } else { declared }
        };
        rows.insert(index as u64, height);
    }
    WorksheetGeometry { default_row, default_pixels, columns, rows }
}

impl WorksheetGeometry {
    /// The width in points of the 1-based column.
    pub fn column_points(&self, index: f64) -> f64 {
        let pixels = self.columns.iter().find(|entry| index >= entry.start && index <= entry.end).map_or(self.default_pixels, |entry| entry.pixels);
        pixels * 0.75
    }

    /// The height in points of the 1-based row.
    pub fn row_points(&self, index: f64) -> f64 {
        if index >= 0.0 && index.fract() == 0.0 { self.rows.get(&(index as u64)).copied().unwrap_or(self.default_row) } else { self.default_row }
    }

    /// Which cell a point falls in. A drawing that starts exactly on a boundary sits in the cell that begins there (an image
    /// placed at D2 is in D2, not in C1), while one that ends on a boundary still ends in the cell before it (`trailing`).
    fn edge_cell(&self, points: f64, size: impl Fn(f64) -> f64, limit: u32, trailing: bool) -> Result<f64, String> {
        let mut edge = 0.0;
        for index in 1..=limit {
            let index = f64::from(index);
            edge += size(index);
            let reached = if trailing { edge >= points } else { edge > points };
            if reached {
                return Ok(index);
            }
        }
        Err("Worksheet drawing exceeds the Excel page grid".to_owned())
    }

    /// The column a point falls in.
    pub fn column_at(&self, points: f64, trailing: bool) -> Result<f64, String> {
        self.edge_cell(points, |index| self.column_points(index), 16_384, trailing)
    }

    /// The row a point falls in.
    pub fn row_at(&self, points: f64, trailing: bool) -> Result<f64, String> {
        self.edge_cell(points, |index| self.row_points(index), 1_048_576, trailing)
    }
}

/// A chart or picture anchored to a worksheet, on the cell grid (1-based, inclusive). `body` is the anchor's own markup,
/// which the caller inspects to tell a chart frame from a picture.
#[derive(Debug, Clone, PartialEq)]
pub struct WorksheetDrawing {
    pub part: String,
    pub kind: String,
    pub body: String,
    pub start_column: f64,
    pub start_row: f64,
    pub end_column: f64,
    pub end_row: f64,
    /// The cell the bottom-right corner lies in, as Excel's BottomRightCell names it: a corner on a boundary is in the cell
    /// that begins there.
    pub corner_column: f64,
    pub corner_row: f64,
    /// Where the drawing sits in points and its size (an absolute or one-cell anchor; a two-cell anchor has none).
    pub frame: Option<DrawingFrame>,
}

/// The position and size of a drawing, in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrawingFrame {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy)]
struct Marker {
    column: f64,
    row: f64,
    x: f64,
    y: f64,
}

fn marker(body: &str, tag: &str) -> Marker {
    let value = compiled(&format!(r"<xdr:{tag}>([\s\S]*?)<\/xdr:{tag}>"), "")
        .captures(body)
        .and_then(|found| found.get(1).map(str::to_owned))
        .unwrap_or_default();
    let number = |name: &str| {
        let found = compiled(&format!(r"<xdr:{name}>(\d+)<\/xdr:{name}>"), "").captures(&value).and_then(|found| found.get(1).map(string_to_number));
        match found {
            Some(parsed) if !parsed.is_nan() && parsed != 0.0 => parsed,
            _ => 0.0,
        }
    };
    Marker { column: number("col"), row: number("row"), x: number("colOff") / 12700.0, y: number("rowOff") / 12700.0 }
}

fn emu_points(attributes: &str, name: &str) -> f64 {
    let value = string_to_number(&xml_attribute(attributes, name)) / 12700.0;
    if value.is_nan() { 0.0 } else { value }
}

const GRID_COLUMNS: f64 = 16_384.0;
const GRID_ROWS: f64 = 1_048_576.0;

/// `worksheetDrawings(zip, sheet, xml)`: every chart and picture anchored to a worksheet, resolved onto the cell grid
/// (1-based, inclusive). Excel writes three anchor kinds and our own writer uses the absolute one, so the print area and the
/// snapshot read the same resolver rather than each parsing anchors again.
pub fn worksheet_drawings<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    zip: &Package,
    sheet: &Sheet,
    xml: &str,
) -> Result<Vec<WorksheetDrawing>, String> {
    let relations = zip.text(&part_relationship_path(&sheet.path));
    let geometry = worksheet_geometry(xml, workbook_digit_width(measurer, zip)?);
    let mut drawings = Vec::new();
    for relationship in RELATIONSHIP.captures_iter(&relations) {
        let attributes = relationship.get(1).unwrap_or("");
        if !xml_attribute(attributes, "Type").ends_with("/drawing") || xml_attribute(attributes, "TargetMode") == "External" {
            continue;
        }
        let target = xml_attribute(attributes, "Target");
        let part = match target.strip_prefix('/') {
            Some(rooted) => rooted.to_owned(),
            None => posix::normalize(&posix::join(&[posix::dirname(&sheet.path).as_str(), target.as_str()])),
        };
        let drawing = zip.text(&part);
        for anchor in ANCHOR.captures_iter(&drawing) {
            let kind = anchor.get(1).unwrap_or("");
            let body = anchor.get(2).unwrap_or("");
            let start = (kind != "absoluteAnchor").then(|| marker(body, "from"));
            if start.is_some_and(|start| start.column >= GRID_COLUMNS || start.row >= GRID_ROWS) {
                return Err("Worksheet drawing anchor exceeds the Excel grid".to_owned());
            }
            if let (Some(start), "twoCellAnchor") = (start, kind) {
                let end = marker(body, "to");
                if end.column >= GRID_COLUMNS || end.row >= GRID_ROWS {
                    return Err("Worksheet drawing anchor exceeds the Excel grid".to_owned());
                }
                drawings.push(WorksheetDrawing {
                    part: part.clone(),
                    kind: kind.to_owned(),
                    body: body.to_owned(),
                    start_column: start.column + 1.0,
                    start_row: start.row + 1.0,
                    end_column: end.column + if end.x > 0.0 { 1.0 } else { 0.0 },
                    end_row: end.row + if end.y > 0.0 { 1.0 } else { 0.0 },
                    // The cell the bottom-right corner lies in, as Excel's BottomRightCell names it: the `to` cell itself.
                    corner_column: end.column + 1.0,
                    corner_row: end.row + 1.0,
                    frame: None,
                });
                continue;
            }
            let extent = EXTENT.captures(body).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
            let (x, y) = match start {
                None => {
                    let position = POSITION.captures(body).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
                    (emu_points(&position, "x"), emu_points(&position, "y"))
                }
                Some(start) => {
                    let (mut x, mut y) = (start.x, start.y);
                    let mut index = 1.0;
                    while index <= start.column {
                        x += geometry.column_points(index);
                        index += 1.0;
                    }
                    index = 1.0;
                    while index <= start.row {
                        y += geometry.row_points(index);
                        index += 1.0;
                    }
                    (x, y)
                }
            };
            let width = emu_points(&extent, "cx");
            let height = emu_points(&extent, "cy");
            drawings.push(WorksheetDrawing {
                part: part.clone(),
                kind: kind.to_owned(),
                body: body.to_owned(),
                start_column: geometry.column_at(x, false)?,
                start_row: geometry.row_at(y, false)?,
                end_column: geometry.column_at(x + width, true)?,
                end_row: geometry.row_at(y + height, true)?,
                // A corner on a boundary is in the cell that begins there.
                corner_column: geometry.column_at(x + width, false)?,
                corner_row: geometry.row_at(y + height, false)?,
                frame: Some(DrawingFrame { left: x, top: y, width, height }),
            });
        }
    }
    Ok(drawings)
}

/// `contentPrintArea(zip, sheet, xml)`: the area from A1 to the last cell that holds something, a merged range ends or a
/// drawing reaches.
pub fn content_print_area<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package, sheet: &Sheet, xml: &str) -> Result<String, String> {
    let mut last_column = 1.0;
    let mut last_row = 1.0;
    for cell in cell_records(xml, &shared_strings(zip), None) {
        if cell.formula.is_none() && cell.value == CellValue::Text(String::new()) {
            continue;
        }
        let parsed = parse_cell_ref(&cell.reference)?;
        last_column = math::max(last_column, column_number(&parsed.col));
        last_row = math::max(last_row, parsed.row as f64);
    }
    for reference in merged_ranges(xml) {
        let area = parse_area_range(&reference)?;
        last_column = math::max(last_column, area.end_col);
        last_row = math::max(last_row, area.end_row);
    }
    // A drawing reaches the print area through the cell its bottom-right corner lies in, as Excel's own content print area
    // takes it: ended on the row it closes, a dashboard chart whose edge met a row boundary left the page no room below it,
    // and Excel cut its axis labels in half at the edge.
    for drawing in worksheet_drawings(measurer, zip, sheet, xml)? {
        last_column = math::max(last_column, drawing.corner_column);
        last_row = math::max(last_row, drawing.corner_row);
    }
    Ok(format!("A1:{}{}", column_label(last_column), number_to_string(last_row)))
}

/// The sheet's own sheetPr with fitToPage turned on: whatever else it declares travels with it, and the fit flag it may
/// already carry is replaced rather than written twice.
fn sheet_pr_with_fit_to_page(xml: &str) -> String {
    let Some(section) = worksheet_section(xml, "sheetPr") else {
        return "<sheetPr><pageSetUpPr fitToPage=\"1\"/></sheetPr>".to_owned();
    };
    let sheet_pr = &xml[section];
    let attributes = SHEET_PR_OPEN.captures(sheet_pr).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
    let body = if sheet_pr.ends_with("/>") {
        ""
    } else {
        match (sheet_pr.find('>'), sheet_pr.rfind("</sheetPr>")) {
            (Some(open), Some(close)) if open < close => &sheet_pr[open + 1..close],
            _ => "",
        }
    };
    let body = match PAGE_SET_UP_PR.find(body) {
        Some(found) => format!("{}{}", &body[..found.start], &body[found.end..]),
        None => body.to_owned(),
    };
    format!("<sheetPr{attributes}>{body}<pageSetUpPr fitToPage=\"1\"/></sheetPr>")
}

/// What [`fit_drawing_sheet_one_page_wide`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FittedSheet {
    pub xml: String,
    pub applied: bool,
}

/// `fitDrawingSheetOnePageWide(xml)`: a chart or picture beside a table is wider than a portrait page, and a sheet with no
/// page setup exports by column blocks, the page break running through the chart. A sheet that declares nothing takes one
/// page wide and keeps paging down (a fit only scales down, so a small sheet prints as before); a declared fit, print
/// scale, or print area is the author's and stays.
pub fn fit_drawing_sheet_one_page_wide(xml: &str) -> FittedSheet {
    if FIT_TO_PAGE_ON.is_match(xml) {
        return FittedSheet { xml: xml.to_owned(), applied: false };
    }
    let setup = worksheet_section(xml, "pageSetup").map(|range| &xml[range]);
    if setup.is_some_and(|setup| SCALE_ATTRIBUTE.is_match(setup)) {
        return FittedSheet { xml: xml.to_owned(), applied: false };
    }
    let next = upsert_worksheet_section(xml, "sheetPr", &sheet_pr_with_fit_to_page(xml));
    // pageSetup is attributes and no children, and the section also matches the paired <pageSetup …></pageSetup> a sheet may
    // carry: the fit is written onto the opening tag's attributes, never appended after a closing one.
    let attributes = setup
        .and_then(|setup| PAGE_SETUP_OPEN.captures(setup).and_then(|found| found.get(1).map(str::to_owned)))
        .unwrap_or_default();
    let attributes = FIT_TO_ATTRIBUTES.replace_all_with(&attributes, |_| String::new());
    let next = upsert_worksheet_section(&next, "pageSetup", &format!("<pageSetup{attributes} fitToWidth=\"1\" fitToHeight=\"0\"/>"));
    FittedSheet { xml: next, applied: true }
}

/// `printTitleRowSpan(value)`: a row or a span of rows, `"1"`, `"4:5"` or `"$1:$1"`.
fn print_title_row_span(value: Option<&Value>) -> Result<Option<(f64, f64)>, String> {
    let Some(value) = value.filter(|value| !value.is_null()) else { return Ok(None) };
    let text = value_to_string(value);
    if js_trim(&text).is_empty() {
        return Ok(None);
    }
    let parts: Vec<f64> = text.replace('$', "").split(':').map(|part| string_to_number(js_trim(part))).collect();
    let first = parts.first().copied().unwrap_or(f64::NAN);
    let last = parts.get(1).copied().unwrap_or(first);
    let integer = |number: f64| number.is_finite() && number.fract() == 0.0;
    if !integer(first) || !integer(last) || first < 1.0 || last < first {
        return Err(format!(
            "set_page_setup printTitleRows is a row or a span of rows such as \"1\" or \"4:5\", not \"{text}\""
        ));
    }
    Ok(Some((first, last)))
}

/// `margin(value, fallback)`: a finite number of zero or more, else the fallback (an absent value is not a number).
fn margin(value: Option<&Value>, fallback: f64) -> f64 {
    let number = to_number_of(value);
    if number.is_finite() && number >= 0.0 { number } else { fallback }
}

/// `Number(value) || 0` of a page count; `None` when the caller did not name one.
fn page_count(value: Option<&Value>) -> Option<f64> {
    let value = value.filter(|value| !value.is_null())?;
    let number = to_number(value);
    Some(if number.is_nan() { 0.0 } else { number })
}

/// Writes one defined name of the workbook that belongs to `sheet_index` (`Print_Area`, `Print_Titles`).
fn write_sheet_name(zip: &mut Package, name: &str, sheet_index: f64, reference: &str) {
    let workbook = zip.text("xl/workbook.xml");
    let entry = format!(
        "<definedName name=\"{name}\" localSheetId=\"{}\">{}</definedName>",
        number_to_string(sheet_index),
        xml_encode(reference)
    );
    let updated = upsert_defined_name(&workbook, Some(&entry), |item| {
        xml_attribute(item, "name") == name && string_to_number(&xml_attribute(item, "localSheetId")) == sheet_index
    });
    zip.set("xl/workbook.xml", updated);
}

/// `applyWorksheetPageSetup(zip, sheets, sheet, xml, op)`: `set_page_setup` on one worksheet: orientation, fit, margins,
/// centring, print area (named, or the content's with `fitToContent`) and the header rows every printed page repeats. The
/// sheet part and the workbook are written into `zip`; the answer is the operation's report.
pub fn apply_worksheet_page_setup<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    zip: &mut Package,
    sheets: &[Sheet],
    sheet: &Sheet,
    xml: &str,
    op: &Map<String, Value>,
) -> Result<Value, String> {
    let orientation = match op.get("orientation").filter(|value| truthy(value)) {
        Some(value) => js_to_lowercase(&value_to_string(value)),
        None => String::new(),
    };
    if !orientation.is_empty() && orientation != "portrait" && orientation != "landscape" {
        return Err("set_page_setup orientation must be portrait or landscape".to_owned());
    }
    // A fit bounds the pages it names and leaves the other side free ("fitted by width alone" in the xlsx skill). The count
    // left out is written as 0 (automatic): missing, Excel reads it as 1, and fitToPagesWide:1 shrank a 92-row log onto
    // one page.
    let fit_wide = page_count(op.get("fitToPagesWide"));
    let fit_tall = page_count(op.get("fitToPagesTall"));
    let fitting = fit_wide.is_some() || fit_tall.is_some();
    let mut xml = xml.to_owned();
    // A call that sets only the print area or margins keeps the fit the sheet already declares: with fitToPage on and the
    // counts dropped, Excel would read the default 1 x 1 and shrink a long sheet onto one page.
    let carried_fit = if fitting {
        String::new()
    } else {
        let setup = worksheet_section(&xml, "pageSetup").map_or("", |range| &xml[range]);
        FIT_TO_ATTRIBUTES.find_iter(setup).map(|found| &setup[found]).collect::<String>()
    };
    if fitting {
        xml = upsert_worksheet_section(&xml, "sheetPr", &sheet_pr_with_fit_to_page(&xml));
    }
    let centered = format!(
        "{}{}",
        if op.get("centerHorizontally") == Some(&Value::Bool(true)) { " horizontalCentered=\"1\"" } else { "" },
        if op.get("centerVertically") == Some(&Value::Bool(true)) { " verticalCentered=\"1\"" } else { "" }
    );
    xml = upsert_worksheet_section(&xml, "printOptions", &if centered.is_empty() { String::new() } else { format!("<printOptions{centered}/>") });
    let edge = |key: &str, fallback: f64| number_to_string(margin(op.get(key), fallback));
    xml = upsert_worksheet_section(
        &xml,
        "pageMargins",
        &format!(
            "<pageMargins left=\"{}\" right=\"{}\" top=\"{}\" bottom=\"{}\" header=\"0.3\" footer=\"0.3\"/>",
            edge("leftMargin", 0.7),
            edge("rightMargin", 0.7),
            edge("topMargin", 0.75),
            edge("bottomMargin", 0.75)
        ),
    );
    let orientation_attribute = if orientation.is_empty() { String::new() } else { format!(" orientation=\"{orientation}\"") };
    let fit_attributes = if fitting {
        format!(" fitToWidth=\"{}\" fitToHeight=\"{}\"", number_to_string(fit_wide.unwrap_or(0.0)), number_to_string(fit_tall.unwrap_or(0.0)))
    } else {
        String::new()
    };
    xml = upsert_worksheet_section(&xml, "pageSetup", &format!("<pageSetup paperSize=\"9\"{orientation_attribute}{fit_attributes}{carried_fit}/>"));
    let named_area = if op.get("fitToContent") == Some(&Value::Bool(true)) {
        Some(Value::from(content_print_area(measurer, zip, sheet, &xml)?))
    } else {
        op.get("printArea").cloned()
    };
    let print_area = named_area.filter(truthy);
    let sheet_index = sheets.iter().position(|entry| entry.name == sheet.name).map_or(-1.0, |index| index as f64);
    if let Some(area) = &print_area {
        let reference = format!("{}!{}", quote_sheet_name(&sheet.name), absolute_range(&area_reference(&parse_area_range(&value_to_string(area))?)));
        write_sheet_name(zip, "_xlnm.Print_Area", sheet_index, &reference);
    }
    // The header rows every printed page repeats (Print_Titles): a data sheet longer than a page named its columns on the
    // first page only, and the frozen header the screen shows does not print.
    let titles = print_title_row_span(op.get("printTitleRows"))?;
    if let Some((first, last)) = titles {
        let reference = format!("{}!${}:${}", quote_sheet_name(&sheet.name), number_to_string(first), number_to_string(last));
        write_sheet_name(zip, "_xlnm.Print_Titles", sheet_index, &reference);
    }
    zip.set(&sheet.path, xml);
    let mut report = Map::new();
    if let Some(name) = op.get("op") {
        report.insert("op".to_owned(), name.clone());
    }
    report.insert("changed".to_owned(), json!(true));
    report.insert("sheet".to_owned(), json!(sheet.name));
    if let Some(area) = print_area {
        report.insert("printArea".to_owned(), area);
    }
    if let Some((first, last)) = titles {
        report.insert("printTitleRows".to_owned(), json!(format!("{}:{}", number_to_string(first), number_to_string(last))));
    }
    Ok(Value::Object(report))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_column_width_is_stored_with_its_padding_in_256ths() {
        // 9 characters at 8 px a digit: (72 + 5) / 8 = 9.625.
        assert_eq!(column_file_width(9.0, 8.0), 9.625);
        assert_eq!(column_file_width(0.0, 7.0), 0.0);
        assert_eq!(column_file_width(f64::NAN, 7.0), 0.0);
        // And back to the pixels it spans: 77.
        assert_eq!(column_pixels(9.625, 8.0), 77.0);
    }

    #[test]
    fn geometry_reads_declared_widths_heights_and_hidden_spans() {
        let xml = "<worksheet><sheetFormatPr defaultRowHeight=\"20\"/><cols><col min=\"1\" max=\"2\" width=\"12\"/><col min=\"3\" max=\"3\" width=\"9\" hidden=\"1\"/></cols>\
                   <sheetData><row r=\"1\" ht=\"30\"/><row r=\"2\" hidden=\"1\"><c r=\"A2\"/></row></sheetData></worksheet>";
        let geometry = worksheet_geometry(xml, 7.0);
        assert_eq!(geometry.column_points(1.0), column_pixels(12.0, 7.0) * 0.75);
        assert_eq!(geometry.column_points(3.0), 0.0);
        // Undeclared: eight characters and padding, up to a multiple of 8 pixels (64).
        assert_eq!(geometry.column_points(4.0), 48.0);
        assert_eq!(geometry.row_points(1.0), 30.0);
        assert_eq!(geometry.row_points(2.0), 0.0);
        assert_eq!(geometry.row_points(9.0), 20.0);
    }

    #[test]
    fn a_point_on_a_boundary_starts_in_the_cell_that_begins_there_and_ends_in_the_one_before() {
        let geometry = worksheet_geometry("<worksheet/>", 7.0);
        // Column width 48 pt each, rows 15 pt.
        assert_eq!(geometry.column_at(48.0, false), Ok(2.0));
        assert_eq!(geometry.column_at(48.0, true), Ok(1.0));
        assert_eq!(geometry.row_at(15.0, false), Ok(2.0));
        assert_eq!(geometry.row_at(15.0, true), Ok(1.0));
        assert!(geometry.column_at(1e9, false).is_err());
    }

    #[test]
    fn a_sheet_that_declares_nothing_is_fitted_one_page_wide() {
        let xml = "<worksheet><sheetData/><pageMargins left=\"0.7\"/></worksheet>";
        let fitted = fit_drawing_sheet_one_page_wide(xml);
        assert!(fitted.applied);
        assert_eq!(
            fitted.xml,
            "<worksheet><sheetPr><pageSetUpPr fitToPage=\"1\"/></sheetPr><sheetData/><pageMargins left=\"0.7\"/><pageSetup fitToWidth=\"1\" fitToHeight=\"0\"/></worksheet>"
        );
    }

    #[test]
    fn a_declared_fit_or_scale_is_the_authors_and_stays() {
        let fit = "<worksheet><sheetPr><pageSetUpPr fitToPage=\"1\"/></sheetPr><sheetData/></worksheet>";
        assert_eq!(fit_drawing_sheet_one_page_wide(fit), FittedSheet { xml: fit.to_owned(), applied: false });
        let scale = "<worksheet><sheetData/><pageSetup scale=\"80\"/></worksheet>";
        assert_eq!(fit_drawing_sheet_one_page_wide(scale), FittedSheet { xml: scale.to_owned(), applied: false });
    }

    #[test]
    fn the_fit_replaces_the_counts_a_paired_page_setup_carries() {
        let xml = "<worksheet><sheetPr codeName=\"S\"><tabColor rgb=\"FF0000FF\"/></sheetPr><sheetData/><pageSetup orientation=\"landscape\" fitToWidth=\"3\"></pageSetup></worksheet>";
        let fitted = fit_drawing_sheet_one_page_wide(xml);
        assert!(fitted.applied);
        assert!(fitted.xml.contains("<sheetPr codeName=\"S\"><tabColor rgb=\"FF0000FF\"/><pageSetUpPr fitToPage=\"1\"/></sheetPr>"));
        assert!(fitted.xml.contains("<pageSetup orientation=\"landscape\" fitToWidth=\"1\" fitToHeight=\"0\"/>"));
    }

    #[test]
    fn print_title_rows_are_a_row_or_a_span() {
        assert_eq!(print_title_row_span(Some(&json!("1"))), Ok(Some((1.0, 1.0))));
        assert_eq!(print_title_row_span(Some(&json!("4:5"))), Ok(Some((4.0, 5.0))));
        assert_eq!(print_title_row_span(Some(&json!("$1:$2"))), Ok(Some((1.0, 2.0))));
        assert_eq!(print_title_row_span(Some(&json!(3))), Ok(Some((3.0, 3.0))));
        assert_eq!(print_title_row_span(Some(&json!(" "))), Ok(None));
        assert_eq!(print_title_row_span(None), Ok(None));
        assert!(print_title_row_span(Some(&json!("5:4"))).is_err());
        assert!(print_title_row_span(Some(&json!("0"))).is_err());
        assert!(print_title_row_span(Some(&json!("a"))).is_err());
    }
}
