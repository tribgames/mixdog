//! `cli-truncate` 6.0.0: fit a string into a width with an ellipsis.
//!
//! Width: plain `string_width` (ANSI removed), as cli-truncate measures; the text is cut with `slice_ansi`. Ink calls
//! it with a position only (see `wrap::wrap_text`); the other options of cli-truncate are kept.
//!
//! The "nearest space" search of `preferTruncationOnSpace` looks at a string index (UTF-16 units, escapes included)
//! that is then used as a cell offset, exactly as cli-truncate does.

use crate::ansi::{ESC, js_trim_end, js_trim_start};
use crate::slice::slice_ansi;
use crate::width::{StringWidthOptions, string_width};

/// Where the text is cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TruncatePosition {
    Start,
    Middle,
    End,
}

/// The options of `cliTruncate(text, columns, options)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TruncateOptions<'a> {
    pub position: TruncatePosition,
    /// A space between the ellipsis and the text that is kept.
    pub space: bool,
    /// Cut at a space close to the cut point when there is one.
    pub prefer_truncation_on_space: bool,
    pub truncation_character: &'a str,
}

impl Default for TruncateOptions<'_> {
    fn default() -> Self {
        Self { position: TruncatePosition::End, space: false, prefer_truncation_on_space: false, truncation_character: "\u{2026}" }
    }
}

fn width(text: &str) -> usize {
    string_width(text, StringWidthOptions::default())
}

/// A signed cell offset as the unsigned one `slice_ansi` takes (a negative offset behaves as 0 there).
fn offset(value: i64) -> usize {
    usize::try_from(value.max(0)).unwrap_or(usize::MAX)
}

