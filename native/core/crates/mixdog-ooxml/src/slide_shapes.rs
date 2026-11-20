//! `portable/portable-slide-shapes.mjs`: the XML of a slide's shapes (a shape, a text box, a picture, a table), the EMU and
//! point arithmetic they share, and the restyling of a shape already on a slide. The builders take what the Node ones
//! took: an options object (`serde_json::Value`), read the way the script reads it (`??`, `Number(...)`, `String(...)`,
//! truthiness), so a value of any JSON type behaves as it did.

use mixdog_js::{
    JsRegex, is_js_space, js_to_lowercase, js_trim, json_number, math, number_to_string, string_to_number, to_number, to_number_of, value_to_string,
};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::xml::{compiled, xml_encode};

pub const EMU_PER_POINT: f64 = 12_700.0;

/// The top-level objects of a slide's shape tree, in the order PowerPoint numbers them: a shape, a picture, a framed
/// chart or table, and a group.
pub const SLIDE_SHAPE_TAGS: [&str; 4] = ["p:sp", "p:pic", "p:graphicFrame", "p:grpSp"];

/// `value ?? fallback` over a value that may be absent: the value unless it is absent or null.
pub(crate) fn coalesce<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    value.filter(|found| !found.is_null()).or(fallback)
}

/// `value != null`.
pub(crate) fn is_set(value: Option<&Value>) -> bool {
    value.is_some_and(|found| !found.is_null())
}

/// `String(value ?? '')`.
pub(crate) fn text_or_empty(value: Option<&Value>) -> String {
    value.filter(|found| !found.is_null()).map(value_to_string).unwrap_or_default()
}

/// `String(value || '')`.
pub(crate) fn text_if_truthy(value: Option<&Value>) -> String {
    value.filter(|found| truthy(found)).map(value_to_string).unwrap_or_default()
}

/// `String(value)` of a value that may be absent (`undefined` prints as such).
pub(crate) fn text_of(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// A parameter with a default: the default only when the argument is absent (a null is `Number(null)` = 0).
pub(crate) fn number_or(value: Option<&Value>, default: f64) -> f64 {
    value.map_or(default, to_number)
}

/// `Number(value) || 0`.
pub(crate) fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() { 0.0 } else { number }
}

/// `${number}`.
pub(crate) fn num(value: f64) -> String {
    number_to_string(value)
}

/// `(pattern.exec(text) ?? [])[1]`: the first group of the first match.
pub(crate) fn first_group(pattern: &JsRegex, text: &str) -> Option<String> {
    pattern.captures(text).and_then(|found| found.get(1).map(str::to_owned))
}

/// `text.replace(pattern, replacer)` for a pattern without the `g` flag.
pub(crate) fn replace_first_with(pattern: &JsRegex, text: &str, with: impl Fn(&mixdog_js::Caps) -> String) -> String {
    match pattern.captures(text) {
        Some(found) => {
            let range = found.range();
            format!("{}{}{}", &text[..range.start], with(&found), &text[range.end..])
        }
        None => text.to_owned(),
    }
}

/// `text.replace(pattern, '')` for a pattern without the `g` flag.
pub(crate) fn remove_first(pattern: &JsRegex, text: &str) -> String {
    replace_first_with(pattern, text, |_| String::new())
}

/// `text.replace(search, () => replacement)` for a string search: the first occurrence.
pub(crate) fn replace_first_text(text: &str, search: &str, replacement: &str) -> String {
    text.replacen(search, replacement, 1)
}

/// `fromEmu(value, fallback)`.
pub fn from_emu(value: f64, fallback: f64) -> f64 {
    if value.is_finite() { value / EMU_PER_POINT } else { fallback }
}

const GEOMETRY: [(&str, &str); 31] = [
    ("rectangle", "rect"),
    ("rect", "rect"),
    ("square", "rect"),
    ("rounded_rectangle", "roundRect"),
    ("rounded_rect", "roundRect"),
    ("roundrect", "roundRect"),
    ("oval", "ellipse"),
    ("ellipse", "ellipse"),
    ("circle", "ellipse"),
    ("triangle", "triangle"),
    ("right_triangle", "rtTriangle"),
    ("diamond", "diamond"),
    ("pentagon", "homePlate"),
    ("hexagon", "hexagon"),
    ("octagon", "octagon"),
    ("chevron", "chevron"),
    ("arrow", "rightArrow"),
    ("right_arrow", "rightArrow"),
    ("left_arrow", "leftArrow"),
    ("up_arrow", "upArrow"),
    ("down_arrow", "downArrow"),
    ("line", "line"),
    ("star", "star5"),
    ("parallelogram", "parallelogram"),
    ("trapezoid", "trapezoid"),
    ("can", "can"),
    ("cloud", "cloud"),
    ("donut", "donut"),
    ("plus", "mathPlus"),
    ("minus", "mathMinus"),
    ("callout", "wedgeRectCallout"),
];

const ALIGNMENT: [(&str, &str); 6] = [("left", "l"), ("center", "ctr"), ("centre", "ctr"), ("right", "r"), ("justify", "just"), ("distributed", "dist")];

const ANCHOR: [(&str, &str); 5] = [("top", "t"), ("center", "ctr"), ("centre", "ctr"), ("middle", "ctr"), ("bottom", "b")];

fn lookup(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(name, _)| *name == key).map(|(_, value)| *value)
}

