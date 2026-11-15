//! Shaping with rustybuzz, a port of HarfBuzz, with HarfBuzz's default features (kern, liga, clig, ccmp, locl, mark,
//! mkmk, rlig, calt and the ones each script adds), which is what Skia's shaper asks for.
//!
//! Text is cut into runs of one script and one direction before it is shaped, as the paragraph shaper does: the
//! characters that belong to no script (spaces, digits, punctuation) join the run they follow, or the run after them
//! at the start of the text.

use std::ops::Range;

use rustybuzz::UnicodeBuffer;
use unicode_script::Script;
use unicode_script::UnicodeScript;

use crate::face::Face;

/// One shaped glyph, in font units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Glyph {
    pub glyph_id: u16,
    /// Byte offset in the shaped text of the first character of the glyph's cluster.
    pub cluster: usize,
    pub x_advance: i32,
    pub y_advance: i32,
    pub x_offset: i32,
    pub y_offset: i32,
}

/// A run of one script and one direction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub range: Range<usize>,
    pub rtl: bool,
}

fn is_rtl(script: Script) -> bool {
    matches!(
        script,
        Script::Arabic
            | Script::Hebrew
            | Script::Syriac
            | Script::Thaana
            | Script::Nko
            | Script::Adlam
            | Script::Mandaic
            | Script::Samaritan
            | Script::Hanifi_Rohingya
            | Script::Mende_Kikakui
            | Script::Old_Hungarian
            | Script::Phoenician
            | Script::Avestan
            | Script::Imperial_Aramaic
    )
}

/// The runs of `text`, in logical order, covering all of it.
pub fn runs(text: &str) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    let mut current: Option<Script> = None;
    for (at, character) in text.char_indices() {
        let script = character.script();
        let neutral = matches!(script, Script::Common | Script::Inherited | Script::Unknown);
        match (&current, neutral) {
            (Some(active), false) if *active != script => {
                out.push(Run { range: at..at + character.len_utf8(), rtl: is_rtl(script) });
                current = Some(script);
            }
            (None, false) => {
                current = Some(script);
                match out.last_mut() {
                    // Leading neutrals take the first script's direction.
                    Some(run) => {
                        run.rtl = is_rtl(script);
                        run.range.end = at + character.len_utf8();
                    }
                    None => out.push(Run { range: at..at + character.len_utf8(), rtl: is_rtl(script) }),
                }
            }
            _ => match out.last_mut() {
                Some(run) => run.range.end = at + character.len_utf8(),
                None => out.push(Run { range: at..at + character.len_utf8(), rtl: false }),
            },
        }
    }
    out
}

/// The shaping face of `face` with the variation coordinates applied (`(axis tag, value)`).
pub fn hb_face<'a>(face: &'a Face, variations: &[(String, f32)]) -> Option<rustybuzz::Face<'a>> {
    let mut shaping = rustybuzz::Face::from_slice(face.bytes()?, face.index())?;
    let coordinates: Vec<rustybuzz::Variation> = variations
        .iter()
        .filter_map(|(tag, value)| {
            let bytes: [u8; 4] = tag.as_bytes().try_into().ok()?;
            Some(rustybuzz::Variation { tag: rustybuzz::ttf_parser::Tag::from_bytes(&bytes), value: *value })
        })
        .collect();
    if !coordinates.is_empty() {
        shaping.set_variations(&coordinates);
    }
    Some(shaping)
}

/// Shapes one run (`text` is one script and one direction) and returns its glyphs in visual order, with clusters as
/// byte offsets from `base`.
pub fn shape_run(face: &rustybuzz::Face<'_>, text: &str, rtl: bool, base: usize) -> Vec<Glyph> {
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.set_direction(if rtl { rustybuzz::Direction::RightToLeft } else { rustybuzz::Direction::LeftToRight });
    buffer.guess_segment_properties();
    let shaped = rustybuzz::shape(face, &[], buffer);
    shaped
        .glyph_infos()
        .iter()
        .zip(shaped.glyph_positions())
        .map(|(info, position)| Glyph {
            glyph_id: info.glyph_id as u16,
            cluster: base + info.cluster as usize,
            x_advance: position.x_advance,
            y_advance: position.y_advance,
            x_offset: position.x_offset,
            y_offset: position.y_offset,
        })
        .collect()
}

/// Shapes `text` of one face run by run (script and direction), the glyphs of the runs in logical order.
pub fn shape(face: &rustybuzz::Face<'_>, text: &str) -> Vec<Glyph> {
    runs(text).into_iter().flat_map(|run| shape_run(face, &text[run.range.clone()], run.rtl, run.range.start)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cut(text: &str) -> Vec<(&str, bool)> {
        runs(text).into_iter().map(|run| (&text[run.range], run.rtl)).collect()
    }

    #[test]
    fn neutral_characters_join_the_run_they_follow() {
        assert_eq!(cut("Hello 12, World"), [("Hello 12, World", false)]);
        assert_eq!(cut("Hello 안녕 ABC"), [("Hello ", false), ("안녕 ", false), ("ABC", false)]);
    }

    #[test]
    fn leading_neutrals_join_the_first_script() {
        assert_eq!(cut(" Hello"), [(" Hello", false)]);
        assert_eq!(cut("  שלום"), [("  שלום", true)]);
    }

    #[test]
    fn right_to_left_scripts_are_their_own_runs() {
        assert_eq!(cut("a שלום b"), [("a ", false), ("שלום ", true), ("b", false)]);
        assert_eq!(cut("مرحبا"), [("مرحبا", true)]);
    }

    #[test]
    fn empty_and_all_neutral_text() {
        assert!(runs("").is_empty());
        assert_eq!(cut(" 12 "), [(" 12 ", false)]);
    }
}
