//! A VT test grid for replaying frames. Filled in by the frame task.

use crate::frame::Grid;

/// A grid built by replaying terminal output.
#[derive(Debug, Default)]
pub struct VtGrid {
    pub grid: Grid,
}

/// The grid an Ink frame recorded from Node describes.
pub fn grid_from_ink_frame(_frame: &str) -> Grid {
    Grid::default()
}
