//! `portable/portable-docx-xml.mjs`: the WordprocessingML builders of the portable Word backend: paragraph, run, table and
//! section-text XML written over the body model, the run, cell and paragraph property merges that keep Word's element order,
//! table widths measured in the table's own face, and the readers of a table's rows, cells and columns with the errors that
//! name the table asked for. The Node code builds XML as text and edits it with patterns; so does this, every pattern a
//! `JsRegex`, and the exact text is what the twin test compares. Properties and operations are JSON values, as the caller's
//! operation list holds them, and every coercion (`Number(x)`, `String(x || '')`, truthiness) is JavaScript's. Offsets are
//! byte offsets into the string searched.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, js_trim, math, number_to_string, slice_utf16, to_number, to_number_of, utf16_len, value_to_string};
use mixdog_office_base::column_widths::natural_column_widths;
use mixdog_office_base::values::truthy;
use serde_json::{Value, json};

use crate::snapshot_docx::{append_docx_block, docx_body_model};
use crate::text_metrics::FontSpec;
use crate::xml::{WORD_RUN_SOURCE, compiled, container_inner, rebuild_text_nodes, text_nodes, top_level_elements, xml_decode, xml_encode};

/// `Math.max(1, Math.round(Number(value) * 20))`.
fn points_to_twips(value: f64) -> f64 {
    math::max(1.0, math::round(value * 20.0))
}

fn twips_text(value: f64) -> String {
    number_to_string(points_to_twips(value))
}

fn num(value: Option<&Value>) -> f64 {
    to_number_of(value)
}

fn present(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// `Number(x) || fallback`.
fn or_else(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || value.is_nan() { fallback } else { value }
}

/// `String(value || '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    value.filter(|value| truthy(value)).map(value_to_string).unwrap_or_default()
}

/// A value as a template literal prints it (`undefined` for an absent one).
fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `String(value).replace(/^#/, '')`.
fn without_hash(value: &str) -> &str {
    value.strip_prefix('#').unwrap_or(value)
}

/// The first match of a pattern replaced by what `with` makes of the matched text (`text.replace(pattern, () => ...)`).
fn replace_first(pattern: &JsRegex, text: &str, with: impl FnOnce(&str) -> String) -> String {
    match pattern.find(text) {
        Some(range) => format!("{}{}{}", &text[..range.start], with(&text[range.clone()]), &text[range.end..]),
        None => text.to_owned(),
    }
}

/// `text.replace(searched, () => replacement)` for a searched string: its first occurrence.
fn replace_first_str(text: &str, searched: &str, replacement: &str) -> String {
    match text.find(searched) {
        Some(at) => format!("{}{}{}", &text[..at], replacement, &text[at + searched.len()..]),
        None => text.to_owned(),
    }
}

// A Word table with no borders and no style is invisible on the page: the rendered document shows three loose columns of
// text, and nothing says the rows belong together. Unless the caller styles the table themselves, it gets the least a reader
// needs, a rule under the header and hairlines between rows, which any explicit borders, style, or shading replaces.
static DEFAULT_TABLE_BORDERS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "top": { "enabled": false },
        "left": { "enabled": false },
        "right": { "enabled": false },
        "bottom": { "style": "single", "size": 4, "color": "BFC5CB" },
        "insideH": { "style": "single", "size": 2, "color": "D8DCE0" },
        "insideV": { "enabled": false },
    })
});

// A rule's line as w:val spells it. The Word backend reads solid (any name it does not know is a single line), dash, and dot;
// written through as given, style:'solid' made a file Word refused to open.
const WORD_BORDER_STYLES: [&str; 11] = ["single", "thick", "double", "dotted", "dashed", "dotDash", "dotDotDash", "triple", "wave", "none", "nil"];

fn word_border_style(style: Option<&Value>) -> String {
    let name = if present(style) { style.map(value_to_string).unwrap_or_default() } else { "single".to_owned() };
    if WORD_BORDER_STYLES.contains(&name.as_str()) {
        return name;
    }
    match js_to_lowercase(&name).as_str() {
        "solid" => "single",
        "dash" => "dashed",
        "dot" => "dotted",
        _ => "single",
    }
    .to_owned()
}

const TABLE_SIDES: [&str; 6] = ["top", "left", "bottom", "right", "insideH", "insideV"];

/// `Object.keys(value).length` of a value a table's borders may be.
fn key_count(value: &Value) -> usize {
    match value {
        Value::Object(map) => map.len(),
        Value::Array(items) => items.len(),
        Value::String(text) => utf16_len(text),
        _ => 0,
    }
}

/// One side's rule of a table's borders: nothing for a spec that is not an object or is switched off.
fn border_rule(side: &str, value: Option<&Value>) -> String {
    let Some(value) = value.filter(|value| value.is_object() || value.is_array()) else { return String::new() };
    if value.get("enabled") == Some(&Value::Bool(false)) {
        return String::new();
    }
    let size = math::max(1.0, or_else(num(value.get("size")), 4.0));
    let space = math::max(0.0, or_else(num(value.get("space")), 0.0));
    let color = if present(value.get("color")) { string_or_empty(value.get("color")) } else { "auto".to_owned() };
    format!(
        "<w:{side} w:val=\"{}\" w:sz=\"{}\" w:space=\"{}\" w:color=\"{}\"/>",
        word_border_style(value.get("style")),
        number_to_string(size),
        number_to_string(space),
        xml_encode(without_hash(&color))
    )
}

/// `wordTableProperties(properties, { totalWidth })`: the table's `w:tblPr` content.
pub fn word_table_properties(properties: &Value, total_width: f64) -> String {
    let style = properties.get("style");
    let shading = properties.get("shading");
    let declared = properties.get("borders").filter(|value| truthy(value));
    let styled = declared.is_some() || present(style) || present(shading);
    let borders: Value = match declared {
        Some(value) => value.clone(),
        None if styled => json!({}),
        None => DEFAULT_TABLE_BORDERS.clone(),
    };
    // Two ways to say it: one spec for every side, or a spec per side. Naming one side used to fall back to the whole object
    // for the others, so asking for a single rule on top drew a full grid.
    let per_side = TABLE_SIDES.iter().any(|side| borders.get(*side).is_some());
    let side_rules: String = TABLE_SIDES.iter().map(|side| border_rule(side, if per_side { borders.get(*side) } else { Some(&borders) })).collect();
    let border_xml = if key_count(&borders) > 0 { format!("<w:tblBorders>{side_rules}</w:tblBorders>") } else { String::new() };
    let table_style = if present(style) {
        format!("<w:tblStyle w:val=\"{}\"/>", xml_encode(&docx_style_id(&value_to_string(style.unwrap_or(&Value::Null)))))
    } else {
        String::new()
    };
    // Declared column widths only hold everywhere (Word, LibreOffice, Google Docs) when the table states its own width too;
    // without it the columns are re-fitted and the layout the caller asked for is lost.
    let width = if total_width > 0.0 {
        format!("<w:tblW w:w=\"{}\" w:type=\"dxa\"/>", number_to_string(math::round(total_width)))
    } else {
        "<w:tblW w:w=\"0\" w:type=\"auto\"/>".to_owned()
    };
    let alignment = if present(properties.get("alignment")) {
        format!("<w:jc w:val=\"{}\"/>", xml_encode(&string_or_empty(properties.get("alignment"))))
    } else {
        String::new()
    };
    let shade = if present(shading) {
        format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{}\"/>", xml_encode(without_hash(&value_to_string(shading.unwrap_or(&Value::Null)))))
    } else {
        String::new()
    };
    [table_style, width, alignment, border_xml, shade].concat()
}

/// The vertical alignments a cell takes: top, center (or middle, as a slide names it), bottom.
fn cell_alignment(name: &str) -> Option<&'static str> {
    match name {
        "top" => Some("top"),
        "center" | "middle" => Some("center"),
        "bottom" => Some("bottom"),
        _ => None,
    }
}

fn word_cell_properties(properties: &Value) -> String {
    let width = properties.get("width");
    let fill = properties.get("fillColor");
    let vertical = cell_alignment(&js_to_lowercase(&string_or_empty(properties.get("verticalAlignment"))));
    [
        if present(width) { format!("<w:tcW w:w=\"{}\" w:type=\"dxa\"/>", twips_text(num(width))) } else { String::new() },
        if present(fill) {
            format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{}\"/>", xml_encode(without_hash(&value_to_string(fill.unwrap_or(&Value::Null)))))
        } else {
            String::new()
        },
        vertical.map(|value| format!("<w:vAlign w:val=\"{value}\"/>")).unwrap_or_default(),
    ]
    .concat()
}

