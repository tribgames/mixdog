//! `ctx.measureText(text)` of `@napi-rs/canvas`, field for field.
//!
//! What the canvas answers, and how each field is reached here:
//!
//! * `width` is the longest line (a line ends at `\n`) of the shaped advances, summed in `f32`, then rounded to a
//!   hundredth: each glyph advance is the font-unit advance scaled the way FreeType scales it (the size in 26.6, the
//!   scale in 16.16 from it, the advance rounded at 16 bits) plus what the shaper added to it (kerning), scaled the
//!   way HarfBuzz scales it.
//! * `fontBoundingBoxAscent`, `emHeightAscent` and `alphabeticBaseline` are the `hhea` ascender of the face of the
//!   FIRST RUN (not of the first family) at the size, `fontBoundingBoxDescent` and `emHeightDescent` its descender
//!   (positive), each as the `f32` unit value times the size. Empty text measures all zero.
//! * the first run is cut as the paragraph shaper cuts runs: at a change of script, of bidi level (left-to-right
//!   paragraph) and of font resolution, where the characters no face has (their `.notdef`) are runs of their own.
//! * the `actualBoundingBox` fields are those of the first run: left from the first glyph, right from the last glyph's
//!   origin, ascent and descent over its glyphs, each glyph's ink box rounded outwards to whole pixels on the left,
//!   right and top and floored on the bottom. A synthesised italic (an italic request answered by an upright face)
//!   shears the outline by a quarter of its height and is rounded outwards on every side. A synthesised bold, which
//!   widens the ink, is not modelled, and hinting moves the vertical bounds of some glyphs by a pixel in the canvas
//!   (the rasteriser). With letter spacing the left bound gains the spacing and the right bound loses half of it,
//!   except in a cursive script.
//! * a NUL in the text is refused.

use mixdog_fsio::ReadProof;

use crate::css_font::ParsedFont;
use crate::face::FontError;
use crate::face::Slant;
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

/// The scaled advance as FreeType gives it (`linearHoriAdvance`): the size in 26.6 (Skia truncates it), the scale to
/// 16.16 fixed point from it (`FT_DivFix`), the advance as `FT_MulDiv(units, scale, 64)`, all rounded half away from zero; the result is in 16.16 fixed point.
fn scaled_fixed(units: i32, size: f32, units_per_em: u16) -> i64 {
    let upem = i64::from(units_per_em.max(1));
    let size26 = (f64::from(size) * 64.0) as i64;
    let scale = (size26 * 65536 + upem / 2) / upem;
    let product = i64::from(units) * scale;
    if product >= 0 { (product + 32) / 64 } else { -((-product + 32) / 64) }
}

/// A shaper adjustment (a kerning value, a mark offset) scaled as HarfBuzz scales it: the font scale is the size in
/// 16.16 and the multiplier is `(scale << 16) / units_per_em`, the product rounded at 16 bits.
fn shaper_scaled_fixed(units: i32, size: f32, units_per_em: u16) -> i64 {
    let upem = i64::from(units_per_em.max(1));
    let hb_scale = (f64::from(size) * 65536.0).round() as i64;
    let multiplier = (hb_scale << 16) / upem;
    (i64::from(units) * multiplier + 0x8000) >> 16
}

/// The advance of a shaped glyph: the font's own advance as FreeType scales it plus what the shaper added to it (kerning),
/// which HarfBuzz scales on its own; the sum is exact in 16.16.
fn advance_of(face: &ttf_parser::Face<'_>, glyph: &shape::Glyph, size: f32, units_per_em: u16) -> f32 {
    let own = face.glyph_hor_advance(ttf_parser::GlyphId(glyph.glyph_id)).map_or(glyph.x_advance, i32::from);
    let adjustment = glyph.x_advance - own;
    (scaled_fixed(own, size, units_per_em) + shaper_scaled_fixed(adjustment, size, units_per_em)) as f32 / 65536.0
}

