//! The wrap arithmetic of `app/text-layout.mjs` that the panels reserve rows from, and the caret position of
//! `input-editing.mjs`, which follows Ink's `wrap="hard"` wrapping of a value cell by cell.
//!
//! Offsets are UTF-16 units and segments are grapheme clusters, as in Node (`Intl.Segmenter`).

use mixdog_js::{js_trim, utf16_len};
use mixdog_termtext::grapheme::{graphemes_with_widths, utf16_to_byte};
use mixdog_termtext::wrap::{WrapOptions, wrap_ansi};

/// One grapheme cluster: its text, its UTF-16 offset and its display width.
struct Cluster<'a> {
    text: &'a str,
    start: usize,
    width: usize,
}

fn clusters(text: &str) -> Vec<Cluster<'_>> {
    let mut at = 0;
    graphemes_with_widths(text)
        .into_iter()
        .map(|cluster| {
            let start = at;
            at += utf16_len(cluster.text);
            Cluster { text: cluster.text, start, width: cluster.width }
        })
        .collect()
}

/// Where the next cluster goes: a newline starts a row; a glyph that would overflow the row moves whole to the next
/// one (a wide glyph leaves no half column behind); a glyph that lands flush on the last column starts a new row
/// only when more content follows.
fn advance(row: usize, col: usize, cluster: &Cluster<'_>, width: usize, more_follows: bool) -> (usize, usize) {
    if cluster.text == "\n" {
        return (row + 1, 0);
    }
    if cluster.width == 0 {
        return (row, col);
    }
    let (mut row, mut col) = (row, col);
    if col > 0 && col + cluster.width > width {
        row += 1;
        col = 0;
    }
    col += cluster.width;
    if col == width && more_follows {
        row += 1;
        col = 0;
    }
    (row, col)
}

fn safe_width(width: usize) -> usize {
    width.max(1)
}

/// `wrappedTextRows(value, width)`: the rows a value takes wrapped to `width` cells (at least one).
pub fn wrapped_text_rows(value: &str, width: usize) -> usize {
    let width = safe_width(width);
    let parts = clusters(value);
    let (mut row, mut col) = (0, 0);
    for (i, cluster) in parts.iter().enumerate() {
        (row, col) = advance(row, col, cluster, width, i + 1 < parts.len());
    }
    row + 1
}

/// `wrappedDetailRows(text, width)`: the rows an Ink `<Text wrap="wrap">` takes (the same wrap-ansi call), zero for a
/// blank text.
pub fn wrapped_detail_rows(text: &str, width: usize) -> usize {
    let value = js_trim(text);
    if value.is_empty() {
        return 0;
    }
    wrap_ansi(value, safe_width(width), WrapOptions { hard: true, trim: false, word_wrap: true }).split('\n').count()
}

/// `caretPosition(text, offset, width, hasTrailingContent)`: the `(row, col)` cell of a caret. `has_trailing_content`
/// says whether a rendered cell follows the offset in the full text; `None` derives it from the text.
pub fn caret_position(text: &str, offset: usize, width: usize, has_trailing_content: Option<bool>) -> (usize, usize) {
    let width = safe_width(width);
    let before = &text[..utf16_to_byte(text, offset)];
    let follows = has_trailing_content.unwrap_or_else(|| offset < utf16_len(text));
    let parts = clusters(before);
    let (mut row, mut col) = (0, 0);
    for (i, cluster) in parts.iter().enumerate() {
        (row, col) = advance(row, col, cluster, width, i + 1 < parts.len() || follows);
    }
    (row, col)
}

/// The UTF-16 offsets where each visual row starts (hard wrap and explicit newlines).
fn visual_row_starts(text: &str, width: usize) -> Vec<usize> {
    let width = safe_width(width);
    let total = utf16_len(text);
    let parts = clusters(text);
    let mut starts = vec![0];
    let mut col = 0;
    for (i, cluster) in parts.iter().enumerate() {
        if cluster.text == "\n" {
            col = 0;
            let next = cluster.start + utf16_len(cluster.text);
            if next < total {
                starts.push(next);
            }
            continue;
        }
        if cluster.width == 0 {
            continue;
        }
        if col > 0 && col + cluster.width > width {
            col = 0;
            starts.push(cluster.start);
        }
        col += cluster.width;
        if col == width && i + 1 < parts.len() {
            col = 0;
            starts.push(parts[i + 1].start);
        }
    }
    starts
}

/// The part of a value that shows when `visible_rows` rows are shown from row `scroll_row`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowWindow {
    pub slice: String,
    pub slice_start: usize,
    pub slice_end: usize,
    pub total_rows: usize,
}

/// `sliceVisualRowWindow(text, width, scrollRow, visibleRows)`.
pub fn slice_visual_row_window(text: &str, width: usize, scroll_row: usize, visible_rows: usize) -> RowWindow {
    let starts = visual_row_starts(text, width);
    let total = utf16_len(text);
    let start = starts[scroll_row.min(starts.len() - 1)];
    let end = starts.get(scroll_row + visible_rows.max(1)).copied().unwrap_or(total);
    let (from, to) = (utf16_to_byte(text, start), utf16_to_byte(text, end));
    RowWindow { slice: text[from..to].to_owned(), slice_start: start, slice_end: end, total_rows: starts.len() }
}

/// `textEntryReservedRows(value, width, maxRows)`: the rows a text entry reserves for a value (room for the caret
/// after the last glyph), at most `max_rows`.
pub fn text_entry_reserved_rows(value: &str, width: usize, max_rows: usize) -> usize {
    wrapped_text_rows(&format!("{value} "), width).min(max_rows.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_count_newlines_wraps_and_a_flush_last_column() {
        assert_eq!(wrapped_text_rows("", 5), 1);
        assert_eq!(wrapped_text_rows("abcde", 5), 1);
        assert_eq!(wrapped_text_rows("abcdef", 5), 2);
        assert_eq!(wrapped_text_rows("ab\ncd\n", 5), 3);
        assert_eq!(wrapped_text_rows("日本語", 5), 2);
    }

    #[test]
    fn the_caret_rolls_to_the_next_row_only_when_something_follows() {
        assert_eq!(caret_position("abcde", 5, 5, None), (0, 5));
        assert_eq!(caret_position("abcde", 5, 5, Some(true)), (1, 0));
        assert_eq!(caret_position("abcdef", 5, 5, None), (1, 0));
        assert_eq!(caret_position("ab\ncd", 4, 5, None), (1, 1));
    }

    #[test]
    fn the_window_starts_at_the_scrolled_row() {
        let window = slice_visual_row_window("abcdefghij", 4, 1, 1);
        assert_eq!((window.slice.as_str(), window.slice_start, window.slice_end, window.total_rows), ("efgh", 4, 8, 3));
        let last = slice_visual_row_window("abcdefghij", 4, 2, 5);
        assert_eq!((last.slice.as_str(), last.slice_end), ("ij", 10));
    }

    #[test]
    fn detail_rows_use_the_hard_wrap_of_ink() {
        assert_eq!(wrapped_detail_rows("  ", 10), 0);
        assert_eq!(wrapped_detail_rows("abcdefghij", 4), 3);
        assert_eq!(text_entry_reserved_rows("abcd", 4, 8), 2);
        assert_eq!(text_entry_reserved_rows("abcd", 4, 1), 1);
    }
}
