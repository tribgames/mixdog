//! The cell grid and the frame writer. Filled in by the frame task.

/// A rectangle of cells.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

/// The display attributes of a cell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Style;

/// One cell of the grid.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cell {
    pub text: String,
    pub style: Style,
}

/// The screen as rows of cells.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Grid {
    pub width: u16,
    pub height: u16,
    pub cells: Vec<Cell>,
}

/// Writes frames to the terminal as minimal diffs.
#[derive(Debug, Default)]
pub struct FrameWriter;
