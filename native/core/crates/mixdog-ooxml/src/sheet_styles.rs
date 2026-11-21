//! `portable/portable-sheet-styles.mjs`: the workbook's styles.xml read and edited as the XML it is. Fonts, fills, borders,
//! number formats and cell formats (`cellXfs`) are added or reused in the order Node does, so the style index a cell is
//! given equals the one Node writes; the table that maps an index back to a resolved style (`resolve_cell_styles`) and the
//! number-format helpers every reader asks live here too.
//!
//! Numbers read from a styles part stay `f64` as in JavaScript (`Number("1.5") || 0`), so an odd file is read as Node reads
//! it; they are written back with `number_to_string`.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, js_trim, math, number_to_string, string_to_number, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::xml::{compiled, xml_decode, xml_encode};

const SECTION_ORDER: [&str; 11] = ["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"];
const EDITED_SECTIONS: [&str; 5] = ["numFmts", "fonts", "fills", "borders", "cellXfs"];
const COUNTED_SECTIONS: [&str; 8] = ["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs"];
const FIRST_CUSTOM_NUMBER_FORMAT: f64 = 164.0;

const BORDER_SIDES: [&str; 4] = ["left", "right", "top", "bottom"];
const BORDER_STYLES: [&str; 8] = ["none", "hair", "thin", "medium", "thick", "dashed", "dotted", "double"];

fn horizontal_alignment(name: &str) -> &'static str {
    match name {
        "left" => "left",
        "center" | "centre" => "center",
        "right" => "right",
        "justify" => "justify",
        "fill" => "fill",
        "distributed" => "distributed",
        "general" => "general",
        _ => "",
    }
}

fn vertical_alignment(name: &str) -> &'static str {
    match name {
        "top" => "top",
        "center" | "centre" | "middle" => "center",
        "bottom" => "bottom",
        "justify" => "justify",
        "distributed" => "distributed",
        _ => "",
    }
}

/// The first match of an element (self-closing or with content) of a section name.
fn section_match(xml: &str, name: &str) -> Option<std::ops::Range<usize>> {
    compiled(&format!(r"<{name}\b[^>]*?(?:\/>|>[\s\S]*?<\/{name}>)"), "").find(xml)
}

fn section_body<'a>(element: &'a str, name: &str) -> &'a str {
    if element.is_empty() || element.ends_with("/>") {
        return "";
    }
    let start = element.find('>').map_or(0, |at| at + 1);
    let end = element.rfind(&format!("</{name}>")).unwrap_or(element.len());
    element.get(start..end).unwrap_or("")
}

fn child_elements(body: &str, name: &str) -> Vec<String> {
    compiled(&format!(r"<{name}\b[^>]*?(?:\/>|>[\s\S]*?<\/{name}>)"), "g").find_iter(body).map(|range| body[range].to_owned()).collect()
}

fn collection(xml: &str, container: &str, item: &str) -> Vec<String> {
    match section_match(xml, container) {
        Some(range) => child_elements(section_body(&xml[range], container), item),
        None => Vec::new(),
    }
}

/// `attribute(source, name)`: the value of the first `name="..."`, empty when absent.
fn attribute(source: &str, name: &str) -> String {
    compiled(&format!(r#"\b{name}="([^"]*)""#), "").captures(source).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default()
}

/// `Number(text) || 0`.
fn number_or_zero(text: &str) -> f64 {
    let number = string_to_number(text);
    if number.is_nan() { 0.0 } else { number }
}

/// `items[index]` for a JavaScript number index: only a whole number inside the list names an item.
fn item_at(items: &[String], index: f64) -> Option<&str> {
    if index >= 0.0 && index.fract() == 0.0 && index < items.len() as f64 { items.get(index as usize).map(String::as_str) } else { None }
}

/// The group-1 text of the first match of a pattern, `""` when it does not match (`regex.exec(xml)?.[1] || ''`).
fn first_group(pattern: &JsRegex, text: &str) -> String {
    pattern.captures(text).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default()
}

fn flag(xml: &str, tag: &str) -> bool {
    let Some(found) = compiled(&format!(r"<{tag}(\s[^>]*?)?/>"), "").captures(xml) else { return false };
    let value = attribute(found.get(1).unwrap_or(""), "val");
    value.is_empty() || value == "1" || value == "true"
}

/// `normalizeColor` of a text: `AARRGGBB` upper-cased, `FF` added to a six-digit colour, a three-digit one doubled; empty
/// when it is none of these.
pub fn normalize_color(value: &str) -> String {
    let trimmed = js_trim(value);
    let raw = trimmed.strip_prefix('#').unwrap_or(trimmed).to_uppercase();
    let hex = |text: &str| text.bytes().all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte));
    if !raw.is_ascii() || !hex(&raw) {
        return String::new();
    }
    match raw.len() {
        8 => raw,
        6 => format!("FF{raw}"),
        3 => format!("FF{}", raw.chars().flat_map(|digit| [digit, digit]).collect::<String>()),
        _ => String::new(),
    }
}

