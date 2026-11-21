//! The HTML authoring path, second half (`authoring/pptx-html-build.mjs`): what `measure_deck` read from the browser
//! becomes a deck of native PowerPoint objects on the pptx writer: text boxes that keep the browser's line breaks (and
//! put the first baseline where the browser drew it, per face), shapes, lines, tables, native charts and pictures, on
//! the 13.333 x 7.5 in wide layout, or on the sheet the measure names.
//!
//! The items are the JSON `measure_deck` hands over (`{ kind: 'rect' | 'line' | 'text' | 'table' | 'chart' | 'svg' |
//! 'image' | 'capture', ... }`); they are read as they are, so a measure recorded by Node builds the same deck. The
//! pictures are drawn here: an SVG rasterised at 2.5 times its box (`mixdog_raster::svg`), a picture cropped to its CSS
//! `object-fit: cover` at its `object-position` and rounded to its corner radius, a captured decoration cut at the page
//! edge, and the mean colour of a capture sampled to name a drawing or to put a native fill under its words.

use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::GeneralPurpose;
use base64::engine::GeneralPurposeConfig;
use base64::engine::general_purpose::STANDARD;
use mixdog_js::math::round as js_round;
use mixdog_js::to_number_of;
use mixdog_office_base::values::truthy;
use mixdog_raster::Blend;
use mixdog_raster::Fit;
use mixdog_raster::Image;
use mixdog_raster::Overlay;
use mixdog_raster::Placement;
use mixdog_raster::ResizeOptions;
use mixdog_raster::composite;
use mixdog_raster::ops;
use mixdog_raster::svg;
use mixdog_raster::svg::SvgFonts;
use serde_json::Value;

use crate::link_target::safe_link;
use crate::measure_deck::Canvas;
use crate::pptx_writer::AxisStyle;
use crate::pptx_writer::Background;
use crate::pptx_writer::Border;
use crate::pptx_writer::Borders;
use crate::pptx_writer::ChartData;
use crate::pptx_writer::ChartKind;
use crate::pptx_writer::ChartLayout;
use crate::pptx_writer::ChartOptions;
use crate::pptx_writer::ColWidths;
use crate::pptx_writer::Dim;
use crate::pptx_writer::Fill;
use crate::pptx_writer::GridLine;
use crate::pptx_writer::Hyperlink;
use crate::pptx_writer::ImageOptions;
use crate::pptx_writer::Line;
use crate::pptx_writer::Margin;
use crate::pptx_writer::Presentation;
use crate::pptx_writer::RowHeights;
use crate::pptx_writer::Shadow;
use crate::pptx_writer::ShapeOptions;
use crate::pptx_writer::Slide;
use crate::pptx_writer::TableCell;
use crate::pptx_writer::TableOptions;
use crate::pptx_writer::TextContent;
use crate::pptx_writer::TextOptions;
use crate::pptx_writer::TextRun;

/// PowerPoint's single line pitch, in em.
const PITCH: f64 = 1.2;
/// The browser's baseline within a glyph box (ascent over ascent + descent) of Noto Sans KR, Noto Serif KR and the rest.
const DEFAULT_ASCENT: f64 = 0.801;
/// The same for Malgun Gothic.
const MALGUN_ASCENT: f64 = 0.815;
/// Em a middle-anchored single line sits above the browser's centre.
const MIDDLE_LIFT: f64 = 0.09;
/// Px: text slack never carries a box past this margin.
const EDGE: f64 = 24.0;
/// The deck canvas lands on the 13.333 in wide layout; a measured sheet carries its own inches.
const WIDE_INCHES: f64 = 13.333;
/// The scale an SVG drawing is rasterised at.
const SVG_SCALE: f64 = 2.5;
/// The scale a picture is cut at.
const IMAGE_SCALE: f64 = 2.0;
/// A drawing that leaves most of its frame clear is named as a motif: it is opaque over less than this share.
const DRAWING_OPAQUE_SHARE: f64 = 0.6;
/// The name of such a drawing.
const MOTIF_NAME: &str = "Mixdog Motif drawing";

/// The first baseline's depth under the content top, in em, measured on PowerPoint renders of Noto Sans KR, its
/// ExtraBold, Noto Serif KR and Malgun Gothic from 20 to 330 px at line heights 0.9-1.5: one line up to 100 % spacing
/// (the written percentage, so exactly 100 % counts), another above it, and slower under 83 % (a display line set
/// tighter than 1.0).
fn first_baseline(spacing: f64) -> f64 {
    if js_round(spacing * 100_000.0) > 100_000.0 {
        return 0.93 * spacing - 0.03;
    }
    if spacing < 0.833 { 0.86 * spacing + 0.028 } else { 1.23 * spacing - 0.28 }
}

/// The first baseline of a middle-anchored block, in em.
fn middle_baseline(spacing: f64) -> f64 {
    1.02 * spacing - 0.09
}

fn number(value: &Value, key: &str) -> f64 {
    to_number_of(value.get(key))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn has(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(truthy)
}

/// A field that is an object (the JavaScript `item.frame`, `item.stroke`): null and absent are `None`.
fn object<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|inner| inner.is_object())
}

/// `item.radius` of a box: absent is 0.
fn radius_of(value: &Value) -> f64 {
    value.get("radius").map_or(0.0, |radius| if radius.is_null() { 0.0 } else { to_number_of(Some(radius)) })
}

fn hex(colour: &Value) -> String {
    text(colour, "hex").to_owned()
}

/// `item.alt || fallback`.
fn alt_or<'a>(item: &'a Value, fallback: &'a str) -> &'a str {
    let alt = text(item, "alt");
    if alt.is_empty() { fallback } else { alt }
}

/// A box in canvas px.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Bounds {
    fn of(value: &Value) -> Self {
        Self { x: number(value, "x"), y: number(value, "y"), w: number(value, "w"), h: number(value, "h") }
    }
}

/// The page the measure names: its inches, or the wide layout's.
fn page_inches(canvas: Canvas) -> (f64, f64) {
    let width = if canvas.inch_width != 0.0 && !canvas.inch_width.is_nan() { canvas.inch_width } else { WIDE_INCHES };
    let height = if canvas.inch_height != 0.0 && !canvas.inch_height.is_nan() {
        canvas.inch_height
    } else {
        WIDE_INCHES * (if canvas.height == 0 { 1080.0 } else { f64::from(canvas.height) }) / f64::from(canvas.width)
    };
    (width, height)
}

/// Inches per CSS px, points per CSS px, and the canvas size.
#[derive(Clone, Copy, Debug)]
struct Units {
    k: f64,
    pt: f64,
    w: f64,
    h: f64,
}

impl Units {
    fn of(canvas: Canvas) -> Self {
        let inches = page_inches(canvas).0;
        let width = f64::from(canvas.width);
        Self {
            k: inches / width,
            pt: 0.5 * (1920.0 / width) * (inches / WIDE_INCHES),
            w: width,
            h: if canvas.height == 0 { 1080.0 } else { f64::from(canvas.height) },
        }
    }

    fn inch(&self, value: f64) -> f64 {
        value * self.k
    }

    fn dim(&self, value: f64) -> Option<Dim> {
        Some(Dim::Number(self.inch(value)))
    }
}

/// The page clips what runs past it (`section.slide` is `overflow: hidden`); PowerPoint would keep the part past the
/// edge in the editing view. A box is cut to the canvas, and `None` when nothing of it is on the page.
fn on_canvas(bounds: Bounds, u: &Units) -> Option<Bounds> {
    let x0 = bounds.x.max(0.0);
    let y0 = bounds.y.max(0.0);
    let x1 = u.w.min(bounds.x + bounds.w);
    let y1 = u.h.min(bounds.y + bounds.h);
    if x1 - x0 < 0.5 || y1 - y0 < 0.5 { None } else { Some(Bounds { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }) }
}

/// A picture rendered for `bounds` keeps only the pixels on the page, placed at the part of the box that is.
fn crop_to_canvas(image: Image, bounds: Bounds, u: &Units) -> Result<Option<(Image, Bounds)>, String> {
    let Some(visible) = on_canvas(bounds, u) else { return Ok(None) };
    if visible.w == bounds.w && visible.h == bounds.h {
        return Ok(Some((image, bounds)));
    }
    let (width, height) = (f64::from(image.width()), f64::from(image.height()));
    let sx = width / bounds.w;
    let sy = height / bounds.h;
    let left = (width - 1.0).min(js_round((visible.x - bounds.x) * sx).max(0.0));
    let top = (height - 1.0).min(js_round((visible.y - bounds.y) * sy).max(0.0));
    let w = (width - left).min(js_round(visible.w * sx)).max(1.0);
    let h = (height - top).min(js_round(visible.h * sy)).max(1.0);
    let cut = ops::extract(&image, left as u32, top as u32, w as u32, h as u32).map_err(|error| error.to_string())?;
    Ok(Some((cut, visible)))
}

fn transparency(colour: &Value) -> f64 {
    let alpha = number(colour, "a");
    if alpha < 1.0 { js_round((1.0 - alpha) * 100.0) } else { 0.0 }
}

