//! pdf.js's `Page` as far as the read path needs it: the geometry (`mediaBox`, `cropBox`, `view`, `rotate`,
//! `userUnit`), the inherited `Resources`, the page's content bytes, and the display layer's `PageViewport` at a
//! scale. Properties a page inherits from its ancestors (`Resources`, `MediaBox`, `CropBox`, `Rotate`) are looked up
//! along `/Parent` as `getInheritableProperty` does, with a loop guard.

use std::collections::HashSet;
use std::sync::Arc;

use crate::document::Document;
use crate::error::Result;
use crate::object::{Dict, Obj, Ref};
use crate::stream::PdfStream;
use crate::xref::Xref;

/// `LETTER_SIZE_MEDIABOX`: the box of a page that has no usable `MediaBox`.
const LETTER_SIZE_MEDIABOX: [f64; 4] = [0.0, 0.0, 612.0, 792.0];

/// One page of a [`Document`].
#[derive(Debug, Clone)]
pub struct Page {
    /// The 0-based index of the page in the document.
    pub index: usize,
    pub dict: Arc<Dict>,
    /// The reference the page was reached by (`Page.ref`); `None` for a page held inline in its parent's `Kids` or
    /// found by a walk of the whole tree.
    pub reference: Option<Ref>,
    /// `mediaBox`: the `MediaBox` normalised, letter size when it is missing, empty or invalid.
    pub media_box: [f64; 4],
    /// `cropBox`: the `CropBox`, the media box when it is missing, empty or invalid.
    pub crop_box: [f64; 4],
    /// `view`: the crop box intersected with the media box.
    pub view: [f64; 4],
    /// `rotate`: the original value when already in range (including numeric strings/arrays).
    pub rotate: Obj,
    /// `userUnit`: the `UserUnit` when it is a positive number, else 1.
    pub user_unit: f64,
}

/// The display layer's `PageViewport`: where a page's user space lands on the canvas at `scale`.
#[derive(Debug, Clone)]
pub struct Viewport {
    pub view_box: [f64; 4],
    pub user_unit: f64,
    pub scale: f64,
    pub rotation: Obj,
    pub offset_x: f64,
    pub offset_y: f64,
    pub transform: [f64; 6],
    pub width: f64,
    pub height: f64,
}

impl Page {
    /// Reads the geometry of the page whose dictionary is `dict` (the properties pdf.js's `GetPage` handler asks:
    /// `rotate`, `userUnit`, `view`).
    pub(crate) fn new(
        document: &Document,
        index: usize,
        dict: Arc<Dict>,
        reference: Option<Ref>,
    ) -> Result<Page> {
        let xref = document.xref();
        let rotate = rotate_of(inheritable(xref, &dict, "Rotate", false)?.as_ref());
        let user_unit = match xref.get(&dict, "UserUnit")? {
            Obj::Num(n) if n > 0.0 => n,
            _ => 1.0,
        };
        let media_box = bounding_box(xref, &dict, "MediaBox")?.unwrap_or(LETTER_SIZE_MEDIABOX);
        let crop_box = bounding_box(xref, &dict, "CropBox")?.unwrap_or(media_box);
        let view = view_of(crop_box, media_box);
        Ok(Page {
            index,
            dict,
            reference,
            media_box,
            crop_box,
            view,
            rotate,
            user_unit,
        })
    }

    /// `resources`: the `Resources` the page or its nearest ancestor has; when several ancestors have one they are
    /// merged, the nearest winning each key. An empty dictionary when none is usable.
    pub fn resources(&self, document: &Document) -> Result<Arc<Dict>> {
        match inheritable(document.xref(), &self.dict, "Resources", false)? {
            Some(Obj::Dict(resources)) => Ok(resources),
            _ => Ok(Arc::new(Dict::new())),
        }
    }

