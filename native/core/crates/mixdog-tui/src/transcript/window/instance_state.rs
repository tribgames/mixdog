//! The state one transcript window keeps between frames (`use-transcript-window/instance-state.mjs`) and its reset when the
//! session changes.
//!
//! Node also reset the App-owned scroll refs (reading anchor, scroll target and position, follow, selection layout) in the same
//! render; those belong to the scroll state and the mouse, so [`WindowState::switch_session`] answers whether a reset
//! happened and the caller clears them with it. The committed-max hold of Node (a cap held while a mounted row still waited
//! for its Yoga measurement) is gone with the measurement: the published maximum is always the current one.

use super::heights::ItemHeights;
use super::row_index::IncrementalRowIndex;

/// The viewport-only geometry of the previous frame, so a floating panel opening or closing (which changes the viewport and
/// not the items) can freeze the visible top row for a single frame.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ViewportGeom {
    pub content_height: usize,
    pub floating_panel_rows: usize,
}

/// The caches and the last frame's numbers of one transcript window.
#[derive(Default)]
pub struct WindowState {
    session_key: String,
    /// The total rows of the previous commit (`transcriptTotalRowsRef`).
    total_rows: usize,
    pub(super) incremental: IncrementalRowIndex,
    pub(super) heights: ItemHeights,
    /// The previous frame's viewport geometry.
    pub prev_viewport: ViewportGeom,
}

impl WindowState {
    pub fn new(session_key: &str) -> Self {
        Self { session_key: session_key.to_owned(), ..Self::default() }
    }

    /// A resumed session replaces the transcript atomically while the window stays: the outgoing session's row index, heights
    /// and last frame never take part in the incoming session's first frame. Returns whether the session changed (and the
    /// state was reset), so the caller resets the scroll state and the selection layout in the same frame.
    pub fn switch_session(&mut self, session_key: &str) -> bool {
        if self.session_key == session_key {
            return false;
        }
        self.session_key = session_key.to_owned();
        self.total_rows = 0;
        self.incremental.clear();
        self.heights.reset();
        self.prev_viewport = ViewportGeom::default();
        true
    }

    /// Records this commit's total rows and returns the previous commit's (`transcriptTotalRowsRef`).
    pub fn commit_total_rows(&mut self, total_rows: usize) -> usize {
        std::mem::replace(&mut self.total_rows, total_rows)
    }

    /// The caches of heights and rendered lines (the selection stitch reads the lines of off-screen rows through them).
    pub fn heights(&mut self) -> &mut ItemHeights {
        &mut self.heights
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_switch_resets_once() {
        let mut state = WindowState::new("one");
        assert!(!state.switch_session("one"));
        state.commit_total_rows(40);
        state.prev_viewport = ViewportGeom { content_height: 9, floating_panel_rows: 2 };
        assert!(state.switch_session("two"));
        assert_eq!(state.commit_total_rows(5), 0);
        assert_eq!(state.prev_viewport, ViewportGeom::default());
        assert!(!state.switch_session("two"));
    }

    #[test]
    fn the_previous_total_is_returned_by_each_commit() {
        let mut state = WindowState::default();
        assert_eq!(state.commit_total_rows(10), 0);
        assert_eq!(state.commit_total_rows(12), 10);
    }
}