fn fill_of(colour: Option<&Value>) -> Fill {
    match colour.filter(|colour| truthy(colour)) {
        Some(colour) => Fill { color: Some(hex(colour)), transparency: Some(transparency(colour)), ..Fill::default() },
        None => Fill::none(),
    }
}

/// The shape of a box: an ellipse for a full radius on a square, a rounded rectangle for a radius, else a rectangle.
struct Geometry {
    shape: &'static str,
    rect_radius: Option<f64>,
}

fn geometry(u: &Units, bounds: Bounds, radius: f64) -> Geometry {
    let short = bounds.w.min(bounds.h);
    if radius >= short / 2.0 - 0.5 && (bounds.w - bounds.h).abs() < 1.0 {
        return Geometry { shape: "ellipse", rect_radius: None };
    }
    if radius > 0.5 {
        return Geometry { shape: "roundRect", rect_radius: Some(u.inch(radius.min(short / 2.0))) };
    }
    Geometry { shape: "rect", rect_radius: None }
}

/// One CSS box-shadow as PowerPoint's outer shadow. A blur of 0 reads as unset (8 pt), so a hard shadow carries a blur
/// just above zero.
fn shadow_of(shadow: Option<&Value>, pt: f64) -> Option<Shadow> {
    let shadow = shadow.filter(|shadow| object(shadow, "color").is_some_and(truthy))?;
    let colour = shadow.get("color")?;
    let (x, y) = (number(shadow, "x"), number(shadow, "y"));
    Some(Shadow {
        kind: Some("outer".to_owned()),
        color: Some(hex(colour)),
        opacity: Some(number(colour, "a")),
        blur: Some((number(shadow, "blur") * pt).max(0.01)),
        offset: Some(x.hypot(y) * pt),
        angle: Some(js_round(y.atan2(x) * 180.0 / std::f64::consts::PI)),
        ..Shadow::default()
    })
}

/// CSS paints a border inside the box; PowerPoint strokes the outline on its centre. The outline shape stands half a
/// stroke inside the CSS box so both reach the same outer edge.
fn stroke_inset(bounds: Bounds, stroke: Option<&Value>, radius: f64) -> (Bounds, f64) {
    let half = stroke.map_or(0.0, |stroke| number(stroke, "w") / 2.0);
    if half == 0.0 || half.is_nan() {
        return (bounds, radius);
    }
    (Bounds { x: bounds.x + half, y: bounds.y + half, w: (bounds.w - 2.0 * half).max(1.0), h: (bounds.h - 2.0 * half).max(1.0) }, (radius - half).max(0.0))
}

fn add_rect(slide: &mut Slide, u: &Units, item: &Value) -> Result<(), String> {
    // A plain square fill is cut at the page edge (a rounded or outlined one past the edge is captured).
    let stroke = object(item, "stroke");
    let rounded = radius_of(item) > 0.5;
    let plain = stroke.is_none() && !rounded && !has(item, "rotate");
    let measured = Bounds::of(&item["box"]);
    let bounds = if plain {
        match on_canvas(measured, u) {
            Some(visible) => visible,
            None => return Ok(()),
        }
    } else {
        measured
    };
    let (b, radius) = stroke_inset(bounds, stroke, radius_of(item));
    let g = geometry(u, b, radius);
    let mut frame = ShapeOptions {
        x: u.dim(b.x),
        y: u.dim(b.y),
        w: u.dim(b.w),
        h: u.dim(b.h),
        fill: Some(fill_of(item.get("fill"))),
        line: Some(line_of(stroke, u.pt)),
        rect_radius: g.rect_radius,
        shadow: shadow_of(item.get("shadow"), u.pt),
        ..ShapeOptions::default()
    };
    if has(item, "rotate") {
        frame.rotate = Some(js_round(number(item, "rotate") * 100.0) / 100.0);
    }
    slide.add_shape(g.shape, frame)
}

fn line_of(stroke: Option<&Value>, pt: f64) -> Line {
    match stroke {
        Some(stroke) => Line { color: Some(hex(stroke)), width: Some(number(stroke, "w") * pt), ..Line::default() },
        None => Line::none(),
    }
}

fn add_line(slide: &mut Slide, u: &Units, item: &Value) -> Result<(), String> {
    // Border sides are level or upright, so the page edge cuts them by clamping.
    let clamp = |value: f64, max: f64| max.min(value.max(0.0));
    let seg = |at: usize| to_number_of(item["seg"].get(at));
    let (x1, y1, x2, y2) = (clamp(seg(0), u.w), clamp(seg(1), u.h), clamp(seg(2), u.w), clamp(seg(3), u.h));
    if (x2 - x1).hypot(y2 - y1) < 0.5 {
        return Ok(());
    }
    let colour = &item["color"];
    slide.add_shape(
        "line",
        ShapeOptions {
            x: u.dim(x1.min(x2)),
            y: u.dim(y1.min(y2)),
            w: u.dim((x2 - x1).abs()),
            h: u.dim((y2 - y1).abs()),
            line: Some(Line { color: Some(hex(colour)), width: Some(number(item, "w") * u.pt), transparency: Some(transparency(colour)), ..Line::default() }),
            ..ShapeOptions::default()
        },
    )
}

/// Where a text item sits and how PowerPoint must set it so the glyphs land where the browser drew them.
#[derive(Clone, Debug, PartialEq)]
pub struct TextPlacement {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub inset: Inset,
    pub valign: &'static str,
    /// A chip its one line fills (a pill label) centres, so PowerPoint's wider or narrower glyphs keep its padding
    /// even; a wider band keeps the alignment the browser used.
    pub center_align: bool,
    pub wrap: bool,
    pub spacing: f64,
}

/// The four insets of a text item, in px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Inset {
    pub l: f64,
    pub r: f64,
    pub t: f64,
    pub b: f64,
}

fn ascent_of(item: &Value) -> f64 {
    match item["lines"][0]["runs"][0]["style"]["font"].as_str() {
        Some("Malgun Gothic" | "맑은 고딕") => MALGUN_ASCENT,
        _ => DEFAULT_ASCENT,
    }
}

/// The horizontal extent of a text box: the browser's box widened (a framed one eats its insets instead) until its ink
/// fits with a little room so PowerPoint's metrics add no break of their own, and held inside the page margin.
fn fit_width(item: &Value, b: &Bounds, ins: &mut Inset, single: bool, framed: bool, canvas_width: f64) -> (f64, f64) {
    let (mut x, mut w) = (b.x, b.w);
    let align = text(item, "align");
    let extra = number(item, "inkW") * (if single { 1.05 } else { 1.04 }) + 4.0 - (b.w - ins.l - ins.r);
    if extra > 0.0 {
        if framed {
            let d = extra / 2.0;
            ins.l = (ins.l - d).max(0.0);
            ins.r = (ins.r - d).max(0.0);
        } else if align == "center" {
            x -= extra / 2.0;
            w += extra;
        } else if align == "right" {
            x -= extra;
            w += extra;
        } else {
            w += extra;
        }
    }
    let left = x.max(b.x.min(EDGE));
    w -= left - x;
    x = left;
    w = w.min((b.x + b.w).max(canvas_width - EDGE) - x);
    (x, w)
}