fn signed(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// `getIndexOfNearestSpace(string, wantedIndex, shouldSearchRight)`: `wanted` when the unit there is a space,
/// otherwise the first space up to 3 units away in the direction (the wanted index again when there is none).
fn index_of_nearest_space(text: &str, wanted: i64, search_right: bool) -> i64 {
    let units: Vec<u16> = text.encode_utf16().collect();
    let is_space = |index: i64| usize::try_from(index).ok().and_then(|at| units.get(at)) == Some(&u16::from(b' '));
    if is_space(wanted) {
        return wanted;
    }
    let direction = if search_right { 1 } else { -1 };
    for step in 0..=3 {
        let candidate = wanted + step * direction;
        if is_space(candidate) {
            return candidate;
        }
    }
    wanted
}

fn is_sgr_parameter(byte: u8) -> bool {
    byte.is_ascii_digit() || byte == b';'
}

/// The end of the run of `ESC [ params m` sequences at the start of `text`.
fn leading_sgr_span_end(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index + 2 < bytes.len() && bytes[index] == ESC as u8 && bytes[index + 1] == b'[' {
        let mut at = index + 2;
        while at < bytes.len() && is_sgr_parameter(bytes[at]) {
            at += 1;
        }
        if at < bytes.len() && bytes[at] == b'm' {
            index = at + 1;
            continue;
        }
        break;
    }
    index
}

/// The start of the run of `ESC [ params m` sequences at the end of `text`.
fn trailing_sgr_span_start(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut start = bytes.len();
    while start > 1 && bytes[start - 1] == b'm' {
        let mut at = start as isize - 2;
        while at >= 0 && is_sgr_parameter(bytes[at as usize]) {
            at -= 1;
        }
        if at >= 1 && bytes[at as usize - 1] == ESC as u8 && bytes[at as usize] == b'[' {
            start = at as usize - 1;
            continue;
        }
        break;
    }
    start
}

/// `visible` followed by `suffix`, the suffix placed before the SGR codes that close `visible`, so it inherits the
/// style.
fn append_with_inherited_style_from_end(visible: &str, suffix: &str) -> String {
    let start = trailing_sgr_span_start(visible);
    format!("{}{suffix}{}", &visible[..start], &visible[start..])
}

/// `prefix` and `visible`, the prefix placed after the SGR codes that open `visible`.
fn prepend_with_inherited_style_from_start(prefix: &str, visible: &str) -> String {
    let end = leading_sgr_span_end(visible);
    format!("{}{prefix}{}", &visible[..end], &visible[end..])
}

/// `cliTruncate(text, columns, options)`.
pub fn truncate_with(text: &str, columns: usize, options: TruncateOptions<'_>) -> String {
    if columns < 1 {
        return String::new();
    }
    let length = width(text);
    if length <= columns {
        return text.to_owned();
    }
    if columns == 1 {
        return options.truncation_character.to_owned();
    }
    let mut ellipsis = options.truncation_character.to_owned();
    let (length_i, columns_i) = (signed(length), signed(columns));
    match options.position {
        TruncatePosition::Start => {
            if options.prefer_truncation_on_space {
                let nearest = index_of_nearest_space(text, length_i - columns_i + 1, true);
                let right = slice_ansi(text, offset(nearest), Some(length));
                return prepend_with_inherited_style_from_start(&ellipsis, js_trim_end(js_trim_start(&right)));
            }
            if options.space {
                ellipsis.push(' ');
            }
            let right = slice_ansi(text, offset(length_i - columns_i + signed(width(&ellipsis))), Some(length));
            prepend_with_inherited_style_from_start(&ellipsis, &right)
        }
        TruncatePosition::Middle => {
            if options.space {
                ellipsis = format!(" {ellipsis} ");
            }
            let half = columns / 2;
            let half_i = signed(half);
            if options.prefer_truncation_on_space {
                let first = index_of_nearest_space(text, half_i, false);
                let second = index_of_nearest_space(text, length_i - (columns_i - half_i) + 1, true);
                let tail = slice_ansi(text, offset(second), Some(length));
                return format!("{}{ellipsis}{}", slice_ansi(text, 0, Some(offset(first))), js_trim_end(js_trim_start(&tail)));
            }
            format!(
                "{}{ellipsis}{}",
                slice_ansi(text, 0, Some(half)),
                slice_ansi(text, offset(length_i - (columns_i - half_i) + signed(width(&ellipsis))), Some(length))
            )
        }
        TruncatePosition::End => {
            if options.prefer_truncation_on_space {
                let nearest = index_of_nearest_space(text, columns_i - 1, false);
                let left = slice_ansi(text, 0, Some(offset(nearest)));
                return append_with_inherited_style_from_end(&left, &ellipsis);
            }
            if options.space {
                ellipsis = format!(" {ellipsis}");
            }
            let left = slice_ansi(text, 0, Some(offset(columns_i - signed(width(&ellipsis)))));
            append_with_inherited_style_from_end(&left, &ellipsis)
        }
    }
}

/// `cliTruncate(text, columns, { position })`: the ellipsis is U+2026.
pub fn truncate(text: &str, columns: usize, position: TruncatePosition) -> String {
    truncate_with(text, columns, TruncateOptions { position, ..TruncateOptions::default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_that_fits_is_returned_as_it_is() {
        assert_eq!(truncate("abc", 3, TruncatePosition::End), "abc");
        assert_eq!(truncate("abc", 10, TruncatePosition::Start), "abc");
        assert_eq!(truncate("", 0, TruncatePosition::End), "");
    }

    #[test]
    fn no_columns_give_nothing_and_one_column_gives_the_ellipsis() {
        assert_eq!(truncate("abcdef", 0, TruncatePosition::End), "");
        assert_eq!(truncate("abcdef", 1, TruncatePosition::End), "\u{2026}");
        assert_eq!(truncate("abcdef", 1, TruncatePosition::Middle), "\u{2026}");
    }

    #[test]
    fn each_position_cuts_where_it_says() {
        assert_eq!(truncate("abcdefghij", 6, TruncatePosition::End), "abcde\u{2026}");
        assert_eq!(truncate("abcdefghij", 6, TruncatePosition::Start), "\u{2026}fghij");
        assert_eq!(truncate("abcdefghij", 6, TruncatePosition::Middle), "abc\u{2026}ij");
    }

    #[test]
    fn wide_characters_are_not_split() {
        assert_eq!(truncate("日本語日本語", 6, TruncatePosition::End), "日本\u{2026}");
        assert_eq!(truncate("日本語日本語", 6, TruncatePosition::Start), "\u{2026}本語");
    }

    #[test]
    fn the_ellipsis_inherits_the_style() {
        assert_eq!(truncate("\x1b[31mabcdefghij\x1b[39m", 6, TruncatePosition::End), "\x1b[31mabcde\u{2026}\x1b[39m");
        assert_eq!(truncate("\x1b[31mabcdefghij\x1b[39m", 6, TruncatePosition::Start), "\x1b[31m\u{2026}fghij\x1b[39m");
    }

    #[test]
    fn a_space_can_follow_or_precede_the_ellipsis() {
        let options = |position| TruncateOptions { position, space: true, ..TruncateOptions::default() };
        assert_eq!(truncate_with("abcdefghij", 6, options(TruncatePosition::End)), "abcd \u{2026}");
        assert_eq!(truncate_with("abcdefghij", 6, options(TruncatePosition::Start)), "\u{2026} ghij");
        assert_eq!(truncate_with("abcdefghij", 8, options(TruncatePosition::Middle)), "abcd \u{2026} j");
    }

    #[test]
    fn truncation_on_a_space_is_preferred_when_one_is_near() {
        let options = |position| TruncateOptions { position, prefer_truncation_on_space: true, ..TruncateOptions::default() };
        assert_eq!(truncate_with("the quick brown fox", 8, options(TruncatePosition::End)), "the qui\u{2026}");
        assert_eq!(truncate_with("the quick brown fox", 10, options(TruncatePosition::End)), "the quick\u{2026}");
        assert_eq!(truncate_with("the quick brown fox", 10, options(TruncatePosition::Start)), "\u{2026}brown fox");
    }

    #[test]
    fn a_custom_ellipsis_is_used() {
        let options = TruncateOptions { truncation_character: "...", ..TruncateOptions::default() };
        assert_eq!(truncate_with("abcdefghij", 6, options), "abc...");
    }

    #[test]
    fn style_spans_are_found_at_both_ends() {
        assert_eq!(leading_sgr_span_end("\x1b[1m\x1b[31mab"), 9);
        assert_eq!(leading_sgr_span_end("ab"), 0);
        assert_eq!(leading_sgr_span_end("\x1b[1"), 0);
        assert_eq!(trailing_sgr_span_start("ab\x1b[39m\x1b[22m"), 2);
        assert_eq!(trailing_sgr_span_start("ab"), 2);
        assert_eq!(trailing_sgr_span_start("m"), 1);
    }
}
