//! `extractPdfTextLayout`: per page the size, origin and transform, the text items in top-left display coordinates,
//! the ruled lines and boxes the page paints, and its links.

use mixdog_fsio::ReadProof;
use mixdog_pdf::document::Document;
use mixdog_pdf::error::CancelCheck;
use mixdog_pdf::oplist::gstate::transform;
use mixdog_pdf::oplist::{self, Op};
use mixdog_pdf::page::{Page, Viewport};
use mixdog_pdf::text::{self, TextItem};
use mixdog_pdf::{Obj, PdfError, annotations, outline_read};
use serde_json::Value;

use super::{js_max, js_min, json_number, max_of, min_of, object, round2};
use crate::document::{AnalysisError, PdfSource, open_pdf, selected_pages};
use crate::limits::{DEFAULT_MAX_ITEMS, MAX_SHAPES_PER_PAGE};

const CANCELLED: &str = "PDF layout extraction was cancelled";

/// One run of text: its box in the layout's top-left coordinates, `vertical` and `reversed` for text that stands or
/// reads backwards on a rotated page.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutItem {
    pub text: String,
    pub x: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub vertical: bool,
    pub reversed: bool,
    pub direction: String,
    pub font: String,
}

/// A ruled line: a hairline stroke or a thin filled bar.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RuledLine {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

/// An axis-aligned rectangle the page paints; `checkbox` is a small square.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoxShape {
    pub x: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub filled: bool,
    pub stroked: bool,
    pub checkbox: bool,
}

/// A link annotation with what it opens: a URL or a page.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub x: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub url: Option<String>,
    pub page: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PageLayout {
    pub page: usize,
    pub width: f64,
    pub height: f64,
    /// Reported only when the page box does not start at 0,0: bottom-left coordinates derived from this layout need
    /// the offset added back.
    pub origin: Option<(f64, f64)>,
    /// User space to these display coordinates; a mark inverts it to land on the page.
    pub transform: [f64; 6],
    pub items: Vec<LayoutItem>,
    pub lines: Vec<RuledLine>,
    pub boxes: Vec<BoxShape>,
    /// Why the lines and boxes could not be read, when they could not.
    pub shapes_unavailable: Option<String>,
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PdfLayout {
    pub page_count: i64,
    pub pages: Vec<PageLayout>,
    pub truncated: bool,
}

/// `{ pages, maxItems, shapes, signal }`.
#[derive(Clone)]
pub struct LayoutOptions {
    pub pages: Option<Vec<f64>>,
    pub max_items: usize,
    /// Read the ruled lines, boxes and links as well as the text.
    pub shapes: bool,
    pub cancel: Option<CancelCheck>,
}

impl Default for LayoutOptions {
    fn default() -> Self {
        LayoutOptions {
            pages: None,
            max_items: DEFAULT_MAX_ITEMS,
            shapes: true,
            cancel: None,
        }
    }
}

/// A point through a transform. pdf.js's own applyTransform mutates its argument in place, so points are mapped here.
pub(crate) fn apply_point((x, y): (f64, f64), m: &[f64]) -> (f64, f64) {
    (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5])
}

fn near(left: f64, right: f64, tolerance: f64) -> bool {
    (left - right).abs() <= tolerance
}

enum Shape {
    Line(RuledLine),
    Box(BoxShape),
}

fn line_shape(x1: f64, y1: f64, x2: f64, y2: f64) -> Shape {
    Shape::Line(RuledLine {
        x1: round2(x1),
        y1: round2(y1),
        x2: round2(x2),
        y2: round2(y2),
    })
}

