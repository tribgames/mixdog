//! `assurance-structure-pptx.mjs`: slide structure review, the type hierarchy, the alignment axes, peers, text walls
//! and collisions. The areas are in pt², the thresholds are Node's floats, and the issues come in Node's order.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, math, number_to_string, to_number, value_to_string};
use mixdog_office_design::discipline::{font_family_key, is_motif_shape, is_picture_shape};
use mixdog_office_design::templates::annotate_pptx_snapshot_roles;
use serde_json::Value;

use super::{coalesce, distinct_sorted, length, list, nested, num, num0, record, text, trimmed, warn};
use crate::{field, field_of, is_truthy, strict_equals, template_text};

/// Presentation body copy stays at 12 pt or more, but page chrome (kickers, page badges, captions, source lines) is
/// legitimately smaller and may sit closer to the edge. Chrome is a short line at caption size; anything longer is body
/// copy whatever its size.
const PPTX_BODY_MIN_PT: f64 = 12.0;
const PPTX_CHROME_MIN_PT: f64 = 9.0;
const PPTX_EDGE_PT: f64 = 18.0;
const PPTX_CHROME_EDGE_PT: f64 = 10.0;
const PPTX_CHROME_MAX_CHARS: usize = 90;

/// Near-miss alignment: an element a few points off an axis the slide already shares reads as a mistake, not as a
/// decision.
const PPTX_AXIS_SNAP_PT: f64 = 1.0;
const PPTX_AXIS_DRIFT_PT: f64 = 6.0;
/// The kit's icon bands: glyph 0.3 in, marker 0.45 in: a picture that small is a mark inside a unit.
const PPTX_INLINE_ICON_PT: f64 = 36.0;
const PPTX_AXIS_MEMBERS: usize = 2;
const PPTX_AXIS_REPORTS_PER_SLIDE: usize = 3;

/// An edge is compared only with edges of its own kind: left edges make a column, tops make a row, centres make a
/// spine.
const PPTX_AXIS_KINDS: [&str; 6] = ["left edge", "centre", "right edge", "top edge", "middle", "bottom edge"];
/// A line has no width or no height, so its two edges and its centre are one position; the collapsed dimension reports
/// its centre only.
const PPTX_VERTICAL_AXES: [&str; 3] = ["top edge", "bottom edge", "middle"];
const PPTX_HORIZONTAL_AXES: [&str; 3] = ["left edge", "right edge", "centre"];

/// A row of identical cards is read as one rhythm, so the gaps between them are part of the shape.
const PPTX_ROW_BAND_PT: f64 = 2.0;
const PPTX_ROW_SIZE_RATIO: f64 = 0.02;
const PPTX_ROW_GAP_RATIO: f64 = 0.05;
const PPTX_ROW_GAP_PT: f64 = 2.0;
/// A gap half again wider than its peers is a break between groups.
const PPTX_ROW_BREAK_RATIO: f64 = 1.5;
/// The gaps carry the rhythm only while they are small beside the objects they separate.
const PPTX_ROW_GAP_TO_WIDTH: f64 = 0.5;

const LABEL_UNIT_CHARS: usize = 16;
/// The kicker is recognised by its type, not its length: one line, at most three fifths of the size of the line under it.
const KICKER_SIZE_SHARE: f64 = 0.6;
const LABEL_UNIT_WIDTH_SHARE: f64 = 0.6;
const LABEL_HEADING_CHARS: usize = 28;

/// A row of peers is read as one set.
const PEER_TYPE_TOLERANCE: f64 = 0.05;
const PEER_WIDTH_SHARE: f64 = 0.6;
/// A page that fits its words is not a page anyone reads from a seat.
const TEXT_WALL_CHARS: usize = 900;
const TEXT_WALL_COVERAGE: f64 = 0.45;
/// How much of a text box an opaque object may cover before the words behind it stop being read.
const TEXT_OCCLUSION_SHARE: f64 = 0.25;
/// Slack an auto-fitting text box carries below its last line.
const PPTX_TEXT_COLLISION_PT: f64 = 4.0;
/// A page of boxes all set in one size has no voice the eye reaches first.
const FLAT_PAGE_TEXT_BOXES: usize = 3;
/// Type itself can lead where the induction names no title: a page whose loudest box runs a third larger than the type
/// around it has a place to start.
const HIERARCHY_LEAD_RATIO: f64 = 1.3;
/// A text box that dips a sliver into a surface it does not sit in reads as a collision, not a decision.
const TEXT_EDGE_SLACK_PT: f64 = 2.0;
/// Only a surface drawn to its frame has the frame's edges.
const FRAME_EDGED_GEOMETRY: [&str; 2] = ["rect", "roundRect"];

/// A slide is seen whole on a screen, fitted to its height; the floors scale with the height, never the width. A PDF's
/// designed sheet is paper in the hand: the print floors.
const SLIDE_HEIGHT_PT: f64 = 540.0;
const PRINT_BODY_MIN_PT: f64 = 9.0;
const PRINT_CHROME_MIN_PT: f64 = 7.0;

/// Slide-number fields (master placeholders) carry their size in the field run, which the snapshot does not always
/// surface; the numeral itself is the chrome.
static PPTX_PAGE_NUMBER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\s*(?:\d+\s*(?:\/|of)\s*\d+|\d{1,3})\s*$", "i"));
static PEER_SLOT: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^((?:column|metric|step)-(?:title|body|value|label|detail))-\d+$", ""));
static LINE_BREAK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[\r\n]", ""));
static ANY_DIGIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\d", ""));
static CITED_SOURCE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"(?:source\s*:|[\w .-]+!\$?[A-Z]{1,3}\$?\d+|출처\s*:)", "i"));

/// The numbers of a shape's frame (`Number(shape.left)` and the like).
#[derive(Clone, Copy)]
struct Frame {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

fn frame_of(shape: &Value) -> Frame {
    Frame {
        left: num(field(shape, "left")),
        top: num(field(shape, "top")),
        width: num(field(shape, "width")),
        height: num(field(shape, "height")),
    }
}

/// `hasFrame(shape)`.
fn has_frame(shape: &Value) -> bool {
    let frame = frame_of(shape);
    [frame.left, frame.top, frame.width, frame.height].iter().all(|edge| edge.is_finite())
}

/// The area two boxes share, in pt².
fn intersection_area(left: &Frame, right: &Frame) -> f64 {
    let width = f64::max(0.0, f64::min(left.left + left.width, right.left + right.width) - f64::max(left.left, right.left));
    let height = f64::max(0.0, f64::min(left.top + left.height, right.top + right.height) - f64::max(left.top, right.top));
    width * height
}

fn overlap_ratio(left: &Frame, right: &Frame) -> f64 {
    let smallest = f64::min(left.width * left.height, right.width * right.height);
    if smallest > 0.0 { intersection_area(left, right) / smallest } else { 0.0 }
}

/// A slide with the shapes the reader sees.
struct Slide<'a> {
    value: &'a Value,
    shapes: Vec<&'a Value>,
}

