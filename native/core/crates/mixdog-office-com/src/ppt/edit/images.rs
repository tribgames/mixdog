//! The picture and media operations of the deck editor: `Add-PptImage` (stretch, contain and cover), `add_image`,
//! `replace_image`, `crop_image` and `add_media`.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::Value;
use crate::ps::text;

use super::boolean;
use super::bstr;
use super::double;
use super::double_value;
use super::i4;
use super::int;
use super::int_value;
use super::present;
use super::prop;
use super::r4;
use super::record;
use super::shape_of;
use super::shapes::clamp_unit;
use super::single;
use super::single_value;
use super::slide_of;
use super::string_value;
use super::text_of;
use super::truthy;
use super::walk;

/// `[single]$op.name` where the request names it, else `$fallback` (`if ($null -ne $op.name)`).
fn single_or(op: &Value, name: &str, fallback: f32) -> Result<f32> {
    let given = prop(op, name);
    if present(&given) { single(&given) } else { Ok(fallback) }
}

/// `[single]$op.name` where the request names it truthfully (`if ($op.name)`), else `$fallback`.
fn single_if_truthy(op: &Value, name: &str, fallback: f32) -> Result<f32> {
    let given = prop(op, name);
    if truthy(&given) { single(&given) } else { Ok(fallback) }
}

/// The `fit` of a request, lower-cased: `stretch` unless one is given.
fn fit_of(op: &Value) -> String {
    let given = prop(op, "fit");
    text::to_lower_invariant(&if truthy(&given) { text_of(&given) } else { "stretch".to_owned() })
}

/// What a cover crop takes off each edge, as fractions of the picture: the picture is cut on the axis that is too long, around
/// the focus point, held inside the picture.
fn cover_crop(source_ratio: f64, target_ratio: f64, focus_x: f64, focus_y: f64) -> (f64, f64, f64, f64) {
    let mut crop = (0.0, 0.0, 0.0, 0.0);
    if source_ratio > target_ratio {
        let visible = target_ratio / source_ratio;
        let remaining = 1.0 - visible;
        let focus = clamp_unit(focus_x);
        let left = 0.0_f64.max(remaining.min(focus - visible / 2.0));
        crop.0 = left;
        crop.2 = remaining - left;
    } else if source_ratio < target_ratio {
        let visible = source_ratio / target_ratio;
        let remaining = 1.0 - visible;
        let focus = clamp_unit(focus_y);
        let top = 0.0_f64.max(remaining.min(focus - visible / 2.0));
        crop.1 = top;
        crop.3 = remaining - top;
    }
    crop
}

/// `Add-PptImage`: the picture placed in the box by `stretch`, `contain` (whole, centred) or `cover` (cropped to fill around
/// `focusX` and `focusY`), by the picture's own size in points. Double arithmetic throughout.
pub(crate) fn add_picture(slide: &Com, op: &Value) -> Result<Com> {
    let left = single_or(op, "left", 72.0)?;
    let top = single_or(op, "top", 72.0)?;
    let width = single_or(op, "width", 320.0)?;
    let height = single_or(op, "height", 240.0)?;
    let fit = fit_of(op);
    let path = bstr(&text_of(&prop(op, "path")));
    if fit == "stretch" {
        return slide.member("Shapes")?.call_member("AddPicture", &[path, boolean(false), boolean(true), r4(left), r4(top), r4(width), r4(height)]);
    }
    if fit != "contain" && fit != "cover" {
        return Err(Error::host("Image fit must be stretch, contain, or cover"));
    }
    let shape = slide.member("Shapes")?.call_member("AddPicture", &[path, boolean(false), boolean(true), i4(0), i4(0), i4(-1), i4(-1)])?;
    let source_width = double_value(&shape.member("Width")?)?;
    let source_height = double_value(&shape.member("Height")?)?;
    if source_width <= 0.0 || source_height <= 0.0 {
        shape.call_member("Delete", &[])?;
        return Err(Error::host(format!("PowerPoint could not read image dimensions: {}", text_of(&prop(op, "path")))));
    }
    let (wide, high) = (f64::from(width), f64::from(height));
    if fit == "contain" {
        let scale = (wide / source_width).min(high / source_height);
        let placed_width = (source_width * scale) as f32;
        let placed_height = (source_height * scale) as f32;
        shape.set_member("LockAspectRatio", i4(0))?;
        shape.set_member("Left", r4((f64::from(left) + (wide - f64::from(placed_width)) / 2.0) as f32))?;
        shape.set_member("Top", r4((f64::from(top) + (high - f64::from(placed_height)) / 2.0) as f32))?;
        shape.set_member("Width", r4(placed_width))?;
        shape.set_member("Height", r4(placed_height))?;
        return Ok(shape);
    }
    let focus_x = if present(&prop(op, "focusX")) { double(&prop(op, "focusX"))? } else { 0.5 };
    let focus_y = if present(&prop(op, "focusY")) { double(&prop(op, "focusY"))? } else { 0.5 };
    let (crop_left, crop_top, crop_right, crop_bottom) = cover_crop(source_width / source_height, wide / high, focus_x, focus_y);
    for (member, crop, extent) in [
        ("CropLeft", crop_left, source_width),
        ("CropTop", crop_top, source_height),
        ("CropRight", crop_right, source_width),
        ("CropBottom", crop_bottom, source_height),
    ] {
        shape.member("PictureFormat")?.set_member(member, r4((extent * crop) as f32))?;
    }
    shape.set_member("LockAspectRatio", i4(0))?;
    shape.set_member("Left", r4(left))?;
    shape.set_member("Top", r4(top))?;
    shape.set_member("Width", r4(width))?;
    shape.set_member("Height", r4(height))?;
    Ok(shape)
}