    /// The bytes of the page's content streams, decoded and joined (`getContentStream`): `/Contents` is one stream or
    /// an array of them. A stream that fails to decode is skipped when the document's `ignore_errors` is set.
    pub fn content(&self, document: &Document) -> Result<Vec<u8>> {
        let xref = document.xref();
        let filters = xref.filters();
        match xref.get_array(&self.dict, "Contents")? {
            Obj::Stream(stream) if !is_image_stream(&stream) => {
                stream.decode(filters.as_ref(), xref.guard())
            }
            Obj::Array(items) => {
                let mut bytes = Vec::new();
                for item in items.iter() {
                    let Obj::Stream(stream) = item else { continue };
                    if is_image_stream(stream) {
                        continue;
                    }
                    match stream.decode(filters.as_ref(), xref.guard()) {
                        Ok(chunk) => bytes.extend_from_slice(&chunk),
                        Err(e) if !e.is_fatal() && document.options().ignore_errors => {
                            tracing::warn!(
                                "getContentStream - ignoring sub-stream ({}): \"{e}\".",
                                stream.dict.obj_id.as_deref().unwrap_or("undefined")
                            );
                        }
                        Err(e) => return Err(e),
                    }
                }
                Ok(bytes)
            }
            _ => Ok(Vec::new()),
        }
    }

    /// `getViewport({ scale })`: the page's own rotation, no offset, the y axis flipped.
    pub fn viewport(&self, scale: f64) -> Viewport {
        Viewport::new(
            self.view,
            self.user_unit,
            scale,
            self.rotate.clone(),
            0.0,
            0.0,
        )
        .expect("Page.rotate is normalized to a multiple of 90")
    }
}

impl Viewport {
    /// `new PageViewport({ viewBox, userUnit, scale, rotation, offsetX, offsetY })`. `rotation` is a multiple of 90.
    pub fn new(
        view_box: [f64; 4],
        user_unit: f64,
        scale: f64,
        rotation: Obj,
        offset_x: f64,
        offset_y: f64,
    ) -> Result<Viewport> {
        let scaled = scale * user_unit;
        let center_x = (view_box[2] + view_box[0]) / 2.0;
        let center_y = (view_box[3] + view_box[1]) / 2.0;
        let mut angle = object_number(&rotation) % 360.0;
        if angle < 0.0 {
            angle += 360.0;
        }
        let (rotate_a, rotate_b, rotate_c, rotate_d) = match angle {
            180.0 => (-1.0, 0.0, 0.0, 1.0),
            90.0 => (0.0, 1.0, 1.0, 0.0),
            270.0 => (0.0, -1.0, -1.0, 0.0),
            0.0 => (1.0, 0.0, 0.0, -1.0),
            _ => {
                return Err(crate::error::PdfError::Unknown(
                    "PageViewport: Invalid rotation, must be a multiple of 90 degrees.".into(),
                ));
            }
        };
        let (offset_canvas_x, offset_canvas_y, width, height) = if rotate_a == 0.0 {
            (
                (center_y - view_box[1]).abs() * scaled + offset_x,
                (center_x - view_box[0]).abs() * scaled + offset_y,
                (view_box[3] - view_box[1]) * scaled,
                (view_box[2] - view_box[0]) * scaled,
            )
        } else {
            (
                (center_x - view_box[0]).abs() * scaled + offset_x,
                (center_y - view_box[1]).abs() * scaled + offset_y,
                (view_box[2] - view_box[0]) * scaled,
                (view_box[3] - view_box[1]) * scaled,
            )
        };
        Ok(Viewport {
            view_box,
            user_unit,
            scale,
            rotation,
            offset_x,
            offset_y,
            transform: [
                rotate_a * scaled,
                rotate_b * scaled,
                rotate_c * scaled,
                rotate_d * scaled,
                offset_canvas_x - rotate_a * scaled * center_x - rotate_c * scaled * center_y,
                offset_canvas_y - rotate_b * scaled * center_x - rotate_d * scaled * center_y,
            ],
            width,
            height,
        })
    }
}

/// `BaseStream.isImageStream`: a stream whose last filter is an image codec.
fn is_image_stream(stream: &PdfStream) -> bool {
    stream.chain().last().is_some_and(|filter| {
        matches!(
            filter.name.as_str(),
            "DCT" | "DCTDecode" | "JPX" | "JPXDecode" | "CCF" | "CCITTFaxDecode" | "JBIG2Decode"
        )
    })
}

