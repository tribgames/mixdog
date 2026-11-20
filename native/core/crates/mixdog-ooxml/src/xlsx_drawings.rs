//! `portable/portable-xlsx-drawings.mjs`: everything that lives on a worksheet's drawing part: the picture bytes and their
//! anchor, the anchor arithmetic a cell placement needs, and the move / resize / delete of a picture or chart frame already on
//! the sheet (including the parts a deleted frame owned alone). Each operation takes the package, the sheet, the worksheet XML
//! and the operation (`serde_json::Value`, read the way the script reads it) and answers the JSON the script answered.

use std::path::Path;
use std::sync::LazyLock;

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, js_to_lowercase, js_trim, math, number_to_string, string_to_number, to_number_of, value_to_string};
use mixdog_office_base::a1::{column_number, parse_cell_ref};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

use crate::cells::Sheet;
use crate::opc::{
    IMAGE_CONTENT_TYPES, PIXELS_TO_POINTS, add_package_relationship, ensure_default_content_type, image_content_type, image_pixel_size, part_relationship_path,
    posix, relationship_target_by_type, remove_content_type_override, remove_package_relationship,
};
use crate::package::os_message;
use crate::sheet_page::{fit_drawing_sheet_one_page_wide, workbook_digit_width, worksheet_geometry};
use crate::sheet_parts::ensure_worksheet_drawing;
use crate::slide_shapes::{replace_first_with, to_emu, to_emu_of};
use crate::text_metrics::TextMeasurer;
use crate::xml::{OFFICE_RELATIONSHIP_BASE, compiled, tag_pattern, xml_attribute, xml_decode, xml_encode};
use crate::zipio::Package;

macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

