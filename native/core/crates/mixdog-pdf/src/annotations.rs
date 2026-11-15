//! `page.getAnnotations()` of pdf.js 6.4 (the display intent): the annotations of a page that are viewable, each
//! with the data every annotation shares (subtype, rectangle, flags, contents, title, appearance) and, for a link,
//! the action it carries (a URI, a destination, a named action...). The subtype-specific data of widgets, lines,
//! free text and the other markup types is not read here.

use std::collections::HashSet;
use std::sync::Arc;

use crate::document::Document;
use crate::error::Result;
use crate::fonts::data::string_to_pdf_string;
use crate::object::{Dict, Obj};
use crate::outline_read::{self, ActionData};
use crate::page::Page;

/// `AnnotationFlag.INVISIBLE` and `NOVIEW`: the flags that make an annotation not viewable.
const FLAG_INVISIBLE: i64 = 1;
const FLAG_NOVIEW: i64 = 32;

/// The data of one annotation (`annotation.data`).
#[derive(Debug, Clone)]
pub struct Annotation {
    /// The reference as text (`12R`), or `annot_p<page>_<n>` for an annotation held inline.
    pub id: String,
    pub subtype: Option<String>,
    /// The normalised rectangle; `None` for a popup without an area.
    pub rect: Option<[f64; 4]>,
    pub annotation_flags: i64,
    /// `contentsObj.str`.
    pub contents: String,
    pub modification_date: Option<String>,
    pub has_appearance: bool,
    /// The normal appearance stream (`appearance`): directly, or the one `/AS` selects.
    pub appearance: Option<Obj>,
    /// The quad points of a link or a text-markup annotation, as `Float32Array` values.
    pub quad_points: Option<Vec<f32>>,
    /// The link's action: `url`, `unsafe_url`, `dest`, `action`...
    pub action: ActionData,
}

/// The subtypes pdf.js has a class for (the others are plain annotations).
fn has_class(subtype: &str) -> bool {
    matches!(
        subtype,
        "Link"
            | "Text"
            | "Widget"
            | "Popup"
            | "FreeText"
            | "Line"
            | "Square"
            | "Circle"
            | "PolyLine"
            | "Polygon"
            | "Caret"
            | "Ink"
            | "Highlight"
            | "Underline"
            | "Squiggly"
            | "StrikeOut"
            | "Stamp"
            | "FileAttachment"
            | "RichMedia"
            | "Screen"
            | "Sound"
    )
}

/// `lookupNormalRect(arr, fallback)`.
fn normal_rect(obj: &Obj) -> Option<[f64; 4]> {
    let Obj::Array(items) = obj else {
        return None;
    };
    if items.len() != 4 {
        return None;
    }
    let numbers: Option<Vec<f64>> = items.iter().map(Obj::as_num).collect();
    let n = numbers?;
    let mut r = [n[0], n[1], n[2], n[3]];
    if r[0] > r[2] {
        r.swap(0, 2);
    }
    if r[1] > r[3] {
        r.swap(1, 3);
    }
    Some(r)
}

/// `getQuadPoints(dict, rect)`: `None` when the points are missing or invalid, or (with a `rect`) do not fit in it.
fn quad_points(
    dict: &Dict,
    rect: Option<&[f64; 4]>,
    document: &Document,
) -> Result<Option<Vec<f32>>> {
    let Obj::Array(items) = document.xref().get_array(dict, "QuadPoints")? else {
        return Ok(None);
    };
    let numbers: Option<Vec<f64>> = items.iter().map(Obj::as_num).collect();
    let Some(points) = numbers else {
        return Ok(None);
    };
    if points.is_empty() || points.len() % 8 > 0 {
        return Ok(None);
    }
    let mut out = vec![0.0f32; points.len()];
    for (i, quad) in points.chunks(8).enumerate() {
        let xs = [quad[0], quad[2], quad[4], quad[6]];
        let ys = [quad[1], quad[3], quad[5], quad[7]];
        let min_x = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let max_x = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let min_y = ys.iter().copied().fold(f64::INFINITY, f64::min);
        let max_y = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        if let Some(rect) = rect
            && (min_x < rect[0] || max_x > rect[2] || min_y < rect[1] || max_y > rect[3])
        {
            return Ok(None);
        }
        let set = [min_x, max_y, max_x, max_y, min_x, min_y, max_x, min_y];
        for (k, v) in set.iter().enumerate() {
            out[i * 8 + k] = *v as f32;
        }
    }
    Ok(Some(out))
}

