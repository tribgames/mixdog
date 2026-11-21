//! `authoring/pptx-receipt.mjs`: the composition receipt, what each saved slide actually carries, read from the
//! snapshot after a script authored the deck and handed back beside the render. It is information, never a gate: the
//! author compares it with the plan line and answers a deck-wide zero or a contradicted promise with a reason or a fix
//! (pptx skill, section 2 step 7). Counts are not quotas.
//!
//! The snapshot (`{ slides: [{ index, background, shapes: [...] }], slideWidth?, slideHeight? }`, portable or Office
//! COM) and every receipt are JSON values with the key order Node writes, so the figures and the wording are Node's.
//! The rendered air of `quality/render-air.mjs` joins through [`attach_rendered_air`]; what a session has already sent is
//! held in a [`DeliveredReceipt`] that [`receipt_for_delivery`] reads and replaces.

use mixdog_js::{is_js_space, js_trim, json_number, json_stringify, math, number_to_string, string_to_number, to_number, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_office_design::discipline::{is_picture_shape, relative_luminance};
use mixdog_office_quality::render_air::{Air, Balance};
use mixdog_ooxml::relations::{RelationBox, rectangle_gap};
use serde_json::{Map, Value, json};

use crate::brief::planned_carrier_gaps;

/// The page the shapes sit on, in points: the deck's 13.33 x 7.5 in unless the document names its slide size (a PDF's
/// designed pages are a sheet).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Page {
    pub width: f64,
    pub height: f64,
}

/// The wide canvas (`WIDE_CANVAS`).
pub const WIDE_CANVAS: Page = Page { width: 960.0, height: 540.0 };

/// `canvasOf(document)`.
pub fn canvas_of(document: &Value) -> Page {
    let (width, height) = (to_number_of(field(document, "slideWidth")), to_number_of(field(document, "slideHeight")));
    if width > 0.0 && height > 0.0 { Page { width, height } } else { WIDE_CANVAS }
}

// JSON reading, as the script reads it

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(key))
}

fn field_of<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|inner| field(inner, key))
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() { 0.0 } else { number }
}

/// `String(value || '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(inner) if truthy(inner) => value_to_string(inner),
        _ => String::new(),
    }
}

/// `Number(x.toFixed(digits))`.
fn fixed(x: f64, digits: usize) -> f64 {
    string_to_number(&math::to_fixed(x, digits))
}

/// `asList`: nothing is an empty list, a list is itself, anything else a list of one.
fn as_list(value: Option<&Value>) -> Vec<&Value> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.iter().collect(),
        Some(other) => vec![other],
    }
}

fn six_hex(text: &str) -> bool {
    text.chars().count() == 6 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// The distinct numbers of a list in first-seen order (`[...new Set(list)]`).
fn distinct(list: impl IntoIterator<Item = f64>) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for number in list {
        if !out.contains(&number) {
            out.push(number);
        }
    }
    out
}

fn distinct_text(list: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for text in list {
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out
}

/// `.sort((a, b) => a - b)` of finite numbers.
fn ascending(mut list: Vec<f64>) -> Vec<f64> {
    list.sort_by(|a, b| a.total_cmp(b));
    list
}

fn numbers(list: &[f64]) -> Value {
    Value::Array(list.iter().map(|number| json_number(*number)).collect())
}

fn strings(list: &[String]) -> Value {
    Value::Array(list.iter().cloned().map(Value::String).collect())
}

fn optional(number: Option<f64>) -> Value {
    number.map_or(Value::Null, json_number)
}

// colour

fn background_role(slide: &Value) -> &'static str {
    let Some(luminance) = relative_luminance(&text_or_empty(field_of(field(slide, "background"), "color"))) else {
        return "";
    };
    if luminance < 0.2 {
        "dark"
    } else if luminance > 0.6 {
        "light"
    } else {
        "mid"
    }
}

fn saturation(hex: &str) -> f64 {
    let value = hex.strip_prefix('#').unwrap_or(hex);
    if !six_hex(value) {
        return 0.0;
    }
    let channels: Vec<f64> = (0..3).map(|at| f64::from(u8::from_str_radix(&value[at * 2..at * 2 + 2], 16).unwrap_or(0))).collect();
    let max = channels.iter().copied().fold(f64::MIN, f64::max);
    let min = channels.iter().copied().fold(f64::MAX, f64::min);
    if max != 0.0 { (max - min) / max } else { 0.0 }
}

/// `bgrHex`: the `RRGGBB` of a COM colour long (blue in the high byte).
fn bgr_hex(rgb: f64) -> String {
    let part = |value: f64| format!("{:02X}", math::round(value) as u64);
    format!("{}{}{}", part(rgb % 256.0), part(math::floor(rgb / 256.0) % 256.0), part(math::floor(rgb / 65536.0) % 256.0))
}

/// A field that owns the page: a dark or saturated surface over three fifths of the canvas is what a reader sees as a
/// beat (a cover, a section mark, a claim on a field), whatever the slide's own background says.
fn is_beat_field(fill: &str, area: f64, page: Page) -> bool {
    if fill.is_empty() || area < page.width * page.height * 0.6 {
        return false;
    }
    relative_luminance(fill).is_some_and(|luminance| luminance < 0.35) || saturation(fill) > 0.35
}

/// The surface colour of a shape: the portable snapshot's hex, or the COM snapshot's BGR long when the fill is visible
/// and not fully transparent. Empty when it has none.
fn surface_color(shape: &Value) -> String {
    let hex = text_or_empty(field_of(field(shape, "fill"), "color")).to_uppercase();
    if six_hex(&hex) {
        return hex;
    }
    let visible = field(shape, "fillVisible");
    if visible == Some(&Value::Bool(false)) || to_number_of(field(shape, "fillTransparency")) >= 1.0 {
        return String::new();
    }
    let rgb = to_number_of(field(shape, "fillColor"));
    if !rgb.is_finite() || rgb < 0.0 || visible != Some(&Value::Bool(true)) {
        return String::new();
    }
    bgr_hex(rgb)
}

/// The text colours of a shape: the portable snapshot's run colours minus the shape's own surface, or the COM run
/// colours (BGR longs; a mixed range reports a negative sentinel, which is skipped).
fn text_colors_of(shape: &Value) -> Vec<String> {
    let surface = surface_color(shape);
    let listed: Vec<String> = as_list(field(shape, "colors"))
        .into_iter()
        .map(|color| value_to_string(color).to_uppercase())
        .filter(|color| six_hex(color) && *color != surface)
        .collect();
    if !listed.is_empty() {
        return listed;
    }
    let longs: Vec<f64> = as_list(field_of(field(shape, "runs"), "colors")).into_iter().map(to_number).collect();
    if longs.is_empty() {
        // Both snapshots name font.color as RRGGBB ("111827"), which `Number` would misread as a BGR long.
        let color = field_of(field(shape, "font"), "color");
        if let Some(Value::Number(number)) = color {
            let number = number.as_f64().unwrap_or(f64::NAN);
            return if number.is_finite() && number >= 0.0 { vec![bgr_hex(number)] } else { Vec::new() };
        }
        let text = match color {
            None | Some(Value::Null) => String::new(),
            Some(inner) => value_to_string(inner),
        };
        let hex = text.strip_prefix('#').unwrap_or(&text).to_uppercase();
        return if six_hex(&hex) { vec![hex] } else { Vec::new() };
    }
    distinct_text(longs.into_iter().filter(|rgb| rgb.is_finite() && *rgb >= 0.0).map(bgr_hex))
}

/// The type sizes of a shape: every run size the portable or COM snapshot lists, else the box's font size.
fn type_sizes_of(shape: &Value) -> Vec<f64> {
    let listed: Vec<f64> =
        as_list(field(shape, "sizes")).into_iter().chain(as_list(field_of(field(shape, "runs"), "sizes"))).map(to_number).filter(|size| *size > 0.0).collect();
    if !listed.is_empty() {
        return distinct(listed);
    }
    let size = to_number_of(field_of(field(shape, "font"), "size"));
    if size > 0.0 { vec![size] } else { Vec::new() }
}

/// Page chrome (a slide-number placeholder from the master) is not the author's type or colour.
fn is_chrome(shape: &Value) -> bool {
    field(shape, "placeholder").is_some_and(truthy) || to_number_of(field(shape, "type")) == 14.0
}

fn has_text(shape: &Value) -> bool {
    !js_trim(&text_or_empty(field(shape, "text"))).is_empty()
}

// spec carriers

/// Spec carriers (kit.md section 1 SPEC): the kit signs a badge, a callout, a chevron stage, a stat numeral or a table
/// with its spec name and variant (`mixdog-spec:badge:positive`); the receipt reads the signature back: how many of
/// each the slide holds, in which variants, and with what anatomy (type sizes and face), so the deck can see whether the
/// third callout is the first's. One anatomy per carrier is the spec kept; two is a per-call override to explain.
const SPEC_PREFIX: &str = "mixdog-spec:";

#[derive(Default)]
struct SpecEntry {
    count: usize,
    variants: Vec<String>,
    anatomies: Vec<String>,
}

type Specs = Vec<(String, SpecEntry)>;

fn spec_of(shape: &Value) -> Option<(String, String)> {
    let name = text_or_empty(field(shape, "name"));
    let rest = name.strip_prefix(SPEC_PREFIX)?;
    let mut parts = rest.split(':');
    let spec = parts.next().unwrap_or_default();
    (!spec.is_empty()).then(|| (spec.to_owned(), parts.next().unwrap_or_default().to_owned()))
}

fn anatomy_of(shape: &Value) -> String {
    let sizes = ascending(type_sizes_of(shape)).into_iter().map(number_to_string).collect::<Vec<_>>().join("/");
    let face = match field(shape, "fonts") {
        Some(Value::Array(fonts)) => fonts.first(),
        _ => field_of(field(shape, "font"), "name"),
    };
    let face = face.filter(|value| truthy(value)).map(value_to_string);
    [Some(sizes).filter(|sizes| !sizes.is_empty()), face].into_iter().flatten().collect::<Vec<_>>().join("|")
}

fn note_spec(specs: &mut Specs, shape: &Value) {
    let Some((spec, variant)) = spec_of(shape) else { return };
    let at = specs.iter().position(|(name, _)| *name == spec).unwrap_or_else(|| {
        specs.push((spec, SpecEntry::default()));
        specs.len() - 1
    });
    let entry = &mut specs[at].1;
    entry.count += 1;
    if !variant.is_empty() && !entry.variants.contains(&variant) {
        entry.variants.push(variant);
    }
    let anatomy = anatomy_of(shape);
    if !anatomy.is_empty() && !entry.anatomies.contains(&anatomy) {
        entry.anatomies.push(anatomy);
    }
}

const CELL: f64 = 5.0;