static ANCHOR_COUNT: LazyLock<JsRegex> = regex!(r"<xdr:(?:absolute|two|one)CellAnchor\b", "g");
static DRAWING_ANCHOR: LazyLock<JsRegex> = regex!(r"<xdr:(absoluteAnchor|oneCellAnchor|twoCellAnchor)\b[^>]*>[\s\S]*?<\/xdr:\1>", "g");
static ANCHOR_NAME: LazyLock<JsRegex> = regex!(r#"<xdr:cNvPr\b[^>]*\bname="([^"]*)""#, "");
static ANCHOR_CHART: LazyLock<JsRegex> = regex!(r#"<c:chart\b[^>]*\br:id="([^"]+)""#, "");
static ANCHOR_EMBED: LazyLock<JsRegex> = regex!(r#"<a:blip\b[^>]*\br:embed="([^"]+)""#, "");
static RELATIONSHIP_ELEMENT: LazyLock<JsRegex> = regex!(r"<Relationship\b[^>]*\/>", "g");
static RELS_PART: LazyLock<JsRegex> = regex!(r"\.rels$", "i");
static EXTERNAL_SCHEME: LazyLock<JsRegex> = regex!(r"^[a-z]+:", "i");
static FROM_MARKER: LazyLock<JsRegex> = regex!(r"<xdr:from>[\s\S]*?<\/xdr:from>", "");
static TO_MARKER: LazyLock<JsRegex> = regex!(r"<xdr:to>[\s\S]*?<\/xdr:to>", "");
static POSITION: LazyLock<JsRegex> = regex!(r"<xdr:pos\b([^>]*)\/>", "");
static POSITION_ELEMENT: LazyLock<JsRegex> = regex!(r"<xdr:pos\b[^>]*\/>", "");
static EXTENT: LazyLock<JsRegex> = regex!(r"<xdr:ext\b([^>]*)\/>", "");
static EXTENT_ELEMENT: LazyLock<JsRegex> = regex!(r"<xdr:ext\b[^>]*\/>", "");

const EMU_PER_POINT_XLSX: f64 = 12700.0;

/// Where a new chart or picture frame sits: at a cell, or at a point. `None` is a field the operation did not state
/// (`undefined`); a stated `null` is `Some(&Value::Null)`.
#[derive(Debug, Clone, Copy)]
pub struct FramePlacement<'a> {
    pub cell: Option<&'a Value>,
    pub left: Option<&'a Value>,
    pub top: Option<&'a Value>,
    pub width: f64,
    pub height: f64,
}

/// `frameAnchorXml({ cell, left, top, width, height }, frame)`: the anchor a new chart or picture frame takes. Placed at a
/// cell (and no point position), the frame hangs off that cell as a oneCellAnchor and moves with it: an absolute position
/// written from the widths at the time stayed put when a later autofit widened the columns, and a chart placed beside its
/// table at E9 ended up across it (C9).
pub fn frame_anchor_xml(placement: &FramePlacement<'_>, frame: &str) -> Result<String, String> {
    let ext = format!(
        "<xdr:ext cx=\"{}\" cy=\"{}\"/>",
        number_to_string(math::max(1.0, to_emu(placement.width))),
        number_to_string(math::max(1.0, to_emu(placement.height)))
    );
    if let Some(cell) = placement.cell.filter(|cell| truthy(cell))
        && placement.left.is_none()
        && placement.top.is_none()
    {
        let parsed = parse_cell_ref(&value_to_string(cell))?;
        return Ok(format!(
            "<xdr:oneCellAnchor><xdr:from><xdr:col>{}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>{ext}{frame}<xdr:clientData/></xdr:oneCellAnchor>",
            number_to_string(column_number(&parsed.col) - 1.0),
            number_to_string(parsed.row as f64 - 1.0),
        ));
    }
    let point = |value: Option<&Value>| match value {
        None | Some(Value::Null) => to_emu(0.0),
        Some(value) => to_emu_of(Some(value)),
    };
    Ok(format!(
        "<xdr:absoluteAnchor><xdr:pos x=\"{}\" y=\"{}\"/>{ext}{frame}<xdr:clientData/></xdr:absoluteAnchor>",
        number_to_string(point(placement.left)),
        number_to_string(point(placement.top)),
    ))
}

/// A reader who cannot see the picture hears this description; Excel reads it from the drawing's descr.
fn picture_description(alt_text: Option<&Value>) -> String {
    let text = alt_text_of(alt_text);
    if text.is_empty() { String::new() } else { format!(" descr=\"{}\"", xml_encode(&text)) }
}

/// `String(altText ?? '').trim()`.
fn alt_text_of(alt_text: Option<&Value>) -> String {
    match alt_text {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_trim(&value_to_string(value)).to_owned(),
    }
}

/// `path.extname(String(path || ''))` without its dot, lower-cased (Node's win32 rule: a leading dot names no extension).
fn image_extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or("");
    match name.rfind('.') {
        Some(at) if at > 0 && name != ".." => name[at + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// The image bytes stored as the next xl/media part of their type.
struct StoredMedia {
    part: String,
    data: Vec<u8>,
}

fn store_image_media<P: ReadProof>(proof: &P, zip: &mut Package, op: &Value) -> Result<StoredMedia, String> {
    let path_value = op.get("path").filter(|path| truthy(path));
    let path_text = path_value.map(value_to_string).unwrap_or_default();
    let extension = image_extension(&path_text);
    let Some(content_type) = image_content_type(&extension) else {
        let known: Vec<&str> = IMAGE_CONTENT_TYPES.iter().map(|(name, _)| *name).collect();
        return Err(format!("Unsupported image type: .{}. Use {}", if extension.is_empty() { "unknown" } else { extension.as_str() }, known.join(", ")));
    };
    let path = match path_value {
        Some(Value::String(path)) => path.clone(),
        _ => {
            return Err("The \"path\" argument must be of type string or an instance of Buffer or URL. Received an instance of Array".to_owned());
        }
    };
    let data = mixdog_fsio::read(proof, Path::new(&path)).map_err(|error| os_message(&error, "open", Path::new(&path)))?;
    let mut ordinal = 1_u64;
    while zip.file(&format!("xl/media/image{ordinal}.{extension}")).is_some() {
        ordinal += 1;
    }
    let part = format!("xl/media/image{ordinal}.{extension}");
    zip.set(&part, data.clone());
    ensure_default_content_type(zip, &extension, content_type);
    Ok(StoredMedia { part, data })
}

/// The requested size, or the picture's own size in points.
fn image_placement_size(op: &Value, data: &[u8]) -> (f64, f64) {
    let pixels = image_pixel_size(data);
    let natural_width = pixels.map_or(240.0, |size| f64::from(size.width) * PIXELS_TO_POINTS);
    let natural_height = pixels.map_or(180.0, |size| f64::from(size.height) * PIXELS_TO_POINTS);
    let stated = |key: &str, natural: f64| {
        let value = to_number_of(op.get(key));
        if value > 0.0 { value } else { natural }
    };
    (stated("width", natural_width), stated("height", natural_height))
}

/// The picture names its relationship namespace where it uses it, as the chart frame does: Excel's own drawing declares
/// only xdr and a at its root, and a picture added to it with an undeclared r: left a file Excel would not open.
fn image_anchor_xml(embed_id: &str, anchor_count: usize, op: &Value, size: (f64, f64)) -> Result<String, String> {
    let placement = FramePlacement { cell: op.get("cell"), left: op.get("left"), top: op.get("top"), width: size.0, height: size.1 };
    frame_anchor_xml(
        &placement,
        &format!(
            "<xdr:pic><xdr:nvPicPr><xdr:cNvPr id=\"{}\" name=\"Picture {}\"{}/><xdr:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\" r:embed=\"{embed_id}\"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>",
            anchor_count + 2,
            anchor_count + 1,
            picture_description(op.get("altText")),
        ),
    )
}

/// `countDrawingAnchors(drawingXml)`: the anchors already on a sheet's drawing: a picture or a chart frame is numbered after
/// them.
pub fn count_drawing_anchors(drawing_xml: &str) -> usize {
    ANCHOR_COUNT.find_iter(drawing_xml).count()
}

/// The operation's `op` member as the report repeats it (nothing when the operation did not name one).
fn op_name(op: &Value) -> Option<Value> {
    op.get("op").cloned()
}

fn report(op: &Value, rest: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    if let Some(name) = op_name(op) {
        map.insert("op".to_owned(), name);
    }
    for (key, value) in rest {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

/// `addWorksheetImage(zip, sheet, xml, op)`: places a picture on the sheet's drawing, sized from the file when no size is
/// given.
pub fn add_worksheet_image<P: ReadProof>(proof: &P, zip: &mut Package, sheet: &Sheet, xml: &str, op: &Value) -> Result<Value, String> {
    let media = store_image_media(proof, zip, op)?;
    let drawing = ensure_worksheet_drawing(zip, sheet, xml);
    let fitted = fit_drawing_sheet_one_page_wide(&drawing.worksheet);
    let embed_id = add_package_relationship(
        zip,
        &part_relationship_path(&drawing.part),
        &format!("{OFFICE_RELATIONSHIP_BASE}/image"),
        &posix::relative(&posix::dirname(&drawing.part), &media.part),
        "",
    );
    let drawing_xml = zip.text(&drawing.part);
    let anchor_count = count_drawing_anchors(&drawing_xml);
    let anchor = image_anchor_xml(&embed_id, anchor_count, op, image_placement_size(op, &media.data))?;
    zip.set(&drawing.part, drawing_xml.replacen("</xdr:wsDr>", &format!("{anchor}</xdr:wsDr>"), 1));
    zip.set(&sheet.path, fitted.xml);
    let mut rest = vec![("changed", Value::Bool(true)), ("sheet", Value::from(sheet.name.as_str())), ("image", Value::from(media.part))];
    if op.get("cell").is_some_and(truthy) {
        rest.push(("cell", Value::String(value_to_string(&op["cell"]).to_uppercase())));
    }
    let alt_text = alt_text_of(op.get("altText"));
    if !alt_text.is_empty() {
        rest.push(("altText", Value::String(alt_text)));
    }
    Ok(report(op, rest))
}

// A chart or picture could be placed and never moved again. The audit reports the ones that overlap each other or sit
// outside the print area and asks for them to be moved, and the only answer was to build the workbook again.

fn worksheet_drawing_part(zip: &Package, sheet: &Sheet) -> Result<String, String> {
    let target = relationship_target_by_type(&zip.text(&part_relationship_path(&sheet.path)), "drawing");
    if target.is_empty() {
        return Err(format!("Worksheet holds no chart or picture: {}", sheet.name));
    }
    Ok(posix::normalize(&posix::join(&[posix::dirname(&sheet.path).as_str(), target.as_str()])))
}

/// One anchor of a drawing part: where it lies in the text and what names it.
#[derive(Debug, Clone)]
struct DrawingAnchor {
    index: usize,
    kind: String,
    body: String,
    start: usize,
    end: usize,
    name: String,
    chart_id: String,
    embed_id: String,
}

fn drawing_anchors(xml: &str) -> Vec<DrawingAnchor> {
    DRAWING_ANCHOR
        .captures_iter(xml)
        .enumerate()
        .map(|(position, found)| {
            let range = found.range();
            let body = xml[range.clone()].to_owned();
            let group = |pattern: &JsRegex| pattern.captures(&body).and_then(|caught| caught.get(1).map(str::to_owned)).unwrap_or_default();
            DrawingAnchor {
                index: position + 1,
                kind: found.get(1).unwrap_or("").to_owned(),
                name: xml_decode(&group(&ANCHOR_NAME)),
                chart_id: group(&ANCHOR_CHART),
                embed_id: group(&ANCHOR_EMBED),
                start: range.start,
                end: range.end,
                body,
            }
        })
        .collect()
}

fn select_drawing<'a>(anchors: &'a [DrawingAnchor], op: &Value) -> Result<&'a DrawingAnchor, String> {
    let wanted = op.get("drawing").filter(|value| !value.is_null()).or_else(|| op.get("name"));
    let named = wanted.filter(|value| !value.is_null()).filter(|value| !js_trim(&value_to_string(value)).is_empty());
    let Some(wanted) = named else {
        return Err(format!(
            "XLSX {} requires drawing: the name the snapshot reports, or its 1-based index on the sheet",
            op.get("op").map_or_else(|| "undefined".to_owned(), value_to_string)
        ));
    };
    let ordinal = to_number_of(Some(wanted));
    let found = if ordinal.is_finite() && ordinal.fract() == 0.0 {
        anchors.iter().find(|anchor| anchor.index as f64 == ordinal)
    } else {
        let lowered = js_to_lowercase(js_trim(&value_to_string(wanted)));
        anchors.iter().find(|anchor| js_to_lowercase(&anchor.name) == lowered)
    };
    if let Some(found) = found {
        return Ok(found);
    }
    let known: Vec<String> = anchors
        .iter()
        .map(|anchor| format!("{}: {}", anchor.index, if anchor.name.is_empty() { anchor.kind.as_str() } else { anchor.name.as_str() }))
        .collect();
    Err(format!(
        "Drawing not found: {}. This sheet holds {}.",
        value_to_string(wanted),
        if anchors.is_empty() { "no drawings".to_owned() } else { known.join(", ") }
    ))
}

/// `resolveRelationshipTarget(baseDir, target)`: the package path a relationship target names, empty for an external one.
fn resolve_relationship_target(base_dir: &str, target: &str) -> String {
    if target.is_empty() || EXTERNAL_SCHEME.is_match(target) {
        return String::new();
    }
    match target.strip_prefix('/') {
        Some(rooted) => rooted.to_owned(),
        None => posix::normalize(&posix::join(&[base_dir, target])),
    }
}

/// Whether any relationship still points at this part, so a picture placed twice survives the deletion of its first frame.
fn package_still_references(zip: &Package, part: &str) -> bool {
    for name in zip.names() {
        if !RELS_PART.is_match(&name) {
            continue;
        }
        let xml = zip.text(&name);
        if xml.is_empty() {
            continue;
        }
        let base_dir = posix::dirname(&posix::dirname(&name));
        for found in RELATIONSHIP_ELEMENT.find_iter(&xml) {
            if resolve_relationship_target(&base_dir, &xml_attribute(&xml[found], "Target")) == part {
                return true;
            }
        }
    }
    false
}

/// A chart owns its embedded workbook and its colour and style parts; deleting the frame without them leaves the package
/// carrying parts nothing reaches.
fn remove_part_tree(zip: &mut Package, part: &str) -> Vec<String> {
    let relationships_path = part_relationship_path(part);
    let relationships = zip.text(&relationships_path);
    let mut children = Vec::new();
    if !relationships.is_empty() {
        for found in RELATIONSHIP_ELEMENT.find_iter(&relationships) {
            let child = resolve_relationship_target(&posix::dirname(part), &xml_attribute(&relationships[found], "Target"));
            if !child.is_empty() {
                children.push(child);
            }
        }
        zip.remove(&relationships_path);
    }
    zip.remove(part);
    remove_content_type_override(zip, &format!("/{part}"));
    let mut removed = vec![part.to_owned()];
    for child in children {
        if zip.file(&child).is_none() || package_still_references(zip, &child) {
            continue;
        }
        removed.extend(remove_part_tree(zip, &child));
    }
    removed
}

/// A two-cell anchor's marker as the numbers it holds.
struct CellMarker {
    col: f64,
    col_off: f64,
    row: f64,
    row_off: f64,
}

fn marker_of(body: &str, tag: &str) -> CellMarker {
    let value =
        compiled(&format!(r"<xdr:{tag}>([\s\S]*?)<\/xdr:{tag}>"), "").captures(body).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
    let number = |name: &str| {
        let read = compiled(&format!(r"<xdr:{name}>(-?\d+)<\/xdr:{name}>"), "")
            .captures(&value)
            .and_then(|found| found.get(1).map(string_to_number))
            .unwrap_or(f64::NAN);
        if read.is_nan() { 0.0 } else { read }
    };
    CellMarker { col: number("col"), col_off: number("colOff"), row: number("row"), row_off: number("rowOff") }
}

fn marker_xml(tag: &str, col: f64, col_off: f64, row: f64, row_off: f64) -> String {
    format!(
        "<xdr:{tag}><xdr:col>{}</xdr:col><xdr:colOff>{}</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>{}</xdr:rowOff></xdr:{tag}>",
        number_to_string(col),
        number_to_string(col_off),
        number_to_string(row),
        number_to_string(row_off)
    )
}

/// `Math.round(Number(value) * 12700)`.
fn emu(value: f64) -> f64 {
    math::round(value * EMU_PER_POINT_XLSX)
}

/// `Number(xmlAttribute(attributes, name)) || 0`.
fn number_attribute(attributes: &str, name: &str) -> f64 {
    let value = string_to_number(&xml_attribute(attributes, name));
    if value.is_nan() { 0.0 } else { value }
}

/// A two-cell frame moved or resized: the cells the new rectangle starts and ends in and the offset into each.
fn move_two_cell_anchor<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package, xml: &str, op: &Value, body: &str) -> Result<String, String> {
    let geometry = worksheet_geometry(xml, workbook_digit_width(measurer, zip)?);
    let points = |marker: CellMarker| {
        let mut x = marker.col_off / EMU_PER_POINT_XLSX;
        let mut index = 1.0;
        while index <= marker.col {
            x += geometry.column_points(index);
            index += 1.0;
        }
        let mut y = marker.row_off / EMU_PER_POINT_XLSX;
        index = 1.0;
        while index <= marker.row {
            y += geometry.row_points(index);
            index += 1.0;
        }
        (x, y)
    };
    let at = |x: f64, y: f64| -> Result<(f64, f64, f64, f64), String> {
        let column = math::max(1.0, geometry.column_at(x, false)?);
        let row = math::max(1.0, geometry.row_at(y, false)?);
        let mut spent = 0.0;
        let mut index = 1.0;
        while index < column {
            spent += geometry.column_points(index);
            index += 1.0;
        }
        let mut used = 0.0;
        index = 1.0;
        while index < row {
            used += geometry.row_points(index);
            index += 1.0;
        }
        Ok((column - 1.0, emu(math::max(0.0, x - spent)), row - 1.0, emu(math::max(0.0, y - used))))
    };
    let from = points(marker_of(body, "from"));
    let to = points(marker_of(body, "to"));
    let stated = |key: &str, fallback: f64| if op.get(key).is_some() { to_number_of(op.get(key)) } else { fallback };
    let left = stated("left", from.0);
    let top = stated("top", from.1);
    let width = if op.get("width").is_some() { to_number_of(op.get("width")) } else { math::max(1.0, to.0 - from.0) };
    let height = if op.get("height").is_some() { to_number_of(op.get("height")) } else { math::max(1.0, to.1 - from.1) };
    let start = at(left, top)?;
    let end = at(left + width, top + height)?;
    let moved = replace_first_with(&FROM_MARKER, body, |_| marker_xml("from", start.0, start.1, start.2, start.3));
    Ok(replace_first_with(&TO_MARKER, &moved, |_| marker_xml("to", end.0, end.1, end.2, end.3)))
}

/// `setWorksheetDrawing(zip, sheet, xml, op)`: moves or resizes a chart or picture already on the sheet; positions are
/// points, the same unit add_chart places one with.
pub fn set_worksheet_drawing<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &mut Package, sheet: &Sheet, xml: &str, op: &Value) -> Result<Value, String> {
    let part = worksheet_drawing_part(zip, sheet)?;
    let drawing_xml = zip.text(&part);
    let anchors = drawing_anchors(&drawing_xml);
    let target = select_drawing(&anchors, op)?;
    let label = if target.name.is_empty() { Value::from(target.index) } else { Value::from(target.name.as_str()) };
    let label_text = value_to_string(&label);
    let stated = |key: &str| op.get(key).is_some();
    let number = |key: &str| to_number_of(op.get(key));
    let mut body = target.body.clone();
    if target.kind == "twoCellAnchor" {
        body = move_two_cell_anchor(measurer, zip, xml, op, &body)?;
    }
    if target.kind != "twoCellAnchor" && (stated("left") || stated("top")) {
        if target.kind == "absoluteAnchor" {
            let current = POSITION.captures(&body).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
            let x = if stated("left") { emu(number("left")) } else { number_attribute(&current, "x") };
            let y = if stated("top") { emu(number("top")) } else { number_attribute(&current, "y") };
            body = replace_first_with(&POSITION_ELEMENT, &body, |_| format!("<xdr:pos x=\"{}\" y=\"{}\"/>", number_to_string(x), number_to_string(y)));
        } else {
            if !stated("left") || !stated("top") {
                return Err(format!("Drawing \"{label_text}\" hangs off a cell; set_drawing needs left and top together to move it."));
            }
            // Measuring the offset from A1 makes the point given the point drawn.
            let (left, top) = (emu(number("left")), emu(number("top")));
            body = replace_first_with(&FROM_MARKER, &body, |_| marker_xml("from", 0.0, left, 0.0, top));
        }
    }
    if stated("width") || stated("height") {
        let current = EXTENT.captures(&body).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default();
        let cx = if stated("width") { emu(number("width")) } else { number_attribute(&current, "cx") };
        let cy = if stated("height") { emu(number("height")) } else { number_attribute(&current, "cy") };
        body = replace_first_with(&EXTENT_ELEMENT, &body, |_| format!("<xdr:ext cx=\"{}\" cy=\"{}\"/>", number_to_string(cx), number_to_string(cy)));
    }
    if body == target.body {
        return Err(format!("XLSX {} needs left, top, width, or height", op.get("op").map_or_else(|| "undefined".to_owned(), value_to_string)));
    }
    zip.set(&part, format!("{}{}{}", &drawing_xml[..target.start], body, &drawing_xml[target.end..]));
    Ok(report(
        op,
        vec![("changed", Value::Bool(true)), ("sheet", Value::from(sheet.name.as_str())), ("drawing", label), ("kind", Value::from(target.kind.as_str()))],
    ))
}

/// `deleteWorksheetDrawing(zip, sheet, xml, op)`: takes a chart or picture off the sheet with the parts only it owned.
pub fn delete_worksheet_drawing(zip: &mut Package, sheet: &Sheet, op: &Value) -> Result<Value, String> {
    let part = worksheet_drawing_part(zip, sheet)?;
    let drawing_xml = zip.text(&part);
    let anchors = drawing_anchors(&drawing_xml);
    let target = select_drawing(&anchors, op)?;
    let relationships_path = part_relationship_path(&part);
    let relationship_id = if target.chart_id.is_empty() { target.embed_id.clone() } else { target.chart_id.clone() };
    let mut removed_parts: Vec<String> = Vec::new();
    if !relationship_id.is_empty() {
        let relationships = zip.text(&relationships_path);
        let entry = compiled(&format!(r#"<Relationship\b[^>]*\bId="{}"[^>]*\/>"#, tag_pattern(&relationship_id)), "")
            .find(&relationships)
            .map(|found| relationships[found].to_owned())
            .unwrap_or_default();
        let linked = if entry.is_empty() { String::new() } else { resolve_relationship_target(&posix::dirname(&part), &xml_attribute(&entry, "Target")) };
        remove_package_relationship(zip, &relationships_path, &relationship_id);
        if !linked.is_empty() && zip.file(&linked).is_some() && !package_still_references(zip, &linked) {
            removed_parts.extend(remove_part_tree(zip, &linked));
        }
    }
    zip.set(&part, format!("{}{}", &drawing_xml[..target.start], &drawing_xml[target.end..]));
    let label = if target.name.is_empty() { Value::from(target.index) } else { Value::from(target.name.as_str()) };
    let mut rest = vec![("changed", Value::Bool(true)), ("sheet", Value::from(sheet.name.as_str())), ("drawing", label)];
    if !removed_parts.is_empty() {
        rest.push(("removedParts", Value::Array(removed_parts.into_iter().map(Value::from).collect())));
    }
    Ok(report(op, rest))
}
