//! The painter: pdf.js's `CanvasGraphics` (`src/display/canvas.js`) driven by the typed events of
//! [`crate::oplist`] over [`mixdog_raster::canvas::Canvas`]. It owns the graphics state the display layer keeps on top
//! of the canvas's own (`CanvasExtraState`: the text state, the alphas and colours, the line width), executes each
//! event the way `CanvasGraphics` executes the matching operator, and leaves text to `text.rs` and images to
//! `images.rs`.
//!
//! Not painted here (the paint stage of the rasteriser adds them): Type3 glyph procedures, shadings, patterns, soft
//! masks, non-trivial transparency groups. A pattern fill or stroke draws nothing until then (reported once); a group
//! is entered as pdf.js enters one that needs no isolation (its bounding box clips, its content paints in place).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use mixdog_raster::RasterError;
use mixdog_raster::canvas::skia::Transform;
use mixdog_raster::canvas::{Canvas, FillRule, Path2D};

use crate::document::Document;
use crate::error::{PdfError, Result};
use crate::object::{Dict, Obj};
use crate::oplist::events::{
    DRAW_CLOSE_PATH, DRAW_CURVE_TO, DRAW_LINE_TO, DRAW_MOVE_TO, DRAW_QUADRATIC_CURVE_TO, Expression,
    GStateValue, MarkedData, Op, OperatorList, OptionalContent, PaintOp, ParamOp, PathData,
};
use crate::oplist::gstate::Matrix;

use super::text::{DrawnFont, FontDrawing};

/// `LINE_CAP_STYLES` and `LINE_JOIN_STYLES`.
const LINE_CAP_STYLES: [&str; 3] = ["butt", "round", "square"];
const LINE_JOIN_STYLES: [&str; 3] = ["miter", "round", "bevel"];

/// The failure of a canvas call as the reader's own.
pub(super) fn raster(error: RasterError) -> PdfError {
    PdfError::Unknown(error.message().to_owned())
}

/// `Math.round` of JavaScript: halves round up.
pub(super) fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `Math.sign`.
pub(super) fn js_sign(value: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        value
    } else {
        value.signum()
    }
}

/// A matrix as the canvas hands it back (single precision), widened.
pub(super) fn widen(m: [f32; 6]) -> Matrix {
    [
        f64::from(m[0]),
        f64::from(m[1]),
        f64::from(m[2]),
        f64::from(m[3]),
        f64::from(m[4]),
        f64::from(m[5]),
    ]
}

/// The inverse of an affine matrix (`DOMMatrix.invertSelf`, `Util.inverseTransform`); `None` when it is singular.
pub(super) fn invert(m: &Matrix) -> Option<Matrix> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    Some([
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[4] * m[3]) / det,
        (m[4] * m[1] - m[5] * m[0]) / det,
    ])
}

/// A matrix as the tiny-skia transform of the canvas's path calls.
pub(super) fn skia(m: &Matrix) -> Transform {
    Transform::from_row(
        m[0] as f32,
        m[1] as f32,
        m[2] as f32,
        m[3] as f32,
        m[4] as f32,
        m[5] as f32,
    )
}

/// `Util.singularValueDecompose2dScale`: the two scale factors of a matrix, single precision as the `Float32Array` of
/// pdf.js keeps them.
pub(super) fn singular_scales(m: &Matrix) -> (f32, f32) {
    let a = m[0].powi(2) + m[1].powi(2);
    let b = m[0] * m[2] + m[1] * m[3];
    let c = m[2].powi(2) + m[3].powi(2);
    let first = (a + c) / 2.0;
    let second = (first.powi(2) - (a * c - b.powi(2))).sqrt();
    let or_one = |value: f64| if value == 0.0 || value.is_nan() { 1.0 } else { value };
    (
        or_one(first + second).sqrt() as f32,
        or_one(first - second).sqrt() as f32,
    )
}

/// `Util.axialAlignedBoundingBox`: the box of `rect` under `m` joined to `output`.
pub(super) fn axial_bounding_box(rect: &[f64; 4], m: &Matrix, output: &mut [f64; 4]) {
    let (r0, r1, r2, r3) = (rect[0], rect[1], rect[2], rect[3]);
    let mut a0 = m[0] * r0 + m[4];
    let mut a2 = a0;
    let mut a1 = m[0] * r2 + m[4];
    let mut a3 = a1;
    let mut b0 = m[3] * r1 + m[5];
    let mut b2 = b0;
    let mut b1 = m[3] * r3 + m[5];
    let mut b3 = b1;
    if m[1] != 0.0 || m[2] != 0.0 {
        let (m1r0, m1r2, m2r1, m2r3) = (m[1] * r0, m[1] * r2, m[2] * r1, m[2] * r3);
        a0 += m2r1;
        a3 += m2r1;
        a1 += m2r3;
        a2 += m2r3;
        b0 += m1r0;
        b3 += m1r0;
        b1 += m1r2;
        b2 += m1r2;
    }
    output[0] = output[0].min(a0).min(a1).min(a2).min(a3);
    output[1] = output[1].min(b0).min(b1).min(b2).min(b3);
    output[2] = output[2].max(a0).max(a1).max(a2).max(a3);
    output[3] = output[3].max(b0).max(b1).max(b2).max(b3);
}