/// One straight subpath in page space: a hairline stroke or a thin filled bar reads as a line, an axis-aligned closed
/// rectangle as a box. Rules and boxes are what a form without fields is made of: the horizontal line under a label is
/// where the answer goes, and a small square is a checkbox.
fn shape_of_subpath(points: &[(f64, f64)], filled: bool, stroked: bool) -> Option<Shape> {
    let x = min_of(points.iter().map(|p| p.0));
    let top = min_of(points.iter().map(|p| p.1));
    let width = max_of(points.iter().map(|p| p.0)) - x;
    let height = max_of(points.iter().map(|p| p.1)) - top;
    if points.len() == 2 {
        if stroked && (near(height, 0.0, 1.0) || near(width, 0.0, 1.0)) {
            return Some(line_shape(
                points[0].0,
                points[0].1,
                points[1].0,
                points[1].1,
            ));
        }
        return None;
    }
    let closed = points.len() == 4
        || (points.len() == 5
            && near(points[0].0, points[4].0, 0.5)
            && near(points[0].1, points[4].1, 0.5));
    if !closed {
        return None;
    }
    let axis_aligned = points[..4].iter().enumerate().all(|(position, point)| {
        let next = points[(position + 1) % 4];
        near(point.0, next.0, 0.5) || near(point.1, next.1, 0.5)
    });
    if !axis_aligned {
        return None;
    }
    if filled && height <= 1.5 && width > 6.0 {
        return Some(line_shape(
            x,
            top + height / 2.0,
            x + width,
            top + height / 2.0,
        ));
    }
    if filled && width <= 1.5 && height > 6.0 {
        return Some(line_shape(
            x + width / 2.0,
            top,
            x + width / 2.0,
            top + height,
        ));
    }
    if width >= 2.0 && height >= 2.0 {
        return Some(Shape::Box(BoxShape {
            x: round2(x),
            top: round2(top),
            width: round2(width),
            height: round2(height),
            filled,
            stroked,
            checkbox: (6.0..=24.0).contains(&width)
                && (6.0..=24.0).contains(&height)
                && (width - height).abs() <= 2.0,
        }));
    }
    None
}

fn page_shapes(
    document: &Document,
    page: &Page,
    viewport: &Viewport,
) -> Result<(Vec<RuledLine>, Vec<BoxShape>), PdfError> {
    let list = oplist::get_operator_list(document, page, None)?;
    let mut lines = Vec::new();
    let mut boxes = Vec::new();
    for (ctm, op) in list.with_transforms() {
        let Op::ConstructPath {
            paint,
            path: Some(path),
        } = op
        else {
            continue;
        };
        let (filled, stroked) = (paint.fills(), paint.strokes());
        if path.data.is_empty() || (!filled && !stroked) {
            continue;
        }
        let full = transform(&viewport.transform, &ctm);
        for subpath in path.subpaths() {
            if subpath.curved {
                continue;
            }
            let points: Vec<(f64, f64)> = subpath
                .points
                .iter()
                .map(|point| apply_point(*point, &full))
                .collect();
            match shape_of_subpath(&points, filled, stroked) {
                Some(Shape::Line(line)) => lines.push(line),
                Some(Shape::Box(shape)) => boxes.push(shape),
                None => {}
            }
        }
        if lines.len() + boxes.len() >= MAX_SHAPES_PER_PAGE {
            break;
        }
    }
    lines.truncate(MAX_SHAPES_PER_PAGE);
    boxes.truncate(MAX_SHAPES_PER_PAGE);
    Ok((lines, boxes))
}

/// The page a destination's first element names: a page reference is looked up, a whole number is a page index.
/// `None` when it names neither or the lookup fails; a cancellation or a budget failure propagates.
pub(crate) fn destination_page(
    document: &Document,
    target: Option<&Obj>,
) -> Result<Option<i64>, PdfError> {
    match target {
        Some(Obj::Ref(reference)) => match outline_read::get_page_index(document, *reference) {
            Ok(index) => Ok(Some(index as i64 + 1)),
            Err(error) if error.is_fatal() => Err(error),
            Err(_) => Ok(None),
        },
        Some(Obj::Num(number)) if number.is_finite() && number.fract() == 0.0 => {
            Ok(Some(*number as i64 + 1))
        }
        _ => Ok(None),
    }
}

/// The explicit destination a `dest` stands for: a name is looked up, an array is the destination. `None` for an empty
/// name, an unknown one, or a lookup that fails; a cancellation or a budget failure propagates.
pub(crate) fn explicit_destination(
    document: &Document,
    dest: &outline_read::Dest,
) -> Result<Option<Vec<Obj>>, PdfError> {
    match dest {
        outline_read::Dest::Named(name) if name.is_empty() => Ok(None),
        outline_read::Dest::Named(name) => match outline_read::get_destination(document, name) {
            Ok(found) => Ok(found),
            Err(error) if error.is_fatal() => Err(error),
            Err(_) => Ok(None),
        },
        outline_read::Dest::Explicit(array) => Ok(Some(array.clone())),
    }
}

