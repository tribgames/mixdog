//! The pure text operations of the editor (`src/tui/input-editing.mjs`): selection, cursor motion by grapheme and by word,
//! deletions, the visual-line geometry of a wrapped value and the cell/offset mapping the mouse and the arrows use.
//!
//! Every offset is in UTF-16 units and every segment is a grapheme cluster, as in Node (`Intl.Segmenter`). A Korean
//! syllable typed as jamo is one cluster once composed, so Backspace removes the composed cluster as Node does.

use std::sync::OnceLock;

use mixdog_js::JsRegex;
use mixdog_termtext::display_width;
use mixdog_termtext::lone;
use mixdog_termtext::grapheme::{byte_to_utf16, utf16_to_byte};
use unicode_segmentation::UnicodeSegmentation;

use super::draft::Draft;

/// One grapheme cluster with its UTF-16 offsets.
struct Unit<'a> {
    start: usize,
    end: usize,
    segment: &'a str,
}

fn units(text: &str) -> Vec<Unit<'_>> {
    let mut at = 0;
    text.graphemes(true)
        .map(|segment| {
            let start = at;
            at += mixdog_termtext::lone::utf16_len(segment);
            Unit { start, end: at, segment }
        })
        .collect()
}

/// `/[\p{L}\p{N}\p{M}\p{Pc}]/u.test(segment)`
fn word_like(segment: &str) -> bool {
    static WORD: OnceLock<JsRegex> = OnceLock::new();
    WORD.get_or_init(|| JsRegex::new_static(r"[\p{L}\p{N}\p{M}\p{Pc}]", "u")).is_match(segment)
}

/// `Math.max(1, Math.floor(Number(width) || 80))`: a width of 0 (not measured yet) counts as 80 columns.
fn safe_width(width: usize) -> usize {
    if width == 0 { 80 } else { width }
}

/// The length of `text` in UTF-16 units.
pub fn len16(text: &str) -> usize {
    mixdog_termtext::lone::utf16_len(text)
}

fn clamp_offset(text: &str, offset: usize) -> usize {
    offset.min(len16(text))
}

/// `text.slice(from, to)` by UTF-16 offsets (both clamped; empty when `to` is not after `from`).
pub fn slice16(text: &str, from: usize, to: usize) -> &str {
    let from = utf16_to_byte(text, from);
    let to = utf16_to_byte(text, to);
    if to <= from { "" } else { &text[from..to] }
}

/// `text.slice(from)`.
pub fn slice16_from(text: &str, from: usize) -> &str {
    &text[utf16_to_byte(text, from)..]
}

/// `text.slice(0, from) + insert + text.slice(to)` by UTF-16 offsets. A cut inside a surrogate pair leaves its half in the
/// result, and two halves that meet join into the pair they make; a half left alone stays a lone surrogate, carried as
/// [`mixdog_termtext::lone`] carries it (zero cells wide, one unit long).
pub fn splice16(text: &str, from: usize, to: usize, insert: &str) -> String {
    let units = lone::to_units(text);
    let (from, to) = (from.min(units.len()), to.min(units.len()));
    let mut out: Vec<u16> = units[..from].to_vec();
    out.extend(lone::to_units(insert));
    out.extend_from_slice(&units[to..]);
    lone::from_units(&out)
}

/// The offsets of a live selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

/// The selected range of a draft; none without an anchor or when the anchor equals the caret.
pub fn selection_range(draft: &Draft) -> Option<Range> {
    let anchor = clamp_offset(&draft.value, draft.selection_anchor?);
    let cursor = clamp_offset(&draft.value, draft.cursor);
    if anchor == cursor {
        return None;
    }
    Some(Range { start: anchor.min(cursor), end: anchor.max(cursor) })
}

pub fn clear_selection(draft: &Draft) -> Draft {
    Draft { selection_anchor: None, ..draft.clone() }
}

/// Moves the caret; `extend` keeps (or starts) a selection from the old caret.
pub fn move_cursor(draft: &Draft, cursor: usize, extend: bool) -> Draft {
    let cursor = clamp_offset(&draft.value, cursor);
    let selection_anchor = if extend {
        Some(clamp_offset(&draft.value, draft.selection_anchor.unwrap_or(draft.cursor)))
    } else {
        None
    };
    Draft { value: draft.value.clone(), cursor, selection_anchor }
}