/// `makePathFromDrawOPS`: the path a buffer of codes and coordinates describes (the walk stops at a truncated entry).
pub(super) fn path_from_buffer(data: &[f32]) -> Path2D {
    let mut path = Path2D::new();
    let mut i = 0;
    while i < data.len() {
        let code = data[i];
        i += 1;
        if code == DRAW_CLOSE_PATH {
            path.close_path();
            continue;
        }
        let points = if code == DRAW_MOVE_TO || code == DRAW_LINE_TO {
            2
        } else if code == DRAW_CURVE_TO {
            6
        } else if code == DRAW_QUADRATIC_CURVE_TO {
            4
        } else {
            break;
        };
        let Some(v) = data.get(i..i + points) else {
            break;
        };
        if code == DRAW_MOVE_TO {
            path.move_to(v[0], v[1]);
        } else if code == DRAW_LINE_TO {
            path.line_to(v[0], v[1]);
        } else if code == DRAW_CURVE_TO {
            path.bezier_curve_to(v[0], v[1], v[2], v[3], v[4], v[5]);
        } else {
            path.quadratic_curve_to(v[0], v[1], v[2], v[3]);
        }
        i += points;
    }
    path
}

/// `TransferMapsFallback`: the three 256-entry maps of a `TR` function, applied to colours and image pixels because the
/// canvas of Node has no filters.
#[derive(Clone)]
pub(super) struct TransferMaps {
    maps: [Arc<[u8]>; 3],
}

impl TransferMaps {
    fn new(maps: &[Option<Vec<u8>>]) -> Self {
        let identity: Arc<[u8]> = (0..=255u8).collect::<Vec<_>>().into();
        let pick = |entry: Option<&Option<Vec<u8>>>, default: Option<&Vec<u8>>| -> Arc<[u8]> {
            let map = match entry {
                Some(entry) => entry.as_ref(),
                None => default,
            };
            map.map_or_else(|| identity.clone(), |map| Arc::from(map.as_slice()))
        };
        let first = maps.first().and_then(Option::as_ref);
        Self {
            maps: [
                pick(maps.first(), None),
                pick(maps.get(1), first),
                pick(maps.get(2), first),
            ],
        }
    }

    fn lookup(map: &[u8], level: u8) -> u8 {
        map.get(usize::from(level)).copied().unwrap_or(0)
    }

    /// `applyToColor`: a `#rrggbb` colour through the maps, anything else as it is.
    fn apply_to_color(&self, color: &str) -> String {
        let Some(hex) = color.strip_prefix('#').filter(|hex| hex.len() == 6) else {
            return color.to_owned();
        };
        let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
        let (Some(r), Some(g), Some(b)) = (channel(0), channel(2), channel(4)) else {
            return color.to_owned();
        };
        format!(
            "#{:02x}{:02x}{:02x}",
            Self::lookup(&self.maps[0], r),
            Self::lookup(&self.maps[1], g),
            Self::lookup(&self.maps[2], b)
        )
    }

    /// `applyToImageData`: straight RGBA pixels, alpha kept.
    pub(super) fn apply_to_rgba(&self, rgba: &mut [u8]) {
        for pixel in rgba.chunks_exact_mut(4) {
            pixel[0] = Self::lookup(&self.maps[0], pixel[0]);
            pixel[1] = Self::lookup(&self.maps[1], pixel[1]);
            pixel[2] = Self::lookup(&self.maps[2], pixel[2]);
        }
    }
}

/// `CanvasExtraState`: what the display layer keeps beside the canvas's own state.
#[derive(Clone)]
pub(super) struct Extra {
    pub(super) font_name: String,
    /// `None` is the font that could not be made: its text draws nothing.
    pub(super) font: Option<DrawnFont>,
    pub(super) font_size: f64,
    pub(super) font_direction: f64,
    pub(super) font_matrix: Matrix,
    pub(super) leading: f64,
    pub(super) text_matrix: Option<Matrix>,
    pub(super) text_matrix_scale: f64,
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) line_x: f64,
    pub(super) line_y: f64,
    pub(super) char_spacing: f64,
    pub(super) word_spacing: f64,
    pub(super) text_hscale: f64,
    pub(super) text_rendering_mode: i64,
    pub(super) text_rise: f64,
    pub(super) fill_color: String,
    pub(super) stroke_color: String,
    pub(super) pattern_fill: bool,
    pub(super) pattern_stroke: bool,
    pub(super) fill_alpha: f64,
    pub(super) stroke_alpha: f64,
    pub(super) line_width: f64,
    pub(super) dash_phase: f64,
    pub(super) transfer: Option<TransferMaps>,
}

