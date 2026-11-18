//! Text on the canvas: `fillText`, `strokeText` and `measureText` through the font stack of `mixdog-fonts`.
//!
//! A string is cut into runs of one script, each character is set in the first face of the font's family list that
//! has it, the run is shaped by the same HarfBuzz port `measureText` uses, and every glyph is drawn the way Skia draws a
//! glyph through FreeType (what `@napi-rs/canvas` does on Windows): the pen of a glyph is snapped on the device (a quarter
//! of a pixel across, a whole pixel down), the outline is grid-fitted vertically by the auto-hinter in its light mode
//! (`mixdog_fonts::autohint`) when the matrix keeps the axes, the coverage is the exact pixel area FreeType's rasteriser
//! leaves and goes through Skia's luminance-dependent glyph pre-blend (`glyph.rs`). A bold weight asked of a face that
//! is not bold is drawn stroked and filled (Skia's fake bold, rendered as a path), an italic asked of an upright face
//! is sheared by a quarter of its height and not hinted, and the glyphs of `strokeText` are stroked paths. The ideographs and
//! Hangul, which FreeType's auto-hinter treats with a module of its own, are not grid-fitted.
//!
//! `textBaseline` shifts the baseline by the metrics `measureText` reports (the first face's ascent and descent):
//! `middle` by half their difference, `hanging` by 0.8 of the ascent, `ideographic` and `bottom` by the descent,
//! `top` by the ascent (the offsets `@napi-rs/canvas` uses for `middle`, `hanging` and `ideographic` were measured
//! exactly; for `top` and `bottom` the canvas answers a font-specific value that follows from no metric of the face,
//! and the ascent and descent stand in).

use mixdog_fonts::autohint;
use mixdog_fonts::css_font::ParsedFont;
use mixdog_fonts::face::Slant;
use mixdog_fonts::matching::Chain;
use mixdog_fonts::registry::FaceId;
use mixdog_fonts::registry::Registry;
use mixdog_fonts::shape;
use mixdog_fsio::ReadProof;
use tiny_skia::LineCap;
use tiny_skia::LineJoin;
use tiny_skia::Path;
use tiny_skia::PathBuilder;
use tiny_skia::Stroke;
use tiny_skia::Transform;

use super::glyph;

use crate::RasterError;

/// `textAlign`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TextAlign {
    #[default]
    Start,
    End,
    Left,
    Right,
    Center,
}

impl TextAlign {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "start" => Some(Self::Start),
            "end" => Some(Self::End),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            "center" => Some(Self::Center),
            _ => None,
        }
    }

    /// How far left of the given x the text starts, for a text `width` wide (the direction is always left to right).
    pub(crate) fn shift(self, width: f32) -> f32 {
        match self {
            Self::Start | Self::Left => 0.0,
            Self::End | Self::Right => -width,
            Self::Center => -width / 2.0,
        }
    }
}

/// `textBaseline`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TextBaseline {
    Top,
    Hanging,
    Middle,
    #[default]
    Alphabetic,
    Ideographic,
    Bottom,
}

impl TextBaseline {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "top" => Some(Self::Top),
            "hanging" => Some(Self::Hanging),
            "middle" => Some(Self::Middle),
            "alphabetic" => Some(Self::Alphabetic),
            "ideographic" => Some(Self::Ideographic),
            "bottom" => Some(Self::Bottom),
            _ => None,
        }
    }

    /// How far below the given y the alphabetic baseline is drawn.
    pub(crate) fn shift(self, ascent: f32, descent: f32) -> f32 {
        match self {
            Self::Alphabetic => 0.0,
            Self::Top => ascent,
            Self::Hanging => ascent * 0.8,
            Self::Middle => (ascent - descent) / 2.0,
            Self::Ideographic | Self::Bottom => -descent,
        }
    }
}

/// One glyph of a laid-out line: which face and glyph, where its pen stands on the baseline (the advance of the glyphs
/// before it plus the shaper's offset), and what the canvas does to its outline.
pub(crate) struct LaidGlyph {
    pub face: FaceId,
    pub glyph: u16,
    /// The pen position on the baseline, in pixels at the font's size.
    pub x: f32,
    /// The shaper's vertical offset (up is positive).
    pub y: f32,
    /// Pixels per font unit at the font's size.
    pub scale: f32,
    /// A bold weight was asked of a face that is not bold: the canvas emboldens the outline (`FT_Outline_Embolden`).
    pub embolden: bool,
    /// An italic was asked of an upright face: the canvas shears the outline by a quarter of its height.
    pub skew: bool,
    /// The auto-hinter grid-fits this glyph (every script but the ideographs and Hangul).
    pub hint: autohint::Script,
}