/// `normalizeColor(value)` for a value that may be absent or any JSON value (`String(value || '')`).
pub fn normalize_color_value(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(value) => normalize_color(&value_to_string(value)),
        _ => String::new(),
    }
}

struct Font {
    bold: bool,
    italic: bool,
    size: f64,
    color: String,
    name: String,
}

static SZ: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<sz\b([^>]*?)\/>", ""));
static COLOR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<color\b([^>]*?)\/>", ""));
static NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<name\b([^>]*?)\/>", ""));
static PATTERN_FILL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<patternFill\b([^>]*?)(?:\/>|>[\s\S]*?<\/patternFill>)", ""));
static FG_COLOR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<fgColor\b([^>]*?)\/>", ""));

fn parse_font(xml: &str) -> Font {
    let size = number_or_zero(&attribute(&first_group(&SZ, xml), "val"));
    let name = xml_decode(&attribute(&first_group(&NAME, xml), "val"));
    Font {
        bold: flag(xml, "b"),
        italic: flag(xml, "i"),
        size: if size == 0.0 { 11.0 } else { size },
        color: normalize_color(&attribute(&first_group(&COLOR, xml), "rgb")),
        name: if name.is_empty() { "Calibri".to_owned() } else { name },
    }
}

fn build_font(font: &Font) -> String {
    format!(
        "<font>{}{}<sz val=\"{}\"/>{}<name val=\"{}\"/><family val=\"2\"/></font>",
        if font.bold { "<b/>" } else { "" },
        if font.italic { "<i/>" } else { "" },
        number_to_string(font.size),
        if font.color.is_empty() { String::new() } else { format!("<color rgb=\"{}\"/>", font.color) },
        xml_encode(&font.name),
    )
}

/// The solid colour of a fill, empty for any other fill.
fn parse_fill(xml: &str) -> String {
    let Some(pattern) = PATTERN_FILL.captures(xml) else { return String::new() };
    if attribute(pattern.get(1).unwrap_or(""), "patternType") != "solid" {
        return String::new();
    }
    normalize_color(&attribute(&first_group(&FG_COLOR, &xml[pattern.range()]), "rgb"))
}

fn build_fill(color: &str) -> String {
    if color.is_empty() {
        "<fill><patternFill patternType=\"none\"/></fill>".to_owned()
    } else {
        format!("<fill><patternFill patternType=\"solid\"><fgColor rgb=\"{color}\"/><bgColor indexed=\"64\"/></patternFill></fill>")
    }
}

/// A border edge: its style and colour (empty colour is automatic).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Edge {
    style: String,
    color: String,
}

type Border = [Option<Edge>; 4];

fn parse_border(xml: &str) -> Border {
    BORDER_SIDES.map(|side| {
        let element = compiled(&format!(r"<{side}\b([^>]*?)(?:\/>|>([\s\S]*?)<\/{side}>)"), "").captures(xml)?;
        let style = attribute(element.get(1).unwrap_or(""), "style");
        if style.is_empty() || style == "none" {
            return None;
        }
        Some(Edge { color: normalize_color(&attribute(&first_group(&COLOR, element.get(2).unwrap_or("")), "rgb")), style })
    })
}

fn build_border(border: &Border) -> String {
    let side = |index: usize| {
        let name = BORDER_SIDES[index];
        match &border[index] {
            None => format!("<{name}/>"),
            Some(edge) => format!(
                "<{name} style=\"{}\">{}</{name}>",
                edge.style,
                if edge.color.is_empty() { "<color auto=\"1\"/>".to_owned() } else { format!("<color rgb=\"{}\"/>", edge.color) }
            ),
        }
    };
    format!("<border>{}{}{}{}<diagonal/></border>", side(0), side(1), side(2), side(3))
}