/// A shape's footprint; `id` tells which shape it is (a box is the same box by `id`, as an object is by identity).
#[derive(Clone, Copy, Debug)]
struct Frame {
    id: usize,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

impl Frame {
    fn area(&self) -> f64 {
        self.width * self.height
    }

    fn bottom(&self) -> f64 {
        self.top + self.height
    }

    fn right(&self) -> f64 {
        self.left + self.width
    }

    fn relation_box(&self) -> RelationBox {
        RelationBox { slide: 0.0, shape: 0.0, left: self.left, top: self.top, width: self.width, height: self.height, relation: None, relation_error: None }
    }
}

fn is_in(list: &[Frame], frame: &Frame) -> bool {
    list.iter().any(|other| other.id == frame.id)
}

fn geometry_of(shape: &Value) -> [f64; 4] {
    [to_number_of(field(shape, "left")), to_number_of(field(shape, "top")), to_number_of(field(shape, "width")), to_number_of(field(shape, "height"))]
}

fn footprint(shape: &Value, id: usize) -> Option<Frame> {
    let [left, top, width, height] = geometry_of(shape);
    if ![left, top, width, height].iter().all(|n| n.is_finite()) || width <= 0.0 || height <= 0.0 {
        return None;
    }
    Some(Frame { id, left, top, width, height })
}

/// A hairline or a rule has no area (cx or cy = 0) and still bounds the labels beside it.
fn extent(shape: &Value) -> Option<Frame> {
    let [left, top, width, height] = geometry_of(shape);
    if ![left, top, width, height].iter().all(|n| n.is_finite()) || width < 0.0 || height < 0.0 || (width == 0.0 && height == 0.0) {
        return None;
    }
    Some(Frame { id: usize::MAX, left, top, width, height })
}

struct Raster {
    cells: Vec<u8>,
    cols: isize,
    rows: isize,
}

fn raster(frames: &[Frame], page: Page) -> Raster {
    let cols = math::ceil(page.width / CELL) as isize;
    let rows = math::ceil(page.height / CELL) as isize;
    let mut cells = vec![0_u8; (cols.max(0) * rows.max(0)) as usize];
    for frame in frames {
        let x0 = math::max(0.0, math::floor(frame.left / CELL)) as isize;
        let x1 = math::min(cols as f64, math::ceil(frame.right() / CELL)) as isize;
        let y0 = math::max(0.0, math::floor(frame.top / CELL)) as isize;
        let y1 = math::min(rows as f64, math::ceil(frame.bottom() / CELL)) as isize;
        for y in y0..y1 {
            for x in x0..x1 {
                cells[(y * cols + x) as usize] = 1;
            }
        }
    }
    Raster { cells, cols, rows }
}

/// `airOf(grid, x0, y0, x1, y1)`: the share of the window no box covers.
fn air_of(grid: &Raster, x0: isize, y0: isize, x1: isize, y1: isize) -> f64 {
    let mut covered = 0_u32;
    for y in y0..y1 {
        for x in x0..x1 {
            covered += u32::from(grid.cells[(y * grid.cols + x) as usize]);
        }
    }
    let total = (x1 - x0) * (y1 - y0);
    if total != 0 { fixed(1.0 - f64::from(covered) / total as f64, 2) } else { 1.0 }
}

fn whole_air(grid: &Raster) -> f64 {
    air_of(grid, 0, 0, grid.cols, grid.rows)
}

/// Values within `tolerance` pt of their predecessor form one cluster.
fn clusters(values: Vec<f64>, tolerance: f64) -> Vec<Vec<f64>> {
    let mut out: Vec<Vec<f64>> = Vec::new();
    for value in ascending(values) {
        if let Some(last) = out.last_mut().filter(|last| value - last[last.len() - 1] <= tolerance) {
            last.push(value);
        } else {
            out.push(vec![value]);
        }
    }
    out
}

/// Text boxes sharing a left edge (within 6 pt) form one column; a text box no other box aligns with is stray. Right
/// edges are read the same way: a box whose left edge shares a column but whose right edge shares nothing is a width
/// that drifted (a title 0.2 in wider than the prose under it): the reader sees a ragged column.
struct Edges {
    columns: usize,
    stray: usize,
    right_edges: usize,
    right_stray: usize,
}

fn left_edges(boxes: &[Frame]) -> Edges {
    let lefts = clusters(boxes.iter().map(|b| b.left).collect(), 6.0);
    let rights = clusters(boxes.iter().map(Frame::right).collect(), 6.0);
    Edges {
        columns: lefts.len(),
        stray: lefts.iter().filter(|cluster| cluster.len() == 1).count(),
        right_edges: rights.len(),
        right_stray: rights.iter().filter(|cluster| cluster.len() == 1).count(),
    }
}

/// Vertical gaps: for every box, the space to the nearest box below it that overlaps it horizontally, in inches
/// rounded to 0.05, when the two do not touch and sit within 1.5 in. The distinct values are the slide's spacing
/// vocabulary: a deck with two spacing steps reads as two values, a hand-spaced deck as a spread of them
/// (composition.md section 6). Numbers only; the plan line decides what a gap means.
fn vertical_gaps(boxes: &[Frame]) -> Vec<f64> {
    let mut values = Vec::new();
    for frame in boxes {
        let bottom = frame.bottom();
        let mut nearest: Option<&Frame> = None;
        for other in boxes {
            if other.id == frame.id || other.top < bottom - 1.0 {
                continue;
            }
            let overlap = math::min(frame.right(), other.right()) - math::max(frame.left, other.left);
            if overlap <= 0.0 {
                continue;
            }
            if nearest.is_none_or(|best| other.top < best.top) {
                nearest = Some(other);
            }
        }
        let Some(nearest) = nearest else { continue };
        let gap = (nearest.top - bottom) / 72.0;
        if gap > 0.01 && gap <= 1.5 {
            values.push(fixed(math::round(gap / 0.05) * 0.05, 2));
        }
    }
    ascending(distinct(values))
}

/// Visual centroid: the area-weighted centre of every shape that is not a canvas-wide surface, in canvas units
/// [0, 1]; offset is its ellipse-normalised distance from the canvas centre with a horizontal tolerance of 0.05 and a
/// vertical one of 0.15 (a sideways drift reads first, as in AeSlides' imbalance metric). Both are numbers the author
/// weighs; a breathing slide may sit off centre on purpose.
fn centroid_of(boxes: &[Frame], page: Page) -> Option<([f64; 2], f64)> {
    let (mut area, mut sx, mut sy) = (0.0, 0.0, 0.0);
    for frame in boxes {
        let a = frame.area();
        if a >= page.width * page.height * 0.9 {
            continue;
        }
        area += a;
        sx += a * (frame.left + frame.width / 2.0);
        sy += a * (frame.top + frame.height / 2.0);
    }
    if area == 0.0 {
        return None;
    }
    let (x, y) = (sx / area / page.width, sy / area / page.height);
    let (dx, dy) = ((x - 0.5) / 0.05, (y - 0.5) / 0.15);
    let offset = f64::sqrt(dx * dx + dy * dy);
    Some(([fixed(x, 2), fixed(y, 2)], fixed(offset, 1)))
}

/// Body top: the top edge (inches) of the first element below the largest type, where the page's content zone begins.
/// Read across the deck it shows whether content slides share one body top. Body fill: how much of the zone under the
/// title (down to the lower safe margin) the content spans, as a share: a dense slide whose content stops halfway
/// reads as a hollow; a breathing slide is meant to.
fn body_top_of(boxes: &[Frame], title: Option<&Frame>, page: Page) -> (Option<f64>, Option<f64>) {
    let Some(title) = title else { return (None, None) };
    let title_bottom = title.bottom();
    let below: Vec<&Frame> =
        boxes.iter().filter(|frame| frame.id != title.id && frame.top >= title_bottom - 2.0 && frame.area() < page.width * page.height * 0.9).collect();
    if below.is_empty() {
        return (None, None);
    }
    let top = below.iter().map(|frame| frame.top).fold(f64::INFINITY, f64::min);
    let bottom = below.iter().map(|frame| frame.bottom()).fold(f64::NEG_INFINITY, f64::max);
    let zone = page.height - 0.5 * 72.0 - top;
    (Some(fixed(top / 72.0, 2)), (zone > 0.0).then(|| fixed(f64::min(1.0, (bottom - top) / zone), 2)))
}

/// A surface field is a promise: the reader takes a tinted plane as a zone that holds something. `fieldFill` is the
/// share of each field of 6% of the canvas or more (a full-page background is not one) that content actually covers,
/// lowest first. Neither `air` nor `quadrantAir` can say this: the field's own footprint fills the very quadrant it
/// leaves empty.
fn field_fill_of(surfaces: &[Frame], grid: &Raster, page: Page) -> Vec<f64> {
    let canvas = page.width * page.height;
    let mut shares: Vec<f64> = surfaces
        .iter()
        .filter(|frame| frame.area() >= canvas * 0.06 && frame.area() < canvas * 0.9)
        .map(|frame| {
            let x0 = math::max(0.0, math::floor(frame.left / CELL)) as isize;
            let y0 = math::max(0.0, math::floor(frame.top / CELL)) as isize;
            let x1 = math::min(grid.cols as f64, math::ceil(frame.right() / CELL)) as isize;
            let y1 = math::min(grid.rows as f64, math::ceil(frame.bottom() / CELL)) as isize;
            fixed(1.0 - air_of(grid, x0, y0, x1, y1), 2)
        })
        .collect();
    shares.sort_by(|a, b| a.total_cmp(b));
    shares.truncate(3);
    shares
}

// reading the shapes of a slide

#[derive(Default)]
struct Counts {
    charts: usize,
    tables: usize,
    pictures: usize,
    groups: usize,
    text_boxes: usize,
    drawn: usize,
    fields: usize,
    lines: usize,
    largest_text: f64,
    chars: usize,
}

struct Read<'a> {
    counts: Counts,
    covered: f64,
    beat_field: bool,
    presets: Vec<String>,
    text_boxes: Vec<Frame>,
    visuals: Vec<Frame>,
    /// What the reader reads as content: text, data, pictures, contours; not fields, lines or chrome.
    content: Vec<Frame>,
    /// The spacing vocabulary's units: text and data blocks (a contour is part of a device, not a block).
    blocks: Vec<Frame>,
    /// Tinted planes and cards: the zones a reader expects to hold something.
    surfaces: Vec<Frame>,
    /// Contours and connectors: the parts of a drawn construction (a diagram reads by its extent).
    constructs: Vec<Frame>,
    fills: Vec<(String, f64)>,
    title_box: Option<Frame>,
    seen: Vec<&'a Value>,
    specs: Specs,
}

