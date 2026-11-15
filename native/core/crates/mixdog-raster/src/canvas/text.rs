//! Text on the canvas: `fillText`, `strokeText` and `measureText` through the font stack of `mixdog-fonts`.
//!
//! A string is cut into runs of one script, each character is set in the first face of the font's family list that
//! has it, the run is shaped by the same HarfBuzz port `measureText` uses, and every glyph is drawn as its outline,
//! scaled to the size and placed at the shaped position (the advance and the offsets of the shaper, plus the letter
//! spacing after every glyph). The outlines are filled as paths: no hinting and no sub-pixel glyph cache, so edges
//! differ slightly from Skia's glyph masks. A weight or slant the matched face does not have is not synthesised.
//!
//! `textBaseline` shifts the baseline by the metrics `measureText` reports (the first face's ascent and descent):
//! `middle` by half their difference, `hanging` by 0.8 of the ascent, `ideographic` and `bottom` by the descent,
//! `top` by the ascent (the offsets `@napi-rs/canvas` uses for `middle`, `hanging` and `ideographic` were measured
//! exactly; for `top` and `bottom` the canvas answers a font-specific value that follows from no metric of the face,
//! and the ascent and descent stand in).

use mixdog_fonts::css_font::ParsedFont;
use mixdog_fonts::matching::Chain;
use mixdog_fonts::registry::Registry;
use mixdog_fonts::shape;
use mixdog_fsio::ReadProof;
use tiny_skia::Path;
use tiny_skia::PathBuilder;
use ttf_parser::GlyphId;
use ttf_parser::OutlineBuilder;

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

/// A line of text laid out at the origin of its baseline, y growing downwards.
pub(crate) struct Laid {
    /// The glyph outlines, `None` when nothing in the text has ink.
    pub path: Option<Path>,
    /// The sum of the advances, letter spacing included.
    pub width: f32,
    pub ascent: f32,
    pub descent: f32,
}

/// Collects a glyph outline, scaled and flipped into canvas space, into a shared builder.
struct Outline<'a> {
    builder: &'a mut PathBuilder,
    scale: f32,
    x: f32,
    y: f32,
}

impl Outline<'_> {
    fn at(&self, x: f32, y: f32) -> (f32, f32) {
        (self.x + x * self.scale, self.y - y * self.scale)
    }
}

impl OutlineBuilder for Outline<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.builder.move_to(x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.builder.line_to(x, y);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (x1, y1) = self.at(x1, y1);
        let (x, y) = self.at(x, y);
        self.builder.quad_to(x1, y1, x, y);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (x1, y1) = self.at(x1, y1);
        let (x2, y2) = self.at(x2, y2);
        let (x, y) = self.at(x, y);
        self.builder.cubic_to(x1, y1, x2, y2, x, y);
    }

    fn close(&mut self) {
        self.builder.close();
    }
}

/// Lays `text` out in `font`: the outlines of its glyphs from the origin of the baseline, and its advance. An error
/// when no face is registered (nothing can be set) or the text holds a NUL (the canvas refuses it).
pub(crate) fn lay_out<P: ReadProof>(proof: &P, registry: &Registry, font: &ParsedFont, text: &str, letter_spacing: f32) -> Result<Laid, RasterError> {
    if text.contains('\0') {
        return Err(RasterError::new("Convert String to CString failed"));
    }
    let chain = Chain::new(proof, registry, font);
    let Some(primary) = chain.ids().first().map(|id| registry.face(*id)) else {
        return Err(RasterError::new("no font is registered"));
    };
    let size = font.size;
    let per_unit = size / f32::from(primary.units_per_em.max(1));
    let ascent = f32::from(primary.metrics.ascender) * per_unit;
    let descent = -f32::from(primary.metrics.descender) * per_unit;
    let faces: Vec<_> = chain.ids().iter().map(|id| shape::hb_face(registry.face(*id), &[])).collect();
    let mut builder = PathBuilder::new();
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
            for glyph in shape::shape_run(face, &run_text[at..end], script_run.rtl, script_run.range.start + at) {
                let character = text[glyph.cluster..].chars().next();
                if !matches!(character, Some('\n' | '\r')) {
                    let mut outline = Outline {
                        builder: &mut builder,
                        scale,
                        x: pen + glyph.x_offset as f32 * scale,
                        y: -(glyph.y_offset as f32) * scale,
                    };
                    let _ = parsed.outline_glyph(GlyphId(glyph.glyph_id), &mut outline);
                }
                pen += glyph.x_advance as f32 * scale + letter_spacing;
            }
        }
    }
    Ok(Laid { path: builder.finish(), width: pen, ascent, descent })
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
        assert_eq!(error.message(), "no font is registered");
        let nul = lay_out(&mixdog_fsio::Unlaned, &registry, &font, "a\0", 0.0).err().expect("an error");
        assert_eq!(nul.message(), "Convert String to CString failed");
    }
}