/// `toEmu(points)`: points to EMU, a non-finite value as zero.
pub fn to_emu(points: f64) -> f64 {
    math::round(if points.is_finite() { points } else { 0.0 } * EMU_PER_POINT)
}

/// `toEmu(value)` of a value that may be absent.
pub(crate) fn to_emu_of(value: Option<&Value>) -> f64 {
    to_emu(to_number_of(value))
}

/// `normalizeHex(value)`: six upper-case hex digits (three are doubled), or empty.
pub fn normalize_hex(value: Option<&Value>) -> String {
    let text = text_or_empty(value);
    let trimmed = js_trim(&text);
    let raw = trimmed.strip_prefix('#').unwrap_or(trimmed).to_uppercase();
    let hex = raw.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'A'..=b'F'));
    if hex && raw.len() == 6 {
        return raw;
    }
    if hex && raw.len() == 3 {
        return raw.chars().flat_map(|digit| [digit, digit]).collect();
    }
    String::new()
}

/// `resolveGeometry(shapeType)`: the preset geometry a shape word names, or empty.
pub fn resolve_geometry(shape_type: Option<&Value>) -> &'static str {
    let given = text_if_truthy(shape_type);
    let lowered = js_to_lowercase(js_trim(&given));
    let key = compiled(r"[\s-]+", "g").replace_all_with(&lowered, |_| "_".to_owned());
    lookup(&GEOMETRY, &key).unwrap_or("")
}

/// `supportedShapeTypes()`.
pub fn supported_shape_types() -> Vec<&'static str> {
    GEOMETRY.iter().map(|(name, _)| *name).collect()
}

fn solid_fill_hex(hex: &str, transparency: Option<&Value>) -> String {
    let alpha = to_number_of(transparency);
    let modifier = if alpha.is_finite() && alpha > 0.0 {
        format!("<a:alpha val=\"{}\"/>", num(math::round(math::max(0.0, math::min(100.0, 100.0 - alpha)) * 1000.0)))
    } else {
        String::new()
    };
    format!("<a:solidFill><a:srgbClr val=\"{hex}\">{modifier}</a:srgbClr></a:solidFill>")
}

fn solid_fill(color: Option<&Value>, transparency: Option<&Value>) -> String {
    let hex = normalize_hex(color);
    if hex.is_empty() { String::new() } else { solid_fill_hex(&hex, transparency) }
}

fn outline(properties: &Value) -> String {
    let color = normalize_hex(properties.get("lineColor"));
    if color.is_empty() {
        return if properties.get("lineColor") == Some(&Value::Null) { "<a:ln><a:noFill/></a:ln>".to_owned() } else { String::new() };
    }
    let width = to_number_of(properties.get("lineWidth"));
    let attribute = if width.is_finite() && width > 0.0 { format!(" w=\"{}\"", num(to_emu(width))) } else { String::new() };
    format!("<a:ln{attribute}>{}</a:ln>", solid_fill_hex(&color, properties.get("lineTransparency")))
}

fn run_properties(source: &Value, defaults: &Value) -> (String, String) {
    let size = to_number_of(coalesce(source.get("fontSize"), defaults.get("fontSize")));
    let name = coalesce(source.get("fontName"), defaults.get("fontName"));
    let color = normalize_hex(coalesce(source.get("color"), defaults.get("color")));
    let bold = coalesce(source.get("bold"), defaults.get("bold"));
    let italic = coalesce(source.get("italic"), defaults.get("italic"));
    let mut attributes = " lang=\"en-US\"".to_owned();
    if size.is_finite() && size > 0.0 {
        attributes.push_str(&format!(" sz=\"{}\"", num(math::round(size * 100.0))));
    }
    if bold == Some(&Value::Bool(true)) {
        attributes.push_str(" b=\"1\"");
    }
    if italic == Some(&Value::Bool(true)) {
        attributes.push_str(" i=\"1\"");
    }
    attributes.push_str(" dirty=\"0\"");
    let mut children = if color.is_empty() { String::new() } else { solid_fill_hex(&color, None) };
    if let Some(name) = name.filter(|name| truthy(name)) {
        let face = xml_encode(&value_to_string(name));
        children.push_str(&format!("<a:latin typeface=\"{face}\"/><a:ea typeface=\"{face}\"/><a:cs typeface=\"{face}\"/>"));
    }
    (attributes, children)
}

