//! `pptx-slide-roles.mjs`: slide roles read from the saved shapes of an authored deck (no composer plan). The render
//! review judges density per role: a diagram slide draws its evidence as native shapes (tinted fields, hairlines,
//! braces, arcs) that the rendered foreground sampler barely sees, so it is judged by the field its shapes cover, not by
//! the ink they leave.

use std::collections::BTreeSet;

use mixdog_js::{js_trim, math, number_to_string, to_number_of, utf16_len};
use mixdog_office_design::discipline::is_motif_shape;
use serde_json::{Map, Value, json};

use super::fixed;
use crate::structure::{num0, text};
use crate::{field, field_of, is_true, is_truthy};

/// A slide's canvas in points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// `DEFAULT_SLIDE`: LAYOUT_WIDE in points.
pub const DEFAULT_SLIDE: Size = Size { width: 960.0, height: 540.0 };
const DIAGRAM_MIN_SHAPES: usize = 3;
const DIAGRAM_MIN_FIELD_SHARE: f64 = 0.25;
const PICTURE_MIN_SHARE: f64 = 0.25;

fn shapes_of(slide: &Value) -> Vec<&Value> {
    field(slide, "shapes").and_then(Value::as_array).map_or_else(Vec::new, |list| list.iter().collect())
}

/// `Number(shape?.width) > 0 || Number(shape?.height) > 0`: a line has one zero extent; it still spans the field.
fn has_box(shape: &Value) -> bool {
    to_number_of(field(shape, "width")) > 0.0 || to_number_of(field(shape, "height")) > 0.0
}