// Word keeps cell properties in a fixed order too. Restyling one cell (a fill on the "after" column head) replaces only the
// properties it names; the width and the vertical alignment the table was written with stay.
const CELL_PROPERTY_ORDER: [&str; 11] =
    ["w:tcW", "w:gridSpan", "w:vMerge", "w:tcBorders", "w:shd", "w:noWrap", "w:tcMar", "w:textDirection", "w:tcFitText", "w:vAlign", "w:hideMark"];

/// `mergeWordCellProperties(cellXml, properties)`: the cell's properties with the ones named replaced in place.
pub fn merge_word_cell_properties(cell_xml: &str, properties: &Value) -> String {
    let mut existing = compiled(r"<w:tcPr(?:\s[^>]*)?>([\s\S]*?)<\/w:tcPr>", "").captures(cell_xml).and_then(|found| found.get(1)).unwrap_or("").to_owned();
    // A filled cell is a field again, and its text needs the padding back: a layout table's flush edge is dropped when the
    // cell takes a fill.
    if present(properties.get("fillColor")) {
        existing = replace_first(&compiled(r#"<w:tcMar>(?:<w:(?:left|right) w:w="0" w:type="dxa"\/>)+<\/w:tcMar>"#, ""), &existing, |_| String::new());
    }
    // fillColor: null takes the shading away, as the Word backend's automatic colour removes it: a data row inserted above a
    // total keeps the total's shading otherwise.
    if properties.get("fillColor") == Some(&Value::Null) {
        existing = replace_first(&compiled(r"<w:shd\b[^>]*\/>", ""), &existing, |_| String::new());
    }
    let inner = merge_word_property_elements(&existing, &word_cell_properties(properties), &CELL_PROPERTY_ORDER);
    replace_word_properties(cell_xml, "tc", "tcPr", &inner)
}

/// `{ bold }` of `wordTableRunProperties`.
fn word_table_run_properties(properties: &Value, bold: bool) -> String {
    let latin = if present(properties.get("fontName")) { xml_encode(&string_or_empty(properties.get("fontName"))) } else { String::new() };
    let east_asia = if present(properties.get("fontNameEastAsia")) { xml_encode(&string_or_empty(properties.get("fontNameEastAsia"))) } else { String::new() };
    let size = num(properties.get("fontSize"));
    let color = properties.get("color");
    [
        run_fonts_xml(&latin, &east_asia),
        if bold { "<w:b/><w:bCs/>".to_owned() } else { String::new() },
        if present(color) {
            format!("<w:color w:val=\"{}\"/>", xml_encode(without_hash(&value_to_string(color.unwrap_or(&Value::Null)))))
        } else {
            String::new()
        },
        if size.is_finite() && size > 0.0 {
            let half = number_to_string(math::round(size * 2.0));
            format!("<w:sz w:val=\"{half}\"/><w:szCs w:val=\"{half}\"/>")
        } else {
            String::new()
        },
    ]
    .concat()
}

// Every cell of a row shares one exact line pitch, 1.3x the size: under a minimum pitch a Hangul label took Malgun Gothic's
// taller line and sat 2 pt above the Latin-only figure beside it (Word, probe 2026-09-25); an exact pitch puts every line's
// baseline at the same height.
fn word_table_paragraph_properties(properties: &Value, keep_next: bool) -> String {
    let spacing = num(properties.get("spacingAfter"));
    let size = if num(properties.get("fontSize")) > 0.0 { num(properties.get("fontSize")) } else { 11.0 };
    let after = if spacing.is_finite() { format!(" w:after=\"{}\"", number_to_string(math::max(0.0, math::round(spacing * 20.0)))) } else { String::new() };
    [
        if present(properties.get("textStyle")) {
            format!("<w:pStyle w:val=\"{}\"/>", xml_encode(&docx_style_id(&string_or_empty(properties.get("textStyle")))))
        } else {
            String::new()
        },
        if keep_next { "<w:keepNext/>".to_owned() } else { String::new() },
        format!("<w:spacing{after} w:line=\"{}\" w:lineRule=\"exact\"/>", number_to_string(exact_line_pitch_twips(size))),
    ]
    .concat()
}

/// The exact line pitch of a table cell set at `size` points, in twips.
pub fn exact_line_pitch_twips(size: f64) -> f64 {
    math::round(size * 1.3 * 20.0)
}

/// `wordJustification(alignment)`: an alignment as Word's w:jc spells it, for a paragraph and for a column's cells. The file
/// takes "both" for justified text: "justify" written as it was named made a file Word refused to open. Empty for a name the
/// file does not know.
pub fn word_justification(alignment: &str) -> &'static str {
    match js_to_lowercase(js_trim(alignment)).as_str() {
        "left" => "left",
        "center" | "centre" => "center",
        "right" => "right",
        "justify" | "both" => "both",
        "distribute" => "distribute",
        _ => "",
    }
}

/// `wordJustification(value)` of a value as an operation holds it (`String(value || '')`).
fn justification_of(value: Option<&Value>) -> &'static str {
    word_justification(&string_or_empty(value))
}

/// `justifyWordParagraphs(cellXml, justification)`: one justification on every paragraph of a cell, replacing the one it had.
pub fn justify_word_paragraphs(cell_xml: &str, justification: &str) -> String {
    if justification.is_empty() {
        return cell_xml.to_owned();
    }
    let jc = compiled(r"<w:jc\b[^>]*\/>", "g");
    compiled(r"<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>", "g").replace_all_with(cell_xml, |found| {
        let paragraph = found.get(0).unwrap_or("");
        let stripped = jc.replace_all_with(paragraph, |_| String::new());
        if compiled(r"<w:pPr(?:\s[^>]*)?>", "").is_match(&stripped) {
            replace_first_str(&stripped, "</w:pPr>", &format!("<w:jc w:val=\"{justification}\"/></w:pPr>"))
        } else {
            replace_first(&compiled(r"^(<w:p(?:\s[^>]*)?>)", ""), &stripped, |open| format!("{open}<w:pPr><w:jc w:val=\"{justification}\"/></w:pPr>"))
        }
    })
}

/// `alignWordTableColumns(tableXml, columnAlignments)`: per-column text alignment applied to an existing table.
pub fn align_word_table_columns(table_xml: &str, column_alignments: &[Value]) -> String {
    let justifications: Vec<&str> = column_alignments.iter().map(|value| justification_of(Some(value))).collect();
    if !justifications.iter().any(|value| !value.is_empty()) {
        return table_xml.to_owned();
    }
    let mut next = table_xml.to_owned();
    for row in table_row_matches(table_xml) {
        let mut next_row = row.xml.clone();
        for (column, cell) in row_cell_matches(&row.xml).iter().enumerate() {
            let Some(justification) = justifications.get(column).filter(|value| !value.is_empty()) else { continue };
            next_row = replace_first_str(&next_row, &cell.xml, &justify_word_paragraphs(&cell.xml, justification));
        }
        next = replace_first_str(&next, &row.xml, &next_row);
    }
    next
}

// A table with every rule switched off and no fill is a layout grid (a resume's role and date, a signature block): nothing
// marks its edges, so its cell padding shows as an indent. Its outer cells drop the padding on the page side, so the text
// registers with the paragraphs around it; the padding between columns stays.
fn is_layout_table(properties: &Value) -> bool {
    if present(properties.get("style")) || present(properties.get("shading")) {
        return false;
    }
    let Some(borders) = properties.get("borders").filter(|value| value.is_object() || value.is_array()) else { return false };
    if borders.get("enabled") == Some(&Value::Bool(false)) {
        return true;
    }
    TABLE_SIDES.iter().all(|side| borders.get(*side).and_then(|rule| rule.get("enabled")) == Some(&Value::Bool(false)))
}