fn paragraph_xml(paragraph: &Value, defaults: &Value) -> String {
    let level = math::max(0.0, math::min(8.0, number_or_zero(paragraph.get("level"))));
    let align_key = js_to_lowercase(&text_or_empty(coalesce(paragraph.get("align"), defaults.get("align"))));
    let align = lookup(&ALIGNMENT, &align_key).unwrap_or("");
    let spacing = to_number_of(coalesce(paragraph.get("paragraphSpacing"), defaults.get("paragraphSpacing")));
    let bulleted = paragraph.get("bullet") == Some(&Value::Bool(true));
    // A bullet hangs 22 pt and each level steps in by as much again, as the Office backend sets it: one margin for
    // every level set a sub-point flush with the point it belongs to.
    let indent = if bulleted { math::round(2.2 * EMU_PER_POINT * 10.0) } else { 0.0 };
    let mut properties = String::from("<a:pPr");
    if level != 0.0 {
        properties.push_str(&format!(" lvl=\"{}\"", num(level)));
    }
    if bulleted {
        properties.push_str(&format!(" marL=\"{}\" indent=\"{}\"", num(indent * (level + 1.0)), num(-indent)));
    } else {
        properties.push_str(" marL=\"0\" indent=\"0\"");
    }
    if !align.is_empty() {
        properties.push_str(&format!(" algn=\"{align}\""));
    }
    properties.push('>');
    if spacing.is_finite() && spacing > 0.0 {
        properties.push_str(&format!("<a:spcBef><a:spcPts val=\"{}\"/></a:spcBef>", num(math::round(spacing * 100.0))));
    }
    properties.push_str(if bulleted { "<a:buFont typeface=\"Arial\"/><a:buChar char=\"&#8226;\"/>" } else { "<a:buNone/>" });
    properties.push_str("</a:pPr>");
    let text = text_or_empty(paragraph.get("text"));
    let (attributes, children) = run_properties(paragraph, defaults);
    let spaced = text.chars().next().is_some_and(is_js_space) || text.chars().next_back().is_some_and(is_js_space);
    let body = if text.is_empty() {
        format!("<a:endParaRPr{attributes}>{children}</a:endParaRPr>")
    } else {
        let preserve = if spaced { " xml:space=\"preserve\"" } else { "" };
        format!("<a:r><a:rPr{attributes}>{children}</a:rPr><a:t{preserve}>{}</a:t></a:r>", xml_encode(&text))
    };
    format!("<a:p>{properties}{body}</a:p>")
}

/// `textBodyXml({ paragraphs, defaults, anchor, wrap, margins, autofit })`: the text body of a shape, from its paragraphs
/// (`{ text, level, align, bullet, ... }`) and the defaults they inherit.
pub fn text_body_xml(options: &Value) -> String {
    let empty = Vec::new();
    let paragraphs = options.get("paragraphs").and_then(Value::as_array).unwrap_or(&empty);
    let no_defaults = Value::Object(Map::new());
    let defaults = options.get("defaults").unwrap_or(&no_defaults);
    let anchor = text_if_truthy(options.get("anchor"));
    let anchor_value = lookup(&ANCHOR, &js_to_lowercase(&anchor)).unwrap_or("");
    let wrap = options.get("wrap").is_none_or(truthy);
    let margins = options.get("margins");
    let mut inset = String::new();
    for (edge, attribute) in [("Left", "lIns"), ("Top", "tIns"), ("Right", "rIns"), ("Bottom", "bIns")] {
        let value = margins.and_then(|margins| margins.get(format!("margin{edge}")));
        if is_set(value) {
            inset.push_str(&format!(" {attribute}=\"{}\"", num(to_emu_of(value))));
        }
    }
    let fit = match options.get("autofit").and_then(Value::as_str).unwrap_or("none") {
        "shrink" => "<a:normAutofit/>",
        "resize" => "<a:spAutoFit/>",
        _ => "<a:noAutofit/>",
    };
    let body: String = if paragraphs.is_empty() {
        paragraph_xml(&json!({ "text": "" }), defaults)
    } else {
        paragraphs.iter().map(|paragraph| paragraph_xml(paragraph, defaults)).collect()
    };
    let anchor_attribute = if anchor_value.is_empty() { String::new() } else { format!(" anchor=\"{anchor_value}\"") };
    format!("<a:bodyPr wrap=\"{}\"{inset}{anchor_attribute}>{fit}</a:bodyPr><a:lstStyle/>{body}", if wrap { "square" } else { "none" })
}

fn frame(left: f64, top: f64, width: f64, height: f64, rotation: Option<&Value>) -> String {
    let angle = to_number_of(rotation);
    let rot = if angle.is_finite() && angle != 0.0 { format!(" rot=\"{}\"", num(math::round(angle * 60_000.0))) } else { String::new() };
    format!(
        "<a:xfrm{rot}><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>",
        num(to_emu(left)),
        num(to_emu(top)),
        num(math::max(1.0, to_emu(width))),
        num(math::max(1.0, to_emu(height)))
    )
}

/// The `left, top, width, height` a builder reads, each defaulting when absent.
fn box_of(options: &Value, width: f64, height: f64) -> (f64, f64, f64, f64) {
    (number_or(options.get("left"), 0.0), number_or(options.get("top"), 0.0), number_or(options.get("width"), width), number_or(options.get("height"), height))
}