impl Slide<'_> {
    /// `slideAt(slide)`.
    fn at(&self) -> String {
        let path = field(self.value, "path");
        if is_truthy(path) { text(path) } else { format!("/slide[{}]", template_text(field(self.value, "index"))) }
    }

    /// `shape.path || slide.path` as a record's path, which `undefined` leaves out.
    fn path_of(&self, shape: &Value) -> Option<String> {
        let own = field(shape, "path");
        if is_truthy(own) {
            return Some(text(own));
        }
        field(self.value, "path").map(|path| if path.is_null() { String::new() } else { value_to_string(path) })
    }

    /// `${shape.path || slide.path}` inside a template literal.
    fn path_template(&self, shape: &Value) -> String {
        let own = field(shape, "path");
        if is_truthy(own) { text(own) } else { template_text(field(self.value, "path")) }
    }

    /// `chart.path || \`${shape.path || slide.path}/chart\``.
    fn chart_path(&self, shape: &Value, chart: &Value) -> String {
        let own = field(chart, "path");
        if is_truthy(own) { text(own) } else { format!("{}/chart", self.path_template(shape)) }
    }
}

/// `officeColorRgb(value)`: no colour is no colour (a slide that follows its master reports background.color as "").
fn office_color_rgb(value: Option<&Value>) -> Option<[u32; 3]> {
    let value = value?;
    match value {
        Value::Null => return None,
        Value::String(raw) => {
            let trimmed = js_trim(raw);
            if trimmed.is_empty() {
                return None;
            }
            let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
            if hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                let channel = |at: usize| u32::from_str_radix(&hex[at..at + 2], 16).ok();
                return Some([channel(0)?, channel(2)?, channel(4)?]);
            }
        }
        _ => {}
    }
    let color = to_number(value);
    if !color.is_finite() || !(0.0..=16_777_215.0).contains(&color) {
        return None;
    }
    let bits = color.trunc() as u32;
    Some([bits & 255, (bits >> 8) & 255, (bits >> 16) & 255])
}

fn relative_luminance(rgb: Option<[u32; 3]>) -> Option<f64> {
    let channels = rgb?.map(|entry| {
        let channel = f64::from(entry) / 255.0;
        if channel <= 0.04045 { channel / 12.92 } else { math::pow((channel + 0.055) / 1.055, 2.4) }
    });
    Some(0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2])
}

fn color_contrast_ratio(left: Option<&Value>, right: Option<&Value>) -> Option<f64> {
    let left_luminance = relative_luminance(office_color_rgb(left))?;
    let right_luminance = relative_luminance(office_color_rgb(right))?;
    let lighter = f64::max(left_luminance, right_luminance);
    let darker = f64::min(left_luminance, right_luminance);
    Some((lighter + 0.05) / (darker + 0.05))
}

/// `solidShapeFill(shape)`: a PowerPoint session reports a fill as fillColor with its transparency; a portable snapshot
/// reports it as fill: { color }. A fill with no transparency recorded is an opaque fill.
fn solid_shape_fill(shape: Option<&Value>) -> Option<&Value> {
    let fill = shape.and_then(|inner| field(inner, "fill"));
    let color = coalesce(shape.and_then(|inner| field(inner, "fillColor")), field_of(fill, "color"));
    let zero = Value::from(0);
    let transparency = num(coalesce(
        shape.and_then(|inner| field(inner, "fillTransparency")),
        coalesce(field_of(fill, "transparency"), Some(&zero)),
    ));
    if office_color_rgb(color).is_none() || !transparency.is_finite() || transparency >= 0.2 { None } else { color }
}

/// `!!solidShapeFill(shape)`: the colour a solid fill reports is read as a truth value, so a fill of the number 0 is none.
fn solid_fill_truthy(shape: &Value) -> bool {
    solid_shape_fill(Some(shape)).is_some_and(|color| is_truthy(Some(color)))
}

/// `String(shape?.text || '').trim()` of a shape that may be absent.
fn has_text(shape: &Value) -> bool {
    !trimmed(field(shape, "text")).is_empty()
}

fn containing_surface<'a>(text_shape: &Text<'_>, shapes: &[&'a Value]) -> Option<&'a Value> {
    let center_x = text_shape.frame.left + text_shape.frame.width / 2.0;
    let center_y = text_shape.frame.top + text_shape.frame.height / 2.0;
    let mut best: Option<(&'a Value, f64)> = None;
    for shape in shapes {
        let frame = frame_of(shape);
        let behind = num(field(shape, "index")) < num(field(text_shape.shape, "index"));
        if !(behind
            && !has_text(shape)
            && solid_shape_fill(Some(*shape)).is_some()
            && frame.left <= center_x
            && frame.top <= center_y
            && frame.left + frame.width >= center_x
            && frame.top + frame.height >= center_y)
        {
            continue;
        }
        let area = frame.width * frame.height;
        if best.is_none_or(|(_, known)| area < known) {
            best = Some((*shape, area));
        }
    }
    best.map(|(shape, _)| shape)
}

/// A text box a slide measures: the ones with words, a frame, and no motif role, their edges as numbers.
struct Text<'a> {
    shape: &'a Value,
    frame: Frame,
}

impl Text<'_> {
    fn index(&self) -> Option<&Value> {
        field(self.shape, "index")
    }

    fn font_size(&self) -> f64 {
        num0(nested(self.shape, "font", "size"))
    }
}

fn pptx_text_shapes<'a>(slide: &Slide<'a>) -> Vec<Text<'a>> {
    slide
        .shapes
        .iter()
        .filter(|shape| has_text(shape) && !is_motif_shape(shape) && has_frame(shape))
        .map(|shape| Text { shape: *shape, frame: frame_of(shape) })
        .collect()
}

/// `isPptxPicture(shape)`: a structure review also reads the snapshot's own picture fields.
fn is_pptx_picture(shape: &Value) -> bool {
    is_truthy(field(shape, "picture")) || is_truthy(field(shape, "image")) || is_picture_shape(shape)
}