/// `sectionTextWidth(document, position)`: the text width, in twips, of the section a block sits in: the first section
/// properties after it close that section. Measured against the document's first section, a table on a landscape page was
/// reported as 3.4 in wider than its column.
pub fn section_text_width(document: &str, position: usize) -> f64 {
    let section_pattern = compiled(r"<w:sectPr\b[\s\S]*?<\/w:sectPr>", "");
    let after = document.get(position..).unwrap_or("");
    let section = section_pattern.find(after).map(|range| &after[range]).or_else(|| section_pattern.find(document).map(|range| &document[range])).unwrap_or("");
    let page = compiled(r#"<w:pgSz\b[^>]*\bw:w="(\d+)""#, "").captures(section).and_then(|found| found.get(1).map(str::to_owned));
    let margins = compiled(r#"<w:pgMar\b[^>]*\bw:left="(\d+)"[^>]*\bw:right="(\d+)""#, "")
        .captures(section)
        .and_then(|found| Some((found.get(1)?.to_owned(), found.get(2)?.to_owned())))
        .or_else(|| {
            compiled(r#"<w:pgMar\b[^>]*\bw:right="(\d+)"[^>]*\bw:left="(\d+)""#, "")
                .captures(section)
                .and_then(|found| Some((found.get(1)?.to_owned(), found.get(2)?.to_owned())))
        });
    let digits = |text: &str| to_number(&Value::String(text.to_owned()));
    page.map_or(12240.0, |width| digits(&width)) - margins.map_or(2880.0, |(a, b)| digits(&a) + digits(&b))
}

/// Word's default cell padding, left and right together, in points.
const CELL_PADDING_POINTS: f64 = 10.8;

/// What a measure of text width answers to: the width in px of one line set in a face, or the reason it cannot be measured.
pub type MeasureText<'a, E> = &'a mut dyn FnMut(&str, &FontSpec) -> Result<f64, E>;

fn table_text_rows(values: &Value) -> Vec<Vec<String>> {
    values
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.as_array()
                        .map(|cells| cells.iter().map(|cell| if cell.is_null() { String::new() } else { value_to_string(cell) }).collect())
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default()
}

fn table_face_name(properties: &Value) -> String {
    if present(properties.get("fontName")) {
        string_or_empty(properties.get("fontName"))
    } else if present(properties.get("fontNameEastAsia")) {
        string_or_empty(properties.get("fontNameEastAsia"))
    } else {
        "Calibri".to_owned()
    }
}

/// `naturalTableColumnWidths(values, properties, available)`: column widths, in points, for a table the caller gave no
/// widths, across the text width (`natural_column_widths`), measured in the table's own face. The widths are always
/// written: a grid without them spans the page in the LibreOffice preview and shrinks to its text in Word. `None` when the
/// table has no column or nothing is available.
pub fn natural_table_column_widths<E>(values: &Value, properties: &Value, available: f64, measure: MeasureText<'_, E>) -> Result<Option<Vec<f64>>, E> {
    let rows = table_text_rows(values);
    let name = table_face_name(properties);
    let base_size = if num(properties.get("fontSize")) > 0.0 { num(properties.get("fontSize")) } else { 11.0 };
    let header_bold = table_header_bold(properties, rows.len());
    let headers = table_header_rows(properties, rows.len());
    let gutters = if is_layout_table(properties) { Vec::new() } else { gutter_columns(properties) };
    let mut failure: Option<E> = None;
    let widths = natural_column_widths(
        &rows,
        |text, row, column| {
            if failure.is_some() {
                return 0.0;
            }
            let own = table_row_style(properties, row).map(|style| num(style.get("fontSize"))).filter(|size| *size > 0.0);
            let font = FontSpec {
                font_name: Some(name.clone()),
                font_size: Some(own.unwrap_or(base_size)),
                bold: row_bold(properties, row, rows.len(), header_bold && row < headers),
                italic: false,
            };
            match measure(text, &font) {
                Ok(width) => width * 1.05 + CELL_PADDING_POINTS + if gutters.get(column).copied().unwrap_or(false) { GUTTER_POINTS } else { 0.0 },
                Err(error) => {
                    failure = Some(error);
                    0.0
                }
            }
        },
        available,
    );
    match failure {
        Some(error) => Err(error),
        None => Ok(widths),
    }
}

// Room before a column of words that follows a column of figures: set right, the figure ran into the note beside it ("96 내부
// 인력 4명") across the cells' own padding alone. The words' cells take a gutter on their left.
const GUTTER_POINTS: f64 = 8.0;

fn gutter_columns(properties: &Value) -> Vec<bool> {
    let alignments: Vec<String> = properties
        .get("columnAlignments")
        .and_then(Value::as_array)
        .map(|list| list.iter().map(|value| js_to_lowercase(&string_or_empty(Some(value)))).collect())
        .unwrap_or_default();
    alignments
        .iter()
        .enumerate()
        .map(|(column, alignment)| column > 0 && alignments[column - 1] == "right" && (alignment == "left" || alignment == "justify"))
        .collect()
}

fn gutter_margin(gutter: bool) -> String {
    if gutter {
        format!("<w:tcMar><w:left w:w=\"{}\" w:type=\"dxa\"/></w:tcMar>", twips_text(CELL_PADDING_POINTS / 2.0 + GUTTER_POINTS))
    } else {
        String::new()
    }
}

// The rows a table's header takes: one, or more for a header of several levels (a group label over the columns it spans is
// two). At least one row stays data.
fn table_header_rows(properties: &Value, rows: usize) -> usize {
    let asked = math::floor(or_else(num(properties.get("headerRows")), 1.0));
    math::max(1.0, math::min(rows as f64 - 1.0, asked)) as usize
}

// The header row is set apart by weight unless the caller opts out (headerBold, or repeatHeader: false for a table whose
// first row is data); a one-row table has no header to set apart.
fn table_header_bold(properties: &Value, rows: usize) -> bool {
    rows > 1 && properties.get("headerBold") != Some(&Value::Bool(false)) && properties.get("repeatHeader") != Some(&Value::Bool(false))
}

// One row's own type (rowStyles[row]: fontSize, color, bold): a stat strip sets its figures at 22 pt and the labels under
// them at 9 pt in one table, where a single fontSize set the labels at 22 pt too.
fn table_row_style(properties: &Value, row: usize) -> Option<&Value> {
    properties.get("rowStyles").and_then(Value::as_array).and_then(|styles| styles.get(row)).filter(|style| style.is_object() || style.is_array())
}

// The last row is the total when totalRow is set: bold over a rule, so it reads as the sum of the rows above it and not as
// one more of them.
fn is_total_row(properties: &Value, row: usize, rows: usize) -> bool {
    properties.get("totalRow") == Some(&Value::Bool(true)) && rows > 1 && row + 1 == rows
}

const TOTAL_ROW_RULE_SIZE: u32 = 8;
const TOTAL_ROW_RULE_COLOR: &str = "374151";

/// A row's weight: its own rowStyles bold when given, else the header's or the total's.
fn row_bold(properties: &Value, row: usize, rows: usize, header: bool) -> bool {
    if let Some(Value::Bool(own)) = table_row_style(properties, row).and_then(|style| style.get("bold")) {
        return *own;
    }
    header || is_total_row(properties, row, rows)
}

/// A row's type properties: the table's, with its own rowStyles size and ink over them.
fn row_type_properties(properties: &Value, row: usize) -> Value {
    let Some(style) = table_row_style(properties, row) else { return properties.clone() };
    let mut merged = properties.as_object().cloned().unwrap_or_default();
    if num(style.get("fontSize")) > 0.0 {
        merged.insert("fontSize".to_owned(), json!(num(style.get("fontSize"))));
    }
    if present(style.get("color")) {
        merged.insert("color".to_owned(), style.get("color").cloned().unwrap_or(Value::Null));
    }
    Value::Object(merged)
}

fn flush_cell_margins(first: bool, last: bool) -> String {
    if !first && !last {
        return String::new();
    }
    let left = if first { "<w:left w:w=\"0\" w:type=\"dxa\"/>" } else { "" };
    let right = if last { "<w:right w:w=\"0\" w:type=\"dxa\"/>" } else { "" };
    format!("<w:tcMar>{left}{right}</w:tcMar>")
}

/// A list of numbers an operation declares (`columnWidths`, `rowHeights`): each entry as `Number(entry)`.
fn number_list(value: Option<&Value>) -> Vec<f64> {
    value.filter(|value| truthy(value)).and_then(Value::as_array).map(|list| list.iter().map(|entry| to_number(entry)).collect()).unwrap_or_default()
}

fn truthy_number(value: Option<f64>) -> Option<f64> {
    value.filter(|number| *number != 0.0 && !number.is_nan())
}

/// A page break never strands a table's edge: the header travels with the first two rows and the last two rows travel together;
/// a table of six rows or fewer moves whole. The last row is held to what follows only when keepWithNext asks.
fn row_kept_with_next(properties: &Value, row: usize, rows: usize, headers: usize) -> bool {
    if row + 1 < rows { rows <= 6 || row <= headers || row + 2 == rows } else { present(properties.get("keepWithNext")) }
}

/// The opening of a row: a header row repeats on every page a table breaks across, and a row height is a minimum.
fn table_row_open(repeats_as_header: bool, height: Option<f64>) -> String {
    let properties = [
        if repeats_as_header { "<w:tblHeader/>".to_owned() } else { String::new() },
        match truthy_number(height) {
            Some(height) => format!("<w:trHeight w:val=\"{}\" w:hRule=\"atLeast\"/>", twips_text(height)),
            None => String::new(),
        },
    ]
    .concat();
    if properties.is_empty() { "<w:tr>".to_owned() } else { format!("<w:tr><w:trPr>{properties}</w:trPr>") }
}

/// A cell's text as runs: a line break in the text is a `<w:br/>`, since Word collapses a literal newline inside one text element.
fn cell_text_runs(text: &str) -> String {
    split_lines(text).iter().enumerate().map(|(index, line)| format!("{}{}", if index > 0 { "<w:br/>" } else { "" }, word_text_element(line, false))).collect()
}

/// `wordTableXml(operation, { available })`: the table an operation (`values`, `rows`, `columns`, `properties`) describes.
/// `available` is the text width, in points, of the section the table lands in; `measure` answers the width in px of a line
/// in a face, for the column widths of a table that names none.
pub fn word_table_xml<E>(operation: &Value, available: f64, measure: MeasureText<'_, E>) -> Result<String, E> {
    let values: Vec<&Value> = operation.get("values").and_then(Value::as_array).map(|rows| rows.iter().collect()).unwrap_or_default();
    let longest_row = values.iter().map(|row| row.as_array().map_or(0, Vec::len)).max().unwrap_or(0);
    let no_properties = Value::Null;
    let properties = operation.get("properties").unwrap_or(&no_properties);
    let layout = is_layout_table(properties);
    let rows = math::max(1.0, or_else(num(operation.get("rows")), if values.is_empty() { 1.0 } else { values.len() as f64 })) as usize;
    let columns = math::max(1.0, or_else(num(operation.get("columns")), if longest_row == 0 { 1.0 } else { longest_row as f64 })) as usize;
    let widths: Vec<f64> = if present(properties.get("columnWidths")) {
        number_list(properties.get("columnWidths"))
    } else if columns == longest_row {
        natural_table_column_widths(operation.get("values").unwrap_or(&Value::Null), properties, available, measure)?.unwrap_or_default()
    } else {
        Vec::new()
    };
    let heights = number_list(properties.get("rowHeights"));
    let justifications: Vec<&str> = properties
        .get("columnAlignments")
        .and_then(Value::as_array)
        .map(|list| list.iter().map(|value| justification_of(Some(value))).collect())
        .unwrap_or_default();
    let header_bold = table_header_bold(properties, rows);
    let headers = table_header_rows(properties, rows);
    let row_run_properties =
        |row: usize| word_table_run_properties(&row_type_properties(properties, row), row_bold(properties, row, rows, header_bold && row < headers));
    let total_border =
        format!("<w:tcBorders><w:top w:val=\"single\" w:sz=\"{TOTAL_ROW_RULE_SIZE}\" w:space=\"0\" w:color=\"{TOTAL_ROW_RULE_COLOR}\"/></w:tcBorders>");
    let gutters = if layout { Vec::new() } else { gutter_columns(properties) };
    let paragraph_properties =
        |row: usize| word_table_paragraph_properties(&row_type_properties(properties, row), row_kept_with_next(properties, row, rows, headers));
    let grid: String = (0..columns)
        .map(|column| match truthy_number(widths.get(column).copied()) {
            Some(width) => format!("<w:gridCol w:w=\"{}\"/>", twips_text(width)),
            None => "<w:gridCol/>".to_owned(),
        })
        .collect();
    let repeat_header = properties.get("repeatHeader") != Some(&Value::Bool(false));
    let mut body = String::new();
    for row in 0..rows {
        body.push_str(&table_row_open(row < headers && repeat_header, heights.get(row).copied()));
        for column in 0..columns {
            let cell = values.get(row).and_then(|cells| cells.get(column)).filter(|cell| !cell.is_null());
            let text = cell.map(value_to_string).unwrap_or_default();
            let width = match truthy_number(widths.get(column).copied()) {
                Some(width) => format!("<w:tcW w:w=\"{}\" w:type=\"dxa\"/>", twips_text(width)),
                None => String::new(),
            };
            let runs = cell_text_runs(&text);
            let justification = justifications.get(column).copied().filter(|value| !value.is_empty());
            let cell_paragraph_properties =
                format!("{}{}", paragraph_properties(row), justification.map(|value| format!("<w:jc w:val=\"{value}\"/>")).unwrap_or_default());
            let cell_run_properties = row_run_properties(row);
            let margins =
                if layout { flush_cell_margins(column == 0, column + 1 == columns) } else { gutter_margin(gutters.get(column).copied().unwrap_or(false)) };
            let edge = if row < headers && header_bold { "bottom" } else { "top" };
            let rule = if is_total_row(properties, row, rows) { total_border.as_str() } else { "" };
            body.push_str(&format!(
                "<w:tc><w:tcPr>{width}{rule}{margins}<w:vAlign w:val=\"{edge}\"/></w:tcPr><w:p>{}<w:r>{}{runs}</w:r></w:p></w:tc>",
                if cell_paragraph_properties.is_empty() { String::new() } else { format!("<w:pPr>{cell_paragraph_properties}</w:pPr>") },
                if cell_run_properties.is_empty() { String::new() } else { format!("<w:rPr>{cell_run_properties}</w:rPr>") },
            ));
        }
        body.push_str("</w:tr>");
    }
    let total_width = if widths.len() == columns { widths.iter().map(|width| points_to_twips(*width)).sum::<f64>() } else { 0.0 };
    Ok(format!("<w:tbl><w:tblPr>{}</w:tblPr><w:tblGrid>{grid}</w:tblGrid>{body}</w:tbl>", word_table_properties(properties, total_width)))
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    lines
}

/// `insertDocxBlockAt(documentXml, block, paragraphNumber)`: the block placed after the numbered paragraph (1-based), or at the
/// end of the body when no number is given.
pub fn insert_docx_block_at(document_xml: &str, block: &str, paragraph_number: f64) -> Result<String, String> {
    if paragraph_number == 0.0 || paragraph_number.is_nan() {
        return append_docx_block(document_xml, block);
    }
    let model = docx_body_model(document_xml);
    let body = model.body.as_ref().ok_or_else(|| "DOCX document body is missing".to_owned())?;
    let wanted = paragraph_number - 1.0;
    let paragraph = (wanted >= 0.0 && wanted.fract() == 0.0)
        .then(|| model.blocks.iter().filter(|entry| entry.name == "w:p").nth(wanted as usize))
        .flatten()
        .ok_or_else(|| format!("DOCX paragraph {} not found", number_to_string(paragraph_number)))?;
    let inner = format!("{}{}{}", &body.inner[..paragraph.end], block, &body.inner[paragraph.end..]);
    Ok(format!("{}{}{}", &document_xml[..body.start], inner, &document_xml[body.end..]))
}

/// `docxStyleId(name)`: the id Word's English template gives a style named in words; any other name loses its white space.
pub fn docx_style_id(name: &str) -> String {
    let raw = js_trim(name);
    if raw.is_empty() {
        return String::new();
    }
    match js_to_lowercase(raw).as_str() {
        "heading 1" => "Heading1".to_owned(),
        "heading 2" => "Heading2".to_owned(),
        "heading 3" => "Heading3".to_owned(),
        "heading 4" => "Heading4".to_owned(),
        "list paragraph" => "ListParagraph".to_owned(),
        "table grid" => "TableGrid".to_owned(),
        "normal table" => "TableNormal".to_owned(),
        "no spacing" => "NoSpacing".to_owned(),
        "intense quote" => "IntenseQuote".to_owned(),
        _ => raw.chars().filter(|c| !mixdog_js::is_js_space(*c)).collect(),
    }
}

// Word keeps run properties in a fixed order and honours the last value it reads: appending a colour beside the one already
// there leaves the old ink winning, so a restyled cell must replace the property it sets, in place.
const RUN_PROPERTY_ORDER: [&str; 23] = [
    "w:rStyle",
    "w:rFonts",
    "w:b",
    "w:bCs",
    "w:i",
    "w:iCs",
    "w:caps",
    "w:smallCaps",
    "w:strike",
    "w:dstrike",
    "w:vanish",
    "w:color",
    "w:spacing",
    "w:w",
    "w:kern",
    "w:position",
    "w:sz",
    "w:szCs",
    "w:highlight",
    "w:u",
    "w:vertAlign",
    "w:rtl",
    "w:lang",
];

/// `(tag, xml)` of each property element of a fragment, in source order.
fn run_property_elements(xml: &str) -> Vec<(String, String)> {
    compiled(r"<(w:[A-Za-z]+)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)", "g")
        .captures_iter(xml)
        .map(|found| (found.get(1).unwrap_or("").to_owned(), found.get(0).unwrap_or("").to_owned()))
        .collect()
}

/// `mergeWordPropertyElements(existing, overrides, order)`: the elements of both, an override replacing the element of its
/// name where it stood, in the order's sequence (a name the order does not list goes last).
pub fn merge_word_property_elements(existing: &str, overrides: &str, order: &[&str]) -> String {
    let mut merged: Vec<(String, String)> = Vec::new();
    for (tag, xml) in run_property_elements(existing).into_iter().chain(run_property_elements(overrides)) {
        match merged.iter_mut().find(|(name, _)| *name == tag) {
            Some(entry) => entry.1 = xml,
            None => merged.push((tag, xml)),
        }
    }
    let rank = |tag: &str| order.iter().position(|name| *name == tag).unwrap_or(order.len());
    merged.sort_by_key(|(tag, _)| rank(tag));
    merged.into_iter().map(|(_, xml)| xml).collect()
}

/// What [`merge_word_run_fonts`] sets: a Latin face, an East Asian face, a size in points and an ink.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunFontOverrides<'a> {
    pub name: &'a str,
    pub name_east_asia: &'a str,
    pub size: f64,
    pub color: &'a str,
}

/// `mergeWordRunFonts(existing, overrides)`: run properties merged in Word's order, the overrides replacing the elements they
/// name. The faces merge attribute by attribute: a document default naming its Korean face keeps it when only the Latin face
/// is set.
pub fn merge_word_run_fonts(existing: &str, overrides: &RunFontOverrides<'_>) -> String {
    let mut attributes: Vec<(String, String)> = Vec::new();
    let set = |attributes: &mut Vec<(String, String)>, key: &str, value: String| match attributes.iter_mut().find(|(name, _)| name == key) {
        Some(entry) => entry.1 = value,
        None => attributes.push((key.to_owned(), value)),
    };
    if let Some(found) = compiled(r"<w:rFonts\b([^>]*)\/>", "").captures(existing) {
        for pair in compiled(r#"(w:[A-Za-z]+)="([^"]*)""#, "g").captures_iter(found.get(1).unwrap_or("")) {
            set(&mut attributes, pair.get(1).unwrap_or(""), pair.get(2).unwrap_or("").to_owned());
        }
    }
    // A theme face (asciiTheme...) outranks the named one in Word, so a face set here drops it.
    if !overrides.name.is_empty() {
        attributes.retain(|(key, _)| key != "w:asciiTheme" && key != "w:hAnsiTheme");
        set(&mut attributes, "w:ascii", xml_encode(overrides.name));
        set(&mut attributes, "w:hAnsi", xml_encode(overrides.name));
    }
    if !overrides.name_east_asia.is_empty() {
        attributes.retain(|(key, _)| key != "w:eastAsiaTheme");
        set(&mut attributes, "w:eastAsia", xml_encode(overrides.name_east_asia));
    }
    let half = if overrides.size > 0.0 { math::max(2.0, math::round(overrides.size * 2.0)) } else { 0.0 };
    let ink = without_hash(overrides.color);
    let mut fragment = String::new();
    if !attributes.is_empty() {
        let list: Vec<String> = attributes.iter().map(|(key, value)| format!("{key}=\"{value}\"")).collect();
        fragment.push_str(&format!("<w:rFonts {}/>", list.join(" ")));
    }
    if ink.len() == 6 && ink.chars().all(|c| c.is_ascii_hexdigit()) {
        fragment.push_str(&format!("<w:color w:val=\"{}\"/>", ink.to_ascii_uppercase()));
    }
    if half != 0.0 {
        let half = number_to_string(half);
        fragment.push_str(&format!("<w:sz w:val=\"{half}\"/><w:szCs w:val=\"{half}\"/>"));
    }
    merge_word_property_elements(existing, &fragment, &RUN_PROPERTY_ORDER)
}

/// `applyWordRunFormat(xml, runFormat)`: the run properties of every run of the fragment merged with `run_format`, a run
/// without properties taking them as its own.
pub fn apply_word_run_format(xml: &str, run_format: &str) -> String {
    if run_format.is_empty() {
        return xml.to_owned();
    }
    let self_closed = compiled(r"<w:rPr\b[^>]*\/>", "");
    let opened = compiled(r"<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>", "");
    let run_open = compiled(r"<w:r(?:\s[^>]*)?>", "");
    compiled(WORD_RUN_SOURCE, "g").replace_all_with(xml, |found| {
        let run = found.get(0).unwrap_or("");
        if let Some(inner) = opened.captures(run) {
            let merged = merge_word_property_elements(inner.get(1).unwrap_or(""), run_format, &RUN_PROPERTY_ORDER);
            return replace_first_str(run, inner.get(0).unwrap_or(""), &format!("<w:rPr>{merged}</w:rPr>"));
        }
        if let Some(range) = self_closed.find(run) {
            return replace_first_str(run, &run[range], &format!("<w:rPr>{run_format}</w:rPr>"));
        }
        replace_first(&run_open, run, |open| format!("{open}<w:rPr>{run_format}</w:rPr>"))
    })
}

/// `<w:rFonts>` with the already-encoded Latin (ascii/hAnsi/cs) and East Asian faces; empty without either.
fn run_fonts_xml(latin: &str, east_asia: &str) -> String {
    if latin.is_empty() && east_asia.is_empty() {
        return String::new();
    }
    let latin_attributes = if latin.is_empty() { String::new() } else { format!(" w:ascii=\"{latin}\" w:hAnsi=\"{latin}\" w:cs=\"{latin}\"") };
    let east_asia_attribute = if east_asia.is_empty() { String::new() } else { format!(" w:eastAsia=\"{east_asia}\"") };
    format!("<w:rFonts{latin_attributes}{east_asia_attribute}/>")
}

/// `<w:rFonts>` for a run's ascii/hAnsi face and East Asian face; empty without either.
fn word_run_fonts_xml(name: &str, name_east_asia: &str) -> String {
    if name.is_empty() && name_east_asia.is_empty() {
        return String::new();
    }
    let latin = if name.is_empty() { String::new() } else { format!(" w:ascii=\"{0}\" w:hAnsi=\"{0}\"", xml_encode(name)) };
    let east_asia = if name_east_asia.is_empty() { String::new() } else { format!(" w:eastAsia=\"{}\"", xml_encode(name_east_asia)) };
    format!("<w:rFonts{latin}{east_asia}/>")
}

/// `wordTextElement(text, { preserve })`: `<w:t>` for one string; edge white space is kept with `xml:space="preserve"`, which
/// Word otherwise drops.
pub fn word_text_element(text: &str, preserve: bool) -> String {
    let edge = text.chars().next().is_some_and(mixdog_js::is_js_space) || text.chars().next_back().is_some_and(mixdog_js::is_js_space);
    format!("<w:t{}>{}</w:t>", if preserve || edge { " xml:space=\"preserve\"" } else { "" }, xml_encode(text))
}

/// `<w:tag w:val="..."/>` for a tri-state property: empty when absent, else its on/off value.
fn toggle_xml(tag: &str, value: Option<&Value>, on: &str, off: &str) -> String {
    match value {
        None => String::new(),
        Some(value) => format!("<w:{tag} w:val=\"{}\"/>", if truthy(value) { on } else { off }),
    }
}

/// `wordRunProperties(properties)`: the run properties a font, weight, style, size and ink ask for, in Word's order.
pub fn word_run_properties(properties: &Value) -> String {
    let size_value = properties.get("size").filter(|value| !value.is_null()).or_else(|| properties.get("fontSize"));
    let size = num(size_value);
    let half = if size.is_finite() && size > 0.0 { math::max(2.0, math::round(size * 2.0)) } else { 0.0 };
    let name = string_or_empty(properties.get("name"));
    let name_east_asia = string_or_empty(properties.get("nameEastAsia"));
    let color = properties.get("color");
    [
        word_run_fonts_xml(&name, &name_east_asia),
        toggle_xml("b", properties.get("bold"), "1", "0"),
        toggle_xml("i", properties.get("italic"), "1", "0"),
        toggle_xml("u", properties.get("underline"), "single", "none"),
        // A working note travels with the document without being part of it: Word hides the run, and the runtime already
        // reads it back as hidden text.
        toggle_xml("vanish", properties.get("hidden"), "1", "0"),
        if present(color) {
            format!("<w:color w:val=\"{}\"/>", xml_encode(without_hash(&value_to_string(color.unwrap_or(&Value::Null)))))
        } else {
            String::new()
        },
        if half != 0.0 {
            let half = number_to_string(half);
            format!("<w:sz w:val=\"{half}\"/><w:szCs w:val=\"{half}\"/>")
        } else {
            String::new()
        },
    ]
    .concat()
}

/// `wordParagraph(text, { alignment, style, runProperties })`: one paragraph of one run.
pub fn word_paragraph(text: &str, alignment: &str, style: &str, run_properties: &str) -> String {
    let justification = word_justification(alignment);
    let properties = [
        if style.is_empty() { String::new() } else { format!("<w:pStyle w:val=\"{}\"/>", xml_encode(style)) },
        if justification.is_empty() { String::new() } else { format!("<w:jc w:val=\"{justification}\"/>") },
    ]
    .concat();
    format!(
        "<w:p>{}<w:r>{}{}</w:r></w:p>",
        if properties.is_empty() { String::new() } else { format!("<w:pPr>{properties}</w:pPr>") },
        if run_properties.is_empty() { String::new() } else { format!("<w:rPr>{run_properties}</w:rPr>") },
        word_text_element(text, false)
    )
}

/// `blankTableCells(xml)`: every text element emptied.
pub fn blank_table_cells(xml: &str) -> String {
    compiled(r"(<w:t(?:\s[^>]*)?>)[\s\S]*?(<\/w:t>)", "g")
        .replace_all_with(xml, |found| format!("{}{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or("")))
}

/// A match of a table's row or cell: the element and where it starts in what was searched (`match.index`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Matched {
    pub index: usize,
    pub xml: String,
}

/// `rewriteTableColumns(tableXml, columnIndex, mode)`: a column (1-based) deleted from the grid and every row, or a copy of
/// it, its text blanked, inserted before it (one past the last adds it at the end). A table must keep one column.
pub fn rewrite_table_columns(table_xml: &str, column_index: usize, deleting: bool) -> Result<String, String> {
    let grid = compiled(r"<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>", "").find(table_xml).map(|range| table_xml[range].to_owned());
    let at = column_index.saturating_sub(1);
    let mut next = table_xml.to_owned();
    if let Some(grid) = grid {
        let mut columns: Vec<String> = compiled(r"<w:gridCol\b[^>]*\/>", "g").find_iter(&grid).map(|range| grid[range].to_owned()).collect();
        if deleting {
            if columns.len() <= 1 {
                return Err("A table must keep at least one column".to_owned());
            }
            if at < columns.len() {
                columns.remove(at);
            }
        } else {
            let template = columns.get(at).or_else(|| columns.last()).cloned().unwrap_or_else(|| "<w:gridCol/>".to_owned());
            columns.insert(at.min(columns.len()), template);
        }
        next = replace_first_str(&next, &grid, &format!("<w:tblGrid>{}</w:tblGrid>", columns.concat()));
    }
    Ok(map_table_rows(&next, |row| {
        let mut cells: Vec<String> = row_cell_matches(row).into_iter().map(|cell| cell.xml).collect();
        if cells.is_empty() {
            return row.to_owned();
        }
        if deleting {
            if cells.len() <= 1 {
                return row.to_owned();
            }
            if at < cells.len() {
                cells.remove(at);
            }
        } else {
            let template = cells.get(at).or_else(|| cells.last()).cloned().unwrap_or_default();
            cells.insert(at.min(cells.len()), blank_table_cells(&template));
        }
        let open = compiled(r"^<w:tr(?:\s[^>]*)?>", "").find(row).map_or("<w:tr>", |range| &row[range]).to_owned();
        let properties = compiled(r"<w:trPr(?:\s[^>]*)?>[\s\S]*?<\/w:trPr>", "").find(row).map_or("", |range| &row[range]).to_owned();
        format!("{open}{properties}{}</w:tr>", cells.concat())
    }))
}

/// `tableRows(tableXml)`: the rows of a table, with their offsets in it.
pub fn table_rows(table_xml: &str) -> Vec<crate::xml::Element> {
    let Some(inner) = container_inner(table_xml, "w:tbl", 0) else { return Vec::new() };
    top_level_elements(&inner.inner, &["w:tr"])
        .into_iter()
        .map(|row| crate::xml::Element { start: inner.start + row.start, end: inner.start + row.end, ..row })
        .collect()
}

/// `tableRowMatches(tableXml)`: the rows as matches.
pub fn table_row_matches(table_xml: &str) -> Vec<Matched> {
    table_rows(table_xml).into_iter().map(|row| Matched { index: row.start, xml: row.xml }).collect()
}

/// `missingDocxCellError(op, cells)`: a row names its cells as it stands: a merge across columns joins cells and moves the
/// later ones left, so a header merged left to right lost its last label. The error says how many cells the row holds and how
/// to go on, in the words the Office backend uses.
pub fn missing_docx_cell_error(op: &Value, cells: &[Matched]) -> String {
    format!(
        "DOCX table row {} holds {} cell(s) as it stands, so it has no cell {}: a merge across columns joins cells and moves the later ones left; merge a row from its right end first, or name the cell by its new position",
        shown(op.get("row")),
        cells.len(),
        shown(op.get("col"))
    )
}

/// `rowCellMatches(rowXml)`: the cells of a row as matches.
pub fn row_cell_matches(row_xml: &str) -> Vec<Matched> {
    let Some(inner) = container_inner(row_xml, "w:tr", 0) else { return Vec::new() };
    top_level_elements(&inner.inner, &["w:tc"]).into_iter().map(|cell| Matched { index: inner.start + cell.start, xml: cell.xml }).collect()
}

fn map_table_rows(table_xml: &str, transform: impl Fn(&str) -> String) -> String {
    let rows = table_rows(table_xml);
    if rows.is_empty() {
        return table_xml.to_owned();
    }
    let mut output = String::new();
    let mut cursor = 0;
    for row in &rows {
        output.push_str(&table_xml[cursor..row.start]);
        output.push_str(&transform(&row.xml));
        cursor = row.end;
    }
    output.push_str(&table_xml[cursor..]);
    output
}

/// `docxTables(current)`: the tables of the body, as matches in the document.
pub fn docx_tables(current: &str) -> Vec<Matched> {
    let body = container_inner(current, "w:body", 0);
    let (scope, offset) = match &body {
        Some(body) => (body.inner.as_str(), body.start),
        None => (current, 0),
    };
    top_level_elements(scope, &["w:tbl"]).into_iter().map(|element| Matched { index: offset + element.start, xml: element.xml }).collect()
}

/// The grid's columns, as Word counts a table's columns whatever its merges.
fn table_column_count(table_xml: &str, rows: &[Matched]) -> usize {
    let grid = compiled(r"<w:tblGrid\b[\s\S]*?<\/w:tblGrid>", "").find(table_xml).map_or("", |range| &table_xml[range]);
    let columns = compiled(r"<w:gridCol\b", "g").find_iter(grid).count();
    if columns > 0 { columns } else { rows.first().map_or(0, |row| row_cell_matches(&row.xml).len()) }
}

// A table as a caller can pick it out of the page: its size and the words it starts with. A report's metric strip is a table
// too, and "table 1" named it where the results table was meant; the errors now say which table is which.
fn table_summary(table_xml: &str) -> String {
    let rows = table_row_matches(table_xml);
    let columns = table_column_count(table_xml, &rows);
    let first_cell = rows.first().and_then(|row| row_cell_matches(&row.xml).into_iter().next()).map(|cell| cell.xml).unwrap_or_default();
    let words: String = compiled(r"<w:t\b[^>]*>([^<]*)<\/w:t>", "g").captures_iter(&first_cell).map(|found| xml_decode(found.get(1).unwrap_or(""))).collect();
    let start = slice_utf16(js_trim(&words), 24);
    format!("{}×{}{}", rows.len(), columns, if start.is_empty() { String::new() } else { format!(" starting \"{start}\"") })
}

/// `docxTable(current, number)`: the table numbered `number` (1-based) among the body's, or an error that names the tables
/// the document holds.
pub fn docx_table(current: &str, number: Option<&Value>) -> Result<Matched, String> {
    let tables = docx_tables(current);
    let wanted = num(number) - 1.0;
    if wanted >= 0.0 && wanted.fract() == 0.0 {
        if let Some(found) = tables.get(wanted as usize) {
            return Ok(found.clone());
        }
    }
    let held = tables.iter().take(6).enumerate().map(|(index, table)| format!("{}: {}", index + 1, table_summary(&table.xml))).collect::<Vec<_>>().join("; ");
    Err(format!(
        "DOCX table {} not found: the document holds {} table(s){}",
        shown(number),
        tables.len(),
        if held.is_empty() { String::new() } else { format!(" ({held})") }
    ))
}

/// `missingDocxRowError(op, tableXml)`: a row the table does not have, said with the table's size and first words, so the
/// caller can tell whether it named the wrong row or the wrong table. insert_table_row takes one past the last row, where the
/// new row is added at the end.
pub fn missing_docx_row_error(op: &Value, table_xml: &str) -> String {
    let count = table_row_matches(table_xml).len();
    let insertion = op.get("op") == Some(&Value::String("insert_table_row".to_owned()));
    format!(
        "DOCX table {} is {}, so it has no row {}{}",
        shown(op.get("table")),
        table_summary(table_xml),
        shown(op.get("row")),
        if insertion {
            format!(": insert_table_row row is the position the new row takes, 1 to {0} ({0} adds it at the end)", count + 1)
        } else {
            String::new()
        }
    )
}

/// `checkDocxColumn(op, tableXml)`: the column an operation names (1-based), or an error that says how many the table has;
/// insert_table_column takes one past the last column, where the new column is added at the end.
pub fn check_docx_column(op: &Value, table_xml: &str) -> Result<usize, String> {
    let count = table_column_count(table_xml, &table_row_matches(table_xml));
    let insertion = op.get("op") == Some(&Value::String("insert_table_column".to_owned()));
    let column = num(op.get("column"));
    if column.fract() == 0.0 && column >= 1.0 && column <= (count + usize::from(insertion)) as f64 {
        return Ok(column as usize);
    }
    Err(format!(
        "DOCX table {} is {}, so it has no column {}{}",
        shown(op.get("table")),
        table_summary(table_xml),
        shown(op.get("column")),
        if insertion {
            format!(": insert_table_column column is the position the new column takes, 1 to {0} ({0} adds it at the end)", count + 1)
        } else {
            String::new()
        }
    ))
}

/// `replaceDocxTable(current, table, nextTable)`.
pub fn replace_docx_table(current: &str, table: &Matched, next_table: &str) -> String {
    format!("{}{}{}", &current[..table.index], next_table, &current[table.index + table.xml.len()..])
}

/// `replaceWordProperties(xml, owner, propertyTag, value)`: the owner's property element given the new content, or added
/// right after the owner's opening tag.
pub fn replace_word_properties(xml: &str, owner: &str, property_tag: &str, value: &str) -> String {
    let pattern = compiled(&format!(r"<w:{property_tag}(?:\s[^>]*)?>[\s\S]*?<\/w:{property_tag}>"), "");
    if pattern.is_match(xml) {
        return replace_first(&pattern, xml, |_| format!("<w:{property_tag}>{value}</w:{property_tag}>"));
    }
    replace_first(&compiled(&format!(r"<w:{owner}(?:\s[^>]*)?>"), ""), xml, |open| format!("{open}<w:{property_tag}>{value}</w:{property_tag}>"))
}

// The gap between a rule and the text is Word's own default per side (4 pt beside, 1 pt above or below), the distance Word
// applies through COM; a callout's left rule otherwise touches its label.
fn paragraph_border_xml(border: Option<&Value>) -> String {
    let Some(border) = border.filter(|value| truthy(value)) else { return String::new() };
    // The sides the Word backend draws; any other name is its bottom rule, as Word reads it.
    let named = value_to_string(border.get("side").unwrap_or(&Value::Null));
    let side = if border.get("side").is_some() && ["top", "left", "bottom", "right"].contains(&named.as_str()) { named.as_str() } else { "bottom" };
    let space = border.get("space");
    let explicit = space.is_some_and(|space| !space.is_null() && *space != Value::String(String::new()) && num(Some(space)).is_finite());
    let default_space = if side == "left" || side == "right" { 4.0 } else { 1.0 };
    let space = math::max(0.0, if explicit { num(space) } else { default_space });
    let color = if present(border.get("color")) { string_or_empty(border.get("color")) } else { "auto".to_owned() };
    format!(
        "<w:pBdr><w:{side} w:val=\"{}\" w:sz=\"{}\" w:space=\"{}\" w:color=\"{}\"/></w:pBdr>",
        word_border_style(border.get("style")),
        number_to_string(math::max(1.0, or_else(num(border.get("size")), 4.0))),
        number_to_string(space),
        xml_encode(without_hash(&color))
    )
}

/// A tab stop's leader in the names the Word backend reads (dash, line) and in the file's own (hyphen, underscore); a name
/// written through as given ("dash") is not one the file knows, and Word refuses such a file.
fn tab_leader(name: &str) -> Option<&'static str> {
    match name {
        "none" => Some("none"),
        "dot" | "dots" | "dotted" => Some("dot"),
        "dash" | "hyphen" => Some("hyphen"),
        "line" | "underscore" => Some("underscore"),
        "heavy" => Some("heavy"),
        "middledot" => Some("middleDot"),
        _ => None,
    }
}

fn tab_stop_xml(tab: &Value) -> String {
    let alignment = js_to_lowercase(&string_or_empty(tab.get("alignment")));
    let leader = tab_leader(&js_to_lowercase(&string_or_empty(tab.get("leader")))).map(|name| format!(" w:leader=\"{name}\"")).unwrap_or_default();
    let value = if ["left", "center", "right", "decimal", "bar"].contains(&alignment.as_str()) { alignment.as_str() } else { "left" };
    let position = if present(tab.get("position")) { num(tab.get("position")) } else { 0.0 };
    format!("<w:tab w:val=\"{value}\" w:pos=\"{}\"{leader}/>", twips_text(position))
}

// lineSpacing is a minimum unless lineSpacingRule:'exact' holds the line at it: set on Malgun Gothic's own line, the two
// lines of one 24 pt title stood nearly twice the size apart, and a minimum can only open that gap further.
fn paragraph_spacing_xml(properties: &Value) -> String {
    let (before, after, line) = (properties.get("spacingBefore"), properties.get("spacingAfter"), properties.get("lineSpacing"));
    if before.is_none() && after.is_none() && line.is_none() {
        return String::new();
    }
    let points = |value: Option<&Value>, name: &str| {
        value.map(|value| format!(" w:{name}=\"{}\"", number_to_string(math::max(0.0, math::round(num(Some(value)) * 20.0))))).unwrap_or_default()
    };
    let rule = if js_to_lowercase(&string_or_empty(properties.get("lineSpacingRule"))) == "exact" { "exact" } else { "atLeast" };
    let line = line
        .map(|value| format!(" w:line=\"{}\" w:lineRule=\"{rule}\"", number_to_string(math::max(1.0, math::round(num(Some(value)) * 20.0)))))
        .unwrap_or_default();
    format!("<w:spacing{}{}{line}/>", points(before, "before"), points(after, "after"))
}

fn paragraph_indent_xml(properties: &Value) -> String {
    let (left, right, first_line) = (properties.get("indentLeft"), properties.get("indentRight"), properties.get("indentFirstLine"));
    if left.is_none() && right.is_none() && first_line.is_none() {
        return String::new();
    }
    let twips = |points: f64| number_to_string(math::max(0.0, math::round(points * 20.0)));
    let side = |value: Option<&Value>, name: &str| value.map(|value| format!(" w:{name}=\"{}\"", twips(num(Some(value))))).unwrap_or_default();
    // A negative first line is spelled w:hanging: w:firstLine never goes below zero.
    let first = num(first_line);
    let first_text = match first_line {
        None => String::new(),
        Some(_) if first < 0.0 => format!(" w:hanging=\"{}\"", twips(-first)),
        Some(_) => format!(" w:firstLine=\"{}\"", twips(first)),
    };
    format!("<w:ind{}{}{first_text}/>", side(left, "left"), side(right, "right"))
}

/// `wordTextContent(text, { preserve })`: a run's text content. Each tab is Word's own `<w:tab/>` element: a TAB character
/// inside `<w:t>` renders as a space, so the paragraph's tab stops (a right-aligned figure, a dot leader) never see it.
pub fn word_text_content(text: &str, preserve: bool) -> String {
    if !text.contains('\t') {
        return word_text_element(text, preserve);
    }
    text.split('\t').map(|part| if part.is_empty() { String::new() } else { word_text_element(part, preserve) }).collect::<Vec<_>>().join("<w:tab/>")
}

/// `withFirstRunText(xml, text)`: the fragment with `text` in its first `<w:t>` and every other `<w:t>` emptied: the first
/// run's formatting carries the new words, and a tab in them becomes that run's `<w:tab/>`. The fragment holds at least one
/// `<w:t>`.
pub fn with_first_run_text(xml: &str, text: &str) -> String {
    let nodes: Vec<_> = text_nodes(xml, "w:t")
        .into_iter()
        .enumerate()
        .map(|(index, node)| crate::xml::TextNode { text: if index > 0 { String::new() } else { text.to_owned() }, ..node })
        .collect();
    if !text.contains('\t') {
        return rebuild_text_nodes(xml, "w:t", &nodes);
    }
    let Some((first, rest)) = nodes.split_first() else { return xml.to_owned() };
    let tail = &xml[first.end..];
    let shifted: Vec<_> = rest.iter().map(|node| crate::xml::TextNode { start: node.start - first.end, end: node.end - first.end, ..node.clone() }).collect();
    format!("{}{}{}", &xml[..first.start], word_text_content(text, false), rebuild_text_nodes(tail, "w:t", &shifted))
}

/// A paragraph's list membership: the level (0 to 2 as written) and the numbering definition's id.
#[derive(Debug, Clone, PartialEq)]
pub struct Numbering {
    pub level: f64,
    pub num_id: String,
}

/// `paragraphFormatXml(properties, numbering)`: the paragraph properties a format asks for, in the schema's pPr order.
pub fn paragraph_format_xml(properties: &Value, numbering: Option<&Numbering>) -> String {
    let tabs = properties.get("tabStops").and_then(Value::as_array);
    let shading = properties.get("shading");
    let justification = justification_of(properties.get("alignment"));
    [
        toggle_xml("keepNext", properties.get("keepWithNext"), "1", "0"),
        toggle_xml("keepLines", properties.get("keepTogether"), "1", "0"),
        toggle_xml("pageBreakBefore", properties.get("pageBreakBefore"), "1", "0"),
        toggle_xml("widowControl", properties.get("widowControl"), "1", "0"),
        numbering
            .map(|numbering| {
                format!(
                    "<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr>",
                    number_to_string(math::max(0.0, math::min(2.0, or_else(numbering.level, 0.0)))),
                    numbering.num_id
                )
            })
            .unwrap_or_default(),
        paragraph_border_xml(properties.get("border")),
        // A paragraph's own field (a callout, a summary band) and its indents (a quote set in from the margin), in points
        // like every other distance here; Word reads the same fill and indents through COM.
        if present(shading) {
            format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{}\"/>", xml_encode(without_hash(&value_to_string(shading.unwrap_or(&Value::Null)))))
        } else {
            String::new()
        },
        if properties.get("tabStops").is_some() {
            format!("<w:tabs>{}</w:tabs>", tabs.map(|list| list.iter().map(tab_stop_xml).collect::<String>()).unwrap_or_default())
        } else {
            String::new()
        },
        paragraph_spacing_xml(properties),
        // w:ind follows w:spacing in the schema's pPr sequence; a validator refuses the other order.
        paragraph_indent_xml(properties),
        if justification.is_empty() { String::new() } else { format!("<w:jc w:val=\"{justification}\"/>") },
    ]
    .concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A face that prints ten px a character.
    fn ten_per_character(text: &str, _: &FontSpec) -> Result<f64, String> {
        Ok(text.chars().count() as f64 * 10.0)
    }

    #[test]
    fn table_columns_without_widths_are_measured_in_the_tables_face() {
        let values = json!([["ab", "c"], ["abcd", "e"]]);
        let widths = natural_table_column_widths(&values, &json!({}), 100.0, &mut ten_per_character).expect("measured").expect("widths");
        // Each cell costs its text plus the cell padding, the longest line of each column keeps its width, and what is left
        // of the 100 pt is shared evenly.
        let (first, second) = (4.0 * 10.0 * 1.05 + CELL_PADDING_POINTS, 10.0 * 1.05 + CELL_PADDING_POINTS);
        let extra = (100.0 - first - second) / 2.0;
        assert!((widths[0] - (first + extra)).abs() < 1e-9 && (widths[1] - (second + extra)).abs() < 1e-9, "{widths:?}");
        assert_eq!(natural_table_column_widths(&values, &json!({}), 0.0, &mut ten_per_character), Ok(None));
        let mut refused = |_: &str, _: &FontSpec| -> Result<f64, String> { Err("no face".to_owned()) };
        assert_eq!(natural_table_column_widths(&values, &json!({}), 100.0, &mut refused), Err("no face".to_owned()));
    }

    #[test]
    fn a_table_that_names_no_widths_states_the_ones_it_measured() {
        let table = word_table_xml(&json!({ "values": [["a", "b"]] }), 400.0, &mut ten_per_character).expect("a table");
        assert!(table.contains(r#"<w:tblW w:w="8000" w:type="dxa"/>"#), "{table}");
        assert_eq!(table.matches(r#"<w:gridCol w:w="4000"/>"#).count(), 2);
        assert!(table.contains(r#"<w:tcW w:w="4000" w:type="dxa"/>"#));
        let unmeasured = word_table_xml(&json!({ "values": [["a", "b"]] }), 0.0, &mut ten_per_character).expect("a table");
        assert!(unmeasured.contains(r#"<w:tblW w:w="0" w:type="auto"/>"#) && unmeasured.contains("<w:gridCol/>"), "{unmeasured}");
    }

    #[test]
    fn a_table_is_read_back_by_rows_cells_and_columns() {
        let table = word_table_xml(&json!({ "values": [["x", "y"], ["z", "w"]], "properties": { "columnWidths": [50, 50] } }), 0.0, &mut ten_per_character)
            .expect("a table");
        let rows = table_row_matches(&table);
        assert_eq!(rows.len(), 2);
        assert_eq!(row_cell_matches(&rows[0].xml).len(), 2);
        let wider = rewrite_table_columns(&table, 3, false).expect("a column added at the end");
        assert_eq!(row_cell_matches(&table_row_matches(&wider)[1].xml).len(), 3);
        let narrower = rewrite_table_columns(&wider, 1, true).expect("a column removed");
        assert_eq!(narrower.matches("<w:gridCol").count(), 2);
        assert_eq!(
            rewrite_table_columns("<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid></w:tbl>", 1, true),
            Err("A table must keep at least one column".to_owned())
        );
        let error = check_docx_column(&json!({ "op": "insert_table_column", "table": 1, "column": 9 }), &table).expect_err("past the end");
        assert!(error.ends_with("insert_table_column column is the position the new column takes, 1 to 3 (3 adds it at the end)"), "{error}");
        assert_eq!(docx_style_id(" Table Grid "), "TableGrid");
        assert_eq!(docx_style_id("Body  Text"), "BodyText");
    }
}