/// `shapeXml({ id, name, geometry, left, top, width, height, properties, textBody, textBox })`.
pub fn shape_xml(options: &Value) -> String {
    let no_properties = Value::Object(Map::new());
    let properties = options.get("properties").unwrap_or(&no_properties);
    let text_box = options.get("textBox").is_some_and(truthy);
    let id = text_of(options.get("id"));
    let name = options.get("name").filter(|value| truthy(value)).map_or_else(|| format!("Shape {id}"), value_to_string);
    let geometry = options.get("geometry").map_or_else(|| "rect".to_owned(), value_to_string);
    let (left, top, width, height) = box_of(options, 100.0, 50.0);
    let mut fill = if text_box { "<a:noFill/>".to_owned() } else { String::new() };
    if properties.get("fillColor").is_some() {
        let filled = solid_fill(properties.get("fillColor"), properties.get("fillTransparency"));
        fill = if filled.is_empty() { "<a:noFill/>".to_owned() } else { filled };
    }
    let mut line = outline(properties);
    if line.is_empty() && text_box {
        line = "<a:ln><a:noFill/></a:ln>".to_owned();
    }
    // The shadow and the description set_shape writes; a new shape dropped both on both backends.
    let effects = match properties.get("shadow").filter(|value| truthy(value)) {
        Some(shadow) => format!("<a:effectLst>{}</a:effectLst>", shadow_xml(shadow)),
        None => String::new(),
    };
    let description = match properties.get("altText").filter(|value| truthy(value)) {
        Some(text) => format!(" descr=\"{}\"", xml_encode(&value_to_string(text))),
        None => String::new(),
    };
    let text_body = options.get("textBody").map(value_to_string).unwrap_or_default();
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{}\"{description}/><p:cNvSpPr{}/><p:nvPr/></p:nvSpPr><p:spPr>{}<a:prstGeom prst=\"{geometry}\"><a:avLst/></a:prstGeom>{fill}{line}{effects}</p:spPr><p:txBody>{text_body}</p:txBody></p:sp>",
        xml_encode(&name),
        if text_box { " txBox=\"1\"" } else { "" },
        frame(left, top, width, height, properties.get("rotation"))
    )
}

fn crop_rect_xml(crop: Option<&Value>) -> String {
    let Some(crop) = crop.filter(|value| truthy(value)) else { return String::new() };
    let side = |key: &str| math::round(math::max(0.0, math::min(1.0, number_or_zero(crop.get(key)))) * 100_000.0);
    let (l, t, r, b) = (side("left"), side("top"), side("right"), side("bottom"));
    if ![l, t, r, b].iter().any(|value| *value > 0.0) {
        return String::new();
    }
    format!("<a:srcRect l=\"{}\" t=\"{}\" r=\"{}\" b=\"{}\"/>", num(l), num(t), num(r), num(b))
}

/// `pictureXml({ id, name, embedId, left, top, width, height, crop, altText })`.
pub fn picture_xml(options: &Value) -> String {
    let id = text_of(options.get("id"));
    let name = options.get("name").filter(|value| truthy(value)).map_or_else(|| format!("Picture {id}"), value_to_string);
    let (left, top, width, height) = box_of(options, 100.0, 100.0);
    // `altText ? ...`: a null or other falsy description (an operation's `altText: null`) writes none.
    let description = match options.get("altText").filter(|value| truthy(value)) {
        Some(text) => format!(" descr=\"{}\"", xml_encode(&value_to_string(text))),
        None => String::new(),
    };
    format!(
        "<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"{}\"{description}/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed=\"{}\"/>{}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{}<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
        xml_encode(&name),
        text_of(options.get("embedId")),
        crop_rect_xml(options.get("crop")),
        frame(left, top, width, height, None)
    )
}

// A table the caller did not style reads the way the Word writer's does: a rule under the header, hairlines between
// the rows, no verticals. Left to the reader, the same table came out as a black grid in LibreOffice and bare text in
// PowerPoint (no style, no borders), neither of them the deck it sat in.
const TABLE_HEADER_RULE: &str = "9AA3AD";
const TABLE_ROW_RULE: &str = "D8DCE0";

fn table_line(side: &str, rule: Option<(&str, &str)>) -> String {
    match rule {
        Some((color, width)) => format!(
            "<a:{side} w=\"{width}\" cap=\"flat\" cmpd=\"sng\"><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill><a:prstDash val=\"solid\"/></a:{side}>"
        ),
        None => format!("<a:{side} w=\"0\"><a:noFill/></a:{side}>"),
    }
}

fn table_cell_lines(header: bool) -> String {
    let bottom = if header { table_line("lnB", Some((TABLE_HEADER_RULE, "12700"))) } else { table_line("lnB", Some((TABLE_ROW_RULE, "6350"))) };
    format!("{}{}{}{bottom}", table_line("lnL", None), table_line("lnR", None), table_line("lnT", None))
}

/// A figure sits on the right edge of its column, and its header over it: "1,420", "−12", "8.4", "94.1%", "2,840원".
const TABLE_FIGURE: &str = r"^[\s~+\-−–$€₩£(]*[\d.,]+\s*(?:[%xXKMBT]|배|건|억|조|만|천|원|시간|일|개월|개|명|대|곳|분|초|회|점|년)*[)]?\s*$|^[-–—]$";

fn table_cell_xml(text: &Value, header: bool, properties: &Value, fill: &str, align: &str) -> String {
    let mut defaults = Map::new();
    let color = if header { coalesce(properties.get("headerColor"), properties.get("color")) } else { properties.get("color") };
    for (key, value) in [("fontName", properties.get("fontName")), ("fontSize", properties.get("fontSize")), ("color", color)] {
        if let Some(value) = value {
            defaults.insert(key.to_owned(), value.clone());
        }
    }
    if header {
        defaults.insert("bold".to_owned(), Value::Bool(true));
    } else if let Some(bold) = properties.get("bold") {
        defaults.insert("bold".to_owned(), bold.clone());
    }
    let fallback = Value::from(align);
    let cell_align = coalesce(properties.get("align"), Some(&fallback)).cloned().unwrap_or(Value::Null);
    let body = text_body_xml(&json!({
        "paragraphs": [{ "text": text, "align": cell_align }],
        "defaults": defaults,
        "anchor": "center",
        "margins": { "marginLeft": 7, "marginRight": 7, "marginTop": 3, "marginBottom": 3 },
    }));
    let fill_xml = if fill.is_empty() { String::new() } else { solid_fill_hex(fill, None) };
    format!("<a:tc><a:txBody>{body}</a:txBody><a:tcPr anchor=\"ctr\">{}{fill_xml}</a:tcPr></a:tc>", table_cell_lines(header))
}

