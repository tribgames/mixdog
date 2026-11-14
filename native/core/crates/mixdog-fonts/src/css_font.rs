//! The canvas `ctx.font` shorthand as `@napi-rs/canvas` reads it.
//!
//! `[style] [variant] [weight] [stretch] size[/line-height] family[, family...]`. The behaviours that differ from a
//! browser, each seen in the canvas's own answers:
//!
//! * keywords are case-sensitive (`Bold` and `ITALIC` are ignored; so is a unit written `PX`, which makes the size
//!   unknown and the family list empty);
//! * a bare number is a weight only when it is a multiple of 100 from 100 to 900 and a size follows; any other number
//!   is the size in pixels (`350 16px Arial` is a 350px font whose family list is `16px Arial`);
//! * the size is its absolute value, em, rem and `%` are taken against 16px, and a unit this parser does not know
//!   keeps the number as pixels and leaves the family list empty;
//! * a font stretch keyword is read and does not take part in matching;
//! * without a size the string is refused (``[`text`] is not valid font style``).
//!
//! A family is a quoted string or the raw text between commas, trimmed (inner runs of blanks are kept, so
//! `Noto   Sans` is not `Noto Sans`); an unterminated quote drops the entry.

use crate::face::FontError;
use crate::face::FontStyle;
use crate::face::Slant;

/// The base font size, in pixels, that `em`, `rem` and `%` are taken against.
const BASE_SIZE: f32 = 16.0;

/// A parsed `ctx.font`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFont {
    pub slant: Slant,
    pub weight: u16,
    /// Font stretch keyword as a width class (1 ultra-condensed .. 9 ultra-expanded); read, not matched on.
    pub stretch: u8,
    pub small_caps: bool,
    /// The size in pixels.
    pub size: f32,
    pub families: Vec<String>,
}

impl ParsedFont {
    /// What the face is matched on.
    pub fn style(&self) -> FontStyle {
        FontStyle { weight: self.weight, width: 5, slant: self.slant }
    }
}

struct SizeToken {
    pixels: f32,
    known_unit: bool,
}

/// A token that reads as a size: sign, digits with an optional fraction, then a unit (maybe none), then an optional
/// `/line-height` which is dropped.
fn size_token(token: &str) -> Option<SizeToken> {
    let token = token.split('/').next().unwrap_or(token);
    let rest = token.strip_prefix(['+', '-']).unwrap_or(token);
    let first = rest.chars().next()?;
    if !(first.is_ascii_digit() || (first == '.' && rest[1..].starts_with(|c: char| c.is_ascii_digit()))) {
        return None;
    }
    let digits = rest.char_indices().take_while(|(_, c)| c.is_ascii_digit()).last().map_or(0, |(at, _)| at + 1);
    let mut end = digits;
    if rest[end..].starts_with('.') {
        let fraction = rest[end + 1..].chars().take_while(char::is_ascii_digit).count();
        end += 1 + fraction;
    }
    let number: f32 = rest[..end].trim_end_matches('.').parse().ok()?;
    let (scale, known_unit) = match &rest[end..] {
        "" | "px" => (1.0, true),
        "pt" => (4.0 / 3.0, true),
        "pc" => (16.0, true),
        "in" => (96.0, true),
        "cm" => (96.0 / 2.54, true),
        "mm" => (96.0 / 25.4, true),
        "Q" => (96.0 / 101.6, true),
        "em" | "rem" => (BASE_SIZE, true),
        "%" => (BASE_SIZE / 100.0, true),
        _ => (1.0, false),
    };
    Some(SizeToken { pixels: number.abs() * scale, known_unit })
}

fn is_hundred_weight(token: &str) -> Option<u16> {
    let weight: u16 = token.parse().ok()?;
    (100..=900).contains(&weight).then_some(weight).filter(|weight| weight % 100 == 0)
}

fn stretch_keyword(token: &str) -> Option<u8> {
    Some(match token {
        "ultra-condensed" => 1,
        "extra-condensed" => 2,
        "condensed" => 3,
        "semi-condensed" => 4,
        "semi-expanded" => 6,
        "expanded" => 7,
        "extra-expanded" => 8,
        "ultra-expanded" => 9,
        _ => return None,
    })
}

fn is_angle(token: &str) -> bool {
    ["deg", "grad", "rad", "turn"].iter().any(|unit| token.strip_suffix(unit).is_some_and(|number| number.parse::<f32>().is_ok()))
}