/// `add_image`.
pub(crate) fn add_image(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = add_picture(&slide, op)?;
    let alt_text = prop(op, "altText");
    if truthy(&alt_text) {
        shape.set_member("AlternativeText", bstr(&text_of(&alt_text)))?;
    }
    Ok(record(vec![
        ("op", Value::string("add_image")),
        ("changed", Value::Bool(true)),
        ("shape", Value::String(string_value(&shape.member("Name")?))),
        ("fit", Value::String(fit_of(op))),
    ]))
}

/// `replace_image`: the picture of the same frame; the old frame's description belongs to the picture that just left it.
pub(crate) fn replace_image(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let old = shape_of(&slide, op)?;
    let left = single_value(&old.member("Left")?)?;
    let top = single_value(&old.member("Top")?)?;
    let width = single_value(&old.member("Width")?)?;
    let height = single_value(&old.member("Height")?)?;
    old.call_member("Delete", &[])?;
    let shape = slide.member("Shapes")?.call_member(
        "AddPicture",
        &[bstr(&text_of(&prop(op, "path"))), boolean(false), boolean(true), r4(left), r4(top), r4(width), r4(height)],
    )?;
    let alt_text = prop(op, "altText");
    if truthy(&alt_text) {
        shape.set_member("AlternativeText", bstr(&text_of(&alt_text)))?;
    }
    Ok(record(vec![
        ("op", Value::string("replace_image")),
        ("changed", Value::Bool(true)),
        ("shape", Value::String(string_value(&shape.member("Name")?))),
    ]))
}

/// `crop_image`: the edges named, in points.
pub(crate) fn crop_image(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let shape = shape_of(&slide, op)?;
    for (name, member) in [("left", "CropLeft"), ("right", "CropRight"), ("top", "CropTop"), ("bottom", "CropBottom")] {
        let edge = prop(op, name);
        if present(&edge) {
            walk(&shape, &["PictureFormat"])?.set_member(member, r4(single(&edge)?))?;
        }
    }
    Ok(record(vec![
        ("op", Value::string("crop_image")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int(&prop(op, "shape"))?)),
    ]))
}

/// `add_media`: a sound or a video, embedded unless it is linked.
pub(crate) fn add_media(presentation: &Com, op: &Value) -> Result<Value> {
    let slide = slide_of(presentation, op)?;
    let left = single_or(op, "left", 40.0)?;
    let top = single_or(op, "top", 40.0)?;
    let width = single_if_truthy(op, "width", 320.0)?;
    let height = single_if_truthy(op, "height", 180.0)?;
    let link = truthy(&prop(op, "link"));
    let embed_given = prop(op, "embed");
    let embed = if present(&embed_given) { truthy(&embed_given) } else { !link };
    let path = text_of(&prop(op, "path"));
    let shape = slide.member("Shapes")?.call_member(
        "AddMediaObject2",
        &[bstr(&path), i4(if link { -1 } else { 0 }), i4(if embed { -1 } else { 0 }), r4(left), r4(top), r4(width), r4(height)],
    )?;
    let alt_text = prop(op, "altText");
    if truthy(&alt_text) {
        shape.set_member("AlternativeText", bstr(&text_of(&alt_text)))?;
    }
    Ok(record(vec![
        ("op", Value::string("add_media")),
        ("changed", Value::Bool(true)),
        ("shape", Value::Int(int_value(&shape.member("ZOrderPosition")?)?)),
        ("media", Value::String(text_of(&prop(op, "path")))),
        ("embedded", Value::Bool(embed)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wide_picture_in_a_square_box_is_cropped_at_the_sides_around_the_focus() {
        // 2:1 source in a 1:1 box: half of it shows.
        let (left, top, right, bottom) = cover_crop(2.0, 1.0, 0.5, 0.5);
        assert_eq!((left, top, right, bottom), (0.25, 0.0, 0.25, 0.0));
        // Focus at the far left: nothing is cut from the left.
        let (left, _, right, _) = cover_crop(2.0, 1.0, 0.0, 0.5);
        assert_eq!((left, right), (0.0, 0.5));
        // A focus past the edge is held inside the picture.
        let (left, _, right, _) = cover_crop(2.0, 1.0, 7.0, 0.5);
        assert_eq!((left, right), (0.5, 0.0));
    }

    #[test]
    fn a_tall_picture_in_a_square_box_is_cropped_at_the_top_and_bottom() {
        let (left, top, right, bottom) = cover_crop(0.5, 1.0, 0.5, 0.5);
        assert_eq!((left, top, right, bottom), (0.0, 0.25, 0.0, 0.25));
    }

    #[test]
    fn a_fraction_of_the_focus_is_kept_and_not_rounded() {
        let (left, _, _, _) = cover_crop(2.0, 1.0, 0.3, 0.5);
        assert!((left - 0.05).abs() < 1e-12);
    }

    #[test]
    fn the_fit_is_stretch_unless_one_is_given_and_is_lower_cased() {
        let none = crate::ps::payload::parse_payload("{}").unwrap();
        assert_eq!(fit_of(&none), "stretch");
        let named = crate::ps::payload::parse_payload("{\"fit\":\"Cover\"}").unwrap();
        assert_eq!(fit_of(&named), "cover");
    }
}
