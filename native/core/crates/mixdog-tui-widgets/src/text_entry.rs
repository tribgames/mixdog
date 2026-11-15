//! `components/TextEntryPanel.jsx`, `text-entry-layout.mjs` and `text-entry-value.jsx`: the layout of the inline editor
//! used inside picker workflows. A single-line value is a horizontal window that keeps the caret visible (newlines show
//! as a glyph, so a pasted block never grows the panel); a multiline value wraps and scrolls to keep the caret row in
//! view; a masked value never shows the secret. The editing keys belong to the editor.

use mixdog_js::utf16_len;
use mixdog_term::frame::{Rect, Style};
use mixdog_term::paint::{Painter, RoundBorder, TextWrap};
use mixdog_termtext::grapheme::utf16_to_byte;
use mixdog_tui_style::Key;

use crate::hint_overprint::clean_right_message;
use crate::panel_cell_text::{cells, truncate_panel_text};
use crate::sign_in_url::{CopyStatus, SignInUrlLayout, paint_sign_in_url, sign_in_url_layout, sign_in_url_note};
use crate::text_layout::{caret_position, slice_visual_row_window, wrapped_text_rows};
use crate::{Justify, Run, paint_split, runs_to_ansi, selected_style, split_row, text_width, themed};

/// The glyph a newline shows as in a single-line value.
pub const NEWLINE_GLYPH: &str = "\u{23ce}";

/// The text being edited: the value, the caret and the selection anchor, in UTF-16 units.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextEntryDraft {
    pub value: String,
    pub cursor: usize,
    pub selection_anchor: Option<usize>,
}

impl TextEntryDraft {
    /// A draft with the caret at the end of `value`.
    pub fn new(value: &str) -> Self {
        Self { value: value.to_owned(), cursor: utf16_len(value), selection_anchor: None }
    }
}

/// `selectionRange(draft)`: the selected `(start, end)`, none without an anchor or when it equals the caret.
pub fn selection_range(draft: &TextEntryDraft) -> Option<(usize, usize)> {
    let len = utf16_len(&draft.value);
    let anchor = draft.selection_anchor?.min(len);
    let cursor = draft.cursor.min(len);
    (anchor != cursor).then(|| (anchor.min(cursor), anchor.max(cursor)))
}

/// `flattenForSingleLine(text)`: newlines as one visible glyph, so a multiline paste stays one visual row.
pub fn flatten_for_single_line(text: &str) -> String {
    text.replace('\n', NEWLINE_GLYPH)
}

/// `singleLine(text)`: any white space collapsed so a hint is one visual line.
pub fn single_line(text: &str) -> String {
    clean_right_message(text)
}

/// The visible part of a single line: a window of `width` cells that keeps the caret in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineWindow {
    pub text: String,
    /// The window's UTF-16 offsets in the flattened line.
    pub cu_start: usize,
    pub cu_end: usize,
    /// The caret's cell in the window.
    pub caret_col: usize,
}

/// `windowSingleLine(flat, cursor, width)`: a horizontal viewport over a flattened line, so long or multiline pasted
/// input scrolls instead of wrapping and growing the panel. Offsets are code units, which map one to one to the
/// flattened string (a newline is one glyph, a mask one character).
pub fn window_single_line(flat: &str, cursor: usize, width: usize) -> LineWindow {
    let w = width.max(1);
    let chars: Vec<char> = flat.chars().collect();
    let widths: Vec<usize> = chars.iter().map(|ch| cells(&ch.to_string())).collect();
    let mut unit = 0;
    let mut cursor_char = chars.len();
    for (index, ch) in chars.iter().enumerate() {
        if unit >= cursor {
            cursor_char = index;
            break;
        }
        unit += ch.len_utf16();
    }
    let cursor_cell: usize = widths[..cursor_char].iter().sum();
    let total_cell: usize = widths.iter().sum();
    let mut start_cell = cursor_cell.saturating_sub(w - 1);
    start_cell = start_cell.min(total_cell.saturating_sub(w));
    let (mut a, mut accumulated) = (0, 0);
    while a < chars.len() && accumulated + widths[a] <= start_cell {
        accumulated += widths[a];
        a += 1;
    }
    let aligned_start = accumulated;
    let (mut b, mut shown) = (a, 0);
    while b < chars.len() && shown + widths[b] <= w {
        shown += widths[b];
        b += 1;
    }
    let cu_start: usize = chars[..a].iter().map(|ch| ch.len_utf16()).sum();
    let cu_end = cu_start + chars[a..b].iter().map(|ch| ch.len_utf16()).sum::<usize>();
    LineWindow { text: chars[a..b].iter().collect(), cu_start, cu_end, caret_col: cursor_cell.saturating_sub(aligned_start) }
}

