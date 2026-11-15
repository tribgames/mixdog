//! `ctx.measureText(text)` of `@napi-rs/canvas`, field for field.
//!
//! What the canvas answers, and how each field is reached here:
//!
//! * `width` is the longest line (a line ends at `\n`) of the shaped advances, summed in `f32`, then rounded to a
//!   hundredth: each glyph advance is the font-unit advance scaled to the size in 16.16 fixed point, as FreeType
//!   scales it.
//! * `fontBoundingBoxAscent`, `emHeightAscent` and `alphabeticBaseline` are the `hhea` ascender of the first matched
//!   face at the size, `fontBoundingBoxDescent` and `emHeightDescent` its descender (positive).
//! * the `actualBoundingBox` fields are those of the first shaped run (one script, one face): left from the first
//!   glyph, right from the last glyph's origin, ascent and descent over its glyphs, each glyph's ink box rounded
//!   outwards to whole pixels on the left, right and top and floored on the bottom. A synthesised bold or italic, which
//!   widens the ink, is not modelled, and hinting moves the vertical bounds of some glyphs (accented capitals) by a
//!   pixel in the canvas.
//! * a NUL in the text is refused.

use mixdog_fsio::ReadProof;

use crate::css_font::ParsedFont;
use crate::face::FontError;
use crate::matching::Chain;
use crate::registry::FaceId;
use crate::registry::Registry;
use crate::shape;

/// The fields of the canvas `TextMetrics` the canvas fills in (it has no hanging or ideographic baseline).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextMetrics {
    pub width: f64,
    pub actual_bounding_box_left: f64,
    pub actual_bounding_box_right: f64,
    pub actual_bounding_box_ascent: f64,
    pub actual_bounding_box_descent: f64,
    pub font_bounding_box_ascent: f64,
    pub font_bounding_box_descent: f64,
    pub alphabetic_baseline: f64,
    pub em_height_ascent: f64,
    pub em_height_descent: f64,
}

/// What `measureText` reads besides the font and the text.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MeasureOptions {
    /// `ctx.letterSpacing` in pixels, added after every glyph.
    pub letter_spacing: f32,
}

/// The ink box of one glyph in pixels, rounded outwards on the left, right and top, floored on the bottom.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Ink {
    left: f32,
    right: f32,
    top: f32,
    bottom: f32,
}

struct Placed {
    /// Byte offset of the glyph's cluster in the text.
    cluster: usize,
    run: usize,
    advance: f32,
    offset: f32,
    ink: Option<Ink>,
}

/// The scaled advance as FreeType gives it: the product to 16.16 fixed point.
fn scaled(units: i32, size: f32, units_per_em: u16) -> f32 {
    let exact = f64::from(units) * f64::from(size) / f64::from(units_per_em.max(1));
    ((exact * 65536.0).round() / 65536.0) as f32
}

fn round_hundredths(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

fn glyph_ink(face: &ttf_parser::Face<'_>, glyph: u16, size: f32) -> Option<Ink> {
    let bounds = face.glyph_bounding_box(ttf_parser::GlyphId(glyph))?;
    let per_unit = |value: i16| f32::from(value) * size / f32::from(face.units_per_em().max(1));
    Some(Ink {
        left: per_unit(bounds.x_min).floor(),
        right: per_unit(bounds.x_max).ceil(),
        top: per_unit(bounds.y_max).ceil(),
        bottom: (-per_unit(bounds.y_min)).floor(),
    })
}

fn shape_text(chain: &Chain<'_>, text: &str, size: f32, letter_spacing: f32) -> Vec<Placed> {
    let registry = chain.registry();
    let faces: Vec<_> = chain.ids().iter().map(|id| crate::shape::hb_face(registry.face(*id), &[])).collect();
    let mut placed = Vec::new();
    let mut run_index = 0;
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
            let units_per_em = parsed.units_per_em();
            for glyph in shape::shape_run(face, &run_text[at..end], script_run.rtl, script_run.range.start + at) {
                placed.push(Placed {
                    cluster: glyph.cluster,
                    run: run_index,
                    advance: scaled(glyph.x_advance, size, units_per_em) + letter_spacing,
                    offset: scaled(glyph.x_offset, size, units_per_em),
                    ink: glyph_ink(parsed, glyph.glyph_id, size),
                });
            }
            run_index += 1;
        }
    }
    placed
}

