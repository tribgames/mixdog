//! The selection side of a transcript scroll (the selection parts of `scrollTranscriptRows` and `rebuildSelectionAfterScroll`
//! in `use-transcript-scroll.mjs`). Before a scroll that moves, the rows under a live selection are snapshotted into the stitch
//! buffer so they survive scrolling off; after it, a live selection follows its content: an active drag is rebuilt from its
//! anchor (span aware, so a word or line drag that reached the edge keeps extending by whole words or lines), a released one is
//! shifted by the rows scrolled.
//!
//! [`SelectionScroll`] is the [`ScrollHost`] the application hands to
//! [`TranscriptScroll::scroll_rows`](crate::transcript::scroll::engine::TranscriptScroll::scroll_rows): history paging goes to
//! the host it wraps, the selection hooks to the mouse state.

use mixdog_term::selection::SelectionRect;

use crate::transcript::scroll::engine::ScrollHost;

use super::geometry::{linear_selection, selection_point_at_current_scroll};
use super::host::{RenderStore, SelectionIo};
use super::state::Region;
use super::Mouse;

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
    fn render_selection_text(&mut self) -> Option<String> {
        self.store.render_selection_text()
    }
    fn render_selection_rows(&mut self) -> Option<Vec<mixdog_term::selection::SelectedRow>> {
        self.store.render_selection_rows()
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
    /// Before a scroll that moves from `target_before`: the rows under a live transcript selection go to the stitch buffer,
    /// keyed by the pre-scroll offset, for an active drag and a released selection alike, so Ctrl+C reconstructs the full text
    /// however far it scrolled off. A pending throttled rect is committed first so the harvest reads the newest selection.
    pub fn selection_before_scroll<S: RenderStore + ?Sized>(&mut self, store: &mut S, target_before: f64, now_ms: u64) {
        if self.drag.region != Some(Region::Transcript) || self.drag.rect.is_none() {
            return;
        }
        let mut io = AtTarget { store, target: target_before };
        self.flush_pending_selection_paint(&mut io, now_ms);
        self.harvest_stitch_rows_now(&mut io, target_before);
    }

    /// After a scroll that moved by `applied_delta` rows to `target`: the layout the selection was placed against takes the new
    /// offset and a live selection follows its content.
    pub fn selection_after_scroll<S: RenderStore + ?Sized>(&mut self, store: &mut S, applied_delta: f64, target: f64, now_ms: u64) {
        if let Some(layout) = self.selection_layout.as_mut() {
            layout.scroll_offset = target.round() as i64;
        }
        if self.drag.rect.is_some() {
            let mut io = AtTarget { store, target };
            self.rebuild_selection_after_scroll(&mut io, applied_delta, now_ms);
        }
    }

    /// `rebuildSelectionAfterScroll`. The active-drag rebuild paints directly through the themed clip with text capture off
    /// (the clip carries the theme colour a bare rect would lack), after cancelling any armed throttled repaint (it would fire
    /// the pre-scroll rect after this one, leaving two highlights). The shifted rect is clipped to the viewport, so its text is
    /// never re-harvested: that would overwrite the full text remembered at release with the still-visible rows.
    fn rebuild_selection_after_scroll<S: SelectionIo + ?Sized>(&mut self, io: &mut S, applied_delta: f64, now_ms: u64) {
        let rect = if self.drag.active {
            match (self.drag.anchor_span, self.drag.last) {
                (Some(span), Some(last)) => {
                    Some(self.build_span_rect(io, span, last.x, last.y, self.drag.region, self.drag.anchor_scroll))
                }
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
        self.paint_selection_rect(io, clipped, false, now_ms);
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

    fn selection_before_scroll(&mut self, target_before: f64) {
        self.mouse.selection_before_scroll(&mut *self.store, target_before, self.now_ms);
    }

    fn selection_after_scroll(&mut self, applied_delta: f64, target: f64) {
        self.mouse.selection_after_scroll(&mut *self.store, applied_delta, target, self.now_ms);
    }
}