/// `textPlacement(item, canvasWidth)`.
pub fn text_placement(item: &Value, canvas_width: f64) -> Result<TextPlacement, String> {
    let lines = item["lines"].as_array().map_or(&[][..], Vec::as_slice);
    if lines.is_empty() {
        return Err("Cannot read properties of undefined (reading 'top')".to_owned());
    }
    let single = lines.len() == 1;
    let b = Bounds::of(&item["box"]);
    let inset = &item["inset"];
    let mut ins = Inset { l: number(inset, "l"), r: number(inset, "r"), t: number(inset, "t"), b: number(inset, "b") };
    let (mut y, mut h) = (b.y, b.h);
    let framed = object(item, "frame").is_some();
    let ink_w = number(item, "inkW");
    let font_size = number(item, "fontSize");
    let line_height = number(item, "lineHeight");
    let (x, w) = fit_width(item, &b, &mut ins, single, framed, canvas_width);
    let content_top = b.y + ins.t;
    let content_height = b.h - ins.t - ins.b;
    let first = &lines[0];
    let text_top = number(first, "top");
    let text_bottom = number(&lines[lines.len() - 1], "bottom");
    let chip = framed && content_height <= line_height * lines.len() as f64 * 1.25;
    // Text the browser laid out on its frame's middle (a disc, a stamp, a centred label) keeps PowerPoint's middle
    // anchor, whatever its padding. Unframed text is always placed by its baseline.
    let centred = framed
        && ((text_top + text_bottom) / 2.0 - (content_top + content_height / 2.0)).abs() < 4.0_f64.max(content_height * 0.05)
        && content_height > text_bottom - text_top + 2.0;
    let middle = chip || centred;
    // Line spacing: the pitch matches when the multiple is the browser's line height over PowerPoint's single pitch.
    // The first baseline does not follow the browser's half-leading: PowerPoint sets it first_baseline(spacing) em
    // under the content top, so a top-anchored block is placed by baseline.
    let pitch = font_size * PITCH;
    let mut spacing = line_height / pitch;
    let mut top_inset = ins.t;
    if middle {
        ins.t = 0.0;
        ins.b = 0.0;
        top_inset = 0.0;
        if single {
            spacing = 1.0;
            // PowerPoint centres a single line MIDDLE_LIFT em above where the browser centres it.
            top_inset = 2.0 * MIDDLE_LIFT * font_size;
        } else {
            // A centred block: PowerPoint's first baseline lands middle_baseline(spacing) em under the block's nominal
            // top; the inset moves the middle anchor by half of itself.
            let glyph = number(first, "bottom") - number(first, "top");
            let browser = (line_height - glyph) / 2.0 + ascent_of(item) * glyph;
            let delta = middle_baseline(spacing) * font_size - browser;
            if delta < 0.0 {
                top_inset = -2.0 * delta;
            } else {
                ins.b = 2.0 * delta;
            }
        }
    } else {
        let baseline = number(first, "top") + ascent_of(item) * (number(first, "bottom") - number(first, "top"));
        let offset = first_baseline(spacing) * font_size;
        if framed {
            top_inset = (baseline - b.y - offset).max(0.0);
        } else {
            let top = baseline - ins.t - offset;
            // PowerPoint's content is lines x the browser's line height at this multiple, tighter lines included; it
            // reads its text bounds about 0.035 em taller than that, so the box keeps 0.05 em of slack.
            h = (h + y - top).max(ins.t + ins.b + lines.len() as f64 * line_height + 0.05 * font_size);
            y = top;
        }
    }
    let original = Inset { l: number(inset, "l"), r: number(inset, "r"), t: 0.0, b: 0.0 };
    Ok(TextPlacement {
        x,
        y: if framed { b.y } else { y },
        w,
        h,
        inset: Inset { t: top_inset, ..ins },
        valign: if middle { "middle" } else { "top" },
        center_align: chip && single && b.w - original.l - original.r - ink_w < 4.0,
        wrap: !single,
        spacing,
    })
}

/// The hyperlink of a run, when its `href` is a target a document may carry; a rejected one leaves plain text.
fn link_of(run: &Value) -> Option<Hyperlink> {
    safe_link(text(run, "href")).map(|url| Hyperlink { url: Some(url), ..Hyperlink::default() })
}

fn text_runs(u: &Units, item: &Value) -> Vec<TextRun> {
    let mut runs = Vec::new();
    for (li, line) in item["lines"].as_array().map_or(&[][..], Vec::as_slice).iter().enumerate() {
        for (ri, run) in line["runs"].as_array().map_or(&[][..], Vec::as_slice).iter().enumerate() {
            let style = &run["style"];
            let colour = &style["color"];
            runs.push(TextRun {
                text: text(run, "text").to_owned(),
                options: Some(TextOptions {
                    font_face: Some(text(style, "font").to_owned()),
                    font_size: Some(number(style, "size") * u.pt),
                    bold: has(style, "bold"),
                    italic: has(style, "italic"),
                    color: Some(hex(colour)),
                    transparency: (number(colour, "a") < 1.0).then(|| transparency(colour)),
                    char_spacing: Some(number(style, "ls") * u.pt),
                    highlight: style.get("hl").and_then(Value::as_str).filter(|hl| !hl.is_empty()).map(str::to_owned),
                    soft_break_before: li > 0 && ri == 0,
                    frame: ShapeOptions { hyperlink: link_of(style), ..ShapeOptions::default() },
                    ..TextOptions::default()
                }),
            });
        }
    }
    runs
}

fn add_text(slide: &mut Slide, u: &Units, item: &Value, canvas_width: f64) -> Result<(), String> {
    let runs = text_runs(u, item);
    let place = text_placement(item, canvas_width)?;
    let frame = object(item, "frame");
    // A framed box's outline stands half its stroke inside, and its words keep their place.
    let stroke = frame.and_then(|frame| object(frame, "stroke"));
    let half = stroke.map_or(0.0, |stroke| number(stroke, "w") / 2.0);
    let framed = frame.map(|frame| stroke_inset(Bounds::of(&item["box"]), stroke, radius_of(frame)));
    let g = framed.map(|(bounds, radius)| geometry(u, bounds, radius));
    // A rounded rectangle's own text rectangle already stands 0.29289 of its corner radius inside the shape.
    let corner = match (&g, framed) {
        (Some(g), Some((bounds, radius))) if g.shape == "roundRect" => 0.29289 * radius.min(bounds.w.min(bounds.h) / 2.0),
        _ => 0.0,
    };
    let margin = |value: f64| (value - corner - half).max(0.0) * u.pt;
    let ellipse = g.as_ref().is_some_and(|g| g.shape == "ellipse");
    let mut frame_options = ShapeOptions {
        x: u.dim(place.x + half),
        y: u.dim(place.y + half),
        w: u.dim((place.w - 2.0 * half).max(1.0)),
        h: u.dim((place.h - 2.0 * half).max(1.0)),
        ..ShapeOptions::default()
    };
    if has(item, "rotate") {
        frame_options.rotate = Some(js_round(number(item, "rotate") * 100.0) / 100.0);
    }
    if let (Some(frame), Some(g)) = (frame, &g) {
        frame_options.fill = Some(fill_of(frame.get("fill")));
        frame_options.line = Some(line_of(stroke, u.pt));
        frame_options.shadow = shadow_of(frame.get("shadow"), u.pt);
        frame_options.rect_radius = g.rect_radius;
    }
    let options = TextOptions {
        frame: frame_options,
        shape: g.as_ref().map(|g| g.shape.to_owned()),
        margin: Some(Margin::Each(vec![margin(place.inset.l), margin(place.inset.r), margin(place.inset.b), margin(place.inset.t)])),
        valign: Some(place.valign.to_owned()),
        align: Some(if place.center_align || ellipse { "center".to_owned() } else { text(item, "align").to_owned() }),
        wrap: Some(place.wrap),
        line_spacing_multiple: Some(place.spacing),
        ..TextOptions::default()
    };
    slide.add_text(TextContent::Runs(runs), Some(options))
}

fn table_cell(u: &Units, cell: &Value) -> TableCell {
    let edge = |edge: Option<&Value>| match edge.filter(|edge| truthy(edge)) {
        Some(edge) => Border { kind: Some("solid".to_owned()), pt: Some(number(edge, "w") * u.pt), color: Some(text(edge, "c").to_owned()) },
        None => Border { kind: Some("none".to_owned()), ..Border::default() },
    };
    let pad = &cell["pad"];
    let border = &cell["border"];
    let fill = cell.get("fill").filter(|fill| fill.is_object()).map(hex).filter(|hex| !hex.is_empty()).unwrap_or_else(|| "FFFFFF".to_owned());
    let span = number(cell, "span");
    let linked = cell.get("runs").and_then(Value::as_array).filter(|runs| !runs.is_empty());
    TableCell::Cell {
        text: match linked {
            Some(runs) => TextContent::Runs(
                runs.iter()
                    .map(|run| TextRun {
                        text: text(run, "text").to_owned(),
                        options: Some(TextOptions {
                            frame: ShapeOptions { hyperlink: link_of(run), ..ShapeOptions::default() },
                            font_face: Some(text(cell, "font").to_owned()),
                            font_size: Some(number(cell, "size") * u.pt),
                            bold: has(cell, "bold"),
                            color: Some(hex(&cell["color"])),
                            align: Some(text(cell, "align").to_owned()),
                            ..TextOptions::default()
                        }),
                    })
                    .collect(),
            ),
            None => TextContent::Plain(text(cell, "text").to_owned()),
        },
        options: Some(TextOptions {
            frame: ShapeOptions { fill: Some(Fill::color(&fill)), ..ShapeOptions::default() },
            font_face: Some(text(cell, "font").to_owned()),
            font_size: Some(number(cell, "size") * u.pt),
            bold: has(cell, "bold"),
            color: Some(hex(&cell["color"])),
            align: Some(text(cell, "align").to_owned()),
            valign: Some("middle".to_owned()),
            margin: Some(Margin::Each(vec![u.inch(number(pad, "t")), u.inch(number(pad, "r")), u.inch(number(pad, "b")), u.inch(number(pad, "l"))])),
            border: Some(Borders::Each(vec![
                Some(edge(border.get("t"))),
                Some(edge(border.get("r"))),
                Some(edge(border.get("b"))),
                Some(edge(border.get("l"))),
            ])),
            colspan: (span > 1.0).then_some(span as usize),
            ..TextOptions::default()
        }),
    }
}

