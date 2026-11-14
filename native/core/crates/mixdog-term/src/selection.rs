//! Text selection over the grid. Filled in by the frame task.

use crate::frame::{Grid, Rect};

/// A selection anchored in the grid.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    pub rect: Rect,
}

/// The text a selection covers.
pub fn selected_text(_grid: &Grid, _selection: &Selection) -> String {
    String::new()
}

/// The rectangle of the word at a cell.
pub fn word_rect_at(_grid: &Grid, _col: u16, _row: u16) -> Option<Rect> {
    None
}

/// The rectangle of the line at a row.
pub fn line_rect_at(_grid: &Grid, _row: u16) -> Option<Rect> {
    None
}
