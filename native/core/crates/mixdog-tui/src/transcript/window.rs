//! The transcript window (`src/tui/app/transcript-window.mjs`, `transcript-row-estimate.mjs`, `transcript-measure.mjs`):
//! which items are visible, with exact heights from the widgets. Filled by `nr-tui-transcript-window`; the signatures below are
//! the ones the scroll state, the mouse and the view are written against.

use serde_json::Value;

/// The items of the transcript and their measured heights at one width.
#[derive(Debug, Default)]
pub struct TranscriptWindow {
    pub width: usize,
    pub heights: Vec<usize>,
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

/// The rows an item is expected to take before it is measured.
pub fn row_estimate(_item: &Value, _width: usize) -> usize {
    1
}

/// The exact rows an item takes at `width`.
pub fn measure_item(_item: &Value, _width: usize) -> usize {
    1
}
