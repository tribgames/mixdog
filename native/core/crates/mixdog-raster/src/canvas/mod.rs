//! The 2D canvas the Office code draws with (`@napi-rs/canvas`, which is Skia's `CanvasRenderingContext2D`), over
//! tiny-skia, a port of Skia's raster pipeline: PDF page rendering, contact sheets, visual diffs and the rendered-page
//! metrics read pixels from it.
//!
//! [`Canvas`] is the canvas and its context in one: a pixmap, the drawing state (with `save` and `restore`), and the
//! current path. It has the calls the Office code makes and the ones the PDF renderer needs on top of them:
//!
//! * state: `save`, `restore`, `reset`, `translate`, `scale`, `rotate`, `transform`, `set_transform`, `reset_transform`,
//!   `globalAlpha`, `globalCompositeOperation` (all 26 operations), `imageSmoothingEnabled` and `Quality`;
//! * paths: `begin_path`, `move_to`, `line_to`, `bezier_curve_to`, `quadratic_curve_to`, `arc`, `arc_to`, `ellipse`,
//!   `rect`, `round_rect`, `close_path`, and [`Path2D`] to build one aside and draw it later;
//! * drawing: `fill` (non-zero and even-odd), `stroke` (width, caps, joins, miter limit, dashes and their offset),
//!   `clip`, `fill_rect`, `stroke_rect`, `clear_rect`, fill and stroke styles that are a colour, a linear or radial
//!   [`Gradient`] or a [`PatternStyle`], `draw_image` (three forms) from a [`Bitmap`];
//! * text: `fill_text`, `stroke_text` and `measure_text` through `mixdog-fonts` (the caller passes the font registry and
//!   the read proof it needs to load a face), `font`, `textAlign`, `textBaseline` and `letterSpacing`;
//! * pixels: `get_image_data`, `put_image_data` ([`ImageData`], straight RGBA with Skia's rounding) and PNG export.
//!
//! The pixmap, the clip mask and the tiny-skia types are public (`skia` re-exports them), so the PDF renderer can use
//! masks and shaders directly on the same pixels.
//!
//! Not modelled: shadows, filters, `Path2D` hit testing and a second text direction.

use std::sync::Arc;

use mixdog_fonts::Slant;
use mixdog_fonts::css_font;
use mixdog_fonts::css_font::ParsedFont;
use mixdog_fonts::measure;
use mixdog_fonts::measure::MeasureOptions;
use mixdog_fonts::measure::TextMetrics;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::ReadProof;
use tiny_skia::FilterQuality;
use tiny_skia::IntRect;
use tiny_skia::LineCap;
use tiny_skia::LineJoin;
use tiny_skia::Mask;
use tiny_skia::Paint;
use tiny_skia::Path;
use tiny_skia::PathBuilder;
use tiny_skia::Pattern;
use tiny_skia::Pixmap;
use tiny_skia::Rect;
use tiny_skia::Shader;
use tiny_skia::SpreadMode;
use tiny_skia::Stroke;
use tiny_skia::StrokeDash;
use tiny_skia::Transform;

mod glyph;
pub mod image_data;
pub mod paint;
pub mod path;
pub mod text;

/// The tiny-skia types, for code that draws on a canvas's pixmap with masks and shaders directly.
pub mod skia {
    pub use tiny_skia::*;
}

pub use self::image_data::Bitmap;
pub use self::image_data::ImageData;
pub use self::paint::CompositeOperation;
pub use self::paint::Gradient;
pub use self::paint::PatternStyle;
pub use self::paint::Repetition;
pub use self::paint::SmoothingQuality;
pub use self::paint::Style;
pub use self::paint::parse_color;
pub use self::path::Path2D;
pub use self::text::TextAlign;
pub use self::text::TextBaseline;
pub use tiny_skia::FillRule;

use self::image_data::premultiply;
use self::path::finite;
use self::image_data::unpremultiply;
use crate::Image;
use crate::RasterError;

/// The drawing state `save` pushes and `restore` pops.
#[derive(Clone)]
struct State {
    transform: Transform,
    fill: Style,
    stroke: Style,
    line_width: f32,
    line_cap: LineCap,
    line_join: LineJoin,
    miter_limit: f32,
    dash: Vec<f32>,
    dash_offset: f32,
    global_alpha: f32,
    composite: CompositeOperation,
    smoothing: bool,
    quality: SmoothingQuality,
    font: ParsedFont,
    font_text: String,
    letter_spacing: f32,
    align: TextAlign,
    baseline: TextBaseline,
    clip: Option<Arc<Mask>>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            transform: Transform::identity(),
            fill: Style::default(),
            stroke: Style::default(),
            line_width: 1.0,
            line_cap: LineCap::Butt,
            line_join: LineJoin::Miter,
            miter_limit: 10.0,
            dash: Vec::new(),
            dash_offset: 0.0,
            global_alpha: 1.0,
            composite: CompositeOperation::SourceOver,
            smoothing: true,
            quality: SmoothingQuality::Low,
            font: ParsedFont { slant: Slant::Upright, weight: 400, stretch: 5, small_caps: false, size: 10.0, families: vec!["sans-serif".to_owned()] },
            font_text: "10px sans-serif".to_owned(),
            letter_spacing: 0.0,
            align: TextAlign::Start,
            baseline: TextBaseline::Alphabetic,
            clip: None,
        }
    }
}

/// What a draw call paints with.
#[derive(Clone, Copy)]
enum Ink {
    Fill,
    Stroke,
}

/// The paint of a style: its shader in the space of the transform in force (the shader is moved with the path by
/// tiny-skia when a transform is passed), `globalAlpha` applied, and the composite operation as the blend mode.
fn build_paint<'a>(state: &State, style: &'a Style) -> Option<Paint<'a>> {
    let mut paint = Paint { anti_alias: true, blend_mode: state.composite.blend_mode(), ..Paint::default() };
    paint.shader = match style {
        Style::Color(color) => {
            let mut color = *color;
            color.apply_opacity(state.global_alpha);
            Shader::SolidColor(color)
        }
        Style::Gradient(gradient) => gradient.shader(state.global_alpha)?,
        Style::Pattern(pattern) => {
            // `repeat-x` and `repeat-y` repeat both ways and are cut to their band by the draw mask.
            let mode = if pattern.repetition == Repetition::NoRepeat { SpreadMode::Pad } else { SpreadMode::Repeat };
            Pattern::new(Pixmap::as_ref(&pattern.pixmap), mode, if pattern.cubic && state.smoothing { FilterQuality::Bicubic } else { state.quality.filter(state.smoothing) }, state.global_alpha, pattern.transform)
        }
    };
    Some(paint)
}

/// The mask a draw is cut to: the clip, and for a pattern that does not repeat both ways its cell.
enum DrawMask<'a> {
    Unmasked,
    Clip(&'a Mask),
    Cell(Mask),
}

impl DrawMask<'_> {
    fn get(&self) -> Option<&Mask> {
        match self {
            Self::Unmasked => None,
            Self::Clip(mask) => Some(mask),
            Self::Cell(mask) => Some(mask),
        }
    }
}

/// `None` when the cell cannot be made (nothing is drawn).
fn draw_mask<'a>(state: &'a State, style: &Style, width: u32, height: u32) -> Option<DrawMask<'a>> {
    let clip = || state.clip.as_deref().map_or(DrawMask::Unmasked, DrawMask::Clip);
    let Style::Pattern(pattern) = style else { return Some(clip()) };
    let Some((x, y, w, h)) = pattern.band() else { return Some(clip()) };
    let cell = PathBuilder::from_rect(Rect::from_xywh(x, y, w, h)?);
    let mut mask = match state.clip.as_deref() {
        Some(existing) => existing.clone(),
        None => {
            let mut full = Mask::new(width, height)?;
            full.data_mut().fill(255);
            full
        }
    };
    mask.intersect_path(&cell, FillRule::Winding, true, state.transform.pre_concat(pattern.transform));
    Some(DrawMask::Cell(mask))
}

fn style_of(state: &State, ink: Ink) -> &Style {
    match ink {
        Ink::Fill => &state.fill,
        Ink::Stroke => &state.stroke,
    }
}

/// Fills `path` given in the user space of `state.transform`.
fn fill_user(pixmap: &mut Pixmap, state: &State, ink: Ink, path: &Path, rule: FillRule) {
    let style = style_of(state, ink);
    let Some(paint) = build_paint(state, style) else { return };
    let Some(mask) = draw_mask(state, style, pixmap.width(), pixmap.height()) else { return };
    pixmap.fill_path(path, &paint, rule, state.transform, mask.get());
}