/// A vector the kit drew (an icon, a motif) is a device the page carries, not a picture the page shows: the writer
/// names it `mixdog-svg:<svg>` and the normaliser renames it "Icon" once the SVG is attached. A raster the kit drew as
/// a device with no vector source (the beat's sphere) is named `mixdog-device:<kind>` and reads the same way, so a
/// cover with its object stays a beat.
fn is_device_picture(shape: &Value) -> bool {
    let name = text_or_empty(field(shape, "name"));
    is_picture_shape(shape) && (name.starts_with("mixdog-svg:") || name.starts_with("mixdog-device:") || name == "Icon")
}

/// A chart, table, picture or group reads the same way: it covers canvas and counts as a visual, as content, and as one
/// block of the spacing vocabulary.
fn count_carrier(read: &mut Read, area: f64, frame: Option<Frame>) {
    read.covered += area;
    if let Some(frame) = frame {
        read.visuals.push(frame);
        read.content.push(frame);
        read.blocks.push(frame);
    }
}

/// One pass over the slide's shapes: counts them and sorts their footprints into the vocabularies the observations read.
fn read_shapes(shapes: &[Value], page: Page) -> Read<'_> {
    let mut read = Read {
        counts: Counts::default(),
        covered: 0.0,
        beat_field: false,
        presets: Vec::new(),
        text_boxes: Vec::new(),
        visuals: Vec::new(),
        content: Vec::new(),
        blocks: Vec::new(),
        surfaces: Vec::new(),
        constructs: Vec::new(),
        fills: Vec::new(),
        title_box: None,
        seen: Vec::new(),
        specs: Vec::new(),
    };
    for (id, shape) in shapes.iter().enumerate() {
        if field(shape, "placeholder").is_some_and(truthy) && !has_text(shape) {
            continue;
        }
        read.seen.push(shape);
        let area = number_or_zero(field(shape, "width")) * number_or_zero(field(shape, "height"));
        let frame = footprint(shape, id);
        let fill = surface_color(shape);
        if !fill.is_empty() && frame.is_some() {
            match read.fills.iter_mut().find(|(color, _)| *color == fill) {
                Some(slot) => slot.1 += area,
                None => read.fills.push((fill.clone(), area)),
            }
        }
        if field(shape, "chart").is_some_and(truthy) {
            read.counts.charts += 1;
            count_carrier(&mut read, area, frame);
            continue;
        }
        if field(shape, "table").is_some_and(truthy) {
            read.counts.tables += 1;
            note_spec(&mut read.specs, shape);
            count_carrier(&mut read, area, frame);
            continue;
        }
        if is_device_picture(shape) {
            read.counts.drawn += 1;
            read.covered += area;
            read.visuals.extend(frame);
            continue;
        }
        if is_picture_shape(shape) {
            read.counts.pictures += 1;
            count_carrier(&mut read, area, frame);
            continue;
        }
        if field(shape, "group").is_some_and(truthy) {
            read.counts.groups += 1;
            count_carrier(&mut read, area, frame);
            continue;
        }
        if has_text(shape) {
            read_text_box(&mut read, shape, frame, area);
            continue;
        }
        read_drawn_shape(&mut read, shape, frame, area, &fill, page);
    }
    read
}

fn read_text_box(read: &mut Read, shape: &Value, frame: Option<Frame>, area: f64) {
    read.counts.text_boxes += 1;
    note_spec(&mut read.specs, shape);
    let size = number_or_zero(field_of(field(shape, "font"), "size"));
    if size > read.counts.largest_text {
        read.counts.largest_text = size;
        read.title_box = frame;
    }
    let chrome = is_chrome(shape);
    if let Some(frame) = frame {
        read.text_boxes.push(frame);
        if !chrome {
            read.content.push(frame);
            read.blocks.push(frame);
        }
    }
    if !chrome {
        read.counts.chars += collapsed_length(&text_or_empty(field(shape, "text")));
    }
    read.covered += area;
}

fn read_drawn_shape(read: &mut Read, shape: &Value, frame: Option<Frame>, area: f64, fill: &str, page: Page) {
    read.counts.drawn += 1;
    read.visuals.extend(frame);
    let geometry = text_or_empty(field(shape, "geometry"));
    if geometry == "line" || geometry.contains("Connector") {
        read.counts.lines += 1;
        if let Some(span) = frame.or_else(|| extent(shape)) {
            read.constructs.push(span);
        }
    } else if geometry == "rect" || geometry == "roundRect" {
        read.counts.fields += 1;
        read.covered += area;
        if let (Some(frame), false) = (frame, fill.is_empty()) {
            read.surfaces.push(frame);
        }
        if is_beat_field(fill, area, page) {
            read.beat_field = true;
        }
    } else if !geometry.is_empty() {
        if !read.presets.contains(&geometry) {
            read.presets.push(geometry);
        }
        read.covered += area;
        if let Some(frame) = frame {
            read.content.push(frame);
            read.constructs.push(frame);
        }
    }
}

/// `String(text).replace(/\s+/g, ' ').trim().length`: the UTF-16 length of the text with every run of white space as
/// one space.
fn collapsed_length(text: &str) -> usize {
    let mut collapsed = String::new();
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    js_trim(&collapsed).encode_utf16().count()
}

/// Page grammar (composition.md section 7): a beat is a dark page or one a dark or saturated field owns; an evidence
/// page carries a chart, a table, a picture, a group, a stat, or a drawn construction (three or more contours and
/// connectors); the rest is a text page. The reference decks run beats on one page in eight and evidence on two of
/// three; the deck's shares sit in `deck.shape` and the sequence in `deck.rhythm.grammar`. Evidence first: a chart on a
/// dark page is an evidence page of a dark deck, not a beat.
fn page_grammar(background: &str, read: &Read) -> &'static str {
    let counts = &read.counts;
    let named = |name: &str| read.specs.iter().any(|(spec, _)| spec == name);
    let evidence = counts.charts + counts.tables + counts.pictures + counts.groups > 0
        || read.constructs.len() >= 3
        || named("stat")
        || named("structure")
        || named("chevrons");
    if evidence {
        "evidence"
    } else if background == "dark" || read.beat_field {
        "beat"
    } else {
        "text"
    }
}

/// Diagram labels (small text bound to a contour or connector: a node's name, an axis tick, a dumbbell value, a legend
/// entry) belong to their device, not to the page's columns and spacing steps: they leave the alignment and gap
/// readings and are counted instead.
fn diagram_labels(text_boxes: &[Frame], constructs: &[Frame]) -> Vec<Frame> {
    text_boxes
        .iter()
        .filter(|frame| {
            frame.width <= 2.5 * 72.0
                && frame.height <= 0.4 * 72.0
                && constructs.iter().any(|construct| rectangle_gap(&frame.relation_box(), &construct.relation_box()) <= 0.3 * 72.0)
        })
        .copied()
        .collect()
}

/// Presence: the share of the canvas the largest carrier takes: a chart, table, picture, group, or a drawn
/// construction (three or more contours and connectors read as one object by their extent), never a text box or a
/// tinted plane. Under a quarter of the canvas is what the reader sees as "a small chart beside a lot of copy"; 0
/// means the page carries type alone.
fn presence_of(read: &Read, canvas: f64) -> f64 {
    let largest = read.content.iter().filter(|frame| !is_in(&read.text_boxes, frame)).map(Frame::area).fold(0.0, f64::max);
    let construct_area = if read.constructs.len() >= 3 {
        let right = read.constructs.iter().map(Frame::right).fold(f64::NEG_INFINITY, f64::max);
        let left = read.constructs.iter().map(|frame| frame.left).fold(f64::INFINITY, f64::min);
        let bottom = read.constructs.iter().map(Frame::bottom).fold(f64::NEG_INFINITY, f64::max);
        let top = read.constructs.iter().map(|frame| frame.top).fold(f64::INFINITY, f64::min);
        (right - left) * (bottom - top)
    } else {
        0.0
    };
    fixed(f64::min(1.0, f64::max(largest, construct_area) / canvas), 2)
}

fn observe(read: &Read, labels: &[Frame], page: Page) -> Option<Value> {
    let boxes: Vec<Frame> = read.seen.iter().enumerate().filter_map(|(at, shape)| footprint(shape, at)).collect();
    if boxes.is_empty() {
        return None;
    }
    let authored: Vec<&Value> = read.seen.iter().copied().filter(|shape| !is_chrome(shape)).collect();
    let type_set = ascending(distinct(authored.iter().flat_map(|shape| type_sizes_of(shape))));
    let text_colors = distinct_text(authored.iter().filter(|shape| has_text(shape)).flat_map(|shape| text_colors_of(shape)));
    let all = raster(&boxes, page);
    let inner = raster(&read.content, page);
    let centroid = centroid_of(&boxes, page);
    let title = read.title_box.map(|title| {
        read.content.iter().find(|frame| frame.left == title.left && frame.top == title.top && frame.width == title.width).copied().unwrap_or(title)
    });
    let (body_top, body_fill) = body_top_of(&read.content, title.as_ref(), page);
    let (mid_x, mid_y) = (all.cols / 2, all.rows / 2);
    let canvas = page.width * page.height;
    let mut fills: Vec<(&String, f64)> = read.fills.iter().map(|(color, area)| (color, fixed(area / canvas, 2))).filter(|(_, share)| *share > 0.0).collect();
    fills.sort_by(|a, b| b.1.total_cmp(&a.1));
    fills.truncate(3);
    let presence = presence_of(read, canvas);
    let edges = left_edges(&read.text_boxes.iter().filter(|frame| !is_in(labels, frame)).copied().collect::<Vec<_>>());
    let quadrants = |grid: &Raster| {
        numbers(&[
            air_of(grid, 0, 0, mid_x, mid_y),
            air_of(grid, mid_x, 0, grid.cols, mid_y),
            air_of(grid, 0, mid_y, mid_x, grid.rows),
            air_of(grid, mid_x, mid_y, grid.cols, grid.rows),
        ])
    };
    let mut out = Map::new();
    out.insert("air".into(), json_number(whole_air(&all)));
    out.insert("quadrantAir".into(), quadrants(&all));
    out.insert("contentAir".into(), quadrants(&inner));
    out.insert("fieldFill".into(), numbers(&field_fill_of(&read.surfaces, &inner, page)));
    out.insert("largestShare".into(), json_number(fixed(boxes.iter().map(Frame::area).fold(f64::MIN, f64::max) / canvas, 2)));
    out.insert(
        "visualShare".into(),
        if read.visuals.is_empty() { json_number(0.0) } else { json_number(fixed(1.0 - whole_air(&raster(&read.visuals, page)), 2)) },
    );
    out.insert("presence".into(), json_number(presence));
    out.insert(
        "textColumns".into(),
        json!({
            "columns": edges.columns,
            "stray": edges.stray,
            "rightEdges": edges.right_edges,
            "rightStray": edges.right_stray,
            "labels": labels.len(),
        }),
    );
    out.insert("fills".into(), Value::Array(fills.iter().map(|(color, share)| json!({ "color": color, "share": json_number(*share) })).collect()));
    out.insert("largestTextTop".into(), optional(read.title_box.map(|title| fixed(title.top / 72.0, 2))));
    out.insert("bodyTop".into(), optional(body_top));
    out.insert("bodyFill".into(), optional(body_fill));
    if let Some((point, offset)) = centroid {
        out.insert("centroid".into(), numbers(&point));
        out.insert("centroidOffset".into(), json_number(offset));
    }
    let blocks: Vec<Frame> = read.blocks.iter().filter(|frame| !is_in(labels, frame)).copied().collect();
    out.insert("gaps".into(), numbers(&vertical_gaps(&blocks)));
    out.insert("typeSet".into(), numbers(&type_set));
    out.insert("textColors".into(), strings(&text_colors));
    Some(Value::Object(out))
}