/// A spec's `style` field as `String(spec?.style || 'thin')` reads it.
fn spec_style(spec: &Value) -> String {
    match spec.get("style") {
        Some(style) if truthy(style) => value_to_string(style),
        _ => "thin".to_owned(),
    }
}

/// `mergeBorders(base, requested)`: the sides the caller names replace the ones the cell had; the others keep them.
fn merge_borders(base: &Border, requested: Option<&Value>) -> Result<Border, String> {
    let mut next = base.clone();
    let empty = Map::new();
    let sides = match requested {
        Some(Value::Object(object)) => object,
        _ => &empty,
    };
    // One spec for every side (`borders: { style: 'thin', color }`) or a spec per side.
    let uniform =
        BORDER_SIDES.iter().all(|name| !sides.contains_key(*name)) && (sides.get("style").is_some_and(truthy) || sides.get("color").is_some_and(truthy));
    let whole = Value::Object(sides.clone());
    for (index, name) in BORDER_SIDES.iter().enumerate() {
        let spec = if uniform { Some(&whole) } else { sides.get(*name) };
        let Some(spec) = spec else { continue };
        let none = spec.is_null()
            || spec == &Value::Bool(false)
            || spec.as_str() == Some("none")
            || spec.get("style").and_then(Value::as_str) == Some("none")
            || spec.get("enabled") == Some(&Value::Bool(false));
        if none {
            next[index] = None;
            continue;
        }
        let style = js_to_lowercase(&spec_style(spec));
        if !BORDER_STYLES.contains(&style.as_str()) {
            return Err(format!("set_style borders.{name}.style \"{style}\" is not one of {}", BORDER_STYLES.join(", ")));
        }
        next[index] = Some(Edge { style, color: normalize_color_value(spec.get("color")) });
    }
    Ok(next)
}

#[derive(Clone)]
struct Xf {
    num_fmt_id: f64,
    font_id: f64,
    fill_id: f64,
    border_id: f64,
    xf_id: f64,
    horizontal: String,
    vertical: String,
    indent: f64,
    wrap_text: bool,
    locked: bool,
}

static XF_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^<xf\b([^>]*?)(?:\/>|>)", ""));
static ALIGNMENT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<alignment\b([^>]*?)\/?>", ""));
static PROTECTION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<protection\b([^>]*?)\/?>", ""));

fn parse_xf(xml: &str) -> Xf {
    let attrs = first_group(&XF_OPEN, xml);
    let alignment = first_group(&ALIGNMENT, xml);
    let protection = first_group(&PROTECTION, xml);
    let number = |source: &str, name: &str| number_or_zero(&attribute(source, name));
    Xf {
        num_fmt_id: number(&attrs, "numFmtId"),
        font_id: number(&attrs, "fontId"),
        fill_id: number(&attrs, "fillId"),
        border_id: number(&attrs, "borderId"),
        xf_id: number(&attrs, "xfId"),
        horizontal: attribute(&alignment, "horizontal"),
        vertical: attribute(&alignment, "vertical"),
        indent: number(&alignment, "indent"),
        // An xsd:boolean is 1/0 or true/false: LibreOffice writes the words (a recalculated workbook comes back with
        // locked="false" and wrapText="true"), and reading only the digits relocked every entry cell of a form.
        wrap_text: matches!(attribute(&alignment, "wrapText").as_str(), "1" | "true"),
        // Every cell is locked until told otherwise; the flag only takes effect once the sheet itself is protected.
        locked: !matches!(attribute(&protection, "locked").as_str(), "0" | "false"),
    }
}

