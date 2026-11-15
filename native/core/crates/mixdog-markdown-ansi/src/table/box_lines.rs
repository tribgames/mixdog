//! The bordered horizontal table (`table-layout/box-lines.mjs`): one row's wrapped, vertically centred and aligned
//! cell lines, and the three border rules.

use mixdog_termtext::display_width;
use mixdog_termtext::wrap::wrap_lines;

use super::cells::format_cell;
use super::column_widths::ColumnWidths;
use crate::format::pad_aligned;
use crate::lexer::{Align, TableCell, Token};

/// Which rule of the box a border line is.
#[derive(Clone, Copy)]
pub(super) enum BorderKind {
    Top,
    Middle,
    Bottom,
}

/// `[left, fill, cross, right]` of a rule.
fn glyphs(kind: BorderKind) -> [&'static str; 4] {
    match kind {
        BorderKind::Top => ["\u{250c}", "\u{2500}", "\u{252c}", "\u{2510}"],
        BorderKind::Middle => ["\u{251c}", "\u{2500}", "\u{253c}", "\u{2524}"],
        BorderKind::Bottom => ["\u{2514}", "\u{2500}", "\u{2534}", "\u{2518}"],
    }
}

/// `renderRowLines(cells, isHeader, { token, columnWidths, needsHardWrap })`.
pub(super) fn render_row_lines(
    cells: &[TableCell],
    is_header: bool,
    token: &Token,
    widths: &ColumnWidths,
) -> Vec<String> {
    let width_of = |column: usize| widths.column_widths.get(column).copied().unwrap_or(0);
    let cell_lines: Vec<Vec<String>> = cells
        .iter()
        .enumerate()
        .map(|(column, cell)| wrap_lines(&format_cell(&cell.tokens), width_of(column), widths.needs_hard_wrap))
        .collect();
    let max_lines = cell_lines.iter().map(Vec::len).max().unwrap_or(0).max(1);
    let mut result = Vec::with_capacity(max_lines);
    for line_index in 0..max_lines {
        let mut line = String::from("\u{2502}");
        for (column, lines) in cell_lines.iter().enumerate() {
            let offset = (max_lines - lines.len()) / 2;
            let text = line_index.checked_sub(offset).and_then(|at| lines.get(at)).map_or("", String::as_str);
            let align = if is_header {
                Some(Align::Center)
            } else {
                token.align.as_ref().and_then(|align| align.get(column).copied().flatten())
            };
            line.push(' ');
            line.push_str(&pad_aligned(text, display_width(text), width_of(column), align));
            line.push_str(" \u{2502}");
        }
        result.push(line);
    }
    result
}

/// `renderBorderLine(type, columnWidths)`.
pub(super) fn render_border_line(kind: BorderKind, column_widths: &[usize]) -> String {
    let [left, fill, cross, right] = glyphs(kind);
    let mut line = String::from(left);
    for (column, width) in column_widths.iter().enumerate() {
        line.push_str(&fill.repeat(width + 2));
        line.push_str(if column + 1 < column_widths.len() { cross } else { right });
    }
    line
}