/// The widest line: the glyphs between two `\n` summed in order, the `\n` glyph itself left out.
fn longest_line(text: &str, placed: &[Placed]) -> f32 {
    let breaks: Vec<usize> = text.match_indices('\n').map(|(at, _)| at).collect();
    let mut lines = vec![0.0_f32; breaks.len() + 1];
    for glyph in placed {
        if text[glyph.cluster..].starts_with('\n') {
            continue;
        }
        lines[breaks.partition_point(|at| *at < glyph.cluster)] += glyph.advance;
    }
    lines.into_iter().fold(0.0, f32::max)
}

/// `(left, right, ascent, descent)` of the first run's glyphs, which come first in `placed`.
fn actual_bounds(placed: &[Placed]) -> (f32, f32, f32, f32) {
    let first_run: Vec<&Placed> = placed.iter().take_while(|glyph| glyph.run == 0).collect();
    let (Some(first), Some(last)) = (first_run.first(), first_run.last()) else { return (0.0, 0.0, 0.0, 0.0) };
    let mut origin = 0.0_f32;
    let mut last_origin = 0.0_f32;
    let (mut ascent, mut descent) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
    for glyph in &first_run {
        last_origin = origin + glyph.offset;
        if let Some(ink) = glyph.ink {
            ascent = ascent.max(ink.top);
            descent = descent.max(ink.bottom);
        }
        origin += glyph.advance;
    }
    let left = first.ink.map_or(0.0, |ink| -ink.left + 0.0);
    let right = last_origin + last.ink.map_or(0.0, |ink| ink.right);
    (left, right, if ascent.is_finite() { ascent } else { 0.0 }, if descent.is_finite() { descent } else { 0.0 })
}

/// `measureText` for a parsed font.
pub fn measure_parsed<P: ReadProof>(
    proof: &P,
    registry: &Registry,
    font: &ParsedFont,
    text: &str,
    options: &MeasureOptions,
) -> Result<TextMetrics, FontError> {
    if text.contains('\0') {
        return Err(FontError::InvalidText);
    }
    let chain = Chain::new(proof, registry, font);
    let Some(primary) = chain.ids().first().map(|id| registry.face(*id)) else {
        return Err(FontError::Unreadable("no font is registered".to_owned()));
    };
    let size = font.size;
    let units_per_em = f32::from(primary.units_per_em.max(1));
    let ascent = f32::from(primary.metrics.ascender) * size / units_per_em;
    let descent = -f32::from(primary.metrics.descender) * size / units_per_em;
    let placed = shape_text(&chain, text, size, options.letter_spacing);
    let (left, right, ink_ascent, ink_descent) = actual_bounds(&placed);
    Ok(TextMetrics {
        width: f64::from(round_hundredths(longest_line(text, &placed))),
        actual_bounding_box_left: f64::from(left),
        actual_bounding_box_right: f64::from(right),
        actual_bounding_box_ascent: f64::from(ink_ascent),
        actual_bounding_box_descent: f64::from(ink_descent),
        font_bounding_box_ascent: f64::from(ascent),
        font_bounding_box_descent: f64::from(descent),
        alphabetic_baseline: f64::from(ascent),
        em_height_ascent: f64::from(ascent),
        em_height_descent: f64::from(descent),
    })
}

/// `ctx.font = font; ctx.measureText(text)`.
pub fn measure_text<P: ReadProof>(proof: &P, registry: &Registry, font: &str, text: &str) -> Result<TextMetrics, FontError> {
    measure_parsed(proof, registry, &crate::css_font::parse(font)?, text, &MeasureOptions::default())
}

