//! The spinner (`Spinner.jsx`, `SpinnerByline.jsx`, `use-spinner-progress.mjs`): filled by `nr-tui-widgets-status`.

use crate::Line;

/// The animated progress of a turn (verb, elapsed time, token count, thinking indicator).
#[derive(Clone, Debug, Default)]
pub struct SpinnerProgress {}

/// The spinner rows for a progress at `columns`.
pub fn render_spinner(_progress: &SpinnerProgress, _columns: usize) -> Vec<Line> {
    unimplemented!("filled by nr-tui-widgets-status")
}