/// Replaces the selection (or inserts at the caret) with `input`, the caret after it.
pub fn replace_selection(draft: &Draft, input: &str) -> Draft {
    let range = selection_range(draft);
    let start = range.map_or_else(|| clamp_offset(&draft.value, draft.cursor), |r| r.start);
    let end = range.map_or(start, |r| r.end);
    let value = splice16(&draft.value, start, end, input);
    Draft { value, cursor: start + len16(input), selection_anchor: None }
}

pub fn delete_selected_text(draft: &Draft) -> Draft {
    if selection_range(draft).is_some() { replace_selection(draft, "") } else { clear_selection(draft) }
}

pub fn previous_offset(text: &str, offset: usize) -> usize {
    if offset == 0 {
        return 0;
    }
    let mut previous = 0;
    for unit in units(text) {
        if unit.end >= offset {
            return unit.start;
        }
        previous = unit.end;
    }
    previous
}

pub fn next_offset(text: &str, offset: usize) -> usize {
    let length = len16(text);
    if offset >= length {
        return length;
    }
    for unit in units(text) {
        if unit.start >= offset || unit.end > offset {
            return unit.end;
        }
    }
    length
}

pub fn previous_word_offset(text: &str, offset: usize) -> usize {
    let units = units(text);
    let mut index = 0;
    while index < units.len() && units[index].end <= offset {
        index += 1;
    }
    while index > 0 && !word_like(units[index - 1].segment) {
        index -= 1;
    }
    while index > 0 && word_like(units[index - 1].segment) {
        index -= 1;
    }
    if index == 0 { 0 } else { units.get(index).map_or(0, |unit| unit.start) }
}

pub fn next_word_offset(text: &str, offset: usize) -> usize {
    let units = units(text);
    let mut index = 0;
    while index < units.len() && units[index].end <= offset {
        index += 1;
    }
    while index < units.len() && !word_like(units[index].segment) {
        index += 1;
    }
    while index < units.len() && word_like(units[index].segment) {
        index += 1;
    }
    if index == 0 { 0 } else { units.get(index - 1).map_or_else(|| len16(text), |unit| unit.end) }
}

/// The start of the line the caret is on: after the last `\n` before it.
pub fn line_start(text: &str, offset: usize) -> usize {
    let from = utf16_to_byte(text, offset.saturating_sub(1));
    // A character that starts at `from` is a newline only when it is one byte long.
    let upto = if text.as_bytes().get(from) == Some(&b'\n') { from + 1 } else { from };
    text[..upto].rfind('\n').map_or(0, |at| byte_to_utf16(text, at) + 1)
}

/// The end of the line the caret is on: the next `\n` at or after it, or the end of the text.
pub fn line_end(text: &str, offset: usize) -> usize {
    let from = utf16_to_byte(text, offset);
    text[from..].find('\n').map_or_else(|| len16(text), |at| byte_to_utf16(text, from + at))
}

/// The `[start, end)` run of same-class characters (word-like or not) around `offset`, for double-click word selection.
pub fn word_range_at(text: &str, offset: usize) -> Range {
    let units = units(text);
    if units.is_empty() {
        return Range { start: 0, end: 0 };
    }
    let off = clamp_offset(text, offset);
    let found = units.iter().position(|unit| off >= unit.start && off < unit.end);
    let index = found.unwrap_or_else(|| {
        let mut fallback = units.len() - 1;
        for (i, unit) in units.iter().enumerate() {
            if unit.start >= off {
                fallback = i.saturating_sub(1);
                break;
            }
        }
        fallback
    });
    let target = word_like(units[index].segment);
    let mut start = index;
    while start > 0 && word_like(units[start - 1].segment) == target {
        start -= 1;
    }
    let mut end = index;
    while end + 1 < units.len() && word_like(units[end + 1].segment) == target {
        end += 1;
    }
    Range { start: units[start].start, end: units[end].end }
}

/// A caret cell inside the wrapped content.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Caret {
    pub row: usize,
    pub col: usize,
}

/// Where one grapheme lands in the wrapped content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Step {
    /// The row the grapheme is drawn on (a newline and a zero-width cluster take the current row).
    pub drawn_row: usize,
    /// The caret row after the grapheme.
    pub row: usize,
    /// The caret column after the grapheme.
    pub col: usize,
}