/// Paints text: the outlines of the glyphs on the device. The coverage is the area FreeType's rasteriser leaves for the glyphs
/// it renders and Skia's own anti-aliased path fill for the others, corrected the way Skia corrects the coverage of a glyph
/// mask for the colour of the text (`glyph::correcting_table`), cut by the clip and used as the mask of one fill of the
/// paint over the bounds.
fn fill_glyphs(pixmap: &mut Pixmap, state: &State, ink: Ink, paths: &text::DevicePaths) {
    let style = style_of(state, ink);
    let Some(mut paint) = build_paint(state, style) else { return };
    paint.shader.transform(state.transform);
    let Some(draw) = draw_mask(state, style, pixmap.width(), pixmap.height()) else { return };
    let (width, height) = (pixmap.width() as usize, pixmap.height() as usize);
    let Some(mut coverage) = Mask::new(width as u32, height as u32) else { return };
    let table = glyph::correcting_table(glyph::canonical_luminance(style.luminance_color()));
    // The pixels touched, as left, top, right, bottom.
    let mut touched: Option<(usize, usize, usize, usize)> = None;
    let mut include = |left: usize, top: usize, right: usize, bottom: usize| {
        touched = Some(touched.map_or((left, top, right, bottom), |(l, t, r, b)| (l.min(left), t.min(top), r.max(right), b.max(bottom))));
    };
    if let Some(path) = paths.sampled.as_ref() {
        let bounds = path.bounds();
        let left = (bounds.left().floor().max(0.0) as usize).min(width);
        let right = (bounds.right().ceil().max(0.0) as usize).min(width);
        let top = (bounds.top().floor().max(0.0) as usize).min(height);
        let bottom = (bounds.bottom().ceil().max(0.0) as usize).min(height);
        if right > left && bottom > top {
            coverage.fill_path(path, FillRule::Winding, true, Transform::identity());
            for row in top..bottom {
                for value in &mut coverage.data_mut()[row * width + left..row * width + right] {
                    *value = table[usize::from(*value)];
                }
            }
            include(left, top, right, bottom);
        }
    }
    if let Some(raster) = paths.exact.as_ref().and_then(|path| glyph::rasterize(path, width, height)) {
        for row in 0..raster.height {
            for column in 0..raster.width {
                let at = (raster.top + row) * width + raster.left + column;
                let corrected = table[usize::from(raster.data[row * raster.width + column])];
                coverage.data_mut()[at] = coverage.data()[at].max(corrected);
            }
        }
        include(raster.left, raster.top, raster.left + raster.width, raster.top + raster.height);
    }
    let Some((left, top, right, bottom)) = touched else { return };
    if let Some(cut) = draw.get() {
        for row in top..bottom {
            for column in left..right {
                let at = row * width + column;
                coverage.data_mut()[at] = multiply(coverage.data()[at], cut.data()[at]);
            }
        }
    }
    if let Some(area) = Rect::from_ltrb(left as f32, top as f32, right as f32, bottom as f32) {
        pixmap.fill_rect(area, &paint, Transform::identity(), Some(&coverage));
    }
}

/// `a * b / 255`, rounded (the product of two coverages).
fn multiply(a: u8, b: u8) -> u8 {
    let product = u32::from(a) * u32::from(b) + 128;
    ((product + (product >> 8)) >> 8) as u8
}

/// Fills `path` given in device space (the current path, which holds device points).
fn fill_device(pixmap: &mut Pixmap, state: &State, path: &Path, rule: FillRule) {
    let Some(mut paint) = build_paint(state, &state.fill) else { return };
    paint.shader.transform(state.transform);
    let Some(mask) = draw_mask(state, &state.fill, pixmap.width(), pixmap.height()) else { return };
    pixmap.fill_path(path, &paint, rule, Transform::identity(), mask.get());
}

fn make_stroke(state: &State) -> Stroke {
    Stroke {
        width: state.line_width,
        miter_limit: state.miter_limit,
        line_cap: state.line_cap,
        line_join: state.line_join,
        dash: if state.dash.is_empty() { None } else { StrokeDash::new(state.dash.clone(), state.dash_offset) },
    }
}

/// Strokes `path` given in user space: the width and the dashes are in user units and the transform bends them.
fn stroke_user(pixmap: &mut Pixmap, state: &State, path: &Path) {
    let style = style_of(state, Ink::Stroke);
    let Some(paint) = build_paint(state, style) else { return };
    let Some(mask) = draw_mask(state, style, pixmap.width(), pixmap.height()) else { return };
    pixmap.stroke_path(path, &paint, &make_stroke(state), state.transform, mask.get());
}

/// `(x, y, width, height)` with a negative size turned into the rectangle it covers.
fn normalised(x: f32, y: f32, width: f32, height: f32) -> (f32, f32, f32, f32) {
    let (x, width) = if width < 0.0 { (x + width, -width) } else { (x, width) };
    let (y, height) = if height < 0.0 { (y + height, -height) } else { (y, height) };
    (x, y, width, height)
}

/// A canvas and its 2D context.
pub struct Canvas {
    pixmap: Pixmap,
    state: State,
    stack: Vec<State>,
    path: Path2D,
}

impl Canvas {
    /// A transparent canvas; a width or height of zero (or one that does not fit in memory) is an error.
    pub fn new(width: u32, height: u32) -> Result<Self, RasterError> {
        let pixmap = Pixmap::new(width, height).ok_or_else(|| RasterError::new("a canvas needs a width and a height above zero that fit in memory"))?;
        Ok(Self { pixmap, state: State::default(), stack: Vec::new(), path: Path2D::new() })
    }

    pub fn width(&self) -> u32 {
        self.pixmap.width()
    }

    pub fn height(&self) -> u32 {
        self.pixmap.height()
    }

    /// The pixels, premultiplied RGBA8.
    pub fn pixmap(&self) -> &Pixmap {
        &self.pixmap
    }

    /// The pixels, for drawing on them with tiny-skia directly.
    pub fn pixmap_mut(&mut self) -> &mut Pixmap {
        &mut self.pixmap
    }

    pub fn into_pixmap(self) -> Pixmap {
        self.pixmap
    }

    /// The clip in force, if any (coverage 0 to 255 per pixel).
    pub fn clip_mask(&self) -> Option<&Mask> {
        self.state.clip.as_deref()
    }

    // ---- state ------------------------------------------------------------------------------------------------

    pub fn save(&mut self) {
        self.stack.push(self.state.clone());
    }

    /// Pops the last saved state; without one it does nothing.
    pub fn restore(&mut self) {
        if let Some(state) = self.stack.pop() {
            self.state = state;
        }
    }

    /// `reset()`: transparent pixels, the default state, no saved states and an empty path.
    pub fn reset(&mut self) {
        self.pixmap.fill(tiny_skia::Color::TRANSPARENT);
        self.state = State::default();
        self.stack.clear();
        self.path = Path2D::new();
    }

    pub fn translate(&mut self, x: f32, y: f32) {
        if finite(&[x, y]) {
            self.state.transform = self.state.transform.pre_translate(x, y);
        }
    }

    pub fn scale(&mut self, x: f32, y: f32) {
        if finite(&[x, y]) {
            self.state.transform = self.state.transform.pre_scale(x, y);
        }
    }

    /// Rotates by `angle` radians (clockwise on screen).
    pub fn rotate(&mut self, angle: f32) {
        if angle.is_finite() {
            let (sin, cos) = angle.sin_cos();
            self.state.transform = self.state.transform.pre_concat(Transform::from_row(cos, sin, -sin, cos, 0.0, 0.0));
        }
    }

    /// `transform(a, b, c, d, e, f)`: multiplies the current matrix by this one.
    pub fn transform(&mut self, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) {
        if finite(&[a, b, c, d, e, f]) {
            self.state.transform = self.state.transform.pre_concat(Transform::from_row(a, b, c, d, e, f));
        }
    }

    /// `setTransform(a, b, c, d, e, f)`: replaces the current matrix.
    pub fn set_transform(&mut self, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) {
        if finite(&[a, b, c, d, e, f]) {
            self.state.transform = Transform::from_row(a, b, c, d, e, f);
        }
    }

    pub fn reset_transform(&mut self) {
        self.state.transform = Transform::identity();
    }

    /// The current matrix as `[a, b, c, d, e, f]`.
    pub fn get_transform(&self) -> [f32; 6] {
        let t = self.state.transform;
        [t.sx, t.ky, t.kx, t.sy, t.tx, t.ty]
    }

    pub fn set_fill_style(&mut self, style: Style) {
        self.state.fill = style;
    }

    pub fn set_stroke_style(&mut self, style: Style) {
        self.state.stroke = style;
    }

    /// `fillStyle = "css colour"`: false, and the old style kept, when the text is no colour.
    pub fn set_fill_color(&mut self, css: &str) -> bool {
        Style::from_css(css).map(|style| self.state.fill = style).is_some()
    }

    /// `strokeStyle = "css colour"`.
    pub fn set_stroke_color(&mut self, css: &str) -> bool {
        Style::from_css(css).map(|style| self.state.stroke = style).is_some()
    }

    pub fn fill_style(&self) -> &Style {
        &self.state.fill
    }

    pub fn stroke_style(&self) -> &Style {
        &self.state.stroke
    }

    /// `lineWidth`: a value that is not above zero (or not finite) is ignored.
    pub fn set_line_width(&mut self, width: f32) {
        if width.is_finite() && width > 0.0 {
            self.state.line_width = width;
        }
    }

    pub fn line_width(&self) -> f32 {
        self.state.line_width
    }

    /// `lineCap`: `butt`, `round` or `square`; false for any other text.
    pub fn set_line_cap(&mut self, name: &str) -> bool {
        self.state.line_cap = match name {
            "butt" => LineCap::Butt,
            "round" => LineCap::Round,
            "square" => LineCap::Square,
            _ => return false,
        };
        true
    }