impl Default for Extra {
    fn default() -> Self {
        Self {
            font_name: String::new(),
            font: None,
            font_size: 0.0,
            font_direction: 1.0,
            font_matrix: super::text::FONT_IDENTITY_MATRIX,
            leading: 0.0,
            text_matrix: None,
            text_matrix_scale: 1.0,
            x: 0.0,
            y: 0.0,
            line_x: 0.0,
            line_y: 0.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            text_hscale: 1.0,
            text_rendering_mode: 0,
            text_rise: 0.0,
            fill_color: "#000000".to_owned(),
            stroke_color: "#000000".to_owned(),
            pattern_fill: false,
            pattern_stroke: false,
            fill_alpha: 1.0,
            stroke_alpha: 1.0,
            line_width: 1.0,
            dash_phase: 0.0,
            transfer: None,
        }
    }
}

/// `OptionalContentConfig` for the display intent: which optional content groups are on.
#[derive(Default)]
pub(super) struct OptionalContentConfig {
    groups: HashMap<String, bool>,
}

impl OptionalContentConfig {
    /// The default configuration of the catalog's `OCProperties` (`Catalog.optionalContentConfig`): the base state, the
    /// `ON` and `OFF` lists, and a group whose `Usage` `View` state is off. A configuration that cannot be read is no
    /// configuration (every group visible), said at warn level; a cancellation or a limit is not swallowed.
    pub(super) fn read(document: &Document) -> Result<Self> {
        match Self::read_catalog(document) {
            Ok(config) => Ok(config),
            Err(error) if error.is_fatal() => Err(error),
            Err(error) => {
                tracing::warn!("Unable to read optional content config: {}", error.message());
                Ok(Self::default())
            }
        }
    }

    fn read_catalog(document: &Document) -> Result<Self> {
        let xref = document.xref();
        let Some(root) = xref.root() else {
            return Ok(Self::default());
        };
        let Obj::Dict(properties) = xref.get(&root, "OCProperties")? else {
            return Ok(Self::default());
        };
        let Obj::Array(listed) = xref.get(&properties, "OCGs")? else {
            return Ok(Self::default());
        };
        let Obj::Dict(config) = xref.get(&properties, "D")? else {
            return Ok(Self::default());
        };
        let base_off = matches!(xref.get(&config, "BaseState")?, Obj::Name(name) if &*name == "OFF");
        let mut groups: HashMap<String, bool> = HashMap::new();
        let mut view_off: HashSet<String> = HashSet::new();
        for item in listed.iter() {
            let Obj::Ref(reference) = item else { continue };
            let id = reference.to_string();
            // `#readOptionalContentGroup` reads the entry as a dictionary: anything else fails the whole configuration.
            let Obj::Dict(group) = xref.fetch(*reference, false)? else {
                return Err(PdfError::format(format!("the optional content group {id} is not a dictionary")));
            };
            if let Obj::Dict(usage) = xref.get(&group, "Usage")?
                && let Obj::Dict(view) = xref.get(&usage, "View")?
                && matches!(xref.get(&view, "ViewState")?, Obj::Name(state) if &*state == "OFF")
            {
                view_off.insert(id.clone());
            }
            groups.insert(id, !base_off);
        }
        for (key, state) in [("ON", true), ("OFF", false)] {
            if let Obj::Array(items) = xref.get(&config, key)? {
                for item in items.iter() {
                    if let Obj::Ref(reference) = item
                        && let Some(slot) = groups.get_mut(&reference.to_string())
                    {
                        *slot = state;
                    }
                }
            }
        }
        for id in &view_off {
            if let Some(slot) = groups.get_mut(id) {
                *slot = false;
            }
        }
        Ok(Self { groups })
    }

    fn state(&self, id: &str) -> Option<bool> {
        let known = self.groups.get(id).copied();
        if known.is_none() {
            tracing::warn!("Optional content group not found: {id}");
        }
        known
    }

    fn evaluate(&self, array: &[Expression]) -> bool {
        if array.len() < 2 {
            return true;
        }
        let Expression::Operator(operator) = &array[0] else {
            return true;
        };
        for element in &array[1..] {
            let state = match element {
                Expression::Nested(nested) => self.evaluate(nested),
                Expression::Reference(id) => match self.state(id) {
                    Some(state) => state,
                    None => return true,
                },
                Expression::Operator(_) => return true,
            };
            match operator.as_str() {
                "And" if !state => return false,
                "And" => {}
                "Or" if state => return true,
                "Or" => {}
                "Not" => return !state,
                _ => return true,
            }
        }
        operator == "And"
    }

