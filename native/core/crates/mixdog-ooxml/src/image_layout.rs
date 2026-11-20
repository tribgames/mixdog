//! `portable/image-layout.mjs`: where a picture sits in its frame. `stretch` fills the frame; `contain` fits the whole
//! picture inside it, centred; `cover` fills the frame and crops what overflows around a focus point. The source's pixel
//! size comes from [`crate::opc::image_pixel_size`] (the PNG, JPEG and GIF header reader).

use mixdog_js::{js_to_lowercase, js_trim, json_number, math, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

use crate::slide_shapes::number_or;

fn positive(value: Option<&Value>, fallback: f64) -> f64 {
    let number = to_number_of(value);
    if number.is_finite() && number > 0.0 { number } else { fallback }
}

fn coordinate(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_finite() { number } else { 0.0 }
}

fn unit(value: f64) -> f64 {
    if value.is_finite() { math::max(0.0, math::min(1.0, value)) } else { 0.5 }
}

fn placed(left: f64, top: f64, width: f64, height: f64, fit: &str, crop: Value) -> Value {
    let mut layout = Map::new();
    layout.insert("left".to_owned(), json_number(left));
    layout.insert("top".to_owned(), json_number(top));
    layout.insert("width".to_owned(), json_number(width));
    layout.insert("height".to_owned(), json_number(height));
    layout.insert("fit".to_owned(), Value::from(fit));
    layout.insert("crop".to_owned(), crop);
    Value::Object(layout)
}

/// `resolveImageLayout({ sourceWidth, sourceHeight, left, top, width, height, fit, focusX, focusY })`: the frame the picture
/// is drawn in and, for `cover`, the fractions of each edge cropped (`{ left, top, width, height, fit, crop }`). An error
/// for a fit that is not one of the three, or for `contain` and `cover` of a picture whose size is not known.
pub fn resolve_image_layout(options: &Value) -> Result<Value, String> {
    let mode = match options.get("fit").filter(|value| truthy(value)) {
        Some(fit) => js_to_lowercase(js_trim(&value_to_string(fit))),
        None => "stretch".to_owned(),
    };
    if !["stretch", "contain", "cover"].contains(&mode.as_str()) {
        return Err("Image fit must be stretch, contain, or cover".to_owned());
    }
    let (left, top) = (coordinate(options.get("left")), coordinate(options.get("top")));
    let (width, height) = (positive(options.get("width"), 100.0), positive(options.get("height"), 100.0));
    if mode == "stretch" {
        return Ok(placed(left, top, width, height, &mode, Value::Null));
    }
    let (source_width, source_height) = (positive(options.get("sourceWidth"), 0.0), positive(options.get("sourceHeight"), 0.0));
    if source_width == 0.0 || source_height == 0.0 {
        return Err(format!("Image fit {mode} requires a PNG, JPEG, or GIF with readable dimensions"));
    }
    if mode == "contain" {
        let scale = math::min(width / source_width, height / source_height);
        let (placed_width, placed_height) = (source_width * scale, source_height * scale);
        return Ok(placed(left + (width - placed_width) / 2.0, top + (height - placed_height) / 2.0, placed_width, placed_height, &mode, Value::Null));
    }
    let source_ratio = source_width / source_height;
    let target_ratio = width / height;
    let (mut crop_left, mut crop_top, mut crop_right, mut crop_bottom) = (0.0, 0.0, 0.0, 0.0);
    if source_ratio > target_ratio {
        let visible = target_ratio / source_ratio;
        let remaining = 1.0 - visible;
        let start = math::max(0.0, math::min(remaining, unit(number_or(options.get("focusX"), 0.5)) - visible / 2.0));
        crop_left = start;
        crop_right = remaining - start;
    } else if source_ratio < target_ratio {
        let visible = source_ratio / target_ratio;
        let remaining = 1.0 - visible;
        let start = math::max(0.0, math::min(remaining, unit(number_or(options.get("focusY"), 0.5)) - visible / 2.0));
        crop_top = start;
        crop_bottom = remaining - start;
    }
    let mut crop = Map::new();
    for (key, value) in [("left", crop_left), ("top", crop_top), ("right", crop_right), ("bottom", crop_bottom)] {
        crop.insert(key.to_owned(), json_number(value));
    }
    Ok(placed(left, top, width, height, &mode, Value::Object(crop)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn contain_centres_the_whole_picture_in_the_frame() {
        let placed =
            resolve_image_layout(&json!({ "sourceWidth": 400, "sourceHeight": 200, "left": 10, "top": 20, "width": 100, "height": 100, "fit": "contain" }))
                .expect("layout");
        assert_eq!(placed, json!({ "left": 10, "top": 45, "width": 100, "height": 50, "fit": "contain", "crop": null }));
    }

    #[test]
    fn cover_crops_what_overflows_around_the_focus() {
        let placed = resolve_image_layout(&json!({ "sourceWidth": 400, "sourceHeight": 200, "width": 100, "height": 100, "fit": "Cover", "focusX": 0.5 }))
            .expect("layout");
        assert_eq!(placed["crop"], json!({ "left": 0.25, "top": 0, "right": 0.25, "bottom": 0 }));
    }

    #[test]
    fn an_unknown_fit_or_an_unknown_size_is_refused() {
        assert_eq!(resolve_image_layout(&json!({ "fit": "tile" })), Err("Image fit must be stretch, contain, or cover".to_owned()));
        assert_eq!(resolve_image_layout(&json!({ "fit": "cover" })), Err("Image fit cover requires a PNG, JPEG, or GIF with readable dimensions".to_owned()));
        assert_eq!(
            resolve_image_layout(&json!({})).expect("stretch"),
            json!({ "left": 0, "top": 0, "width": 100, "height": 100, "fit": "stretch", "crop": null })
        );
    }
}