/// A picture is `p:pic` in the portable snapshot and msoPicture (13) in the COM one; PowerPoint reports a picture that
/// carries an SVG source (the kit's icons) as msoGraphic (28).
fn is_pptx_inline_icon(shape: &Value) -> bool {
    (is_pptx_picture(shape) || num(field(shape, "type")) == 28.0)
        && f64::max(num0(field(shape, "width")), num0(field(shape, "height"))) <= PPTX_INLINE_ICON_PT
}

/// The kit signs the glow it draws under a hero object; it is a gradient that ends at zero alpha, not a plane.
fn is_halo_device(shape: &Value) -> bool {
    let name = field(shape, "name");
    let name = if is_truthy(name) { text(name) } else { text(field(shape, "objectName")) };
    name == "mixdog-device:glow"
}

fn is_page_number(shape: &Value) -> bool {
    is_truthy(field(shape, "placeholder")) && PPTX_PAGE_NUMBER.is_match(&trimmed(field(shape, "text")))
}

fn is_pptx_chrome_text(shape: &Value) -> bool {
    let body = trimmed(field(shape, "text"));
    let font_size = num0(nested(shape, "font", "size"));
    if is_truthy(field(shape, "placeholder")) && PPTX_PAGE_NUMBER.is_match(&body) {
        return true;
    }
    font_size > 0.0 && font_size <= PPTX_BODY_MIN_PT && length(&body) <= PPTX_CHROME_MAX_CHARS && !LINE_BREAK.is_match(&body)
}

/// A placed (non-text) shape the alignment review reads: its frame and which dimension spans the page.
struct Placed<'a> {
    shape: &'a Value,
    frame: Frame,
    spans_height: bool,
    spans_width: bool,
}