/// `getInheritableProperty` with `stopWhenFound: false` followed by the page's choice (`#getInheritableProperty`):
/// the values `key` has along the `/Parent` chain, nearest first; the first one is the result, unless it is a
/// dictionary and there are several, when the dictionaries are merged. With `get_array` the references among an
/// array's elements are fetched.
fn inheritable(xref: &Xref, dict: &Arc<Dict>, key: &str, get_array: bool) -> Result<Option<Obj>> {
    let mut values: Vec<Obj> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut current = Some(dict.clone());
    while let Some(node) = current {
        if let Some(id) = &node.obj_id
            && !visited.insert(id.clone())
        {
            break;
        }
        if node.has(key) {
            values.push(if get_array {
                xref.get_array(&node, key)?
            } else {
                xref.get(&node, key)?
            });
        }
        current = match xref.get(&node, "Parent")? {
            Obj::Dict(parent) => Some(parent),
            _ => None,
        };
    }
    if values.len() > 1 && matches!(values[0], Obj::Dict(_)) {
        let merged = Dict::merge(&values, false).unwrap_or_default();
        return Ok(Some(Obj::Dict(Arc::new(merged))));
    }
    Ok(values.into_iter().next())
}

/// `getBoundingBox`: the inherited box as a normalised rectangle, `None` when it is missing, no array of four
/// numbers or empty.
fn bounding_box(xref: &Xref, dict: &Arc<Dict>, name: &str) -> Result<Option<[f64; 4]>> {
    let Some(Obj::Array(items)) = inheritable(xref, dict, name, true)? else {
        return Ok(None);
    };
    let numbers: Vec<f64> = items.iter().filter_map(Obj::as_num).collect();
    if numbers.len() != items.len() {
        return Ok(None);
    }
    let &[x0, y0, x1, y1] = numbers.as_slice() else {
        return Ok(None);
    };
    let rect = [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)];
    if rect[2] - rect[0] > 0.0 && rect[3] - rect[1] > 0.0 {
        return Ok(Some(rect));
    }
    tracing::warn!("Empty, or invalid, /{name} entry.");
    Ok(None)
}

/// `Page.view`: the crop box intersected with the media box (`Util.intersect`), the media box when they do not
/// overlap in a rectangle with an area.
fn view_of(crop_box: [f64; 4], media_box: [f64; 4]) -> [f64; 4] {
    if crop_box == media_box {
        return media_box;
    }
    let low = |a: [f64; 4], i: usize| a[i].min(a[i + 2]);
    let high = |a: [f64; 4], i: usize| a[i].max(a[i + 2]);
    let x_low = low(crop_box, 0).max(low(media_box, 0));
    let x_high = high(crop_box, 0).min(high(media_box, 0));
    let y_low = low(crop_box, 1).max(low(media_box, 1));
    let y_high = high(crop_box, 1).min(high(media_box, 1));
    if x_low <= x_high && y_low <= y_high {
        let (width, height) = (x_high - x_low, y_high - y_low);
        if width > 0.0 && height > 0.0 {
            return [x_low, y_low, x_high, y_high];
        }
    }
    tracing::warn!("Empty /CropBox and /MediaBox intersection.");
    media_box
}

/// Ordinary PDF objects use JavaScript object coercion; arrays keep unresolved refs,
/// since Rotate is read through Dict.get, not Dict.getArray.
pub(crate) fn object_number(value: &Obj) -> f64 {
    match value {
        Obj::Null => 0.0,
        Obj::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Obj::Num(value) => *value,
        Obj::Str(bytes) => {
            mixdog_js::string_to_number(&bytes.iter().map(|&b| char::from(b)).collect::<String>())
        }
        Obj::Array(_) => mixdog_js::string_to_number(&array_string(value)),
        _ => f64::NAN,
    }
}
fn array_string(value: &Obj) -> String {
    match value {
        Obj::Null => String::new(),
        Obj::Bool(value) => value.to_string(),
        Obj::Num(value) => mixdog_js::number_to_string(*value),
        Obj::Str(bytes) => bytes.iter().map(|&b| char::from(b)).collect(),
        Obj::Array(items) => items.iter().map(array_string).collect::<Vec<_>>().join(","),
        _ => "[object Object]".into(),
    }
}
fn rotate_of(value: Option<&Obj>) -> Obj {
    let Some(value) = value else {
        return Obj::Num(0.0);
    };
    if matches!(value, Obj::Null | Obj::Bool(false))
        || matches!(value, Obj::Num(n) if *n == 0.0 || n.is_nan())
        || matches!(value, Obj::Str(s) if s.is_empty())
    {
        return Obj::Num(0.0);
    }
    let angle = object_number(value);
    if angle % 90.0 != 0.0 {
        Obj::Num(0.0)
    } else if angle >= 360.0 {
        Obj::Num(angle % 360.0)
    } else if angle < 0.0 {
        Obj::Num((angle % 360.0 + 360.0) % 360.0)
    } else {
        value.clone()
    }
}