fn build_xf(xf: &Xf) -> String {
    let aligned = !xf.horizontal.is_empty() || !xf.vertical.is_empty() || xf.wrap_text || xf.indent != 0.0;
    let mut alignment = String::new();
    if aligned {
        let horizontal = if xf.horizontal.is_empty() { String::new() } else { format!(" horizontal=\"{}\"", xf.horizontal) };
        let vertical = if xf.vertical.is_empty() { String::new() } else { format!(" vertical=\"{}\"", xf.vertical) };
        let wrap = if xf.wrap_text { " wrapText=\"1\"" } else { "" };
        let indent = if xf.indent != 0.0 { format!(" indent=\"{}\"", number_to_string(xf.indent)) } else { String::new() };
        alignment = format!("<alignment{horizontal}{vertical}{wrap}{indent}/>");
    }
    // An unlocked cell is how a protected sheet keeps its entry fields typable.
    let protection = if xf.locked { "" } else { "<protection locked=\"0\"/>" };
    let head = format!(
        "<xf numFmtId=\"{}\" fontId=\"{}\" fillId=\"{}\" borderId=\"{}\" xfId=\"{}\"{}{}{}{}{}{}",
        number_to_string(xf.num_fmt_id),
        number_to_string(xf.font_id),
        number_to_string(xf.fill_id),
        number_to_string(xf.border_id),
        number_to_string(xf.xf_id),
        if xf.num_fmt_id != 0.0 { " applyNumberFormat=\"1\"" } else { "" },
        if xf.font_id != 0.0 { " applyFont=\"1\"" } else { "" },
        if xf.fill_id != 0.0 { " applyFill=\"1\"" } else { "" },
        if xf.border_id != 0.0 { " applyBorder=\"1\"" } else { "" },
        if aligned { " applyAlignment=\"1\"" } else { "" },
        if protection.is_empty() { "" } else { " applyProtection=\"1\"" },
    );
    let body = format!("{alignment}{protection}");
    if body.is_empty() { format!("{head}/>") } else { format!("{head}>{body}</xf>") }
}

/// `register(items, candidate)`: the index of an identical item, or of the one appended.
fn register(items: &mut Vec<String>, candidate: String) -> f64 {
    if let Some(found) = items.iter().position(|item| *item == candidate) {
        return found as f64;
    }
    items.push(candidate);
    (items.len() - 1) as f64
}

fn register_number_format(num_fmts: &mut Vec<String>, code: Option<&Value>) -> f64 {
    let text = match code {
        Some(code) if truthy(code) => value_to_string(code),
        _ => String::new(),
    };
    let normalized = js_trim(&text);
    if normalized.is_empty() || js_to_lowercase(normalized) == "general" {
        return 0.0;
    }
    for entry in num_fmts.iter() {
        if xml_decode(&attribute(entry, "formatCode")) == normalized {
            return number_or_zero(&attribute(entry, "numFmtId"));
        }
    }
    let used = num_fmts.iter().map(|entry| number_or_zero(&attribute(entry, "numFmtId")));
    let id = used.fold(FIRST_CUSTOM_NUMBER_FORMAT - 1.0, math::max) + 1.0;
    num_fmts.push(format!("<numFmt numFmtId=\"{}\" formatCode=\"{}\"/>", number_to_string(id), xml_encode(normalized)));
    id
}

/// The sections of a styles part: the five that are edited as lists, the others as the text they have.
struct StyleSheet {
    num_fmts: Vec<String>,
    fonts: Vec<String>,
    fills: Vec<String>,
    borders: Vec<String>,
    cell_xfs: Vec<String>,
    opaque: HashMap<&'static str, String>,
}

impl StyleSheet {
    fn parse(xml: &str) -> Self {
        let mut sheet = Self {
            num_fmts: collection(xml, "numFmts", "numFmt"),
            fonts: collection(xml, "fonts", "font"),
            fills: collection(xml, "fills", "fill"),
            borders: collection(xml, "borders", "border"),
            cell_xfs: collection(xml, "cellXfs", "xf"),
            opaque: HashMap::new(),
        };
        for name in SECTION_ORDER {
            if !EDITED_SECTIONS.contains(&name) {
                sheet.opaque.insert(name, section_match(xml, name).map(|range| xml[range].to_owned()).unwrap_or_default());
            }
        }
        if sheet.fonts.is_empty() {
            sheet.fonts.push("<font><sz val=\"11\"/><name val=\"Calibri\"/><family val=\"2\"/></font>".to_owned());
        }
        if sheet.fills.is_empty() {
            sheet.fills.push(build_fill(""));
            sheet.fills.push("<fill><patternFill patternType=\"gray125\"/></fill>".to_owned());
        }
        if sheet.borders.is_empty() {
            sheet.borders.push("<border><left/><right/><top/><bottom/><diagonal/></border>".to_owned());
        }
        if sheet.cell_xfs.is_empty() {
            sheet.cell_xfs.push("<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>".to_owned());
        }
        sheet
    }

