//! The column fit (`table-layout/column-widths.mjs`): ideal widths when they fit, a proportional shrink toward the
//! per-column minimum when they do not, and a hard-wrapping scale-down when even the minimums overflow. Plus the
//! wrapped height that decides the vertical fallback.
//!
//! The arithmetic is JavaScript's: the shares are computed in floating point and floored, so the widths are the same
//! integers the Node product reached.

use mixdog_termtext::wrap::wrap_lines;

use super::cells::{MIN_COLUMN_WIDTH, cell_ideal_width, cell_min_width, format_cell, tokens_at};
use super::{header_of, rows_of};
use crate::lexer::Token;

pub(super) const SAFETY_MARGIN: usize = 4;
pub(super) const MAX_ROW_LINES: usize = 4;

/// The fit of the columns: their widths and whether a cell is hard-wrapped to them.
pub(super) struct ColumnWidths {
    pub(super) column_widths: Vec<usize>,
    pub(super) needs_hard_wrap: bool,
}

pub(super) fn compute_column_widths(token: &Token, width: usize) -> ColumnWidths {
    let header = header_of(token);
    let rows = rows_of(token);
    // Step 1: the minimum (longest word) and ideal (full content) width of every column.
    let min_widths: Vec<usize> = header
        .iter()
        .enumerate()
        .map(|(column, head)| {
            rows.iter().map(|row| cell_min_width(tokens_at(row, column))).fold(cell_min_width(&head.tokens), usize::max)
        })
        .collect();
    let ideal_widths: Vec<usize> = header
        .iter()
        .enumerate()
        .map(|(column, head)| {
            rows.iter().map(|row| cell_ideal_width(tokens_at(row, column))).fold(cell_ideal_width(&head.tokens), usize::max)
        })
        .collect();

    // Step 2: the available space.
    let columns = header.len();
    let border_overhead = 1 + columns * 3;
    let available = width.saturating_sub(border_overhead + SAFETY_MARGIN).max(columns * MIN_COLUMN_WIDTH);

    // Step 3: fit the widths into it.
    let total_min: usize = min_widths.iter().sum();
    let total_ideal: usize = ideal_widths.iter().sum();
    if total_ideal <= available {
        return ColumnWidths { column_widths: ideal_widths, needs_hard_wrap: false };
    }
    if total_min <= available {
        let extra_space = (available - total_min) as f64;
        let overflows: Vec<i64> =
            ideal_widths.iter().zip(&min_widths).map(|(ideal, min)| *ideal as i64 - *min as i64).collect();
        let total_overflow: i64 = overflows.iter().sum();
        let column_widths = min_widths
            .iter()
            .zip(&overflows)
            .map(|(min, overflow)| {
                if total_overflow == 0 {
                    return *min;
                }
                let share = ((*overflow as f64 / total_overflow as f64) * extra_space).floor();
                (*min as i64 + share as i64).max(0) as usize
            })
            .collect();
        return ColumnWidths { column_widths, needs_hard_wrap: false };
    }
    let scale_factor = available as f64 / total_min as f64;
    ColumnWidths {
        column_widths: min_widths
            .iter()
            .map(|w| ((*w as f64 * scale_factor).floor() as usize).max(MIN_COLUMN_WIDTH))
            .collect(),
        needs_hard_wrap: true,
    }
}

/// `calculateMaxRowLines(token, columnWidths, needsHardWrap)`: the tallest wrapped cell of the table, in lines.
pub(super) fn calculate_max_row_lines(token: &Token, widths: &ColumnWidths) -> usize {
    let lines_of = |tokens: &[Token], column: usize| {
        let at = widths.column_widths.get(column).copied().unwrap_or(0);
        wrap_lines(&format_cell(tokens), at, widths.needs_hard_wrap).len()
    };
    let mut max_lines = 1;
    for (column, head) in header_of(token).iter().enumerate() {
        max_lines = max_lines.max(lines_of(&head.tokens, column));
    }
    for row in rows_of(token) {
        for (column, cell) in row.iter().enumerate() {
            max_lines = max_lines.max(lines_of(&cell.tokens, column));
        }
    }
    max_lines
}