/// One step of the wrap: where a grapheme lands given the position before it. A grapheme that would overflow the row goes
/// whole to the next row; one that fills the last column starts a new row only when more rendered content follows
/// (`more_follows`).
pub(super) fn advance(row: usize, col: usize, segment: &str, width: usize, more_follows: bool) -> Step {
    if segment == "\n" {
        return Step { drawn_row: row, row: row + 1, col: 0 };
    }
    let segment_width = display_width(segment);
    if segment_width == 0 {
        return Step { drawn_row: row, row, col };
    }
    let (mut row, mut col) = (row, col);
    if col > 0 && col + segment_width > width {
        row += 1;
        col = 0;
    }
    let drawn_row = row;
    col += segment_width;
    if col == width && more_follows {
        row += 1;
        col = 0;
    }
    Step { drawn_row, row, col }
}

/// The caret cell of `offset` in `text` wrapped to `width` columns, the way Ink wraps it. `has_trailing_content`
/// says whether any rendered cell follows the offset in the full text; `None` derives it from the text (a caret at
/// the end of the text has none), and the prompt passes `Some(true)` because it renders a trailing space cell at the end.
pub fn caret_position(text: &str, offset: usize, width: usize, has_trailing_content: Option<bool>) -> Caret {
    let width = safe_width(width);
    let before = slice16(text, 0, offset);
    let follows_in_full_text = has_trailing_content.unwrap_or_else(|| offset < len16(text));
    let (mut row, mut col) = (0, 0);
    let segments: Vec<&str> = before.graphemes(true).collect();
    for (i, segment) in segments.iter().enumerate() {
        let more_follows = i + 1 < segments.len() || follows_in_full_text;
        let step = advance(row, col, segment, width, more_follows);
        (row, col) = (step.row, step.col);
    }
    Caret { row, col }
}

#[derive(Clone, Copy)]
struct Boundary {
    offset: usize,
    row: usize,
    col: usize,
}

/// Every grapheme-boundary position in one pass. The flush-boundary advance is decided from the full text, so a soft-wrap
/// offset reports the next row at column 0.
fn boundary_positions(text: &str, width: usize) -> Vec<Boundary> {
    let units = units(text);
    let mut positions = vec![Boundary { offset: 0, row: 0, col: 0 }];
    let (mut row, mut col) = (0, 0);
    for (i, unit) in units.iter().enumerate() {
        let step = advance(row, col, unit.segment, width, i + 1 < units.len());
        (row, col) = (step.row, step.col);
        positions.push(Boundary { offset: unit.end, row, col });
    }
    positions
}

/// The offset whose caret is nearest to cell (`row`, `col`) of the wrapped content: a click never jumps to a different
/// visual line; within the row the nearest column wins.
pub fn offset_at_cell(text: &str, row: usize, col: usize, width: usize) -> usize {
    let positions = boundary_positions(text, safe_width(width));
    let mut best = positions[0];
    let mut best_score = usize::MAX;
    for position in positions {
        let score = position.row.abs_diff(row).saturating_mul(100_000).saturating_add(position.col.abs_diff(col));
        if score < best_score {
            best = position;
            best_score = score;
        }
    }
    best.offset
}

/// A vertical move: the new caret and the column it aims for (kept across a run of vertical moves).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Vertical {
    pub cursor: usize,
    pub preferred_column: usize,
}

/// The caret one visual line up (`direction` -1) or down (1), at the preferred column or the nearest one on that line.
/// The caret stays when there is no such line.
pub fn vertical_offset(
    text: &str,
    offset: usize,
    width: usize,
    direction: i32,
    preferred_column: Option<usize>,
) -> Vertical {
    let width = safe_width(width);
    let current = caret_position(text, offset, width, None);
    let target_column = preferred_column.unwrap_or(current.col);
    let stay = Vertical { cursor: offset, preferred_column: target_column };
    let Some(target_row) = current.row.checked_add_signed(direction as isize) else {
        return stay;
    };
    let candidates: Vec<Boundary> =
        boundary_positions(text, width).into_iter().filter(|position| position.row == target_row).collect();
    let Some(&first) = candidates.first() else {
        return stay;
    };
    let mut best = first;
    for candidate in candidates {
        let best_distance = best.col.abs_diff(target_column);
        let candidate_distance = candidate.col.abs_diff(target_column);
        if candidate_distance < best_distance
            || (candidate_distance == best_distance && candidate.col <= target_column && candidate.col > best.col)
        {
            best = candidate;
        }
    }
    Vertical { cursor: best.offset, preferred_column: target_column }
}