    /// `isVisible(group)`.
    pub(super) fn is_visible(&self, content: Option<&OptionalContent>) -> bool {
        if self.groups.is_empty() {
            return true;
        }
        let Some(content) = content else {
            return true;
        };
        match content {
            OptionalContent::Group { id } => id
                .as_deref()
                .and_then(|id| self.state(id))
                .unwrap_or(true),
            OptionalContent::MembershipOne { id } => self.state(id).unwrap_or(true),
            OptionalContent::Membership {
                ids,
                policy,
                expression,
            } => {
                if let Some(expression) = expression {
                    return self.evaluate(expression);
                }
                // The groups are read in order and the answer is given at the first one that decides it, so a group
                // the file does not list makes the content visible only when it is met before that one.
                let (decides_on, answer, otherwise) = match policy.as_deref() {
                    None | Some("AnyOn") => (true, true, false),
                    Some("AllOn") => (false, false, true),
                    Some("AnyOff") => (false, true, false),
                    Some("AllOff") => (true, false, true),
                    Some(other) => {
                        tracing::warn!("Unknown optional content policy {other}.");
                        return true;
                    }
                };
                for id in ids {
                    match self.state(id) {
                        None => return true,
                        Some(state) if state == decides_on => return answer,
                        Some(_) => {}
                    }
                }
                otherwise
            }
        }
    }
}

/// `CanvasGraphics` over one page.
pub(super) struct Painter<'a> {
    pub(super) canvas: Canvas,
    pub(super) document: &'a Document,
    pub(super) resources: Arc<Dict>,
    pub(super) drawing: Option<&'a dyn FontDrawing>,
    pub(super) current: Extra,
    states: Vec<Extra>,
    pending_clip: Option<FillRule>,
    optional_content: OptionalContentConfig,
    marked: Vec<bool>,
    pub(super) content_visible: bool,
    /// `pendingTextPaths`: the glyph outlines a clipping text mode collects until `ET`.
    pub(super) pending_text_paths: Option<Vec<super::text::TextClipPath>>,
    reported: HashSet<&'static str>,
}

impl<'a> Painter<'a> {
    pub(super) fn new(
        canvas: Canvas,
        document: &'a Document,
        resources: Arc<Dict>,
        drawing: Option<&'a dyn FontDrawing>,
        optional_content: OptionalContentConfig,
    ) -> Self {
        Self {
            canvas,
            document,
            resources,
            drawing,
            current: Extra::default(),
            states: Vec::new(),
            pending_clip: None,
            optional_content,
            marked: Vec::new(),
            content_visible: true,
            pending_text_paths: None,
            reported: HashSet::new(),
        }
    }

    /// Says once, at warn level, that something the rasteriser does not paint yet was met.
    pub(super) fn report_once(&mut self, key: &'static str, message: &str) {
        if self.reported.insert(key) {
            tracing::warn!("{message}");
        }
    }

    /// The matrix in force.
    pub(super) fn ctm(&self) -> Matrix {
        widen(self.canvas.get_transform())
    }

    /// `execute`: every event in order, the cancellation asked between them.
    pub(super) fn execute(&mut self, list: &OperatorList) -> Result<()> {
        for op in list.ops() {
            self.document.guard().tick()?;
            self.apply(op)?;
        }
        Ok(())
    }