fn placed_axes(placed: &Placed<'_>) -> Vec<(&'static str, f64)> {
    let frame = &placed.frame;
    let flat_x = frame.width == 0.0;
    let flat_y = frame.height == 0.0;
    let mut axes: Vec<(&'static str, f64)> = Vec::new();
    if !flat_x {
        axes.push(("left edge", frame.left));
        axes.push(("right edge", frame.left + frame.width));
    }
    axes.push(("centre", frame.left + frame.width / 2.0));
    if !flat_y {
        axes.push(("top edge", frame.top));
        axes.push(("bottom edge", frame.top + frame.height));
    }
    axes.push(("middle", frame.top + frame.height / 2.0));
    axes.retain(|(kind, _)| {
        !(placed.spans_height && PPTX_VERTICAL_AXES.contains(kind)) && !(placed.spans_width && PPTX_HORIZONTAL_AXES.contains(kind))
    });
    axes
}

/// The axes the slide itself establishes: positions three or more shapes already share, to the point, on the same kind
/// of edge. A pair is a coincidence; a third shape makes it the slide's grid, which is what a drifting element breaks.
fn established_axes(shapes: &[Placed<'_>]) -> Vec<Vec<f64>> {
    let mut members: Vec<Vec<(f64, usize)>> = vec![Vec::new(); PPTX_AXIS_KINDS.len()];
    for (at, shape) in shapes.iter().enumerate() {
        for (kind, value) in placed_axes(shape) {
            let slot = PPTX_AXIS_KINDS.iter().position(|known| *known == kind).unwrap_or(0);
            members[slot].push((value, at));
        }
    }
    let mut axes: Vec<Vec<f64>> = vec![Vec::new(); PPTX_AXIS_KINDS.len()];
    for (slot, entries) in members.iter_mut().enumerate() {
        entries.sort_by(|left, right| left.0.total_cmp(&right.0));
        let mut cluster: Vec<(f64, usize)> = Vec::new();
        let mut flush = |cluster: &mut Vec<(f64, usize)>| {
            let mut distinct: Vec<usize> = cluster.iter().map(|entry| entry.1).collect();
            distinct.sort_unstable();
            distinct.dedup();
            if distinct.len() >= PPTX_AXIS_MEMBERS {
                axes[slot].push(cluster.iter().fold(0.0, |sum, entry| sum + entry.0) / cluster.len() as f64);
            }
            cluster.clear();
        };
        for entry in entries.iter() {
            if !cluster.is_empty() && entry.0 - cluster[0].0 > PPTX_AXIS_SNAP_PT {
                flush(&mut cluster);
            }
            cluster.push(*entry);
        }
        flush(&mut cluster);
    }
    axes
}

struct Drift {
    name: &'static str,
    offset: f64,
    axis: f64,
}

fn axis_drift(shape: &Placed<'_>, axes: &[Vec<f64>]) -> Option<Drift> {
    for (kind, value) in placed_axes(shape) {
        let slot = PPTX_AXIS_KINDS.iter().position(|known| *known == kind).unwrap_or(0);
        let candidates = &axes[slot];
        if candidates.iter().any(|axis| (axis - value).abs() <= PPTX_AXIS_SNAP_PT) {
            continue;
        }
        if let Some(axis) = candidates.iter().find(|candidate| (*candidate - value).abs() <= PPTX_AXIS_DRIFT_PT) {
            return Some(Drift { name: kind, offset: (axis - value).abs(), axis: *axis });
        }
    }
    None
}

fn pptx_peer_rows<'p, 'a>(shapes: &'p [Placed<'a>]) -> Vec<Vec<&'p Placed<'a>>> {
    let mut rows: Vec<Vec<&Placed<'a>>> = Vec::new();
    for shape in shapes {
        if !(shape.frame.width > 0.0 && shape.frame.height > 0.0) {
            continue;
        }
        let row = rows.iter_mut().find(|row| {
            let first = &row[0].frame;
            (first.top - shape.frame.top).abs() <= PPTX_ROW_BAND_PT
                && (first.height - shape.frame.height).abs() <= f64::max(1.0, first.height * PPTX_ROW_SIZE_RATIO)
                && (first.width - shape.frame.width).abs() <= f64::max(1.0, first.width * PPTX_ROW_SIZE_RATIO)
        });
        match row {
            Some(row) => row.push(shape),
            None => rows.push(vec![shape]),
        }
    }
    let mut kept: Vec<Vec<&Placed<'a>>> = rows.into_iter().filter(|row| row.len() >= 3).collect();
    for row in &mut kept {
        row.sort_by(|left, right| left.frame.left.total_cmp(&right.frame.left));
    }
    kept
}

struct Spread {
    smallest: f64,
    largest: f64,
    count: usize,
}

fn row_gap_spread(row: &[&Placed<'_>]) -> Option<Spread> {
    let gaps: Vec<f64> = (1..row.len()).map(|at| row[at].frame.left - (row[at - 1].frame.left + row[at - 1].frame.width)).collect();
    if gaps.iter().any(|gap| *gap <= 0.0) {
        return None;
    }
    let average = gaps.iter().fold(0.0, |sum, gap| sum + gap) / gaps.len() as f64;
    let smallest = gaps.iter().copied().fold(f64::INFINITY, f64::min);
    let largest = gaps.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let spread = largest - smallest;
    if largest > row[0].frame.width * PPTX_ROW_GAP_TO_WIDTH {
        return None;
    }
    if spread <= PPTX_ROW_GAP_PT || spread <= average * PPTX_ROW_GAP_RATIO {
        return None;
    }
    if largest >= smallest * PPTX_ROW_BREAK_RATIO {
        return None;
    }
    Some(Spread { smallest, largest, count: row.len() })
}

/// A plane that runs the page's full height or full width was not placed on that dimension: its middle is the page's
/// middle. It keeps the edges it does place.
fn page_spanning(frame: &Frame, canvas: &Canvas) -> (bool, bool) {
    let spans_height = canvas.height > 0.0 && frame.top <= 0.5 && frame.top + frame.height >= canvas.height - 0.5;
    let spans_width = canvas.width > 0.0 && frame.left <= 0.5 && frame.left + frame.width >= canvas.width - 0.5;
    (spans_height, spans_width)
}

struct Canvas {
    width: f64,
    height: f64,
}

fn review_alignment(slide: &Slide<'_>, issues: &mut Vec<Value>, canvas: &Canvas) {
    let placed: Vec<Placed<'_>> = slide
        .shapes
        .iter()
        .filter(|shape| !is_motif_shape(shape) && !is_pptx_inline_icon(shape) && !has_text(shape) && has_frame(shape))
        .map(|shape| {
            let frame = frame_of(shape);
            let (spans_height, spans_width) = page_spanning(&frame, canvas);
            Placed { shape: *shape, frame, spans_height, spans_width }
        })
        .collect();
    let axes = established_axes(&placed);
    let mut drifts = 0;
    for shape in &placed {
        if drifts >= PPTX_AXIS_REPORTS_PER_SLIDE {
            break;
        }
        let Some(drift) = axis_drift(shape, &axes) else { continue };
        drifts += 1;
        issues.push(warn(
            "axis_drift",
            slide.path_of(shape.shape),
            format!(
                "The {} sits {} pt off the axis the slide shares at {} pt.",
                drift.name,
                math::to_fixed(drift.offset, 1),
                math::to_fixed(drift.axis, 1)
            ),
        ));
    }
    for row in pptx_peer_rows(&placed) {
        let Some(spread) = row_gap_spread(&row) else { continue };
        issues.push(warn(
            "peer_gap_uneven",
            Some(slide.at()),
            format!(
                "A row of {} equal shapes is spaced from {} to {} pt; the gaps read as a wobble rather than one rhythm.",
                spread.count,
                math::to_fixed(spread.smallest, 1),
                math::to_fixed(spread.largest, 1)
            ),
        ));
    }
}

fn is_kicker_over_title(upper: &Text<'_>, lower: &Text<'_>) -> bool {
    let upper_size = upper.font_size();
    let lower_size = lower.font_size();
    let upper_height = upper.frame.height;
    if upper_size == 0.0 || lower_size == 0.0 || upper_size > lower_size * KICKER_SIZE_SHARE {
        return false;
    }
    // One line of that size, with the slack a text box carries around its own line.
    upper_height > 0.0 && upper_height <= (upper_size / 72.0) * 1.2 * 1.9 * 72.0
}

/// A figure and the words that name it sit close on purpose, whichever way round the page sets them.
fn is_labelled_unit(left: &Text<'_>, right: &Text<'_>) -> bool {
    let (upper, lower) = if left.frame.top <= right.frame.top { (left, right) } else { (right, left) };
    let upper_text = trimmed(field(upper.shape, "text"));
    let upper_size = upper.font_size();
    let lower_size = lower.font_size();
    if upper_size == 0.0 || lower_size == 0.0 {
        return false;
    }
    if is_kicker_over_title(upper, lower) {
        return true;
    }
    // A heading line over the detail it names is the same unit as a figure over its caption; what marks it is the step
    // in type, not a short string.
    let stepped = upper_size >= lower_size * 1.2 || lower_size >= upper_size * 1.2;
    if stepped && !upper_text.contains('\n') && length(&upper_text) <= LABEL_HEADING_CHARS {
        return true;
    }
    if length(&upper_text) > LABEL_UNIT_CHARS {
        return false;
    }
    if stepped {
        return true;
    }
    // Two lines a step apart in size are still a label and its detail when the measure says so.
    let (upper_width, lower_width) = (upper.frame.width, lower.frame.width);
    upper_width > 0.0 && lower_width > 0.0 && upper_width <= lower_width * LABEL_UNIT_WIDTH_SHARE
}

fn shape_faces(shape: &Value) -> Vec<String> {
    let names: Vec<Option<&Value>> = match field(shape, "fonts").and_then(Value::as_array) {
        Some(fonts) => fonts.iter().map(Some).collect(),
        None => vec![nested(shape, "font", "name")],
    };
    names.into_iter().map(|name| font_family_key(&text(name))).filter(|key| !key.is_empty()).collect()
}

/// Two or more series drawn in two or more colours are read by whatever names them: the chart's legend, labels carrying
/// the series name, or the page's own words. With none of those the colours mean nothing.
fn review_chart_series_naming(slide: &Slide<'_>, at: usize, issues: &mut Vec<Value>) {
    let shape = slide.shapes[at];
    let Some(chart) = field(shape, "chart").filter(|chart| is_truthy(Some(*chart))) else { return };
    if num(field(chart, "seriesCount")) < 2.0 {
        return;
    }
    if field(chart, "legend") != Some(&Value::Bool(false)) || field(chart, "seriesNamesShown") == Some(&Value::Bool(true)) {
        return;
    }
    let names: Vec<String> = list(field(chart, "series"))
        .iter()
        .map(|series| trimmed(field(series, "name")))
        .filter(|name| length(name) > 1)
        .collect();
    if names.len() < 2 {
        return;
    }
    let words = slide
        .shapes
        .iter()
        .enumerate()
        .filter(|(other, _)| *other != at)
        .map(|(_, entry)| text(field(entry, "text")))
        .collect::<Vec<_>>()
        .join("\n");
    if names.iter().all(|name| words.contains(name.as_str())) {
        return;
    }
    issues.push(warn(
        "chart_series_unnamed",
        Some(slide.chart_path(shape, chart)),
        format!(
            "{} series ({}) are told apart by colour alone: the chart draws no legend, its labels carry no series name, and the page does not name them either.",
            names.len(),
            names.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
        ),
    ));
}

fn review_peer_type(slide: &Slide<'_>, issues: &mut Vec<Value>) {
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    for shape in &slide.shapes {
        let slot = text(field(shape, "slot"));
        let Some(role) = PEER_SLOT.captures(&slot).and_then(|found| found.get(1)).map(str::to_owned) else { continue };
        if !has_text(shape) {
            continue;
        }
        match groups.iter_mut().find(|group| group.0 == role) {
            Some(group) => group.1.push(*shape),
            None => groups.push((role, vec![*shape])),
        }
    }
    let path = slide.at();
    for (role, members) in &groups {
        if members.len() < 2 {
            continue;
        }
        // Peers in one row hold the same column: a 140 pt label beside a 665 pt lead line is a label and its sentence.
        let widths: Vec<f64> = members.iter().map(|shape| num0(field(shape, "width"))).collect();
        let narrowest = widths.iter().copied().fold(f64::INFINITY, f64::min);
        let widest = widths.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        if narrowest < widest * PEER_WIDTH_SHARE {
            continue;
        }
        let sizes: Vec<f64> = members.iter().map(|shape| num0(nested(shape, "font", "size"))).filter(|size| *size > 0.0).collect();
        let largest = sizes.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let smallest = sizes.iter().copied().fold(f64::INFINITY, f64::min);
        if sizes.len() == members.len() && largest > smallest * (1.0 + PEER_TYPE_TOLERANCE) {
            issues.push(warn(
                "peer_style_inconsistent",
                Some(path.clone()),
                format!("The {role} boxes are set at {} pt; peers in one row read as one set.", distinct_sorted(&sizes)),
            ));
            continue;
        }
        let mut faces: Vec<String> = Vec::new();
        for face in members.iter().flat_map(|shape| shape_faces(shape)) {
            if !faces.contains(&face) {
                faces.push(face);
            }
        }
        if faces.len() > 1 {
            issues.push(warn(
                "peer_style_inconsistent",
                Some(path.clone()),
                format!("The {role} boxes mix {}; peers in one row carry one face.", faces.join(", ")),
            ));
        }
    }
}

/// The type itself leads when the largest size runs a third past the median of the rest.
fn leads_by_type(sizes: &[f64]) -> bool {
    let mut ascending = sizes.to_vec();
    ascending.sort_by(f64::total_cmp);
    let largest = ascending[ascending.len() - 1];
    let rest = &ascending[..ascending.len() - 1];
    if rest.is_empty() {
        return true;
    }
    let median = if rest.len() % 2 == 1 { rest[(rest.len() - 1) / 2] } else { (rest[rest.len() / 2 - 1] + rest[rest.len() / 2]) / 2.0 };
    largest >= median * HIERARCHY_LEAD_RATIO
}

/// A chart, table, picture, or group carries the page instead of the words.
fn carries_the_page(shapes: &[&Value]) -> bool {
    shapes
        .iter()
        .any(|shape| is_truthy(field(shape, "chart")) || is_truthy(field(shape, "table")) || is_truthy(field(shape, "group")) || is_pptx_picture(shape))
}

fn review_hierarchy(slide: &Slide<'_>, issues: &mut Vec<Value>) {
    if carries_the_page(&slide.shapes) {
        return;
    }
    let text_shapes: Vec<&&Value> = slide.shapes.iter().filter(|shape| has_text(shape) && !is_motif_shape(shape)).collect();
    if text_shapes.len() < FLAT_PAGE_TEXT_BOXES {
        return;
    }
    if text_shapes.iter().any(|shape| field(shape, "slot") == Some(&Value::String("title".into()))) {
        return;
    }
    let sizes: Vec<f64> = text_shapes.iter().map(|shape| num0(nested(shape, "font", "size"))).filter(|size| *size > 0.0).collect();
    if sizes.len() != text_shapes.len() || leads_by_type(&sizes) {
        return;
    }
    issues.push(warn(
        "slide_hierarchy_flat",
        Some(slide.at()),
        format!(
            "The slide's {} text boxes are set at {} pt with none leading the others; the reader has no place to start.",
            text_shapes.len(),
            distinct_sorted(&sizes)
        ),
    ));
}

fn review_text_wall(slide: &Slide<'_>, width: f64, height: f64, issues: &mut Vec<Value>) {
    if width == 0.0 || height == 0.0 || carries_the_page(&slide.shapes) {
        return;
    }
    let mut chars = 0usize;
    let mut area = 0.0;
    for shape in &slide.shapes {
        let body = trimmed(field(shape, "text"));
        if body.is_empty() {
            continue;
        }
        chars += length(&body);
        area += f64::max(0.0, num0(field(shape, "width"))) * f64::max(0.0, num0(field(shape, "height")));
    }
    let coverage = area / f64::max(1.0, width * height);
    if chars <= TEXT_WALL_CHARS || coverage < TEXT_WALL_COVERAGE {
        return;
    }
    issues.push(warn(
        "slide_text_dense",
        Some(slide.at()),
        format!(
            "The slide carries {chars} characters over {}% of the canvas with no carrier; split it or cut it rather than projecting a document.",
            number_to_string(math::round(coverage * 100.0))
        ),
    ));
}

fn review_charts(slide: &Slide<'_>, issues: &mut Vec<Value>) {
    for (at, shape) in slide.shapes.iter().enumerate() {
        if let Some(chart) = field(shape, "chart").filter(|chart| is_truthy(Some(*chart)))
            && num(field(chart, "seriesCount")) == 0.0
        {
            issues.push(record(
                "empty_chart",
                Some(slide.chart_path(shape, chart)),
                "Chart has no persisted data series.".into(),
                "format-review",
                "error",
            ));
        }
        review_chart_series_naming(slide, at, issues);
    }
}

/// The floors by how the page is read.
struct Floors {
    body: f64,
    chrome: f64,
}

fn type_floors(document: &Value, height: f64) -> Floors {
    if is_truthy(field(document, "printSheet")) {
        return Floors { body: PRINT_BODY_MIN_PT, chrome: PRINT_CHROME_MIN_PT };
    }
    let scale = if height > 0.0 { f64::min(1.0, height / SLIDE_HEIGHT_PT) } else { 1.0 };
    let floor = |points: f64| math::round(points * scale * 2.0) / 2.0;
    Floors { body: floor(PPTX_BODY_MIN_PT), chrome: floor(PPTX_CHROME_MIN_PT) }
}

fn review_text_shape(slide: &Slide<'_>, shape: &Text<'_>, canvas: &Canvas, issues: &mut Vec<Value>, floors: &Floors) {
    let font_size = shape.font_size();
    let chrome = is_pptx_chrome_text(shape.shape);
    if font_size > 0.0 && font_size < floors.chrome {
        issues.push(warn("small_font", slide.path_of(shape.shape), format!("Text is smaller than {} pt.", number_to_string(floors.chrome))));
    } else if font_size > 0.0 && font_size < floors.body && !chrome {
        issues.push(warn("small_font", slide.path_of(shape.shape), format!("Body text is smaller than {} pt.", number_to_string(floors.body))));
    }
    let surface = containing_surface(shape, &slide.shapes);
    let background = solid_shape_fill(Some(shape.shape))
        .or_else(|| solid_shape_fill(surface))
        .or_else(|| nested(slide.value, "background", "color"));
    let contrast = color_contrast_ratio(nested(shape.shape, "font", "color"), background);
    // A table's words stand on its cells' fills, each read against its own. Read against the slide, a dark-headed
    // table's white header was reported as text indistinguishable from its surface.
    if !is_truthy(field(shape.shape, "table"))
        && let Some(ratio) = contrast
        && ratio < 1.8
    {
        let against = surface.map(|found| field(found, "path")).filter(|path| is_truthy(*path));
        issues.push(warn(
            "low_contrast",
            slide.path_of(shape.shape),
            format!(
                "Text contrast is {}:1 against {}; the text is visually indistinguishable from its surface.",
                math::to_fixed(ratio, 2),
                against.map_or_else(|| "the slide background".to_owned(), |path| text(path))
            ),
        ));
    }
    let margin = if chrome { PPTX_CHROME_EDGE_PT } else { PPTX_EDGE_PT };
    let frame = &shape.frame;
    if canvas.width > 0.0
        && canvas.height > 0.0
        && (frame.left < margin || frame.top < margin || frame.left + frame.width > canvas.width - margin || frame.top + frame.height > canvas.height - margin)
    {
        issues.push(warn(
            "edge_margin",
            slide.path_of(shape.shape),
            format!("Text is within {} pt of a slide edge.", number_to_string(margin)),
        ));
    }
}

/// What two text boxes do to each other (an overlap, a collision in the column they share, or a tight spacing), or
/// none when they sit apart.
fn text_pair_finding(left: &Text<'_>, right: &Text<'_>, labels: &str) -> Option<(&'static str, String)> {
    if overlap_ratio(&left.frame, &right.frame) >= 0.25 {
        return Some(("shape_overlap", format!("Text shapes {labels} overlap by at least 25%.")));
    }
    if is_page_number(left.shape) || is_page_number(right.shape) {
        return None;
    }
    let (l, r) = (&left.frame, &right.frame);
    let horizontal_overlap = f64::max(0.0, f64::min(l.left + l.width, r.left + r.width) - f64::max(l.left, r.left));
    let vertical_gap = f64::max(r.top - (l.top + l.height), l.top - (r.top + r.height));
    if horizontal_overlap < f64::min(l.width, r.width) * 0.3 {
        return None;
    }
    // A band laid across a column it does not belong to covers a small share of its own area, so the area rule above
    // passes it while the page shows two blocks running into each other. Where the boxes share a column, the reading is
    // the overlap itself: past the slack an auto-fitting box carries, the lines are in each other's space.
    if vertical_gap < -PPTX_TEXT_COLLISION_PT {
        return Some((
            "shape_overlap",
            format!(
                "Text shapes {labels} run into each other over {} pt of the column they share; the two blocks read as one.",
                number_to_string(math::round(-vertical_gap))
            ),
        ));
    }
    // A label and the line it names sit tight by design, so the pair is exempt from the spacing step, never from a
    // collision.
    if is_labelled_unit(left, right) {
        return None;
    }
    if (0.0..6.0).contains(&vertical_gap) {
        return Some(("text_spacing_tight", format!("Text shapes {labels} have less than 6 pt vertical spacing.")));
    }
    None
}

/// `${shape.index || position + 1}`.
fn index_label(shape: &Text<'_>, position: usize) -> String {
    let index = shape.index();
    if is_truthy(index) { text(index) } else { (position + 1).to_string() }
}

fn review_text_pairs(slide: &Slide<'_>, text_shapes: &[Text<'_>], issues: &mut Vec<Value>) {
    for left_at in 0..text_shapes.len() {
        for right_at in left_at + 1..text_shapes.len() {
            let (left, right) = (&text_shapes[left_at], &text_shapes[right_at]);
            let labels = format!("{} and {}", index_label(left, left_at), index_label(right, right_at));
            if let Some((code, message)) = text_pair_finding(left, right, &labels) {
                issues.push(warn(code, Some(slide.at()), message));
            }
        }
    }
}

/// A solid shape added after an evidence frame and drawn over it.
fn review_frame_cover(slide: &Slide<'_>, at: usize, area: f64, issues: &mut Vec<Value>) {
    let frame = slide.shapes[at];
    let frame_box = frame_of(frame);
    for (other, cover) in slide.shapes.iter().enumerate() {
        if other == at || !solid_fill_truthy(cover) {
            continue;
        }
        if !(num(field(cover, "index")) > num(field(frame, "index"))) || !has_frame(cover) {
            continue;
        }
        let share = intersection_area(&frame_box, &frame_of(cover)) / area;
        if share < 0.05 {
            continue;
        }
        let kind = if is_truthy(field(frame, "chart")) {
            "chart"
        } else if is_truthy(field(frame, "table")) {
            "table"
        } else {
            "picture"
        };
        issues.push(warn(
            "shape_overlap",
            Some(path_or_slide(slide, frame)),
            format!(
                "Shape {} is drawn over the {kind}, covering {}% of it; a band across the foot of a chart hides its category axis.",
                template_text(field(cover, "index")),
                number_to_string(math::round(share * 100.0))
            ),
        ));
        return;
    }
}

/// `shape.path || slideAt(slide)`.
fn path_or_slide(slide: &Slide<'_>, shape: &Value) -> String {
    let own = field(shape, "path");
    if is_truthy(own) { text(own) } else { slide.at() }
}

/// A text box over a table is never an annotation (a chart or a picture may carry one): a source line whose box starts
/// inside the table's last row is a table that ran into the foot, and the fill check sees only solid shapes.
fn review_table_text_cover(slide: &Slide<'_>, frame: &Value, text_shapes: &[Text<'_>], issues: &mut Vec<Value>) {
    let frame_box = frame_of(frame);
    for text_shape in text_shapes {
        // A snapshot lists the table's own cell text on the table shape; that is the frame, not a box over it.
        if is_truthy(field(text_shape.shape, "table"))
            || is_truthy(field(text_shape.shape, "chart"))
            || strict_equals(text_shape.index(), field(frame, "index"))
        {
            continue;
        }
        let text_area = text_shape.frame.width * text_shape.frame.height;
        if !(text_area > 0.0) {
            continue;
        }
        let share = intersection_area(&frame_box, &text_shape.frame) / text_area;
        if share < 0.2 {
            continue;
        }
        issues.push(warn(
            "shape_overlap",
            Some(path_or_slide(slide, frame)),
            format!(
                "Text shape {} runs into the table ({}% of the text box lies over it); move the text or give the table fewer rows.",
                template_text(text_shape.index()),
                number_to_string(math::round(share * 100.0))
            ),
        ));
        return;
    }
}