fn round_hundredths(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

/// Skia's synthetic italic: the glyph is sheared by a quarter of its height to the right (`SkFont::setSkewX(-1/4)`).
const FAKE_ITALIC_SKEW: f32 = 0.25;

/// The extent of an outline sheared by [`FAKE_ITALIC_SKEW`], in font units: `(min x, max x)`; the curves are followed
/// to their extremes, not only through their control points.
struct SkewedExtent {
    last: (f32, f32),
    min_x: f32,
    max_x: f32,
}

impl SkewedExtent {
    fn at(&mut self, x: f32, y: f32) {
        let sheared = x + FAKE_ITALIC_SKEW * y;
        self.min_x = self.min_x.min(sheared);
        self.max_x = self.max_x.max(sheared);
    }

    fn follow(&mut self, points: &[(f32, f32)]) {
        // Sampled densely: a glyph curve is short and smooth, and its extreme is where the sheared x turns.
        const STEPS: usize = 64;
        let start = self.last;
        for step in 1..=STEPS {
            let t = step as f32 / STEPS as f32;
            let u = 1.0 - t;
            let (x, y) = match points {
                [c, e] => (u * u * start.0 + 2.0 * u * t * c.0 + t * t * e.0, u * u * start.1 + 2.0 * u * t * c.1 + t * t * e.1),
                [c1, c2, e] => (
                    u * u * u * start.0 + 3.0 * u * u * t * c1.0 + 3.0 * u * t * t * c2.0 + t * t * t * e.0,
                    u * u * u * start.1 + 3.0 * u * u * t * c1.1 + 3.0 * u * t * t * c2.1 + t * t * t * e.1,
                ),
                _ => return,
            };
            self.at(x, y);
        }
        if let Some(end) = points.last() {
            self.last = *end;
        }
    }
}

impl ttf_parser::OutlineBuilder for SkewedExtent {
    fn move_to(&mut self, x: f32, y: f32) {
        self.at(x, y);
        self.last = (x, y);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.at(x, y);
        self.last = (x, y);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.follow(&[(x1, y1), (x, y)]);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.follow(&[(x1, y1), (x2, y2), (x, y)]);
    }

    fn close(&mut self) {}
}

/// The ink box of a glyph. With `synthetic_italic` the glyph is sheared first and, being no longer aligned to the pixel
/// grid, is not hinted: every edge is rounded outwards.
fn glyph_ink(face: &ttf_parser::Face<'_>, glyph: u16, size: f32, synthetic_italic: bool) -> Option<Ink> {
    let id = ttf_parser::GlyphId(glyph);
    let bounds = face.glyph_bounding_box(id)?;
    let scale = size / f32::from(face.units_per_em().max(1));
    let per_unit = |value: i16| f32::from(value) * scale;
    if synthetic_italic {
        let mut extent = SkewedExtent { last: (0.0, 0.0), min_x: f32::INFINITY, max_x: f32::NEG_INFINITY };
        face.outline_glyph(id, &mut extent)?;
        return Some(Ink {
            left: (extent.min_x * scale).floor(),
            right: (extent.max_x * scale).ceil(),
            top: per_unit(bounds.y_max).ceil(),
            bottom: (-per_unit(bounds.y_min)).ceil(),
        });
    }
    Some(Ink {
        left: per_unit(bounds.x_min).floor(),
        right: per_unit(bounds.x_max).ceil(),
        top: per_unit(bounds.y_max).ceil(),
        bottom: (-per_unit(bounds.y_min)).floor(),
    })
}

/// One run of the paragraph shaper: one script, one bidi level and one font resolution.
struct Region {
    range: std::ops::Range<usize>,
    rtl: bool,
    /// The face that shapes the run: the first of the chain with a glyph for its characters, else the first (`.notdef`).
    slot: usize,
}

/// True when the run is set in a cursive script, which takes no letter spacing (Skia: Arabic, Hanifi Rohingya, Mandaic,
/// Mongolian, N'Ko, Phags-pa, Syriac).
fn is_cursive(run: &str) -> bool {
    use unicode_script::Script;
    use unicode_script::UnicodeScript;
    run.chars()
        .map(|character| character.script())
        .find(|script| !matches!(script, Script::Common | Script::Inherited | Script::Unknown))
        .is_some_and(|script| {
            matches!(script, Script::Arabic | Script::Hanifi_Rohingya | Script::Mandaic | Script::Mongolian | Script::Nko | Script::Phags_Pa | Script::Syriac)
        })
}

/// Characters the shaper does not take part in the font resolution of (they join the run they are in).
fn is_neutral(character: char) -> bool {
    character.is_control() || matches!(character, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
}

/// Where the paragraph shaper cuts the text into runs: at a change of script, of bidi level (paragraph direction left to
/// right) and of font resolution, where a character no face has is a resolution of its own (its `.notdef`), as the
/// paragraph shaper resolves fonts block by block. Logical order, covering all of the text.
fn regions(chain: &Chain<'_>, text: &str) -> Vec<Region> {
    let levels = unicode_bidi::BidiInfo::new(text, Some(unicode_bidi::Level::ltr())).levels;
    let resolve = |character: char| (0..chain.ids().len()).find(|slot| chain.parsed(*slot).is_some_and(|face| face.glyph_index(character).is_some()));
    let mut out: Vec<Region> = Vec::new();
    // The state of the run being built: its level and its resolution (`None` is unresolved).
    for script_run in shape::runs(text) {
        let mut open: Option<(u8, Option<usize>)> = None;
        for (at, character) in text[script_run.range.clone()].char_indices() {
            let at = script_run.range.start + at;
            let level = levels[at].number();
            let state = match open {
                Some(current) if is_neutral(character) => current,
                _ => (level, resolve(character)),
            };
            if open == Some(state) && out.last().is_some_and(|region| region.range.end == at) {
                if let Some(region) = out.last_mut() {
                    region.range.end = at + character.len_utf8();
                }
            } else {
                out.push(Region { range: at..at + character.len_utf8(), rtl: state.0 % 2 == 1, slot: state.1.unwrap_or(0) });
                open = Some(state);
            }
        }
    }
    out
}

/// The glyphs of the text, the position in the chain of the face of the first run (the font whose metrics the canvas
/// reports), and whether that run is of a cursive script.
fn shape_text(chain: &Chain<'_>, text: &str, font: &ParsedFont, letter_spacing: f32) -> (Vec<Placed>, usize, bool) {
    let size = font.size;
    let registry = chain.registry();
    let faces: Vec<_> = chain.ids().iter().map(|id| crate::shape::hb_face(registry.face(*id), &[])).collect();
    let mut placed = Vec::new();
    let regions = regions(chain, text);
    let first_slot = regions.first().map_or(0, |region| region.slot);
    let first_cursive = regions.first().is_some_and(|region| is_cursive(&text[region.range.clone()]));
    for (run_index, region) in regions.into_iter().enumerate() {
        let (Some(face), Some(parsed)) = (faces[region.slot].as_ref(), chain.parsed(region.slot)) else { continue };
        let units_per_em = parsed.units_per_em();
        // A face that is not italic stands in for an italic request: the canvas shears it.
        let synthetic_italic = font.slant != Slant::Upright && registry.face(chain.ids()[region.slot]).style.slant == Slant::Upright;
        for glyph in shape::shape_run(face, &text[region.range.clone()], region.rtl, region.range.start) {
            placed.push(Placed {
                cluster: glyph.cluster,
                run: run_index,
                advance: advance_of(parsed, &glyph, size, units_per_em) + letter_spacing,
                offset: shaper_scaled_fixed(glyph.x_offset, size, units_per_em) as f32 / 65536.0,
                ink: glyph_ink(parsed, glyph.glyph_id, size, synthetic_italic),
            });
        }
    }
    (placed, first_slot, first_cursive)
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
    if chain.ids().is_empty() {
        return Err(FontError::Unreadable("no font is registered".to_owned()));
    }
    if text.is_empty() {
        return Ok(TextMetrics {
            width: 0.0,
            actual_bounding_box_left: 0.0,
            actual_bounding_box_right: 0.0,
            actual_bounding_box_ascent: 0.0,
            actual_bounding_box_descent: 0.0,
            font_bounding_box_ascent: 0.0,
            font_bounding_box_descent: 0.0,
            alphabetic_baseline: 0.0,
            em_height_ascent: 0.0,
            em_height_descent: 0.0,
        });
    }
    let size = font.size;
    let (placed, first_slot, cursive) = shape_text(&chain, text, font, options.letter_spacing);
    let primary = registry.face(chain.ids()[first_slot]);
    // Skia: the unit metric (the font-unit value over units per em, in f32) times the size.
    let units_per_em = f32::from(primary.units_per_em.max(1));
    let ascent = (f32::from(primary.metrics.ascender) / units_per_em) * size;
    let descent = (-f32::from(primary.metrics.descender) / units_per_em) * size;
    let (mut left, mut right, ink_ascent, ink_descent) = actual_bounds(&placed);
    if !cursive {
        // Skia lays the line out half a letter spacing in and the canvas takes that half off again: the left bound
        // carries the half twice (the line's own and the offset), the right bound only the offset.
        left += options.letter_spacing;
        right -= options.letter_spacing / 2.0;
    }
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
        assert_eq!(scaled_fixed(1479, 16.0, 2048) as f32 / 65536.0, 11.554_687_5);
        assert_eq!(scaled_fixed(1139, 16.0, 2048) as f32 / 65536.0, 8.898_437_5);
        assert_eq!(scaled_fixed(0, 16.0, 2048), 0);
        // The scale is made from the size in 26.6 and rounded at 16 bits, as FreeType does: 305 units at 9 px.
        assert_eq!(scaled_fixed(305, 9.0, 1000), 179_898);
    }

    #[test]
    fn a_shaper_adjustment_is_scaled_on_its_own() {
        // -80 units at 16 px of a 1000-unit em is -1.28 px: HarfBuzz rounds at 16 bits.
        assert_eq!(shaper_scaled_fixed(-80, 16.0, 1000), -83_886);
        assert_eq!(shaper_scaled_fixed(0, 16.0, 1000), 0);
    }

    #[test]
    fn controls_and_format_marks_are_neutral_to_the_run_they_are_in() {
        assert!(is_neutral('\n') && is_neutral('\t') && is_neutral('\u{200b}') && is_neutral('\u{feff}'));
        assert!(!is_neutral('a') && !is_neutral(' ') && !is_neutral('\u{00a0}'));
    }

    #[test]
    fn cursive_scripts_are_found_by_their_first_scripted_character() {
        assert!(is_cursive("مرحبا"));
        assert!(is_cursive("  ܐܒ"));
        assert!(!is_cursive("Hello"));
        assert!(!is_cursive("  123"));
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