    /// `lineJoin`: `miter`, `round` or `bevel`; false for any other text.
    pub fn set_line_join(&mut self, name: &str) -> bool {
        self.state.line_join = match name {
            "miter" => LineJoin::Miter,
            "round" => LineJoin::Round,
            "bevel" => LineJoin::Bevel,
            _ => return false,
        };
        true
    }

    /// `miterLimit`: a value that is not above zero (or not finite) is ignored.
    pub fn set_miter_limit(&mut self, limit: f32) {
        if limit.is_finite() && limit > 0.0 {
            self.state.miter_limit = limit;
        }
    }

    /// `setLineDash`: an array with a negative or non-finite entry is ignored, an odd one is repeated once.
    pub fn set_line_dash(&mut self, segments: &[f32]) {
        if segments.iter().any(|value| !value.is_finite() || *value < 0.0) {
            return;
        }
        self.state.dash = if segments.len() % 2 == 1 { [segments, segments].concat() } else { segments.to_vec() };
    }

    pub fn line_dash(&self) -> &[f32] {
        &self.state.dash
    }

    pub fn set_line_dash_offset(&mut self, offset: f32) {
        if offset.is_finite() {
            self.state.dash_offset = offset;
        }
    }

    /// `globalAlpha`: a value outside 0 to 1 (or not a number) is ignored.
    pub fn set_global_alpha(&mut self, alpha: f32) {
        if (0.0..=1.0).contains(&alpha) {
            self.state.global_alpha = alpha;
        }
    }

    pub fn global_alpha(&self) -> f32 {
        self.state.global_alpha
    }

    /// `globalCompositeOperation`: false, and the old operation kept, for a name that is none of the 26.
    pub fn set_global_composite_operation(&mut self, name: &str) -> bool {
        CompositeOperation::parse(name).map(|operation| self.state.composite = operation).is_some()
    }

    pub fn global_composite_operation(&self) -> CompositeOperation {
        self.state.composite
    }

    pub fn set_image_smoothing_enabled(&mut self, enabled: bool) {
        self.state.smoothing = enabled;
    }

    /// `imageSmoothingQuality`: `low`, `medium` or `high`; false for any other text.
    pub fn set_image_smoothing_quality(&mut self, name: &str) -> bool {
        SmoothingQuality::parse(name).map(|quality| self.state.quality = quality).is_some()
    }

    // ---- path -------------------------------------------------------------------------------------------------

    fn path_mut(&mut self) -> &mut Path2D {
        self.path.set_transform(self.state.transform);
        &mut self.path
    }

    pub fn begin_path(&mut self) {
        self.path.clear();
    }

    pub fn move_to(&mut self, x: f32, y: f32) {
        self.path_mut().move_to(x, y);
    }

    pub fn line_to(&mut self, x: f32, y: f32) {
        self.path_mut().line_to(x, y);
    }

    pub fn quadratic_curve_to(&mut self, cpx: f32, cpy: f32, x: f32, y: f32) {
        self.path_mut().quadratic_curve_to(cpx, cpy, x, y);
    }

    pub fn bezier_curve_to(&mut self, cp1x: f32, cp1y: f32, cp2x: f32, cp2y: f32, x: f32, y: f32) {
        self.path_mut().bezier_curve_to(cp1x, cp1y, cp2x, cp2y, x, y);
    }

    pub fn close_path(&mut self) {
        self.path_mut().close_path();
    }