/// The evidence frames are compared with what is drawn over them. A takeaway band laid across the foot of a chart hides
/// the category axis, so the page shows three bars with no names.
fn review_evidence_cover(slide: &Slide<'_>, text_shapes: &[Text<'_>], issues: &mut Vec<Value>) {
    for (at, frame) in slide.shapes.iter().enumerate() {
        let evidence = ["chart", "table", "picture", "image"].iter().any(|key| is_truthy(field(frame, key)));
        if !evidence || !has_frame(frame) {
            continue;
        }
        let area = num(field(frame, "width")) * num(field(frame, "height"));
        if !(area > 0.0) {
            continue;
        }
        review_frame_cover(slide, at, area, issues);
        if is_truthy(field(frame, "table")) {
            review_table_text_cover(slide, frame, text_shapes, issues);
        }
    }
}

/// The words a later object covers are the defect a rendered page hides best: the box still measures as fitting and its
/// text still reads back from the file. A card drawn under its own text sits below it in z-order, so only an object
/// added after the text can hide it.
fn review_text_occlusion(slide: &Slide<'_>, text_shapes: &[Text<'_>], issues: &mut Vec<Value>) {
    for text_shape in text_shapes {
        let text_area = text_shape.frame.width * text_shape.frame.height;
        if !(text_area > 0.0) {
            continue;
        }
        for cover in &slide.shapes {
            // A halo is a radial wash that fades to nothing at its edge, so the words it reaches are still read. Only
            // an object that paints over them hides them.
            if is_motif_shape(cover) || is_halo_device(cover) || has_text(cover) {
                continue;
            }
            if !(num(field(cover, "index")) > num(text_shape.index())) {
                continue;
            }
            if !is_pptx_picture(cover) && !solid_fill_truthy(cover) {
                continue;
            }
            if !has_frame(cover) {
                continue;
            }
            let share = intersection_area(&text_shape.frame, &frame_of(cover)) / text_area;
            if share < TEXT_OCCLUSION_SHARE {
                continue;
            }
            issues.push(warn(
                "shape_overlap",
                Some(path_or_slide(slide, text_shape.shape)),
                format!(
                    "Shape {} is drawn over text shape {}, covering {}% of it; the words behind it are not read.",
                    template_text(field(cover, "index")),
                    template_text(text_shape.index()),
                    number_to_string(math::round(share * 100.0))
                ),
            ));
            break;
        }
    }
}