/// A piece of the shown value: plain, or inside the selection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Segment {
    Plain(String),
    Selected(String),
}

/// `renderSelectedText(displayValue, range, trailingSpace)`: the slice with its selected range marked, and a blank cell
/// after it when the caret is past the end.
fn selected_segments(display: &str, range: Option<(usize, usize)>, trailing_space: bool) -> Vec<Segment> {
    let tail = if trailing_space { " " } else { "" };
    let Some((from, to)) = range else {
        return vec![Segment::Plain(format!("{display}{tail}"))];
    };
    let len = utf16_len(display);
    let start = from.min(len);
    let end = to.min(len).max(start);
    let (start_byte, end_byte) = (utf16_to_byte(display, start), utf16_to_byte(display, end));
    let mut segments = Vec::new();
    if start > 0 {
        segments.push(Segment::Plain(display[..start_byte].to_owned()));
    }
    if end > start {
        segments.push(Segment::Selected(display[start_byte..end_byte].to_owned()));
    }
    segments.push(Segment::Plain(format!("{}{tail}", &display[end_byte..])));
    segments
}

/// The value as the panel shows it, and the rows the value box takes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValueView {
    pub segments: Vec<Segment>,
    pub content_height: usize,
}

/// A masked value shows one `*` per UTF-16 unit and keeps its newlines.
fn visible_value(draft: &TextEntryDraft, mask: bool) -> String {
    if !mask {
        return draft.value.clone();
    }
    draft.value.chars().map(|ch| if ch == '\n' { "\n".to_owned() } else { "*".repeat(ch.len_utf16()) }).collect()
}

/// The rows of a multiline value box and the first row shown: the box shows at most `max_content_rows` rows and scrolls
/// to keep the caret row in view.
fn multiline_window(draft: &TextEntryDraft, visible: &str, content_cells: usize, max_content_rows: usize) -> (usize, usize, bool) {
    let trailing = draft.cursor == utf16_len(&draft.value);
    let layout_text = format!("{visible}{}", if trailing { " " } else { "" });
    let total_rows = wrapped_text_rows(&layout_text, content_cells);
    let visible_rows = total_rows.min(max_content_rows.max(1));
    let caret = caret_position(visible, draft.cursor, content_cells, trailing.then_some(true));
    let scroll = if total_rows > visible_rows { (caret.0 + 1).saturating_sub(visible_rows).min(total_rows - visible_rows) } else { 0 };
    (visible_rows, scroll, trailing)
}

/// `renderTextEntryValue(...)`: the visible (windowed, selection-highlighted) value of a draft and the rows it takes.
pub fn render_text_entry_value(draft: &TextEntryDraft, mask: bool, multiline: bool, content_cells: usize, max_content_rows: usize) -> ValueView {
    let visible = visible_value(draft, mask);
    let range = selection_range(draft);
    if multiline {
        let (visible_rows, scroll, trailing) = multiline_window(draft, &visible, content_cells, max_content_rows);
        let window = slice_visual_row_window(&visible, content_cells, scroll, visible_rows);
        let selection = range.and_then(|(from, to)| {
            let clamp = |offset: usize| offset.clamp(window.slice_start, window.slice_end) - window.slice_start;
            let (start, end) = (clamp(from), clamp(to));
            (end > start).then_some((start, end))
        });
        let slice_trailing = trailing && draft.cursor >= window.slice_end;
        return ValueView { segments: selected_segments(&window.slice, selection, slice_trailing), content_height: visible_rows };
    }
    let flat = flatten_for_single_line(&visible);
    let window = window_single_line(&flat, draft.cursor, content_cells);
    let selection = range.and_then(|(from, to)| {
        let clamp = |offset: usize| offset.clamp(window.cu_start, window.cu_end) - window.cu_start;
        let (start, end) = (clamp(from), clamp(to));
        (end > start).then_some((start, end))
    });
    let trailing = draft.cursor == utf16_len(&draft.value) && window.cu_end >= utf16_len(&flat);
    ValueView { segments: selected_segments(&window.text, selection, trailing), content_height: 1 }
}