/// `draft` with the text between `from` and `to` removed and the caret at `cursor`.
fn cut(draft: &Draft, from: usize, to: usize, cursor: usize) -> Draft {
    let value = splice16(&draft.value, from, to, "");
    Draft { value, cursor, selection_anchor: None }
}

pub fn delete_backward_word(draft: &Draft) -> Draft {
    if selection_range(draft).is_some() {
        return replace_selection(draft, "");
    }
    if draft.cursor == 0 {
        return draft.clone();
    }
    let start = previous_word_offset(&draft.value, draft.cursor);
    cut(draft, start, draft.cursor, start)
}

pub fn delete_forward_word(draft: &Draft) -> Draft {
    if selection_range(draft).is_some() {
        return replace_selection(draft, "");
    }
    if draft.cursor >= draft.len16() {
        return draft.clone();
    }
    let end = next_word_offset(&draft.value, draft.cursor);
    cut(draft, draft.cursor, end, draft.cursor)
}

pub fn delete_to_line_start(draft: &Draft) -> Draft {
    if selection_range(draft).is_some() {
        return replace_selection(draft, "");
    }
    let start = line_start(&draft.value, draft.cursor);
    if start == draft.cursor {
        return draft.clone();
    }
    cut(draft, start, draft.cursor, start)
}

