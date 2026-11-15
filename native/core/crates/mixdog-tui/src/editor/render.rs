//! The look of the prompt box content (`components/PromptInput.jsx`, `prompt-input/selected-text.jsx`): the value hard-wrapped
//! at the content width by display width, the selection highlighted, a trailing blank cell when the caret sits at the end,
//! the hint shown over an empty box, and the caret cell the frame writer parks the hardware cursor at.
//!
//! The rounded border and the surface background belong to the layout that hosts the box.

use mixdog_termtext::display_width;
use mixdog_termtext::wrap::{WrapMode, wrap_text};
use mixdog_tui_style::Key;
use unicode_segmentation::UnicodeSegmentation;

use super::draft::Draft;
use super::editing::{Caret, advance, caret_position, len16, selection_range};
use super::helpers::{HintTone, hint_color};

/// Tab stops of the wrapped text are every this many columns of the line.
const TAB_SIZE: usize = 8;

/// A run of text in one style: a theme foreground and, for the selection, a background.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub fg: Key,
    pub bg: Option<Key>,
}

/// The painted rows of the box content and where the caret is.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PromptRender {
    pub rows: Vec<Vec<Span>>,
    /// The caret cell inside the content (row, column); none when the box is not an edit target.
    pub caret: Option<Caret>,
}

/// What the render reads.
#[derive(Clone, Copy, Debug)]
pub struct PromptView<'a> {
    pub draft: &'a Draft,
    pub mask: bool,
    pub hint: &'a str,
    pub hint_tone: HintTone,
    /// The content width in columns.
    pub width: usize,
    /// Whether the hardware caret is parked in the box (a real, enabled edit target).
    pub caret_enabled: bool,
}

/// The value shown for a masked prompt: every character but a newline becomes `*`, one per UTF-16 unit (the JavaScript
/// replace works on units, so an emoji shows two).
pub fn mask_value(value: &str) -> String {
    value.chars().map(|c| if c == '\n' { "\n".to_owned() } else { "*".repeat(c.len_utf16()) }).collect()
}

fn push_piece(row: &mut Vec<Span>, text: &str, selected: bool) {
    let (fg, bg) = if selected { (Key::SelectionText, Some(Key::SelectionBackground)) } else { (Key::Text, None) };
    match row.last_mut() {
        Some(last) if last.fg == fg && last.bg == bg => last.text.push_str(text),
        _ => row.push(Span { text: text.to_owned(), fg, bg }),
    }
}

