//! Publishing the grid selection rect to the renderer (`use-selection-paint.mjs`, `use-selection-paint/paint-queue.mjs`,
//! `use-selection-paint/selection-clip.mjs`): the region clip with the theme colour, the direct paint, and the motion-paint
//! throttle (`MIXDOG_TUI_SELECTION_PAINT_MS`) with its cancel and flush guards. The state machine itself is
//! `mixdog_term::selection::PaintQueue`. The text of a selection is not read back from the renderer: it is read from the
//! content when the selection is made ([`super::follow`]).

use mixdog_term::frame::Rgb;
use mixdog_term::selection::{DEFAULT_SELECTION_BACKGROUND, PaintPublish, PaintQueue, SelectionRect, Throttle, clip_selection_rect};

use super::Mouse;
use super::host::SelectionIo;

/// What the paint hooks kept in refs: the throttle and the colour.
#[derive(Debug)]
pub(super) struct PaintState {
    queue: PaintQueue,
    background: Rgb,
    /// The absolute time the trailing paint timer fires at.
    timer_at: Option<u64>,
}

impl PaintState {
    pub(super) fn new(interval_ms: u64) -> Self {
        Self { queue: PaintQueue::new(interval_ms), background: DEFAULT_SELECTION_BACKGROUND, timer_at: None }
    }

    pub(super) fn set_background(&mut self, background: Rgb) {
        self.background = background;
    }

    pub(super) fn deadline(&self) -> Option<u64> {
        self.timer_at
    }

    pub(super) fn dispose(&mut self) {
        self.timer_at = None;
        self.queue.cancel_pending();
    }
}

/// `selectionRectsEqual` over optional rects: the same region (the colours do not count).
fn rects_equal(a: Option<&SelectionRect>, b: Option<&SelectionRect>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.same_region(b),
        _ => false,
    }
}

impl Mouse {
    /// `selectionClipBand`: the rows of the region being dragged. A status-bar selection lives in the bottom statusline band,
    /// not the transcript viewport, so the highlight cannot spill into the prompt or transcript rows; everything else keeps the
    /// transcript-viewport clip.
    fn selection_clip(&self) -> (i32, i32) {
        let band = self.region_rows(self.drag.region);
        (band.top as i32, band.bottom as i32)
    }

    /// `withSelectionClip`: the rect as the renderer takes it, clipped to its region and carrying the theme colour;
    /// `suppress_capture` is the `captureText: false` option of a motion paint.
    pub fn with_selection_clip(&self, rect: Option<SelectionRect>, suppress_capture: bool) -> Option<SelectionRect> {
        rect.map(|rect| clip_selection_rect(&rect, self.selection_clip(), self.paint.background, suppress_capture))
    }

    /// Hands the renderer what a publish decided.
    fn apply_publish<S: SelectionIo + ?Sized>(&mut self, store: &mut S, publish: PaintPublish) {
        store.set_render_selection(publish.rect.as_ref());
    }

    /// `paintSelectionRect`: publishes a clipped rect (or the clear) now.
    pub fn paint_selection_rect<S: SelectionIo + ?Sized>(&mut self, store: &mut S, clipped: Option<SelectionRect>, now_ms: u64) {
        if let Some(publish) = self.paint.queue.publish(clipped, false, now_ms) {
            self.apply_publish(store, publish);
        }
    }

    /// `cancelPendingSelectionPaint`: a pending throttled repaint would fire after a direct paint and stamp a stale rect over
    /// the current one (two coexisting highlights), so every direct paint cancels it first.
    pub fn cancel_pending_selection_paint(&mut self) {
        self.paint.timer_at = None;
        self.paint.queue.cancel_pending();
    }

    /// `applySelectionRect`: the rect becomes the drag's and is painted at once. A released selection takes its place in the
    /// content and its text ([`Self::anchor_selection`]), which may draw the rect back to the rows that have a place, or leave
    /// no selection.
    pub fn apply_selection_rect<S: SelectionIo + ?Sized>(&mut self, store: &mut S, rect: Option<SelectionRect>, now_ms: u64) {
        self.drag.rect = self.with_selection_clip(rect, false);
        if !self.anchor_selection(store) {
            self.drag.rect = None;
            self.anchor_selection(store);
        }
        self.cancel_pending_selection_paint();
        self.paint_selection_rect(store, self.drag.rect, now_ms);
    }

    /// `applySelectionRectThrottled`: a motion paint, at most one per paint interval; the rest waits for the trailing timer
    /// ([`Self::fire_paint_timer`]).
    pub fn apply_selection_rect_throttled<S: SelectionIo + ?Sized>(&mut self, store: &mut S, rect: Option<SelectionRect>, now_ms: u64) {
        let clipped = self.with_selection_clip(rect, true);
        if rects_equal(self.drag.rect.as_ref(), clipped.as_ref()) {
            return;
        }
        self.drag.rect.clone_from(&clipped);
        match self.paint.queue.schedule_throttled(clipped, now_ms) {
            Throttle::Unchanged | Throttle::Wait(None) => {}
            Throttle::Paint(publish) => {
                self.paint.timer_at = None;
                if let Some(publish) = publish {
                    self.apply_publish(store, publish);
                }
            }
            Throttle::Wait(Some(delay_ms)) => self.paint.timer_at = Some(now_ms.saturating_add(delay_ms)),
        }
    }

    /// The trailing paint timer: publishes what waited, if it is due.
    pub(super) fn fire_paint_timer<S: SelectionIo + ?Sized>(&mut self, store: &mut S, now_ms: u64) {
        if self.paint.timer_at.is_none_or(|at| now_ms < at) {
            return;
        }
        self.paint.timer_at = None;
        if let Some(publish) = self.paint.queue.fire_timer(now_ms) {
            self.apply_publish(store, publish);
        }
    }
}
