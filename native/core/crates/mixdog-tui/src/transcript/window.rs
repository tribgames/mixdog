//! The transcript window: which items are mounted for the viewport, with exact heights. An item renders to lines through the
//! transcript widgets and its number of lines is its height.
//!
//! Older history is paged by the core (`thread/restoreOlderTranscript`, `thread/restoreNewerTranscript`; the pages come with
//! `thread/items/list`): the window sees the items it is given, a page replacing them bumps the structure revision, and
//! [`render_window::transcript_swap_returns_to_tail`] says when that replacement returns the viewport to the tail.

pub mod geometry;
pub mod heights;
pub mod instance_state;
pub mod render_window;
pub mod row_index;
pub mod selection_shift;
pub mod visible_items;

use serde_json::Value;

pub use heights::{HeightParams, ItemHeights};
pub use instance_state::WindowState;
pub use row_index::{Items, RowIndex};

/// The items of the transcript and their measured heights at one width.
#[derive(Debug, Default)]
pub struct TranscriptWindow {
    pub width: usize,
    pub heights: Vec<usize>,
}

impl TranscriptWindow {
    /// The window over a row index built at `width`.
    pub fn from_row_index(width: usize, index: &RowIndex) -> Self {
        Self { width, heights: index.rows.clone() }
    }
}

/// The indices of the items intersecting the viewport that starts `top_row` rows into the transcript and is `rows` high.
pub fn visible_items(window: &TranscriptWindow, top_row: usize, rows: usize) -> std::ops::Range<usize> {
    let bottom = top_row + rows;
    let (mut at, mut first, mut end) = (0, None, 0);
    for (index, height) in window.heights.iter().enumerate() {
        let next = at + height;
        if next > top_row && at < bottom {
            first.get_or_insert(index);
            end = index + 1;
        }
        at = next;
    }
    first.map_or(0..0, |start| start..end)
}

/// The rows an item takes at `width` before the neighbour above it and the transcript-wide expansion are known: its exact
/// height with no neighbour and collapsed cards.
pub fn row_estimate(item: &Value, width: usize) -> usize {
    ItemHeights::default().rows(item, None, &HeightParams { columns: width, tool_output_expanded: false })
}

/// The exact rows an item takes at `width`, collapsed and with no neighbour above it.
pub fn measure_item(item: &Value, width: usize) -> usize {
    row_estimate(item, width)
}