/// The tokens of `text` with the byte offset where each ends.
fn tokens(text: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = None;
    for (at, character) in text.char_indices() {
        match (character.is_whitespace(), start) {
            (false, None) => start = Some(at),
            (true, Some(from)) => {
                out.push((at, &text[from..at]));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start {
        out.push((text.len(), &text[from..]));
    }
    out
}

/// The family names of the text after the size.
fn family_list(text: &str) -> Vec<String> {
    let mut families = Vec::new();
    let mut chars = text.chars().peekable();
    loop {
        while chars.next_if(|character| character.is_whitespace()).is_some() {}
        let Some(first) = chars.peek().copied() else { break };
        let mut stop = false;
        if matches!(first, '"' | '\'') {
            chars.next();
            let mut name = String::new();
            let mut closed = false;
            for character in chars.by_ref() {
                if character == first {
                    closed = true;
                    break;
                }
                name.push(character);
            }
            // An unterminated quote drops its entry; what follows a closing quote up to the comma is dropped.
            if !closed {
                break;
            }
            for character in chars.by_ref() {
                if character == ',' {
                    break;
                }
                if character == ';' || character == '!' {
                    stop = true;
                    break;
                }
            }
            if !name.is_empty() {
                families.push(name);
            }
        } else {
            let mut raw = String::new();
            for character in chars.by_ref() {
                if character == ',' {
                    break;
                }
                if character == ';' || character == '!' {
                    stop = true;
                    break;
                }
                raw.push(character);
            }
            let name = raw.trim();
            if !name.is_empty() {
                families.push(name.to_owned());
            }
        }
        if stop {
            break;
        }
    }
    families
}

/// Parses a `ctx.font` value.
pub fn parse(text: &str) -> Result<ParsedFont, FontError> {
    let parts = tokens(text);
    let mut font = ParsedFont { slant: Slant::Upright, weight: 400, stretch: 5, small_caps: false, size: 0.0, families: Vec::new() };
    let mut index = 0;
    while index < parts.len() {
        let (end, token) = parts[index];
        index += 1;
        let size_follows = || parts[index..].iter().any(|(_, later)| size_token(later).is_some());
        if let Some(weight) = is_hundred_weight(token).filter(|_| size_follows()) {
            font.weight = weight;
            continue;
        }
        if let Some(size) = size_token(token) {
            font.size = size.pixels;
            if size.known_unit {
                font.families = family_list(text[end..].trim_start());
            }
            return Ok(font);
        }
        match token {
            "italic" => font.slant = Slant::Italic,
            "oblique" => {
                font.slant = Slant::Oblique;
                if parts.get(index).is_some_and(|(_, next)| is_angle(next)) {
                    index += 1;
                }
            }
            "small-caps" => font.small_caps = true,
            "bold" | "bolder" => font.weight = 700,
            "lighter" => font.weight = 100,
            other => {
                if let Some(stretch) = stretch_keyword(other) {
                    font.stretch = stretch;
                }
            }
        }
    }
    Err(FontError::InvalidFont(text.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn font(text: &str) -> ParsedFont {
        parse(text).unwrap_or_else(|error| panic!("{text}: {error}"))
    }

    #[test]
    fn the_shorthand_the_office_code_writes_parses() {
        let parsed = font("italic 700 12.5px \"Malgun Gothic\"");
        assert_eq!(parsed.slant, Slant::Italic);
        assert_eq!(parsed.weight, 700);
        assert_eq!(parsed.size, 12.5);
        assert_eq!(parsed.families, ["Malgun Gothic"]);
        let stack = font("23.4571px \"Segoe UI\", \"Malgun Gothic\", sans-serif");
        assert_eq!(stack.families, ["Segoe UI", "Malgun Gothic", "sans-serif"]);
        assert_eq!(stack.weight, 400);
        assert_eq!(font("bold 16px Arial").weight, 700);
    }

    #[test]
    fn units_are_taken_against_sixteen_pixels() {
        for (text, size) in [("2em Arial", 32.0), ("200% Arial", 32.0), ("10rem Arial", 160.0), ("1in Arial", 96.0), ("-5px Arial", 5.0), (".5em Arial", 8.0)] {
            assert_eq!(font(text).size, size, "{text}");
        }
        assert!((font("10pt Arial").size - 13.333_334).abs() < 1e-4);
        assert!((font("2cm Arial").size - 75.590_55).abs() < 1e-3);
        assert_eq!(font("16 Arial").size, 16.0);
    }

    #[test]
    fn a_number_that_is_not_a_hundred_weight_is_the_size() {
        let parsed = font("350 16px Arial");
        assert_eq!(parsed.size, 350.0);
        assert_eq!(parsed.weight, 400);
        assert_eq!(parsed.families, ["16px Arial"]);
        assert_eq!(font("100 italic 16px Arial").weight, 100);
        assert_eq!(font("italic 900 16px Arial").weight, 900);
    }

    #[test]
    fn keywords_and_units_are_case_sensitive() {
        assert_eq!(font("Bold 16px Arial").weight, 400);
        assert_eq!(font("ITALIC 16px Arial").slant, Slant::Upright);
        let upper = font("16PX Arial");
        assert_eq!(upper.size, 16.0);
        assert!(upper.families.is_empty());
        assert!(font("10vw Arial").families.is_empty());
    }

    #[test]
    fn family_entries_are_raw_text_between_commas() {
        assert_eq!(font("16px  Noto   Sans").families, ["Noto   Sans"]);
        assert_eq!(font("16px 'Noto Sans'").families, ["Noto Sans"]);
        assert_eq!(font("16px \"Arial\"x").families, ["Arial"]);
        assert_eq!(font("16px Arial;").families, ["Arial"]);
        assert_eq!(font("16px Arial !important").families, ["Arial"]);
        assert!(font("12px \"Arial").families.is_empty());
        assert_eq!(font("16px/20px Arial").families, ["Arial"]);
        assert_eq!(font("16px / 20px Arial").families, ["/ 20px Arial"]);
        assert_eq!(font("16px").families, Vec::<String>::new());
    }

    #[test]
    fn a_string_without_a_size_is_refused() {
        for text in ["Arial", "abc", "", "bold", "large Arial", "caption"] {
            assert_eq!(parse(text), Err(FontError::InvalidFont(text.to_owned())), "{text}");
        }
    }

    #[test]
    fn stretch_and_small_caps_are_read() {
        let parsed = font("italic small-caps bold condensed 16px Arial");
        assert!(parsed.small_caps);
        assert_eq!(parsed.stretch, 3);
        assert_eq!(parsed.style(), FontStyle { weight: 700, width: 5, slant: Slant::Italic });
        assert_eq!(font("oblique 10deg 16px Arial").slant, Slant::Oblique);
    }
}