/// `tableXml({ id, name, values, left, top, width, height, properties })`: an error when `values` holds no row or no column.
pub fn table_xml(options: &Value) -> Result<String, String> {
    let no_properties = Value::Object(Map::new());
    let properties = options.get("properties").unwrap_or(&no_properties);
    let rows: Vec<&Vec<Value>> =
        options.get("values").and_then(Value::as_array).map(|values| values.iter().filter_map(Value::as_array).collect()).unwrap_or_default();
    if rows.is_empty() {
        return Err("add_table requires values as a non-empty array of rows".to_owned());
    }
    let columns = rows.iter().map(|row| row.len()).max().unwrap_or(0);
    if columns == 0 {
        return Err("add_table requires at least one column".to_owned());
    }
    let id = text_of(options.get("id"));
    let name = options.get("name").filter(|value| truthy(value)).map_or_else(|| format!("Table {id}"), value_to_string);
    let (left, top, width, height) = box_of(options, 400.0, 200.0);
    // columnWidths (points, one per column) share the frame's width in their proportions; without them the columns are
    // equal.
    let declared: Vec<f64> = properties.get("columnWidths").and_then(Value::as_array).map(|widths| widths.iter().map(to_number).collect()).unwrap_or_default();
    let shares: Vec<f64> = if declared.len() == columns && declared.iter().all(|value| *value > 0.0) {
        let total = declared.iter().fold(0.0, |sum, entry| sum + entry);
        declared.iter().map(|value| value / total).collect()
    } else {
        vec![1.0 / columns as f64; columns]
    };
    let header_height = number_or_zero(properties.get("headerRowHeight"));
    let body_height = number_or_zero(properties.get("bodyRowHeight"));
    let grid: String = shares.iter().map(|share| format!("<a:gridCol w=\"{}\"/>", num(math::max(1.0, math::round(to_emu(width) * share))))).collect();
    let header_fill = normalize_hex(properties.get("headerFillColor"));
    let body_fill = normalize_hex(properties.get("bodyFillColor"));
    let figure = compiled(TABLE_FIGURE, "");
    let alignments: Vec<&str> = (0..columns)
        .map(|column| {
            let cells: Vec<String> =
                rows.iter().skip(1).map(|row| js_trim(&text_or_empty(row.get(column))).to_owned()).filter(|cell| !cell.is_empty()).collect();
            if column > 0 && !cells.is_empty() && cells.iter().all(|cell| figure.is_match(cell)) { "right" } else { "left" }
        })
        .collect();
    let mut body = String::new();
    for (row_index, row) in rows.iter().enumerate() {
        let header = row_index == 0;
        let row_height = if header {
            if header_height != 0.0 { header_height } else { body_height }
        } else if body_height != 0.0 {
            body_height
        } else {
            header_height
        };
        let height_emu = if row_height != 0.0 { to_emu(row_height) } else { math::round(to_emu(height) / rows.len() as f64) };
        let fill = if header { &header_fill } else { &body_fill };
        let cells: String = (0..columns)
            .map(|column| {
                let cell = row.get(column).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| Value::from(""));
                table_cell_xml(&cell, header, properties, fill, alignments[column])
            })
            .collect();
        body.push_str(&format!("<a:tr h=\"{}\">{cells}</a:tr>", num(height_emu)));
    }
    Ok(format!(
        "<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp=\"1\"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></p:xfrm><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/table\"><a:tbl><a:tblPr firstRow=\"1\" bandRow=\"1\"/><a:tblGrid>{grid}</a:tblGrid>{body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>",
        xml_encode(&name),
        num(to_emu(left)),
        num(to_emu(top)),
        num(math::max(1.0, to_emu(width))),
        num(math::max(1.0, to_emu(height)))
    ))
}

/// An attribute list with one attribute set (or added) to a value.
fn with_attribute(attributes: &str, name: &str, value: &str) -> String {
    let stripped = remove_first(&compiled(&format!("\\s{name}=\"[^\"]*\""), ""), attributes);
    format!("{stripped} {name}=\"{value}\"")
}