    pub fn rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
        self.path_mut().rect(x, y, width, height);
    }

    /// `roundRect` with one to four corner radii; a negative radius or a wrong count is an error.
    pub fn round_rect(&mut self, x: f32, y: f32, width: f32, height: f32, radii: &[f32]) -> Result<(), RasterError> {
        self.path_mut().round_rect(x, y, width, height, radii)
    }

    /// `arc`; a negative radius is an error.
    pub fn arc(&mut self, x: f32, y: f32, radius: f32, start: f32, end: f32, counterclockwise: bool) -> Result<(), RasterError> {
        self.path_mut().arc(x, y, radius, start, end, counterclockwise)
    }

    pub fn arc_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, radius: f32) -> Result<(), RasterError> {
        self.path_mut().arc_to(x1, y1, x2, y2, radius)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ellipse(&mut self, x: f32, y: f32, rx: f32, ry: f32, rotation: f32, start: f32, end: f32, counterclockwise: bool) -> Result<(), RasterError> {
        self.path_mut().ellipse(x, y, rx, ry, rotation, start, end, counterclockwise)
    }

    /// Adds the sub-paths of a [`Path2D`] to the current path, mapped by `transform` and the current matrix.
    pub fn add_path(&mut self, other: &Path2D, transform: Transform) {
        self.path_mut().add_path(other, transform);
    }

    // ---- drawing ----------------------------------------------------------------------------------------------

    /// Runs a draw. The composite operations that also change the canvas where the shape is not (`source-in`,
    /// `source-out`, `destination-in`, `destination-atop`, `copy`: the source is transparent there) draw the shape on a
    /// layer of its own first and composite the whole layer through the clip; every other operation draws in place.
    fn draw_with(&mut self, draw: impl FnOnce(&mut Pixmap, &State)) {
        if !self.state.composite.clears_outside_shape() {
            draw(&mut self.pixmap, &self.state);
            return;
        }
        let (width, height) = (self.pixmap.width(), self.pixmap.height());
        let Some(mut layer) = Pixmap::new(width, height) else { return };
        let inner = State { composite: CompositeOperation::SourceOver, clip: None, ..self.state.clone() };
        draw(&mut layer, &inner);
        let paint = Paint {
            shader: Pattern::new(layer.as_ref(), SpreadMode::Pad, FilterQuality::Nearest, 1.0, Transform::identity()),
            blend_mode: self.state.composite.blend_mode(),
            anti_alias: false,
            force_hq_pipeline: false,
        };
        if let Some(whole) = Rect::from_xywh(0.0, 0.0, width as f32, height as f32) {
            self.pixmap.fill_rect(whole, &paint, Transform::identity(), self.state.clip.as_deref());
        }
    }

    /// Fills the current path.
    pub fn fill(&mut self, rule: FillRule) {
        if let Some(path) = self.path.to_path() {
            self.draw_with(|pixmap, state| fill_device(pixmap, state, &path, rule));
        }
    }

    /// Fills a [`Path2D`], whose points are in the current user space.
    pub fn fill_path2d(&mut self, path: &Path2D, rule: FillRule) {
        if let Some(path) = path.to_path() {
            self.draw_with(|pixmap, state| fill_user(pixmap, state, Ink::Fill, &path, rule));
        }
    }

    /// Strokes the current path.
    pub fn stroke(&mut self) {
        let Some(device) = self.path.to_path() else { return };
        let Some(user) = self.state.transform.invert().and_then(|inverse| device.transform(inverse)) else { return };
        self.draw_with(|pixmap, state| stroke_user(pixmap, state, &user));
    }

    pub fn stroke_path2d(&mut self, path: &Path2D) {
        if let Some(path) = path.to_path() {
            self.draw_with(|pixmap, state| stroke_user(pixmap, state, &path));
        }
    }

    /// Intersects the clip with the current path (an empty path clips everything away).
    pub fn clip(&mut self, rule: FillRule) {
        let device = self.path.to_path();
        self.clip_device(device, rule);
    }

    pub fn clip_path2d(&mut self, path: &Path2D, rule: FillRule) {
        let device = path.to_path().and_then(|path| path.transform(self.state.transform));
        self.clip_device(device, rule);
    }

    fn clip_device(&mut self, path: Option<Path>, rule: FillRule) {
        let (width, height) = (self.pixmap.width(), self.pixmap.height());
        let Some(path) = path else {
            self.state.clip = Mask::new(width, height).map(Arc::new);
            return;
        };
        if let Some(existing) = self.state.clip.as_mut() {
            Arc::make_mut(existing).intersect_path(&path, rule, true, Transform::identity());
            return;
        }
        if let Some(mut mask) = Mask::new(width, height) {
            mask.fill_path(&path, rule, true, Transform::identity());
            self.state.clip = Some(Arc::new(mask));
        }
    }

    /// `fillRect`; a rectangle without area draws nothing.
    pub fn fill_rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
        if !finite(&[x, y, width, height]) {
            return;
        }
        let (x, y, width, height) = normalised(x, y, width, height);
        if let Some(rect) = Rect::from_xywh(x, y, width, height) {
            self.draw_with(|pixmap, state| fill_user(pixmap, state, Ink::Fill, &PathBuilder::from_rect(rect), FillRule::Winding));
        }
    }

    /// `strokeRect`; a rectangle with one side of zero is a line.
    pub fn stroke_rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
        if !finite(&[x, y, width, height]) {
            return;
        }
        let (x, y, width, height) = normalised(x, y, width, height);
        let Some(rect) = Rect::from_xywh(x, y, width, height) else { return };
        self.draw_with(|pixmap, state| stroke_user(pixmap, state, &PathBuilder::from_rect(rect)));
    }

    /// `clearRect`: transparent black inside the rectangle, through the clip, whatever the paint and composite.
    pub fn clear_rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
        if !finite(&[x, y, width, height]) {
            return;
        }
        let (x, y, width, height) = normalised(x, y, width, height);
        let Some(rect) = Rect::from_xywh(x, y, width, height) else { return };
        let paint = Paint { blend_mode: tiny_skia::BlendMode::Clear, anti_alias: true, ..Paint::default() };
        self.pixmap.fill_path(&PathBuilder::from_rect(rect), &paint, FillRule::Winding, self.state.transform, self.state.clip.as_deref());
    }

    // ---- images -----------------------------------------------------------------------------------------------

    /// `drawImage(image, dx, dy)`.
    pub fn draw_image(&mut self, image: &Bitmap, dx: f32, dy: f32) {
        self.draw_image_region(image, 0.0, 0.0, image.width() as f32, image.height() as f32, dx, dy, image.width() as f32, image.height() as f32);
    }

    /// `drawImage(image, dx, dy, dw, dh)`.
    pub fn draw_image_scaled(&mut self, image: &Bitmap, dx: f32, dy: f32, dw: f32, dh: f32) {
        self.draw_image_region(image, 0.0, 0.0, image.width() as f32, image.height() as f32, dx, dy, dw, dh);
    }

    /// `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)`: the part of the image outside its bounds is cut away
    /// together with the matching part of the destination; a rectangle without area draws nothing.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_image_region(&mut self, image: &Bitmap, sx: f32, sy: f32, sw: f32, sh: f32, dx: f32, dy: f32, dw: f32, dh: f32) {
        if !finite(&[sx, sy, sw, sh, dx, dy, dw, dh]) || sw == 0.0 || sh == 0.0 || dw == 0.0 || dh == 0.0 {
            return;
        }
        let (sx, sy, sw, sh) = normalised(sx, sy, sw, sh);
        let (dx, dy, dw, dh) = normalised(dx, dy, dw, dh);
        let (scale_x, scale_y) = (dw / sw, dh / sh);
        let (left, top) = (sx.max(0.0), sy.max(0.0));
        let right = (sx + sw).min(image.width() as f32);
        let bottom = (sy + sh).min(image.height() as f32);
        if right <= left || bottom <= top {
            return;
        }
        let (target_x, target_y) = (dx + (left - sx) * scale_x, dy + (top - sy) * scale_y);
        let (target_w, target_h) = ((right - left) * scale_x, (bottom - top) * scale_y);
        let (x0, y0, x1, y1) = (left.floor() as i32, top.floor() as i32, right.ceil() as i32, bottom.ceil() as i32);
        let Some(cell) = IntRect::from_ltrb(x0, y0, x1, y1) else { return };
        let Some(source) = image.pixmap().clone_rect(cell) else { return };
        let Some(target) = Rect::from_xywh(target_x, target_y, target_w, target_h) else { return };
        let placement = Transform::from_row(scale_x, 0.0, 0.0, scale_y, target_x + (x0 as f32 - left) * scale_x, target_y + (y0 as f32 - top) * scale_y);
        if !self.state.smoothing {
            let origin = (dx - sx * scale_x, dy - sy * scale_y);
            if self.draw_nearest_aligned(image, (x0, y0, x1, y1), (scale_x, scale_y), origin, (target_x, target_y, target_w, target_h)) {
                return;
            }
        }
        self.draw_with(|pixmap, state| {
            let paint = Paint {
                shader: Pattern::new(source.as_ref(), SpreadMode::Pad, state.quality.filter(state.smoothing), state.global_alpha, placement),
                blend_mode: state.composite.blend_mode(),
                anti_alias: true,
                force_hq_pipeline: false,
            };
            pixmap.fill_path(&PathBuilder::from_rect(target), &paint, FillRule::Winding, state.transform, state.clip.as_deref());
        });
    }

    /// An image drawn without smoothing under a matrix that only scales and moves: every device pixel takes the source
    /// pixel Skia's nearest sampler names for its centre, and the picture of those pixels is laid on the canvas as it
    /// is. Skia maps the centre through the inverse of the whole matrix in single precision (`1 / scale`, then
    /// `centre * inverse - translate * inverse` as one fused multiply-add) and takes the pixel the position is in, a
    /// position exactly on the border of two pixels being in the earlier one (`ceil - 1`): a bitmap of 8 pixels drawn
    /// 20 wide gives its first source pixel to the first three device pixels, not two. `false` when the matrix turns or
    /// skews the image (the sampler of tiny-skia draws it).
    fn draw_nearest_aligned(
        &mut self,
        image: &Bitmap,
        (x0, y0, x1, y1): (i32, i32, i32, i32),
        (scale_x, scale_y): (f32, f32),
        (origin_x, origin_y): (f32, f32),
        (target_x, target_y, target_w, target_h): (f32, f32, f32, f32),
    ) -> bool {
        let ctm = self.state.transform;
        if ctm.kx != 0.0 || ctm.ky != 0.0 || ctm.sx == 0.0 || ctm.sy == 0.0 {
            return false;
        }
        // The matrix from image pixels to the device, composed in double and stored in single as Skia's `setConcat`.
        let sx = (f64::from(ctm.sx) * f64::from(scale_x)) as f32;
        let sy = (f64::from(ctm.sy) * f64::from(scale_y)) as f32;
        let tx = (f64::from(ctm.sx) * f64::from(origin_x) + f64::from(ctm.tx)) as f32;
        let ty = (f64::from(ctm.sy) * f64::from(origin_y) + f64::from(ctm.ty)) as f32;
        if sx == 0.0 || sy == 0.0 || !finite(&[sx, sy, tx, ty]) {
            return false;
        }
        let (inverse_x, inverse_y) = (1.0 / sx, 1.0 / sy);
        let (shift_x, shift_y) = (-tx * inverse_x, -ty * inverse_y);
        // The pixels a non-anti-aliased rectangle covers: those whose centre it contains.
        let corner = |a: f32, b: f32| {
            let (p, q) = (f64::from(a), f64::from(b));
            (((p.min(q)) + 0.5).floor() as i64, ((p.max(q)) + 0.5).floor() as i64)
        };
        let (left, right) = corner(
            (f64::from(ctm.sx) * f64::from(target_x) + f64::from(ctm.tx)) as f32,
            (f64::from(ctm.sx) * f64::from(target_x + target_w) + f64::from(ctm.tx)) as f32,
        );
        let (top, bottom) = corner(
            (f64::from(ctm.sy) * f64::from(target_y) + f64::from(ctm.ty)) as f32,
            (f64::from(ctm.sy) * f64::from(target_y + target_h) + f64::from(ctm.ty)) as f32,
        );
        let (width, height) = (i64::from(self.pixmap.width()), i64::from(self.pixmap.height()));
        let (left, right, top, bottom) = (left.max(0), right.min(width), top.max(0), bottom.min(height));
        if right <= left || bottom <= top {
            return true;
        }
        let (columns, rows) = ((right - left) as u32, (bottom - top) as u32);
        let Some(mut drawn) = Pixmap::new(columns, rows) else { return false };
        let source = image.pixmap();
        let source_width = source.width() as usize;
        let pick = |centre: i64, inverse: f32, shift: f32, low: i32, high: i32| -> usize {
            let position = (centre as f32 + 0.5).mul_add(inverse, shift);
            (position.ceil() as i64 - 1).clamp(i64::from(low), i64::from(high) - 1) as usize
        };
        let columns_at: Vec<usize> = (left..right).map(|x| pick(x, inverse_x, shift_x, x0, x1)).collect();
        let pixels = source.data();
        let target = drawn.data_mut();
        for (row, y) in (top..bottom).enumerate() {
            let from = pick(y, inverse_y, shift_y, y0, y1) * source_width;
            for (column, &x) in columns_at.iter().enumerate() {
                let at = (from + x) * 4;
                let to = (row * columns as usize + column) * 4;
                target[to..to + 4].copy_from_slice(&pixels[at..at + 4]);
            }
        }
        let Some(cover) = Rect::from_xywh(left as f32, top as f32, columns as f32, rows as f32) else { return true };
        let placement = Transform::from_translate(left as f32, top as f32);
        self.draw_with(|pixmap, inner| {
            let paint = Paint {
                shader: Pattern::new(drawn.as_ref(), SpreadMode::Pad, FilterQuality::Nearest, inner.global_alpha, placement),
                blend_mode: inner.composite.blend_mode(),
                anti_alias: false,
                force_hq_pipeline: false,
            };
            pixmap.fill_rect(cover, &paint, Transform::identity(), inner.clip.as_deref());
        });
        true
    }

    /// `getImageData(x, y, w, h)`: straight RGBA; what lies outside the canvas is transparent black.
    pub fn get_image_data(&self, x: i32, y: i32, width: u32, height: u32) -> Result<ImageData, RasterError> {
        let mut out = ImageData::new(width, height)?;
        let (canvas_w, canvas_h) = (self.pixmap.width() as i64, self.pixmap.height() as i64);
        let source = self.pixmap.data();
        let data = out.data_mut();
        for row in 0..i64::from(height) {
            let from_y = i64::from(y) + row;
            if !(0..canvas_h).contains(&from_y) {
                continue;
            }
            for column in 0..i64::from(width) {
                let from_x = i64::from(x) + column;
                if !(0..canvas_w).contains(&from_x) {
                    continue;
                }
                let at = (from_y * canvas_w + from_x) as usize * 4;
                let to = (row * i64::from(width) + column) as usize * 4;
                let alpha = source[at + 3];
                data[to] = unpremultiply(source[at], alpha);
                data[to + 1] = unpremultiply(source[at + 1], alpha);
                data[to + 2] = unpremultiply(source[at + 2], alpha);
                data[to + 3] = alpha;
            }
        }
        Ok(out)
    }

    /// `putImageData(data, dx, dy)` or with a dirty rectangle `(x, y, width, height)` of the image data: the pixels
    /// replace the canvas's (no compositing, no transform, no clip).
    pub fn put_image_data(&mut self, image: &ImageData, dx: i32, dy: i32, dirty: Option<(i32, i32, i32, i32)>) {
        let (image_w, image_h) = (i64::from(image.width()), i64::from(image.height()));
        let (mut x0, mut y0, mut x1, mut y1) = (0_i64, 0_i64, image_w, image_h);
        if let Some((x, y, w, h)) = dirty {
            let (x, y, w, h) = (i64::from(x), i64::from(y), i64::from(w), i64::from(h));
            let (x, w) = if w < 0 { (x + w, -w) } else { (x, w) };
            let (y, h) = if h < 0 { (y + h, -h) } else { (y, h) };
            x0 = x0.max(x);
            y0 = y0.max(y);
            x1 = x1.min(x + w);
            y1 = y1.min(y + h);
        }
        let (canvas_w, canvas_h) = (i64::from(self.pixmap.width()), i64::from(self.pixmap.height()));
        let source = image.data();
        let target = self.pixmap.data_mut();
        for row in y0..y1 {
            let to_y = i64::from(dy) + row;
            if !(0..canvas_h).contains(&to_y) {
                continue;
            }
            for column in x0..x1 {
                let to_x = i64::from(dx) + column;
                if !(0..canvas_w).contains(&to_x) {
                    continue;
                }
                let from = (row * image_w + column) as usize * 4;
                let to = (to_y * canvas_w + to_x) as usize * 4;
                let alpha = source[from + 3];
                target[to] = premultiply(source[from], alpha);
                target[to + 1] = premultiply(source[from + 1], alpha);
                target[to + 2] = premultiply(source[from + 2], alpha);
                target[to + 3] = alpha;
            }
        }
    }

    /// The whole canvas as a picture (straight RGBA).
    pub fn to_image(&self) -> Result<Image, RasterError> {
        let data = self.get_image_data(0, 0, self.width(), self.height())?;
        Image::from_raw(self.width(), self.height(), 4, data.data())
    }

    /// `toBuffer('image/png')`.
    pub fn to_png(&self) -> Result<Vec<u8>, RasterError> {
        self.to_image()?.to_png()
    }

    // ---- text -------------------------------------------------------------------------------------------------

    /// `font = "..."`: false, and the old font kept, when the canvas would refuse the text.
    pub fn set_font(&mut self, css: &str) -> bool {
        match css_font::parse(css) {
            Ok(font) => {
                self.state.font = font;
                self.state.font_text = css.to_owned();
                true
            }
            Err(_) => false,
        }
    }

    pub fn font(&self) -> &str {
        &self.state.font_text
    }

    pub fn set_text_align(&mut self, name: &str) -> bool {
        TextAlign::parse(name).map(|align| self.state.align = align).is_some()
    }

    pub fn set_text_baseline(&mut self, name: &str) -> bool {
        TextBaseline::parse(name).map(|baseline| self.state.baseline = baseline).is_some()
    }

    /// `letterSpacing` in pixels.
    pub fn set_letter_spacing(&mut self, pixels: f32) {
        if pixels.is_finite() {
            self.state.letter_spacing = pixels;
        }
    }

    /// The line of `text` laid out for a draw at `(x, y)`, and the matrix from its own space (the pen at the origin of the
    /// baseline) to user space: aligned, on the chosen baseline and squeezed to `max_width`. `None` when there is nothing
    /// to draw (a maximum width that is not above zero, or a position that is not finite).
    fn text_layout<P: ReadProof>(&self, proof: &P, registry: &Registry, text: &str, x: f32, y: f32, max_width: Option<f32>) -> Result<Option<(text::Laid, Transform)>, RasterError> {
        if !finite(&[x, y]) || max_width.is_some_and(|limit| limit.is_nan() || limit <= 0.0) {
            return Ok(None);
        }
        let laid = text::lay_out(proof, registry, &self.state.font, text, self.state.letter_spacing)?;
        let squeeze = match max_width {
            Some(limit) if laid.width > limit => limit / laid.width,
            _ => 1.0,
        };
        let left = x + self.state.align.shift(laid.width * squeeze);
        let baseline = y + self.state.baseline.shift(laid.ascent, laid.descent);
        Ok(Some((laid, Transform::from_row(squeeze, 0.0, 0.0, 1.0, left, baseline))))
    }

    /// `fillText(text, x, y, maxWidth)`.
    pub fn fill_text<P: ReadProof>(&mut self, proof: &P, registry: &Registry, text: &str, x: f32, y: f32, max_width: Option<f32>) -> Result<(), RasterError> {
        if let Some((laid, local)) = self.text_layout(proof, registry, text, x, y, max_width)? {
            let device = self.state.transform.pre_concat(local);
            let paths = text::device_path(registry, &laid, device, text::Mode::Filled);
            self.draw_with(|pixmap, state| fill_glyphs(pixmap, state, Ink::Fill, &paths));
        }
        Ok(())
    }

    /// `strokeText(text, x, y, maxWidth)`.
    pub fn stroke_text<P: ReadProof>(&mut self, proof: &P, registry: &Registry, text: &str, x: f32, y: f32, max_width: Option<f32>) -> Result<(), RasterError> {
        if let Some((laid, local)) = self.text_layout(proof, registry, text, x, y, max_width)? {
            if let Some(path) = text::device_path(registry, &laid, local, text::Mode::Stroked).sampled {
                // The outline is stroked in user space (the width is in user units) and then moved to the device.
                if let Some(outline) = path.stroke(&make_stroke(&self.state), 1.0).and_then(|stroked| stroked.transform(self.state.transform)) {
                    let paths = text::DevicePaths { exact: None, sampled: Some(outline) };
                    self.draw_with(|pixmap, state| fill_glyphs(pixmap, state, Ink::Stroke, &paths));
                }
            }
        }
        Ok(())
    }

    /// `measureText(text)` with the current font and letter spacing.
    pub fn measure_text<P: ReadProof>(&self, proof: &P, registry: &Registry, text: &str) -> Result<TextMetrics, RasterError> {
        measure::measure_parsed(proof, registry, &self.state.font, text, &MeasureOptions { letter_spacing: self.state.letter_spacing })
            .map_err(|error| RasterError::new(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use mixdog_fsio::Unlaned;

    use super::*;

    fn canvas(width: u32, height: u32) -> Canvas {
        Canvas::new(width, height).expect("a canvas")
    }

    fn px(canvas: &Canvas, x: i32, y: i32) -> [u8; 4] {
        let data = canvas.get_image_data(x, y, 1, 1).expect("a pixel");
        [data.data()[0], data.data()[1], data.data()[2], data.data()[3]]
    }

    fn lisu() -> Registry {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/office-measure/faces/NotoSansLisu-Regular.ttf");
        let mut registry = Registry::new();
        registry.register_file(&Unlaned, &path, Some("Twin Lisu")).expect("the fixture face registers");
        registry
    }

    const LISU_32: &str = "32px \"Twin Lisu\"";

    /// `(left, top, right, bottom)` of the pixels with any ink, exclusive on the far edges.
    fn ink(canvas: &Canvas) -> Option<(u32, u32, u32, u32)> {
        let data = canvas.pixmap().data();
        let width = canvas.width();
        let mut bounds: Option<(u32, u32, u32, u32)> = None;
        for (index, pixel) in data.chunks_exact(4).enumerate() {
            if pixel[3] > 40 {
                let (x, y) = (index as u32 % width, index as u32 / width);
                bounds = Some(match bounds {
                    None => (x, y, x + 1, y + 1),
                    Some((l, t, r, b)) => (l.min(x), t.min(y), r.max(x + 1), b.max(y + 1)),
                });
            }
        }
        bounds
    }

    #[test]
    fn an_empty_size_is_refused() {
        assert!(Canvas::new(0, 5).is_err());
        assert!(Canvas::new(5, 0).is_err());
    }

    #[test]
    fn an_opaque_rectangle_is_exact_inside_and_untouched_outside() {
        let mut canvas = canvas(10, 10);
        assert!(canvas.set_fill_color("#ff0000"));
        canvas.fill_rect(2.0, 2.0, 4.0, 4.0);
        assert_eq!(px(&canvas, 3, 3), [255, 0, 0, 255]);
        assert_eq!(px(&canvas, 1, 3), [0, 0, 0, 0]);
        assert_eq!(px(&canvas, 6, 3), [0, 0, 0, 0]);
        canvas.fill_rect(8.0, 8.0, -3.0, -3.0);
        assert_eq!(px(&canvas, 6, 6), [255, 0, 0, 255], "a negative size covers the rectangle it spans");
        assert!(!canvas.set_fill_color("not a colour"));
        canvas.fill_rect(0.0, 0.0, 1.0, 1.0);
        assert_eq!(px(&canvas, 0, 0), [255, 0, 0, 255], "an unreadable colour keeps the old style");
    }

    #[test]
    fn a_half_covered_pixel_is_half_transparent() {
        let mut canvas = canvas(4, 4);
        canvas.set_fill_color("#000000");
        canvas.begin_path();
        canvas.rect(0.5, 0.0, 1.0, 4.0);
        canvas.fill(FillRule::Winding);
        for x in [0, 1] {
            let alpha = px(&canvas, x, 2)[3];
            assert!((126..=129).contains(&alpha), "column {x}: {alpha}");
        }
        assert_eq!(px(&canvas, 2, 2)[3], 0);
    }

    #[test]
    fn even_odd_leaves_the_inner_square_open() {
        let mut canvas = canvas(12, 12);
        canvas.set_fill_color("#00ff00");
        canvas.begin_path();
        canvas.rect(0.0, 0.0, 12.0, 12.0);
        canvas.rect(3.0, 3.0, 6.0, 6.0);
        canvas.fill(FillRule::EvenOdd);
        assert_eq!(px(&canvas, 1, 1)[3], 255);
        assert_eq!(px(&canvas, 6, 6)[3], 0);
        canvas.begin_path();
        canvas.rect(0.0, 0.0, 12.0, 12.0);
        canvas.rect(3.0, 3.0, 6.0, 6.0);
        canvas.fill(FillRule::Winding);
        assert_eq!(px(&canvas, 6, 6)[3], 255, "the same direction winds twice and is filled");
    }

    #[test]
    fn the_clip_limits_every_later_draw_and_restore_lifts_it() {
        let mut canvas = canvas(10, 10);
        canvas.set_fill_color("blue");
        canvas.save();
        canvas.begin_path();
        canvas.rect(0.0, 0.0, 5.0, 10.0);
        canvas.clip(FillRule::Winding);
        canvas.fill_rect(0.0, 0.0, 10.0, 10.0);
        assert_eq!(px(&canvas, 2, 5), [0, 0, 255, 255]);
        assert_eq!(px(&canvas, 7, 5)[3], 0);
        canvas.restore();
        assert!(canvas.clip_mask().is_none());
        canvas.fill_rect(5.0, 0.0, 5.0, 10.0);
        assert_eq!(px(&canvas, 7, 5), [0, 0, 255, 255]);
        canvas.begin_path();
        canvas.clip(FillRule::Winding);
        canvas.clear_rect(0.0, 0.0, 10.0, 10.0);
        canvas.fill_rect(0.0, 0.0, 10.0, 10.0);
        assert_eq!(px(&canvas, 7, 5), [0, 0, 255, 255], "an empty clip lets nothing through, not even a clear");
    }

    #[test]
    fn save_and_restore_bring_the_state_back() {
        let mut canvas = canvas(4, 4);
        canvas.set_fill_color("#112233");
        canvas.set_line_width(3.0);
        canvas.set_global_alpha(0.25);
        canvas.translate(1.0, 2.0);
        canvas.save();
        canvas.set_fill_color("#ffffff");
        canvas.set_line_width(7.0);
        canvas.set_global_alpha(1.0);
        canvas.reset_transform();
        canvas.restore();
        assert_eq!(canvas.line_width(), 3.0);
        assert_eq!(canvas.global_alpha(), 0.25);
        assert_eq!(canvas.get_transform(), [1.0, 0.0, 0.0, 1.0, 1.0, 2.0]);
        canvas.restore();
        assert_eq!(canvas.line_width(), 3.0, "a restore without a save does nothing");
    }

    #[test]
    fn invalid_values_are_ignored_as_the_canvas_ignores_them() {
        let mut canvas = canvas(2, 2);
        canvas.set_line_width(-1.0);
        canvas.set_line_width(f32::NAN);
        canvas.set_global_alpha(2.0);
        canvas.set_miter_limit(0.0);
        canvas.set_line_dash(&[1.0, -1.0]);
        canvas.set_line_dash(&[2.0, f32::INFINITY]);
        assert_eq!((canvas.line_width(), canvas.global_alpha()), (1.0, 1.0));
        assert!(canvas.line_dash().is_empty());
        canvas.set_line_dash(&[1.0, 2.0, 3.0]);
        assert_eq!(canvas.line_dash(), [1.0, 2.0, 3.0, 1.0, 2.0, 3.0]);
        assert!(!canvas.set_line_cap("flat") && canvas.set_line_cap("round"));
        assert!(!canvas.set_line_join("miter-clip") && canvas.set_line_join("bevel"));
        assert!(!canvas.set_global_composite_operation("over") && canvas.set_global_composite_operation("multiply"));
        assert!(!canvas.set_image_smoothing_quality("best") && canvas.set_image_smoothing_quality("high"));
        assert!(!canvas.set_font("bold") && canvas.set_font("12px serif"));
        assert_eq!(canvas.font(), "12px serif");
        assert!(!canvas.set_text_align("middle") && canvas.set_text_align("center"));
        assert!(!canvas.set_text_baseline("center") && canvas.set_text_baseline("middle"));
        canvas.set_transform(f32::NAN, 0.0, 0.0, 1.0, 0.0, 0.0);
        assert_eq!(canvas.get_transform(), [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn translate_rotate_and_scale_move_what_is_drawn() {
        let mut canvas = canvas(10, 10);
        canvas.set_fill_color("black");
        canvas.translate(5.0, 0.0);
        canvas.fill_rect(0.0, 0.0, 2.0, 2.0);
        assert_eq!(px(&canvas, 5, 0)[3], 255);
        assert_eq!(px(&canvas, 0, 0)[3], 0);
        canvas.reset_transform();
        canvas.rotate(std::f32::consts::FRAC_PI_2);
        canvas.fill_rect(0.0, -4.0, 4.0, 4.0);
        assert_eq!(px(&canvas, 1, 1)[3], 255, "a quarter turn maps x to y and y to minus x");
        canvas.reset_transform();
        canvas.scale(2.0, 2.0);
        canvas.fill_rect(4.0, 4.0, 1.0, 1.0);
        assert_eq!(px(&canvas, 9, 9)[3], 255);
    }

    #[test]
    fn a_point_is_mapped_when_it_is_added_not_when_the_path_is_filled() {
        let mut canvas = canvas(10, 10);
        canvas.set_fill_color("black");
        canvas.begin_path();
        canvas.translate(5.0, 0.0);
        canvas.rect(0.0, 0.0, 2.0, 2.0);
        canvas.reset_transform();
        canvas.fill(FillRule::Winding);
        assert_eq!(px(&canvas, 5, 0)[3], 255);
        assert_eq!(px(&canvas, 0, 0)[3], 0);
    }

    #[test]
    fn global_alpha_scales_the_paint_and_copy_replaces_the_pixels() {
        let mut canvas = canvas(4, 4);
        canvas.set_fill_color("black");
        canvas.fill_rect(0.0, 0.0, 4.0, 4.0);
        canvas.set_fill_color("white");
        canvas.set_global_alpha(0.5);
        canvas.fill_rect(0.0, 0.0, 4.0, 4.0);
        let pixel = px(&canvas, 1, 1);
        assert!((127..=129).contains(&pixel[0]) && pixel[3] == 255, "{pixel:?}");
        canvas.set_global_alpha(1.0);
        canvas.set_global_composite_operation("copy");
        canvas.set_fill_color("#0000ff80");
        canvas.fill_rect(0.0, 0.0, 2.0, 4.0);
        let copied = px(&canvas, 0, 0);
        assert_eq!((copied[2], copied[3]), (255, 128), "copy keeps the source alpha: {copied:?}");
        assert_eq!(px(&canvas, 3, 0)[3], 0, "and clears what the shape does not cover");
    }

    #[test]
    fn composite_operations_combine_with_what_is_there() {
        let mut canvas = canvas(4, 4);
        canvas.set_fill_color("red");
        canvas.fill_rect(0.0, 0.0, 4.0, 4.0);
        canvas.set_global_composite_operation("destination-out");
        canvas.set_fill_color("black");
        canvas.fill_rect(0.0, 0.0, 2.0, 4.0);
        assert_eq!(px(&canvas, 0, 0)[3], 0);
        assert_eq!(px(&canvas, 3, 0), [255, 0, 0, 255]);
        canvas.set_global_composite_operation("destination-over");
        canvas.set_fill_color("blue");
        canvas.fill_rect(0.0, 0.0, 4.0, 4.0);
        assert_eq!(px(&canvas, 0, 0), [0, 0, 255, 255], "drawn behind: it shows where the canvas is clear");
        assert_eq!(px(&canvas, 3, 0), [255, 0, 0, 255]);
        canvas.set_global_composite_operation("lighter");
        canvas.set_fill_color("#00ff00");
        canvas.fill_rect(0.0, 0.0, 4.0, 4.0);
        assert_eq!(px(&canvas, 3, 0), [255, 255, 0, 255]);
    }

    #[test]
    fn clear_rect_clears_through_any_composite_operation() {
        let mut canvas = canvas(4, 4);
        canvas.set_fill_color("red");
        canvas.fill_rect(0.0, 0.0, 4.0, 4.0);
        canvas.set_global_composite_operation("destination-over");
        canvas.clear_rect(1.0, 1.0, 2.0, 2.0);
        assert_eq!(px(&canvas, 1, 1)[3], 0);
        assert_eq!(px(&canvas, 0, 0)[3], 255);
    }

    #[test]
    fn a_stroke_is_as_wide_as_the_line_width_and_follows_the_scale() {
        let mut canvas = canvas(12, 12);
        canvas.set_stroke_color("black");
        canvas.set_line_width(2.0);
        canvas.begin_path();
        canvas.move_to(0.0, 5.0);
        canvas.line_to(12.0, 5.0);
        canvas.stroke();
        assert_eq!(px(&canvas, 6, 4)[3], 255);
        assert_eq!(px(&canvas, 6, 5)[3], 255);
        assert_eq!(px(&canvas, 6, 3)[3], 0);
        assert_eq!(px(&canvas, 6, 6)[3], 0);
        let mut scaled = self::canvas(12, 12);
        scaled.set_stroke_color("black");
        scaled.scale(1.0, 3.0);
        scaled.begin_path();
        scaled.move_to(0.0, 2.0);
        scaled.line_to(12.0, 2.0);
        scaled.stroke();
        assert_eq!(px(&scaled, 6, 5)[3], 255, "a one unit line is three pixels high under a vertical scale of 3");
        assert_eq!(px(&scaled, 6, 6)[3], 255);
        assert_eq!(px(&scaled, 6, 2)[3], 0);
    }

    #[test]
    fn dashes_and_caps_shape_a_stroke() {
        let mut canvas = canvas(12, 12);
        canvas.set_stroke_color("black");
        canvas.set_line_width(2.0);
        canvas.set_line_dash(&[2.0, 2.0]);
        canvas.begin_path();
        canvas.move_to(0.0, 5.0);
        canvas.line_to(12.0, 5.0);
        canvas.stroke();
        assert_eq!(px(&canvas, 1, 5)[3], 255);
        assert_eq!(px(&canvas, 3, 5)[3], 0);
        assert_eq!(px(&canvas, 5, 5)[3], 255);
        canvas.set_line_dash(&[]);
        canvas.set_line_cap("square");
        canvas.begin_path();
        canvas.move_to(4.0, 9.0);
        canvas.line_to(8.0, 9.0);
        canvas.stroke();
        assert_eq!(px(&canvas, 3, 9)[3], 255, "a square cap reaches half a width past the end");
        assert_eq!(px(&canvas, 2, 9)[3], 0);
    }

    #[test]
    fn stroke_rect_draws_the_outline_and_leaves_the_inside() {
        let mut canvas = canvas(12, 12);
        canvas.set_stroke_color("black");
        canvas.set_line_width(2.0);
        canvas.stroke_rect(3.0, 3.0, 6.0, 6.0);
        assert_eq!(px(&canvas, 3, 6)[3], 255);
        assert_eq!(px(&canvas, 6, 6)[3], 0);
        assert_eq!(px(&canvas, 0, 6)[3], 0);
    }

    #[test]
    fn a_linear_gradient_runs_from_its_first_colour_to_its_last() {
        let mut canvas = canvas(20, 1);
        let mut gradient = Gradient::linear(0.0, 0.0, 20.0, 0.0);
        gradient.add_color_stop(0.0, "black").unwrap();
        gradient.add_color_stop(1.0, "white").unwrap();
        canvas.set_fill_style(Style::Gradient(gradient));
        canvas.fill_rect(0.0, 0.0, 20.0, 1.0);
        let (first, middle, last) = (px(&canvas, 0, 0)[0], px(&canvas, 10, 0)[0], px(&canvas, 19, 0)[0]);
        assert!(first < 20 && last > 235, "{first} {last}");
        assert!((110..=145).contains(&middle), "{middle}");
    }

    #[test]
    fn a_radial_gradient_is_centred_where_it_was_asked() {
        let mut canvas = canvas(21, 21);
        let mut gradient = Gradient::radial(10.0, 10.0, 0.0, 10.0, 10.0, 10.0);
        gradient.add_color_stop(0.0, "white").unwrap();
        gradient.add_color_stop(1.0, "black").unwrap();
        canvas.set_fill_style(Style::Gradient(gradient));
        canvas.fill_rect(0.0, 0.0, 21.0, 21.0);
        assert!(px(&canvas, 10, 10)[0] > 235);
        assert!(px(&canvas, 0, 10)[0] < 30);
        assert!(px(&canvas, 10, 10)[0] > px(&canvas, 10, 15)[0]);
    }

    #[test]
    fn a_pattern_repeats_and_a_no_repeat_pattern_stays_in_its_cell() {
        let cell = Bitmap::from_straight(2, 2, &[255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255]).unwrap();
        let mut repeated = canvas(8, 8);
        repeated.set_fill_style(Style::Pattern(PatternStyle::new(&cell, Repetition::Repeat)));
        repeated.fill_rect(0.0, 0.0, 8.0, 8.0);
        assert_eq!(px(&repeated, 0, 0), [255, 0, 0, 255]);
        assert_eq!(px(&repeated, 1, 0), [0, 0, 255, 255]);
        assert_eq!(px(&repeated, 6, 0), [255, 0, 0, 255]);
        assert_eq!(px(&repeated, 7, 7), [255, 0, 0, 255]);
        let mut single = canvas(8, 8);
        single.set_fill_style(Style::Pattern(PatternStyle::new(&cell, Repetition::NoRepeat)));
        single.fill_rect(0.0, 0.0, 8.0, 8.0);
        assert_eq!(px(&single, 1, 1), [255, 0, 0, 255]);
        assert_eq!(px(&single, 5, 5)[3], 0);
        assert_eq!(px(&single, 5, 0)[3], 0);
        let mut across = canvas(8, 8);
        across.set_fill_style(Style::Pattern(PatternStyle::new(&cell, Repetition::RepeatX)));
        across.fill_rect(0.0, 0.0, 8.0, 8.0);
        assert_eq!(px(&across, 6, 0), [255, 0, 0, 255], "repeat-x repeats along its row");
        assert_eq!(px(&across, 7, 1), [255, 0, 0, 255]);
        assert_eq!(px(&across, 6, 5)[3], 0, "and nowhere below it");
    }

    #[test]
    fn draw_image_scales_without_smoothing_and_cuts_to_the_source_rectangle() {
        let picture = Bitmap::from_straight(2, 2, &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]).unwrap();
        let mut canvas = canvas(8, 8);
        canvas.set_image_smoothing_enabled(false);
        canvas.draw_image_scaled(&picture, 0.0, 0.0, 8.0, 8.0);
        assert_eq!(px(&canvas, 1, 1), [255, 0, 0, 255]);
        assert_eq!(px(&canvas, 6, 1), [0, 255, 0, 255]);
        assert_eq!(px(&canvas, 1, 6), [0, 0, 255, 255]);
        assert_eq!(px(&canvas, 6, 6), [255, 255, 255, 255]);
        let mut cut = self::canvas(8, 8);
        cut.set_image_smoothing_enabled(false);
        cut.draw_image_region(&picture, 1.0, 0.0, 1.0, 1.0, 2.0, 2.0, 4.0, 4.0);
        assert_eq!(px(&cut, 3, 3), [0, 255, 0, 255]);
        assert_eq!(px(&cut, 1, 1)[3], 0);
        assert_eq!(px(&cut, 6, 6)[3], 0);
        let mut plain = self::canvas(4, 4);
        plain.draw_image(&picture, 1.0, 1.0);
        assert_eq!(px(&plain, 1, 1), [255, 0, 0, 255]);
        assert_eq!(px(&plain, 2, 2), [255, 255, 255, 255]);
        let mut overhang = self::canvas(8, 8);
        overhang.set_image_smoothing_enabled(false);
        overhang.draw_image_region(&picture, -2.0, 0.0, 4.0, 2.0, 0.0, 0.0, 8.0, 4.0);
        assert_eq!(px(&overhang, 1, 1)[3], 0, "the part of the source outside the image is cut with its destination");
        assert_eq!(px(&overhang, 5, 1), [255, 0, 0, 255]);
    }

    #[test]
    fn a_pixel_centre_on_the_border_of_two_source_pixels_takes_the_earlier_one() {
        // 8 pixels drawn 20 wide (2.5 device pixels each): the centre of device pixel 2 is at 2.5, the border of source
        // pixels 0 and 1, and Skia gives it to pixel 0.
        let pixels: Vec<u8> = (0..8u8).flat_map(|i| [i * 30, 0, 0, 255]).collect();
        let strip = Bitmap::from_straight(8, 1, &pixels).unwrap();
        let mut canvas = canvas(20, 1);
        canvas.set_image_smoothing_enabled(false);
        canvas.draw_image_scaled(&strip, 0.0, 0.0, 20.0, 1.0);
        let reds: Vec<u8> = (0..20).map(|x| px(&canvas, x, 0)[0] / 30).collect();
        assert_eq!(reds, vec![0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 6, 7, 7]);
    }

    #[test]
    fn a_smoothed_tile_is_the_mitchell_filter_of_the_tile_with_its_edge_pixels_repeated() {
        let mut tile = canvas(4, 1);
        tile.set_fill_color("#ffffff");
        tile.fill_rect(1.0, 0.0, 1.0, 1.0);
        let style = PatternStyle::smoothed(&Bitmap::from_canvas(&tile), Repetition::Repeat);
        // One white pixel in a row of transparent ones, filtered along x by 1/18, 16/18, 1/18 and then along y (one row:
        // the edge pixel repeated, so the weights add up to 1).
        let alphas: Vec<u8> = style.pixmap.data().chunks_exact(4).map(|p| p[3]).collect();
        assert_eq!(alphas, vec![14, 227, 14, 0]);
    }

    #[test]
    fn a_canvas_can_be_drawn_onto_another() {
        let mut source = canvas(2, 2);
        source.set_fill_color("#336699");
        source.fill_rect(0.0, 0.0, 2.0, 2.0);
        let mut target = canvas(4, 4);
        target.draw_image(&Bitmap::from_canvas(&source), 1.0, 1.0);
        assert_eq!(px(&target, 1, 1), [0x33, 0x66, 0x99, 255]);
        assert_eq!(px(&target, 0, 0)[3], 0);
    }

    #[test]
    fn image_data_round_trips_with_skias_rounding_and_the_edges_are_transparent() {
        let mut canvas = canvas(3, 2);
        let mut data = ImageData::new(2, 1).unwrap();
        data.data_mut().copy_from_slice(&[200, 100, 50, 255, 200, 100, 50, 128]);
        canvas.put_image_data(&data, 1, 0, None);
        assert_eq!(px(&canvas, 1, 0), [200, 100, 50, 255]);
        let half = px(&canvas, 2, 0);
        assert_eq!(half[3], 128);
        for (got, want) in half.iter().zip([200_u8, 100, 50]) {
            assert!((i32::from(*got) - i32::from(want)).abs() <= 2, "{half:?}");
        }
        assert_eq!(px(&canvas, 0, 0), [0, 0, 0, 0]);
        let around = canvas.get_image_data(-1, -1, 2, 2).unwrap();
        assert_eq!(around.data()[..12], [0; 12]);
        assert_eq!(around.data()[12..], [0, 0, 0, 0], "only the last pixel is on the canvas, and it is clear");
        assert!(canvas.get_image_data(0, 0, 0, 1).is_err());
    }

    #[test]
    fn a_dirty_rectangle_limits_what_put_image_data_writes() {
        let mut canvas = canvas(4, 4);
        let mut data = ImageData::new(4, 1).unwrap();
        for pixel in data.data_mut().chunks_exact_mut(4) {
            pixel.copy_from_slice(&[9, 9, 9, 255]);
        }
        canvas.put_image_data(&data, 0, 2, Some((1, 0, 2, 1)));
        assert_eq!(px(&canvas, 0, 2)[3], 0);
        assert_eq!(px(&canvas, 1, 2)[3], 255);
        assert_eq!(px(&canvas, 2, 2)[3], 255);
        assert_eq!(px(&canvas, 3, 2)[3], 0);
        canvas.put_image_data(&data, 0, 3, Some((2, 0, -2, 1)));
        assert_eq!(px(&canvas, 0, 3)[3], 255, "a negative width covers the pixels to its left");
        assert_eq!(px(&canvas, 1, 3)[3], 255);
        assert_eq!(px(&canvas, 2, 3)[3], 0);
    }

    #[test]
    fn the_png_has_the_canvas_size_and_straight_pixels() {
        let mut canvas = canvas(5, 3);
        canvas.set_fill_color("#ff000080");
        canvas.fill_rect(0.0, 0.0, 5.0, 3.0);
        let decoded = Image::decode(&canvas.to_png().unwrap()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (5, 3));
        let pixel = &decoded.rgba()[..4];
        assert_eq!((pixel[0], pixel[3]), (255, 128));
    }

    #[test]
    fn a_canvas_can_be_reset_and_leaves_its_pixels_to_the_caller() {
        let mut canvas = canvas(3, 3);
        canvas.set_fill_color("red");
        canvas.translate(1.0, 1.0);
        canvas.fill_rect(0.0, 0.0, 2.0, 2.0);
        canvas.pixmap_mut().data_mut()[3] = 255;
        assert_eq!(px(&canvas, 0, 0)[3], 255);
        canvas.reset();
        assert_eq!(px(&canvas, 1, 1)[3], 0);
        assert_eq!(canvas.get_transform(), [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        assert_eq!(canvas.into_pixmap().width(), 3);
    }

    #[test]
    fn text_is_drawn_from_the_baseline_up_in_the_registered_face() {
        let registry = lisu();
        let mut canvas = canvas(60, 50);
        canvas.set_fill_color("black");
        assert!(canvas.set_font(LISU_32));
        canvas.fill_text(&Unlaned, &registry, "H", 10.0, 40.0, None).unwrap();
        let (left, top, right, bottom) = ink(&canvas).expect("ink");
        assert!((bottom as i32 - 40).abs() <= 1, "the glyph stands on the baseline: {bottom}");
        assert!((top as i32 - 16).abs() <= 2, "a cap height of 0.714 em: {top}");
        assert!(left >= 10 && right <= 10 + 26, "{left} {right}");
    }

    #[test]
    fn alignment_baseline_and_max_width_place_the_text() {
        let registry = lisu();
        let width = {
            let mut probe = canvas(10, 10);
            probe.set_font(LISU_32);
            probe.measure_text(&Unlaned, &registry, "H").unwrap().width as f32
        };
        let mut left = canvas(120, 60);
        left.set_font(LISU_32);
        left.fill_text(&Unlaned, &registry, "H", 60.0, 45.0, None).unwrap();
        let (l0, _, r0, _) = ink(&left).unwrap();
        let mut right = canvas(120, 60);
        right.set_font(LISU_32);
        right.set_text_align("right");
        right.fill_text(&Unlaned, &registry, "H", 60.0, 45.0, None).unwrap();
        let (l1, _, r1, _) = ink(&right).unwrap();
        assert!((l0 as f32 - l1 as f32 - width).abs() <= 1.5 && (r0 as f32 - r1 as f32 - width).abs() <= 1.5, "{l0} {l1} {width}");
        let mut middle = canvas(120, 60);
        middle.set_font(LISU_32);
        middle.set_text_baseline("middle");
        middle.fill_text(&Unlaned, &registry, "H", 60.0, 30.0, None).unwrap();
        let (_, top, _, bottom) = ink(&middle).unwrap();
        // The baseline sits (ascent - descent) / 2 = 12.4 below y, so the cap-height glyph spans about 18.6 to 30.0 + 12.4.
        assert!((bottom as f32 - 42.4).abs() <= 1.5 && (top as f32 - 19.6).abs() <= 2.0, "{top} {bottom}");
        let mut squeezed = canvas(120, 60);
        squeezed.set_font(LISU_32);
        squeezed.fill_text(&Unlaned, &registry, "HHH", 10.0, 45.0, Some(30.0)).unwrap();
        let (sl, _, sr, _) = ink(&squeezed).unwrap();
        assert!(sr - sl <= 30, "the text is squeezed into the maximum width: {sl} {sr}");
        let mut none = canvas(20, 20);
        none.set_font("12px \"Twin Lisu\"");
        none.fill_text(&Unlaned, &registry, "H", 1.0, 15.0, Some(0.0)).unwrap();
        assert!(ink(&none).is_none(), "a maximum width of zero draws nothing");
    }

    #[test]
    fn stroked_text_leaves_ink() {
        let registry = lisu();
        let mut canvas = canvas(80, 60);
        canvas.set_font("48px \"Twin Lisu\"");
        canvas.set_stroke_color("black");
        canvas.stroke_text(&Unlaned, &registry, "I", 20.0, 50.0, None).unwrap();
        assert!(ink(&canvas).is_some());
    }

    #[test]
    fn a_missing_font_is_reported_and_korean_text_is_set_when_a_face_has_it() {
        let empty = Registry::new();
        let mut canvas = canvas(20, 20);
        assert!(canvas.fill_text(&Unlaned, &empty, "x", 0.0, 10.0, None).is_err());
        assert!(canvas.measure_text(&Unlaned, &empty, "x").is_err());
        let registry = lisu();
        canvas.set_font("12px \"Twin Lisu\"");
        canvas.fill_text(&Unlaned, &registry, "\u{d55c}\u{ae00}", 1.0, 15.0, None).unwrap();
    }

    #[test]
    fn measure_text_uses_the_current_letter_spacing() {
        let registry = lisu();
        let mut canvas = canvas(4, 4);
        canvas.set_font("20px \"Twin Lisu\"");
        let plain = canvas.measure_text(&Unlaned, &registry, "HH").unwrap().width;
        canvas.set_letter_spacing(2.0);
        let spaced = canvas.measure_text(&Unlaned, &registry, "HH").unwrap().width;
        assert!((spaced - plain - 4.0).abs() < 0.02, "{plain} {spaced}");
    }
}
