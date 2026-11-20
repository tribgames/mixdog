//! Pictures and charts on a sheet: `Excel-Drawing`, `add_image`, `set_drawing`, `delete_drawing`.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::excel::cells::items_of;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;

use super::com_text;
use super::flag;
use super::is_blank;
use super::present;
use super::print::set_one_page_wide;
use super::prop;
use super::range_of;
use super::record_of;
use super::sheets::excel_sheet;
use super::single_cast;
use super::string_of_com;
use super::text_of;

/// `Excel-Drawing`: a chart or picture already on the sheet, addressed by the name the snapshot reports or by its 1-based position,
/// so one address works on both backends.
fn excel_drawing(sheet: &Com, op: &Value) -> Result<Com> {
    let wanted = if present(op, "drawing") { prop(op, "drawing") } else { prop(op, "name") };
    let wanted_text = convert::to_ps_string(&wanted);
    if wanted.is_null() || is_blank(&wanted_text) {
        return Err(Error::host(format!("{} requires drawing: the name the snapshot reports, or its 1-based index on the sheet.", text_of(op, "op"))));
    }
    let shapes = items_of(&sheet.member("Shapes")?)?;
    if let Some(ordinal) = convert::try_parse_int(&wanted_text) {
        if ordinal >= 1 && usize::try_from(ordinal).is_ok_and(|ordinal| ordinal <= shapes.len()) {
            return Ok(shapes[(ordinal - 1) as usize].clone());
        }
    }
    for shape in &shapes {
        if payload::names_equal(&string_of_com(&shape.member("Name")?), &wanted_text) {
            return Ok(shape.clone());
        }
    }
    let mut known = Vec::new();
    for (index, shape) in shapes.iter().enumerate() {
        known.push(format!("{}: {}", index + 1, string_of_com(&shape.member("Name")?)));
    }
    let held = if known.is_empty() { "no drawings".to_owned() } else { known.join(", ") };
    Err(Error::host(format!("Drawing not found: {wanted_text}. This sheet holds {held}.")))
}

/// `add_image`: a snapshot reports where a picture sits as cells, so a caller may place it by cell; explicit points still win.
pub(super) fn add_image(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let anchor = if flag(op, "cell") { Some(range_of(&sheet, &text_of(op, "cell"))?) } else { None };
    let placed = |name: &str, member: &str| -> Result<f32> {
        if flag(op, name) {
            single_cast(&prop(op, name))
        } else if let Some(anchor) = &anchor {
            single_cast(&crate::excel::cells::ps_of(&anchor.member(member)?))
        } else {
            Ok(0.0)
        }
    };
    let left = placed("left", "Left")?;
    let top = placed("top", "Top")?;
    let width = if flag(op, "width") { single_cast(&prop(op, "width"))? } else { 320.0 };
    let height = if flag(op, "height") { single_cast(&prop(op, "height"))? } else { 240.0 };
    let picture = sheet.member("Shapes")?.call_member(
        "AddPicture",
        &[com_text(text_of(op, "path")), Com::Bool(false), Com::Bool(true), Com::R4(left), Com::R4(top), Com::R4(width), Com::R4(height)],
    )?;
    if flag(op, "altText") {
        picture.set_member("AlternativeText", com_text(text_of(op, "altText")))?;
    }
    let page_fit = set_one_page_wide(&sheet);
    let mut more = Vec::new();
    if let Some(fit) = page_fit {
        more.push(("pageFit", Value::string(fit)));
    }
    Ok(record_of("add_image", true, more))
}

/// `set_drawing`: moves or resizes a drawing.
pub(super) fn set_drawing(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let shape = excel_drawing(&sheet, op)?;
    let edges = ["left", "top", "width", "height"];
    if edges.iter().all(|edge| !present(op, edge)) {
        return Err(Error::host("set_drawing needs left, top, width, or height"));
    }
    for (edge, member) in [("left", "Left"), ("top", "Top"), ("width", "Width"), ("height", "Height")] {
        if present(op, edge) {
            shape.set_member(member, Com::R4(single_cast(&prop(op, edge))?))?;
        }
    }
    Ok(record_of(
        "set_drawing",
        true,
        vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?))), ("drawing", Value::String(string_of_com(&shape.member("Name")?)))],
    ))
}

/// `delete_drawing`.
pub(super) fn delete_drawing(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let shape = excel_drawing(&sheet, op)?;
    let name = string_of_com(&shape.member("Name")?);
    shape.call_member("Delete", &[])?;
    Ok(record_of("delete_drawing", true, vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?))), ("drawing", Value::String(name))]))
}
