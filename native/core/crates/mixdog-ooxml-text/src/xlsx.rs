//! `.xlsx` / `.xlsm`: a workbook's text is its grid, sheet by sheet, one row per line, cells separated by tabs and empty
//! columns kept so a value stays under its header. A formula cell reads as the value Excel last cached for it, which is
//! what the sheet shows.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::string_to_number;
use mixdog_js::utf16_len;

use crate::Failure;
use crate::cap_output;
use crate::docx::PartKind;
use crate::docx::ooxml_part_text;
use crate::numfmt::cell_number_formats;
use crate::numfmt::displayed_number;
use crate::scan::A;
use crate::scan::T_RUN_RE;
use crate::scan::V_RE;
use crate::scan::decode_xml_entities;
use crate::scan::drawing_marker;
use crate::scan::first_element;
use crate::scan::first_group;
use crate::scan::flatten_lines;
use crate::scan::relationship_list;
use crate::scan::scan_elements;
use crate::zip::Zip;

const SHEET_MAX_ROWS: usize = 5000;

static SHEET_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!(r"<sheet\b({A}?)/>"), ""));
static COL_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!(r"<col\b({A}?)/?>"), ""));
static CHART_ID_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!(r#"<c:chart\b{A}?\br:id="([^"<>]+)""#), ""));
static STATE_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bstate="([^"]*)""#, ""));
static NAME_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bname="([^"]*)""#, ""));
static SHEET_ID_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\br:id="([^"]+)""#, ""));
static HIDDEN_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bhidden="(?:1|true)""#, ""));
static MIN_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bmin="(\d+)""#, ""));
static MAX_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bmax="(\d+)""#, ""));
static CELL_TYPE_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bt="([^"]+)""#, ""));
static CELL_STYLE_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bs="(\d+)""#, ""));
static CELL_REF_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\br="([^"]+)""#, ""));
static DRAWING_TARGET_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"drawings/drawing\d+\.xml$", ""));
static PICTURE_RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<xdr:pic\b", ""));

/// `columnIndex(reference)`: the 1-based number of the column letters a cell reference starts with, Excel's last column
/// (XFD, 16384) at most.
fn column_index(reference: &str) -> usize {
    let mut index = 0usize;
    for letter in reference.to_uppercase().chars().take_while(char::is_ascii_uppercase) {
        index = (index * 26 + (letter as usize - 64)).min(16384);
    }
    index.clamp(1, 16384)
}

/// `columnName(index)`: the letters of a column number (arithmetic on the number as JavaScript does, so a malformed huge
/// index gives Node's letters).
fn column_name(index: f64) -> String {
    let mut name = String::new();
    let mut remaining = index;
    while remaining > 0.0 && remaining.is_finite() {
        let step = (remaining - 1.0) % 26.0;
        name.insert(0, char::from(65 + step as u8));
        remaining = ((remaining - 1.0) / 26.0).floor();
    }
    name
}

/// Concatenated `<t>` character data of one fragment.
fn text_runs(fragment: &str) -> Result<String, Failure> {
    let mut out = String::new();
    for found in T_RUN_RE.captures_iter(fragment) {
        out.push_str(&decode_xml_entities(found.get(1).unwrap_or(""))?);
    }
    Ok(out)
}

fn shared_string_table(xml: &str) -> Result<Vec<String>, Failure> {
    if xml.is_empty() {
        return Ok(Vec::new());
    }
    scan_elements(xml, "si").filter_map(|item| item.inner).map(text_runs).collect()
}

/// A sheet hides rows and columns the same way it hides a whole sheet: the values stay in the file and the workbook does
/// not show them. Read as ordinary cells they enter the answer as what the sheet says.
fn hidden_column_numbers(xml: &str) -> Vec<f64> {
    let declarations = first_element(xml, "cols").and_then(|element| element.inner).unwrap_or("");
    let mut hidden = Vec::new();
    for found in COL_RE.captures_iter(declarations) {
        let attributes = found.get(1).unwrap_or("");
        if !HIDDEN_RE.is_match(attributes) {
            continue;
        }
        let first = string_to_number(first_group(&MIN_RE, attributes).unwrap_or("0"));
        let last = first_group(&MAX_RE, attributes).map_or(first, string_to_number);
        if first == 0.0 {
            continue;
        }
        let mut index = first;
        // At most 64 columns of one declaration (a count past 2^53 would not advance, so the count bounds the loop too).
        for _ in 0..64 {
            if index > last {
                break;
            }
            hidden.push(index);
            index += 1.0;
        }
    }
    hidden
}

struct Rows {
    text: String,
    truncated: bool,
    hidden_columns: Vec<String>,
}

