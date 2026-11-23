//! The selection side of a transcript scroll (the selection parts of `scrollTranscriptRows` and `rebuildSelectionAfterScroll`
//! in `use-transcript-scroll.mjs`). After a scroll that moved, a live selection follows its content: an active drag is rebuilt
//! from its anchor (span aware, so a word or line drag that reached the edge keeps extending by whole words or lines), a
//! released one is shifted by the rows scrolled until the next frame draws it where its content is ([`super::follow`]).
//!
//! [`SelectionScroll`] is the [`ScrollHost`] the application hands to
//! [`TranscriptScroll::scroll_rows`](crate::transcript::scroll::engine::TranscriptScroll::scroll_rows): history paging goes to
//! the host it wraps, the selection hooks to the mouse state.

use mixdog_term::selection::SelectionRect;

use crate::transcript::scroll::engine::ScrollHost;

use super::Mouse;
use super::geometry::{linear_selection, selection_point_at_current_scroll};
use super::host::{RenderStore, SelectionIo};

/// A store paired with the scroll target the hook runs at.
struct AtTarget<'a, S: RenderStore + ?Sized> {
    store: &'a mut S,
    target: f64,
}

impl<S: RenderStore + ?Sized> RenderStore for AtTarget<'_, S> {
    fn word_rect_at(&mut self, x: i32, y: i32) -> Option<mixdog_term::selection::CellSpan> {
        self.store.word_rect_at(x, y)
    }
    fn line_rect_at(&mut self, y: i32) -> Option<mixdog_term::selection::CellSpan> {
        self.store.line_rect_at(y)
    }
    fn set_render_selection(&mut self, rect: Option<&SelectionRect>) {
        self.store.set_render_selection(rect);
    }
    fn force_render_repaint(&mut self) {
        self.store.force_render_repaint();
    }
}

impl<S: RenderStore + ?Sized> SelectionIo for AtTarget<'_, S> {
    fn scroll_target(&self) -> f64 {
        self.target
    }
}

/// `shiftSelectionRectY`: the rect moved `delta` rows (`Math.round`), keeping everything else about it.
fn shifted(rect: &SelectionRect, delta: f64) -> SelectionRect {
    let dy = (if delta.is_nan() { 0.0 } else { delta } + 0.5).floor() as i32;
    SelectionRect { y1: rect.y1 + dy, y2: rect.y2 + dy, ..*rect }
}

impl Mouse {
    /// After a scroll that moved by `applied_delta` rows to `target`: a live selection follows its content.
    pub fn selection_after_scroll<S: RenderStore + ?Sized>(&mut self, store: &mut S, applied_delta: f64, target: f64, now_ms: u64) {
        self.follow.scrolled += applied_delta;
        if self.drag.rect.is_some() {
            let mut io = AtTarget { store, target };
            self.rebuild_selection_after_scroll(&mut io, applied_delta, now_ms);
        }
    }

    /// `rebuildSelectionAfterScroll`. The active-drag rebuild paints directly through the themed clip with text capture off
    /// (the clip carries the theme colour a bare rect would lack), after cancelling any armed throttled repaint (it would fire
    /// the pre-scroll rect after this one, leaving two highlights). A released selection keeps its place in the content: the shift only
    /// says where the next frame is expected to draw it.
    fn rebuild_selection_after_scroll<S: SelectionIo + ?Sized>(&mut self, io: &mut S, applied_delta: f64, now_ms: u64) {
        let rect = if self.drag.active {
            match (self.drag.anchor_span, self.drag.last) {
                (Some(span), Some(last)) => Some(self.build_span_rect(io, span, last.x, last.y, self.drag.region, self.drag.anchor_scroll)),
                (_, last) => match (self.drag.anchor, last) {
                    (Some(anchor), Some(last)) => {
                        let current = selection_point_at_current_scroll(anchor, self.drag.anchor_scroll, io.scroll_target());
                        Some(linear_selection(current, last))
                    }
                    _ => None,
                },
            }
        } else {
            self.drag.rect.as_ref().map(|rect| shifted(rect, applied_delta))
        };
        let clipped = self.with_selection_clip(rect, self.drag.active);
        self.drag.rect.clone_from(&clipped);
        self.cancel_pending_selection_paint();
        self.paint_selection_rect(io, clipped, now_ms);
    }
}

/// The [`ScrollHost`] for one scroll: the history paging of `inner` and the selection hooks of the mouse state, at `now_ms`.
pub struct SelectionScroll<'a, S: RenderStore + ?Sized, H: ScrollHost> {
    pub mouse: &'a mut Mouse,
    pub store: &'a mut S,
    pub inner: &'a mut H,
    pub now_ms: u64,
}

impl<S: RenderStore + ?Sized, H: ScrollHost> ScrollHost for SelectionScroll<'_, S, H> {
    fn history_before(&self) -> bool {
        self.inner.history_before()
    }

    fn history_after(&self) -> bool {
        self.inner.history_after()
    }

    fn restore_older(&mut self) -> bool {
        self.inner.restore_older()
    }

    fn restore_newer(&mut self) -> bool {
        self.inner.restore_newer()
    }

    fn selection_after_scroll(&mut self, applied_delta: f64, target: f64) {
        self.mouse.selection_after_scroll(&mut *self.store, applied_delta, target, self.now_ms);
    }
}