    fn list(&self, name: &str) -> Option<&Vec<String>> {
        match name {
            "numFmts" => Some(&self.num_fmts),
            "fonts" => Some(&self.fonts),
            "fills" => Some(&self.fills),
            "borders" => Some(&self.borders),
            "cellXfs" => Some(&self.cell_xfs),
            _ => None,
        }
    }

    /// The styles part written back: the text up to the root's opening tag, the sections in schema order, the closing tag.
    fn serialize(&self, xml: &str) -> Result<String, String> {
        static ROOT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([\s\S]*?<styleSheet\b[^>]*>)", ""));
        let root = ROOT.captures(xml).ok_or_else(|| "Workbook styles are missing a styleSheet root".to_owned())?;
        let mut out = root.get(1).unwrap_or("").to_owned();
        for name in SECTION_ORDER {
            match self.list(name) {
                Some(items) if items.is_empty() => {}
                Some(items) => {
                    let count = if COUNTED_SECTIONS.contains(&name) { format!(" count=\"{}\"", items.len()) } else { String::new() };
                    out.push_str(&format!("<{name}{count}>{}</{name}>", items.concat()));
                }
                None => out.push_str(self.opaque.get(name).map_or("", String::as_str)),
            }
        }
        out.push_str("</styleSheet>");
        Ok(out)
    }

    fn xf(&self, index: f64) -> Xf {
        parse_xf(item_at(&self.cell_xfs, index).unwrap_or(&self.cell_xfs[0]))
    }

    fn font(&self, id: f64) -> Font {
        parse_font(item_at(&self.fonts, id).unwrap_or(&self.fonts[0]))
    }
}

/// `numberFormatId(stylesXml, code)`: the id the workbook's styles give a format code (as `apply_cell_style` registered
/// it), 0 for General or one not held.
pub fn number_format_id(styles_xml: &str, code: &str) -> f64 {
    let normalized = js_trim(code);
    if normalized.is_empty() || js_to_lowercase(normalized) == "general" {
        return 0.0;
    }
    let sheet = StyleSheet::parse(styles_xml);
    match sheet.num_fmts.iter().find(|entry| xml_decode(&attribute(entry, "formatCode")) == normalized) {
        Some(found) => number_or_zero(&attribute(found, "numFmtId")),
        None => 0.0,
    }
}

/// `styleHasNumberFormat(stylesXml, index)`: whether the cell style at `index` sets a number format of its own (anything
/// but General). `index` is `Number(index) || 0`.
pub fn style_has_number_format(styles_xml: &str, index: f64) -> bool {
    let sheet = StyleSheet::parse(styles_xml);
    sheet.xf(if index.is_nan() { 0.0 } else { index }).num_fmt_id != 0.0
}

/// What [`apply_cell_style`] answers: the styles part and the index of the cell format to give the cell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledXml {
    pub xml: String,
    pub index: usize,
}