/// `slideReceipt(slide, page)`: what one saved slide carries.
pub fn slide_receipt(slide: &Value, page: Page) -> Value {
    let shapes: &[Value] = field(slide, "shapes").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let background = background_role(slide);
    let read = read_shapes(shapes, page);
    let counts = &read.counts;
    let mut receipt = Map::new();
    receipt.insert("slide".into(), json_number(number_or_zero(field(slide, "index"))));
    receipt.insert("background".into(), json!(background));
    receipt.insert("charts".into(), json!(counts.charts));
    receipt.insert("tables".into(), json!(counts.tables));
    receipt.insert("pictures".into(), json!(counts.pictures));
    receipt.insert("groups".into(), json!(counts.groups));
    receipt.insert("textBoxes".into(), json!(counts.text_boxes));
    receipt.insert("drawn".into(), json!(counts.drawn));
    receipt.insert("fields".into(), json!(counts.fields));
    receipt.insert("lines".into(), json!(counts.lines));
    receipt.insert("presets".into(), strings(&read.presets));
    receipt.insert("largestText".into(), json_number(counts.largest_text));
    receipt.insert("chars".into(), json!(counts.chars));
    receipt.insert("coverage".into(), json_number(f64::min(1.0, fixed(read.covered / (page.width * page.height), 2))));
    receipt.insert("grammar".into(), json!(page_grammar(background, &read)));
    if !read.specs.is_empty() {
        let mut specs = Map::new();
        for (name, entry) in &read.specs {
            specs.insert(name.clone(), json!({ "count": entry.count, "variants": strings(&entry.variants), "anatomies": strings(&entry.anatomies) }));
        }
        receipt.insert("specs".into(), Value::Object(specs));
    }
    if let Some(observed) = observe(&read, &diagram_labels(&read.text_boxes, &read.constructs), page) {
        receipt.insert("observe".into(), observed);
    }
    Value::Object(receipt)
}

// the deck

fn count_of(slide: &Value, key: &str) -> f64 {
    number_or_zero(field(slide, key))
}

fn observed_field<'a>(slide: &'a Value, key: &str) -> Option<&'a Value> {
    field_of(field(slide, "observe"), key)
}