/// `worksheetRows`. `max_content_chars` stops the build once the grid alone is longer than the caller can ever show
/// (`cap_output` cuts the text anyway), so a sheet of far-right cells on thousands of rows costs the output cap, not
/// hundreds of megabytes. The text built so far is a prefix of the full text, so the cut output is the same.
fn worksheet_rows(xml: &str, strings: &[String], formats: &[String], max_content_chars: usize) -> Result<Rows, Failure> {
    let mut lines: Vec<String> = Vec::new();
    let mut truncated = false;
    let mut chars = 0usize; // length of lines joined by newlines
    let mut content_chars = 0usize; // the same, through the last non-empty line
    for row in scan_elements(xml, "row") {
        if lines.len() >= SHEET_MAX_ROWS {
            truncated = true;
            break;
        }
        let mut cells: Vec<String> = Vec::new();
        for cell in scan_elements(row.inner.unwrap_or(""), "c") {
            let attributes = cell.attrs;
            let inner = cell.inner.unwrap_or("");
            let kind = first_group(&CELL_TYPE_RE, attributes).unwrap_or("n");
            let text = if kind == "s" {
                let index = first_group(&V_RE, inner).map_or(f64::NAN, string_to_number);
                if index.is_finite() && index.fract() == 0.0 && index >= 0.0 {
                    strings.get(index as usize).cloned().unwrap_or_default()
                } else {
                    String::new()
                }
            } else if kind == "inlineStr" {
                text_runs(inner)?
            } else {
                let text = decode_xml_entities(first_group(&V_RE, inner).unwrap_or(""))?;
                let style = first_group(&CELL_STYLE_RE, attributes).map_or(f64::NAN, string_to_number);
                if !text.is_empty() && style.is_finite() && style.fract() == 0.0 {
                    let format = formats.get(style as usize).map_or("", String::as_str);
                    displayed_number(&text, format)?
                } else {
                    text
                }
            };
            let column = column_index(first_group(&CELL_REF_RE, attributes).unwrap_or(""));
            if cells.len() < column {
                cells.resize(column, String::new());
            }
            cells[column - 1] = text;
        }
        let joined = cells.join("\t");
        let line = joined.trim_end_matches('\t');
        let shown = if !line.is_empty() && HIDDEN_RE.is_match(row.attrs) { format!("[hidden] {line}") } else { line.to_owned() };
        chars += usize::from(!lines.is_empty()) + utf16_len(&shown);
        let has_content = !shown.is_empty();
        lines.push(shown);
        if has_content {
            content_chars = chars;
        }
        if content_chars > max_content_chars {
            break;
        }
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let first = lines.first().map_or("", String::as_str);
    let header: Vec<&str> = first.strip_prefix("[hidden] ").unwrap_or(first).split('\t').collect();
    let hidden_columns = hidden_column_numbers(xml)
        .into_iter()
        .map(|index| {
            let label = (index >= 1.0).then(|| header.get(index as usize - 1)).flatten().map_or("", |label| js_trim(label));
            if label.is_empty() { column_name(index) } else { format!("{} ({label})", column_name(index)) }
        })
        .collect();
    Ok(Rows { text: lines.join("\n"), truncated, hidden_columns })
}

/// `relatedPart(target, ownerPart)`: the package path a relationship target names, relative to the part that owns it.
fn related_part(target: &str, owner_part: &str) -> String {
    let parent = |path: &str| match path.rfind('/') {
        Some(at) if at + 1 < path.len() => path[..at].to_owned(),
        _ => path.to_owned(),
    };
    let base = parent(owner_part);
    let value = target.strip_prefix('/').unwrap_or(target);
    if !value.starts_with("..") {
        return if value.starts_with("xl/") { value.to_owned() } else { format!("{base}/{value}") };
    }
    match value.strip_prefix("../") {
        Some(rest) => format!("{}/{rest}", parent(&base)),
        None => value.to_owned(),
    }
}

/// `part.replace(/([^/]+)$/, '_rels/$1.rels')`: the relationships part of a part.
fn rels_name(part: &str) -> String {
    match part.rfind('/') {
        Some(at) if at + 1 < part.len() => format!("{}_rels/{}.rels", &part[..=at], &part[at + 1..]),
        Some(_) => part.to_owned(),
        None if part.is_empty() => String::new(),
        None => format!("_rels/{part}.rels"),
    }
}

/// A sheet's chart is its message, and it lives outside the cell grid: read as rows alone, a dashboard sheet came back
/// empty. Each figure is named after the grid, with the chart's own title when it has one.
fn sheet_figures(zip: &Zip, sheet_part: &str) -> Result<Vec<String>, Failure> {
    let sheet_rels = zip.part_text(&rels_name(sheet_part))?;
    let Some((_, drawing_target)) = relationship_list(&sheet_rels).into_iter().find(|(_, target)| DRAWING_TARGET_RE.is_match(target)) else {
        return Ok(Vec::new());
    };
    let drawing_part = related_part(&drawing_target, sheet_part);
    let drawing = zip.part_text(&drawing_part)?;
    if drawing.is_empty() {
        return Ok(Vec::new());
    }
    let drawing_rels = zip.part_text(&rels_name(&drawing_part))?;
    let targets: HashMap<String, String> = relationship_list(&drawing_rels)
        .into_iter()
        .filter_map(|(id, target)| id.map(|id| (id, related_part(&target, &drawing_part))))
        .collect();
    let mut anchors: Vec<_> = ["xdr:absoluteAnchor", "xdr:twoCellAnchor", "xdr:oneCellAnchor"]
        .into_iter()
        .flat_map(|name| scan_elements(&drawing, name))
        .filter(|item| item.inner.is_some())
        .collect();
    anchors.sort_by_key(|item| item.index);
    let mut figures = Vec::new();
    for anchor in anchors {
        if let Some(chart_id) = first_group(&CHART_ID_RE, anchor.full) {
            let chart_xml = zip.part_text(targets.get(chart_id).map_or("", String::as_str))?;
            let title_xml = first_element(&chart_xml, "c:title").map_or("", |element| element.full);
            let title = flatten_lines(&ooxml_part_text(title_xml, PartKind::Drawing, None)?);
            figures.push(if title.is_empty() { "[chart]".to_owned() } else { format!("[chart: {title}]") });
            continue;
        }
        if PICTURE_RE.is_match(anchor.full) {
            figures.push(drawing_marker(anchor.full)?);
        }
    }
    Ok(figures)
}

/// `workbookText`.
pub fn workbook_text(zip: &Zip, max_output_bytes: usize) -> Result<String, Failure> {
    if !zip.has("xl/workbook.xml") {
        return Err(Failure::Format("no xl/workbook.xml part — not an Excel workbook (or an encrypted one)".into()));
    }
    let workbook = zip.part_text("xl/workbook.xml")?;
    let mut relationships: HashMap<String, String> = HashMap::new();
    for (id, target) in relationship_list(&zip.part_text("xl/_rels/workbook.xml.rels")?) {
        let Some(id) = id else { continue };
        let target = target.strip_prefix("/xl/").or_else(|| target.strip_prefix("xl/")).unwrap_or(&target);
        let target = target.strip_prefix("./").unwrap_or(target);
        relationships.insert(id, format!("xl/{target}"));
    }
    let strings = shared_string_table(&zip.part_text("xl/sharedStrings.xml")?)?;
    let formats = cell_number_formats(&zip.part_text("xl/styles.xml")?)?;
    let mut sections: Vec<String> = Vec::new();
    let mut section_chars = 0usize;
    for found in SHEET_RE.captures_iter(&workbook) {
        let attributes = found.get(1).unwrap_or("");
        // A hidden sheet is content the workbook does not show; reading it as an ordinary sheet presents withheld data
        // as the answer.
        let state = js_to_lowercase(first_group(&STATE_RE, attributes).unwrap_or(""));
        let label = match state.as_str() {
            "hidden" => " (hidden)",
            "veryhidden" => " (very hidden)",
            // `{ hidden, veryhidden }[state]` reads the object's own prototype for these two names.
            "constructor" => "function Object() { [native code] }",
            "__proto__" => "[object Object]",
            _ => "",
        };
        let name = format!("{}{label}", decode_xml_entities(first_group(&NAME_RE, attributes).unwrap_or(""))?);
        let relationship_id = first_group(&SHEET_ID_RE, attributes).unwrap_or("");
        let part = relationships.get(relationship_id).map(String::as_str);
        let Some(part) = part.filter(|part| zip.has(part)) else {
            sections.push(format!("--- sheet {name} ---\n(sheet part missing)"));
            continue;
        };
        let rows = worksheet_rows(&zip.part_text(part)?, &strings, &formats, max_output_bytes)?;
        let figures = sheet_figures(zip, part)?;
        let mut section = format!("--- sheet {name} ---\n{}", if rows.text.is_empty() { "(empty sheet)" } else { rows.text.as_str() });
        if rows.truncated {
            section.push_str(&format!("\n... [sheet truncated at {SHEET_MAX_ROWS} rows]"));
        }
        if !rows.hidden_columns.is_empty() {
            section.push_str(&format!("\n[hidden columns: {}]", rows.hidden_columns.join(", ")));
        }
        if !figures.is_empty() {
            section.push_str(&format!("\n{}", figures.join("\n")));
        }
        // Sheets past the output cap are cut by cap_output; do not build them.
        section_chars += utf16_len(&section) + 2;
        sections.push(section);
        if section_chars > max_output_bytes {
            break;
        }
    }
    if sections.is_empty() {
        return Err(Failure::Format("workbook declares no sheets".into()));
    }
    Ok(cap_output(&sections.join("\n\n"), max_output_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_letters_are_a_number_up_to_xfd() {
        assert_eq!(column_index("A1"), 1);
        assert_eq!(column_index("b2"), 2);
        assert_eq!(column_index("AA10"), 27);
        assert_eq!(column_index("XFD1"), 16384);
        assert_eq!(column_index("XFE1"), 16384);
        assert_eq!(column_index("ZZZZZZZZZZ1"), 16384);
        assert_eq!(column_index("12"), 1);
        assert_eq!(column_index(""), 1);
        // `toUpperCase` turns the sharp s into SS.
        assert_eq!(column_index("ßA1"), 26 * 26 * 19 + 26 * 19 + 1);
    }

    #[test]
    fn a_column_number_is_named_in_letters() {
        assert_eq!(column_name(1.0), "A");
        assert_eq!(column_name(26.0), "Z");
        assert_eq!(column_name(27.0), "AA");
        assert_eq!(column_name(702.0), "ZZ");
        assert_eq!(column_name(703.0), "AAA");
        assert_eq!(column_name(16384.0), "XFD");
        assert_eq!(column_name(0.0), "");
    }

    #[test]
    fn a_target_is_resolved_against_the_part_that_names_it() {
        assert_eq!(related_part("../drawings/drawing1.xml", "xl/worksheets/sheet1.xml"), "xl/drawings/drawing1.xml");
        assert_eq!(related_part("/xl/charts/chart1.xml", "xl/drawings/drawing1.xml"), "xl/charts/chart1.xml");
        assert_eq!(related_part("charts/chart1.xml", "xl/drawings/drawing1.xml"), "xl/drawings/charts/chart1.xml");
        assert_eq!(related_part("../charts/chart1.xml", "xl/drawings/drawing1.xml"), "xl/charts/chart1.xml");
        assert_eq!(related_part("..x", "xl/drawings/drawing1.xml"), "..x");
        assert_eq!(related_part("a.xml", "sheet.xml"), "sheet.xml/a.xml");
    }

    #[test]
    fn the_relationships_part_of_a_part() {
        assert_eq!(rels_name("xl/worksheets/sheet1.xml"), "xl/worksheets/_rels/sheet1.xml.rels");
        assert_eq!(rels_name("sheet1.xml"), "_rels/sheet1.xml.rels");
        assert_eq!(rels_name("xl/"), "xl/");
        assert_eq!(rels_name(""), "");
    }

    #[test]
    fn rows_keep_their_columns_and_drop_trailing_blanks() {
        let sheet = r#"<worksheet><cols><col min="2" max="2" hidden="1"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>x</t></is></c></row><row r="2" hidden="1"><c r="B2"><v>7</v></c></row><row r="3"/></sheetData></worksheet>"#;
        let rows = worksheet_rows(sheet, &["head".to_owned()], &[], usize::MAX).unwrap();
        assert_eq!(rows.text, "head\t\tx\n[hidden] \t7");
        assert!(!rows.truncated);
        assert_eq!(rows.hidden_columns, vec!["B".to_owned()]);
    }

    #[test]
    fn the_build_stops_once_the_text_is_longer_than_the_cap_can_show() {
        let row = |n: usize| format!(r#"<row r="{n}"><c r="A{n}" t="inlineStr"><is><t>abcdefghij</t></is></c></row>"#);
        let sheet = format!("<sheetData>{}</sheetData>", (1..=50).map(row).collect::<String>());
        let rows = worksheet_rows(&sheet, &[], &[], 25).unwrap();
        // 10 characters a line and a newline between: the third line ends at 32 > 25.
        assert_eq!(rows.text.lines().count(), 3);
        let rows = worksheet_rows(&sheet, &[], &[], usize::MAX).unwrap();
        assert_eq!(rows.text.lines().count(), 50);
    }

    #[test]
    fn a_sheet_past_the_row_limit_is_marked_truncated() {
        let sheet = format!("<sheetData>{}</sheetData>", (1..=5001).map(|n| format!(r#"<row r="{n}"><c r="A{n}"><v>{n}</v></c></row>"#)).collect::<String>());
        let rows = worksheet_rows(&sheet, &[], &[], usize::MAX).unwrap();
        assert!(rows.truncated);
        assert_eq!(rows.text.lines().count(), SHEET_MAX_ROWS);
    }

    #[test]
    fn at_most_sixty_four_columns_of_one_declaration_are_hidden() {
        let hidden = hidden_column_numbers(r#"<cols><col min="3" max="200" hidden="1"/><col min="1" max="2" hidden="false"/><col max="5" hidden="1"/></cols>"#);
        assert_eq!(hidden.len(), 64);
        assert_eq!(hidden[0], 3.0);
        assert_eq!(hidden[63], 66.0);
    }
}
