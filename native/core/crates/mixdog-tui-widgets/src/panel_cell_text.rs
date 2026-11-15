//! `components/panel-cell-text.mjs`: fitting panel text to a number of cells.

use mixdog_termtext::{StringWidthOptions, string_width};

/// `stringWidth(text)` of the `string-width` package, which the panels measure with.
pub(crate) fn cells(text: &str) -> usize {
    string_width(text, StringWidthOptions::default())
}

/// `truncatePanelText(value, width)`: the text if it fits, else its start with a closing `…` that fits `width`
/// (a width of one or less is only ellipses; no width is nothing).
pub fn truncate_panel_text(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if cells(value) <= width {
        return value.to_owned();
    }
    if width <= 1 {
        return "\u{2026}".repeat(width);
    }
    let mut out = String::new();
    for ch in value.chars() {
        let mut candidate = out.clone();
        candidate.push(ch);
        candidate.push('\u{2026}');
        if cells(&candidate) > width {
            break;
        }
        out.push(ch);
    }
    out.push('\u{2026}');
    out
}

/// `padPanelCells(value, width)`: the text followed by blanks up to `width` cells.
pub fn pad_panel_cells(value: &str, width: usize) -> String {
    format!("{value}{}", " ".repeat(width.saturating_sub(cells(value))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_that_fits_is_kept_and_the_rest_ends_in_an_ellipsis() {
        assert_eq!(truncate_panel_text("abc", 3), "abc");
        assert_eq!(truncate_panel_text("abcdef", 4), "abc\u{2026}");
        assert_eq!(truncate_panel_text("abcdef", 1), "\u{2026}");
        assert_eq!(truncate_panel_text("abcdef", 0), "");
    }

    #[test]
    fn a_wide_glyph_that_does_not_fit_before_the_ellipsis_is_left_out() {
        assert_eq!(truncate_panel_text("日本語", 4), "日\u{2026}");
        assert_eq!(truncate_panel_text("日本語", 5), "日本\u{2026}");
        assert_eq!(truncate_panel_text("日本語", 6), "日本語");
    }

    #[test]
    fn padding_counts_cells_not_chars() {
        assert_eq!(pad_panel_cells("日", 4), "日  ");
        assert_eq!(pad_panel_cells("abcdef", 3), "abcdef");
    }
}