    fn apply(&mut self, op: &Op) -> Result<()> {
        match op {
            Op::Save => self.save(),
            Op::Restore => self.restore(),
            Op::Transform(m) => self.canvas.transform(
                m[0] as f32,
                m[1] as f32,
                m[2] as f32,
                m[3] as f32,
                m[4] as f32,
                m[5] as f32,
            ),
            Op::ConstructPath { paint, path } => self.construct_path(*paint, path.as_ref()),
            Op::Clip => self.pending_clip = Some(FillRule::Winding),
            Op::EoClip => self.pending_clip = Some(FillRule::EvenOdd),
            Op::SetLineWidth(width) => self.set_line_width(*width),
            Op::SetDash { array, phase } => self.set_dash(array, *phase),
            Op::SetGState(states) => self.set_gstate(states),
            Op::Param(op, args) => self.param(*op, args),
            Op::BeginText => self.begin_text(),
            Op::EndText => self.end_text(),
            Op::SetFont { loaded_name, size } => {
                self.set_font(loaded_name, size.as_num().unwrap_or(f64::NAN));
            }
            Op::ShowText(items) => self.show_text(items),
            Op::SetTextMatrix(m) => self.set_text_matrix(m),
            Op::SetFillRgbColor(color) => self.set_fill_color(color),
            Op::SetStrokeRgbColor(color) => self.set_stroke_color(color),
            Op::SetFillTransparent => self.set_fill_color("transparent"),
            Op::SetStrokeTransparent => self.set_stroke_color("transparent"),
            Op::SetFillPattern(_) => self.current.pattern_fill = true,
            Op::SetStrokePattern(_) => self.current.pattern_stroke = true,
            Op::ShadingFill(_) => self.report_once(
                "shading",
                "a shading fill (sh) is not painted by the core rasteriser",
            ),
            Op::FormBegin { matrix, bbox } => self.form_begin(matrix.as_ref(), bbox.as_ref()),
            Op::FormEnd => {
                if self.content_visible {
                    self.restore();
                }
            }
            Op::BeginGroup(group) => {
                if self.content_visible {
                    self.save();
                    if let Some(bbox) = group.bbox {
                        let clip = rect_path(f64::from(bbox[0]), f64::from(bbox[1]), f64::from(bbox[2]), f64::from(bbox[3]));
                        let clip = match &group.matrix {
                            Some(matrix) => {
                                let mut moved = Path2D::new();
                                moved.add_path(&clip, skia(matrix));
                                moved
                            }
                            None => clip,
                        };
                        self.canvas.clip_path2d(&clip, FillRule::Winding);
                    }
                }
            }
            Op::EndGroup(_) => {
                if self.content_visible {
                    self.restore();
                }
            }
            Op::PaintImage(image) => {
                if self.content_visible {
                    self.paint_image_object(image)?;
                }
            }
            Op::PaintInlineImage(image) => {
                if self.content_visible {
                    self.paint_small_inline_image(image)?;
                }
            }
            Op::PaintImageMask(image) => {
                if self.content_visible {
                    self.paint_image_mask_object(image)?;
                }
            }
            Op::PaintSolidColorImageMask => {
                if self.content_visible {
                    self.canvas.fill_rect(0.0, 0.0, 1.0, 1.0);
                }
            }
            Op::BeginMarkedContent(_) => self.marked.push(true),
            Op::BeginMarkedContentProps { tag, data } => {
                let visible = match (tag.as_str(), data) {
                    ("OC", MarkedData::OptionalContent(content)) => {
                        self.optional_content.is_visible(content.as_ref())
                    }
                    _ => true,
                };
                self.marked.push(visible);
                self.content_visible = self.marked.iter().all(|visible| *visible);
            }
            Op::EndMarkedContent => {
                self.marked.pop();
                self.content_visible = self.marked.iter().all(|visible| *visible);
            }
        }
        Ok(())
    }

    // ---- state -------------------------------------------------------------------------------------------------

    /// `save`.
    pub(super) fn save(&mut self) {
        self.canvas.save();
        self.states.push(self.current.clone());
    }

    /// `restore`: nothing when nothing is saved.
    pub(super) fn restore(&mut self) {
        let Some(state) = self.states.pop() else {
            return;
        };
        self.current = state;
        self.canvas.restore();
        self.pending_clip = None;
    }

    fn set_line_width(&mut self, width: f64) {
        self.current.line_width = width;
        self.canvas.set_line_width(width as f32);
    }

    fn set_dash(&mut self, array: &[f64], phase: f64) {
        let segments: Vec<f32> = array.iter().map(|value| *value as f32).collect();
        self.canvas.set_line_dash(&segments);
        self.canvas.set_line_dash_offset(phase as f32);
        self.current.dash_phase = phase;
    }

    fn set_line_cap(&mut self, style: f64) {
        if let Some(name) = style_name(&LINE_CAP_STYLES, style) {
            self.canvas.set_line_cap(name);
        }
    }

    fn set_line_join(&mut self, style: f64) {
        if let Some(name) = style_name(&LINE_JOIN_STYLES, style) {
            self.canvas.set_line_join(name);
        }
    }

    fn param(&mut self, op: ParamOp, args: &[Obj]) {
        let number = |at: usize| args.get(at).and_then(Obj::as_num).unwrap_or(f64::NAN);
        match op {
            ParamOp::SetLineCap => self.set_line_cap(number(0)),
            ParamOp::SetLineJoin => self.set_line_join(number(0)),
            ParamOp::SetMiterLimit => self.canvas.set_miter_limit(number(0) as f32),
            ParamOp::SetRenderingIntent | ParamOp::SetFlatness => {}
            ParamOp::SetCharSpacing => self.current.char_spacing = number(0),
            ParamOp::SetWordSpacing => self.current.word_spacing = number(0),
            ParamOp::SetHScale => self.current.text_hscale = number(0) / 100.0,
            ParamOp::SetLeading => self.current.leading = -number(0),
            ParamOp::SetTextRenderingMode => {
                let mode = number(0);
                self.current.text_rendering_mode = if mode.is_finite() { mode as i64 } else { 0 };
            }
            ParamOp::SetTextRise => self.current.text_rise = number(0),
            ParamOp::MoveText => self.move_text(number(0), number(1)),
            ParamOp::SetLeadingMoveText => {
                self.current.leading = number(1);
                self.move_text(number(0), number(1));
            }
            ParamOp::NextLine => {
                let leading = self.current.leading;
                self.move_text(0.0, leading);
            }
            ParamOp::SetCharWidth | ParamOp::SetCharWidthAndBounds => self.report_once(
                "type3-width",
                "a Type3 glyph description (d0, d1) is drawn by the paint stage of the rasteriser",
            ),
        }
    }

