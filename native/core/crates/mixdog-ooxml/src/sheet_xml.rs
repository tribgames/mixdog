//! `portable/portable-sheet-xml.mjs`: a worksheet and the workbook part around it as XML text: the order of a worksheet's
//! sections, merged cells, rows and columns shifted or hidden, column widths, conditional-format rules, the views, area
//! references, the width a formatted number takes in a column, and defined names. Every function reads and writes the XML
//! as the Node code does (regular expressions over the text), so what it leaves untouched stays byte for byte.
//!
//! Row and column numbers that a worksheet writes as whole numbers are held as `u32` or `f64` as the Node arithmetic
//! needs; a column or row attribute that is not a whole number (which no worksheet carries) is cut to its integer part.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::ops::Range;
use std::sync::LazyLock;

use mixdog_js::{
    JsRegex, js_trim, math, number_to_string, slice_utf16, string_to_number, to_number_of, utf16_len, value_to_string,
};
use mixdog_office_base::a1::{column_label, column_number, parse_cell_ref};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

use crate::sheet_styles::normalize_color_value;
use crate::xml::{compiled, container_body, element_spans, set_xml_attribute, xml_attribute};

const WORKSHEET_SECTIONS: [&str; 38] = [
    "sheetPr",
    "dimension",
    "sheetViews",
    "sheetFormatPr",
    "cols",
    "sheetData",
    "sheetCalcPr",
    "sheetProtection",
    "protectedRanges",
    "scenarios",
    "autoFilter",
    "sortState",
    "dataConsolidate",
    "customSheetViews",
    "mergeCells",
    "phoneticPr",
    "conditionalFormatting",
    "dataValidations",
    "hyperlinks",
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
    "customProperties",
    "cellWatches",
    "ignoredErrors",
    "smartTags",
    "drawing",
    "legacyDrawing",
    "legacyDrawingHF",
    "picture",
    "oleObjects",
    "controls",
    "webPublishItems",
    "tableParts",
    "extLst",
];

/// A pattern fixed in the source, compiled on first use.
macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

static WHITESPACE_RUN: LazyLock<JsRegex> = regex!(r"\s+", "g");
static NOT_NAME_CHARACTER: LazyLock<JsRegex> = regex!(r"[^\p{L}\p{N}_.]", "gu");
static STARTS_WITH_LETTER: LazyLock<JsRegex> = regex!(r"^[\p{L}_]", "u");
static RESERVED_TABLE_NAME: LazyLock<JsRegex> = regex!(r"^(?:[RrCc]|[A-Za-z]{1,3}\d{1,7})$", "");
static ANY_WHITESPACE: LazyLock<JsRegex> = regex!(r"\s", "");
static DEFINED_NAME_START: LazyLock<JsRegex> = regex!(r"^[\p{L}_\\]", "u");
static DEFINED_NAME_CHARACTER: LazyLock<JsRegex> = regex!(r"[\p{L}\p{N}_.\\]", "u");
static RESERVED_DEFINED_NAME: LazyLock<JsRegex> = regex!(r"^(?:[RrCc]|\$?[A-Za-z]{1,3}\$?\d{1,7})$", "");

/// `safeWorkbookTableName(value)`: a name Excel accepts for a table. Excel names take letters of any script, digits,
/// underscores and periods, but no spaces or punctuation, and may not start with a digit or read as a cell reference.
/// Keeping only ASCII erased a Korean name entirely and the table was silently called Table1.
pub fn safe_workbook_table_name(value: &str) -> String {
    let spaced = WHITESPACE_RUN.replace_all_with(value, |_| "_".to_owned());
    let cleaned = NOT_NAME_CHARACTER.replace_all_with(&spaced, |_| String::new());
    let named = if STARTS_WITH_LETTER.is_match(&cleaned) {
        cleaned
    } else if !cleaned.is_empty() {
        format!("_{cleaned}")
    } else {
        String::new()
    };
    let bounded = slice_utf16(&named, 255);
    if bounded.is_empty() {
        return "Table1".to_owned();
    }
    // R, C, and anything shaped like A1 are reserved; Excel refuses the workbook.
    if RESERVED_TABLE_NAME.is_match(&bounded) { format!("_{bounded}") } else { bounded }
}

/// `workbookDefinedNameFault(value)`: why a name Excel refuses is refused, empty when it is accepted. A defined name is
/// written into formulas by the caller, so repairing it silently would break those formulas: the rule is reported
/// instead. Excel will not open a workbook whose defined name carries a space, and reads A1 or R/C as a reference.
pub fn workbook_defined_name_fault(value: &str) -> String {
    let name = value;
    if js_trim(name).is_empty() {
        return "a name is required".to_owned();
    }
    let length = utf16_len(name);
    if length > 255 {
        return format!("it is {length} characters; Excel allows 255");
    }
    if ANY_WHITESPACE.is_match(name) {
        let underscored = WHITESPACE_RUN.replace_all_with(name, |_| "_".to_owned());
        return format!("it contains a space; use an underscore ({underscored})");
    }
    if !DEFINED_NAME_START.is_match(name) {
        return "it must start with a letter, underscore, or backslash".to_owned();
    }
    let mut offending: Vec<char> = Vec::new();
    for character in name.chars() {
        if !DEFINED_NAME_CHARACTER.is_match(&character.to_string()) && !offending.contains(&character) {
            offending.push(character);
        }
    }
    if !offending.is_empty() {
        let listed: Vec<String> = offending.iter().map(char::to_string).collect();
        return format!("it contains {}; use letters, digits, underscores, or periods", listed.join(" "));
    }
    if RESERVED_DEFINED_NAME.is_match(name) {
        return "Excel reads it as a cell reference, not a name".to_owned();
    }
    String::new()
}

/// `worksheetSection(xml, name)`: where the first element of a section lies (self-closing or with content).
pub fn worksheet_section(xml: &str, name: &str) -> Option<Range<usize>> {
    compiled(&format!(r"<{name}\b[^>]*?(?:\/>|>[\s\S]*?<\/{name}>)"), "").find(xml)
}

/// `xml.slice(0, at) + insert + xml.slice(at)`.
fn insert_at(xml: &str, at: usize, insert: &str) -> String {
    format!("{}{insert}{}", &xml[..at], &xml[at..])
}

/// `xml.replace(/<\/tag>\s*$/, () => element + '</tag>')`: the closing tag and the white space after it become the
/// element and the closing tag.
fn before_closing(xml: &str, closing: &'static LazyLock<JsRegex>, tag_text: &str, element: &str) -> String {
    match closing.find(xml) {
        Some(range) => format!("{}{element}{tag_text}{}", &xml[..range.start], &xml[range.end..]),
        None => xml.to_owned(),
    }
}

static WORKSHEET_END: LazyLock<JsRegex> = regex!(r"<\/worksheet>\s*$", "");
static WORKBOOK_END: LazyLock<JsRegex> = regex!(r"<\/workbook>\s*$", "");