/// Link annotations in the same top-left coordinates as the text, so a reader can say where a link sits and what it
/// opens.
fn page_links(
    document: &Document,
    page: &Page,
    viewport: &Viewport,
) -> Result<Vec<Link>, PdfError> {
    let mut links = Vec::new();
    let found = match annotations::get_annotations(document, page) {
        Ok(found) => found,
        Err(error) if error.is_fatal() => return Err(error),
        Err(_) => return Ok(links),
    };
    for annotation in found {
        let Some(rect) = annotation.rect else {
            continue;
        };
        if annotation.subtype.as_deref() != Some("Link") {
            continue;
        }
        let (x1, y1) = apply_point((rect[0], rect[1]), &viewport.transform);
        let (x2, y2) = apply_point((rect[2], rect[3]), &viewport.transform);
        let mut entry = Link {
            x: round2(js_min(x1, x2)),
            top: round2(js_min(y1, y2)),
            width: round2((x2 - x1).abs()),
            height: round2((y2 - y1).abs()),
            url: None,
            page: None,
        };
        // unsafeUrl is the string the file carries; url is pdf.js's normalized copy (a trailing slash appears).
        let action = &annotation.action;
        let url = action
            .unsafe_url
            .as_ref()
            .filter(|url| !url.is_empty())
            .or(action.url.as_ref().filter(|url| !url.is_empty()));
        if let Some(url) = url {
            entry.url = Some(url.clone());
        } else if let Some(dest) = &action.dest
            && let Some(destination) = explicit_destination(document, dest)?
        {
            entry.page = destination_page(document, destination.first())?;
        }
        if entry.url.is_none() && entry.page.is_none_or(|page| page == 0) {
            continue;
        }
        links.push(entry);
        if links.len() >= MAX_SHAPES_PER_PAGE {
            break;
        }
    }
    Ok(links)
}

/// The run's four corners (origin, end of the advance, and both lifted by the glyph height) give one box that is
/// right for upright text, text on a rotated page, and a diagonal watermark.
fn layout_item(viewport: &Viewport, item: &TextItem, text: String) -> LayoutItem {
    let [a, b, c, d, e, f] = transform(&viewport.transform, &item.transform);
    let hypot = a.hypot(b);
    let advance = if hypot == 0.0 || hypot.is_nan() {
        1.0
    } else {
        hypot
    };
    let run = [(a / advance) * item.width, (b / advance) * item.width];
    let xs = [e, e + run[0], e + c, e + run[0] + c];
    let ys = [f, f + run[1], f + d, f + run[1] + d];
    let left = min_of(xs);
    let top = min_of(ys);
    // On a rotated page the run stands (vertical) and may read upward or leftward (reversed); a search places a
    // match along that axis.
    let vertical = b.abs() > a.abs();
    let reversed = if vertical { b < 0.0 } else { a < 0.0 };
    LayoutItem {
        text,
        x: round2(left),
        top: round2(top),
        width: round2(max_of(xs) - left),
        height: round2(js_max(1.0, max_of(ys) - top)),
        vertical,
        reversed,
        direction: item.dir.as_str().to_owned(),
        font: item.font_name.clone().unwrap_or_default(),
    }
}

fn page_layout(
    document: &Document,
    page: &Page,
    number: usize,
    viewport: &Viewport,
    items: Vec<LayoutItem>,
    shapes: bool,
) -> Result<PageLayout, PdfError> {
    let mut layout = PageLayout {
        page: number,
        width: round2(viewport.width),
        height: round2(viewport.height),
        origin: None,
        transform: viewport.transform,
        items,
        lines: Vec::new(),
        boxes: Vec::new(),
        shapes_unavailable: None,
        links: Vec::new(),
    };
    let [origin_x, origin_y, ..] = page.view;
    if (origin_x != 0.0 && !origin_x.is_nan()) || (origin_y != 0.0 && !origin_y.is_nan()) {
        layout.origin = Some((round2(origin_x), round2(origin_y)));
    }
    if !shapes {
        return Ok(layout);
    }
    match page_shapes(document, page, viewport) {
        Ok((lines, boxes)) => {
            layout.lines = lines;
            layout.boxes = boxes;
        }
        Err(error) if error.is_fatal() => return Err(error),
        Err(error) => {
            let message = error.message();
            layout.shapes_unavailable = Some(if message.is_empty() {
                error.to_string()
            } else {
                message.to_owned()
            });
        }
    }
    layout.links = page_links(document, page, viewport)?;
    Ok(layout)
}

