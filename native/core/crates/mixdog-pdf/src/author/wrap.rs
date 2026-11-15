//! `wrapText` of `pdf-draw.mjs`: text into lines that fit a width.
//!
//! Line breaks are honoured, words wrap at spaces, and a run wider than the line (CJK prose, URLs) breaks by character
//! instead of leaving the page. Words that read as one ("10월 14일", "24억 원") wrap together
//! ([`mixdog_office_base::line_breaks::wrap_units`]), and a paragraph never ends on one word alone under a full line
//! ([`mixdog_office_base::line_breaks::without_runt`]).
//!
//! A character is a code point. A Rust string holds no lone surrogate, so the case of a text carrying one (which
//! JavaScript keeps whole) does not arise here; a supplementary character is never split.

use std::cell::RefCell;

use mixdog_office_base::line_breaks::{without_runt, wrap_units};

/// A word wider than `width` cut into pieces that each fit (a piece is one character at least).
fn break_word(word: &str, width: f64, measure: &impl Fn(&str) -> f64) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut piece = String::new();
    for character in word.chars() {
        let mut longer = piece.clone();
        longer.push(character);
        if !piece.is_empty() && measure(&longer) > width {
            pieces.push(std::mem::take(&mut piece));
        }
        piece.push(character);
    }
    if !piece.is_empty() {
        pieces.push(piece);
    }
    pieces
}

/// `wrapText(text, font, size, width)`: `measure` is the width of a string at the size the text is set at (a font's
/// `widthOfTextAtSize`). The first failure of `measure` is the failure of the wrapping.
pub fn wrap_text<E>(text: &str, width: f64, measure: impl Fn(&str) -> Result<f64, E>) -> Result<Vec<String>, E> {
    let failure: RefCell<Option<E>> = RefCell::new(None);
    let measured = |value: &str| match measure(value) {
        Ok(wide) => wide,
        Err(error) => {
            failure.borrow_mut().get_or_insert(error);
            0.0
        }
    };
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let mut paragraph: Vec<String> = Vec::new();
        let mut line = String::new();
        let words: Vec<&str> = raw.split([' ', '\t']).filter(|word| !word.is_empty()).collect();
        for word in wrap_units(&words) {
            let candidate = if line.is_empty() { word.clone() } else { format!("{line} {word}") };
            if measured(&candidate) <= width {
                line = candidate;
                continue;
            }
            if !line.is_empty() {
                paragraph.push(std::mem::take(&mut line));
            }
            let mut pieces = if measured(&word) <= width { vec![word] } else { break_word(&word, width, &measured) };
            line = pieces.pop().unwrap_or_default();
            paragraph.extend(pieces);
        }
        paragraph.push(line);
        lines.extend(without_runt(&paragraph, &measured, width));
    }
    if let Some(error) = failure.into_inner() {
        return Err(error);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(size: f64) -> impl Fn(&str) -> Result<f64, String> {
        move |text| Ok(text.chars().count() as f64 * size)
    }

    #[test]
    fn supplementary_characters_stay_whole() {
        assert_eq!(wrap_text("A😀B𠀀C", 20.0, chars(10.0)).unwrap(), ["A😀", "B𠀀", "C"]);
    }

    #[test]
    fn line_breaks_are_kept_and_words_wrap_at_spaces() {
        assert_eq!(wrap_text("aa bb cc\r\n\r\ndd", 50.0, chars(10.0)).unwrap(), ["aa bb", "cc", "", "dd"]);
        assert_eq!(wrap_text("", 50.0, chars(10.0)).unwrap(), [""]);
        assert_eq!(wrap_text("a \t b", 50.0, chars(10.0)).unwrap(), ["a b"]);
    }

    #[test]
    fn an_unspaced_run_breaks_by_character() {
        assert_eq!(wrap_text("abcdefgh", 30.0, chars(10.0)).unwrap(), ["abc", "def", "gh"]);
    }

    #[test]
    fn words_that_read_as_one_wrap_together() {
        assert_eq!(wrap_text("예산은 24억 원", 90.0, chars(10.0)).unwrap(), ["예산은", "24억 원"]);
    }

    #[test]
    fn a_failing_measure_fails_the_wrapping() {
        let measure = |text: &str| if text.contains('x') { Err("no glyph".to_owned()) } else { Ok(10.0) };
        assert_eq!(wrap_text("a x", 100.0, measure), Err("no glyph".to_owned()));
    }
}