fn add_table(slide: &mut Slide, u: &Units, item: &Value) -> Result<(), String> {
    let source = item["rows"].as_array().map_or(&[][..], Vec::as_slice);
    let rows: Vec<Vec<TableCell>> =
        source.iter().map(|row| row.as_array().map_or(&[][..], Vec::as_slice).iter().map(|cell| table_cell(u, cell)).collect()).collect();
    let mut widest: &[Value] = source.first().and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    for row in source {
        let row = row.as_array().map_or(&[][..], Vec::as_slice);
        if row.len() > widest.len() {
            widest = row;
        }
    }
    let heights: Vec<f64> = source
        .iter()
        .map(|row| row.get(0).map(|cell| u.inch(number(&cell["box"], "h"))).ok_or_else(|| "Cannot read properties of undefined (reading 'box')".to_owned()))
        .collect::<Result<_, _>>()?;
    let b = &item["box"];
    // The frame carries the whole table height: a frame sized to its first row reads as a hollow band to every
    // geometry check below it.
    let total = heights.iter().fold(0.0, |sum, value| sum + value);
    slide.add_table(
        rows,
        TableOptions {
            text: TextOptions {
                frame: ShapeOptions {
                    x: u.dim(number(b, "x")),
                    y: u.dim(number(b, "y")),
                    w: u.dim(number(b, "w")),
                    h: Some(Dim::Number(total)),
                    ..ShapeOptions::default()
                },
                ..TextOptions::default()
            },
            col_w: Some(ColWidths::Each(widest.iter().map(|cell| u.inch(number(&cell["box"], "w"))).collect())),
            row_h: Some(RowHeights::Each(heights)),
            auto_page: false,
        },
    )
}

/// `Number(value) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = to_number_of(value);
    if number == 0.0 || number.is_nan() { fallback } else { number }
}

/// `String(value)` of a chart label or series name.
fn label_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Number(number) => mixdog_js::number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        other => other.to_string(),
    }
}

/// The values of a series: a value that is not a number is an empty point; a series with no values at all is what
/// pptxgenjs cannot write.
fn chart_values(values: Option<&Value>) -> Result<Vec<Option<f64>>, String> {
    let list = values.and_then(Value::as_array).ok_or_else(|| "Cannot read properties of undefined (reading 'length')".to_owned())?;
    Ok(list
        .iter()
        .map(|value| match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => Some(mixdog_js::string_to_number(text)).filter(|parsed| !parsed.is_nan()),
            _ => None,
        })
        .collect())
}

fn chart_kind(spec_type: &str) -> ChartKind {
    match spec_type.to_lowercase().as_str() {
        "line" => ChartKind::Line,
        "area" => ChartKind::Area,
        "pie" => ChartKind::Pie,
        "doughnut" => ChartKind::Doughnut,
        _ => ChartKind::Bar,
    }
}

/// `spec.key || fallback` for a string.
fn spec_text<'a>(spec: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    match spec.get(key).and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value,
        _ => fallback,
    }
}

/// The series of a spec: its `series` list, or the one series its own `values` make; a chart whose values cannot be read
/// is counted as failed.
fn chart_series(pres: &mut Presentation, spec: &Value, labels: &[String]) -> Result<Vec<ChartData>, String> {
    match spec.get("series").and_then(Value::as_array) {
        Some(series) => series
            .iter()
            .map(|series| {
                Ok(ChartData {
                    name: label_text(&series["name"]),
                    labels: vec![labels.to_vec()],
                    values: chart_values(series.get("values")).inspect_err(|_| pres.count_failed_chart())?,
                })
            })
            .collect(),
        None => {
            let name =
                ["name", "unit"].iter().find_map(|key| spec.get(key).filter(|value| truthy(value)).map(label_text)).unwrap_or_else(|| "Value".to_owned());
            Ok(vec![ChartData { name, labels: vec![labels.to_vec()], values: chart_values(spec.get("values")).inspect_err(|_| pres.count_failed_chart())? }])
        }
    }
}

/// A `data-chart` spec as a native, editable chart.
fn add_chart(pres: &mut Presentation, index: usize, u: &Units, item: &Value) -> Result<(), String> {
    let b = Bounds::of(&item["box"]);
    let empty = Value::Object(serde_json::Map::new());
    let spec = object(item, "spec").unwrap_or(&empty);
    let spec_type = match spec.get("type") {
        Some(value) if truthy(value) => label_text(value),
        _ => "bar".to_owned(),
    };
    let kind = chart_kind(&spec_type);
    let labels: Vec<String> = spec.get("labels").and_then(Value::as_array).map(|list| list.iter().map(label_text).collect()).unwrap_or_default();
    let data = chart_series(pres, spec, &labels)?;
    let ink = spec_text(spec, "labelColor", "333333");
    let item_font = text(item, "font");
    let font = spec_text(spec, "font", if item_font.is_empty() { "Noto Sans KR" } else { item_font });
    let size = number_or(spec.get("size"), 12.0);
    let round = matches!(kind, ChartKind::Pie | ChartKind::Doughnut);
    let lowered = spec_type.to_lowercase();
    let column = lowered == "col" || lowered == "column";
    let mut options = ChartOptions {
        x: u.dim(b.x),
        y: u.dim(b.y),
        w: u.dim(b.w),
        h: u.dim(b.h),
        chart_colors: spec.get("colors").and_then(Value::as_array).map(|list| list.iter().map(label_text).collect()),
        show_legend: has(spec, "legend"),
        legend_pos: Some(spec_text(spec, "legendPos", "b").to_owned()),
        legend_font_face: Some(font.to_owned()),
        legend_font_size: Some(size),
        legend_color: Some(ink.to_owned()),
        show_title: false,
        // plot: the inner plot area as fractions of the chart box, so an overlay (a shaded band, a threshold, a callout)
        // drawn in the HTML lands on the data: category i of n sits at x + (i + 0.5) / n of the plot width.
        layout: spec.get("plot").filter(|plot| truthy(plot)).map(|plot| ChartLayout {
            x: Some(number_or(plot.get("x"), 0.0)),
            y: Some(number_or(plot.get("y"), 0.0)),
            w: Some(number_or(plot.get("w"), 1.0)),
            h: Some(number_or(plot.get("h"), 1.0)),
        }),
        show_value: spec.get("showValues") != Some(&Value::Bool(false)),
        data_label_color: Some(ink.to_owned()),
        data_label_font_face: Some(font.to_owned()),
        data_label_font_size: Some(size),
        data_label_font_bold: true,
        data_label_format_code: spec.get("format").filter(|format| truthy(format)).map(label_text),
        ..ChartOptions::default()
    };
    if round {
        options.show_percent = false;
        options.hole_size = Some(number_or(spec.get("hole"), 60.0));
        options.data_label_position = Some(spec_text(spec, "labelPosition", "bestFit").to_owned());
    } else {
        axis_chart_options(&mut options, kind, spec, column, ink, font, size);
    }
    pres.add_chart(index, kind, data, options)
}

fn axis_label_position(kind: ChartKind, spec: &Value) -> String {
    let given = spec_text(spec, "labelPosition", "");
    if !given.is_empty() {
        return given.to_owned();
    }
    if has(spec, "stacked") {
        return "ctr".to_owned();
    }
    (if kind == ChartKind::Line { "t" } else { "outEnd" }).to_owned()
}

/// The options a bar / line / area chart adds to the shared ones: series geometry, axes and grid.
fn axis_chart_options(options: &mut ChartOptions, kind: ChartKind, spec: &Value, column: bool, ink: &str, font: &str, size: f64) {
    if kind == ChartKind::Bar {
        options.bar_dir = Some((if column { "col" } else { "bar" }).to_owned());
        let gap = match spec.get("gap") {
            None | Some(Value::Null) => 60.0,
            other => to_number_of(other),
        };
        options.bar_gap_width_pct = Some(gap);
        options.bar_grouping = Some((if has(spec, "stacked") { "stacked" } else { "clustered" }).to_owned());
    }
    if kind == ChartKind::Line {
        options.line_size = Some(number_or(spec.get("lineSize"), 3.0));
        options.line_data_symbol = Some((if spec.get("markers") == Some(&Value::Bool(false)) { "none" } else { "circle" }).to_owned());
    }
    options.data_label_position = Some(axis_label_position(kind, spec));
    options.cat_axis_label_frequency = Some(1.0);
    options.cat_axis = AxisStyle {
        orientation: Some((if kind == ChartKind::Bar && !column { "maxMin" } else { "minMax" }).to_owned()),
        hidden: spec.get("categoryAxis") == Some(&Value::Bool(false)),
        label_color: Some(ink.to_owned()),
        label_font_face: Some(font.to_owned()),
        label_font_size: Some(size),
        line_show: Some(has(spec, "axisLine")),
        ..AxisStyle::default()
    };
    let present = |key: &str| spec.get(key).filter(|value| !value.is_null());
    options.val_axis = AxisStyle {
        hidden: spec.get("valueAxis") != Some(&Value::Bool(true)),
        label_color: Some(ink.to_owned()),
        label_font_face: Some(font.to_owned()),
        label_font_size: Some(size),
        min_val: Some(present("min").map_or(0.0, |min| to_number_of(Some(min)))),
        max_val: present("max").map(|max| to_number_of(Some(max))),
        ..AxisStyle::default()
    };
    options.val_grid_line = Some(match spec.get("grid").filter(|grid| truthy(grid)) {
        Some(grid) => GridLine { color: Some(label_text(grid)), size: Some(1.0), ..GridLine::default() },
        None => GridLine { style: Some("none".to_owned()), ..GridLine::default() },
    });
    options.cat_grid_line = Some(GridLine { style: Some("none".to_owned()), ..GridLine::default() });
}