/// `extractPdfTextLayout(path, { pages, maxItems, shapes, signal })`.
pub fn extract_pdf_text_layout<P: ReadProof>(
    proof: &P,
    source: PdfSource<'_>,
    options: &LayoutOptions,
) -> Result<PdfLayout, AnalysisError> {
    let reader = |error: PdfError| AnalysisError::from_pdf_or_cancelled(&error, CANCELLED);
    let document = open_pdf(proof, source, options.cancel.clone())?;
    let fonts = text::font_loader(&document);
    let mut pages = Vec::new();
    let mut item_count = 0usize;
    let mut truncated = false;
    for number in selected_pages(document.num_pages(), options.pages.as_deref())? {
        if options.cancel.as_ref().is_some_and(|cancel| cancel()) {
            return Err(AnalysisError::plain(CANCELLED));
        }
        let page = document.page(number - 1).map_err(reader)?;
        let viewport = page.viewport(1.0);
        let content = page.text_content(&document, &fonts).map_err(reader)?;
        let mut items = Vec::new();
        for item in &content.items {
            if item.units.is_empty() {
                continue;
            }
            if item_count + items.len() >= options.max_items {
                truncated = true;
                break;
            }
            items.push(layout_item(&viewport, item, item.text()));
        }
        item_count += items.len();
        pages.push(
            page_layout(&document, &page, number, &viewport, items, options.shapes)
                .map_err(reader)?,
        );
        if truncated {
            break;
        }
    }
    Ok(PdfLayout {
        page_count: document.num_pages(),
        pages,
        truncated,
    })
}

// ---- the JSON Node returns -------------------------------------------------------------------------------------------

impl LayoutItem {
    pub fn to_json(&self) -> Value {
        let mut pairs = vec![
            ("text", Value::from(self.text.clone())),
            ("x", json_number(self.x)),
            ("top", json_number(self.top)),
            ("width", json_number(self.width)),
            ("height", json_number(self.height)),
        ];
        if self.vertical {
            pairs.push(("vertical", Value::Bool(true)));
        }
        if self.reversed {
            pairs.push(("reversed", Value::Bool(true)));
        }
        pairs.push(("direction", Value::from(self.direction.clone())));
        pairs.push(("font", Value::from(self.font.clone())));
        object(pairs)
    }
}

impl RuledLine {
    pub fn to_json(&self) -> Value {
        object(vec![
            ("x1", json_number(self.x1)),
            ("y1", json_number(self.y1)),
            ("x2", json_number(self.x2)),
            ("y2", json_number(self.y2)),
        ])
    }
}

impl BoxShape {
    pub fn to_json(&self) -> Value {
        object(vec![
            ("x", json_number(self.x)),
            ("top", json_number(self.top)),
            ("width", json_number(self.width)),
            ("height", json_number(self.height)),
            ("filled", Value::Bool(self.filled)),
            ("stroked", Value::Bool(self.stroked)),
            ("checkbox", Value::Bool(self.checkbox)),
        ])
    }
}

impl Link {
    pub fn to_json(&self) -> Value {
        let mut pairs = vec![
            ("x", json_number(self.x)),
            ("top", json_number(self.top)),
            ("width", json_number(self.width)),
            ("height", json_number(self.height)),
        ];
        if let Some(url) = &self.url {
            pairs.push(("url", Value::from(url.clone())));
        } else if let Some(page) = self.page {
            pairs.push(("page", Value::from(page)));
        }
        object(pairs)
    }
}

impl PageLayout {
    pub fn to_json(&self) -> Value {
        let mut pairs = vec![
            ("page", Value::from(self.page)),
            ("width", json_number(self.width)),
            ("height", json_number(self.height)),
        ];
        if let Some((x, y)) = self.origin {
            pairs.push((
                "origin",
                object(vec![("x", json_number(x)), ("y", json_number(y))]),
            ));
        }
        pairs.push((
            "transform",
            Value::Array(self.transform.iter().map(|v| json_number(*v)).collect()),
        ));
        pairs.push((
            "items",
            Value::Array(self.items.iter().map(LayoutItem::to_json).collect()),
        ));
        pairs.push((
            "lines",
            Value::Array(self.lines.iter().map(RuledLine::to_json).collect()),
        ));
        pairs.push((
            "boxes",
            Value::Array(self.boxes.iter().map(BoxShape::to_json).collect()),
        ));
        if let Some(reason) = &self.shapes_unavailable {
            pairs.push(("shapesUnavailable", Value::from(reason.clone())));
        }
        pairs.push((
            "links",
            Value::Array(self.links.iter().map(Link::to_json).collect()),
        ));
        object(pairs)
    }
}

