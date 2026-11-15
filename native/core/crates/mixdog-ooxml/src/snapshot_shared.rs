//! `portable/portable-snapshot-shared.mjs`: helpers shared by the per-format snapshots: run fonts, related parts, chart parts
//! and pagination facts.

use mixdog_js::{json_number, math, string_to_number, to_number_of};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::opc::{part_relationship_path, relationship_target};
use crate::pptx_chart::detect_chart_type;
use crate::slide_shapes::number_or_zero;
use crate::xml::{block_text, compiled, xml_attribute, xml_decode};
use crate::zipio::Package;

fn first_group(pattern: &str, flags: &str, text: &str) -> Option<String> {
    compiled(pattern, flags).captures(text).and_then(|found| found.get(1).map(str::to_owned))
}

/// `docxRunFont(xml)`: the type a run states: size (the largest, in points), weight, face, colour, caps and tracking. Word
/// keeps a heading's type in styles.xml, not on its runs: a document whose headings carry no direct formatting reads as
/// sizeless unless the style chain is resolved. Each style answers with what it states, then with what it is based on, and
/// finally with the document defaults.
pub fn docx_run_font(xml: &str) -> Value {
    let sizes: Vec<f64> = compiled(r#"<w:sz\b[^>]*\bw:val="(\d+)""#, "g")
        .captures_iter(xml)
        .map(|found| string_to_number(found.get(1).unwrap_or("")) / 2.0)
        .filter(|size| *size > 0.0)
        .collect();
    // Automatic colour is the effective default, black. Caps and tracking are left out when unstated, and stated as false / 0
    // when the run switches them off, so an inheriting style can tell a reset from silence.
    let color = first_group(r#"<w:color\b[^>]*\bw:val="([0-9A-Fa-f]{6}|auto)""#, "", xml);
    let tracking = first_group(r#"<w:spacing\b[^>]*\bw:val="(-?\d+)""#, "", xml);
    let caps_off = compiled(r#"\bw:val="(?:0|false)""#, "");
    let caps_tags: Vec<String> = compiled(r"<w:(?:caps|smallCaps)\b([^>]*)>", "g")
        .captures_iter(xml)
        .map(|found| found.get(1).unwrap_or("").to_owned())
        .collect();
    let caps = caps_tags.iter().any(|tag| !caps_off.is_match(tag));
    let mut font = Map::new();
    font.insert("size".to_owned(), json_number(sizes.iter().copied().fold(0.0, math::max)));
    font.insert("bold".to_owned(), Value::Bool(compiled(r#"<w:b\b(?![^>]*\bw:val="(?:0|false)")"#, "").is_match(xml)));
    font.insert("name".to_owned(), Value::String(xml_decode(&first_group(r#"<w:rFonts\b[^>]*\bw:ascii="([^"]*)""#, "", xml).unwrap_or_default())));
    if let Some(color) = color.filter(|color| !color.is_empty()) {
        font.insert("color".to_owned(), Value::String(if color == "auto" { "000000".to_owned() } else { color.to_uppercase() }));
    }
    if !caps_tags.is_empty() {
        font.insert("caps".to_owned(), Value::Bool(caps));
    }
    if let Some(value) = tracking {
        font.insert("letterSpacing".to_owned(), json_number(string_to_number(&value) / 20.0));
    }
    Value::Object(font)
}

/// `docxParagraphSpacing(xml)`: paragraph spacing before/after in points, as the paragraph or style properties state it
/// (`{ spacingBefore?, spacingAfter? }`).
pub fn docx_paragraph_spacing(xml: &str) -> Value {
    let properties = compiled(r"<w:pPr\b[^>]*>[\s\S]*?</w:pPr>", "").find(xml).map_or(xml, |found| &xml[found]);
    let read = |name: &str| -> Option<Value> {
        first_group(&format!(r#"<w:spacing\b[^>]*\bw:{name}="(\d+)""#), "", properties).map(|value| json_number(string_to_number(&value) / 20.0))
    };
    let mut spacing = Map::new();
    if let Some(before) = read("before") {
        spacing.insert("spacingBefore".to_owned(), before);
    }
    if let Some(after) = read("after") {
        spacing.insert("spacingAfter".to_owned(), after);
    }
    Value::Object(spacing)
}

/// `relatedPartById(zip, part, id)`: the part a relationship id points at, used to walk worksheet, drawing, chart. Empty for
/// an id the part does not declare, or an external target.
pub fn related_part_by_id(zip: &Package, part: &str, id: &str) -> String {
    if id.is_empty() {
        return String::new();
    }
    let relationship_path = part_relationship_path(part);
    let relationships = zip.text(&relationship_path);
    if relationships.is_empty() {
        return String::new();
    }
    for found in compiled(r"<Relationship\b[^>]*?/?>", "g").find_iter(&relationships) {
        let element = &relationships[found];
        if xml_attribute(element, "Id") != id {
            continue;
        }
        if compiled(r#"\bTargetMode="External""#, "i").is_match(element) {
            return String::new();
        }
        let target = xml_attribute(element, "Target");
        return if target.is_empty() { String::new() } else { relationship_target(&relationship_path, &target) };
    }
    String::new()
}

/// `chartPartSnapshot(xml)`: what a chart part carries, in the shape a review reads: its plot kind, title, and the series
/// with the ranges they pull from.
pub fn chart_part_snapshot(xml: &str) -> Value {
    let series: Vec<Value> = compiled(r"<c:ser>([\s\S]*?)</c:ser>", "g")
        .captures_iter(xml)
        .enumerate()
        .map(|(index, found)| {
            let body = found.get(1).unwrap_or("");
            // Each reference is read inside its own element: a name written as text (<c:tx><c:v>Value</c:v></c:tx>) has no
            // formula, and a search past </c:tx> reported the category range as the series name's.
            let element = |tag: &str| first_group(&format!(r"<c:{tag}>([\s\S]*?)</c:{tag}>"), "", body).unwrap_or_default();
            let reference = |tag: &str| xml_decode(&first_group(r"<c:f>([\s\S]*?)</c:f>", "", &element(tag)).unwrap_or_default());
            let points = first_group(r#"<c:val>[\s\S]*?<c:ptCount\b[^>]*\bval="(\d+)""#, "", body);
            json!({
                "index": index + 1,
                "name": xml_decode(&first_group(r"<c:v>([\s\S]*?)</c:v>", "", &element("tx")).unwrap_or_default()),
                "formula": reference("tx"),
                "categoryFormula": reference("cat"),
                "valueFormula": reference("val"),
                "pointCount": json_number(points.map_or(0.0, |count| string_to_number(&count))),
            })
        })
        .collect();
    // A column and a bar are both barChart; only the direction (and the grouping) tells them apart, so the reader uses the
    // same names the writer takes rather than the element name alone.
    let chart_type = if compiled(r"<c:\w+Chart\b", "").is_match(xml) { detect_chart_type(xml) } else { "" };
    let title = first_group(r"<c:title>([\s\S]*?)</c:title>", "", xml).unwrap_or_default();
    json!({
        "chartType": chart_type,
        "title": block_text(&title, "a:t"),
        "seriesCount": series.len(),
        // What tells one series from another on the page: the legend the chart draws, or labels that carry the series name.
        // Without either, two series are two colours and the reader has nothing to read them by.
        "legend": compiled(r"<c:legend>", "").is_match(xml),
        "seriesNamesShown": compiled(r#"<c:showSerName val="1"/>"#, "").is_match(xml),
        "series": series,
    })
}

/// `nextPageOffset(offset, returned, total)`: the offset of the next page, or `None` once the window reached the end.
pub fn next_page_offset(offset: f64, returned: f64, total: f64) -> Option<f64> {
    if offset + returned < total { Some(offset + returned) } else { None }
}

/// `populatedCellPagination({ options, page, selectedSheets, sheets, sheetOffset })`: pagination facts for a paged workbook
/// read: the populated-cell window of the sheet just read, and the next sheet when this one is read out and the caller named
/// none. `page` is `{ records, total }` or null; `sheets_len` is how many sheets the workbook has.
pub fn populated_cell_pagination(
    options: &Value,
    page: &Value,
    selected_sheets: &[Value],
    sheets_len: usize,
    sheet_offset: f64,
) -> Value {
    let offset = math::max(0.0, number_or_zero(options.get("offset")));
    let has_page = truthy(page);
    let returned = (if has_page { page.get("records").and_then(Value::as_array).map_or(0, Vec::len) } else { 0 }) as f64;
    let total_value = page.get("total").filter(|value| truthy(value)).cloned().unwrap_or_else(|| Value::from(0));
    let next_offset = if has_page { next_page_offset(offset, returned, to_number_of(Some(&total_value))) } else { None };
    let range_suffix = options.get("range").filter(|value| truthy(value)).map(|range| format!("!{}", mixdog_js::value_to_string(range))).unwrap_or_default();
    let sheet_name = selected_sheets.first().and_then(|sheet| sheet.get("name")).filter(|name| truthy(name)).map(mixdog_js::value_to_string).unwrap_or_default();
    let mut pagination = Map::new();
    pagination.insert("unit".to_owned(), Value::from("populated-cell"));
    pagination.insert("scope".to_owned(), Value::String(format!("{sheet_name}{range_suffix}")));
    pagination.insert("offset".to_owned(), json_number(offset));
    pagination.insert("limit".to_owned(), json_number(math::max(1.0, {
        let limit = number_or_zero(options.get("limit"));
        if limit == 0.0 { 2000.0 } else { limit }
    })));
    pagination.insert("returned".to_owned(), json_number(returned));
    pagination.insert("total".to_owned(), total_value);
    pagination.insert("nextOffset".to_owned(), next_offset.map_or(Value::Null, json_number));
    if next_offset.is_none() && !options.get("sheet").is_some_and(truthy) && sheet_offset + 1.0 < sheets_len as f64 {
        pagination.insert("nextSheetOffset".to_owned(), json_number(sheet_offset + 1.0));
    }
    Value::Object(pagination)
}

/// `statedRunFont(xml)`: `{ font }` when the run states any type of its own, otherwise `{}`.
pub fn stated_run_font(xml: &str) -> Value {
    let direct = docx_run_font(xml);
    let stated = ["size", "bold", "name", "color"].iter().any(|key| direct.get(*key).is_some_and(truthy))
        || direct.get("caps").is_some()
        || direct.get("letterSpacing").is_some();
    if stated { json!({ "font": direct }) } else { json!({}) }
}

/// `softBreakFacts(xml)`: `{ softBreaks }` when the paragraph holds line breaks that are not page or column breaks.
pub fn soft_break_facts(xml: &str) -> Value {
    let count = compiled(r"<w:br\b(?![^>]*\bw:type=)", "g").find_iter(xml).count();
    if count > 0 { json!({ "softBreaks": count }) } else { json!({}) }
}
