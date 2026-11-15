//! The transcript scroll state (`src/tui/app/use-transcript-scroll*.mjs`, `transcript-anchor-lock.mjs`,
//! `use-transcript-follow.mjs`). Filled by `nr-tui-transcript-scroll` against the window signatures of `window.rs`.

/// The scroll position and whether the tail is followed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScrollState {
    /// Rows from the top of the transcript to the top of the viewport.
    pub top_row: usize,
    /// The streaming tail is followed only while armed; a manual scroll disarms it.
    pub following: bool,
}

/// The item at the viewport top and the offset inside it, kept still while items above change height.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AnchorLock {
    pub item: usize,
    pub offset: usize,
}

/// A wheel step of `delta` rows (negative scrolls up); it disarms the follow.
pub fn apply_wheel(state: ScrollState, delta: i32, max_top: usize) -> ScrollState {
    let top_row = state.top_row.saturating_add_signed(delta as isize).min(max_top);
    ScrollState { top_row, following: false }
}

/// The state that follows the tail of a transcript whose last viewport starts at `max_top`.
pub fn follow_tail(max_top: usize) -> ScrollState {
    ScrollState { top_row: max_top, following: true }
}