    fn set_gstate(&mut self, states: &[(String, GStateValue)]) {
        for (key, value) in states {
            match (key.as_str(), value) {
                ("LW", GStateValue::Number(width)) => self.set_line_width(*width),
                ("LC", GStateValue::Value(Obj::Num(style))) => self.set_line_cap(*style),
                ("LJ", GStateValue::Value(Obj::Num(style))) => self.set_line_join(*style),
                ("ML", GStateValue::Value(Obj::Num(limit))) => {
                    self.canvas.set_miter_limit(*limit as f32);
                }
                ("D", GStateValue::Value(Obj::Array(dash))) => {
                    let array: Vec<f64> = match dash.first() {
                        Some(Obj::Array(values)) => {
                            values.iter().map(|v| v.as_num().unwrap_or(f64::NAN)).collect()
                        }
                        _ => Vec::new(),
                    };
                    let phase = dash.get(1).and_then(Obj::as_num).unwrap_or(0.0);
                    self.set_dash(&array, phase);
                }
                ("Font", GStateValue::Font { loaded_name, size }) => {
                    self.set_font(loaded_name, size.as_num().unwrap_or(f64::NAN));
                }
                ("CA", GStateValue::Value(Obj::Num(alpha))) => self.current.stroke_alpha = *alpha,
                ("ca", GStateValue::Value(Obj::Num(alpha))) => {
                    self.current.fill_alpha = *alpha;
                    self.canvas.set_global_alpha(*alpha as f32);
                }
                ("BM", GStateValue::BlendMode(mode)) => {
                    self.canvas.set_global_composite_operation(mode);
                }
                ("TR", GStateValue::Transfer(maps)) => self.set_transfer(maps.as_deref()),
                _ => {}
            }
        }
    }

    /// The `TR` entry: the maps become the fallback that recolours what is drawn from now on.
    fn set_transfer(&mut self, maps: Option<&[Option<Vec<u8>>]>) {
        let fallback = maps.map(TransferMaps::new);
        if fallback.is_none() && self.current.transfer.is_none() {
            return;
        }
        self.current.transfer = fallback;
        if !self.current.pattern_fill {
            let color = self.transferred(&self.current.fill_color);
            self.canvas.set_fill_color(&color);
        }
        if !self.current.pattern_stroke {
            let color = self.transferred(&self.current.stroke_color);
            self.canvas.set_stroke_color(&color);
        }
    }

    fn transferred(&self, color: &str) -> String {
        match &self.current.transfer {
            Some(maps) => maps.apply_to_color(color),
            None => color.to_owned(),
        }
    }

    fn set_fill_color(&mut self, color: &str) {
        self.current.fill_color = color.to_owned();
        let shown = self.transferred(color);
        self.canvas.set_fill_color(&shown);
        self.current.pattern_fill = false;
    }

    fn set_stroke_color(&mut self, color: &str) {
        self.current.stroke_color = color.to_owned();
        let shown = self.transferred(color);
        self.canvas.set_stroke_color(&shown);
        self.current.pattern_stroke = false;
    }

    fn form_begin(&mut self, matrix: Option<&[f32; 6]>, bbox: Option<&[f32; 4]>) {
        if !self.content_visible {
            return;
        }
        self.save();
        if let Some(m) = matrix {
            self.canvas.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        }
        if let Some(b) = bbox {
            let clip = rect_path(f64::from(b[0]), f64::from(b[1]), f64::from(b[2]), f64::from(b[3]));
            self.canvas.clip_path2d(&clip, FillRule::Winding);
            // `endPath` after the box: a `W` left pending before `Do` is consumed by the empty path.
            self.pending_clip = None;
        }
    }

    // ---- paths -------------------------------------------------------------------------------------------------

    fn construct_path(&mut self, paint: PaintOp, data: Option<&PathData>) {
        let path = data.map_or_else(Path2D::new, |data| path_from_buffer(&data.data));
        let is_empty = data.is_none_or(|data| data.min_max[0] == f32::INFINITY);
        match paint {
            PaintOp::Stroke | PaintOp::CloseStroke => self.stroke(&path),
            PaintOp::Fill => self.fill(&path, FillRule::Winding),
            PaintOp::EoFill => self.fill(&path, FillRule::EvenOdd),
            PaintOp::FillStroke | PaintOp::CloseFillStroke => {
                self.fill(&path, FillRule::Winding);
                self.stroke(&path);
            }
            PaintOp::EoFillStroke | PaintOp::CloseEoFillStroke => {
                self.fill(&path, FillRule::EvenOdd);
                self.stroke(&path);
            }
            PaintOp::EndPath => {}
        }
        self.consume_path(&path, is_empty);
    }