/// The page's `Annots` (the nearest ancestor's when the page has none), the array as the file holds it.
fn page_annotations(document: &Document, page: &Page) -> Result<Vec<Obj>> {
    let xref = document.xref();
    let mut visited: HashSet<String> = HashSet::new();
    let mut current: Option<Arc<Dict>> = Some(page.dict.clone());
    while let Some(node) = current {
        if let Some(id) = &node.obj_id
            && !visited.insert(id.clone())
        {
            break;
        }
        if node.has("Annots") {
            return Ok(match xref.get(&node, "Annots")? {
                Obj::Array(items) => items.to_vec(),
                _ => Vec::new(),
            });
        }
        current = match xref.get(&node, "Parent")? {
            Obj::Dict(parent) => Some(parent),
            _ => None,
        };
    }
    Ok(Vec::new())
}

/// How `Annotations` sort: ordinary ones first, then widgets, then popups.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Plain,
    Widget,
    Popup,
}

fn parse_annotation(
    document: &Document,
    entry: &Obj,
    base_url: Option<&str>,
    page_index: usize,
    inline_count: &mut usize,
) -> Result<Option<(Annotation, bool, Kind)>> {
    let xref = document.xref();
    let dict = match xref.fetch_if_ref(entry, false)? {
        Obj::Dict(d) => d,
        _ => return Ok(None),
    };
    let subtype = match xref.get(&dict, "Subtype")? {
        Obj::Name(n) => Some(n.to_string()),
        _ => None,
    };
    let id = match entry {
        Obj::Ref(r) => r.to_string(),
        _ => {
            *inline_count += 1;
            format!("annot_p{page_index}_{inline_count}")
        }
    };
    let text = |key: &str| -> Result<String> {
        Ok(match xref.get(&dict, key)? {
            Obj::Str(bytes) => string_to_pdf_string(&bytes, false),
            _ => String::new(),
        })
    };
    let contents = text("Contents")?;
    let modification_date = match xref.get(&dict, "M")? {
        Obj::Str(bytes) => Some(bytes.iter().map(|&b| char::from(b)).collect()),
        _ => None,
    };
    let mut flags = match xref.get(&dict, "F")?.as_int() {
        Some(f) if f > 0 => f,
        _ => 0,
    };
    let classed = subtype.as_deref().is_some_and(has_class);
    if flags & FLAG_INVISIBLE != 0 && classed {
        flags ^= FLAG_INVISIBLE;
    }
    let rect = normal_rect(&xref.get_array(&dict, "Rect")?).unwrap_or([0.0; 4]);
    let appearance = appearance_of(document, &dict)?;
    let has_appearance = appearance.is_some();
    let mut data = Annotation {
        id,
        subtype: subtype.clone(),
        rect: Some(rect),
        annotation_flags: flags,
        contents,
        modification_date,
        has_appearance,
        appearance,
        quad_points: None,
        action: ActionData::default(),
    };
    // `data.quadPoints !== null`: a text-markup annotation without usable quad points is never viewable.
    let mut quad_points_valid = true;
    match subtype.as_deref() {
        Some("Link") => {
            data.quad_points = quad_points(&dict, Some(&rect), document)?;
            data.action = outline_read::parse_dest_dictionary(xref, &dict, base_url)?;
        }
        Some("Highlight" | "Underline" | "Squiggly" | "StrikeOut") => {
            data.quad_points = quad_points(&dict, None, document)?;
            quad_points_valid = data.quad_points.is_some();
        }
        Some("Text") => {
            // `TextAnnotation`: without an appearance the note is drawn as the 22 px icon, so the rectangle becomes
            // 22 x 22 from its top-left corner (larger or smaller); with an appearance it is kept.
            const DEFAULT_ICON_SIZE: f64 = 22.0;
            if !has_appearance {
                let mut icon = rect;
                icon[1] = icon[3] - DEFAULT_ICON_SIZE;
                icon[2] = icon[0] + DEFAULT_ICON_SIZE;
                data.rect = Some(icon);
            }
        }
        Some("Popup") => {
            if rect[2] - rect[0] == 0.0 || rect[3] - rect[1] == 0.0 {
                data.rect = None;
            }
            popup_from_parent(document, &dict, &mut data)?;
        }
        _ => {}
    }
    let kind = match subtype.as_deref() {
        Some("Widget") => Kind::Widget,
        Some("Popup") => Kind::Popup,
        _ => Kind::Plain,
    };
    Ok(Some((data, quad_points_valid, kind)))
}

