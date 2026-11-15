//! Cell text of a table token: the formatted (ANSI) text the terminal draws, its plain form, and the two widths the
//! column fit is decided from (`table-layout/cells.mjs`).

use mixdog_js::is_js_space;
use mixdog_termtext::{display_width, strip_ansi};

use crate::format::{Context, format_token};
use crate::lexer::{TableCell, Token};

pub(super) const MIN_COLUMN_WIDTH: usize = 3;

/// `row[colIndex]?.tokens ?? []`.
pub(super) fn tokens_at(row: &[TableCell], column: usize) -> &[Token] {
    row.get(column).map_or(&[], |cell| cell.tokens.as_slice())
}

/// `formatCell(tokens)`: the cell's tokens formatted and joined.
pub(super) fn format_cell(tokens: &[Token]) -> String {
    let context = Context::default();
    tokens.iter().map(|token| format_token(token, &context)).collect()
}

/// `plainCellText(tokens)`.
pub(super) fn plain_cell_text(tokens: &[Token]) -> String {
    strip_ansi(&format_cell(tokens)).into_owned()
}

/// `cellMinWidth(tokens)`: the narrowest width that never splits a word.
pub(super) fn cell_min_width(tokens: &[Token]) -> usize {
    let text = plain_cell_text(tokens);
    text.split(is_js_space).filter(|word| !word.is_empty()).map(display_width).max().unwrap_or(0).max(MIN_COLUMN_WIDTH)
}

/// `cellIdealWidth(tokens)`: the width that fits the whole cell on one line.
pub(super) fn cell_ideal_width(tokens: &[Token]) -> usize {
    display_width(&plain_cell_text(tokens)).max(MIN_COLUMN_WIDTH)
}
