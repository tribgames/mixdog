//! The statusline band (`StatusLine.jsx`, `status-line/local-line.mjs`): filled by `nr-tui-widgets-status`.

use crate::Line;

/// The statusline band (its two fixed rows) for the footer text the footer produced, at `columns`.
pub fn render_statusline_band(_footer: &str, _columns: usize) -> Vec<Line> {
    unimplemented!("filled by nr-tui-widgets-status")
}
