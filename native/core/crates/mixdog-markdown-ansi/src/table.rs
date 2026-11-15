//! Tables (`table-layout.mjs`): the single source of truth for how a table token is laid out into terminal lines. The
//! renderer (`MarkdownTable.jsx` prints the lines verbatim) and the row measurement ([`crate::measure`]) both call
//! [`build_table_layout`], so the painted line count and the measured one cannot drift.
//!
//! The layout fits the columns (ideal widths, proportional shrink toward the per-column minimum, a hard-wrapping
//! scale-down), falls back to one `Header: value` line per cell when a cell needs more than four lines or the built box
//! still overflows, and otherwise draws the bordered box.

mod box_lines;
mod cells;
mod column_widths;
mod vertical_lines;

use mixdog_termtext::{display_width, strip_ansi};

use crate::lexer::{TableCell, Token};
use box_lines::{BorderKind, render_border_line, render_row_lines};
use column_widths::{MAX_ROW_LINES, SAFETY_MARGIN, calculate_max_row_lines, compute_column_widths};
use vertical_lines::render_vertical_lines;

/// The width a table lays out at when the caller does not know the terminal's (`Number(terminalWidth) || 80`).
const DEFAULT_WIDTH: usize = 80;

/// `assistantBodyWidth(columns)`: the assistant markdown body width, three columns less than the terminal's, at least 8.
pub fn assistant_body_width(columns: usize) -> usize {
    let columns = if columns == 0 { DEFAULT_WIDTH } else { columns };
    columns.saturating_sub(3).max(8)
}

/// What [`build_table_layout`] returns: the exact lines the table draws and whether they are the vertical fallback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableRender {
    pub lines: Vec<String>,
    pub use_vertical_format: bool,
}

/// The header cells of a table token; none for a token that is not a table.
fn header_of(token: &Token) -> &[TableCell] {
    token.header.as_deref().unwrap_or(&[])
}

fn rows_of(token: &Token) -> &[Vec<TableCell>] {
    token.rows.as_deref().unwrap_or(&[])
}

/// `buildTableRender(token, terminalWidth)`: the lines of `token` at `terminal_width` columns (0 is unknown, 80).
pub fn build_table_layout(token: &Token, terminal_width: usize) -> TableRender {
    let width = if terminal_width == 0 { DEFAULT_WIDTH } else { terminal_width };
    let widths = compute_column_widths(token, width);

    // Step 4: the tallest cell decides the vertical fallback.
    if calculate_max_row_lines(token, &widths) > MAX_ROW_LINES {
        return TableRender { lines: render_vertical_lines(token, width), use_vertical_format: true };
    }

    let columns = &widths.column_widths;
    let rows = rows_of(token);
    let mut table_lines = vec![render_border_line(BorderKind::Top, columns)];
    table_lines.extend(render_row_lines(header_of(token), true, token, &widths));
    table_lines.push(render_border_line(BorderKind::Middle, columns));
    for (row_index, row) in rows.iter().enumerate() {
        table_lines.extend(render_row_lines(row, false, token, &widths));
        if row_index + 1 < rows.len() {
            table_lines.push(render_border_line(BorderKind::Middle, columns));
        }
    }
    table_lines.push(render_border_line(BorderKind::Bottom, columns));

    // Safety: a line that would overflow (a resize race) falls back to the vertical layout.
    let max_line_width = table_lines.iter().map(|line| display_width(&strip_ansi(line))).max().unwrap_or(0);
    if max_line_width + SAFETY_MARGIN > width {
        return TableRender { lines: render_vertical_lines(token, width), use_vertical_format: true };
    }
    TableRender { lines: table_lines, use_vertical_format: false }
}

/// The lines of the table `token` at `columns` columns.
pub fn build_table_render(token: &Token, columns: usize) -> Vec<String> {
    build_table_layout(token, columns).lines
}

/// `measureMarkdownTableRows(token, terminalWidth)`: the exact number of lines a table token occupies once rendered at
/// `terminal_width`; 0 for a token without a header.
pub fn measure_markdown_table_rows(token: &Token, terminal_width: usize) -> usize {
    if header_of(token).is_empty() {
        return 0;
    }
    build_table_layout(token, terminal_width).lines.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::TokenKind;

    fn cell(text: &str) -> TableCell {
        let mut token = Token::new(TokenKind::Text, text);
        token.text = Some(text.to_owned());
        TableCell { text: text.to_owned(), tokens: vec![token], header: false, align: None, queued: None }
    }

    fn table(header: &[&str], rows: &[&[&str]]) -> Token {
        let mut token = Token::new(TokenKind::Table, "");
        token.header = Some(header.iter().map(|text| cell(text)).collect());
        token.rows = Some(rows.iter().map(|row| row.iter().map(|text| cell(text)).collect()).collect());
        token.align = Some(Vec::new());
        token
    }

    fn plain(lines: &[String]) -> Vec<String> {
        lines.iter().map(|line| strip_ansi(line).into_owned()).collect()
    }

    #[test]
    fn narrow_vertical_tables_preserve_empty_cells_and_exact_row_counts() {
        let token = table(&["A", "B"], &[&["", "ok"], &["x", ""]]);
        let rendered = build_table_layout(&token, 10);
        assert!(rendered.use_vertical_format);
        assert_eq!(plain(&rendered.lines), ["A:", "B: ok", "\u{2500}".repeat(9).as_str(), "A: x", "B:"]);
        assert_eq!(measure_markdown_table_rows(&token, 10), 5);
    }

    #[test]
    fn a_table_that_fits_is_drawn_as_a_box() {
        let token = table(&["Name", "Qty"], &[&["apple", "3"]]);
        let rendered = build_table_layout(&token, 40);
        assert!(!rendered.use_vertical_format);
        let rule = |left: &str, cross: &str, right: &str| {
            format!("{left}{}{cross}{}{right}", "\u{2500}".repeat(7), "\u{2500}".repeat(5))
        };
        assert_eq!(
            plain(&rendered.lines),
            [
                rule("\u{250c}", "\u{252c}", "\u{2510}").as_str(),
                "\u{2502} Name  \u{2502} Qty \u{2502}",
                rule("\u{251c}", "\u{253c}", "\u{2524}").as_str(),
                "\u{2502} apple \u{2502} 3   \u{2502}",
                rule("\u{2514}", "\u{2534}", "\u{2518}").as_str(),
            ]
        );
        assert_eq!(build_table_render(&token, 40), rendered.lines);
        assert_eq!(measure_markdown_table_rows(&token, 40), 5);
    }

    #[test]
    fn an_unknown_width_is_eighty_and_a_token_without_header_has_no_rows() {
        let token = table(&["A"], &[&["b"]]);
        assert_eq!(build_table_layout(&token, 0), build_table_layout(&token, 80));
        assert_eq!(measure_markdown_table_rows(&Token::new(TokenKind::Table, ""), 40), 0);
    }

    #[test]
    fn the_body_width_is_three_less_than_the_terminal_and_never_under_eight() {
        assert_eq!(assistant_body_width(80), 77);
        assert_eq!(assistant_body_width(0), 77);
        assert_eq!(assistant_body_width(10), 8);
        assert_eq!(assistant_body_width(1), 8);
    }
}