/// `createTextEntryCursorAnchor(...)`: the `(row, col)` of the hardware cursor inside the value box. `box_width` is the
/// width the value box has: the content cells of a multiline value, the whole interior of a single-line one (the
/// caret column of a long single line is windowed to that width).
pub fn text_entry_cursor(draft: &TextEntryDraft, mask: bool, multiline: bool, box_width: usize, max_content_rows: usize, prompt_label: &str) -> (usize, usize) {
    let width = box_width.max(1);
    let visible = visible_value(draft, mask);
    if multiline {
        let (_, scroll, trailing) = multiline_window(draft, &visible, width, max_content_rows);
        let caret = caret_position(&visible, draft.cursor, width, trailing.then_some(true));
        return (caret.0.saturating_sub(scroll), caret.1);
    }
    let window = window_single_line(&flatten_for_single_line(&visible), draft.cursor, width);
    (0, cells(prompt_label) + window.caret_col)
}

/// The props of the panel.
#[derive(Clone, Debug)]
pub struct TextEntryProps {
    pub title: String,
    pub hint: String,
    /// A sign-in URL, drawn complete and borderless under the panel.
    pub detail: String,
    /// The rows the panel can give the URL block (`i64::MAX` when unknown).
    pub url_max_rows: i64,
    pub mask: bool,
    pub multiline: bool,
    pub max_content_rows: usize,
    pub columns: usize,
    pub action_label: String,
    pub prompt_label: String,
}

impl TextEntryProps {
    pub fn new(title: &str) -> Self {
        Self {
            title: title.to_owned(),
            hint: String::new(),
            detail: String::new(),
            url_max_rows: i64::MAX,
            mask: false,
            multiline: false,
            max_content_rows: 8,
            columns: 80,
            action_label: "save".to_owned(),
            prompt_label: "> ".to_owned(),
        }
    }

    /// The cells of the value after the prompt label: the interior of the panel (border and padding take four columns).
    pub fn content_cells(&self) -> usize {
        1.max(self.columns.saturating_sub(4 + cells(&self.prompt_label)))
    }

    fn help_text(&self) -> String {
        let action = self.action_label.trim();
        format!("Enter to {} \u{b7} Esc to cancel", if action.is_empty() { "save" } else { action })
    }
}

struct Plan {
    url_layout: SignInUrlLayout,
    detail_text: String,
    hint_text: String,
    title: crate::Split,
    value: ValueView,
}

fn plan(props: &TextEntryProps, draft: &TextEntryDraft, status: CopyStatus) -> Plan {
    let detail_text = mixdog_js::js_trim(&props.detail).to_owned();
    let url_layout = sign_in_url_layout(&detail_text, props.columns, props.url_max_rows);
    let source = if !url_layout.hint && !detail_text.is_empty() { sign_in_url_note(status) } else { single_line(&props.hint) };
    let hint_text = truncate_panel_text(&source, props.columns.saturating_sub(4));
    let title = split_row(&props.title, &props.help_text(), props.columns.saturating_sub(4), (TextWrap::Wrap, TextWrap::Wrap), Justify::Between);
    let value = render_text_entry_value(draft, props.mask, props.multiline, props.content_cells(), props.max_content_rows);
    Plan { url_layout, detail_text, hint_text, title, value }
}

