//! The width and theme bound text helpers of the tool card (`tool-execution/text-format.mjs`): the visible budget of one
//! collapsed result line, the `+N` / `-N` line counts coloured, and the fitting of a line to a width.

use mixdog_termtext::display_width;
use mixdog_tui_style::Key;
use mixdog_view_model::card_model::{MIN_RESULT_LINE_CHARS, RESULT_LINE_HARD_MAX, safe_inline_text, split_line_delta_tokens};

use crate::{Run, themed};

/// The visible width budget of one collapsed result line at `columns` (0 is the default 80).
pub fn result_line_max_chars(columns: usize) -> usize {
    let columns = if columns == 0 { 80 } else { columns };
    RESULT_LINE_HARD_MAX.min(MIN_RESULT_LINE_CHARS.max(columns.saturating_sub(7)))
}

/// `text` as runs of `color`, the signed line counts ("+12 Lines") in the success and error colours.
pub fn delta_text_runs(text: &str, color: Key) -> Vec<Run> {
    split_line_delta_tokens(text)
        .into_iter()
        .map(|part| {
            let key = match part.delta {
                Some('+') => Key::Success,
                Some(_) => Key::Error,
                None => color,
            };
            (part.text, themed(key))
        })
        .collect()
}

/// Trims `text` from the end (by display width) so it fits `max_width`, appending an ellipsis. The text is made one row first.
pub fn truncate_to_width(text: &str, max_width: usize) -> String {
    let text = safe_inline_text(text);
    if max_width < 1 {
        return String::new();
    }
    if display_width(&text) <= max_width {
        return text;
    }
    let mut out = String::new();
    for ch in text.chars() {
        let mut probe = out.clone();
        probe.push(ch);
        probe.push('\u{2026}');
        if display_width(&probe) > max_width {
            break;
        }
        out.push(ch);
    }
    out.push('\u{2026}');
    out
}

/// One result line made a row that fits the collapsed budget of `columns`.
pub fn fit_result_line(line: &str, columns: usize) -> String {
    let max = result_line_max_chars(columns);
    let text = safe_inline_text(line);
    if display_width(&text) > max { truncate_to_width(&text, max) } else { text }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_budget_follows_the_columns() {
        assert_eq!(result_line_max_chars(160), 80);
        assert_eq!(result_line_max_chars(40), 33);
        assert_eq!(result_line_max_chars(10), 24);
        assert_eq!(result_line_max_chars(0), 73);
    }

    #[test]
    fn delta_parts_colour_only_signed_line_counts() {
        let parts = |text: &str| delta_text_runs(text, Key::Text).into_iter().map(|(text, style)| (text, style.fg)).collect::<Vec<_>>();
        let success = themed(Key::Success).fg;
        let error = themed(Key::Error).fg;
        let text = themed(Key::Text).fg;
        assert_eq!(
            parts("Changed (+ 12 Lines, - 3 lines)."),
            vec![
                ("Changed ".to_owned(), text),
                ("(".to_owned(), text),
                ("+12".to_owned(), success),
                (" Lines,".to_owned(), text),
                (" ".to_owned(), text),
                ("-3".to_owned(), error),
                (" lines).".to_owned(), text),
            ]
        );
        assert_eq!(
            parts("+0 line\n- 2 LINES"),
            vec![("+0".to_owned(), success), (" line".to_owned(), text), ("\n".to_owned(), text), ("-2".to_owned(), error), (" LINES".to_owned(), text),]
        );
    }

    #[test]
    fn delta_parts_leave_non_line_counts_and_adjacent_signs_unchanged() {
        let text = "x+2 Lines +4 bytes a-3 Lines";
        assert_eq!(delta_text_runs(text, Key::Text).len(), 1);
        assert_eq!(delta_text_runs(text, Key::Text)[0].0, text);
        assert!(delta_text_runs("", Key::Text).is_empty());
    }

    #[test]
    fn a_long_line_is_cut_with_an_ellipsis_at_the_width() {
        assert_eq!(truncate_to_width("abcdefghij", 5), "abcd\u{2026}");
        assert_eq!(truncate_to_width("abc", 5), "abc");
        assert_eq!(truncate_to_width("abc", 0), "");
        assert_eq!(fit_result_line("a\tb\nc", 80), "a b c");
    }
}