/// The depth past each edge the text crosses, measured on the side of the text inside the surface.
fn edge_crossings(t: &Frame, s: &Frame, across: f64, down: f64) -> Vec<(&'static str, f64, f64)> {
    let mut crossings = Vec::new();
    if across > 0.3 * t.width {
        if t.top < s.top && t.top + t.height > s.top && t.top + t.height <= s.top + s.height {
            crossings.push(("top", t.top + t.height - s.top, t.height));
        }
        if t.top + t.height > s.top + s.height && t.top < s.top + s.height && t.top >= s.top {
            crossings.push(("bottom", s.top + s.height - t.top, t.height));
        }
    }
    if down > 0.3 * t.height {
        if t.left < s.left && t.left + t.width > s.left && t.left + t.width <= s.left + s.width {
            crossings.push(("left", t.left + t.width - s.left, t.width));
        }
        if t.left + t.width > s.left + s.width && t.left < s.left + s.width && t.left >= s.left {
            crossings.push(("right", s.left + s.width - t.left, t.width));
        }
    }
    crossings
}

/// A text box that dips a sliver into a panel, band, or picture it does not sit in: a headline whose last line runs onto
/// the card under it reads as a collision, not a decision. Words wholly inside a surface are its label, wholly outside
/// are its neighbour, and a deep crossing is a deliberate overlay; only a shallow crossing of one edge (more than 2 pt,
/// less than half the text) is reported.
fn review_text_edge_crossing(slide: &Slide<'_>, text_shapes: &[Text<'_>], issues: &mut Vec<Value>) {
    for text_shape in text_shapes {
        if is_pptx_chrome_text(text_shape.shape) {
            continue;
        }
        let t = &text_shape.frame;
        if !(t.width > 0.0 && t.height > 0.0) {
            continue;
        }
        for surface in &slide.shapes {
            if is_motif_shape(surface) || has_text(surface) {
                continue;
            }
            if !is_pptx_picture(surface) && !solid_fill_truthy(surface) {
                continue;
            }
            // Only a surface drawn to its frame has the frame's edges: a disc, an arc or a chevron fills part of its
            // box, so text over a corner of that box sits beside the drawn shape.
            let geometry = field(surface, "geometry");
            if is_truthy(geometry) && !geometry.and_then(Value::as_str).is_some_and(|name| FRAME_EDGED_GEOMETRY.contains(&name)) {
                continue;
            }
            if !has_frame(surface) {
                continue;
            }
            let s = frame_of(surface);
            let across = f64::min(t.left + t.width, s.left + s.width) - f64::max(t.left, s.left);
            let down = f64::min(t.top + t.height, s.top + s.height) - f64::max(t.top, s.top);
            if across <= 0.0 || down <= 0.0 {
                continue;
            }
            let crossings = edge_crossings(t, &s, across, down);
            let Some((side, depth, _)) = crossings.iter().find(|(_, depth, size)| *depth > TEXT_EDGE_SLACK_PT && *depth < size / 2.0) else {
                continue;
            };
            issues.push(warn(
                "text_crosses_edge",
                Some(path_or_slide(slide, text_shape.shape)),
                format!(
                    "Text shape {} runs {} pt over the {side} edge of shape {}; move the text clear of the surface or set it inside.",
                    template_text(text_shape.index()),
                    number_to_string(math::round(*depth)),
                    template_text(field(surface, "index"))
                ),
            ));
            break;
        }
    }
}