/// Renders the prompt content.
pub fn render_prompt(view: &PromptView<'_>) -> PromptRender {
    let width = view.width.max(1);
    let value = &view.draft.value;
    let length = len16(value);
    let caret = view.caret_enabled.then(|| {
        let trailing = if view.draft.cursor >= length { Some(true) } else { None };
        caret_position(value, view.draft.cursor, width, trailing)
    });
    if value.is_empty() && !view.hint.is_empty() {
        let fg = hint_color(view.hint_tone);
        let rows = wrap_text(view.hint, width, WrapMode::Wrap)
            .split('\n')
            .map(|line| vec![Span { text: line.to_owned(), fg, bg: None }])
            .collect();
        return PromptRender { rows, caret };
    }
    let mut display = if view.mask { mask_value(value) } else { value.clone() };
    // A trailing blank cell gives the caret at the end of the input a cell to sit on.
    if view.draft.cursor == length {
        display.push(' ');
    }
    let range = selection_range(view.draft);
    let clusters: Vec<&str> = display.graphemes(true).collect();
    let mut rows: Vec<Vec<Span>> = vec![Vec::new()];
    let (mut row, mut col, mut at, mut line_col) = (0, 0, 0, 0);
    // The cluster before this one filled its row and moved on: a newline right after it is that row's break, not another.
    let mut flushed = false;
    for (i, cluster) in clusters.iter().enumerate() {
        let selected = range.is_some_and(|r| at >= r.start && at < r.end);
        let was_flushed = std::mem::take(&mut flushed);
        if *cluster == "\n" {
            line_col = 0;
            if !was_flushed {
                row += 1;
                col = 0;
                while rows.len() <= row {
                    rows.push(Vec::new());
                }
            }
            at += 1;
            continue;
        }
        // A tab shows as spaces up to the next tab stop of its line; the spaces belong to the tab's offset.
        let cells: Vec<&str> = if *cluster == "\t" { vec![" "; TAB_SIZE - line_col % TAB_SIZE] } else { vec![*cluster] };
        line_col += if *cluster == "\t" { cells.len() } else { display_width(cluster) };
        for (k, cell) in cells.iter().enumerate() {
            let more_follows = i + 1 < clusters.len() || k + 1 < cells.len();
            let step = advance(row, col, cell, width, more_follows);
            while rows.len() <= step.row.max(step.drawn_row) {
                rows.push(Vec::new());
            }
            push_piece(&mut rows[step.drawn_row], cell, selected);
            flushed = step.row > step.drawn_row;
            (row, col) = (step.row, step.col);
        }
        at += mixdog_js::utf16_len(cluster);
    }
    PromptRender { rows, caret }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(draft: &Draft, width: usize) -> PromptView<'_> {
        PromptView { draft, mask: false, hint: "", hint_tone: HintTone::Info, width, caret_enabled: true }
    }

    fn texts(render: &PromptRender) -> Vec<String> {
        render.rows.iter().map(|row| row.iter().map(|span| span.text.as_str()).collect()).collect()
    }

    #[test]
    fn a_long_value_hard_wraps_at_the_width_with_a_trailing_cell_for_the_caret() {
        let draft = Draft::at_end("abcdefgh");
        let render = render_prompt(&view(&draft, 4));
        assert_eq!(texts(&render), ["abcd", "efgh", " "]);
        assert_eq!(render.caret, Some(Caret { row: 2, col: 0 }));
    }

    #[test]
    fn a_wide_glyph_that_does_not_fit_goes_whole_to_the_next_row() {
        let draft = Draft::new("abc\u{65e5}x", 0, None);
        let render = render_prompt(&view(&draft, 4));
        assert_eq!(texts(&render), ["abc", "\u{65e5}x"]);
        assert_eq!(render.caret, Some(Caret { row: 0, col: 0 }));
    }

    #[test]
    fn newlines_start_rows_and_are_not_drawn() {
        let draft = Draft::at_end("a\n\nb");
        assert_eq!(texts(&render_prompt(&view(&draft, 10))), ["a", "", "b "]);
        let trailing = Draft::at_end("a\n");
        assert_eq!(texts(&render_prompt(&view(&trailing, 10))), ["a", " "]);
    }

    #[test]
    fn the_selection_is_a_highlighted_span() {
        let draft = Draft::new("hello world", 8, Some(3));
        let render = render_prompt(&view(&draft, 40));
        let row = &render.rows[0];
        assert_eq!(row.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), ["hel", "lo wo", "rld"]);
        assert_eq!(row[1].fg, Key::SelectionText);
        assert_eq!(row[1].bg, Some(Key::SelectionBackground));
        assert_eq!((row[0].fg, row[0].bg), (Key::Text, None));
    }

    #[test]
    fn a_masked_prompt_shows_stars_for_every_unit_but_newlines() {
        let draft = Draft::at_end("ab\n\u{1F600}");
        let mut v = view(&draft, 10);
        v.mask = true;
        assert_eq!(texts(&render_prompt(&v)), ["**", "** "]);
        assert_eq!(mask_value("x\r\n"), "**\n");
    }

    #[test]
    fn an_empty_box_shows_the_hint_in_its_tone() {
        let draft = Draft::empty();
        let mut v = view(&draft, 10);
        v.hint = "type a message";
        v.hint_tone = HintTone::Error;
        let render = render_prompt(&v);
        assert_eq!(texts(&render), ["type a", "message"]);
        assert_eq!(render.rows[0][0].fg, Key::Error);
        assert_eq!(render.caret, Some(Caret { row: 0, col: 0 }));
        let typed = Draft::at_end("x");
        v.draft = &typed;
        assert_eq!(texts(&render_prompt(&v)), ["x "]);
    }

    #[test]
    fn no_caret_when_the_box_is_not_an_edit_target() {
        let draft = Draft::at_end("x");
        let mut v = view(&draft, 10);
        v.caret_enabled = false;
        assert_eq!(render_prompt(&v).caret, None);
    }
}
