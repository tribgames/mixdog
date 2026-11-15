//! `string-width` 8.3.0: how many terminal cells a string occupies.
//!
//! The text is cut into grapheme clusters (Unicode extended clusters, as `Intl.Segmenter` cuts them) and each
//! cluster is measured by the first rule that applies:
//!
//! 1. a cluster without a visible code point (Default_Ignorable, Control, Format, Nonspacing_Mark, Enclosing_Mark,
//!    Surrogate only) is 0, tabs included;
//! 2. an RGI emoji, a keycap `[0-9#*] U+20E3`, or a ZWJ cluster of two or more Extended_Pictographic (at most 50
//!    UTF-16 units long) is 2;
//! 3. a cluster that starts (after its invisible prefix) with Hangul jamo adds 2 for each modern L+V(+T) syllable
//!    piece and the East Asian Width of every other jamo; once a non-jamo follows, every remaining code point adds
//!    its East Asian Width;
//! 4. otherwise the East Asian Width of the first visible code point, plus the East Asian Width of every later
//!    Spacing_Mark and of every later U+FF00 to U+FFEF code point of the cluster.
//!
//! ANSI escape sequences are removed first, and only when the text contains ESC or U+009B. Printable ASCII is its
//! length and is never segmented.

use std::borrow::Cow;
use std::cmp::Ordering;

use unicode_segmentation::UnicodeSegmentation;

use crate::strip::strip_ansi;
use crate::width_tables::{
    AMBIGUOUS, EXTENDED_PICTOGRAPHIC, NOT_VISIBLE, RGI_SEQUENCES, RGI_SINGLE, SPACING_MARK, WIDE,
};

/// The options of `stringWidth(input, options)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StringWidthOptions {
    /// East Asian Ambiguous code points count 1 cell (the default) or 2.
    pub ambiguous_is_narrow: bool,
    /// Count the characters of escape sequences as text instead of removing them first.
    pub count_ansi_escape_codes: bool,
}

impl Default for StringWidthOptions {
    fn default() -> Self {
        Self { ambiguous_is_narrow: true, count_ansi_escape_codes: false }
    }
}

const ZWJ: char = '\u{200d}';
const KEYCAP: char = '\u{20e3}';
/// Real emoji clusters are shorter than 30 UTF-16 units: longer ones are not measured as emoji sequences.
const EMOJI_CLUSTER_UNITS: usize = 50;

/// Whether `cp` is in one of the sorted, inclusive `ranges`.
fn in_ranges(ranges: &[(u32, u32)], cp: u32) -> bool {
    ranges
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                Ordering::Less
            } else if lo > cp {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        })
        .is_ok()
}

/// `eastAsianWidth(cp, { ambiguousAsWide })` of get-east-asian-width 1.6.0: 2 for Fullwidth and Wide (and Ambiguous
/// when asked), otherwise 1.
fn east_asian_width(ch: char, ambiguous_as_wide: bool) -> usize {
    let cp = u32::from(ch);
    if in_ranges(WIDE, cp) || (ambiguous_as_wide && in_ranges(AMBIGUOUS, cp)) {
        2
    } else {
        1
    }
}

fn is_visible(ch: char) -> bool {
    !crate::lone::is_carrier(ch) && !in_ranges(NOT_VISIBLE, u32::from(ch))
}

fn is_hangul_leading(ch: char) -> bool {
    matches!(u32::from(ch), 0x1100..=0x115f | 0xa960..=0xa97c)
}

fn is_hangul_vowel(ch: char) -> bool {
    matches!(u32::from(ch), 0x1160..=0x11a7 | 0xd7b0..=0xd7c6)
}

fn is_hangul_trailing(ch: char) -> bool {
    matches!(u32::from(ch), 0x11a8..=0x11ff | 0xd7cb..=0xd7fb)
}

fn is_hangul_jamo(ch: char) -> bool {
    is_hangul_leading(ch) || is_hangul_vowel(ch) || is_hangul_trailing(ch)
}