/// The rows the panel takes, the URL block under it included.
pub fn text_entry_rows(props: &TextEntryProps, draft: &TextEntryDraft, status: CopyStatus) -> u16 {
    let plan = plan(props, draft, status);
    plan.title.rows + 3 + plan.value.content_height as u16 + 2 + plan.url_layout.rows as u16
}

/// The runs of a value: plain text in the text colour, the selection highlighted.
fn value_runs(segments: &[Segment]) -> Vec<Run> {
    segments
        .iter()
        .map(|segment| match segment {
            Segment::Plain(text) => (text.clone(), Style::default()),
            Segment::Selected(text) => (text.clone(), selected_style()),
        })
        .collect()
}

/// Paints the panel with its top-left cell at `(x, y)`. Returns the rows it took.
pub fn paint_text_entry(painter: &mut Painter, x: i32, y: i32, props: &TextEntryProps, draft: &TextEntryDraft, status: CopyStatus) -> u16 {
    let plan = plan(props, draft, status);
    let columns = props.columns;
    let cx = x + 2;
    let content = plan.value.content_height as u16;
    let border_rows = plan.title.rows + 3 + content + 2;
    if x >= 0 && y >= 0 {
        painter.border(Rect::new(x as u16, y as u16, columns as u16, border_rows), &RoundBorder::all(themed(Key::PromptBorder)));
    }
    let left = (props.title.clone(), themed(Key::PanelTitle));
    let right = (props.help_text(), themed(Key::Subtle));
    let title_rows = i32::from(paint_split(painter, cx, y + 1, &plan.title, &left, &right, (TextWrap::Wrap, TextWrap::Wrap)));
    let hint_row = y + 1 + title_rows + 1;
    painter.line(cx, hint_row, if plan.hint_text.is_empty() { " " } else { &plan.hint_text }, themed(Key::Subtle));
    let value_row = hint_row + 2;
    let label_width = cells(&props.prompt_label) as i32;
    let ansi = runs_to_ansi(&value_runs(&plan.value.segments));
    if props.multiline {
        painter.line(cx, value_row, &props.prompt_label, themed(Key::Inactive));
        let area = Rect::new((cx + label_width) as u16, value_row as u16, props.content_cells() as u16, content);
        // A text wider than its box is laid out one cell wider than the box, as Yoga measures it, so a blank at the end of a
        // full row stays on that row; the box clips the extra cell.
        let plain: String = plan.value.segments.iter().map(|segment| match segment { Segment::Plain(text) | Segment::Selected(text) => text.as_str() }).collect();
        let text_width = props.content_cells() + usize::from(text_width(&plain) > props.content_cells());
        let previous = painter.push_clip(area);
        painter.text(cx + label_width, value_row, &ansi, themed(Key::Text), text_width, TextWrap::Hard);
        painter.pop_clip(previous);
    } else {
        // The label and the value share the row; a value as wide as the row takes cells from the label.
        let plain: String = plan.value.segments.iter().map(|segment| match segment { Segment::Plain(text) | Segment::Selected(text) => text.as_str() }).collect();
        let modes = (TextWrap::Wrap, TextWrap::TruncateEnd);
        let split = split_row(&props.prompt_label, &plain, props.columns.saturating_sub(4), modes, Justify::Start);
        painter.text(cx, value_row, &props.prompt_label, themed(Key::Inactive), split.left_cells, modes.0);
        painter.text(cx + split.right_x as i32, value_row, &ansi, themed(Key::Text), split.right_cells, modes.1);
    }
    paint_sign_in_url(painter, x, y + i32::from(border_rows), columns, &plan.detail_text, &plan.url_layout, status);
    border_rows + plan.url_layout.rows as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(value: &str, cursor: usize) -> TextEntryDraft {
        TextEntryDraft { value: value.to_owned(), cursor, selection_anchor: None }
    }

    #[test]
    fn newlines_show_as_a_glyph_and_hints_are_one_line() {
        assert_eq!(flatten_for_single_line("a\nb"), "a\u{23ce}b");
        assert_eq!(single_line(" two\n  lines "), "two lines");
    }

    #[test]
    fn the_window_keeps_the_caret_in_view_and_aligns_to_whole_glyphs() {
        let short = window_single_line("abc", 3, 10);
        assert_eq!((short.text.as_str(), short.caret_col), ("abc", 3));
        // The caret at the end of a long line: the start is capped so the window ends with the text, which puts the
        // caret cell one past the window (as it does in Node).
        let long = window_single_line("abcdefghij", 10, 5);
        assert_eq!((long.text.as_str(), long.cu_start, long.cu_end, long.caret_col), ("fghij", 5, 10, 5));
        let middle = window_single_line("abcdefghij", 2, 5);
        assert_eq!((middle.text.as_str(), middle.caret_col), ("abcde", 2));
        let wide = window_single_line("日本語テ", 4, 5);
        assert_eq!((wide.text.as_str(), wide.cu_start), ("本語", 1));
    }

    #[test]
    fn a_masked_value_never_shows_the_secret() {
        let secret = draft("pa\u{1f600}ss\nx", 7);
        let view = render_text_entry_value(&secret, true, true, 20, 8);
        let shown: String = view.segments.iter().map(|segment| match segment { Segment::Plain(text) | Segment::Selected(text) => text.as_str() }).collect();
        assert!(!shown.contains("pa") && !shown.contains('x'));
        assert!(shown.contains('*') && shown.contains('\n'));
        let single = render_text_entry_value(&draft("secret", 6), true, false, 20, 8);
        assert_eq!(single.segments, vec![Segment::Plain("****** ".to_owned())]);
    }

    #[test]
    fn the_selection_is_marked_in_the_window_and_the_caret_gets_a_blank_cell() {
        let mut selected = draft("hello world", 5);
        selected.selection_anchor = Some(0);
        let view = render_text_entry_value(&selected, false, false, 40, 8);
        assert_eq!(view.segments, vec![Segment::Selected("hello".to_owned()), Segment::Plain(" world".to_owned())]);
        let end = render_text_entry_value(&draft("abc", 3), false, false, 40, 8);
        assert_eq!(end.segments, vec![Segment::Plain("abc ".to_owned())]);
    }

    #[test]
    fn a_multiline_value_takes_its_wrapped_rows_up_to_the_maximum() {
        let value = draft("aaaa\nbbbb\ncccc\ndddd", 19);
        let view = render_text_entry_value(&value, false, true, 10, 3);
        assert_eq!(view.content_height, 3);
        assert_eq!(view.segments, vec![Segment::Plain("bbbb\ncccc\ndddd ".to_owned())]);
        let all = render_text_entry_value(&value, false, true, 10, 8);
        assert_eq!(all.content_height, 4);
    }

    #[test]
    fn the_cursor_anchor_follows_the_caret_inside_the_box() {
        assert_eq!(text_entry_cursor(&draft("abc", 2), false, false, 20, 8, "> "), (0, 4));
        assert_eq!(text_entry_cursor(&draft("aaaa\nbb", 7), false, true, 10, 8, "> "), (1, 2));
        assert_eq!(text_entry_cursor(&draft("aaaa\nbbbb\ncccc\ndddd", 19), false, true, 10, 3, "> "), (2, 4));
    }

    #[test]
    fn the_panel_is_the_chrome_the_value_and_the_url_block() {
        let props = TextEntryProps::new("Name");
        assert_eq!(text_entry_rows(&props, &TextEntryDraft::new("x"), CopyStatus::Idle), 2 + 4 + 1);
        let mut multi = TextEntryProps::new("Name");
        multi.multiline = true;
        multi.columns = 40;
        // 70 cells and the caret cell wrap to three rows of 34.
        assert_eq!(text_entry_rows(&multi, &TextEntryDraft::new(&"a".repeat(70)), CopyStatus::Idle), 2 + 4 + 3);
        multi.detail = "https://example.com/x".to_owned();
        assert!(text_entry_rows(&multi, &TextEntryDraft::new("abc"), CopyStatus::Idle) > 2 + 4 + 1);
    }
}