    /// `fill`: a pattern fill is the paint stage's.
    fn fill(&mut self, path: &Path2D, rule: FillRule) {
        if self.current.pattern_fill {
            self.report_once("pattern", "a pattern fill is painted by the paint stage of the rasteriser");
            return;
        }
        if self.content_visible {
            self.canvas.fill_path2d(path, rule);
        }
    }

    /// `stroke`: the stroke alpha for the stroke, the fill alpha again after it.
    fn stroke(&mut self, path: &Path2D) {
        if self.current.pattern_stroke {
            self.report_once("pattern", "a pattern stroke is painted by the paint stage of the rasteriser");
            return;
        }
        self.canvas.set_global_alpha(self.current.stroke_alpha as f32);
        if self.content_visible {
            self.rescale_and_stroke(path);
        }
        self.canvas.set_global_alpha(self.current.fill_alpha as f32);
    }

    /// `consumePath`: the pending clip takes the path unless the path was empty.
    fn consume_path(&mut self, path: &Path2D, is_empty: bool) {
        if let Some(rule) = self.pending_clip.take()
            && !is_empty
        {
            self.canvas.clip_path2d(path, rule);
        }
    }

    /// `getSinglePixelWidth`.
    pub(super) fn single_pixel_width(&self) -> f64 {
        let m = self.ctm();
        if m[1] == 0.0 && m[2] == 0.0 {
            return 1.0 / m[0].abs().min(m[3].abs());
        }
        let abs_det = (m[0] * m[3] - m[2] * m[1]).abs();
        let norm_x = m[0].hypot(m[2]);
        let norm_y = m[1].hypot(m[3]);
        norm_x.max(norm_y) / abs_det
    }

    /// `getScaleForStroking`.
    fn scale_for_stroking(&self) -> (f64, f64) {
        let line_width = self.current.line_width;
        let [a, b, c, d, _, _] = self.ctm();
        if b == 0.0 && c == 0.0 {
            let (norm_x, norm_y) = (a.abs(), d.abs());
            if norm_x == norm_y {
                if line_width == 0.0 {
                    return (1.0 / norm_x, 1.0 / norm_x);
                }
                let scaled = norm_x * line_width;
                let scale = if scaled < 1.0 { 1.0 / scaled } else { 1.0 };
                return (scale, scale);
            }
            if line_width == 0.0 {
                return (1.0 / norm_x, 1.0 / norm_y);
            }
            let (scaled_x, scaled_y) = (norm_x * line_width, norm_y * line_width);
            return (
                if scaled_x < 1.0 { 1.0 / scaled_x } else { 1.0 },
                if scaled_y < 1.0 { 1.0 / scaled_y } else { 1.0 },
            );
        }
        let abs_det = (a * d - b * c).abs();
        let (norm_x, norm_y) = (a.hypot(b), c.hypot(d));
        if line_width == 0.0 {
            return (norm_y / abs_det, norm_x / abs_det);
        }
        let base_area = line_width * abs_det;
        (
            if norm_y > base_area { norm_y / base_area } else { 1.0 },
            if norm_x > base_area { norm_x / base_area } else { 1.0 },
        )
    }

    /// `rescaleAndStroke`: a stroke is never thinner than a device pixel.
    fn rescale_and_stroke(&mut self, path: &Path2D) {
        let line_width = self.current.line_width;
        let (scale_x, scale_y) = self.scale_for_stroking();
        let width = if line_width == 0.0 { 1.0 } else { line_width };
        if scale_x == scale_y {
            self.canvas.set_line_width((width * scale_x) as f32);
            self.canvas.stroke_path2d(path);
            return;
        }
        let dashes: Vec<f32> = self.canvas.line_dash().to_vec();
        self.canvas.save();
        self.canvas.scale(scale_x as f32, scale_y as f32);
        let mut moved = Path2D::new();
        moved.add_path(
            path,
            Transform::from_scale((1.0 / scale_x) as f32, (1.0 / scale_y) as f32),
        );
        if !dashes.is_empty() {
            let scale = scale_x.max(scale_y);
            let scaled: Vec<f32> = dashes.iter().map(|dash| (f64::from(*dash) / scale) as f32).collect();
            self.canvas.set_line_dash(&scaled);
            self.canvas.set_line_dash_offset((self.current.dash_phase / scale) as f32);
        }
        self.canvas.set_line_width(width as f32);
        self.canvas.stroke_path2d(&moved);
        self.canvas.restore();
    }
}