/// A line of text laid out at the origin of its baseline, y growing downwards.
pub(crate) struct Laid {
    pub glyphs: Vec<LaidGlyph>,
    /// The sum of the advances, letter spacing included.
    pub width: f32,
    pub ascent: f32,
    pub descent: f32,
}

/// How the outlines of a laid-out line are turned into a device path.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// Glyphs placed as Skia's glyph masks are: the pen snapped on the device, emboldened and sheared where asked.
    Filled,
    /// Glyphs stroked as paths: placed exactly, in the space of the matrix.
    Stroked,
}

/// The outlines of a laid-out line on the device, in the two ways Skia turns an outline into coverage: the glyphs FreeType
/// renders itself (exact pixel areas) and the glyphs Skia renders as paths (4x supersampled), which are the emboldened ones
/// and every glyph of stroked text.
pub(crate) struct DevicePaths {
    pub exact: Option<Path>,
    pub sampled: Option<Path>,
}

/// The outlines of `laid` on the device through `matrix` (text space to device). A filled line is placed as Skia's glyph
/// masks are and, when the matrix keeps the axes, grid-fitted vertically by the auto-hinter at the device size.
pub(crate) fn device_path(registry: &Registry, laid: &Laid, matrix: Transform, mode: Mode) -> DevicePaths {
    let axis_aligned = matrix.kx == 0.0 && matrix.ky == 0.0 && mode == Mode::Filled;
    let mut exact = PathBuilder::new();
    let mut sampled = PathBuilder::new();
    for glyph in &laid.glyphs {
        let face = registry.face(glyph.face);
        let Some(parsed) = face.parsed() else { continue };
        let (mut ox, mut oy) = (glyph.x * matrix.sx + (-glyph.y) * matrix.kx + matrix.tx, glyph.x * matrix.ky + (-glyph.y) * matrix.sy + matrix.ty);
        if mode == Mode::Filled {
            (ox, oy) = glyph::snap_origin(ox, oy, axis_aligned);
        }
        let scale = glyph.scale;
        let upem = f32::from(parsed.units_per_em().max(1));
        let hinted = if axis_aligned && !glyph.skew && matrix.sy > 0.0 && matrix.sx > 0.0 {
            let ppem = |pixels: f32| (f64::from(pixels) * 64.0) as i64;
            let (px, py) = (ppem(scale * upem * matrix.sx), ppem(scale * upem * matrix.sy));
            autohint::metrics_of(face).and_then(|metrics| metrics.hint_script(&parsed, glyph.glyph, px, py, glyph.hint))
        } else {
            None
        };
        // Contours in device pixels relative to the pen, y up.
        let contours: Vec<glyph::Contour> = match hinted {
            Some(hinted) => hinted.contours,
            None => {
                let skew = if glyph.skew { 0.25 } else { 0.0 };
                let Some(outline) = autohint::scaled_outline(&parsed, glyph.glyph, 1.0, 1.0) else { continue };
                outline
                    .contours
                    .into_iter()
                    .map(|contour| {
                        contour
                            .into_iter()
                            .map(|(x, y, tag)| {
                                let (tx, ty) = ((x + skew * y) * scale, -y * scale);
                                (tx * matrix.sx + ty * matrix.kx, -(tx * matrix.ky + ty * matrix.sy), tag)
                            })
                            .collect()
                    })
                    .collect()
            }
        };
        if glyph.embolden && mode == Mode::Filled {
            // Stroked and filled: the glyph grows by half the stroke's width on every side.
            let mut single = PathBuilder::new();
            glyph::into_path(&contours, &mut single, |(x, y)| (ox + x, oy - y));
            if let Some(outline) = single.finish() {
                let stroke = Stroke { width: mixdog_fonts::measure::fake_bold_width(scale * upem) * matrix.sy.abs(), miter_limit: 4.0, line_join: LineJoin::Miter, line_cap: LineCap::Butt, dash: None };
                if let Some(grown) = outline.stroke(&stroke, 1.0) {
                    sampled.push_path(&grown);
                }
                sampled.push_path(&outline);
            }
            continue;
        }
        let target = if mode == Mode::Stroked { &mut sampled } else { &mut exact };
        glyph::into_path(&contours, target, |(x, y)| (ox + x, oy - y));
    }
    DevicePaths { exact: exact.finish(), sampled: sampled.finish() }
}