impl PdfLayout {
    pub fn to_json(&self) -> Value {
        object(vec![
            ("pageCount", Value::from(self.page_count)),
            (
                "pages",
                Value::Array(self.pages.iter().map(PageLayout::to_json).collect()),
            ),
            ("truncated", Value::Bool(self.truncated)),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<(f64, f64)> {
        vec![(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    }

    fn only_box(shape: Option<Shape>) -> BoxShape {
        match shape {
            Some(Shape::Box(shape)) => shape,
            _ => panic!("a box was expected"),
        }
    }

    fn only_line(shape: Option<Shape>) -> RuledLine {
        match shape {
            Some(Shape::Line(line)) => line,
            _ => panic!("a line was expected"),
        }
    }

    #[test]
    fn a_hairline_stroke_is_a_line_and_a_slanted_one_is_not() {
        let line = only_line(shape_of_subpath(&[(0.0, 10.0), (50.0, 10.4)], false, true));
        assert_eq!((line.x2, line.y2), (50.0, 10.4));
        assert!(shape_of_subpath(&[(0.0, 0.0), (50.0, 30.0)], false, true).is_none());
        assert!(shape_of_subpath(&[(0.0, 10.0), (50.0, 10.0)], true, false).is_none());
    }

    #[test]
    fn a_thin_filled_bar_is_a_line_through_its_middle() {
        let across = only_line(shape_of_subpath(&rect(10.0, 20.0, 100.0, 1.0), true, false));
        assert_eq!(
            (across.x1, across.y1, across.x2, across.y2),
            (10.0, 20.5, 110.0, 20.5)
        );
        let down = only_line(shape_of_subpath(&rect(10.0, 20.0, 1.0, 40.0), true, false));
        assert_eq!(
            (down.x1, down.y1, down.x2, down.y2),
            (10.5, 20.0, 10.5, 60.0)
        );
    }

    #[test]
    fn a_small_square_is_a_checkbox_and_a_wide_rectangle_is_not() {
        assert!(only_box(shape_of_subpath(&rect(0.0, 0.0, 10.0, 10.0), false, true)).checkbox);
        assert!(!only_box(shape_of_subpath(&rect(0.0, 0.0, 40.0, 10.0), false, true)).checkbox);
        assert!(shape_of_subpath(&rect(0.0, 0.0, 1.9, 30.0), false, true).is_none());
    }

    #[test]
    fn a_closed_five_point_rectangle_is_a_box_and_a_diamond_is_nothing() {
        let mut five = rect(5.0, 5.0, 30.0, 20.0);
        five.push((5.0, 5.0));
        assert_eq!(only_box(shape_of_subpath(&five, true, true)).width, 30.0);
        let diamond = vec![(10.0, 0.0), (20.0, 10.0), (10.0, 20.0), (0.0, 10.0)];
        assert!(shape_of_subpath(&diamond, true, true).is_none());
        assert!(shape_of_subpath(&[(0.0, 0.0), (9.0, 0.0), (9.0, 9.0)], true, true).is_none());
    }

    #[test]
    fn the_json_names_only_what_is_set() {
        let item = LayoutItem {
            text: "a".into(),
            x: 1.0,
            top: 2.5,
            width: 3.0,
            height: 4.0,
            vertical: false,
            reversed: true,
            direction: "ltr".into(),
            font: "g_d0_f1".into(),
        };
        assert_eq!(
            item.to_json().to_string(),
            r#"{"text":"a","x":1,"top":2.5,"width":3,"height":4,"reversed":true,"direction":"ltr","font":"g_d0_f1"}"#
        );
        let link = Link {
            x: 1.0,
            top: 1.0,
            width: 1.0,
            height: 1.0,
            url: None,
            page: Some(2),
        };
        assert_eq!(
            link.to_json().to_string(),
            r#"{"x":1,"top":1,"width":1,"height":1,"page":2}"#
        );
    }
}
