//! `portable/pptx-targets.mjs`: an operation that names its slide or shape by id (`slideId`, `shapeId`) rewritten to name
//! them by position (`slide`, `shape`), so every later step addresses the page the way the snapshot numbers it.

use mixdog_js::{json_number, number_to_string, to_number, value_to_string};
use serde_json::Value;

use crate::pptx_package::{SlideRef, slide_at};
use crate::relations::shape_identity;
use crate::slide_shapes::{SLIDE_SHAPE_TAGS, is_set};
use crate::xml::{container_inner, top_level_elements};
use crate::zipio::Package;

/// `resolvePptxTargets({ zip, slides }, operation)`: a copy of the operation with `slideId` and `shapeId` replaced by the
/// position they name. An error when an id is missing or names more than one page or shape, or when the position and the
/// id the operation also gives name different ones.
pub fn resolve_pptx_targets(zip: &Package, slides: &[SlideRef], operation: &Value) -> Result<Value, String> {
    let mut op = operation.clone();
    let Some(fields) = op.as_object_mut() else { return Ok(op) };
    if is_set(fields.get("slideId")) {
        let wanted = value_to_string(&fields["slideId"]);
        let matches: Vec<usize> = slides.iter().enumerate().filter(|(_, slide)| number_to_string(slide.id) == wanted).map(|(index, _)| index).collect();
        if matches.len() != 1 {
            return Err(format!("PPTX slideId {wanted} is missing or ambiguous"));
        }
        let slide = (matches[0] + 1) as f64;
        if is_set(fields.get("slide")) && to_number(&fields["slide"]) != slide {
            return Err("PPTX slide and slideId identify different pages".to_owned());
        }
        fields.insert("slide".to_owned(), json_number(slide));
        fields.shift_remove("slideId");
    }
    if is_set(fields.get("shapeId")) {
        let wanted = value_to_string(&fields["shapeId"]);
        let slide = fields.get("slide").and_then(|number| slide_at(slides, number)).ok_or_else(|| "shapeId requires a valid slide or slideId".to_owned())?;
        let xml = zip.text(&slide.path);
        let tree = container_inner(&xml, "p:spTree", 0);
        let shapes = top_level_elements(tree.as_ref().map_or("", |tree| tree.inner.as_str()), &SLIDE_SHAPE_TAGS);
        let matches: Vec<usize> =
            shapes.iter().enumerate().filter(|(_, shape)| shape_identity(&shape.xml).shape_id == wanted).map(|(index, _)| index).collect();
        if matches.len() != 1 {
            return Err(format!("PPTX shapeId {wanted} is missing or ambiguous"));
        }
        let shape = (matches[0] + 1) as f64;
        if is_set(fields.get("shape")) && to_number(&fields["shape"]) != shape {
            return Err("PPTX shape and shapeId identify different elements".to_owned());
        }
        fields.insert("shape".to_owned(), json_number(shape));
        fields.shift_remove("shapeId");
    }
    Ok(op)
}
