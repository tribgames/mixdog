//! `Snapshot-Selection` of `office-com-host.ps1`, the pptx branch: the shapes, the slides or the text the user has selected in
//! the deck's active window, as paths. A failure of any read is the selection being unavailable with the failure as the reason
//! ([`crate::format::snapshot_selection`] does that for every format).

use crate::actions::document::items_of;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::office::item_of;
use crate::ps::ObjectKind;
use crate::ps::Value;

use super::as_value;
use super::count_of;
use super::int_of;
use super::ordered;

fn unavailable(reason: &str) -> Value {
    Value::object(ObjectKind::Ordered, vec![("available", Value::Bool(false)), ("reason", Value::string(reason))])
}

/// The path of each selected shape: its position in the slide's shapes, found by its id.
fn selected_shape_paths(document: &Com, selection: &Com, slide_index: i32) -> Result<Vec<String>> {
    let mut paths = Vec::new();
    let slide = item_of(&document.member("Slides")?, slide_index)?;
    for selected_shape in items_of(&selection.member("ShapeRange")?)? {
        let mut shape_index = 1;
        // `for ($i = 1; $i -le $slide.Shapes.Count; $i++)`: the count is asked again at every step.
        while shape_index <= count_of(&slide.member("Shapes")?)? {
            let candidate = item_of(&slide.member("Shapes")?, i32::try_from(shape_index).unwrap_or(i32::MAX))?;
            if int_of(&candidate.member("Id")?)? == int_of(&selected_shape.member("Id")?)? {
                paths.push(format!("/slide[{slide_index}]/shape[{shape_index}]"));
                break;
            }
            shape_index += 1;
        }
    }
    Ok(paths)
}

/// The pptx branch of `Snapshot-Selection`.
pub fn snapshot_selection(document: &Obj) -> Result<Value> {
    let document = as_value(document);
    let window = document.member("Application")?.member("ActiveWindow")?;
    if window.is_null() {
        return Ok(unavailable("PowerPoint has no active window."));
    }
    let selection = window.member("Selection")?;
    let slide_index =
        window.member("View").and_then(|view| view.member("Slide")).and_then(|slide| slide.member("SlideIndex")).and_then(|index| int_of(&index)).unwrap_or(0);
    let selection_type = int_of(&selection.member("Type")?)?;
    let paths: Vec<String> = if matches!(selection_type, 2 | 3) && slide_index > 0 {
        selected_shape_paths(&document, &selection, slide_index)?
    } else if selection_type == 1 {
        let mut paths = Vec::new();
        for selected_slide in items_of(&selection.member("SlideRange")?)? {
            paths.push(format!("/slide[{}]", int_of(&selected_slide.member("SlideIndex")?)?));
        }
        paths
    } else if slide_index > 0 {
        vec![format!("/slide[{slide_index}]")]
    } else {
        Vec::new()
    };
    let kind = match selection_type {
        1 => "slides",
        2 => "shapes",
        3 => "text",
        _ => "none",
    };
    let target = paths.first().map_or_else(|| "/".to_owned(), Clone::clone);
    let key = format!("{selection_type}:{}", paths.join(","));
    Ok(ordered(vec![
        ("available", Value::Bool(true)),
        ("kind", Value::string(kind)),
        ("target", Value::String(target)),
        ("targets", Value::Array(paths.into_iter().map(Value::String).collect())),
        ("key", Value::String(key)),
        ("slide", Value::Int(slide_index)),
        ("selectionType", Value::Int(selection_type)),
    ]))
}