/// Lays `text` out in `font`: the glyphs with the pen position of each, and the advance. An error when no face is
/// registered (nothing can be set) or the text holds a NUL (the canvas refuses it).
pub(crate) fn lay_out<P: ReadProof>(proof: &P, registry: &Registry, font: &ParsedFont, text: &str, letter_spacing: f32) -> Result<Laid, RasterError> {
    if text.contains('\0') {
        return Err(RasterError::new("Convert String to CString failed"));
    }
    let chain = Chain::new(proof, registry, font);
    let Some(primary) = chain.ids().first().map(|id| registry.face(*id)) else {
        return Err(RasterError::new(mixdog_fonts::NO_FONT_REGISTERED));
    };
    let size = font.size;
    let per_unit = size / f32::from(primary.units_per_em.max(1));
    let ascent = f32::from(primary.metrics.ascender) * per_unit;
    let descent = -f32::from(primary.metrics.descender) * per_unit;
    let faces: Vec<_> = chain.ids().iter().map(|id| shape::hb_face(registry.face(*id), &[])).collect();
    let mut glyphs = Vec::new();
    let mut pen = 0.0_f32;
    for script_run in shape::runs(text) {
        let run_text = &text[script_run.range.clone()];
        let slots: Vec<(usize, usize)> = run_text.char_indices().map(|(at, character)| (at, chain.slot_for(character))).collect();
        let mut index = 0;
        while index < slots.len() {
            let (at, slot) = slots[index];
            let mut next = index + 1;
            while next < slots.len() && slots[next].1 == slot {
                next += 1;
            }
            let end = slots.get(next).map_or(run_text.len(), |(next_at, _)| *next_at);
            index = next;
            let (Some(face), Some(parsed)) = (faces[slot].as_ref(), chain.parsed(slot)) else { continue };
            let scale = size / f32::from(parsed.units_per_em().max(1));
            let style = registry.face(chain.ids()[slot]).style;
            let embolden = font.weight >= 600 && style.weight < 600;
            let skew = font.slant != Slant::Upright && style.slant == Slant::Upright;
            for glyph in shape::shape_run(face, &run_text[at..end], script_run.rtl, script_run.range.start + at) {
                let character = text[glyph.cluster..].chars().next();
                if !matches!(character, Some('\n' | '\r')) {
                    glyphs.push(LaidGlyph {
                        face: chain.ids()[slot],
                        glyph: glyph.glyph_id,
                        x: pen + glyph.x_offset as f32 * scale,
                        y: glyph.y_offset as f32 * scale,
                        scale,
                        embolden,
                        skew,
                        hint: character.map_or(autohint::Script::Latin, autohint::script_of),
                    });
                }
                pen += glyph.x_advance as f32 * scale + letter_spacing;
            }
        }
    }
    Ok(Laid { glyphs, width: pen, ascent, descent })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alignment_and_baseline_names_parse_and_shift() {
        assert_eq!(TextAlign::parse("center"), Some(TextAlign::Center));
        assert_eq!(TextAlign::parse("Center"), None);
        assert_eq!(TextAlign::Left.shift(40.0), 0.0);
        assert_eq!(TextAlign::Start.shift(40.0), 0.0);
        assert_eq!(TextAlign::Right.shift(40.0), -40.0);
        assert_eq!(TextAlign::End.shift(40.0), -40.0);
        assert_eq!(TextAlign::Center.shift(40.0), -20.0);
        assert_eq!(TextBaseline::parse("middle"), Some(TextBaseline::Middle));
        assert_eq!(TextBaseline::parse("nope"), None);
    }

    #[test]
    fn baselines_move_by_the_measured_offsets() {
        let (ascent, descent) = (213.8_f32, 58.6_f32);
        assert_eq!(TextBaseline::Alphabetic.shift(ascent, descent), 0.0);
        assert!((TextBaseline::Middle.shift(ascent, descent) - 77.6).abs() < 1e-3);
        assert!((TextBaseline::Hanging.shift(ascent, descent) - 171.04).abs() < 1e-3);
        assert!((TextBaseline::Ideographic.shift(ascent, descent) + 58.6).abs() < 1e-3);
    }

    #[test]
    fn text_without_a_registered_font_is_an_error_not_a_blank() {
        let registry = Registry::new();
        let font = mixdog_fonts::css_font::parse("12px Arial").unwrap();
        let error = lay_out(&mixdog_fsio::Unlaned, &registry, &font, "x", 0.0).err().expect("an error");
        assert_eq!(error.message(), mixdog_fonts::NO_FONT_REGISTERED);
        let nul = lay_out(&mixdog_fsio::Unlaned, &registry, &font, "a\0", 0.0).err().expect("an error");
        assert_eq!(nul.message(), "Convert String to CString failed");
    }
}
