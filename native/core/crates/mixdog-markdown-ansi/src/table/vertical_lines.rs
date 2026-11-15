//! The vertical fallback (`table-layout/vertical-lines.mjs`): one `Header: value` line per cell, hard-wrapped to the
//! terminal width with an indented continuation, and a rule between rows. Used when a cell would need more than four
//! lines, or when the built box still overflows.

use mixdog_js::{is_js_space, js_trim};
use mixdog_termtext::lone::replace_carriers;
use mixdog_termtext::wrap::hard_wrap_ansi_lines_carried;
use mixdog_termtext::{display_width, strip_ansi};

use super::cells::{format_cell, plain_cell_text};
use super::rows_of;
use crate::lexer::Token;

const ANSI_BOLD_START: &str = "\u{1b}[1m";
const ANSI_BOLD_END: &str = "\u{1b}[22m";

/// `value.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()`: every run of whitespace becomes one space.
fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for ch in value.chars() {
        if is_js_space(ch) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    js_trim(&out).to_owned()
}

/// `pushFitted(rawLine)`: the line hard-wrapped to `width`.
fn push_fitted(lines: &mut Vec<String>, raw_line: &str, width: usize) {
    lines.extend(hard_wrap_ansi_lines_carried(raw_line, width));
}

pub(super) fn render_vertical_lines(token: &Token, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let headers: Vec<String> = token.header.iter().flatten().map(|head| plain_cell_text(&head.tokens)).collect();
    let separator = "\u{2500}".repeat(width.saturating_sub(1).min(40));
    let wrap_indent = "  ";
    let indent_width = display_width(wrap_indent);
    for (row_index, row) in rows_of(token).iter().enumerate() {
        if row_index > 0 {
            lines.push(separator.clone());
        }
        for (column, cell) in row.iter().enumerate() {
            let label = headers
                .get(column)
                .filter(|label| !label.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("Column {}", column + 1));
            let formatted = format_cell(&cell.tokens);
            let value = collapse_whitespace(formatted.trim_end_matches(is_js_space));
            let prefix = format!("{ANSI_BOLD_START}{label}:{ANSI_BOLD_END} ");
            let prefix_width = display_width(&strip_ansi(&prefix));
            let first_value_width = width.saturating_sub(prefix_width).max(1);
            let cont_value_width = width.saturating_sub(indent_width).max(1);
            let first_value_lines = hard_wrap_ansi_lines_carried(&value, first_value_width);
            push_fitted(&mut lines, &format!("{prefix}{}", first_value_lines[0]), width);
            let tail = js_trim(&first_value_lines[1..].join(" ")).to_owned();
            if !tail.is_empty() {
                for cont in hard_wrap_ansi_lines_carried(&tail, cont_value_width) {
                    if js_trim(&cont).is_empty() {
                        continue;
                    }
                    push_fitted(&mut lines, &format!("{wrap_indent}{cont}"), width);
                }
            }
        }
    }
    // Each half of a cut pair travelled as a zero-width carrier; it is what Node writes for it, U+FFFD, in the output.
    lines.iter().map(|line| replace_carriers(line)).collect()
}
