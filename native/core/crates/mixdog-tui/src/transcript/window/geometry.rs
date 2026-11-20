//! The geometry chain of one frame (`use-transcript-window/geometry.mjs`): row index, render scroll offset, window, and the
//! geometry published for the synchronous scroll handlers.
//!
//! The render scroll offset is resolved between the row index and the window by the reading-anchor lock
//! (`transcript-anchor-lock.mjs`, the scroll state's), so [`WindowState::frame`] takes it as a function of the row index.
//! Node memoised the index and the window on a structure signature; the index here is rebuilt only for a new structure
//! revision, width, expansion or streaming-tail height (see [`IncrementalRowIndex`]) and the window is a few binary
//! searches, so a frame computes them directly.

use super::heights::{HeightParams, is_streaming_tail};
use super::instance_state::WindowState;
use super::render_window::{RenderWindow, WindowTuning, transcript_render_window};
use super::row_index::{Items, RowIndex};

/// What one frame is computed from.
#[derive(Clone, Copy, Debug)]
pub struct FrameProps<'a> {
    /// The settled items.
    pub settled: &'a [serde_json::Value],
    /// The engine's monotonic structure revision: it changes with every mutation of a settled item.
    pub structure_revision: u64,
    /// The live tail; it is drawn after the settled items only while it is a streaming assistant message.
    pub streaming_tail: Option<&'a serde_json::Value>,
    pub columns: usize,
    pub tool_output_expanded: bool,
    /// The rows of the transcript viewport.
    pub content_height: usize,
    pub floating_panel_rows: usize,
    /// The scroll offset before the anchor lock (rows above the tail).
    pub scroll_offset: f64,
}

impl<'a> FrameProps<'a> {
    /// The items of the frame: the settled ones and the tail when it is streaming.
    pub fn items(&self) -> Items<'a> {
        Items::new(self.settled, self.streaming_tail.filter(|tail| is_streaming_tail(tail)))
    }
}

/// The geometry a manual scroll reads synchronously to capture the reading anchor, and the next render reads to rebuild the
/// top-edge row that was on screen (`transcriptGeomRef`). The prefix rows are those of [`WindowState::row_index`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PublishedGeometry {
    pub total_rows: usize,
    pub view_rows: usize,
    /// The clamped, bottom-relative offset the window was rendered with.
    pub render_offset: usize,
}

/// One frame's window and the geometry it publishes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame {
    pub window: RenderWindow,
    pub geometry: PublishedGeometry,
    /// The maximum the immediate wheel and keyboard clamp uses (`maxScrollRowsRef`).
    pub max_scroll_rows: usize,
}

impl WindowState {
    /// The row index of the last frame.
    pub fn row_index(&self) -> &RowIndex {
        self.incremental.index()
    }

    /// One frame: builds the row index, asks `render_offset` for the scroll offset to render at (the anchor lock over the
    /// index, given the unresolved offset) and computes the window and the published geometry from it.
    pub fn frame(&mut self, props: &FrameProps, tuning: &WindowTuning, render_offset: impl FnOnce(&RowIndex, f64) -> f64) -> Frame {
        let items = props.items();
        let params = HeightParams { columns: props.columns, tool_output_expanded: props.tool_output_expanded };
        let index = self.incremental.build(&items, &mut self.heights, &params, props.structure_revision);
        let resolved = render_offset(index, props.scroll_offset);
        let view_rows = props.content_height.max(1);
        let window = transcript_render_window(index, resolved, view_rows as f64, tuning);
        self.prev_viewport.floating_panel_rows = props.floating_panel_rows;
        self.prev_viewport.content_height = props.content_height;
        Frame {
            window,
            geometry: PublishedGeometry { total_rows: window.total_rows, view_rows, render_offset: window.effective_scroll_offset },
            max_scroll_rows: window.max_scroll_rows,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn items(count: usize) -> Vec<Value> {
        (0..count).map(|n| json!({"id": format!("u{n}"), "kind": "user", "text": format!("line {n}")})).collect()
    }

    fn props(settled: &[Value], revision: u64, scroll_offset: f64) -> FrameProps<'_> {
        FrameProps {
            settled,
            structure_revision: revision,
            streaming_tail: None,
            columns: 40,
            tool_output_expanded: false,
            content_height: 6,
            floating_panel_rows: 0,
            scroll_offset,
        }
    }

    #[test]
    fn a_fresh_transcript_is_pinned_to_the_bottom() {
        let settled = items(200);
        let mut state = WindowState::new("s");
        let frame = state.frame(&props(&settled, 1, 0.0), &WindowTuning::default(), |_, offset| offset);
        assert_eq!(frame.window.effective_scroll_offset, 0);
        assert_eq!(frame.window.end_index, 200);
        assert_eq!(frame.max_scroll_rows, frame.geometry.total_rows - 6);
        assert_eq!(state.row_index().rows.len(), 200);
    }

    #[test]
    fn the_resolver_sets_the_offset_the_window_renders_at() {
        let settled = items(200);
        let mut state = WindowState::new("s");
        let tuning = WindowTuning::default();
        let frame = state.frame(&props(&settled, 1, 0.0), &tuning, |index, _| {
            assert_eq!(index.rows.len(), 200);
            50.0
        });
        assert_eq!(frame.geometry.render_offset, 50);
        assert!(frame.window.end_index < 200);
        assert!(frame.window.bottom_spacer_rows > 0);
    }

    #[test]
    fn only_a_streaming_tail_joins_the_items() {
        let settled = items(3);
        let done = json!({"id": "a", "kind": "assistant", "text": "x"});
        let live = json!({"id": "a", "kind": "assistant", "streaming": true, "text": "x"});
        let mut with_done = props(&settled, 1, 0.0);
        with_done.streaming_tail = Some(&done);
        assert_eq!(with_done.items().len(), 3);
        let mut with_live = props(&settled, 1, 0.0);
        with_live.streaming_tail = Some(&live);
        assert_eq!(with_live.items().len(), 4);
    }

    #[test]
    fn appended_rows_are_revealed_while_following_and_the_previous_total_is_kept() {
        let mut state = WindowState::new("s");
        let tuning = WindowTuning::default();
        let first = items(200);
        let before = state.frame(&props(&first, 1, 0.0), &tuning, |_, offset| offset);
        assert_eq!(state.commit_total_rows(before.geometry.total_rows), 0);
        let grown = items(210);
        let after = state.frame(&props(&grown, 2, 0.0), &tuning, |_, offset| offset);
        assert_eq!(after.window.effective_scroll_offset, 0);
        assert_eq!(after.window.end_index, 210);
        assert!(after.geometry.total_rows > before.geometry.total_rows);
        assert_eq!(state.commit_total_rows(after.geometry.total_rows), before.geometry.total_rows);
    }
}