/// The name of a style index (`LINE_CAP_STYLES[style]`): `None` for an index outside the table.
fn style_name(names: &[&'static str], style: f64) -> Option<&'static str> {
    if style.fract() != 0.0 || style < 0.0 {
        return None;
    }
    names.get(style as usize).copied()
}

/// The rectangle path `clip.rect(x0, y0, x1 - x0, y1 - y0)`.
pub(super) fn rect_path(x0: f64, y0: f64, x1: f64, y1: f64) -> Path2D {
    let mut path = Path2D::new();
    path.rect(x0 as f32, y0 as f32, (x1 - x0) as f32, (y1 - y0) as f32);
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_buffer_becomes_a_path_and_stops_at_a_truncated_entry() {
        let full = [DRAW_MOVE_TO, 1.0, 1.0, DRAW_LINE_TO, 5.0, 1.0, DRAW_CLOSE_PATH];
        assert!(!path_from_buffer(&full).is_empty());
        let cut = [DRAW_MOVE_TO, 1.0, 1.0, DRAW_CURVE_TO, 5.0, 1.0];
        let path = path_from_buffer(&cut);
        assert!(path.to_path().is_none(), "a lone move draws nothing");
    }

    #[test]
    fn javascript_rounding_rounds_halves_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.6), -3.0);
    }

    #[test]
    fn singular_scales_of_a_scale_and_a_rotation() {
        let (x, y) = singular_scales(&[2.0, 0.0, 0.0, 3.0, 0.0, 0.0]);
        assert!((x - 3.0).abs() < 1e-6 && (y - 2.0).abs() < 1e-6);
        let (x, y) = singular_scales(&[0.0, 2.0, -2.0, 0.0, 0.0, 0.0]);
        assert!((x - 2.0).abs() < 1e-6 && (y - 2.0).abs() < 1e-6);
    }

    #[test]
    fn the_box_of_a_rotated_rectangle_is_axis_aligned() {
        let mut out = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        axial_bounding_box(&[0.0, 0.0, 2.0, 1.0], &[0.0, 1.0, -1.0, 0.0, 10.0, 10.0], &mut out);
        assert_eq!(out, [9.0, 10.0, 10.0, 12.0]);
    }

    #[test]
    fn the_inverse_of_a_matrix_undoes_it() {
        let m = [2.0, 1.0, -1.0, 3.0, 5.0, 7.0];
        let inverse = invert(&m).expect("invertible");
        let product = crate::oplist::gstate::transform(&m, &inverse);
        for (got, want) in product.iter().zip(crate::oplist::gstate::IDENTITY) {
            assert!((got - want).abs() < 1e-12);
        }
        assert!(invert(&[1.0, 2.0, 2.0, 4.0, 0.0, 0.0]).is_none());
    }

    #[test]
    fn transfer_maps_recolour_hex_colours_and_pixels() {
        let invert_map: Vec<u8> = (0..=255u8).rev().collect();
        let maps = TransferMaps::new(&[Some(invert_map), None]);
        // Blue defaults to the red map when only two are given, a `null` one is the identity (green here).
        assert_eq!(maps.apply_to_color("#ff0000"), "#0000ff");
        assert_eq!(maps.apply_to_color("#00ff00"), "#ffffff");
        assert_eq!(maps.apply_to_color("transparent"), "transparent");
        let mut pixel = [255u8, 7, 9, 200];
        maps.apply_to_rgba(&mut pixel);
        assert_eq!(pixel, [0, 7, 246, 200]);
    }

    #[test]
    fn optional_content_policies_follow_the_group_states() {
        let mut groups = HashMap::new();
        groups.insert("1R".to_owned(), true);
        groups.insert("2R".to_owned(), false);
        let config = OptionalContentConfig { groups };
        let membership = |policy: Option<&str>| OptionalContent::Membership {
            ids: vec!["1R".to_owned(), "2R".to_owned()],
            policy: policy.map(str::to_owned),
            expression: None,
        };
        assert!(config.is_visible(Some(&membership(None))));
        assert!(!config.is_visible(Some(&membership(Some("AllOn")))));
        assert!(config.is_visible(Some(&membership(Some("AnyOff")))));
        assert!(!config.is_visible(Some(&membership(Some("AllOff")))));
        assert!(!config.is_visible(Some(&OptionalContent::Group { id: Some("2R".to_owned()) })));
        // A group the file does not list is visible.
        assert!(config.is_visible(Some(&OptionalContent::Group { id: Some("9R".to_owned()) })));
        // In a membership it makes the content visible only when it is met before the group that decides.
        let ordered = |ids: [&str; 2]| OptionalContent::Membership {
            ids: ids.map(str::to_owned).to_vec(),
            policy: Some("AllOn".to_owned()),
            expression: None,
        };
        assert!(!config.is_visible(Some(&ordered(["2R", "9R"]))));
        assert!(config.is_visible(Some(&ordered(["9R", "2R"]))));
        let expression = OptionalContent::Membership {
            ids: Vec::new(),
            policy: None,
            expression: Some(vec![
                Expression::Operator("And".to_owned()),
                Expression::Reference("1R".to_owned()),
                Expression::Nested(vec![
                    Expression::Operator("Not".to_owned()),
                    Expression::Reference("2R".to_owned()),
                ]),
            ]),
        };
        assert!(config.is_visible(Some(&expression)));
    }
}