/// `^\p{RGI_Emoji}$` over the whole cluster.
fn is_rgi_emoji(segment: &str) -> bool {
    let mut chars = segment.chars();
    match (chars.next(), chars.next()) {
        (Some(only), None) => in_ranges(RGI_SINGLE, u32::from(only)),
        (Some(_), Some(_)) => RGI_SEQUENCES.binary_search(&segment).is_ok(),
        _ => false,
    }
}

/// Minimally-qualified or unqualified emoji that terminals still draw double width: a keycap without U+FE0F, or a
/// ZWJ cluster of two or more Extended_Pictographic.
fn is_double_width_non_rgi_sequence(segment: &str) -> bool {
    if mixdog_js::utf16_len(segment) > EMOJI_CLUSTER_UNITS {
        return false;
    }
    let mut chars = segment.chars();
    if let (Some(base), Some(KEYCAP), None) = (chars.next(), chars.next(), chars.next())
        && (base.is_ascii_digit() || base == '#' || base == '*')
    {
        return true;
    }
    segment.contains(ZWJ)
        && segment.chars().filter(|&c| in_ranges(EXTENDED_PICTOGRAPHIC, u32::from(c))).take(2).count() >= 2
}

/// The cluster from its first visible code point, or `None` when the whole cluster is invisible.
fn base_visible(segment: &str) -> Option<&str> {
    segment.char_indices().find(|&(_, c)| is_visible(c)).map(|(at, _)| &segment[at..])
}

/// The width of a cluster that starts with Hangul jamo, or `None` when its first visible code point is not a jamo.
fn hangul_cluster_width(visible: &str, ambiguous_as_wide: bool) -> Option<usize> {
    let code_points: Vec<char> = visible.chars().filter(|&c| is_visible(c)).collect();
    let mut width = 0;
    let mut index = 0;
    while index < code_points.len() {
        let current = code_points[index];
        if !is_hangul_jamo(current) {
            if width == 0 {
                return None;
            }
            // A mixed cluster (a leading jamo, then a precomposed syllable): the East Asian Width of the rest.
            let rest: usize = code_points[index..].iter().map(|&c| east_asian_width(c, ambiguous_as_wide)).sum();
            return Some(width + rest);
        }
        if is_hangul_leading(current) && code_points.get(index + 1).is_some_and(|&c| is_hangul_vowel(c)) {
            width += 2;
            index += if code_points.get(index + 2).is_some_and(|&c| is_hangul_trailing(c)) { 3 } else { 2 };
            continue;
        }
        width += east_asian_width(current, ambiguous_as_wide);
        index += 1;
    }
    (!code_points.is_empty()).then_some(width)
}

/// The width the trailing Spacing_Marks and Halfwidth/Fullwidth Forms of a cluster add to its first code point's.
fn trailing_width(visible: &str, ambiguous_as_wide: bool) -> usize {
    visible
        .chars()
        .skip(1)
        .filter(|&c| in_ranges(SPACING_MARK, u32::from(c)) || ('\u{ff00}'..='\u{ffef}').contains(&c))
        .map(|c| east_asian_width(c, ambiguous_as_wide))
        .sum()
}