/// One run property element (a:rPr or a:endParaRPr) restyled: size and weight on the tag, the colour first among its
/// children and the faces after it, as the schema orders them.
fn restyled_run(tag: &str, attributes: &str, children: &str, properties: &Value) -> String {
    let mut attrs = attributes.to_owned();
    let size = to_number_of(properties.get("fontSize"));
    if size.is_finite() && size > 0.0 {
        attrs = with_attribute(&attrs, "sz", &num(math::round(size * 100.0)));
    }
    if let Some(bold) = properties.get("bold").filter(|value| !value.is_null()) {
        attrs = with_attribute(&attrs, "b", if truthy(bold) { "1" } else { "0" });
    }
    if let Some(italic) = properties.get("italic").filter(|value| !value.is_null()) {
        attrs = with_attribute(&attrs, "i", if truthy(italic) { "1" } else { "0" });
    }
    let mut body = children.to_owned();
    let fill = solid_fill(properties.get("color"), None);
    if !fill.is_empty() {
        let old_fill = compiled(r"<a:(?:solidFill|gradFill)\b[\s\S]*?</a:(?:solidFill|gradFill)>|<a:noFill/>", "g");
        body = format!("{fill}{}", old_fill.replace_all_with(&body, |_| String::new()));
    }
    if let Some(name) = properties.get("fontName").filter(|value| truthy(value)) {
        let face = xml_encode(&value_to_string(name));
        let faces = format!("<a:latin typeface=\"{face}\"/><a:ea typeface=\"{face}\"/><a:cs typeface=\"{face}\"/>");
        body = compiled(r"<a:(?:latin|ea|cs)\b[^>]*/>", "g").replace_all_with(&body, |_| String::new());
        match compiled(r"<a:(?:sym|hlinkClick|hlinkMouseOver|rtl|extLst)\b", "").find(&body) {
            Some(tail) => body = format!("{}{faces}{}", &body[..tail.start], &body[tail.start..]),
            None => body.push_str(&faces),
        }
    }
    if body.is_empty() { format!("<a:{tag}{attrs}/>") } else { format!("<a:{tag}{attrs}>{body}</a:{tag}>") }
}

/// A shadow as the Office backend's Shape.Shadow writes it: true is PowerPoint's own (black, a 5 pt blur, 2.08 pt down and
/// right); an object names its colour, transparency (0-1, as Shadow.Transparency), blur and offsets in points.
fn shadow_xml(shadow: &Value) -> String {
    let none = Value::Object(Map::new());
    let spec = if shadow == &Value::Bool(true) { &none } else { shadow };
    let read = |key: &str, default: f64| -> f64 {
        match spec.get(key).filter(|value| !value.is_null()) {
            Some(value) => to_number(value),
            None => default,
        }
    };
    let offset_x = read("offsetX", 2.08);
    let offset_y = read("offsetY", 2.08);
    let degrees = (math::atan2(offset_y, offset_x) * 180.0 / std::f64::consts::PI + 360.0) % 360.0;
    let transparency = math::max(0.0, math::min(1.0, number_or_zero(spec.get("transparency"))));
    let alpha = if transparency != 0.0 { format!("<a:alpha val=\"{}\"/>", num(math::round((1.0 - transparency) * 100_000.0))) } else { String::new() };
    let color = normalize_hex(spec.get("color"));
    format!(
        "<a:outerShdw blurRad=\"{}\" dist=\"{}\" dir=\"{}\" rotWithShape=\"0\"><a:srgbClr val=\"{}\">{alpha}</a:srgbClr></a:outerShdw>",
        num(to_emu(math::max(0.0, read("blur", 5.0)))),
        num(to_emu(math::hypot(&[offset_x, offset_y]))),
        num(math::round(degrees * 60_000.0)),
        if color.is_empty() { "000000" } else { &color }
    )
}

/// The shape's outer shadow set, its other effects kept in the schema's order.
fn with_shadow(shape: &str, shadow: &Value) -> String {
    let sp_pr = compiled(r"<p:spPr\b[^>]*>([\s\S]*?)</p:spPr>", "");
    let Some(found) = sp_pr.captures(shape) else { return shape.to_owned() };
    let whole = found.range();
    let inside = found.get(1).unwrap_or("");
    let existing = compiled(r"<a:effectLst\b[^>]*?(?:/>|>([\s\S]*?)</a:effectLst>)", "").captures(inside);
    let kept = remove_first(&compiled(r"<a:outerShdw\b[\s\S]*?</a:outerShdw>", ""), existing.as_ref().and_then(|found| found.get(1)).unwrap_or(""));
    let at = compiled(r"<a:(?:prstShdw|reflection|softEdge)\b", "").find(&kept).map_or(kept.len(), |later| later.start);
    let list = format!("<a:effectLst>{}{}{}</a:effectLst>", &kept[..at], shadow_xml(shadow), &kept[at..]);
    let inner = match &existing {
        Some(found) => {
            let range = found.range();
            format!("{}{list}{}", &inside[..range.start], &inside[range.end..])
        }
        None => {
            let position = compiled(r"<a:(?:effectDag|scene3d|sp3d|extLst)\b", "").find(inside).map_or(inside.len(), |after| after.start);
            format!("{}{list}{}", &inside[..position], &inside[position..])
        }
    };
    let opening = &shape[whole.start..whole.end];
    let start = whole.start + opening.find('>').unwrap_or(0) + 1;
    format!("{}{inner}{}", &shape[..start], &shape[start + inside.len()..])
}