/// The face that sets each character of `text` for `font`.
pub fn faces_of<P: ReadProof>(proof: &P, registry: &Registry, font: &str, text: &str) -> Result<Vec<(char, FaceId)>, FontError> {
    let parsed = crate::css_font::parse(font)?;
    let chain = Chain::new(proof, registry, &parsed);
    if chain.is_empty() {
        return Err(FontError::Unreadable("no font is registered".to_owned()));
    }
    Ok(text.chars().map(|character| (character, chain.ids()[chain.slot_for(character)])).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_fsio::Unlaned;

    fn placed(run: usize, cluster: usize, advance: f32, ink: Option<Ink>) -> Placed {
        Placed { cluster, run, advance, offset: 0.0, ink }
    }

    fn ink(left: f32, right: f32, top: f32, bottom: f32) -> Option<Ink> {
        Some(Ink { left, right, top, bottom })
    }

    #[test]
    fn advances_are_scaled_to_sixteenth_sixteen_fixed_point() {
        assert_eq!(scaled(1479, 16.0, 2048), 11.554_687_5);
        assert_eq!(scaled(1139, 16.0, 2048), 8.898_437_5);
        assert_eq!(scaled(0, 16.0, 2048), 0.0);
    }

    #[test]
    fn a_width_is_rounded_to_a_hundredth() {
        assert_eq!(round_hundredths(36.4609), 36.46);
        assert_eq!(round_hundredths(11.5547), 11.55);
        assert_eq!(round_hundredths(102.25), 102.25);
    }

    #[test]
    fn the_longest_line_leaves_the_newline_glyph_out() {
        let glyphs = [placed(0, 0, 8.9, None), placed(0, 1, 12.0, None), placed(0, 2, 8.9, None)];
        assert!((longest_line("a\nb", &glyphs) - 8.9).abs() < 1e-5);
        let glyphs = [placed(0, 0, 8.9, None), placed(0, 1, 12.0, None), placed(0, 2, 12.0, None), placed(0, 3, 8.9, None)];
        assert!((longest_line("a\r\nb", &glyphs) - 20.9).abs() < 1e-5);
        assert_eq!(longest_line("", &[]), 0.0);
    }

    #[test]
    fn the_ink_is_the_first_run_left_of_the_first_glyph_and_right_of_the_last() {
        // "Hello " at 16 px in Arial: H e l l o space; the space has no ink.
        let glyphs = [
            placed(0, 0, 11.554_687_5, ink(1.0, 11.0, 12.0, 0.0)),
            placed(0, 1, 8.898_437_5, ink(0.0, 9.0, 9.0, 0.0)),
            placed(0, 2, 3.554_687_5, ink(1.0, 3.0, 12.0, 0.0)),
            placed(0, 3, 3.554_687_5, ink(1.0, 3.0, 12.0, 0.0)),
            placed(0, 4, 8.898_437_5, ink(0.0, 9.0, 9.0, 0.0)),
            placed(0, 5, 4.445_312_5, None),
            placed(1, 6, 12.0, ink(0.0, 10.0, 10.0, 0.0)),
        ];
        let (left, right, ascent, descent) = actual_bounds(&glyphs);
        assert_eq!((left, ascent, descent), (-1.0, 12.0, 0.0));
        assert!((right - 36.460_94).abs() < 1e-3, "{right}");
        assert_eq!(actual_bounds(&[]), (0.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn nul_text_is_refused_and_an_empty_registry_answers_an_error() {
        let registry = Registry::new();
        assert_eq!(measure_text(&Unlaned, &registry, "16px Arial", "a\0b"), Err(FontError::InvalidText));
        assert!(matches!(measure_text(&Unlaned, &registry, "16px Arial", "ab"), Err(FontError::Unreadable(_))));
        assert_eq!(measure_text(&Unlaned, &registry, "Arial", "ab"), Err(FontError::InvalidFont("Arial".to_owned())));
    }
}