/// The part of `PopupAnnotation` that reads its parent: the popup shows the parent's contents and modification date,
/// and the parent's flags when its own make it invisible. A popup without a parent keeps what it has.
fn popup_from_parent(document: &Document, dict: &Dict, data: &mut Annotation) -> Result<()> {
    let xref = document.xref();
    let Obj::Dict(mut parent) = xref.get(dict, "Parent")? else {
        tracing::warn!("Popup annotation has a missing or invalid parent annotation.");
        return Ok(());
    };
    if matches!(xref.get(&parent, "RT")?, Obj::Name(ref rt) if &**rt == "Group") {
        match xref.get(&parent, "IRT")? {
            Obj::Dict(reply) => parent = reply,
            _ => return Ok(()),
        }
    }
    data.modification_date = match xref.get(&parent, "M")? {
        Obj::Str(bytes) => Some(bytes.iter().map(|&b| char::from(b)).collect()),
        _ => None,
    };
    if !viewable(data.annotation_flags)
        && let Some(parent_flags) = xref.get(&parent, "F")?.as_int()
        && viewable(parent_flags)
    {
        data.annotation_flags = if parent_flags > 0 { parent_flags } else { 0 };
    }
    data.contents = match xref.get(&parent, "Contents")? {
        Obj::Str(bytes) => string_to_pdf_string(&bytes, false),
        _ => String::new(),
    };
    Ok(())
}

/// `setAppearance`: the normal appearance stream (directly, or the one `/AS` selects).
fn appearance_of(document: &Document, dict: &Dict) -> Result<Option<Obj>> {
    let xref = document.xref();
    let Obj::Dict(states) = xref.get(dict, "AP")? else {
        return Ok(None);
    };
    match xref.get(&states, "N")? {
        stream @ Obj::Stream(_) => Ok(Some(stream)),
        Obj::Dict(normal) => match xref.get(dict, "AS")? {
            Obj::Name(state) => Ok(match xref.get(&normal, &state)? {
                stream @ Obj::Stream(_) => Some(stream),
                _ => None,
            }),
            _ => Ok(None),
        },
        _ => Ok(None),
    }
}

/// `Annotation.viewable`: not invisible and not set to be hidden from view.
fn viewable(flags: i64) -> bool {
    flags == 0 || (flags & FLAG_INVISIBLE == 0 && flags & FLAG_NOVIEW == 0)
}

/// `page.getAnnotations()` (the display intent): the viewable annotations in page order. An annotation that cannot
/// be read is skipped (pdf.js warns `_parsedAnnotations`); a cancellation or a budget failure propagates.
pub fn get_annotations(document: &Document, page: &Page) -> Result<Vec<Annotation>> {
    let entries = page_annotations(document, page)?;
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let base_url = outline_read::base_url(document)?;
    let mut inline_count = 0;
    let mut plain = Vec::new();
    let mut widgets = Vec::new();
    let mut popups = Vec::new();
    for entry in &entries {
        document.guard().tick()?;
        match parse_annotation(
            document,
            entry,
            base_url.as_deref(),
            page.index,
            &mut inline_count,
        ) {
            Ok(Some((annotation, quad_points_valid, kind))) => {
                if quad_points_valid && viewable(annotation.annotation_flags) {
                    match kind {
                        Kind::Plain => plain.push(annotation),
                        Kind::Widget => widgets.push(annotation),
                        Kind::Popup => popups.push(annotation),
                    }
                }
            }
            Ok(None) => {}
            Err(e) if e.is_fatal() => return Err(e),
            Err(e) => tracing::warn!("_parsedAnnotations: \"{e}\"."),
        }
    }
    plain.extend(widgets);
    plain.extend(popups);
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_decide_what_is_viewable() {
        assert!(viewable(0));
        assert!(viewable(4));
        assert!(!viewable(FLAG_INVISIBLE));
        assert!(!viewable(FLAG_NOVIEW));
    }

    #[test]
    fn rectangles_are_normalised() {
        let rect = Obj::Array(Arc::new(vec![
            Obj::Num(10.0),
            Obj::Num(20.0),
            Obj::Num(5.0),
            Obj::Num(2.0),
        ]));
        assert_eq!(normal_rect(&rect), Some([5.0, 2.0, 10.0, 20.0]));
        assert_eq!(normal_rect(&Obj::Null), None);
    }
}