/// `upsertWorksheetSection(xml, name, element)`: the section written in schema order: before the first later section that
/// is present, else before the closing tag. An empty `element` removes the section.
pub fn upsert_worksheet_section(xml: &str, name: &str, element: &str) -> String {
    let base = match worksheet_section(xml, name) {
        Some(range) => format!("{}{}", &xml[..range.start], &xml[range.end..]),
        None => xml.to_owned(),
    };
    if element.is_empty() {
        return base;
    }
    let later = WORKSHEET_SECTIONS.iter().position(|section| *section == name).map_or(0, |position| position + 1);
    for candidate in &WORKSHEET_SECTIONS[later..] {
        if let Some(found) = worksheet_section(&base, candidate) {
            return insert_at(&base, found.start, element);
        }
    }
    before_closing(&base, &WORKSHEET_END, "</worksheet>", element)
}

static MERGE_CELL: LazyLock<JsRegex> = regex!(r#"<mergeCell\b[^>]*\bref="([^"]+)"[^>]*\/>"#, "g");

/// `mergedRanges(xml)`: the merged areas, upper-cased.
pub fn merged_ranges(xml: &str) -> Vec<String> {
    let Some(section) = worksheet_section(xml, "mergeCells") else { return Vec::new() };
    MERGE_CELL.captures_iter(&xml[section]).map(|found| found.get(1).unwrap_or("").to_uppercase()).collect()
}

/// `writeMergedRanges(xml, ranges)`: the merged areas written without repeats; none removes the section.
pub fn write_merged_ranges(xml: &str, ranges: &[String]) -> String {
    let mut unique: Vec<&String> = Vec::new();
    for range in ranges {
        if !unique.contains(&range) {
            unique.push(range);
        }
    }
    let element = if unique.is_empty() {
        String::new()
    } else {
        let cells: String = unique.iter().map(|reference| format!("<mergeCell ref=\"{reference}\"/>")).collect();
        format!("<mergeCells count=\"{}\">{cells}</mergeCells>", unique.len())
    };
    upsert_worksheet_section(xml, "mergeCells", &element)
}

static ROW_OPEN: LazyLock<JsRegex> = regex!(r"^<row\b([^>]*?)(\/>|>)", "");
static CELL_REFERENCE: LazyLock<JsRegex> = regex!(r#"(<c\b[^>]*?\br=")([A-Z]+)\d+(")"#, "g");
static SHEET_DATA: LazyLock<JsRegex> = regex!(r"<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)", "");
static ROW_NUMBER: LazyLock<JsRegex> = regex!(r#"\br="(\d+)""#, "");
static CELL_NUMBER: LazyLock<JsRegex> = regex!(r#"\br="([A-Za-z]+\d+)""#, "");
static CELL_COLUMN: LazyLock<JsRegex> = regex!(r#"(\br=")[A-Za-z]+(\d+")"#, "");

fn renumber_worksheet_row(row_xml: &str, index: f64) -> String {
    let Some(open) = ROW_OPEN.captures(row_xml) else { return row_xml.to_owned() };
    let attrs = set_xml_attribute(open.get(1).unwrap_or(""), "r", &number_to_string(index));
    if open.get(2) == Some("/>") {
        return format!("<row{attrs}/>");
    }
    let body = CELL_REFERENCE.replace_all_with(&container_body(row_xml, "row"), |found| {
        format!("{}{}{}{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or(""), number_to_string(index), found.get(3).unwrap_or(""))
    });
    format!("<row{attrs}>{body}</row>")
}

fn sheet_data_section(xml: &str) -> Result<Range<usize>, String> {
    SHEET_DATA.find(xml).ok_or_else(|| "Worksheet is missing sheetData".to_owned())
}

fn replace_sheet_data(xml: &str, inner: &str) -> Result<String, String> {
    let sheet_data = sheet_data_section(xml)?;
    Ok(format!("{}<sheetData>{inner}</sheetData>{}", &xml[..sheet_data.start], &xml[sheet_data.end..]))
}

/// `Number(text)` of the first group of a match, 0 when it did not match (`Number(/re/.exec(s)?.[1] || 0)`).
fn matched_number(regex: &JsRegex, text: &str) -> f64 {
    regex.captures(text).and_then(|found| found.get(1).map(string_to_number)).filter(|number| !number.is_nan()).unwrap_or(0.0)
}

/// `shiftWorksheetRows(xml, from, count)`: the rows from `from` moved by `count` (rows and the cell references in them are
/// renumbered); a negative `count` deletes the rows it covers.
pub fn shift_worksheet_rows(xml: &str, from: f64, count: f64) -> Result<String, String> {
    let sheet_data = &xml[sheet_data_section(xml)?];
    let inner = container_body(sheet_data, "sheetData");
    let mut kept: Vec<String> = Vec::new();
    for span in element_spans(&inner, "row") {
        let index = matched_number(&ROW_NUMBER, &span.attrs);
        if count < 0.0 && index >= from && index < from - count {
            continue;
        }
        let next = if index >= from { index + count } else { index };
        if next < 1.0 {
            continue;
        }
        kept.push(renumber_worksheet_row(&span.xml, next));
    }
    replace_sheet_data(xml, &kept.concat())
}

/// `shiftWorksheetColumns(xml, from, count)`: the columns from `from` moved by `count`; a negative `count` deletes the
/// columns it covers. A cell with no reference is dropped.
pub fn shift_worksheet_columns(xml: &str, from: f64, count: f64) -> Result<String, String> {
    let sheet_data = &xml[sheet_data_section(xml)?];
    let inner = container_body(sheet_data, "sheetData");
    let mut rows: Vec<String> = Vec::new();
    for span in element_spans(&inner, "row") {
        let open = ROW_OPEN.captures(&span.xml);
        let Some(open) = open.filter(|open| open.get(2) != Some("/>")) else {
            rows.push(span.xml.clone());
            continue;
        };
        let body = container_body(&span.xml, "row");
        let mut kept: Vec<String> = Vec::new();
        for cell in element_spans(&body, "c") {
            let reference = CELL_NUMBER.captures(&cell.attrs).and_then(|found| found.get(1).map(str::to_uppercase)).unwrap_or_default();
            if reference.is_empty() {
                continue;
            }
            let column = column_number(&parse_cell_ref(&reference)?.col);
            if count < 0.0 && column >= from && column < from - count {
                continue;
            }
            let next = if column >= from { column + count } else { column };
            if next < 1.0 {
                continue;
            }
            let label = column_label(next);
            let moved = match CELL_COLUMN.captures(&cell.xml) {
                Some(found) => {
                    let range = found.range();
                    format!("{}{}{label}{}{}", &cell.xml[..range.start], found.get(1).unwrap_or(""), found.get(2).unwrap_or(""), &cell.xml[range.end..])
                }
                None => cell.xml.clone(),
            };
            kept.push(moved);
        }
        rows.push(format!("<row{}>{}</row>", open.get(1).unwrap_or(""), kept.concat()));
    }
    replace_sheet_data(xml, &rows.concat())
}

/// `appendWorksheetSection(xml, name, element)`: the element written after the last element of the same name, or in schema
/// order when there is none.
pub fn append_worksheet_section(xml: &str, name: &str, element: &str) -> String {
    let existing = compiled(&format!(r"<{name}\b[^>]*?(?:\/>|>[\s\S]*?<\/{name}>)"), "g");
    match existing.find_iter(xml).last() {
        Some(last) => insert_at(xml, last.end, element),
        None => upsert_worksheet_section(xml, name, element),
    }
}

/// `conditionalScaleRule(kind, options, priority)`: a colour scale or a data bar states its own colours inside the rule:
/// the low end, the optional middle and the high end for a scale; one bar colour otherwise. Excel's defaults are a
/// red-to-green scale and a blue bar; a caller that names colours gets those instead.
pub fn conditional_scale_rule(kind: &str, options: &Map<String, Value>, priority: u32) -> String {
    let color = |value: Option<&Value>, fallback: &str| {
        let normalized = normalize_color_value(value);
        if normalized.is_empty() { fallback.to_owned() } else { normalized }
    };
    if kind == "dataBar" {
        let named = match options.get("color") {
            Some(own) if truthy(own) => Some(own),
            _ => options.get("fillColor"),
        };
        return format!(
            "<cfRule type=\"dataBar\" priority=\"{priority}\"><dataBar><cfvo type=\"min\"/><cfvo type=\"max\"/><color rgb=\"{}\"/></dataBar></cfRule>",
            color(named, "FF638EC6")
        );
    }
    let middle = normalize_color_value(options.get("midColor"));
    format!(
        "<cfRule type=\"colorScale\" priority=\"{priority}\"><colorScale><cfvo type=\"min\"/>{}<cfvo type=\"max\"/><color rgb=\"{}\"/>{}<color rgb=\"{}\"/></colorScale></cfRule>",
        if middle.is_empty() { "" } else { "<cfvo type=\"percentile\" val=\"50\"/>" },
        color(options.get("minColor"), "FFF8696B"),
        if middle.is_empty() { String::new() } else { format!("<color rgb=\"{middle}\"/>") },
        color(options.get("maxColor"), "FF63BE7B"),
    )
}

/// What [`append_differential_format`] answers: the styles part and the id of the differential format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DifferentialFormat {
    pub xml: String,
    pub id: usize,
}

static DXFS: LazyLock<JsRegex> = regex!(r"<dxfs\b[^>]*?(?:\/>|>[\s\S]*?<\/dxfs>)", "");
static DXF: LazyLock<JsRegex> = regex!(r"<dxf>[\s\S]*?<\/dxf>", "g");
static CELL_STYLES: LazyLock<JsRegex> = regex!(r"<cellStyles\b[^>]*?(?:\/>|>[\s\S]*?<\/cellStyles>)", "");

/// `appendDifferentialFormat(stylesXml, { color, fillColor })`: the id of a differential format (a conditional rule's font
/// and fill colours), added to the styles when no identical one exists.
pub fn append_differential_format(styles_xml: &str, color: &str, fill_color: &str) -> DifferentialFormat {
    let font = crate::sheet_styles::normalize_color(color);
    let fill = crate::sheet_styles::normalize_color(fill_color);
    let dxf = format!(
        "<dxf>{}{}</dxf>",
        if font.is_empty() { String::new() } else { format!("<font><color rgb=\"{font}\"/></font>") },
        if fill.is_empty() { String::new() } else { format!("<fill><patternFill><bgColor rgb=\"{fill}\"/></patternFill></fill>") },
    );
    let section = DXFS.find(styles_xml);
    let mut items: Vec<String> = match &section {
        Some(range) if !styles_xml[range.clone()].ends_with("/>") => {
            DXF.find_iter(&styles_xml[range.clone()]).map(|found| styles_xml[range.start + found.start..range.start + found.end].to_owned()).collect()
        }
        _ => Vec::new(),
    };
    if let Some(found) = items.iter().position(|item| *item == dxf) {
        return DifferentialFormat { xml: styles_xml.to_owned(), id: found };
    }
    items.push(dxf);
    let element = format!("<dxfs count=\"{}\">{}</dxfs>", items.len(), items.concat());
    let id = items.len() - 1;
    if let Some(range) = section {
        return DifferentialFormat { xml: format!("{}{element}{}", &styles_xml[..range.start], &styles_xml[range.end..]), id };
    }
    if let Some(styles) = CELL_STYLES.find(styles_xml) {
        return DifferentialFormat { xml: insert_at(styles_xml, styles.end, &element), id };
    }
    DifferentialFormat { xml: styles_xml.replacen("</styleSheet>", &format!("{element}</styleSheet>"), 1), id }
}

/// `mergedCellAnchor(xml, reference)`: false for a cell covered by a merged area that is not its top-left cell.
pub fn merged_cell_anchor(xml: &str, reference: &str) -> Result<bool, String> {
    let parsed = parse_cell_ref(reference)?;
    let column = column_number(&parsed.col);
    let row = parsed.row as f64;
    for entry in merged_ranges(xml) {
        let area = parse_area_range(&entry)?;
        if area.start_col <= column && column <= area.end_col && area.start_row <= row && row <= area.end_row {
            return Ok(area.start_col == column && area.start_row == row);
        }
    }
    Ok(true)
}

static SHEET_VIEW_OPEN: LazyLock<JsRegex> = regex!(r"^<sheetView\b([^>]*?)(\/>|>)", "");
static SHEET_VIEW: LazyLock<JsRegex> = regex!(r"<sheetView\b[^>]*?(?:\/>|>[\s\S]*?<\/sheetView>)", "");

/// A sheet view cut into its attributes and its content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetViewParts {
    pub attrs: String,
    pub body: String,
}

/// `sheetViewParts(view)`.
pub fn sheet_view_parts(view: &str) -> Result<SheetViewParts, String> {
    let open = SHEET_VIEW_OPEN.captures(view).ok_or_else(|| "Worksheet view is malformed".to_owned())?;
    let attrs = open.get(1).unwrap_or("").to_owned();
    if open.get(2) == Some("/>") {
        return Ok(SheetViewParts { attrs, body: String::new() });
    }
    let start = open.range().end;
    // A missing closing tag cuts the last character, as `slice(start, -1)` does.
    let end = view.rfind("</sheetView>").unwrap_or_else(|| view.len() - view.chars().next_back().map_or(0, char::len_utf8));
    Ok(SheetViewParts { attrs, body: view.get(start..end).unwrap_or("").to_owned() })
}

/// `composeSheetView(attrs, body)`.
pub fn compose_sheet_view(attrs: &str, body: &str) -> String {
    if body.is_empty() { format!("<sheetView{attrs}/>") } else { format!("<sheetView{attrs}>{body}</sheetView>") }
}

/// `updateSheetView(xml, mutate)`: the first sheet view (a default one when there is none) changed by `mutate` and written
/// back in place.
pub fn update_sheet_view(xml: &str, mutate: impl FnOnce(&str) -> Result<String, String>) -> Result<String, String> {
    let current = worksheet_section(xml, "sheetViews")
        .and_then(|section| SHEET_VIEW.find(&xml[section.clone()]).map(|view| xml[section.start + view.start..section.start + view.end].to_owned()))
        .unwrap_or_default();
    let next = mutate(if current.is_empty() { "<sheetView workbookViewId=\"0\"/>" } else { current.as_str() })?;
    Ok(upsert_worksheet_section(xml, "sheetViews", &format!("<sheetViews>{next}</sheetViews>")))
}

/// `freezePaneXml(row, column)`: the pane element that freezes the rows above `row` and the columns left of `column`
/// (both 1-based, so 1 freezes nothing); empty when nothing is frozen.
pub fn freeze_pane_xml(row: f64, column: f64) -> String {
    let count = |value: f64| {
        let number = if value.is_nan() { 0.0 } else { value };
        math::max(0.0, number - 1.0)
    };
    let y_split = count(row);
    let x_split = count(column);
    if y_split == 0.0 && x_split == 0.0 {
        return String::new();
    }
    let top_left = format!("{}{}", column_label(x_split + 1.0), number_to_string(y_split + 1.0));
    let active_pane = if y_split != 0.0 && x_split != 0.0 {
        "bottomRight"
    } else if y_split != 0.0 {
        "bottomLeft"
    } else {
        "topRight"
    };
    format!(
        "<pane{}{} topLeftCell=\"{top_left}\" activePane=\"{active_pane}\" state=\"frozen\"/>",
        if x_split != 0.0 { format!(" xSplit=\"{}\"", number_to_string(x_split)) } else { String::new() },
        if y_split != 0.0 { format!(" ySplit=\"{}\"", number_to_string(y_split)) } else { String::new() },
    )
}

/// A parsed area: columns and rows (1-based; 0 where the reference names only rows or only columns).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub start_col: f64,
    pub end_col: f64,
    pub start_row: f64,
    pub end_row: f64,
}

static COLUMN_AREA: LazyLock<JsRegex> = regex!(r"^([A-Z]+):([A-Z]+)$", "");
static ROW_AREA: LazyLock<JsRegex> = regex!(r"^(\d+):(\d+)$", "");
static CELL_AREA: LazyLock<JsRegex> = regex!(r"^([A-Z]+\d+):([A-Z]+\d+)$", "");
static SINGLE_CELL: LazyLock<JsRegex> = regex!(r"^[A-Z]+\d+$", "");

/// `parseAreaRange(range)`: `A:C`, `2:5`, `A1:D5` or `A1`.
pub fn parse_area_range(range: &str) -> Result<Area, String> {
    let text = js_trim(range).to_uppercase();
    if let Some(columns) = COLUMN_AREA.captures(&text) {
        return Ok(Area {
            start_col: column_number(columns.get(1).unwrap_or("")),
            end_col: column_number(columns.get(2).unwrap_or("")),
            start_row: 0.0,
            end_row: 0.0,
        });
    }
    if let Some(rows) = ROW_AREA.captures(&text) {
        return Ok(Area {
            start_col: 0.0,
            end_col: 0.0,
            start_row: string_to_number(rows.get(1).unwrap_or("")),
            end_row: string_to_number(rows.get(2).unwrap_or("")),
        });
    }
    if let Some(area) = CELL_AREA.captures(&text) {
        let start = parse_cell_ref(area.get(1).unwrap_or(""))?;
        let end = parse_cell_ref(area.get(2).unwrap_or(""))?;
        let (start_col, end_col) = (column_number(&start.col), column_number(&end.col));
        let (start_row, end_row) = (start.row as f64, end.row as f64);
        return Ok(Area {
            start_col: math::min(start_col, end_col),
            end_col: math::max(start_col, end_col),
            start_row: math::min(start_row, end_row),
            end_row: math::max(start_row, end_row),
        });
    }
    if SINGLE_CELL.is_match(&text) {
        let single = parse_cell_ref(&text)?;
        let column = column_number(&single.col);
        return Ok(Area { start_col: column, end_col: column, start_row: single.row as f64, end_row: single.row as f64 });
    }
    // A sheet-qualified reference is a near miss, not a malformed range: say where the sheet belongs instead of reporting
    // the whole string as unusable.
    if range.contains('!') {
        return Err(format!(
            "Range \"{range}\" carries a sheet name; pass the cells alone (A1:D25) and name the sheet in the operation's sheet field"
        ));
    }
    Err(format!("Unsupported range: {range}"))
}

/// `areaReference(area)`: a parsed area written back as the bounded reference Excel reads (`A1:D5`): the inverse of
/// [`parse_area_range`], and the one spelling every operation that records a range uses.
pub fn area_reference(area: &Area) -> String {
    format!(
        "{}{}:{}{}",
        column_label(area.start_col),
        number_to_string(area.start_row),
        column_label(area.end_col),
        number_to_string(area.end_row)
    )
}

/// Hangul, CJK and fullwidth forms take two character cells of a column.
fn is_wide_character(character: char) -> bool {
    matches!(
        character,
        '\u{1100}'..='\u{115F}'
            | '\u{2E80}'..='\u{A4CF}'
            | '\u{AC00}'..='\u{D7A3}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{FE30}'..='\u{FE6F}'
            | '\u{FF00}'..='\u{FF60}'
            | '\u{FFE0}'..='\u{FFE6}'
    )
}

/// `displayWidth(text)`: the character cells a text takes.
pub fn display_width(text: &str) -> usize {
    text.chars().map(|character| if is_wide_character(character) { 2 } else { 1 }).sum()
}

/// A column width counts characters of the workbook's default size (the first cell style's face), so a cell set larger
/// needs proportionally more of it. Bold type runs about a fifth wider: a 27 pt bold "47.0%" measured 12.3 characters by
/// size alone, passed in a 14-character column, and printed ### (it fits from 14.7). autofit_range sizes a column by this
/// measure and the fit audits check against it.
const BOLD_WIDTH: f64 = 1.2;

/// `cellWidthScale(style, baseSize, { isDefault })`.
pub fn cell_width_scale(style: Option<&Value>, base_size: f64, is_default: bool) -> f64 {
    let size = to_number_of(style.and_then(|style| style.get("fontSize")));
    let size = if size.is_nan() || size == 0.0 { base_size } else { size };
    let bold = style.and_then(|style| style.get("bold")).is_some_and(truthy);
    (size / base_size) * if bold && !is_default { BOLD_WIDTH } else { 1.0 }
}

static DATE_TOKENS: LazyLock<JsRegex> = regex!(r#"(?:^|[^\\"'])[ymdhs]"#, "i");
static QUOTED_TEXT: LazyLock<JsRegex> = regex!(r#""[^"]*""#, "g");
static DATE_PIECE: LazyLock<JsRegex> = regex!(r#"(y+|m+|d+|h+|s+|am\/pm|a\/p)|"([^"]*)"|\\(.)|\[[^\]]*\]|(.)"#, "gi");
static TRAILING_EXPONENT_ZEROS: LazyLock<JsRegex> = regex!(r"\.?0+e", "");

/// The `;`-separated sections of a number format; a quoted text and an escaped character hold their `;`.
fn format_sections(code: &str) -> Vec<String> {
    let characters: Vec<char> = code.chars().collect();
    let mut sections = Vec::new();
    let mut current = String::new();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == '"' {
            let close = characters[index + 1..].iter().position(|c| *c == '"').map(|at| index + 1 + at);
            let end = close.unwrap_or(characters.len());
            current.extend(characters[index..(end + 1).min(characters.len())].iter());
            index = end;
        } else if character == '\\' {
            current.extend(characters[index..(index + 2).min(characters.len())].iter());
            index += 1;
        } else if character == ';' {
            sections.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
        index += 1;
    }
    sections.push(current);
    sections
}

/// Roughly what a date format prints: each token as the characters it renders.
fn date_width(section: &str) -> usize {
    let mut width = 0;
    for piece in DATE_PIECE.captures_iter(section) {
        if let Some(repeated) = piece.get(1).filter(|text| !text.is_empty()) {
            let size = repeated.chars().count();
            let letter = repeated.chars().next().map_or(' ', |c| c.to_ascii_lowercase());
            width += if letter == 'a' {
                2
            } else if size >= 4 {
                if letter == 'y' { 4 } else { 9 }
            } else if size == 3 {
                3
            } else {
                2
            };
        } else if let Some(text) = piece.get(2).or_else(|| piece.get(3)).or_else(|| piece.get(4)) {
            width += display_width(text);
        }
    }
    width
}

/// `Number.prototype.toExponential(digits)`: the mantissa rounded half up on the exact binary value, an exponent with a
/// sign.
fn to_exponential(number: f64, digits: usize) -> String {
    if !number.is_finite() {
        return number_to_string(number);
    }
    // 40 digits show the exact value far enough to tell a tie from a near miss for any double.
    let exact = format!("{:.40e}", number.abs());
    let (mantissa, exponent) = exact.split_once('e').unwrap_or((&exact, "0"));
    let mut exponent: i32 = exponent.parse().unwrap_or(0);
    let all: Vec<u8> = mantissa.bytes().filter(u8::is_ascii_digit).collect();
    let mut kept: Vec<u8> = all[..=digits].to_vec();
    if all.get(digits + 1).is_some_and(|next| *next >= b'5') {
        let mut at = kept.len();
        loop {
            if at == 0 {
                kept.insert(0, b'1');
                kept.pop();
                exponent += 1;
                break;
            }
            at -= 1;
            if kept[at] == b'9' {
                kept[at] = b'0';
            } else {
                kept[at] += 1;
                break;
            }
        }
    }
    let head = char::from(kept[0]);
    let tail = String::from_utf8_lossy(&kept[1..]).into_owned();
    let sign = if number < 0.0 { "-" } else { "" };
    let dot = if tail.is_empty() { String::new() } else { format!(".{tail}") };
    format!("{sign}{head}{dot}e{}{}", if exponent < 0 { '-' } else { '+' }, exponent.abs())
}

/// What Excel's General format prints: eleven characters at most, the decimals rounded to fit with trailing zeros dropped,
/// scientific notation past that. Counted from the stored digits, float noise such as 0.5700000000000001 measured eighteen
/// characters for the 0.57 on the sheet.
fn general_number_text(number: f64) -> String {
    let plain = number_to_string(number);
    if plain.len() <= 11 {
        return plain;
    }
    let magnitude = number.abs();
    if magnitude >= 1e11 || magnitude < 1e-9 {
        let text = to_exponential(number, 5);
        let trimmed = match TRAILING_EXPONENT_ZEROS.find(&text) {
            Some(range) => format!("{}e{}", &text[..range.start], &text[range.end..]),
            None => text,
        };
        return trimmed.to_uppercase();
    }
    let integer_digits = if magnitude < 1.0 { 1.0 } else { magnitude.log10().floor() + 1.0 };
    let decimals = math::max(0.0, 10.0 - if number < 0.0 { 1.0 } else { 0.0 } - integer_digits);
    number_to_string(string_to_number(&math::to_fixed(number, decimals as usize)))
}

/// `formattedNumberWidth(value, format)`: Excel prints a number through its format, so the characters a column has to hold
/// are the digits it renders plus every literal the format carries: a won sign, a "won" suffix, the space an `_)` reserves.
/// A column narrower than this shows ### instead of the value, which is why both the fit audit and autofit_range measure
/// the formatted text rather than the stored number. `value` is `None` for `undefined`.
pub fn formatted_number_width(value: Option<&Value>, format: &str) -> usize {
    let number = to_number_of(value);
    if !number.is_finite() {
        return display_width(&match value {
            Some(value) if !value.is_null() => value_to_string(value),
            _ => String::new(),
        });
    }
    let code = js_trim(format);
    if code.is_empty() || code.eq_ignore_ascii_case("general") || code == "@" {
        return display_width(&general_number_text(number));
    }
    let sections = format_sections(code);
    let chosen = if number < 0.0 {
        sections.get(1).unwrap_or(&sections[0])
    } else if number == 0.0 {
        sections.get(2).unwrap_or(&sections[0])
    } else {
        &sections[0]
    };
    let section = chosen.as_str();
    if DATE_TOKENS.is_match(&QUOTED_TEXT.replace_all_with(section, |_| String::new())) {
        return date_width(section);
    }
    let characters: Vec<char> = section.chars().collect();
    let find_from = |target: char, from: usize| characters.get(from..).and_then(|rest| rest.iter().position(|c| *c == target)).map(|at| from + at);
    let mut literals = String::new();
    let mut zero_places = 0_usize;
    let mut decimals = 0_usize;
    let mut grouped = false;
    let mut percent = 0_i32;
    let mut thousands = 0_i32;
    let mut fraction = false;
    let mut seen_dot = false;
    let mut seen_placeholder = false;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        match character {
            '"' => {
                let close = find_from('"', index + 1);
                literals.extend(characters[index + 1..close.unwrap_or(characters.len())].iter());
                index = close.unwrap_or(characters.len());
            }
            '\\' => {
                if let Some(next) = characters.get(index + 1) {
                    literals.push(*next);
                }
                index += 1;
            }
            // _x reserves the width of x; *x repeats a fill character that never widens the column.
            '_' => {
                literals.push(' ');
                index += 1;
            }
            '*' => index += 1,
            '[' => {
                let close = find_from(']', index + 1);
                let body: String = characters[index + 1..close.unwrap_or(characters.len())].iter().collect();
                // [$won-412] carries a currency symbol; a colour or condition prints nothing.
                if let Some(symbol) = body.strip_prefix('$') {
                    literals.push_str(symbol.split('-').next().unwrap_or(""));
                }
                index = close.unwrap_or(characters.len());
            }
            '0' | '#' | '?' => {
                seen_placeholder = true;
                if seen_dot {
                    decimals += 1;
                } else if character == '0' {
                    zero_places += 1;
                }
            }
            '.' => seen_dot = true,
            '/' => fraction = true,
            ',' => {
                // A comma between digit placeholders groups thousands; one after the last placeholder divides the value
                // by a thousand per comma. (At the very end of the section `'0#?'.includes('')` holds, so it groups.)
                if !seen_dot && characters.get(index + 1).is_none_or(|next| "0#?".contains(*next)) {
                    grouped = true;
                } else if seen_placeholder {
                    thousands += 1;
                }
            }
            '%' => {
                percent += 1;
                literals.push('%');
            }
            '@' => literals.push_str(&number_to_string(number)),
            other => literals.push(other),
        }
        index += 1;
    }
    let scaled = (math::abs(number) * math::pow(100.0, f64::from(percent))) / math::pow(1000.0, f64::from(thousands));
    let rounded = string_to_number(&math::to_fixed(scaled, decimals.min(20)));
    let digits = number_to_string(rounded.trunc()).len().max(zero_places).max(1);
    let mut width = digits + display_width(&literals);
    if grouped && digits > 3 {
        width += (digits - 1) / 3;
    }
    if decimals > 0 {
        width += decimals + 1;
    }
    // A fraction format prints its numerator and denominator after the integer.
    if fraction {
        width += 3;
    }
    // Without a section of its own, a negative value carries the sign Excel adds.
    if number < 0.0 && sections.len() < 2 {
        width += 1;
    }
    width
}

/// The `<col>` declarations of a worksheet, one per column, as their attribute text.
fn column_attributes(xml: &str) -> BTreeMap<u32, String> {
    static COL: LazyLock<JsRegex> = regex!(r"<col\b([^>]*?)\/>", "g");
    let mut entries = BTreeMap::new();
    if let Some(existing) = worksheet_section(xml, "cols") {
        for found in COL.captures_iter(&xml[existing]) {
            let attrs = found.get(1).unwrap_or("");
            let min = whole(string_to_number(&xml_attribute(attrs, "min")));
            let max = match whole(string_to_number(&xml_attribute(attrs, "max"))) {
                0 => min,
                other => other,
            };
            let mut column = min;
            while column >= 1 && column <= max && column - min < 2048 {
                entries.insert(column, attrs.to_owned());
                column += 1;
            }
        }
    }
    entries
}

/// `Number(text) || 0` as a column or row number.
fn whole(number: f64) -> u32 {
    if number.is_nan() || number < 0.0 { 0 } else { number.min(f64::from(u32::MAX)) as u32 }
}

fn write_column_attributes(xml: &str, entries: &BTreeMap<u32, String>) -> String {
    let body: String = entries
        .iter()
        .map(|(column, attrs)| {
            let text = column.to_string();
            format!("<col{}/>", set_xml_attribute(&set_xml_attribute(attrs, "min", &text), "max", &text))
        })
        .collect();
    upsert_worksheet_section(xml, "cols", &format!("<cols>{body}</cols>"))
}

/// `writeColumnWidths(xml, widths)`: each width written onto what the column already says. A column declaration carries
/// more than its width: hidden keeps a working column out of the sheet, and the outline level and style belong to it too.
/// Replacing the declaration to fit the text put a withheld column back on the page.
pub fn write_column_widths(xml: &str, widths: &[(u32, f64)]) -> String {
    if widths.is_empty() {
        return xml.to_owned();
    }
    let mut entries = column_attributes(xml);
    for (column, width) in widths {
        let previous = entries.get(column).cloned().unwrap_or_else(|| format!(" min=\"{column}\" max=\"{column}\""));
        entries.insert(*column, set_xml_attribute(&set_xml_attribute(&previous, "width", &number_to_string(*width)), "customWidth", "1"));
    }
    write_column_attributes(xml, &entries)
}

/// The rows and columns a sheet does not show.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HiddenAreas {
    pub rows: BTreeSet<u32>,
    pub columns: BTreeSet<u32>,
}

static HIDDEN_FLAG: LazyLock<JsRegex> = regex!(r#"\bhidden="(?:1|true)""#, "");

/// `hiddenSheetAreas(xml)`: what the sheet does not show: a filtered or outlined row, a working column. An appearance
/// check that measures one reports a defect no reader can see, and a reader that quotes one answers with data the workbook
/// withheld.
pub fn hidden_sheet_areas(xml: &str) -> HiddenAreas {
    static ROW: LazyLock<JsRegex> = regex!(r"<row\b([^>]*?)(?:\/>|>)", "g");
    static COLS: LazyLock<JsRegex> = regex!(r"<cols\b[^>]*>([\s\S]*?)<\/cols>", "");
    static COL: LazyLock<JsRegex> = regex!(r"<col\b([^>]*?)\/?>", "g");
    let mut hidden = HiddenAreas::default();
    for found in ROW.captures_iter(xml) {
        let attributes = found.get(1).unwrap_or("");
        if !HIDDEN_FLAG.is_match(attributes) {
            continue;
        }
        let row = whole(string_to_number(&xml_attribute(attributes, "r")));
        if row > 0 {
            hidden.rows.insert(row);
        }
    }
    let declarations = COLS.captures(xml).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
    for found in COL.captures_iter(&declarations) {
        let attributes = found.get(1).unwrap_or("");
        if !HIDDEN_FLAG.is_match(attributes) {
            continue;
        }
        let first = whole(string_to_number(&xml_attribute(attributes, "min")));
        let last = match whole(string_to_number(&xml_attribute(attributes, "max"))) {
            0 => first,
            other => other,
        };
        if first == 0 {
            continue;
        }
        let mut index = first;
        while index <= last && index - first < 2048 {
            hidden.columns.insert(index);
            index += 1;
        }
    }
    hidden
}

/// `writeColumnVisibility(xml, columns, visible)`: a hidden column keeps its width and its values; only the sheet stops
/// showing it. The declarations are stored per range, so each target column is written as its own entry rather than
/// splitting someone else's range by hand.
pub fn write_column_visibility(xml: &str, columns: &[u32], visible: bool) -> String {
    static HIDDEN_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\s*\bhidden="[^"]*""#, "");
    if columns.is_empty() {
        return xml.to_owned();
    }
    let mut entries = column_attributes(xml);
    for column in columns {
        let previous = entries.get(column).cloned().unwrap_or_else(|| format!(" min=\"{column}\" max=\"{column}\" width=\"9.14\" customWidth=\"1\""));
        let attrs = match HIDDEN_ATTRIBUTE.find(&previous) {
            Some(range) => format!("{}{}", &previous[..range.start], &previous[range.end..]),
            None => previous,
        };
        entries.insert(*column, if visible { attrs } else { set_xml_attribute(&attrs, "hidden", "1") });
    }
    write_column_attributes(xml, &entries)
}

static PLAIN_SHEET_NAME: LazyLock<JsRegex> = regex!(r"^[A-Za-z_][A-Za-z0-9_.]*$", "");

/// `quoteSheetName(name)`: the sheet name as a formula writes it.
pub fn quote_sheet_name(name: &str) -> String {
    if PLAIN_SHEET_NAME.is_match(name) { name.to_owned() } else { format!("'{}'", name.replace('\'', "''")) }
}

/// An area of a chart source and the sheet it names (`""` for the sheet the chart stands on).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetArea {
    pub sheet: String,
    pub area: String,
}

static QUALIFIED_AREA: LazyLock<JsRegex> = regex!(r"^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$", "");

/// `sheetQualifiedAreas(range)`: the comma-joined areas of a chart source, each with the sheet it names
/// (`'월별 계산'!A1:A7` is the sheet `월별 계산` and `A1:A7`). Commas inside a quoted sheet name stay in the name, and `$`
/// anchors are dropped: a source reads the same cells either way.
pub fn sheet_qualified_areas(range: &str) -> Vec<SheetArea> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in range.chars() {
        if character == '\'' {
            quoted = !quoted;
        }
        if character == ',' && !quoted {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
    }
    parts.push(current);
    parts
        .iter()
        .map(|part| {
            let text = js_trim(part);
            let found = QUALIFIED_AREA.captures(text);
            let sheet = found
                .as_ref()
                .map(|found| js_trim(&found.get(1).or_else(|| found.get(2)).unwrap_or("").replace("''", "'")).to_owned())
                .unwrap_or_default();
            let area = found.as_ref().map_or(text, |found| found.get(3).unwrap_or("")).replace('$', "");
            SheetArea { sheet, area: js_trim(&area).to_owned() }
        })
        .collect()
}

static ABSOLUTE_PART: LazyLock<JsRegex> = regex!(r"^([A-Za-z]+)(\d+)$", "");

/// `absoluteRange(range)`: each end of a range with its `$` anchors (`A1:B2` is `$A$1:$B$2`).
pub fn absolute_range(range: &str) -> String {
    range
        .split(':')
        .map(|part| match ABSOLUTE_PART.captures(part) {
            Some(found) => format!("${}${}", found.get(1).unwrap_or(""), found.get(2).unwrap_or("")),
            None => part.to_owned(),
        })
        .collect::<Vec<_>>()
        .join(":")
}

static DEFINED_NAMES: LazyLock<JsRegex> = regex!(r"<definedNames\b[^>]*?(?:\/>|>[\s\S]*?<\/definedNames>)", "");
static DEFINED_NAME: LazyLock<JsRegex> = regex!(r"<definedName\b[^>]*?(?:\/>|>[\s\S]*?<\/definedName>)", "g");
static CALC_PR: LazyLock<JsRegex> = regex!(r"<calcPr\b[^>]*?(?:\/>|>[\s\S]*?<\/calcPr>)", "");

/// `upsertDefinedName(xml, entry, matches)`: the defined names without the ones `matches` accepts, and `entry` (when there
/// is one) added; none left removes the section. A new section goes before `calcPr`, else before the closing tag.
pub fn upsert_defined_name(xml: &str, entry: Option<&str>, matches: impl Fn(&str) -> bool) -> String {
    let section = DEFINED_NAMES.find(xml);
    let items: Vec<&str> = match &section {
        Some(range) => DEFINED_NAME.find_iter(&xml[range.clone()]).map(|found| &xml[range.start + found.start..range.start + found.end]).collect(),
        None => Vec::new(),
    };
    let mut kept: Vec<&str> = items.into_iter().filter(|item| !matches(item)).collect();
    if let Some(entry) = entry.filter(|entry| !entry.is_empty()) {
        kept.push(entry);
    }
    let element = if kept.is_empty() { String::new() } else { format!("<definedNames>{}</definedNames>", kept.concat()) };
    if let Some(range) = section {
        return format!("{}{element}{}", &xml[..range.start], &xml[range.end..]);
    }
    if element.is_empty() {
        return xml.to_owned();
    }
    if let Some(calculation) = CALC_PR.find(xml) {
        return insert_at(xml, calculation.start, &element);
    }
    before_closing(xml, &WORKBOOK_END, "</workbook>", &element)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn table_and_defined_names_follow_excel() {
        assert_eq!(safe_workbook_table_name("허브 실적!"), "허브_실적");
        assert_eq!(safe_workbook_table_name("2024 sales"), "_2024_sales");
        assert_eq!(safe_workbook_table_name("A1"), "_A1");
        assert_eq!(safe_workbook_table_name("!!!"), "Table1");
        assert_eq!(workbook_defined_name_fault("Tax Rate"), "it contains a space; use an underscore (Tax_Rate)");
        assert_eq!(workbook_defined_name_fault("A1"), "Excel reads it as a cell reference, not a name");
        assert_eq!(workbook_defined_name_fault("1abc"), "it must start with a letter, underscore, or backslash");
        assert_eq!(workbook_defined_name_fault("a-b+c"), "it contains - +; use letters, digits, underscores, or periods");
        assert_eq!(workbook_defined_name_fault("  "), "a name is required");
        assert_eq!(workbook_defined_name_fault("rate_2"), "");
    }

    #[test]
    fn a_section_is_written_in_schema_order() {
        let xml = "<worksheet><sheetData/><pageMargins/></worksheet>";
        assert_eq!(
            upsert_worksheet_section(xml, "mergeCells", "<mergeCells count=\"1\"/>"),
            "<worksheet><sheetData/><mergeCells count=\"1\"/><pageMargins/></worksheet>"
        );
        assert_eq!(upsert_worksheet_section(xml, "pageMargins", ""), "<worksheet><sheetData/></worksheet>");
        assert_eq!(upsert_worksheet_section(xml, "tableParts", "<tableParts/>"), "<worksheet><sheetData/><pageMargins/><tableParts/></worksheet>");
        let spaced = upsert_worksheet_section("<worksheet><sheetData/></worksheet>\n", "extLst", "<extLst/>");
        assert_eq!(spaced, "<worksheet><sheetData/><extLst/></worksheet>");
    }

    #[test]
    fn merged_ranges_round_trip_without_repeats() {
        let xml = write_merged_ranges("<worksheet><sheetData/></worksheet>", &["a1:b2".to_owned(), "a1:b2".to_owned(), "D4:E5".to_owned()]);
        assert_eq!(xml, "<worksheet><sheetData/><mergeCells count=\"2\"><mergeCell ref=\"a1:b2\"/><mergeCell ref=\"D4:E5\"/></mergeCells></worksheet>");
        assert_eq!(merged_ranges(&xml), vec!["A1:B2", "D4:E5"]);
        assert_eq!(merged_cell_anchor(&xml, "A1").unwrap(), true);
        assert_eq!(merged_cell_anchor(&xml, "B2").unwrap(), false);
        assert_eq!(merged_cell_anchor(&xml, "F9").unwrap(), true);
        assert_eq!(write_merged_ranges(&xml, &[]), "<worksheet><sheetData/></worksheet>");
    }

    #[test]
    fn rows_and_columns_shift_with_their_references() {
        let xml = "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"/><c r=\"B1\"/></row><row r=\"2\"><c r=\"A2\"/></row><row r=\"3\"/></sheetData></worksheet>";
        assert_eq!(
            shift_worksheet_rows(xml, 2.0, 1.0).unwrap(),
            "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"/><c r=\"B1\"/></row><row r=\"3\"><c r=\"A3\"/></row><row r=\"4\"/></sheetData></worksheet>"
        );
        assert_eq!(
            shift_worksheet_rows(xml, 2.0, -1.0).unwrap(),
            "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"/><c r=\"B1\"/></row><row r=\"2\"/></sheetData></worksheet>"
        );
        assert_eq!(
            shift_worksheet_columns(xml, 1.0, 1.0).unwrap(),
            "<worksheet><sheetData><row r=\"1\"><c r=\"B1\"/><c r=\"C1\"/></row><row r=\"2\"><c r=\"B2\"/></row><row r=\"3\"/></sheetData></worksheet>"
        );
        assert_eq!(shift_worksheet_rows("<worksheet/>", 1.0, 1.0).unwrap_err(), "Worksheet is missing sheetData");
    }

    #[test]
    fn scale_rules_and_differential_formats() {
        let options = json!({ "minColor": "#fff", "midColor": "00ff00" });
        let rule = conditional_scale_rule("colorScale", options.as_object().unwrap(), 2);
        assert_eq!(
            rule,
            "<cfRule type=\"colorScale\" priority=\"2\"><colorScale><cfvo type=\"min\"/><cfvo type=\"percentile\" val=\"50\"/><cfvo type=\"max\"/><color rgb=\"FFFFFFFF\"/><color rgb=\"FF00FF00\"/><color rgb=\"FF63BE7B\"/></colorScale></cfRule>"
        );
        assert!(conditional_scale_rule("dataBar", &Map::new(), 1).contains("<color rgb=\"FF638EC6\"/>"));
        let first = append_differential_format("<styleSheet><cellStyles count=\"0\"/></styleSheet>", "ff0000", "");
        assert_eq!(first.id, 0);
        assert_eq!(first.xml, "<styleSheet><cellStyles count=\"0\"/><dxfs count=\"1\"><dxf><font><color rgb=\"FFFF0000\"/></font></dxf></dxfs></styleSheet>");
        assert_eq!(append_differential_format(&first.xml, "ff0000", "").id, 0);
        assert_eq!(append_differential_format(&first.xml, "", "00ff00").id, 1);
    }

    #[test]
    fn views_and_freeze_panes() {
        assert_eq!(freeze_pane_xml(2.0, 1.0), "<pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/>");
        assert_eq!(freeze_pane_xml(3.0, 3.0), "<pane xSplit=\"2\" ySplit=\"2\" topLeftCell=\"C3\" activePane=\"bottomRight\" state=\"frozen\"/>");
        assert_eq!(freeze_pane_xml(1.0, 1.0), "");
        let parts = sheet_view_parts("<sheetView workbookViewId=\"0\"><pane/></sheetView>").unwrap();
        assert_eq!((parts.attrs.as_str(), parts.body.as_str()), (" workbookViewId=\"0\"", "<pane/>"));
        assert_eq!(compose_sheet_view(&parts.attrs, ""), "<sheetView workbookViewId=\"0\"/>");
        assert_eq!(sheet_view_parts("<x/>").unwrap_err(), "Worksheet view is malformed");
        let xml = update_sheet_view("<worksheet><sheetData/></worksheet>", |view| Ok(view.replace("/>", " showGridLines=\"0\"/>"))).unwrap();
        assert_eq!(xml, "<worksheet><sheetViews><sheetView workbookViewId=\"0\" showGridLines=\"0\"/></sheetViews><sheetData/></worksheet>");
    }

    #[test]
    fn areas_parse_and_print() {
        let area = parse_area_range(" d5:b2 ").unwrap();
        assert_eq!(area, Area { start_col: 2.0, end_col: 4.0, start_row: 2.0, end_row: 5.0 });
        assert_eq!(area_reference(&area), "B2:D5");
        assert_eq!(parse_area_range("A:C").unwrap().end_col, 3.0);
        assert_eq!(parse_area_range("2:5").unwrap().end_row, 5.0);
        assert!(parse_area_range("Sheet1!A1:B2").unwrap_err().starts_with("Range \"Sheet1!A1:B2\" carries a sheet name"));
        assert_eq!(parse_area_range("nope").unwrap_err(), "Unsupported range: nope");
    }

    #[test]
    fn widths_count_wide_characters_and_formats() {
        assert_eq!(display_width("abc가나"), 7);
        assert_eq!(formatted_number_width(Some(&json!(1234.5)), "#,##0.00"), 8);
        assert_eq!(formatted_number_width(Some(&json!(0.5)), "0%"), 3);
        assert_eq!(formatted_number_width(Some(&json!(-5)), "0"), 2);
        assert_eq!(formatted_number_width(Some(&json!(1234)), "#,##0\"원\""), 7);
        assert_eq!(formatted_number_width(Some(&json!(46174)), "yyyy-mm-dd"), 10);
        assert_eq!(formatted_number_width(Some(&json!(0.5700000000000001)), ""), 4);
        assert_eq!(formatted_number_width(Some(&json!(123456789012.0)), ""), 11);
        assert_eq!(formatted_number_width(Some(&json!("text")), "0"), 4);
        assert_eq!(formatted_number_width(None, "0"), 0);
        assert_eq!(to_exponential(123_456_500_000.0, 5), "1.23457e+11");
        assert_eq!(to_exponential(9.999_996, 5), "1.00000e+1");
        assert_eq!(cell_width_scale(Some(&json!({ "fontSize": 22, "bold": true })), 11.0, false), 2.0 * 1.2);
    }

    #[test]
    fn column_widths_keep_what_a_declaration_says() {
        let xml = "<worksheet><cols><col min=\"1\" max=\"2\" width=\"5\" hidden=\"1\"/></cols><sheetData/></worksheet>";
        assert_eq!(
            write_column_widths(xml, &[(2, 12.5), (4, 8.0)]),
            "<worksheet><cols><col min=\"1\" max=\"1\" width=\"5\" hidden=\"1\"/><col min=\"2\" max=\"2\" width=\"12.5\" hidden=\"1\" customWidth=\"1\"/><col min=\"4\" max=\"4\" width=\"8\" customWidth=\"1\"/></cols><sheetData/></worksheet>"
        );
        let hidden = hidden_sheet_areas("<worksheet><cols><col min=\"2\" max=\"3\" hidden=\"1\"/></cols><sheetData><row r=\"7\" hidden=\"true\"/><row r=\"8\"/></sheetData></worksheet>");
        assert_eq!(hidden.rows.iter().copied().collect::<Vec<_>>(), vec![7]);
        assert_eq!(hidden.columns.iter().copied().collect::<Vec<_>>(), vec![2, 3]);
        let shown = write_column_visibility(xml, &[1], true);
        assert!(shown.contains("<col min=\"1\" max=\"1\" width=\"5\"/>"));
        assert!(write_column_visibility("<worksheet><sheetData/></worksheet>", &[3], false).contains("<col min=\"3\" max=\"3\" width=\"9.14\" customWidth=\"1\" hidden=\"1\"/>"));
    }

    #[test]
    fn references_and_defined_names() {
        assert_eq!(quote_sheet_name("Data_1"), "Data_1");
        assert_eq!(quote_sheet_name("월별 계산's"), "'월별 계산''s'");
        let areas = sheet_qualified_areas("'월별, 계산'!$A$1:$A$7, B2:B3,Data!C1");
        assert_eq!(areas.len(), 3);
        assert_eq!((areas[0].sheet.as_str(), areas[0].area.as_str()), ("월별, 계산", "A1:A7"));
        assert_eq!((areas[1].sheet.as_str(), areas[1].area.as_str()), ("", "B2:B3"));
        assert_eq!((areas[2].sheet.as_str(), areas[2].area.as_str()), ("Data", "C1"));
        assert_eq!(absolute_range("a1:B2"), "$a$1:$B$2");
        let xml = "<workbook><sheets/><calcPr/></workbook>";
        let added = upsert_defined_name(xml, Some("<definedName name=\"Rate\">0.1</definedName>"), |_| false);
        assert_eq!(added, "<workbook><sheets/><definedNames><definedName name=\"Rate\">0.1</definedName></definedNames><calcPr/></workbook>");
        assert_eq!(upsert_defined_name(&added, None, |item| item.contains("\"Rate\"")), "<workbook><sheets/><calcPr/></workbook>");
        assert_eq!(append_worksheet_section("<worksheet><hyperlinks><hyperlink/></hyperlinks></worksheet>", "hyperlinks", "<hyperlinks/>"), "<worksheet><hyperlinks><hyperlink/></hyperlinks><hyperlinks/></worksheet>");
    }
}