fn review_number_sources(slide: &Slide<'_>, text_shapes: &[Text<'_>], issues: &mut Vec<Value>) {
    let all_text = text_shapes
        .iter()
        .map(|shape| match field(shape.shape, "text") {
            None | Some(Value::Null) => String::new(),
            Some(value) => value_to_string(value),
        })
        .collect::<Vec<_>>()
        .join(" ");
    if !ANY_DIGIT.is_match(&all_text) {
        return;
    }
    if CITED_SOURCE.is_match(&text(field(slide.value, "notes"))) {
        return;
    }
    issues.push(warn(
        "number_without_source",
        Some(slide.at()),
        "Slide contains numbers but its notes do not cite a workbook cell or source.".into(),
    ));
}

/// `reviewPptxStructure(document, auditProfile)`.
pub fn review_pptx_structure(document: &Value, audit_profile: &str) -> Vec<Value> {
    let mut issues = Vec::new();
    let canvas = Canvas { width: num0(field(document, "slideWidth")), height: num0(field(document, "slideHeight")) };
    let floors = type_floors(document, canvas.height);
    // A deck read from the file carries no slots; the roles come from the same induction the snapshot uses, and
    // annotating twice changes nothing.
    let has_slots = list(field(document, "slides"))
        .iter()
        .any(|slide| list(field(slide, "shapes")).iter().any(|shape| is_truthy(field(shape, "slot"))));
    let annotated;
    let document = if has_slots {
        document
    } else {
        let mut copy = document.clone();
        annotate_pptx_snapshot_roles(&mut copy);
        annotated = copy;
        &annotated
    };
    for source in list(field(document, "slides")) {
        // A hidden slide is not in the deck the reader receives.
        if field(source, "hidden") == Some(&Value::Bool(true)) {
            continue;
        }
        // A shape the slide hides is not on the page; measuring it reports defects no reader can see and sends the
        // next fix round after an invisible box.
        let slide = Slide {
            value: source,
            shapes: list(field(source, "shapes")).iter().filter(|shape| field(shape, "hidden") != Some(&Value::Bool(true))).collect(),
        };
        review_peer_type(&slide, &mut issues);
        review_text_wall(&slide, canvas.width, canvas.height, &mut issues);
        review_hierarchy(&slide, &mut issues);
        review_charts(&slide, &mut issues);
        let text_shapes = pptx_text_shapes(&slide);
        for shape in &text_shapes {
            review_text_shape(&slide, shape, &canvas, &mut issues, &floors);
        }
        review_text_pairs(&slide, &text_shapes, &mut issues);
        review_evidence_cover(&slide, &text_shapes, &mut issues);
        review_text_occlusion(&slide, &text_shapes, &mut issues);
        review_text_edge_crossing(&slide, &text_shapes, &mut issues);
        review_alignment(&slide, &mut issues, &canvas);
        if audit_profile == "model-backed-deck" {
            review_number_sources(&slide, &text_shapes, &mut issues);
        }
    }
    issues
}