fn picture_alpha(item: &Value) -> Option<f64> {
    let alpha = number(item, "alpha");
    (alpha < 1.0).then(|| js_round((1.0 - alpha) * 100.0))
}

/// A drawing that leaves most of its frame clear (a band, a ring, an arrow) is not the rectangle it is placed in: it is
/// named as a motif, so review that reads frames leaves its shape to the HTML geometry read.
fn drawing_name(image: &Image) -> Option<String> {
    let channels = mixdog_raster::stats(&image.ensure_alpha());
    let alpha = channels.last()?;
    (alpha.mean / 255.0 < DRAWING_OPAQUE_SHARE).then(|| MOTIF_NAME.to_owned())
}

fn png_data(image: &Image) -> Result<String, String> {
    Ok(format!("image/png;base64,{}", STANDARD.encode(image.to_png().map_err(|error| error.to_string())?)))
}

fn add_svg(slide: &mut Slide, u: &Units, item: &Value, fonts: &SvgFonts) -> Result<(), String> {
    let b = Bounds::of(&item["box"]);
    let width = js_round(b.w * SVG_SCALE).max(1.0) as u32;
    let height = js_round(b.h * SVG_SCALE).max(1.0) as u32;
    let drawn = svg::rasterize_to(fonts, text(item, "markup").as_bytes(), 72.0 * SVG_SCALE, width, height).map_err(|error| error.to_string())?;
    let Some((image, placed)) = crop_to_canvas(drawn, b, u)? else { return Ok(()) };
    slide.add_image(ImageOptions {
        data: Some(png_data(&image)?),
        x: u.dim(placed.x),
        y: u.dim(placed.y),
        w: u.dim(placed.w),
        h: u.dim(placed.h),
        alt_text: Some(alt_or(item, "drawing").to_owned()),
        transparency: picture_alpha(item),
        object_name: drawing_name(&image),
        ..ImageOptions::default()
    })
}

/// The mean colour a picture paints inside a canvas box, and the share of that box it covers opaquely (a point the
/// picture does not reach counts as uncovered).
fn mean_colour(image: &Image, draw: Bounds, bounds: Bounds, inset: f64) -> (Option<String>, f64) {
    let (width, height) = (i64::from(image.width()), i64::from(image.height()));
    let s = f64::from(image.width()) / draw.w;
    let pad = (inset * s).ceil() as i64;
    let x0 = js_round((bounds.x - draw.x) * s) as i64 + pad;
    let y0 = js_round((bounds.y - draw.y) * s) as i64 + pad;
    let x1 = js_round((bounds.x + bounds.w - draw.x) * s) as i64 - pad;
    let y1 = js_round((bounds.y + bounds.h - draw.y) * s) as i64 - pad;
    let step = (js_round((((x1 - x0) * (y1 - y0)).max(1) as f64 / 40_000.0).sqrt()) as i64).max(2);
    let (mut r, mut g, mut b, mut n, mut total) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let data = image.rgba();
    let mut y = y0;
    while y < y1 {
        let mut x = x0;
        while x < x1 {
            total += 1;
            if x >= 0 && y >= 0 && x < width && y < height {
                let at = ((y * width + x) * 4) as usize;
                if data[at + 3] >= 250 {
                    r += u64::from(data[at]);
                    g += u64::from(data[at + 1]);
                    b += u64::from(data[at + 2]);
                    n += 1;
                }
            }
            x += step;
        }
        y += step;
    }
    let hex = (n > 0).then(|| [r, g, b].iter().map(|sum| format!("{:02X}", js_round(*sum as f64 / n as f64) as u64)).collect::<String>());
    (hex, if total > 0 { n as f64 / total as f64 } else { 0.0 })
}

fn add_capture(slide: &mut Slide, u: &Units, item: &Value) -> Result<(), String> {
    let encoded = text(item, "png");
    let bytes = STANDARD.decode(encoded).map_err(|error| error.to_string())?;
    let image = Image::decode(&bytes).map_err(|error| error.to_string())?;
    let draw = Bounds::of(&item["draw"]);
    // The page's own drawn background also sets the slide colour, the one the contrast read stands on.
    if has(item, "slide") {
        let (colour, coverage) = mean_colour(&image, draw, draw, 0.0);
        if let Some(colour) = colour.filter(|_| coverage > 0.98) {
            slide.set_background(Background { color: Some(colour), ..Background::default() });
        }
    }
    // Under a box the picture covers opaquely, read inside the element's own box (not its shadow).
    if let Some(underlay) = object(item, "underlay") {
        let under = Bounds::of(&underlay["box"]);
        let (colour, coverage) = mean_colour(&image, draw, under, number(underlay, "radius"));
        if let Some(colour) = colour.filter(|_| coverage > 0.98) {
            let rect = serde_json::json!({
                "box": underlay["box"],
                "radius": underlay.get("radius").cloned().unwrap_or(Value::Null),
                "rotate": underlay.get("rotate").cloned().unwrap_or(Value::Null),
                "fill": { "hex": colour, "a": 1 },
                "stroke": null,
                "shadow": null,
            });
            add_rect(slide, u, &rect)?;
        }
    }
    slide.add_image(ImageOptions {
        data: Some(format!("image/png;base64,{encoded}")),
        x: u.dim(draw.x),
        y: u.dim(draw.y),
        w: u.dim(draw.w),
        h: u.dim(draw.h),
        alt_text: Some(alt_or(item, "decoration").to_owned()),
        object_name: if has(item, "slide") { None } else { drawing_name(&image) },
        ..ImageOptions::default()
    })
}

/// What the build reads from disk: the bytes of each `file:` picture, by its `src`, or why it could not be read.
pub type Pictures = BTreeMap<String, Result<Vec<u8>, String>>;

/// The `src` of every picture the slides draw from a local file: the caller reads these before the build.
pub fn local_pictures(slides: &[Value]) -> Vec<String> {
    let mut found = Vec::new();
    for item in slides.iter().flat_map(|slide| slide["items"].as_array().map_or(&[][..], Vec::as_slice)) {
        let src = text(item, "src");
        if item["kind"] == "image" && src.starts_with("file:") && !found.iter().any(|known| known == src) {
            found.push(src.to_owned());
        }
    }
    found
}

/// `Buffer.from(text, 'base64')`: the characters of either alphabet, padding and anything else ignored.
fn lenient_base64(encoded: &str) -> Vec<u8> {
    let mut clean: Vec<u8> = encoded
        .bytes()
        .filter_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(byte),
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            _ => None,
        })
        .collect();
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    let engine = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    engine.decode(&clean).unwrap_or_default()
}

/// The `data:` payload of a picture source, `/^data:[^;]+;base64,(.*)$/`.
fn data_payload(src: &str) -> Option<&str> {
    let rest = src.strip_prefix("data:")?;
    let semicolon = rest.find(';')?;
    if semicolon == 0 {
        return None;
    }
    let payload = rest[semicolon..].strip_prefix(";base64,")?;
    (!payload.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(payload)
}

fn image_bytes(src: &str, pictures: &Pictures) -> Result<Vec<u8>, String> {
    if let Some(payload) = data_payload(src) {
        return Ok(lenient_base64(payload));
    }
    if src.starts_with("file:") {
        return match pictures.get(src) {
            Some(read) => read.clone(),
            None => Err(format!("{src} was not read")),
        };
    }
    Err(format!("<img src=\"{}\"> is not local; use a file beside the deck or a data: URI.", mixdog_js::slice_utf16(src, 80)))
}

/// `parseFloat`: the longest decimal prefix, NaN when there is none.
fn parse_float(text: &str) -> f64 {
    let text = mixdog_js::js_trim_start(text);
    let bytes = text.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end += 1;
    }
    if text[end..].starts_with("Infinity") {
        return if bytes.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let digits = |from: usize| bytes[from..].iter().take_while(|byte| byte.is_ascii_digit()).count();
    let whole = digits(end);
    end += whole;
    let mut fraction = 0;
    if bytes.get(end) == Some(&b'.') {
        fraction = digits(end + 1);
        if whole > 0 || fraction > 0 {
            end += 1 + fraction;
        }
    }
    if whole == 0 && fraction == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let mut at = end + 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = digits(at);
        if exponent > 0 {
            end = at + exponent;
        }
    }
    text[..end].parse().unwrap_or(f64::NAN)
}

/// The crop origin of a covered picture from its computed `object-position` ("27% 50%", "-40px 10px"): a percentage
/// places that share of the overflow before the box, a length moves the picture by itself.
pub fn cover_offset(position: &str, overflow_x: f64, overflow_y: f64, scale: f64) -> (f64, f64) {
    let position = if position.is_empty() { "50% 50%" } else { position };
    let mut parts = mixdog_js::js_trim(position).split(|ch: char| mixdog_js::is_js_space(ch)).filter(|part| !part.is_empty());
    let along = |value: &str, overflow: f64| {
        let n = parse_float(value);
        if !n.is_finite() {
            return js_round(overflow / 2.0);
        }
        let offset = if value.ends_with('%') { n / 100.0 * overflow } else { -n * scale };
        overflow.min(js_round(offset).max(0.0))
    };
    let x = parts.next().unwrap_or("50%");
    let y = parts.next().unwrap_or("50%");
    (along(x, overflow_x), along(y, overflow_y))
}