/// `restyleShapeText(shape, properties)`: a shape's text restyled the way the Office backend sets it through the text
/// frame (every paragraph's alignment, every run's face, size, weight and colour, the frame's anchor and insets) and its
/// outline.
pub fn restyle_shape_text(shape: &str, properties: &Value) -> String {
    let mut next = shape.to_owned();
    let sp_pr = compiled(r"<p:spPr\b[^>]*>([\s\S]*?)</p:spPr>", "").captures(&next).map(|found| (found.range(), found.get(1).unwrap_or("").to_owned()));
    // A width or transparency alone restyles the outline the shape has, and a new colour keeps its width, as the Office
    // backend's Line does; both were dropped here unless a colour came with them.
    let line_element = compiled(r"<a:ln\b[^>]*?(?:/>|>[\s\S]*?</a:ln>)", "");
    let existing_line = sp_pr.as_ref().and_then(|(_, inside)| line_element.find(inside).map(|range| inside[range].to_owned())).unwrap_or_default();
    let existing_alpha = first_group(&compiled(r#"<a:alpha val="(\d+)""#, ""), &existing_line);
    let mut line = Map::new();
    match properties.get("lineColor") {
        Some(color) => {
            line.insert("lineColor".to_owned(), color.clone());
        }
        None => {
            if let Some(color) = first_group(&compiled(r#"<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})""#, ""), &existing_line) {
                line.insert("lineColor".to_owned(), Value::String(color));
            }
        }
    }
    match properties.get("lineWidth").filter(|value| !value.is_null()) {
        Some(width) => {
            line.insert("lineWidth".to_owned(), width.clone());
        }
        None => {
            let stated = first_group(&compiled(r#"\bw="(\d+)""#, ""), &existing_line).map_or(f64::NAN, |text| string_to_number(&text));
            let width = stated / EMU_PER_POINT;
            if !width.is_nan() && width != 0.0 {
                line.insert("lineWidth".to_owned(), json_number(width));
            }
        }
    }
    match properties.get("lineTransparency").filter(|value| !value.is_null()) {
        Some(transparency) => {
            line.insert("lineTransparency".to_owned(), transparency.clone());
        }
        None => {
            if let Some(alpha) = existing_alpha {
                line.insert("lineTransparency".to_owned(), json_number(100.0 - string_to_number(&alpha) / 1000.0));
            }
        }
    }
    let line = Value::Object(line);
    let line_requested = ["lineColor", "lineWidth", "lineTransparency"].iter().any(|key| properties.get(*key).is_some());
    if let Some((range, inside)) = &sp_pr {
        if line_requested && (!normalize_hex(line.get("lineColor")).is_empty() || line.get("lineColor") == Some(&Value::Null)) {
            // The outline follows the fill and precedes any effects in the shape properties.
            let stripped = remove_first(&line_element, inside);
            let at = compiled(r"<a:(?:effectLst|effectDag|scene3d|sp3d|extLst)\b", "").find(&stripped).map_or(stripped.len(), |effects| effects.start);
            let inner = format!("{}{}{}", &stripped[..at], outline(&line), &stripped[at..]);
            let opening = &next[range.start..range.end];
            let start = range.start + opening.find('>').unwrap_or(0) + 1;
            next = format!("{}{inner}{}", &next[..start], &next[start + inside.len()..]);
        }
    }
    if let Some(shadow) = properties.get("shadow").filter(|value| truthy(value)) {
        next = with_shadow(&next, shadow);
    }
    let Some((body_range, body)) =
        compiled(r"<p:txBody>([\s\S]*?)</p:txBody>", "").captures(&next).map(|found| (found.range(), found.get(1).unwrap_or("").to_owned()))
    else {
        return next;
    };
    let anchor_key = js_to_lowercase(&text_if_truthy(properties.get("verticalAlignment")));
    let mut inner = replace_first_with(&compiled(r"<a:bodyPr\b([^>]*?)(/?)>", ""), &body, |found| {
        let mut attrs = found.get(1).unwrap_or("").to_owned();
        if let Some(anchor) = lookup(&ANCHOR, &anchor_key) {
            attrs = with_attribute(&attrs, "anchor", anchor);
        }
        for (name, attribute) in [("marginLeft", "lIns"), ("marginTop", "tIns"), ("marginRight", "rIns"), ("marginBottom", "bIns")] {
            if is_set(properties.get(name)) {
                attrs = with_attribute(&attrs, attribute, &num(to_emu_of(properties.get(name))));
            }
        }
        format!("<a:bodyPr{attrs}{}>", found.get(2).unwrap_or(""))
    });
    let spacing = to_number_of(properties.get("paragraphSpacing"));
    if is_set(properties.get("paragraphSpacing")) && spacing.is_finite() {
        // Space before every paragraph, as add_shape writes it and the Office backend sets it; set_shape ignored it.
        let before = if spacing > 0.0 { format!("<a:spcBef><a:spcPts val=\"{}\"/></a:spcBef>", num(math::round(spacing * 100.0))) } else { String::new() };
        inner = compiled(r"<a:p>(?!<a:pPr)", "g").replace_all_with(&inner, |_| "<a:p><a:pPr/>".to_owned());
        inner = compiled(r"<a:pPr\b([^>]*?)/>", "g").replace_all_with(&inner, |found| format!("<a:pPr{}></a:pPr>", found.get(1).unwrap_or("")));
        inner = compiled(r"(<a:pPr\b[^>]*>)([\s\S]*?)</a:pPr>", "g").replace_all_with(&inner, |found| {
            let rest = remove_first(&compiled(r"<a:spcBef>[\s\S]*?</a:spcBef>", ""), found.get(2).unwrap_or(""));
            // lnSpc is the one child the schema puts before spcBef.
            let line_spacing = compiled(r"^<a:lnSpc>[\s\S]*?</a:lnSpc>", "").find(&rest).map_or("", |range| &rest[range]);
            format!("{}{line_spacing}{before}{}</a:pPr>", found.get(1).unwrap_or(""), &rest[line_spacing.len()..])
        });
    }
    let inner = restyled_paragraphs(&inner, properties);
    format!("{}<p:txBody>{inner}</p:txBody>{}", &next[..body_range.start], &next[body_range.end..])
}

/// `restyledParagraphs(inner, properties)`: a text body's paragraphs aligned (`properties.alignment`) and its runs
/// restyled: face, size, weight, colour.
pub fn restyled_paragraphs(inner: &str, properties: &Value) -> String {
    let mut next = inner.to_owned();
    let align_key = js_to_lowercase(&text_if_truthy(properties.get("alignment")));
    if let Some(align) = lookup(&ALIGNMENT, &align_key) {
        next = compiled(r"<a:p>(?!<a:pPr)", "g").replace_all_with(&next, |_| "<a:p><a:pPr/>".to_owned());
        next = compiled(r"<a:pPr\b([^>]*?)(/?)>", "g")
            .replace_all_with(&next, |found| format!("<a:pPr{}{}>", with_attribute(found.get(1).unwrap_or(""), "algn", align), found.get(2).unwrap_or("")));
    }
    if ["fontName", "fontSize", "bold", "italic", "color"].iter().any(|name| is_set(properties.get(*name))) {
        next = compiled(r"<a:r>(?!<a:rPr)", "g").replace_all_with(&next, |_| "<a:r><a:rPr/>".to_owned());
        next = compiled(r"<a:(rPr|endParaRPr)\b([^>]*?)(?:/>|>([\s\S]*?)</a:\1>)", "g")
            .replace_all_with(&next, |found| restyled_run(found.get(1).unwrap_or(""), found.get(2).unwrap_or(""), found.get(3).unwrap_or(""), properties));
    }
    next
}

/// `textAnchor(verticalAlignment)`: the vertical anchor a text frame or table cell takes for a word, or empty for none.
pub fn text_anchor(vertical_alignment: Option<&Value>) -> &'static str {
    lookup(&ANCHOR, &js_to_lowercase(&text_if_truthy(vertical_alignment))).unwrap_or("")
}

/// `solidFillXml(color, transparency)`.
pub fn solid_fill_xml(color: Option<&Value>, transparency: Option<&Value>) -> String {
    solid_fill(color, transparency)
}

/// `backgroundXml(color)`: an error when the colour is not a hex one.
pub fn background_xml(color: Option<&Value>) -> Result<String, String> {
    let hex = normalize_hex(color);
    if hex.is_empty() {
        return Err("set_slide_background requires a hex color".to_owned());
    }
    Ok(format!("<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{hex}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn points_become_whole_emu_and_a_non_finite_value_is_zero() {
        assert_eq!(to_emu(12.5), 158_750.0);
        assert_eq!(to_emu(f64::NAN), 0.0);
        assert_eq!(from_emu(127_000.0, 5.0), 10.0);
        assert_eq!(from_emu(f64::NAN, 5.0), 5.0);
    }

    #[test]
    fn a_colour_is_six_upper_case_hex_digits_or_nothing() {
        assert_eq!(normalize_hex(Some(&json!(" #abc "))), "AABBCC");
        assert_eq!(normalize_hex(Some(&json!("0a1b2c"))), "0A1B2C");
        assert_eq!(normalize_hex(Some(&json!("12345"))), "");
        assert_eq!(normalize_hex(None), "");
    }

    #[test]
    fn a_shape_word_names_a_preset_geometry() {
        assert_eq!(resolve_geometry(Some(&json!("Rounded Rectangle"))), "roundRect");
        assert_eq!(resolve_geometry(Some(&json!(" right-arrow "))), "rightArrow");
        assert_eq!(resolve_geometry(Some(&json!("blob"))), "");
        assert_eq!(supported_shape_types().len(), 31);
    }

    #[test]
    fn a_bullet_hangs_and_each_level_steps_in() {
        let body = text_body_xml(&json!({ "paragraphs": [{ "text": "a", "bullet": true, "level": 1 }] }));
        assert!(body.contains("lvl=\"1\" marL=\"558800\" indent=\"-279400\""), "{body}");
        assert!(body.contains("<a:buChar char=\"&#8226;\"/>"));
    }

    #[test]
    fn a_picture_with_a_null_description_writes_none() {
        assert!(!picture_xml(&json!({ "id": 4, "embedId": "rId2", "altText": null })).contains("descr="));
        assert!(picture_xml(&json!({ "id": 4, "embedId": "rId2", "altText": "Logo" })).contains(" descr=\"Logo\""));
    }

    #[test]
    fn a_table_without_rows_or_columns_is_refused() {
        assert_eq!(table_xml(&json!({ "values": [] })), Err("add_table requires values as a non-empty array of rows".to_owned()));
        assert_eq!(table_xml(&json!({ "values": [[]] })), Err("add_table requires at least one column".to_owned()));
    }

    #[test]
    fn a_figure_column_is_aligned_right_under_its_header() {
        let xml = table_xml(&json!({ "id": 1, "values": [["Item", "Qty"], ["Pen", "1,420"], ["Ink", "-"]] })).expect("table");
        assert_eq!(xml.matches("algn=\"ctr\"").count(), 0);
        assert_eq!(xml.matches("algn=\"r\"").count(), 3);
    }
}