/// `applyCellStyle(stylesXml, baseIndex, properties)`: the cell format that is `base_index` with the named properties
/// changed (`color`, `bold`, `italic`, `fontSize`, `fontName`, `fillColor`, `borders`, `numberFormat`,
/// `horizontalAlignment`, `verticalAlignment`, `wrapText`, `locked`, `indent`), added to the styles when no identical one
/// exists. A key that is present is applied even when its value is null, as `Object.hasOwn` reads it.
pub fn apply_cell_style(styles_xml: &str, base_index: f64, properties: &Map<String, Value>) -> Result<StyledXml, String> {
    let mut sheet = StyleSheet::parse(styles_xml);
    let base = sheet.xf(if base_index.is_nan() { 0.0 } else { base_index });
    let font = sheet.font(base.font_id);
    let fill = parse_fill(item_at(&sheet.fills, base.fill_id).unwrap_or(""));
    let mut next = base.clone();
    let has = |name: &str| properties.contains_key(name);

    let font_size = to_number_of(properties.get("fontSize"));
    let next_font = Font {
        bold: if has("bold") { properties.get("bold") == Some(&Value::Bool(true)) } else { font.bold },
        italic: if has("italic") { properties.get("italic") == Some(&Value::Bool(true)) } else { font.italic },
        size: if font_size > 0.0 { font_size } else { font.size },
        color: if has("color") { normalize_color_value(properties.get("color")) } else { font.color.clone() },
        name: match properties.get("fontName") {
            Some(name) if truthy(name) => value_to_string(name),
            _ => font.name.clone(),
        },
    };
    next.font_id = register(&mut sheet.fonts, build_font(&next_font));

    if has("fillColor") {
        let color = normalize_color_value(properties.get("fillColor"));
        next.fill_id = if color.is_empty() { 0.0 } else { register(&mut sheet.fills, build_fill(&color)) };
    } else if !fill.is_empty() {
        next.fill_id = register(&mut sheet.fills, build_fill(&fill));
    }

    if has("borders") {
        let current = parse_border(item_at(&sheet.borders, base.border_id).unwrap_or(""));
        let merged = merge_borders(&current, properties.get("borders"))?;
        next.border_id = if merged.iter().any(Option::is_some) { register(&mut sheet.borders, build_border(&merged)) } else { 0.0 };
    }

    if has("numberFormat") {
        next.num_fmt_id = register_number_format(&mut sheet.num_fmts, properties.get("numberFormat"));
    }
    if has("horizontalAlignment") {
        let name = js_to_lowercase(&value_to_string(&properties["horizontalAlignment"]));
        next.horizontal = horizontal_alignment(&name).to_owned();
    }
    if has("verticalAlignment") {
        let name = js_to_lowercase(&value_to_string(&properties["verticalAlignment"]));
        next.vertical = vertical_alignment(&name).to_owned();
    }
    if has("wrapText") {
        next.wrap_text = properties.get("wrapText") == Some(&Value::Bool(true));
    }
    if has("locked") {
        next.locked = properties.get("locked") != Some(&Value::Bool(false));
    }
    // Indent levels (Excel's 0-15, each about one character) from the edge the text is set on; an indented cell with no
    // alignment of its own is set left, as Excel sets it.
    if has("indent") {
        let requested = to_number_of(properties.get("indent"));
        let requested = if requested.is_nan() { 0.0 } else { requested };
        next.indent = math::max(0.0, math::min(15.0, math::round(requested)));
        if next.indent != 0.0 && (next.horizontal.is_empty() || next.horizontal == "general") {
            next.horizontal = "left".to_owned();
        }
    }

    let index = register(&mut sheet.cell_xfs, build_xf(&next)) as usize;
    Ok(StyledXml { xml: sheet.serialize(styles_xml)?, index })
}

/// Implicit number formats (ECMA-376 section 18.8.30); a workbook never writes these into numFmts, so a cell carrying one
/// reads back as its id alone.
fn built_in_number_format(id: f64) -> Option<&'static str> {
    if id.fract() != 0.0 {
        return None;
    }
    Some(match id as i64 {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        14 => "mm-dd-yy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;[Red](#,##0.00)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        48 => "##0.0E+0",
        49 => "@",
        _ => return None,
    })
}

/// The General format under any Excel UI language (Korean G/표준, Japanese G/標準, German Standard), and the empty format a
/// cell carries when it has none: neither is a format anyone chose. Every reader asks here.
static GENERAL_NUMBER_FORMAT: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:general|g\/표준|g\/標準|standard|standaard|général|generale|estándar|padrão|общий|常规|通用格式)?$", "i"));

/// `GENERAL_NUMBER_FORMAT.test(code)`.
pub fn is_general_number_format(code: &str) -> bool {
    GENERAL_NUMBER_FORMAT.is_match(code)
}

/// The last six characters of a colour (`color.slice(-6)`).
fn rgb_of(color: &str) -> &str {
    color.get(color.len().saturating_sub(6)..).unwrap_or(color)
}

/// A colour of a style as six hex digits: Excel reports BGR integers (black font 0, no fill 16777215), the portable
/// snapshot RRGGBB; `blank` is the integer that means none.
fn style_hex(value: Option<&Value>, blank: f64) -> String {
    let number = match value {
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite()),
        _ => None,
    };
    let Some(number) = number else { return rgb_of(&normalize_color_value(value)).to_owned() };
    let number = math::max(0.0, math::round(number));
    if number == blank {
        return String::new();
    }
    // The bit operators of JavaScript work on the number as a 32-bit integer.
    let int32 = number.rem_euclid(4_294_967_296.0) as u32 as i32;
    [int32 & 0xff, (int32 >> 8) & 0xff, (int32 >> 16) & 0xff].iter().map(|channel| format!("{channel:02X}")).collect::<String>()
}