/// A picture keeps its CSS crop (`object-fit: cover`, at its `object-position`) and corner radius, baked into the placed
/// PNG.
fn add_image(slide: &mut Slide, u: &Units, item: &Value, fonts: &SvgFonts, pictures: &Pictures) -> Result<(), String> {
    let b = Bounds::of(&item["box"]);
    let out_w = js_round(b.w * IMAGE_SCALE).max(1.0) as u32;
    let out_h = js_round(b.h * IMAGE_SCALE).max(1.0) as u32;
    let raster = |error: mixdog_raster::RasterError| error.to_string();
    let source = Image::decode(&image_bytes(text(item, "src"), pictures)?).map_err(raster)?.auto_orient();
    let fit = text(item, "fit");
    let mut image = if fit == "contain" || fit == "fill" {
        let options = ResizeOptions {
            width: Some(out_w),
            height: Some(out_h),
            fit: Fit::parse(fit).unwrap_or(Fit::Cover),
            background: [0, 0, 0, 0],
            ..ResizeOptions::default()
        };
        ops::resize(&source, &options).map_err(raster)?
    } else {
        // Cover crops where object-position puts the picture, not at its centre.
        let (nw, nh) = (f64::from(source.width()), f64::from(source.height()));
        let s = (f64::from(out_w) / nw).max(f64::from(out_h) / nh);
        let sw = f64::from(out_w).max(js_round(nw * s));
        let sh = f64::from(out_h).max(js_round(nh * s));
        let scaled = ops::resize(&source, &ResizeOptions { width: Some(sw as u32), height: Some(sh as u32), ..ResizeOptions::default() }).map_err(raster)?;
        let (px, py) = cover_offset(text(item, "position"), sw - f64::from(out_w), sh - f64::from(out_h), IMAGE_SCALE);
        ops::extract(&scaled, px as u32, py as u32, out_w, out_h).map_err(raster)?
    };
    let radius = number(item, "radius");
    if radius > 0.5 {
        let r = js_round(radius * IMAGE_SCALE);
        let mask = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{out_w}\" height=\"{out_h}\"><rect width=\"{out_w}\" height=\"{out_h}\" rx=\"{r}\" ry=\"{r}\"/></svg>"
        );
        let mask = svg::rasterize(fonts, mask.as_bytes(), 72.0).map_err(raster)?;
        image = composite(&image, &[Overlay { image: mask, blend: Blend::DestIn, placement: Placement::Centre }]);
    }
    let Some((placed, at)) = crop_to_canvas(image, b, u)? else { return Ok(()) };
    slide.add_image(ImageOptions {
        data: Some(png_data(&placed)?),
        x: u.dim(at.x),
        y: u.dim(at.y),
        w: u.dim(at.w),
        h: u.dim(at.h),
        alt_text: Some(alt_or(item, "picture").to_owned()),
        transparency: picture_alpha(item),
        ..ImageOptions::default()
    })
}

/// The measured deck as a `.pptx` (`buildPptxFromMeasure`): the package's bytes before the authored-package normaliser
/// reads them. `slides` are the measure's `{ bg, items, notes }`; `fonts` are the faces an SVG drawing's text is set in;
/// `pictures` holds the files named by [`local_pictures`].
pub fn build_pptx_from_measure(canvas: Canvas, slides: &[Value], fonts: &SvgFonts, pictures: &Pictures) -> Result<Vec<u8>, String> {
    let mut pres = Presentation::new();
    let page = page_inches(canvas);
    if page.0 == WIDE_INCHES && (page.1 - 7.5).abs() < 0.01 {
        pres.set_layout("LAYOUT_WIDE")?;
    } else {
        pres.define_layout("MIXDOG_SHEET", page.0, page.1);
        pres.set_layout("MIXDOG_SHEET")?;
    }
    let u = Units::of(canvas);
    for measured in slides {
        let index = pres.slide_count();
        pres.add_slide();
        if let Some(bg) = object(measured, "bg") {
            pres.slide_mut(index).ok_or("the slide is missing")?.set_background(Background { color: Some(hex(bg)), ..Background::default() });
        }
        for item in measured["items"].as_array().map_or(&[][..], Vec::as_slice) {
            if item["kind"] == "chart" {
                add_chart(&mut pres, index, &u, item)?;
                continue;
            }
            let slide = pres.slide_mut(index).ok_or("the slide is missing")?;
            match item["kind"].as_str().unwrap_or_default() {
                "rect" => add_rect(slide, &u, item)?,
                "line" => add_line(slide, &u, item)?,
                "text" => add_text(slide, &u, item, f64::from(canvas.width))?,
                "table" => add_table(slide, &u, item)?,
                "svg" => add_svg(slide, &u, item, fonts)?,
                "image" => add_image(slide, &u, item, fonts, pictures)?,
                "capture" => add_capture(slide, &u, item)?,
                _ => {}
            }
        }
        if has(measured, "notes") {
            pres.slide_mut(index).ok_or("the slide is missing")?.add_notes(&label_text(&measured["notes"]));
        }
    }
    pres.write()
}

#[cfg(test)]
mod tests {
    use mixdog_js::JsRegex;
    use serde_json::json;

    use super::*;

    const INK: &str = "14181F";