pub fn delete_to_line_end(draft: &Draft) -> Draft {
    if selection_range(draft).is_some() {
        return replace_selection(draft, "");
    }
    let end = line_end(&draft.value, draft.cursor);
    let mut delete_end = draft.cursor;
    if end > draft.cursor {
        delete_end = end;
    } else if slice16_from(&draft.value, draft.cursor).starts_with('\n') {
        delete_end = draft.cursor + 1;
    }
    if delete_end == draft.cursor {
        return draft.clone();
    }
    cut(draft, draft.cursor, delete_end, draft.cursor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(value: &str, cursor: usize, anchor: Option<usize>) -> Draft {
        Draft::new(value, cursor, anchor)
    }

    #[test]
    fn selection_and_replace() {
        let draft = d("hello world", 5, Some(0));
        assert_eq!(selection_range(&draft), Some(Range { start: 0, end: 5 }));
        assert_eq!(replace_selection(&draft, "bye"), d("bye world", 3, None));
        assert_eq!(selection_range(&d("abc", 2, Some(2))), None);
        assert_eq!(move_cursor(&d("abc", 1, None), 3, true), d("abc", 3, Some(1)));
        assert_eq!(move_cursor(&d("abc", 1, Some(0)), 9, false), d("abc", 3, None));
    }

    #[test]
    fn offsets_step_over_whole_graphemes_in_utf16_units() {
        assert_eq!(previous_offset("a\u{1F1F0}\u{1F1F7}", 5), 1);
        assert_eq!(next_offset("a\u{1F1F0}\u{1F1F7}b", 1), 5);
        assert_eq!(next_offset("ab", 9), 2);
        assert_eq!(previous_offset("e\u{301}x", 2), 0);
        assert_eq!(previous_offset("\u{ac00}\u{b098}", 1), 0);
        // Korean jamo that compose into one syllable cluster are removed together.
        assert_eq!(previous_offset("\u{1112}\u{1161}\u{11ab}", 3), 0);
    }

    #[test]
    fn word_motion() {
        let text = "alpha beta  gamma";
        assert_eq!(previous_word_offset(text, 10), 6);
        assert_eq!(previous_word_offset(text, 6), 0);
        assert_eq!(previous_word_offset(text, 0), 0);
        assert_eq!(next_word_offset(text, 0), 5);
        assert_eq!(next_word_offset(text, 5), 10);
        assert_eq!(next_word_offset(text, 17), 17);
        assert_eq!(next_word_offset("", 0), 0);
        assert_eq!(previous_word_offset("\u{d55c}\u{ae00} \u{d14d}\u{c2a4}\u{d2b8}", 6), 3);
    }

    #[test]
    fn line_bounds() {
        let text = "ab\ncd\n";
        assert_eq!(line_start(text, 0), 0);
        assert_eq!(line_start(text, 2), 0);
        assert_eq!(line_start(text, 3), 3);
        assert_eq!(line_start(text, 5), 3);
        assert_eq!(line_start(text, 6), 6);
        assert_eq!(line_end(text, 0), 2);
        assert_eq!(line_end(text, 2), 2);
        assert_eq!(line_end(text, 3), 5);
        assert_eq!(line_end(text, 6), 6);
        assert_eq!(line_start("\u{65e5}\u{672c}\nx", 4), 3);
    }

    #[test]
    fn word_range_selects_the_run_under_the_offset() {
        let text = "foo  bar!";
        assert_eq!(word_range_at(text, 1), Range { start: 0, end: 3 });
        assert_eq!(word_range_at(text, 3), Range { start: 3, end: 5 });
        assert_eq!(word_range_at(text, 8), Range { start: 8, end: 9 });
        assert_eq!(word_range_at(text, 99), Range { start: 8, end: 9 });
        assert_eq!(word_range_at("", 0), Range { start: 0, end: 0 });
    }

    #[test]
    fn caret_wraps_like_ink() {
        // A flush last column rolls to the next row only when content follows.
        assert_eq!(caret_position("abcd", 4, 4, None), Caret { row: 0, col: 4 });
        assert_eq!(caret_position("abcd", 4, 4, Some(true)), Caret { row: 1, col: 0 });
        assert_eq!(caret_position("abcde", 4, 4, None), Caret { row: 1, col: 0 });
        // A wide glyph that does not fit goes whole to the next row.
        assert_eq!(caret_position("abc\u{65e5}", 4, 4, None), Caret { row: 1, col: 2 });
        assert_eq!(caret_position("a\nb", 3, 10, None), Caret { row: 1, col: 1 });
        assert_eq!(caret_position("x", 0, 0, None), Caret { row: 0, col: 0 });
    }

    #[test]
    fn offset_at_cell_never_leaves_the_row() {
        let text = "abcdefgh";
        assert_eq!(offset_at_cell(text, 0, 2, 4), 2);
        assert_eq!(offset_at_cell(text, 1, 1, 4), 5);
        // Row distance dominates: below the last row is the last row, at the nearest column.
        assert_eq!(offset_at_cell(text, 9, 0, 4), 4);
        assert_eq!(offset_at_cell(text, 9, 9, 4), 8);
        assert_eq!(offset_at_cell("", 3, 3, 4), 0);
    }

    #[test]
    fn vertical_moves_keep_the_preferred_column() {
        let text = "abcdef\nab\nabcdef";
        let up = vertical_offset(text, 16, 20, -1, None);
        assert_eq!(up, Vertical { cursor: 9, preferred_column: 6 });
        let up_again = vertical_offset(text, up.cursor, 20, -1, Some(up.preferred_column));
        assert_eq!(up_again, Vertical { cursor: 6, preferred_column: 6 });
        let top = vertical_offset(text, 2, 20, -1, None);
        assert_eq!(top.cursor, 2);
        let bottom = vertical_offset(text, 16, 20, 1, None);
        assert_eq!(bottom.cursor, 16);
    }

    #[test]
    fn deletions() {
        assert_eq!(delete_backward_word(&d("alpha beta", 10, None)), d("alpha ", 6, None));
        assert_eq!(delete_forward_word(&d("alpha beta", 0, None)), d(" beta", 0, None));
        assert_eq!(delete_to_line_start(&d("ab\ncd", 5, None)), d("ab\n", 3, None));
        assert_eq!(delete_to_line_end(&d("ab\ncd", 0, None)), d("\ncd", 0, None));
        assert_eq!(delete_to_line_end(&d("ab\ncd", 2, None)), d("abcd", 2, None));
        assert_eq!(delete_to_line_end(&d("ab", 2, None)), d("ab", 2, None));
        assert_eq!(delete_backward_word(&d("one two", 7, Some(4))), d("one ", 4, None));
    }
}