#[derive(Clone, Copy)]
struct Frame {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

fn frame_of(shape: &Value) -> Frame {
    let left = num0(field(shape, "left"));
    let top = num0(field(shape, "top"));
    Frame { left, top, right: left + num0(field(shape, "width")), bottom: top + num0(field(shape, "height")) }
}

fn spans_overlap(a_start: f64, a_end: f64, b_start: f64, b_end: f64) -> bool {
    a_start <= b_end && b_start <= a_end
}

/// `canvasArea(size)`: the area a share is measured against; a deck that saved no size reads as the default canvas.
fn canvas_area(size: Size) -> f64 {
    let width = if size.width == 0.0 || size.width.is_nan() { DEFAULT_SLIDE.width } else { size.width };
    let height = if size.height == 0.0 || size.height.is_nan() { DEFAULT_SLIDE.height } else { size.height };
    math::max(1.0, width * height)
}

/// A text box registered to a diagram shape (sharing its row or its column) is part of the diagram: the label beside a
/// brace, the caption under a node.
fn is_registered_text(shape: &Value, anchors: &[Frame]) -> bool {
    let own = frame_of(shape);
    anchors
        .iter()
        .any(|anchor| spans_overlap(own.top, own.bottom, anchor.top, anchor.bottom) || spans_overlap(own.left, own.right, anchor.left, anchor.right))
}

/// A diagram shape is a connector, a preset geometry that is not a plain text rectangle, or a rectangle with a surface
/// fill (a field, a plane, a lane).
fn is_diagram_shape(shape: &Value) -> bool {
    if !shape.is_object() || is_truthy(field(shape, "placeholder")) || is_motif_shape(shape) {
        return false;
    }
    let kind = field(shape, "type").and_then(Value::as_str);
    if kind == Some("p:cxnSp") {
        return true;
    }
    if kind != Some("p:sp") || !is_truthy(field(shape, "geometry")) {
        return false;
    }
    if field(shape, "geometry").and_then(Value::as_str) == Some("rect") {
        return is_truthy(field_of(field(shape, "fill"), "color"));
    }
    true
}

/// `pptxDiagramCoverage(slide, size)`: `(count, fieldShare)`: the drawn shapes, and the union box of those shapes and the
/// text registered to them (the slide's title, its largest type, excluded) as a share of the canvas.
fn diagram_coverage(slide: &Value, size: Size) -> (usize, f64) {
    let all: Vec<&Value> = shapes_of(slide)
        .into_iter()
        .filter(|shape| has_box(shape) && !is_truthy(field(shape, "placeholder")) && !is_motif_shape(shape))
        .collect();
    let drawn: Vec<bool> = all.iter().map(|shape| is_diagram_shape(shape)).collect();
    if !drawn.contains(&true) {
        return (0, 0.0);
    }
    let anchors: Vec<Frame> = all.iter().zip(&drawn).filter(|(_, is)| **is).map(|(shape, _)| frame_of(shape)).collect();
    let largest_type = all.iter().fold(0.0, |most, shape| math::max(most, num0(field_of(field(shape, "font"), "size"))));
    let mut boxes = anchors.clone();
    for (shape, is_drawn) in all.iter().zip(&drawn) {
        if !*is_drawn
            && !js_trim(&text(field(shape, "text"))).is_empty()
            && num0(field_of(field(shape, "font"), "size")) < largest_type
            && is_registered_text(shape, &anchors)
        {
            boxes.push(frame_of(shape));
        }
    }
    let left = boxes.iter().fold(f64::INFINITY, |least, entry| math::min(least, entry.left));
    let top = boxes.iter().fold(f64::INFINITY, |least, entry| math::min(least, entry.top));
    let right = boxes.iter().fold(f64::NEG_INFINITY, |most, entry| math::max(most, entry.right));
    let bottom = boxes.iter().fold(f64::NEG_INFINITY, |most, entry| math::max(most, entry.bottom));
    let share = (math::max(0.0, right - left) * math::max(0.0, bottom - top)) / canvas_area(size);
    (anchors.len(), fixed(share, 4))
}

/// `pptxPictureShare(slide, size)`: the share of the canvas under pictures (each frame's own area; overlaps count twice,
/// which only helps a stack).
fn picture_share(slide: &Value, size: Size) -> f64 {
    let canvas = canvas_area(size);
    let mut area = 0.0;
    for shape in shapes_of(slide) {
        let (width, height) = (to_number_of(field(shape, "width")), to_number_of(field(shape, "height")));
        if field(shape, "type").and_then(Value::as_str) == Some("p:pic") && width > 0.0 && height > 0.0 {
            area += width * height;
        }
    }
    fixed(math::min(1.0, area / canvas), 4)
}

/// `isPptxPictureSlide(slide, size)`: pictures cover a quarter of the canvas or more.
pub fn is_pptx_picture_slide(slide: &Value, size: Size) -> bool {
    picture_share(slide, size) >= PICTURE_MIN_SHARE
}

/// `isPptxDiagramSlide(slide, size)`: three or more drawn shapes whose field (with the text registered to them) covers a
/// quarter of the slide.
pub fn is_pptx_diagram_slide(slide: &Value, size: Size) -> bool {
    let (count, share) = diagram_coverage(slide, size);
    count >= DIAGRAM_MIN_SHAPES && share >= DIAGRAM_MIN_FIELD_SHARE
}

/// `isPptxStatementSlide(slide)`: a statement slide carries one thesis, quote, or number and air. Composer plans say so
/// through `slideRole`; an authored deck has no plan, so the same criterion is read from the saved shapes and shared with
/// the render review.
pub fn is_pptx_statement_slide(slide: &Value) -> bool {
    let text_shapes: Vec<&Value> = shapes_of(slide)
        .into_iter()
        .filter(|shape| !js_trim(&text(field(shape, "text"))).is_empty() && !is_motif_shape(shape) && !is_truthy(field(shape, "placeholder")))
        .collect();
    if text_shapes.is_empty() || text_shapes.len() > 5 {
        return false;
    }
    let sizes: Vec<f64> = text_shapes.iter().map(|shape| num0(field_of(field(shape, "font"), "size"))).collect();
    let largest = sizes.iter().fold(f64::NEG_INFINITY, |most, size| math::max(most, *size));
    let total_text: usize = text_shapes.iter().map(|shape| utf16_len(&text(field(shape, "text")))).sum();
    largest >= 42.0 || sizes.iter().filter(|size| **size >= 34.0).count() >= 2 || (largest >= 24.0 && total_text <= 280)
}

/// `isPptxSpecimenSlide(textShapes)`: a specimen draws its subject: three or more text blocks sharing one left edge, each
/// a different size/weight step, with the largest at 24 pt or more.
pub fn is_pptx_specimen_slide(text_shapes: &[&Value]) -> bool {
    let mut columns: Vec<(f64, BTreeSet<String>, f64)> = Vec::new();
    for shape in text_shapes {
        let key = math::round(num0(field(shape, "left")) / 12.0);
        let font = field(shape, "font");
        let size = num0(field_of(font, "size"));
        let step = format!(
            "{}|{}|{}",
            number_to_string(size),
            u8::from(is_true(field_of(font, "bold"))),
            text(field_of(font, "name"))
        );
        let at = match columns.iter().position(|column| column.0 == key) {
            Some(at) => at,
            None => {
                columns.push((key, BTreeSet::new(), 0.0));
                columns.len() - 1
            }
        };
        columns[at].1.insert(step);
        columns[at].2 = math::max(columns[at].2, size);
    }
    columns.iter().any(|column| column.1.len() >= 3 && column.2 >= 24.0)
}

/// `inferPptxSlideRoles(document)`: the roles the render review must know before it judges density: a diagram is dense
/// in shapes the sampler barely sees, a picture slide is all frame, a statement beat is sparse on purpose. Drawn evidence
/// wins over the statement reading. The answer is an object keyed by slide index (integer keys ascending, as JavaScript
/// lists them).
pub fn infer_pptx_slide_roles(document: &Value) -> Value {
    let slides: &[Value] = field(document, "slides").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let size = Size { width: num0(field(document, "slideWidth")), height: num0(field(document, "slideHeight")) };
    let mut roles: Vec<(f64, Value)> = Vec::new();
    for slide in slides {
        let index = to_number_of(field(slide, "index"));
        if index.is_nan() || index <= 0.0 {
            continue;
        }
        let role = if is_pptx_diagram_slide(slide, size) {
            json!({ "visualType": "diagram" })
        } else if is_pptx_picture_slide(slide, size) {
            json!({ "visualType": "picture" })
        } else if is_pptx_statement_slide(slide) {
            json!({ "slideRole": "statement" })
        } else {
            continue;
        };
        match roles.iter_mut().find(|entry| entry.0 == index) {
            Some(entry) => entry.1 = role,
            None => roles.push((index, role)),
        }
    }
    // An object lists its array-index keys (integers below 2^32 - 1) first, ascending, then the others as inserted.
    let is_array_index = |key: f64| key.fract() == 0.0 && key < 4_294_967_295.0;
    let mut ordered: Vec<(f64, Value)> = roles.iter().filter(|entry| is_array_index(entry.0)).cloned().collect();
    ordered.sort_by(|left, right| left.0.total_cmp(&right.0));
    ordered.extend(roles.iter().filter(|entry| !is_array_index(entry.0)).cloned());
    let mut out = Map::new();
    for (key, role) in ordered {
        out.insert(number_to_string(key), role);
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_shape(text: &str, size: f64, left: f64, top: f64, width: f64, height: f64) -> Value {
        json!({ "text": text, "font": { "size": size }, "left": left, "top": top, "width": width, "height": height })
    }

    #[test]
    fn one_large_sentence_is_a_statement_and_a_dense_page_is_not() {
        let statement = json!({ "index": 1, "shapes": [text_shape("The wait is gone.", 44.0, 60.0, 200.0, 700.0, 120.0)] });
        assert!(is_pptx_statement_slide(&statement));
        let body = json!({ "index": 2, "shapes": [text_shape(&"word ".repeat(80), 16.0, 60.0, 100.0, 700.0, 300.0)] });
        assert!(!is_pptx_statement_slide(&body));
    }

    #[test]
    fn a_picture_over_a_quarter_of_the_canvas_is_a_picture_slide() {
        let picture = json!({ "shapes": [{ "type": "p:pic", "left": 0, "top": 0, "width": 480, "height": 540 }] });
        assert!(is_pptx_picture_slide(&picture, DEFAULT_SLIDE));
        let strip = json!({ "shapes": [{ "type": "p:pic", "left": 0, "top": 0, "width": 100, "height": 100 }] });
        assert!(!is_pptx_picture_slide(&strip, DEFAULT_SLIDE));
    }

    #[test]
    fn three_drawn_shapes_covering_a_quarter_make_a_diagram_and_roles_list_by_index() {
        let node = |left: f64| json!({ "type": "p:sp", "geometry": "ellipse", "left": left, "top": 150, "width": 160, "height": 220 });
        let diagram = json!({ "index": 2, "shapes": [node(60.0), node(300.0), node(540.0)] });
        assert!(is_pptx_diagram_slide(&diagram, DEFAULT_SLIDE));
        let statement = json!({ "index": 10, "shapes": [text_shape("One claim", 48.0, 60.0, 200.0, 700.0, 120.0)] });
        let empty = json!({ "index": 3, "shapes": [] });
        let roles = infer_pptx_slide_roles(&json!({ "slideWidth": 960, "slideHeight": 540, "slides": [statement, empty, diagram] }));
        assert_eq!(mixdog_js::json_stringify(&roles), r#"{"2":{"visualType":"diagram"},"10":{"slideRole":"statement"}}"#);
    }

    #[test]
    fn a_specimen_sets_three_steps_down_one_column() {
        let steps = [text_shape("Aa", 48.0, 40.0, 40.0, 300.0, 60.0), text_shape("Aa", 24.0, 40.0, 120.0, 300.0, 40.0), text_shape("Aa", 14.0, 40.0, 180.0, 300.0, 30.0)];
        let refs: Vec<&Value> = steps.iter().collect();
        assert!(is_pptx_specimen_slide(&refs));
        assert!(!is_pptx_specimen_slide(&refs[..2]));
    }
}