/// `type-floors.test.mjs`: the floors a slide, a shorter canvas and a printed sheet are held to.
#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::super::review_office_structure;

    /// One slide with a two-line body paragraph at `size` pt and a one-line source note at `note` pt.
    fn deck(width: f64, height: f64, size: f64, note: f64, print_sheet: bool) -> Value {
        let mut document = json!({
            "slideWidth": width,
            "slideHeight": height,
            "slides": [{
                "path": "/slide[1]",
                "index": 1,
                "notes": "",
                "shapes": [
                    {
                        "path": "/slide[1]/shape[1]",
                        "index": 1,
                        "text": "본문 문단의 첫째 줄입니다.\n둘째 줄도 본문입니다.",
                        "left": 40,
                        "top": 60,
                        "width": 400,
                        "height": 60,
                        "font": { "size": size }
                    },
                    {
                        "path": "/slide[1]/shape[2]",
                        "index": 2,
                        "text": "출처: 운영 시스템",
                        "left": 40,
                        "top": height - 80.0,
                        "width": 300,
                        "height": 16,
                        "font": { "size": note }
                    }
                ]
            }]
        });
        if print_sheet {
            document["printSheet"] = json!(true);
        }
        document
    }

    fn small(document: &Value) -> Vec<String> {
        review_office_structure(Some("pptx"), document, "")
            .iter()
            .filter(|entry| entry["code"] == "small_font")
            .map(|entry| entry["path"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    const BOTH: [&str; 2] = ["/slide[1]/shape[1]", "/slide[1]/shape[2]"];

    #[test]
    fn a_four_by_three_slide_keeps_the_wide_deck_floors() {
        assert_eq!(small(&deck(960.0, 540.0, 11.0, 8.5, false)), BOTH);
        assert_eq!(small(&deck(720.0, 540.0, 11.0, 8.5, false)), BOTH, "4:3 body under 12 pt is small");
        assert!(small(&deck(720.0, 540.0, 12.0, 9.0, false)).is_empty());
    }

    #[test]
    fn a_shorter_canvas_scales_its_floors_with_its_height() {
        // 10 x 5.625 in (720 x 405 pt): 12 pt and 9 pt read as 9 pt and 7 pt.
        assert!(small(&deck(720.0, 405.0, 9.0, 7.0, false)).is_empty());
        assert_eq!(small(&deck(720.0, 405.0, 8.5, 6.5, false)), BOTH);
    }

    #[test]
    fn a_printed_sheet_is_held_to_the_print_floors_whatever_its_size() {
        assert!(small(&deck(595.0, 842.0, 9.5, 7.5, true)).is_empty());
        assert_eq!(small(&deck(595.0, 842.0, 8.5, 6.5, true)), BOTH);
        // The same A4 page as a slide would hold 12 pt body: the medium decides, not the page's width.
        assert_eq!(small(&deck(595.0, 842.0, 9.5, 7.5, false)), BOTH);
    }
}