fn is_printable_ascii(text: &str) -> bool {
    text.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// `stringWidth(input, options)`.
pub fn string_width(input: &str, options: StringWidthOptions) -> usize {
    if input.is_empty() {
        return 0;
    }
    let text = if options.count_ansi_escape_codes { Cow::Borrowed(input) } else { strip_ansi(input) };
    if is_printable_ascii(&text) {
        return text.len();
    }
    let ambiguous_as_wide = !options.ambiguous_is_narrow;
    text.graphemes(true).map(|segment| cluster_width(segment, ambiguous_as_wide)).sum()
}

fn cluster_width(segment: &str, ambiguous_as_wide: bool) -> usize {
    let Some(visible) = base_visible(segment) else {
        return 0;
    };
    if is_rgi_emoji(segment) || is_double_width_non_rgi_sequence(segment) {
        return 2;
    }
    if let Some(hangul) = hangul_cluster_width(visible, ambiguous_as_wide) {
        return hangul;
    }
    let first = visible.chars().next().map_or(0, |c| east_asian_width(c, ambiguous_as_wide));
    first + trailing_width(visible, ambiguous_as_wide)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn width(text: &str) -> usize {
        string_width(text, StringWidthOptions::default())
    }

    #[test]
    fn printable_ascii_is_its_length() {
        assert_eq!(width(""), 0);
        assert_eq!(width("hello world ~"), 13);
    }

    #[test]
    fn control_and_default_ignorable_clusters_are_zero() {
        assert_eq!(width("a\tb"), 2);
        assert_eq!(width("a\u{200b}b"), 2);
        assert_eq!(width("\u{feff}"), 0);
        assert_eq!(width("\u{7f}\u{85}"), 0);
        assert_eq!(width("\u{301}"), 0);
    }

    #[test]
    fn east_asian_wide_and_combining_marks() {
        assert_eq!(width("日本語"), 6);
        assert_eq!(width("e\u{301}"), 1);
        assert_eq!(width("ＡＢＣ"), 6);
        assert_eq!(width("ｶﾞ"), 2);
    }

    #[test]
    fn ambiguous_is_narrow_unless_asked() {
        let wide = StringWidthOptions { ambiguous_is_narrow: false, ..StringWidthOptions::default() };
        assert_eq!(width("①"), 1);
        assert_eq!(string_width("①", wide), 2);
        assert_eq!(width("└"), 1);
    }

    #[test]
    fn emoji_clusters_are_double_width() {
        assert_eq!(width("🙂"), 2);
        assert_eq!(width("👨\u{200d}👩\u{200d}👧\u{200d}👦"), 2);
        assert_eq!(width("🇯🇵"), 2);
        assert_eq!(width("1\u{fe0f}\u{20e3}"), 2);
        assert_eq!(width("1\u{20e3}"), 2);
        assert_eq!(width("👍🏽"), 2);
        assert_eq!(width("❤\u{fe0f}"), 2);
    }

    #[test]
    fn a_zwj_cluster_needs_two_pictographics() {
        assert_eq!(width("a\u{200d}b"), 2);
        assert_eq!(width("👨\u{200d}"), 2);
    }

    #[test]
    fn hangul_pieces_collapse_and_leftovers_add() {
        assert_eq!(width("한글"), 4);
        assert_eq!(width("\u{1100}\u{1161}"), 2);
        assert_eq!(width("\u{1100}\u{1161}\u{11a8}"), 2);
        assert_eq!(width("\u{1100}\u{1100}\u{1161}"), 4);
        assert_eq!(width("\u{1161}"), 1);
        assert_eq!(width("\u{1100}\u{1161}\u{11a8}\u{11a8}"), 3);
    }

    #[test]
    fn ansi_escapes_are_not_counted_unless_asked() {
        assert_eq!(width("\x1b[31mred\x1b[0m"), 3);
        assert_eq!(width("\x1b]8;;http://x\x07link\x1b]8;;\x07"), 4);
        assert_eq!(width("\u{9b}31mx"), 1);
        let counted = StringWidthOptions { count_ansi_escape_codes: true, ..StringWidthOptions::default() };
        // ESC and the BEL-free text: `[31m` + `red` + `[0m`; the ESC characters are controls.
        assert_eq!(string_width("\x1b[31mred\x1b[0m", counted), 4 + 3 + 3);
    }

    #[test]
    fn ascii_takes_the_fast_path() {
        assert!(is_printable_ascii("plain text 123"));
        assert!(!is_printable_ascii("tab\t"));
        assert!(!is_printable_ascii("é"));
        assert_eq!(width(&"a".repeat(1 << 20)), 1 << 20);
    }
}