    fn style(size: f64, extra: Value) -> Value {
        let mut style = json!({ "font": "Noto Sans KR", "size": size, "bold": false, "italic": false, "color": { "hex": INK, "a": 1 }, "ls": 0, "hl": null });
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            style[key] = value;
        }
        style
    }

    /// A numbered disc as the browser draws it: 44 px circle, one 24 px digit centred, line-height 1.
    fn disc() -> Value {
        json!({
            "kind": "text",
            "box": { "x": 700, "y": 380, "w": 44, "h": 44 },
            "inset": { "l": 0, "r": 0, "t": 0, "b": 0 },
            "frame": { "kind": "rect", "box": { "x": 700, "y": 380, "w": 44, "h": 44 }, "fill": { "hex": "FF6B3D", "a": 1 }, "radius": 22, "stroke": null, "shadow": null },
            "align": "center",
            "lineHeight": 24,
            "fontSize": 24,
            "inkW": 14,
            "lines": [{ "top": 384, "bottom": 419, "width": 14, "runs": [{ "text": "2", "style": style(24.0, json!({ "bold": true })) }] }],
        })
    }

    /// Two lines the browser broke at a word boundary, the second carrying a highlighted run.
    fn paragraph() -> Value {
        json!({
            "kind": "text",
            "box": { "x": 96, "y": 600, "w": 560, "h": 84 },
            "inset": { "l": 0, "r": 0, "t": 0, "b": 0 },
            "frame": null,
            "align": "left",
            "lineHeight": 42,
            "fontSize": 28,
            "inkW": 540,
            "lines": [
                { "top": 604, "bottom": 644, "width": 540, "runs": [{ "text": "하네스만 바꿔 다시 돌렸다.", "style": style(28.0, json!({})) }] },
                { "top": 646, "bottom": 686, "width": 300, "runs": [
                    { "text": "결과는 같고 ", "style": style(28.0, json!({})) },
                    { "text": "비용은 줄었다", "style": style(28.0, json!({ "hl": "FFD9CC" })) },
                ] },
            ],
        })
    }

    fn cell(text: &str, y: f64) -> Value {
        json!({
            "text": text,
            "box": { "x": 96, "y": y, "w": 400, "h": 60 },
            "font": "Noto Sans KR",
            "size": 28,
            "bold": false,
            "color": { "hex": INK, "a": 1 },
            "fill": { "hex": "FFFFFF", "a": 1 },
            "align": "left",
            "pad": { "t": 10, "r": 10, "b": 10, "l": 10 },
            "border": { "t": null, "r": null, "b": { "w": 1, "c": "C9CDD4" }, "l": null },
            "span": 1,
        })
    }

    fn deck_canvas() -> Canvas {
        Canvas { width: 1920, height: 1080, inch_width: 0.0, inch_height: 0.0 }
    }

    fn build(items: Vec<Value>) -> Result<mixdog_ooxml::zipio::Package, String> {
        build_slides(vec![json!({ "bg": null, "items": items })])
    }

    fn build_slides(slides: Vec<Value>) -> Result<mixdog_ooxml::zipio::Package, String> {
        let bytes = build_pptx_from_measure(deck_canvas(), &slides, &SvgFonts::none(), &Pictures::new())?;
        mixdog_ooxml::zipio::Package::load(&bytes)
    }

    #[test]
    fn a_centred_disc_keeps_powerpoint_single_pitch_and_the_middle_anchor_lowered_to_the_browser_centre() {
        let place = text_placement(&disc(), 1920.0).expect("placed");
        assert_eq!(place.valign, "middle");
        assert_eq!(place.spacing, 1.0);
        // PowerPoint centres a single line 0.09 em high; a top inset of twice that moves the middle down.
        assert!((place.inset.t - 2.0 * 0.09 * 24.0).abs() < 1e-9, "{}", place.inset.t);
    }

    #[test]
    fn a_top_anchored_block_is_placed_so_powerpoint_first_baseline_lands_on_the_browser_one() {
        let place = text_placement(&paragraph(), 1920.0).expect("placed");
        assert_eq!(place.valign, "top");
        // Browser baseline: glyph top 604 + 0.801 x 40. PowerPoint: (0.93 x 1.25 - 0.03) x 28 under the top.
        let expected = 604.0 + 0.801 * 40.0 - (0.93 * (42.0 / 33.6) - 0.03) * 28.0;
        assert!((place.y - expected).abs() < 0.01, "{}", place.y);
        assert!((place.spacing - 42.0 / 33.6).abs() < 1e-9);
    }

    #[test]
    fn a_one_line_band_wider_than_its_text_keeps_the_browser_alignment_and_a_pill_it_fills_centres() {
        let mut band = disc();
        band["box"] = json!({ "x": 96, "y": 840, "w": 1728, "h": 104 });
        band["inset"] = json!({ "l": 40, "r": 40, "t": 30, "b": 30 });
        band["frame"]["box"] = band["box"].clone();
        band["frame"]["radius"] = json!(16);
        band["align"] = json!("left");
        band["lineHeight"] = json!(43.5);
        band["fontSize"] = json!(30);
        band["inkW"] = json!(1100);
        band["lines"] =
            json!([{ "top": 866, "bottom": 910, "width": 1100, "runs": [{ "text": "제약 고객의 이탈 시간이 가장 짧다.", "style": style(30.0, json!({})) }] }]);
        assert!(!text_placement(&band, 1920.0).expect("placed").center_align);
        band["box"]["w"] = json!(1180);
        assert!(text_placement(&band, 1920.0).expect("placed").center_align);
    }

    #[test]
    fn a_covered_picture_is_cropped_where_object_position_puts_it() {
        assert_eq!(cover_offset("27% 50%", 1000.0, 200.0, 2.0), (270.0, 100.0));
        assert_eq!(cover_offset("-40px 0px", 1000.0, 200.0, 2.0), (80.0, 0.0));
        assert_eq!(cover_offset("", 1000.0, 200.0, 2.0), (500.0, 100.0));
    }

    #[test]
    fn links_in_a_paragraph_and_in_a_table_cell_resolve_to_their_own_targets_and_a_rejected_scheme_stays_plain() {
        let run = |label: &str, href: &str| json!({ "text": label, "style": style(28.0, json!({ "href": href })) });
        let mut linked = paragraph();
        linked["lines"][1]["runs"] =
            json!([run("Alpha", "https://a.test/?x=1&y=2"), run("Beta", "mailto:b@b.test"), run("Evil", "javascript:alert(1)"), run("Plain", "")]);
        let mut cell_item = cell("ignored", 720.0);
        cell_item["runs"] = json!([
            { "text": "CellOne", "href": "https://c.test/one" },
            { "text": " and ", "href": "" },
            { "text": "CellTwo", "href": "https://c.test/two" },
            { "text": "CellEvil", "href": "file:///c:/secret" },
        ]);
        let table = json!({ "kind": "table", "box": { "x": 96, "y": 720, "w": 400, "h": 60 }, "rows": [[cell_item]] });
        let zip = build(vec![linked, table]).expect("a deck");
        let slide = zip.text("ppt/slides/slide1.xml");
        let rels = zip.text("ppt/slides/_rels/slide1.xml.rels");
        // The relationship a labelled run points at, resolved through the slide's relationships.
        let target_of = |label: &str| -> Option<String> {
            let at = slide.find(&format!("<a:t>{label}</a:t>")).unwrap_or_else(|| panic!("{label} in {slide}"));
            let run = &slide[slide[..at].rfind("<a:r>").expect("a run")..at];
            let id = run.split("<a:hlinkClick r:id=\"").nth(1)?.split('"').next()?;
            let rel = rels.split("<Relationship ").find(|rel| rel.contains(&format!("Id=\"{id}\""))).unwrap_or_else(|| panic!("{id} in {rels}"));
            assert!(rel.contains("relationships/hyperlink") && rel.contains("TargetMode=\"External\""), "{rel}");
            Some(rel.split("Target=\"").nth(1)?.split('"').next()?.to_owned())
        };
        assert_eq!(target_of("Alpha").as_deref(), Some("https://a.test/?x=1&amp;y=2"));
        assert_eq!(target_of("Beta").as_deref(), Some("mailto:b@b.test"));
        assert_eq!(target_of("CellOne").as_deref(), Some("https://c.test/one"));
        assert_eq!(target_of("CellTwo").as_deref(), Some("https://c.test/two"));
        for plain in ["Evil", "Plain", " and ", "CellEvil"] {
            assert_eq!(target_of(plain), None, "{plain}");
        }
        assert!(!rels.contains("javascript") && !rels.contains("secret"), "{rels}");
    }

    #[test]
    fn unframed_text_on_its_box_middle_is_still_placed_by_baseline_never_middle_anchored() {
        let mut loose = paragraph();
        loose["box"] = json!({ "x": 96, "y": 596, "w": 560, "h": 94 });
        assert_eq!(text_placement(&loose, 1920.0).expect("placed").valign, "top");
    }

    #[test]
    fn the_measured_deck_becomes_native_shapes_disc_soft_breaks_highlight_hard_shadow_whole_table() {
        let rect = json!({
            "kind": "rect",
            "box": { "x": 96, "y": 200, "w": 800, "h": 300 },
            "fill": { "hex": "FFFFFF", "a": 1 },
            "radius": 16,
            "stroke": { "hex": INK, "a": 1, "w": 2 },
            "shadow": { "color": { "hex": INK, "a": 1 }, "x": 12, "y": 12, "blur": 0 },
        });
        let table =
            json!({ "kind": "table", "box": { "x": 96, "y": 720, "w": 400, "h": 180 }, "rows": [[cell("a", 720.0)], [cell("b", 780.0)], [cell("c", 840.0)]] });
        let package = build_slides(vec![json!({ "bg": { "hex": "F4F5F7", "a": 1 }, "notes": "speaker note", "items": [rect, disc(), paragraph(), table] })])
            .expect("built");
        let xml = package.text("ppt/slides/slide1.xml");
        assert!(xml.contains("prst=\"ellipse\""));
        assert!(xml.contains("anchor=\"ctr\""));
        assert!(xml.contains("<a:br/>"), "the browser line break is written as a soft break");
        assert!(xml.contains("<a:highlight><a:srgbClr val=\"FFD9CC\""));
        let blur = JsRegex::new_static(r#"<a:outerShdw[^>]*blurRad="(\d+)""#, "")
            .captures(&xml)
            .and_then(|found| found.get(1).map(str::to_owned))
            .expect("an outer shadow");
        assert!(blur.parse::<u64>().expect("a number") < 12700, "hard shadow keeps a near-zero blur ({blur})");
        let frame = JsRegex::new_static(r#"<p:graphicFrame>[\s\S]*?<a:ext cx="\d+" cy="(\d+)""#, "")
            .captures(&xml)
            .and_then(|found| found.get(1).map(str::to_owned))
            .expect("a table frame");
        // Three 60 px rows = 180 px = 1.25 in = 1143000 EMU.
        assert!((frame.parse::<f64>().expect("a number") - 1_143_000.0).abs() < 2000.0, "table frame height {frame}");
        assert!(package.text("ppt/notesSlides/notesSlide1.xml").contains("speaker note"));
    }

    #[test]
    fn what_runs_past_the_page_is_cut_at_its_edge_as_the_browser_clips_it() {
        let band = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"2000\" height=\"260\" viewBox=\"0 0 2000 260\"><polygon points=\"0,202 2000,0 2000,57 0,260\" fill=\"#C9CEF2\"/></svg>";
        let items = vec![
            json!({ "kind": "svg", "box": { "x": -40, "y": 430, "w": 2000, "h": 260 }, "markup": band, "alt": "band", "alpha": 1 }),
            json!({ "kind": "rect", "box": { "x": 1800, "y": -20, "w": 200, "h": 100 }, "fill": { "hex": "FF7A45", "a": 1 }, "radius": 0, "stroke": null, "shadow": null }),
            json!({ "kind": "line", "seg": [-10, 900, 1950, 900], "color": { "hex": "161A33", "a": 1 }, "w": 2 }),
        ];
        let package = build(items).expect("built");
        let xml = package.text("ppt/slides/slide1.xml");
        let drawn = &xml[xml.find("</p:grpSpPr>").expect("the group")..];
        let frames: Vec<Vec<f64>> = JsRegex::new_static(r#"<a:xfrm[^>]*>\s*<a:off x="(-?\d+)" y="(-?\d+)"/>\s*<a:ext cx="(\d+)" cy="(\d+)"/>"#, "g")
            .captures_iter(drawn)
            .map(|found| (1..=4).map(|at| found.get(at).and_then(|value| value.parse().ok()).unwrap_or(f64::NAN)).collect())
            .collect();
        assert_eq!(frames.len(), 3, "{xml}");
        let (w, h) = (12_192_000.0, 6_858_000.0);
        for frame in &frames {
            let [x, y, cx, cy] = [frame[0], frame[1], frame[2], frame[3]];
            assert!(x >= 0.0 && y >= 0.0 && x + cx <= w + 2000.0 && y + cy <= h + 2000.0, "frame {frame:?} stays on the page");
        }
        // The band keeps its page part: the full canvas width, placed at its own top.
        assert!(frames.iter().any(|frame| frame[0] == 0.0 && (frame[2] - w).abs() < 2000.0 && (frame[1] - 430.0 * (w / 1920.0)).abs() < 2000.0), "{frames:?}");
    }

    fn chart_part(package: &mixdog_ooxml::zipio::Package) -> String {
        let name = package.names().into_iter().find(|name| JsRegex::new_static(r"^ppt/charts/chart\d+\.xml$", "").is_match(name)).expect("a chart part");
        package.text(&name)
    }

    #[test]
    fn a_chart_spec_pins_the_plot_area_and_can_hide_the_category_axis() {
        let chart = json!({
            "kind": "chart",
            "box": { "x": 96, "y": 500, "w": 1728, "h": 420 },
            "spec": { "type": "col", "labels": ["a", "b"], "values": [1, 2], "plot": { "x": 0, "y": 0.1, "w": 1, "h": 0.8 }, "categoryAxis": false },
        });
        let xml = chart_part(&build(vec![chart]).expect("built"));
        assert!(JsRegex::new_static(r#"<c:layoutTarget val="inner" ?/>[\s\S]*<c:y val="0.1" ?/>[\s\S]*<c:h val="0.8" ?/>"#, "").is_match(&xml));
        assert!(JsRegex::new_static(r#"<c:catAx>[\s\S]*?<c:delete val="1"/>"#, "").is_match(&xml));
    }

    #[test]
    fn a_chart_takes_the_measured_element_font_before_the_noto_sans_kr_fallback() {
        let face_of = |extra: Value| {
            let mut chart =
                json!({ "kind": "chart", "box": { "x": 96, "y": 500, "w": 1728, "h": 420 }, "spec": { "type": "col", "labels": ["a"], "values": [1] } });
            for (key, value) in extra.as_object().cloned().unwrap_or_default() {
                chart[key] = value;
            }
            let xml = chart_part(&build(vec![chart]).expect("built"));
            JsRegex::new_static(r#"<a:latin typeface="([^"]+)""#, "").captures(&xml).and_then(|found| found.get(1).map(str::to_owned))
        };
        assert_eq!(face_of(json!({ "font": "Georgia" })).as_deref(), Some("Georgia"));
        assert_eq!(face_of(json!({})).as_deref(), Some("Noto Sans KR"));
        assert_eq!(face_of(json!({ "font": "Georgia", "spec": { "type": "col", "labels": ["a"], "values": [1], "font": "Arial" } })).as_deref(), Some("Arial"));
    }

    #[test]
    fn a_picture_that_is_not_local_is_refused_with_the_sentence_node_threw() {
        let item = json!({ "kind": "image", "box": { "x": 0, "y": 0, "w": 10, "h": 10 }, "src": "https://example.com/a.png" });
        assert_eq!(
            build(vec![item]).err().as_deref(),
            Some("<img src=\"https://example.com/a.png\"> is not local; use a file beside the deck or a data: URI.")
        );
    }

    fn png_of(width: u32, height: u32, pixel: [u8; 4]) -> Vec<u8> {
        Image::create(width, height, 4, pixel).expect("an image").to_png().expect("a png")
    }

    #[test]
    fn a_data_picture_is_cropped_to_the_page_and_a_local_one_is_read_from_the_pictures_given() {
        let data = format!("data:image/png;base64,{}", STANDARD.encode(png_of(40, 20, [10, 200, 30, 255])));
        let local = "file:///deck/a.png".to_owned();
        let mut pictures = Pictures::new();
        pictures.insert(local.clone(), Ok(png_of(20, 20, [200, 10, 30, 255])));
        let items = vec![
            json!({ "kind": "image", "box": { "x": -100, "y": 100, "w": 400, "h": 200 }, "src": data, "fit": "cover", "position": "50% 50%", "alt": "left", "alpha": 0.5 }),
            json!({ "kind": "image", "box": { "x": 600, "y": 100, "w": 200, "h": 200 }, "src": local, "fit": "contain", "radius": 20 }),
        ];
        assert_eq!(local_pictures(&[json!({ "items": items })]), vec![local]);
        let bytes = build_pptx_from_measure(deck_canvas(), &[json!({ "items": items })], &SvgFonts::none(), &pictures).expect("built");
        let package = mixdog_ooxml::zipio::Package::load(&bytes).expect("a package");
        let media: Vec<String> = package.names().into_iter().filter(|name| name.starts_with("ppt/media/") && !name.ends_with('/')).collect();
        assert_eq!(media.len(), 2, "{media:?}");
        // The first picture stood 100 px past the page edge: 300 of its 400 px remain, at twice the density.
        let first = Image::decode(package.file(&media[0]).expect("the first picture")).expect("a png");
        assert_eq!((first.width(), first.height()), (600, 400), "{media:?}");
        let xml = package.text("ppt/slides/slide1.xml");
        assert!(xml.contains("descr=\"left\""));
        assert!(xml.contains("<a:alphaModFix amt=\"50000\"/>"), "{xml}");
        let missing = Pictures::new();
        let refused = build_pptx_from_measure(deck_canvas(), &[json!({ "items": [items[1].clone()] })], &SvgFonts::none(), &missing);
        assert_eq!(refused.err().as_deref(), Some("file:///deck/a.png was not read"));
    }

    #[test]
    fn a_capture_names_the_slide_colour_and_puts_a_native_fill_under_its_words() {
        let paint = Image::create(8, 8, 4, [20, 40, 60, 255]).expect("an image").to_png().expect("a png");
        let capture = json!({
            "kind": "capture",
            "png": STANDARD.encode(&paint),
            "draw": { "x": 0, "y": 0, "w": 4, "h": 4 },
            "slide": true,
            "underlay": { "box": { "x": 0, "y": 0, "w": 4, "h": 4 }, "radius": 0 },
        });
        let package = build(vec![capture]).expect("built");
        let xml = package.text("ppt/slides/slide1.xml");
        assert!(xml.contains("<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"14283C\"/>"), "{xml}");
        assert!(xml.contains("<a:srgbClr val=\"14283C\"/>"));
        assert!(xml.contains("descr=\"decoration\""));
        assert!(!xml.contains(MOTIF_NAME), "a page background is not a motif");
    }

    #[test]
    fn a_drawing_that_leaves_most_of_its_frame_clear_is_named_a_motif() {
        let ring = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"none\" stroke=\"#000\" stroke-width=\"4\"/></svg>";
        let solid = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><rect width=\"100\" height=\"100\" fill=\"#123456\"/></svg>";
        let items = vec![
            json!({ "kind": "svg", "box": { "x": 10, "y": 10, "w": 100, "h": 100 }, "markup": ring, "alt": "ring", "alpha": 1 }),
            json!({ "kind": "svg", "box": { "x": 200, "y": 10, "w": 100, "h": 100 }, "markup": solid, "alt": "tile", "alpha": 1 }),
        ];
        let xml = build(items).expect("built").text("ppt/slides/slide1.xml");
        assert_eq!(xml.matches(MOTIF_NAME).count(), 1, "{xml}");
    }

    #[test]
    fn a_layout_other_than_the_wide_one_is_defined_for_the_sheet_the_measure_names() {
        let canvas = Canvas { width: 800, height: 1000, inch_width: 8.0, inch_height: 10.0 };
        let bytes = build_pptx_from_measure(canvas, &[json!({ "items": [] })], &SvgFonts::none(), &Pictures::new()).expect("built");
        let package = mixdog_ooxml::zipio::Package::load(&bytes).expect("a package");
        assert!(package.text("ppt/presentation.xml").contains("<p:sldSz cx=\"7315200\" cy=\"9144000\"/>"));
    }

    #[test]
    fn a_data_uri_decodes_as_buffer_from_does() {
        assert_eq!(lenient_base64("AAEC"), vec![0, 1, 2]);
        assert_eq!(lenient_base64("AAE"), vec![0, 1]);
        assert_eq!(lenient_base64("AA-_"), vec![0, 15, 191]);
        assert_eq!(data_payload("data:image/png;base64,AAEC"), Some("AAEC"));
        assert_eq!(data_payload("data:;base64,AAEC"), None);
        assert_eq!(data_payload("data:image/png;charset=x;base64,AAEC"), None);
    }

    #[test]
    fn parse_float_reads_the_longest_decimal_prefix() {
        assert_eq!(parse_float("27%"), 27.0);
        assert_eq!(parse_float("-40px"), -40.0);
        assert_eq!(parse_float(".5e1x"), 5.0);
        assert!(parse_float("left").is_nan());
    }
}