/// `normalizeExcelCellStyle(style)`: Excel's cell style (BGR integer colours, a General format on every cell) in the
/// portable shape (RRGGBB, defaults omitted). A value that is not an object is returned as it is.
pub fn normalize_excel_cell_style(style: &Value) -> Value {
    let Value::Object(fields) = style else { return style.clone() };
    let color = style_hex(fields.get("color"), 0.0);
    let fill_color = style_hex(fields.get("fillColor"), 16_777_215.0);
    let number_format = match fields.get("numberFormat") {
        Some(format) if truthy(format) => js_trim(&value_to_string(format)).to_owned(),
        _ => String::new(),
    };
    let general = is_general_number_format(&number_format);
    let mut out = Map::new();
    for (key, value) in fields {
        if !["color", "fillColor", "numberFormat", "bold", "italic"].contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    if fields.get("bold") == Some(&Value::Bool(true)) {
        out.insert("bold".to_owned(), Value::Bool(true));
    }
    if fields.get("italic") == Some(&Value::Bool(true)) {
        out.insert("italic".to_owned(), Value::Bool(true));
    }
    if !number_format.is_empty() && !general {
        out.insert("numberFormat".to_owned(), Value::from(number_format));
    }
    if !color.is_empty() && color != "000000" {
        out.insert("color".to_owned(), Value::from(color));
    }
    if !fill_color.is_empty() && fill_color != "FFFFFF" {
        out.insert("fillColor".to_owned(), Value::from(fill_color));
    }
    Value::Object(out)
}

/// `resolveCellStyles(stylesXml)`: the cell-style table (cellXfs index to resolved style) a snapshot attaches to each
/// styled cell, so a reader can see number formats, input colours and fills without Excel. Colours are RRGGBB; theme
/// colours are not resolved. An empty part has no table.
pub fn resolve_cell_styles(styles_xml: &str) -> Vec<Value> {
    if styles_xml.is_empty() {
        return Vec::new();
    }
    let sheet = StyleSheet::parse(styles_xml);
    let mut number_formats: HashMap<u64, String> = HashMap::new();
    for entry in &sheet.num_fmts {
        number_formats.insert(number_or_zero(&attribute(entry, "numFmtId")).to_bits(), xml_decode(&attribute(entry, "formatCode")));
    }
    sheet
        .cell_xfs
        .iter()
        .map(|xf_xml| {
            let xf = parse_xf(xf_xml);
            let font = sheet.font(xf.font_id);
            let fill = parse_fill(item_at(&sheet.fills, xf.fill_id).unwrap_or(""));
            let number_format = number_formats
                .get(&xf.num_fmt_id.to_bits())
                .cloned()
                .or_else(|| built_in_number_format(xf.num_fmt_id).map(str::to_owned))
                .unwrap_or_else(|| "General".to_owned());
            let mut style = Map::new();
            if number_format != "General" {
                style.insert("numberFormat".to_owned(), Value::from(number_format));
            }
            style.insert("fontName".to_owned(), Value::from(font.name.as_str()));
            style.insert("fontSize".to_owned(), mixdog_js::json_number(font.size));
            if font.bold {
                style.insert("bold".to_owned(), json!(true));
            }
            if font.italic {
                style.insert("italic".to_owned(), json!(true));
            }
            if !font.color.is_empty() {
                style.insert("color".to_owned(), Value::from(rgb_of(&font.color)));
            }
            if !fill.is_empty() {
                style.insert("fillColor".to_owned(), Value::from(rgb_of(&fill)));
            }
            if !xf.horizontal.is_empty() {
                style.insert("horizontalAlignment".to_owned(), Value::from(xf.horizontal.as_str()));
            }
            if !xf.vertical.is_empty() {
                style.insert("verticalAlignment".to_owned(), Value::from(xf.vertical.as_str()));
            }
            if xf.wrap_text {
                style.insert("wrapText".to_owned(), json!(true));
            }
            if xf.indent != 0.0 {
                style.insert("indent".to_owned(), mixdog_js::json_number(xf.indent));
            }
            if !xf.locked {
                style.insert("locked".to_owned(), json!(false));
            }
            Value::Object(style)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "<?xml version=\"1.0\"?><styleSheet xmlns=\"x\"><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>\
<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>\
<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>\
<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>\
<cellXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs></styleSheet>";

    fn props(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn colours_normalise_to_eight_digits() {
        assert_eq!(normalize_color("#ff0000"), "FFFF0000");
        assert_eq!(normalize_color("0f0"), "FF00FF00");
        assert_eq!(normalize_color("80112233"), "80112233");
        assert_eq!(normalize_color("red"), "");
        assert_eq!(normalize_color_value(None), "");
        assert_eq!(normalize_color_value(Some(&json!(0))), "");
    }

    #[test]
    fn an_identical_style_is_the_same_index_and_a_new_one_is_appended() {
        let first = apply_cell_style(BASE, 0.0, &props(json!({ "bold": true, "numberFormat": "#,##0.0" }))).unwrap();
        assert_eq!(first.index, 1);
        assert!(first.xml.contains("<numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"#,##0.0\"/></numFmts>"));
        assert!(first.xml.contains("<fonts count=\"2\">"));
        let again = apply_cell_style(&first.xml, 0.0, &props(json!({ "bold": true, "numberFormat": "#,##0.0" }))).unwrap();
        assert_eq!(again.index, 1);
        assert_eq!(again.xml, first.xml);
        let other = apply_cell_style(&first.xml, 1.0, &props(json!({ "numberFormat": "0%" }))).unwrap();
        assert_eq!(other.index, 2);
        assert!(other.xml.contains("numFmtId=\"165\""));
    }

    #[test]
    fn borders_merge_per_side_and_a_bad_style_is_refused() {
        let styled = apply_cell_style(BASE, 0.0, &props(json!({ "borders": { "bottom": { "style": "Thin", "color": "#112233" } } }))).unwrap();
        assert!(styled.xml.contains("<bottom style=\"thin\"><color rgb=\"FF112233\"/></bottom>"));
        let error = apply_cell_style(BASE, 0.0, &props(json!({ "borders": { "top": { "style": "wavy" } } }))).unwrap_err();
        assert_eq!(error, "set_style borders.top.style \"wavy\" is not one of none, hair, thin, medium, thick, dashed, dotted, double");
        let cleared = apply_cell_style(&styled.xml, 1.0, &props(json!({ "borders": { "bottom": "none" } }))).unwrap();
        assert!(cleared.xml.contains("<borders count=\"2\">"));
    }

    #[test]
    fn indent_sets_the_cell_left_and_alignment_words_are_normalised() {
        let styled = apply_cell_style(BASE, 0.0, &props(json!({ "indent": 20, "verticalAlignment": "Middle", "locked": false }))).unwrap();
        let resolved = resolve_cell_styles(&styled.xml);
        assert_eq!(resolved[styled.index]["indent"], json!(15));
        assert_eq!(resolved[styled.index]["horizontalAlignment"], json!("left"));
        assert_eq!(resolved[styled.index]["verticalAlignment"], json!("center"));
        assert_eq!(resolved[styled.index]["locked"], json!(false));
    }

    #[test]
    fn a_styles_part_without_a_root_cannot_be_written() {
        assert_eq!(apply_cell_style("<x/>", 0.0, &Map::new()).unwrap_err(), "Workbook styles are missing a styleSheet root");
    }

    #[test]
    fn number_format_lookups_and_built_in_formats() {
        let styled = apply_cell_style(BASE, 0.0, &props(json!({ "numberFormat": "yyyy-mm-dd" }))).unwrap();
        assert_eq!(number_format_id(&styled.xml, " yyyy-mm-dd "), 164.0);
        assert_eq!(number_format_id(&styled.xml, "General"), 0.0);
        assert!(style_has_number_format(&styled.xml, styled.index as f64));
        assert!(!style_has_number_format(&styled.xml, 0.0));
        let builtin = BASE.replace("<cellXfs count=\"1\"><xf numFmtId=\"0\"", "<cellXfs count=\"1\"><xf numFmtId=\"14\"");
        assert_eq!(resolve_cell_styles(&builtin)[0]["numberFormat"], json!("mm-dd-yy"));
    }

    #[test]
    fn excel_styles_read_in_the_portable_shape() {
        let style = json!({ "color": 255, "fillColor": 16_777_215, "numberFormat": "General", "bold": true, "italic": false, "fontSize": 9 });
        assert_eq!(normalize_excel_cell_style(&style), json!({ "fontSize": 9, "bold": true, "color": "FF0000" }));
        assert_eq!(normalize_excel_cell_style(&json!({ "numberFormat": "G/표준", "fillColor": "#abc" })), json!({ "fillColor": "AABBCC" }));
        assert_eq!(normalize_excel_cell_style(&json!(7)), json!(7));
    }
}