/// `observe.<key>[0] ?? null`.
fn first_or_null(slide: &Value, key: &str) -> Value {
    match observed_field(slide, key) {
        Some(Value::Array(items)) => items.first().filter(|item| !item.is_null()).cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// `observe.<key> ?? null`.
fn observed_or_null(slide: &Value, key: &str) -> Value {
    observed_field(slide, key).cloned().unwrap_or(Value::Null)
}

fn as_numbers(value: Option<&Value>) -> Vec<f64> {
    value.and_then(Value::as_array).map_or_else(Vec::new, |items| items.iter().map(to_number).collect())
}

fn merge_numbers(slides: &[&Value], key: &str) -> Vec<f64> {
    ascending(distinct(slides.iter().flat_map(|slide| as_numbers(observed_field(slide, key)))))
}

/// Spec carriers across the deck: how many, on how many slides, in which variants, and the distinct anatomies.
fn deck_specs(slides: &[Value]) -> Map<String, Value> {
    let mut specs = Map::new();
    for slide in slides {
        let Some(Value::Object(entries)) = field(slide, "specs") else { continue };
        for (name, entry) in entries {
            let slot = specs.entry(name.clone()).or_insert_with(|| json!({ "count": 0, "slides": 0, "variants": [], "anatomies": [] }));
            slot["count"] = json_number(to_number_of(field(slot, "count")) + to_number_of(field(entry, "count")));
            slot["slides"] = json_number(to_number_of(field(slot, "slides")) + 1.0);
            for list in ["variants", "anatomies"] {
                for item in as_list(field(entry, list)) {
                    if let Some(Value::Array(known)) = slot.get_mut(list)
                        && !known.contains(item)
                    {
                        known.push(item.clone());
                    }
                }
            }
        }
    }
    specs
}

/// The deck read as a sequence: air per slide is the density rhythm, title tops the composition variety.
fn deck_rhythm(observed: &[&Value], brief: Option<&Value>) -> Map<String, Value> {
    let each = |build: &dyn Fn(&Value) -> Value| Value::Array(observed.iter().map(|slide| build(*slide)).collect());
    let mut rhythm = Map::new();
    rhythm.insert("air".into(), each(&|s| observed_or_null(s, "air")));
    rhythm.insert("largestTextTops".into(), each(&|s| observed_or_null(s, "largestTextTop")));
    rhythm.insert("centroidX".into(), each(&|s| first_or_null(s, "centroid")));
    rhythm.insert("bodyTops".into(), each(&|s| observed_or_null(s, "bodyTop")));
    rhythm.insert("bodyFills".into(), each(&|s| observed_or_null(s, "bodyFill")));
    rhythm.insert("fieldFills".into(), each(&|s| first_or_null(s, "fieldFill")));
    rhythm.insert("presence".into(), each(&|s| observed_or_null(s, "presence")));
    rhythm.insert("chars".into(), each(&|s| field(s, "chars").cloned().unwrap_or(Value::Null)));
    rhythm.insert("grammar".into(), each(&|s| field(s, "grammar").cloned().unwrap_or(Value::Null)));
    if let Some(plan) = brief.and_then(|brief| field(brief, "plan")).and_then(Value::as_array).filter(|plan| !plan.is_empty()) {
        let planned = |slide: &Value| {
            let number = field(slide, "slide");
            let line = plan.iter().find(|entry| match (field(entry, "slide"), number) {
                (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
                _ => false,
            });
            match line.and_then(|line| field(line, "rhythm")) {
                Some(rhythm) if truthy(rhythm) => rhythm.clone(),
                _ => Value::Null,
            }
        };
        rhythm.insert("planned".into(), each(&planned));
    }
    rhythm.insert("gapSet".into(), numbers(&merge_numbers(observed, "gaps")));
    rhythm.insert("typeSet".into(), numbers(&merge_numbers(observed, "typeSet")));
    let colors = distinct_text(observed.iter().flat_map(|slide| as_list(observed_field(slide, "textColors"))).map(value_to_string));
    rhythm.insert("textColors".into(), strings(&colors));
    rhythm.insert(
        "rightStray".into(),
        each(&|s| match field_of(observed_field(s, "textColumns"), "rightStray") {
            Some(value) if !value.is_null() => value.clone(),
            _ => json!(0),
        }),
    );
    rhythm
}

fn attach_missing_carrier(slides: &mut [Value], gap: &Value) {
    let wanted = match field(gap, "slide") {
        Some(Value::Number(number)) => number.as_f64(),
        _ => None,
    };
    let target = slides.iter_mut().find(|slide| match (wanted, field(slide, "slide")) {
        (Some(wanted), Some(Value::Number(number))) => number.as_f64() == Some(wanted),
        _ => false,
    });
    if let Some(Value::Object(target)) = target {
        let carrier = field(gap, "carrier").cloned().unwrap_or(Value::Null);
        match target.get_mut("missing") {
            Some(Value::Array(missing)) => missing.push(carrier),
            _ => {
                target.insert("missing".into(), Value::Array(vec![carrier]));
            }
        }
    }
}

/// `compositionReceipt(document, brief)`: the whole deck: per-slide receipts, totals, the families that never appear,
/// and the plan lines whose named carriers the snapshot cannot see.
pub fn composition_receipt(document: &Value, brief: Option<&Value>) -> Value {
    let page = canvas_of(document);
    let mut slides: Vec<Value> =
        field(document, "slides").and_then(Value::as_array).map_or(&[][..], Vec::as_slice).iter().map(|slide| slide_receipt(slide, page)).collect();
    let mut deck = Map::new();
    deck.insert("slides".into(), json!(slides.len()));
    let total = |family: &str| -> f64 {
        slides.iter().map(|slide| if family == "presets" { as_list(field(slide, family)).len() as f64 } else { count_of(slide, family) }).sum()
    };
    for family in ["charts", "tables", "pictures", "presets", "fields", "lines", "groups"] {
        deck.insert(family.into(), json_number(total(family)));
    }
    let backgrounds = distinct_text(slides.iter().map(|slide| text_or_empty(field(slide, "background"))).filter(|name| !name.is_empty()));
    deck.insert("backgrounds".into(), strings(&backgrounds));
    let text_only = slides
        .iter()
        .filter(|slide| {
            count_of(slide, "textBoxes") != 0.0 && ["charts", "tables", "pictures", "drawn", "groups"].iter().all(|key| count_of(slide, key) == 0.0)
        })
        .count();
    deck.insert("textOnly".into(), json!(text_only));
    let specs = deck_specs(&slides);
    if !specs.is_empty() {
        deck.insert("specs".into(), Value::Object(specs));
    }
    // The deck's shape: the share of beat, evidence and text pages (composition.md section 7: the reference decks run
    // about 0.13 / 0.67 / 0.13; a deck with a beat on every third page reads as a slideshow of covers).
    if !slides.is_empty() {
        let share = |grammar: &str| {
            let count = slides.iter().filter(|slide| field(slide, "grammar").and_then(Value::as_str) == Some(grammar)).count();
            json_number(fixed(count as f64 / slides.len() as f64, 2))
        };
        deck.insert("shape".into(), json!({ "beat": share("beat"), "evidence": share("evidence"), "text": share("text") }));
    }
    let absent: Vec<String> = ["charts", "tables", "pictures", "presets", "fields", "lines"]
        .iter()
        .filter(|family| deck.get(**family) == Some(&json!(0)))
        .map(|family| (*family).to_owned())
        .collect();
    let observed: Vec<&Value> = slides.iter().filter(|slide| field(slide, "observe").is_some_and(truthy)).collect();
    if !observed.is_empty() {
        deck.insert("rhythm".into(), Value::Object(deck_rhythm(&observed, brief)));
    }
    let gaps = brief.filter(|brief| truthy(brief)).map_or_else(Vec::new, |brief| planned_carrier_gaps(document, brief));
    for gap in &gaps {
        attach_missing_carrier(&mut slides, gap);
    }
    json!({
        "slides": slides,
        "deck": deck,
        "absent": strings(&absent),
        // The field glossary lives in the pptx skill (section 2 step 6), read once, instead of riding every receipt.
        "note": "Observations, not design targets; the pptx skill (§2 step 6, \"Receipt fields\") defines each one. absent lists unused families, not required objects. Judge relevance, legibility, grouping, and emphasis from the rendered pages, not from these ratios.",
    })
}

// the rendered page, read after the fact

/// What a render read of one page (an entry of `renderedAirByPage`): the air, and when the reading has them the colour,
/// the share of the largest object and the visual-weight balance.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PageRead {
    pub air: Option<f64>,
    pub colour: Option<f64>,
    pub largest: Option<f64>,
    pub balance: Option<Balance>,
}

impl From<&Air> for PageRead {
    fn from(read: &Air) -> Self {
        Self { air: read.air, colour: Some(read.colour), largest: Some(read.largest), balance: read.balance }
    }
}

impl PageRead {
    /// A page read as its air alone (a bare number in Node's map).
    pub fn air_only(air: f64) -> Self {
        Self { air: Some(air), ..Self::default() }
    }
}

fn balance_value(balance: &Balance) -> Value {
    json!({
        "centered": json_number(balance.centered),
        "leftRight": json_number(balance.left_right),
        "topBottom": json_number(balance.top_bottom),
        "score": json_number(balance.score),
    })
}

/// Colour pacing (composition.md section 7), read from the rendered colourfulness beside the shape grammar: the spread
/// across the pages (population standard deviation: the frontier decks run 16-36, a one-template IR deck 5-8, the
/// preferred deck-level spread 15 +- 6), the longest run of quiet pages (under the deck's median colour and not a
/// beat), and the plan lines that promised `rhythm: anchor` on a page that rendered quiet. Numbers only.
fn colour_pacing(receipt: &Value, colours: &[Option<f64>], planned: &[&Value]) -> Option<Value> {
    let measured: Vec<f64> = colours.iter().flatten().copied().collect();
    if measured.len() < 2 {
        return None;
    }
    let count = measured.len() as f64;
    let mean = measured.iter().fold(0.0, |sum, value| sum + value) / count;
    let spread = f64::sqrt(measured.iter().fold(0.0, |sum, value| sum + (value - mean) * (value - mean)) / count);
    let median = ascending(measured.clone())[math::floor(count / 2.0) as usize];
    let slides = as_list(field(receipt, "slides"));
    let quiet: Vec<bool> = slides
        .iter()
        .enumerate()
        .map(|(at, slide)| {
            colours.get(at).copied().flatten().is_some_and(|colour| colour < median) && field(slide, "grammar").and_then(Value::as_str) != Some("beat")
        })
        .collect();
    let (mut longest, mut run) = (0_usize, 0_usize);
    for is_quiet in &quiet {
        run = if *is_quiet { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let anchors: Vec<Value> = slides
        .iter()
        .enumerate()
        .filter(|(at, _)| {
            let line = planned.get(*at).map(|value| text_or_empty(Some(value))).unwrap_or_default();
            line.get(..6).is_some_and(|head| head.eq_ignore_ascii_case("anchor")) && quiet[*at]
        })
        .map(|(_, slide)| field(slide, "slide").cloned().unwrap_or(Value::Null))
        .collect();
    Some(json!({
        "colourSpread": json_number(fixed(spread, 1)),
        "median": json_number(fixed(median, 1)),
        "longestQuiet": longest,
        "quietAnchors": anchors,
    }))
}

/// `attachRenderedAir(receipt, airByPage)`: `renderAir` per slide joins the shape-based observation so the two
/// readings can be compared (a picture-heavy slide shows a low shape air and a high render air). `renderBalance`
/// (DeepSlides' visual-weight balance) joins the same way, with `topBottom` the number for "the top of the page is
/// empty". The receipt stays as it is when it has no slide or the render read no page.
pub fn attach_rendered_air(receipt: &mut Value, air_by_page: &[(f64, PageRead)]) {
    let slide_count = field(receipt, "slides").and_then(Value::as_array).map_or(0, Vec::len);
    if slide_count == 0 || air_by_page.is_empty() {
        return;
    }
    let mut sequence: Vec<Value> = Vec::new();
    let mut balance: Vec<Value> = Vec::new();
    let mut colours: Vec<Option<f64>> = Vec::new();
    let mut largest: Vec<Option<f64>> = Vec::new();
    if let Some(Value::Array(slides)) = receipt.get_mut("slides") {
        for slide in slides.iter_mut() {
            let page = field(slide, "slide").map(to_number);
            let found = page.and_then(|page| air_by_page.iter().find(|(known, _)| *known == page || (known.is_nan() && page.is_nan())));
            let read = found.map(|(_, read)| read);
            let colour = read.and_then(|read| read.colour);
            let object = read.and_then(|read| read.largest);
            match read.and_then(|read| read.air.map(|air| (read, air))) {
                Some((read, air)) => {
                    if let Some(map) = slide.as_object_mut() {
                        let mut observe = entries_of(map.get("observe"));
                        observe.insert("renderAir".into(), json_number(air));
                        if let Some(weight) = read.balance.as_ref() {
                            observe.insert("renderBalance".into(), balance_value(weight));
                        }
                        if let Some(colour) = colour {
                            observe.insert("renderColour".into(), json_number(colour));
                        }
                        if let Some(object) = object {
                            observe.insert("renderLargest".into(), json_number(object));
                        }
                        map.insert("observe".into(), Value::Object(observe));
                    }
                    sequence.push(json_number(air));
                    balance.push(optional(read.balance.map(|weight| weight.top_bottom)));
                }
                None => {
                    sequence.push(Value::Null);
                    balance.push(Value::Null);
                }
            }
            colours.push(colour);
            largest.push(object);
        }
    }
    let planned: Vec<Value> = as_list(field_of(field(receipt, "deck"), "rhythm").and_then(|rhythm| field(rhythm, "planned"))).into_iter().cloned().collect();
    let pacing = colour_pacing(receipt, &colours, &planned.iter().collect::<Vec<_>>());
    let Some(Value::Object(deck)) = receipt.get_mut("deck") else { return };
    let mut rhythm = entries_of(deck.get("rhythm"));
    rhythm.insert("renderAir".into(), Value::Array(sequence));
    rhythm.insert("topBottom".into(), Value::Array(balance));
    if largest.iter().any(Option::is_some) {
        rhythm.insert("renderLargest".into(), Value::Array(largest.iter().copied().map(optional).collect()));
    }
    if pacing.is_some() {
        rhythm.insert("colour".into(), Value::Array(colours.iter().copied().map(optional).collect()));
    }
    deck.insert("rhythm".into(), Value::Object(rhythm));
    if let Some(pacing) = pacing {
        deck.insert("pacing".into(), pacing);
    }
}

// what a session already holds

/// A receipt is resent on every author and render of a session, and between two of them most slides keep their shapes.
/// The session remembers the structure it last sent per slide and for the deck; a part that still matches goes out as
/// `unchanged: true` with only what a render reads from the pixels, so the caller keeps the structure it already holds
/// instead of reading it again. This is that memory (`session.deliveredReceipt`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeliveredReceipt {
    slides: Vec<(String, String)>,
    deck: String,
}

const RENDER_OBSERVE: [&str; 4] = ["renderAir", "renderBalance", "renderColour", "renderLargest"];
const RENDER_RHYTHM: [&str; 4] = ["renderAir", "topBottom", "renderLargest", "colour"];
const SLIDE_COUNTS: [&str; 8] = ["charts", "tables", "pictures", "groups", "textBoxes", "drawn", "fields", "lines"];

fn entries_of(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

fn without_keys(value: Option<&Value>, keys: &[&str]) -> Map<String, Value> {
    entries_of(value).into_iter().filter(|(key, _)| !keys.contains(&key.as_str())).collect()
}

fn pick_keys(value: Option<&Value>, keys: &[&str]) -> Map<String, Value> {
    entries_of(value).into_iter().filter(|(key, _)| keys.contains(&key.as_str())).collect()
}

/// What a slide reading says once: empty lists read as absent, and `contentAir` is sent only where fields make it
/// differ from `quadrantAir`.
fn slide_digest(slide: &Value) -> Map<String, Value> {
    let mut observe = entries_of(field(slide, "observe"));
    let same = match (observe.get("contentAir"), observe.get("quadrantAir")) {
        (Some(content), Some(quadrant)) => json_stringify(content) == json_stringify(quadrant),
        (None, None) => true,
        _ => false,
    };
    if same {
        observe.shift_remove("contentAir");
    }
    observe.retain(|_, value| !matches!(value, Value::Array(items) if items.is_empty()));
    let mut digest = entries_of(Some(slide));
    digest.insert("observe".into(), Value::Object(observe));
    digest.retain(|_, value| !matches!(value, Value::Array(items) if items.is_empty()));
    // A slide's own zero counts and blank background say what it does not carry; the deck line keeps the totals a
    // deck-wide zero is read from.
    for key in SLIDE_COUNTS {
        if digest.get(key).is_some_and(|value| value.as_f64() == Some(0.0)) {
            digest.shift_remove(key);
        }
    }
    if digest.get("background") == Some(&Value::String(String::new())) {
        digest.shift_remove("background");
    }
    digest
}

fn slide_key(slide: &Map<String, Value>) -> String {
    slide.get("slide").map_or_else(|| "undefined".to_owned(), json_stringify)
}

/// The deck's structure key, and the collapsed deck when it matches the one `previous` holds.
fn deck_delivery(parts: &Map<String, Value>, previous: &str) -> (String, Option<Value>) {
    let mut rest = parts.clone();
    let pacing = rest.shift_remove("pacing");
    let rhythm = rest.shift_remove("rhythm");
    rest.insert("rhythm".into(), Value::Object(without_keys(rhythm.as_ref(), &RENDER_RHYTHM)));
    let structure = json_stringify(&Value::Object(rest));
    if previous != structure {
        return (structure, None);
    }
    let mut collapsed = Map::new();
    collapsed.insert("unchanged".into(), Value::Bool(true));
    let rendered_rhythm = pick_keys(rhythm.as_ref(), &RENDER_RHYTHM);
    if !rendered_rhythm.is_empty() {
        collapsed.insert("rhythm".into(), Value::Object(rendered_rhythm));
    }
    if let Some(pacing) = pacing.filter(|pacing| truthy(pacing)) {
        collapsed.insert("pacing".into(), pacing);
    }
    (structure, Some(Value::Object(collapsed)))
}

/// `receiptForDelivery(receipt, session)`: the receipt as the result carries it: a part that matches what `session`
/// holds goes out as `unchanged`, and `session` becomes what this receipt sends. Mutates nothing it is given; without a
/// session, or a receipt with no `slides`, the receipt goes out as it is.
pub fn receipt_for_delivery(receipt: &Value, session: Option<&mut DeliveredReceipt>) -> Value {
    let (Some(Value::Array(raw_slides)), Some(session)) = (field(receipt, "slides"), session) else {
        return receipt.clone();
    };
    let previous = std::mem::take(session);
    let mut next = DeliveredReceipt::default();
    let slides: Vec<Value> = raw_slides
        .iter()
        .map(|raw| {
            let slide = slide_digest(raw);
            let mut keyed = slide.clone();
            keyed.insert("observe".into(), Value::Object(without_keys(slide.get("observe"), &RENDER_OBSERVE)));
            let structure = json_stringify(&Value::Object(keyed));
            let key = slide_key(&slide);
            match next.slides.iter_mut().find(|(known, _)| *known == key) {
                Some(slot) => slot.1.clone_from(&structure),
                None => next.slides.push((key.clone(), structure.clone())),
            }
            if previous.slides.iter().find(|(known, _)| *known == key).map(|(_, held)| held) != Some(&structure) {
                return Value::Object(slide);
            }
            let rendered = pick_keys(slide.get("observe"), &RENDER_OBSERVE);
            let mut out = Map::new();
            if let Some(number) = slide.get("slide") {
                out.insert("slide".into(), number.clone());
            }
            out.insert("unchanged".into(), Value::Bool(true));
            if !rendered.is_empty() {
                out.insert("observe".into(), Value::Object(rendered));
            }
            Value::Object(out)
        })
        .collect();
    let original = field(receipt, "deck").cloned();
    let mut deck = original.clone();
    if let Some(Value::Object(parts)) = original.as_ref().filter(|deck| truthy(deck)) {
        let (structure, collapsed) = deck_delivery(parts, &previous.deck);
        next.deck = structure;
        if let Some(collapsed) = collapsed {
            deck = Some(collapsed);
        }
    }
    *session = next;
    let collapsed =
        slides.iter().any(|slide| field(slide, "unchanged").is_some_and(truthy)) || deck.as_ref().and_then(|deck| field(deck, "unchanged")).is_some_and(truthy);
    let mut out = entries_of(Some(receipt));
    out.insert("slides".into(), Value::Array(slides));
    if let Some(deck) = deck {
        out.insert("deck".into(), deck);
    }
    if collapsed {
        out.insert("unchangedMeans".into(), json!("unchanged: this part matches the receipt this session sent last; only render readings are new."));
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::brief::parse_authoring_brief;

    fn document() -> Value {
        json!({ "slides": [
            { "index": 1, "background": { "color": "0F1B26" }, "shapes": [
                { "text": "Cover title", "font": { "size": 47 }, "width": 600, "height": 120 },
                { "text": "01", "font": { "size": 240 }, "width": 400, "height": 300 },
            ] },
            { "index": 2, "background": { "color": "F7F9FB" }, "shapes": [
                { "text": "Title", "font": { "size": 36 }, "width": 800, "height": 60 },
                { "chart": { "path": "/slide[2]/shape[2]/chart" }, "width": 600, "height": 320 },
                { "geometry": "rect", "fill": { "color": "DCEBEC" }, "width": 870, "height": 50 },
                { "text": "Takeaway", "font": { "size": 22 }, "width": 850, "height": 50 },
            ] },
            { "index": 3, "background": { "color": "F7F9FB" }, "shapes": [
                { "text": "Title", "font": { "size": 36 }, "width": 800, "height": 60 },
                { "geometry": "chevron", "fill": { "color": "E9EFF3" }, "width": 200, "height": 80 },
                { "geometry": "chevron", "fill": { "color": "0E7C86" }, "width": 200, "height": 80 },
                { "geometry": "line", "width": 300, "height": 0 },
                { "text": "detail", "font": { "size": 13 }, "width": 200, "height": 80 },
            ] },
            { "index": 4, "background": { "color": "F7F9FB" }, "shapes": [
                { "text": "Title", "font": { "size": 36 }, "width": 800, "height": 60 },
                { "text": "a paragraph", "font": { "size": 18 }, "width": 800, "height": 200 },
            ] },
        ] })
    }

    fn receipt_of(slide: Value) -> Value {
        slide_receipt(&slide, WIDE_CANVAS)
    }

    fn number(value: &Value) -> f64 {
        value.as_f64().expect("a number")
    }

    #[test]
    fn a_slide_receipt_counts_what_the_saved_slide_carries_and_names_its_preset_contours() {
        let document = document();
        let slides = document["slides"].as_array().expect("slides");
        let cover = receipt_of(slides[0].clone());
        assert_eq!(cover["background"], "dark");
        assert_eq!(cover["largestText"], 240);
        let process = receipt_of(slides[2].clone());
        assert_eq!(process["presets"], json!(["chevron"]));
        assert_eq!(process["drawn"], 3);
        assert_eq!(process["lines"], 1);
        assert_eq!(process["textBoxes"], 2);
        let evidence = receipt_of(slides[1].clone());
        assert_eq!(evidence["charts"], 1);
        assert_eq!(evidence["fields"], 1);
        let coverage = number(&evidence["coverage"]);
        assert!(coverage > 0.3 && coverage <= 1.0);
    }

    // The kit signs its spec carriers by name; the receipt reads them back per slide and across the deck, and a carrier
    // whose type size or face changed between slides shows as a second anatomy: information, not a verdict.
    #[test]
    fn a_receipt_reads_spec_carriers_from_their_signatures_and_shows_a_second_anatomy_when_one_drifted() {
        let document = json!({ "slides": [
            { "index": 1, "background": { "color": "F7F9FB" }, "shapes": [
                { "text": "채택", "name": "mixdog-spec:badge:positive", "font": { "size": 11, "name": "Noto Sans KR" }, "width": 90, "height": 24 },
                { "text": "보류", "name": "mixdog-spec:badge:warning", "font": { "size": 11, "name": "Noto Sans KR" }, "width": 90, "height": 24 },
                { "text": "31", "name": "mixdog-spec:stat:band", "font": { "size": 49, "name": "Arial" }, "width": 200, "height": 80 },
                { "table": { "path": "/slide[1]/shape[4]/table" }, "name": "mixdog-spec:table:toned", "width": 600, "height": 200 },
                { "text": "plain box", "font": { "size": 18 }, "width": 300, "height": 60 },
            ] },
            { "index": 2, "background": { "color": "F7F9FB" }, "shapes": [
                { "text": "기각", "name": "mixdog-spec:badge:critical", "font": { "size": 14, "name": "Noto Sans KR" }, "width": 90, "height": 24 },
                { "text": "주의", "name": "mixdog-spec:callout:warning", "font": { "size": 14, "name": "Noto Sans KR" }, "width": 300, "height": 60 },
            ] },
        ] });
        let slides = document["slides"].as_array().expect("slides");
        let first = receipt_of(slides[0].clone());
        assert_eq!(first["specs"]["badge"], json!({ "count": 2, "variants": ["positive", "warning"], "anatomies": ["11|Noto Sans KR"] }));
        assert_eq!(first["specs"]["stat"], json!({ "count": 1, "variants": ["band"], "anatomies": ["49|Arial"] }));
        assert_eq!(first["specs"]["table"], json!({ "count": 1, "variants": ["toned"], "anatomies": [] }));
        assert_eq!(receipt_of(slides[1].clone())["specs"]["callout"]["count"], 1);
        let plain = receipt_of(json!({ "index": 3, "shapes": [{ "text": "no signature", "font": { "size": 18 }, "width": 10, "height": 10 }] }));
        assert!(plain.get("specs").is_none(), "a slide without carriers carries no specs key");
        let deck = composition_receipt(&document, None);
        assert_eq!(
            deck["deck"]["specs"]["badge"],
            json!({ "count": 3, "slides": 2, "variants": ["positive", "warning", "critical"], "anatomies": ["11|Noto Sans KR", "14|Noto Sans KR"] }),
            "the badge on slide 2 drifted to 14 pt: two anatomies"
        );
        assert_eq!(deck["deck"]["specs"]["callout"]["slides"], 1);
    }

    fn footprint_slide() -> Value {
        json!({ "index": 5, "background": { "color": "F7F9FB" }, "shapes": [
            { "text": "Title", "font": { "size": 36 }, "left": 43, "top": 72, "width": 600, "height": 60 },
            { "geometry": "rect", "fill": { "color": "0E7C86" }, "left": 0, "top": 0, "width": 480, "height": 540 },
            { "text": "body", "font": { "size": 18 }, "left": 43, "top": 200, "width": 400, "height": 100 },
            { "text": "stray", "font": { "size": 18 }, "left": 700, "top": 300, "width": 200, "height": 60 },
            { "chart": { "path": "/slide[5]/shape[5]/chart" }, "left": 500, "top": 100, "width": 400, "height": 150 },
        ] })
    }

    #[test]
    fn a_slide_receipt_observes_air_quadrants_the_largest_object_text_columns_and_fills_from_shape_footprints() {
        let o = receipt_of(footprint_slide())["observe"].clone();
        let air = number(&o["air"]);
        assert!(air > 0.3 && air < 0.6, "air {air}");
        assert_eq!(o["quadrantAir"][0], 0, "the dark field fills the top-left quadrant");
        assert_eq!(o["quadrantAir"][2], 0, "and the bottom-left");
        assert!(number(&o["quadrantAir"][3]) > 0.7, "bottom-right is mostly air");
        assert_eq!(o["largestShare"], 0.5);
        let visual = number(&o["visualShare"]);
        assert!(visual > 0.55 && visual < 0.65, "field + chart footprint {visual}");
        assert_eq!(o["presence"], 0.12, "presence is the chart (400 x 150 of 960 x 540), never the field or a text box");
        assert_eq!(o["textColumns"], json!({ "columns": 2, "stray": 1, "rightEdges": 3, "rightStray": 3, "labels": 0 }));
        assert_eq!(o["fills"], json!([{ "color": "0E7C86", "share": 0.5 }]));
        assert_eq!(o["largestTextTop"], 1);
        assert_eq!(o["bodyTop"], 2.78, "the body starts at the first box under the title (the body text at 200 pt)");
        assert!(number(&o["centroid"][0]) < 0.5, "the dark left field pulls the centroid left");
        assert!(number(&o["centroidOffset"]) > 1.0, "and past the horizontal tolerance");
    }

    #[test]
    fn three_contours_and_a_connector_read_as_one_construction_by_their_extent() {
        let diagram = receipt_of(json!({ "index": 9, "background": { "color": "F7F9FB" }, "shapes": [
            { "text": "Title", "font": { "size": 36 }, "left": 43, "top": 72, "width": 600, "height": 60 },
            { "geometry": "ellipse", "fill": { "color": "0E7C86" }, "left": 100, "top": 200, "width": 30, "height": 30 },
            { "geometry": "ellipse", "fill": { "color": "0E7C86" }, "left": 700, "top": 200, "width": 30, "height": 30 },
            { "geometry": "line", "left": 130, "top": 215, "width": 570, "height": 0 },
            { "geometry": "ellipse", "fill": { "color": "0E7C86" }, "left": 400, "top": 460, "width": 30, "height": 30 },
        ] }));
        assert_eq!(diagram["observe"]["presence"], 0.35, "630 x 290 of the canvas");
    }

    #[test]
    fn a_canvas_wide_surface_does_not_move_the_centroid() {
        let centered = receipt_of(json!({ "index": 7, "background": { "color": "F7F9FB" }, "shapes": [
            { "geometry": "rect", "fill": { "color": "F7F9FB" }, "left": 0, "top": 0, "width": 960, "height": 540 },
            { "text": "claim", "font": { "size": 40 }, "left": 280, "top": 220, "width": 400, "height": 100 },
        ] }));
        assert_eq!(centered["observe"]["centroid"], json!([0.5, 0.5]));
        assert_eq!(centered["observe"]["centroidOffset"], 0);
    }

    #[test]
    fn a_com_fill_is_read_from_its_bgr_long_and_an_invisible_fill_is_not_a_surface() {
        let com = receipt_of(json!({ "index": 6, "background": { "color": "0F1B26" }, "shapes": [
            { "text": "no fill textbox", "font": { "size": 18 }, "left": 40, "top": 40, "width": 300, "height": 60, "fillColor": 16777215, "fillVisible": false },
            { "geometry": "rect", "left": 480, "top": 0, "width": 480, "height": 540, "fillColor": 8813582, "fillVisible": true },
        ] }));
        assert_eq!(com["observe"]["fills"], json!([{ "color": "0E7C86", "share": 0.5 }]), "the BGR long 8813582 is 0E7C86");
    }

    #[test]
    fn a_slide_without_positions_has_no_observation() {
        let positionless = receipt_of(document()["slides"][0].clone());
        assert!(positionless.get("observe").is_none(), "no footprint, no observation");
    }

    #[test]
    fn a_slide_receipt_reads_the_spacing_vocabulary_ragged_right_edges_the_type_sizes_and_the_text_colors() {
        let slide = json!({ "index": 8, "background": { "color": "F7F9FB" }, "shapes": [
            { "text": "Title", "font": { "size": 36 }, "sizes": [36], "colors": ["1A2B3C"], "left": 43, "top": 72, "width": 600, "height": 60 },
            { "text": "prose", "font": { "size": 18 }, "sizes": [18, 18], "colors": ["33475B", "B04A2A"], "left": 43, "top": 164.4, "width": 560, "height": 100 },
            { "text": "caption", "font": { "size": 12 }, "sizes": [12], "colors": ["6B7A8A"], "left": 43, "top": 273, "width": 560, "height": 20 },
            { "geometry": "rect", "fill": { "color": "0E7C86" }, "left": 700, "top": 100, "width": 200, "height": 300 },
            // The COM font colour is a BGR long: 16777215 is FFFFFF.
            { "text": "on field", "font": { "size": 18, "color": 16777215 }, "left": 720, "top": 120, "width": 160, "height": 40 },
        ] });
        let o = receipt_of(slide.clone())["observe"].clone();
        assert_eq!(o["gaps"], json!([0.1, 0.45]), "two spacing steps read as two values");
        assert_eq!(
            o["textColumns"],
            json!({ "columns": 2, "stray": 1, "rightEdges": 3, "rightStray": 2, "labels": 0 }),
            "title, prose and caption share a left edge; prose and caption share a right edge, the title is 0.55 in wider (ragged right)"
        );
        assert_eq!(o["typeSet"], json!([12, 18, 36]));
        assert_eq!(
            o["textColors"],
            json!(["1A2B3C", "33475B", "B04A2A", "6B7A8A", "FFFFFF"]),
            "the field's own surface colour is not a text colour; the COM long decodes to white"
        );
        let mut second = slide.clone();
        second["index"] = json!(9);
        second["shapes"] = Value::Array(slide["shapes"].as_array().expect("shapes")[..2].to_vec());
        let deck = composition_receipt(&json!({ "slides": [slide, second] }), None);
        assert_eq!(deck["deck"]["rhythm"]["gapSet"], json!([0.1, 0.45]));
        assert_eq!(deck["deck"]["rhythm"]["typeSet"], json!([12, 18, 36]));
        assert_eq!(deck["deck"]["rhythm"]["textColors"].as_array().map(Vec::len), Some(5));
        assert_eq!(deck["deck"]["rhythm"]["rightStray"], json!([2, 2]));
    }

    #[test]
    fn a_tinted_plane_that_holds_two_lines_reads_as_an_empty_plane_where_footprint_air_cannot() {
        let shapes = json!([
            { "text": "Title", "font": { "size": 36 }, "left": 43, "top": 72, "width": 400, "height": 60 },
            // The plane, bottom-right.
            { "geometry": "rect", "fill": { "color": "E7EBEE" }, "left": 480, "top": 160, "width": 480, "height": 380 },
            { "text": "two lines on the plane", "font": { "size": 14 }, "left": 510, "top": 180, "width": 400, "height": 50 },
            { "chart": { "path": "/slide[11]/shape[4]/chart" }, "left": 43, "top": 160, "width": 400, "height": 360 },
        ]);
        let hollow = receipt_of(json!({ "index": 11, "background": { "color": "F7F9FB" }, "shapes": shapes }))["observe"].clone();
        assert_eq!(hollow["quadrantAir"][3], 0, "the plane covers the bottom-right quadrant");
        assert!(number(&hollow["contentAir"][3]) > 0.9, "while nothing is in it");
        assert!(number(&hollow["fieldFill"][0]) < 0.2, "and the plane carries almost none of itself");
        let mut more = shapes.as_array().expect("shapes").clone();
        more.push(json!({ "text": "the rest of the column", "font": { "size": 14 }, "left": 510, "top": 260, "width": 400, "height": 260 }));
        let filled = receipt_of(json!({ "index": 12, "background": { "color": "F7F9FB" }, "shapes": more }))["observe"].clone();
        assert!(number(&filled["fieldFill"][0]) > 0.6, "content that owns the plane reads high");
        assert!(number(&filled["contentAir"][3]) < 0.5, "and the quadrant carries content");
        let deck = composition_receipt(&json!({ "slides": [{ "index": 11, "shapes": shapes }] }), None);
        assert_eq!(deck["deck"]["rhythm"]["fieldFills"], json!([hollow["fieldFill"][0]]), "the deck rhythm lists the emptiest plane per slide");
    }

    #[test]
    fn the_deck_receipt_totals_the_families_lists_the_absent_ones_and_marks_contradicted_plan_lines() {
        let brief = parse_authoring_brief(
            "\n// BRIEF\n// slide plan: 1 job: cover · carriers: statement · 2 job: evidence · carriers: chart · 3 job: process · carriers: diagram · 4 job: evidence · carriers: chart, table\n",
        );
        let receipt = composition_receipt(&document(), Some(&brief));
        assert_eq!(receipt["deck"]["slides"], 4);
        assert_eq!(receipt["deck"]["charts"], 1);
        assert_eq!(receipt["deck"]["presets"], 1);
        assert_eq!(receipt["deck"]["textOnly"], 2, "the cover (type only) and the paragraph slide are text-only; the receipt reports, the author decides");
        assert_eq!(receipt["deck"]["backgrounds"], json!(["dark", "light"]));
        assert_eq!(receipt["absent"], json!(["tables", "pictures"]));
        assert!(receipt["slides"][1].get("missing").is_none());
        assert_eq!(receipt["slides"][3]["missing"], json!(["chart", "table"]));
    }

    #[test]
    fn rendered_air_joins_the_receipt_per_slide_and_in_the_deck_rhythm() {
        let shape = json!({ "text": "a", "font": { "size": 30 }, "left": 40, "top": 40, "width": 300, "height": 60 });
        let mut receipt = composition_receipt(&json!({ "slides": [{ "index": 1, "shapes": [shape] }, { "index": 2, "shapes": [shape] }] }), None);
        attach_rendered_air(&mut receipt, &[(1.0, PageRead::air_only(0.71))]);
        assert_eq!(receipt["slides"][0]["observe"]["renderAir"], 0.71);
        assert!(receipt["slides"][1]["observe"].get("renderAir").is_none());
        assert_eq!(receipt["deck"]["rhythm"]["renderAir"], json!([0.71, null]));
        assert_eq!(receipt["deck"]["rhythm"]["centroidX"].as_array().map(Vec::len), Some(2));
    }

    fn grammar_deck() -> (Value, Value) {
        let paper = "F7F9FB";
        let title = json!({ "text": "Title", "font": { "size": 36 }, "left": 43, "top": 72, "width": 600, "height": 60 });
        let prose = "A body page carries the argument in the source's own words, three hundred characters or more beside its chart.";
        let document = json!({ "slides": [
            { "index": 1, "background": { "color": "0F1B26" }, "shapes": [
                { "text": "Cover", "font": { "size": 47 }, "left": 43, "top": 200, "width": 600, "height": 120 },
                { "type": "p:pic", "name": "Icon", "left": 500, "top": 20, "width": 440, "height": 500 },
            ] },
            { "index": 2, "background": { "color": paper }, "shapes": [
                title,
                { "chart": {}, "left": 43, "top": 150, "width": 800, "height": 340 },
                { "text": prose, "font": { "size": 15 }, "left": 43, "top": 500, "width": 800, "height": 30 },
            ] },
            { "index": 3, "background": { "color": paper }, "shapes": [
                { "geometry": "rect", "fill": { "color": "0E7C86" }, "left": 0, "top": 0, "width": 960, "height": 540 },
                { "text": "Section", "font": { "size": 40 }, "left": 43, "top": 200, "width": 600, "height": 80 },
            ] },
            { "index": 4, "background": { "color": paper }, "shapes": [
                title,
                { "text": prose, "font": { "size": 15 }, "left": 43, "top": 150, "width": 800, "height": 200 },
            ] },
            { "index": 5, "background": { "color": paper }, "shapes": [
                title,
                { "text": "A stat band", "name": "mixdog-spec:stat:band", "font": { "size": 54 }, "left": 43, "top": 150, "width": 300, "height": 100 },
            ] },
            { "index": 6, "background": { "color": paper }, "shapes": [
                title,
                { "geometry": "ellipse", "left": 100, "top": 200, "width": 80, "height": 80 },
                { "geometry": "ellipse", "left": 400, "top": 200, "width": 80, "height": 80 },
                { "geometry": "line", "left": 180, "top": 240, "width": 220, "height": 0 },
            ] },
        ] });
        let brief = parse_authoring_brief(
            "\n// BRIEF\n// slide plan: 1 job: cover · rhythm: anchor · 2 job: evidence · rhythm: dense · 3 job: section · rhythm: anchor · 4 job: claim · rhythm: anchor · 5 job: evidence · rhythm: dense · 6 job: process · rhythm: dense\n",
        );
        (document, brief)
    }

    #[test]
    fn the_receipt_reads_each_pages_grammar_and_characters_and_the_decks_shape_against_the_planned_rhythm() {
        let (document, brief) = grammar_deck();
        let receipt = composition_receipt(&document, Some(&brief));
        let grammar: Vec<Value> = receipt["slides"].as_array().expect("slides").iter().map(|slide| slide["grammar"].clone()).collect();
        assert_eq!(
            Value::Array(grammar.clone()),
            json!(["beat", "evidence", "beat", "text", "evidence", "evidence"]),
            "dark and field pages are beats; a chart, a signed stat and a drawn construction are evidence; prose alone is text"
        );
        assert_eq!(
            receipt["slides"][1]["chars"],
            5 + "A body page carries the argument in the source's own words, three hundred characters or more beside its chart.".encode_utf16().count(),
            "characters of authored text"
        );
        assert_eq!(receipt["deck"]["shape"], json!({ "beat": 0.33, "evidence": 0.5, "text": 0.17 }));
        assert_eq!(receipt["deck"]["rhythm"]["grammar"], Value::Array(grammar));
        assert_eq!(receipt["deck"]["rhythm"]["planned"], json!(["anchor", "dense", "anchor", "anchor", "dense", "dense"]));
    }

    #[test]
    fn rendered_colour_paces_the_deck_against_the_quiet_pages_and_the_anchors_the_plan_promised() {
        let (document, brief) = grammar_deck();
        let mut receipt = composition_receipt(&document, Some(&brief));
        let read = |air: f64, colour: f64, largest: f64| PageRead {
            air: Some(air),
            colour: Some(colour),
            largest: Some(largest),
            balance: Some(Balance { centered: 0.9, left_right: 0.9, top_bottom: 0.9, score: 0.9 }),
        };
        attach_rendered_air(
            &mut receipt,
            &[
                (1.0, read(0.8, 30.0, 0.9)),
                (2.0, read(0.4, 18.0, 0.45)),
                (3.0, read(0.85, 45.0, 0.95)),
                (4.0, read(0.6, 6.0, 0.08)),
                (5.0, read(0.6, 7.0, 0.12)),
                (6.0, read(0.5, 8.0, 0.3)),
            ],
        );
        assert_eq!(receipt["deck"]["rhythm"]["colour"], json!([30, 18, 45, 6, 7, 8]));
        assert_eq!(receipt["deck"]["rhythm"]["renderLargest"], json!([0.9, 0.45, 0.95, 0.08, 0.12, 0.3]));
        assert_eq!(receipt["slides"][1]["observe"]["renderLargest"], 0.45);
        assert_eq!(receipt["slides"][3]["observe"]["renderColour"], 6);
        let pacing = &receipt["deck"]["pacing"];
        assert_eq!(pacing["median"], 18);
        let spread = number(&pacing["colourSpread"]);
        assert!(spread > 14.0 && spread < 15.0, "population spread of the six readings: {spread}");
        assert_eq!(pacing["longestQuiet"], 3, "slides 4-6 sit under the median with no beat; slide 2 is at the median");
        assert_eq!(pacing["quietAnchors"], json!([4]), "slide 4 promised an anchor and rendered as quiet paper");
    }

    #[test]
    fn a_raster_the_kit_drew_as_a_device_keeps_its_page_a_beat_while_a_placed_picture_makes_it_evidence() {
        let cover = |name: &str| {
            json!({ "slides": [{ "index": 1, "background": { "color": "0F1B26" }, "shapes": [
                { "text": "Cover", "font": { "size": 47 }, "left": 43, "top": 200, "width": 600, "height": 120 },
                { "type": "p:pic", "name": name, "altText": "sphere", "left": 560, "top": 60, "width": 460, "height": 460 },
            ] }] })
        };
        let device = composition_receipt(&cover("mixdog-device:orb"), None);
        assert_eq!(device["slides"][0]["grammar"], "beat", "the sphere is the beat's object, not a picture page");
        assert_eq!(device["slides"][0]["drawn"], 1);
        assert_eq!(device["slides"][0]["pictures"], 0);
        let photo = composition_receipt(&cover("Picture 3"), None);
        assert_eq!(photo["slides"][0]["grammar"], "evidence", "a placed picture is read as the page's evidence");
        assert_eq!(photo["slides"][0]["pictures"], 1);
    }

    fn session_receipt(second_chars: i64) -> Value {
        json!({
            "slides": [
                { "slide": 1, "charts": 0, "chars": 40, "grammar": "beat", "observe": { "air": 0.6 } },
                { "slide": 2, "charts": 1, "chars": second_chars, "grammar": "evidence", "observe": { "air": 0.3 } },
            ],
            "deck": { "slides": 2, "charts": 1, "rhythm": { "air": [0.6, 0.3] } },
            "absent": ["tables"],
            "note": "n",
        })
    }

    #[test]
    fn the_first_delivery_of_a_session_is_whole() {
        let mut session = DeliveredReceipt::default();
        let first = receipt_for_delivery(&session_receipt(60), Some(&mut session));
        assert!(first["slides"][0].get("unchanged").is_none());
        assert!(first["slides"][0].get("charts").is_none(), "a slide's zero count reads the same absent; the deck keeps totals");
        assert!(first.get("unchangedMeans").is_none());
    }

    #[test]
    fn a_resent_receipt_carries_only_what_a_render_read() {
        let receipt = session_receipt;
        let mut session = DeliveredReceipt::default();
        receipt_for_delivery(&receipt(60), Some(&mut session));
        let mut rendered = receipt(60);
        attach_rendered_air(
            &mut rendered,
            &[
                (1.0, PageRead { air: Some(0.58), colour: Some(14.0), ..PageRead::default() }),
                (2.0, PageRead { air: Some(0.4), colour: Some(50.0), ..PageRead::default() }),
            ],
        );
        let again = receipt_for_delivery(&rendered, Some(&mut session));
        assert_eq!(again["slides"][0], json!({ "slide": 1, "unchanged": true, "observe": { "renderAir": 0.58, "renderColour": 14 } }));
        assert_eq!(again["deck"]["unchanged"], true);
        assert_eq!(again["deck"]["rhythm"]["renderAir"], json!([0.58, 0.4]));
        assert!(again["deck"].get("slides").is_none(), "the deck structure the caller holds is not resent");
        assert!(again["unchangedMeans"].as_str().is_some_and(|text| text.contains("matches the receipt this session sent last")));
        assert_eq!(rendered["slides"][0]["charts"], 0, "the receipt handed in is not mutated");
    }

    #[test]
    fn a_slide_digest_drops_empty_lists_and_a_content_air_equal_to_the_quadrant_air() {
        let plain = receipt_for_delivery(
            &json!({ "slides": [{
                "slide": 9,
                "presets": [],
                "observe": { "quadrantAir": [0.5, 0.5, 0.5, 0.5], "contentAir": [0.5, 0.5, 0.5, 0.5], "fills": [], "fieldFill": [0.3] },
            }] }),
            Some(&mut DeliveredReceipt::default()),
        );
        assert_eq!(plain["slides"][0], json!({ "slide": 9, "observe": { "quadrantAir": [0.5, 0.5, 0.5, 0.5], "fieldFill": [0.3] } }));
    }

    #[test]
    fn an_edited_slide_is_sent_whole_and_another_session_or_none_starts_whole() {
        let receipt = session_receipt;
        let mut session = DeliveredReceipt::default();
        receipt_for_delivery(&receipt(60), Some(&mut session));
        let edited = receipt_for_delivery(&receipt(75), Some(&mut session));
        assert_eq!(edited["slides"][0]["unchanged"], true);
        assert_eq!(edited["slides"][1]["chars"], 75, "a slide whose structure changed is sent whole");
        assert!(
            receipt_for_delivery(&receipt(75), Some(&mut DeliveredReceipt::default()))["slides"][1].get("unchanged").is_none(),
            "another session starts whole"
        );
        assert_eq!(receipt_for_delivery(&receipt(75), None), receipt(75), "without a session the receipt goes out as it is");
    }

    #[test]
    fn a_receipt_without_a_brief_still_reports_the_deck_and_never_fails_on_an_empty_document() {
        let receipt = composition_receipt(&json!({ "slides": [] }), None);
        assert_eq!(receipt["deck"]["slides"], 0);
        assert_eq!(receipt["slides"], json!([]));
        assert!(!receipt["absent"].as_array().expect("absent").is_empty());
    }

    #[test]
    fn diagram_labels_bound_to_a_contour_or_connector_leave_the_column_and_gap_readings_and_are_counted() {
        let shapes = json!([
            { "text": "Title", "font": { "size": 36 }, "left": 43, "top": 72, "width": 600, "height": 60 },
            // A gap of 0.45 in under the title.
            { "text": "a paragraph under the title", "font": { "size": 18 }, "left": 43, "top": 164.4, "width": 560, "height": 100 },
            { "geometry": "line", "left": 100, "top": 305, "width": 300, "height": 0 },
            // An axis tick 5 pt above its hairline.
            { "text": "L2", "font": { "size": 11 }, "left": 100, "top": 280, "width": 40, "height": 20 },
            { "geometry": "ellipse", "fill": { "color": "0E7C86" }, "left": 700, "top": 200, "width": 14, "height": 14 },
            // A node label 6 pt from its dot.
            { "text": "node", "font": { "size": 11 }, "left": 720, "top": 196, "width": 60, "height": 20 },
            { "text": "a caption far from any device", "font": { "size": 12 }, "left": 43, "top": 400, "width": 560, "height": 20 },
        ]);
        let o = receipt_of(json!({ "index": 13, "background": { "color": "F7F9FB" }, "shapes": shapes }))["observe"].clone();
        assert_eq!(
            o["textColumns"],
            json!({ "columns": 1, "stray": 0, "rightEdges": 2, "rightStray": 1, "labels": 2 }),
            "the tick and the node label are parts of their device; title, paragraph and caption form the page's column"
        );
        assert_eq!(o["gaps"], json!([0.45]), "the step from the paragraph down to the tick is a device gap, not a spacing step of the page");
    }

    #[test]
    fn a_document_names_its_own_page_and_a_hex_with_trailing_text_is_not_a_colour() {
        assert_eq!(canvas_of(&json!({ "slideWidth": 595, "slideHeight": 842 })), Page { width: 595.0, height: 842.0 });
        assert_eq!(canvas_of(&json!({ "slideWidth": 595 })), WIDE_CANVAS);
        assert_eq!(bgr_hex(8_813_582.0), "0E7C86");
        assert!(!six_hex("0E7C86\n"));
        assert_eq!(collapsed_length("  a \t\n b  "), 3);
    }
}
