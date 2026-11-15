//! Publishing the grid selection rect to the renderer (`use-selection-paint.mjs`, `use-selection-paint/paint-queue.mjs`,
//! `use-selection-paint/selection-clip.mjs`): the region clip with the theme colour, the direct paint with deferred text
//! capture, and the motion-paint throttle (`MIXDOG_TUI_SELECTION_PAINT_MS`) with its cancel and flush guards. The state
//! machine itself is `mixdog_term::selection::PaintQueue`; the stitch harvest hooks in on every paint.

use mixdog_js::js_trim;
use mixdog_term::frame::Rgb;
use mixdog_term::selection::{DEFAULT_SELECTION_BACKGROUND, PaintPublish, PaintQueue, SelectionRect, Throttle, clip_selection_rect};

use super::Mouse;
use super::host::{RenderStore, SelectionIo};

/// What the paint hooks kept in refs: the throttle, the colour and the capture of the text under the selection.
#[derive(Debug)]
pub(super) struct PaintState {
    queue: PaintQueue,
    background: Rgb,
    /// The absolute time the trailing paint timer fires at.
    timer_at: Option<u64>,
    /// `selectionTextCaptureRef`: bumped by every request and every clear, so only the newest capture lands.
    capture_generation: u64,
    /// The capture waiting for the next painted frame.
    pending_capture: Option<u64>,
}

impl PaintState {
    pub(super) fn new(interval_ms: u64) -> Self {
        Self { queue: PaintQueue::new(interval_ms), background: DEFAULT_SELECTION_BACKGROUND, timer_at: None, capture_generation: 0, pending_capture: None }
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
        self.capture_generation += 1;
        self.pending_capture = None;
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

    /// `rememberSelectionTextSoon`: the text under the selection is read after the next painted frame (the rect is published
    /// synchronously, the renderer paints it later; reading sooner could capture the previous rect). The newest request wins.
    fn remember_selection_text_soon(&mut self) {
        self.paint.capture_generation += 1;
        self.paint.pending_capture = Some(self.paint.capture_generation);
    }

    /// Hands the renderer what a publish decided.
    fn apply_publish<S: SelectionIo + ?Sized>(&mut self, store: &mut S, publish: PaintPublish) {
        store.set_render_selection(publish.rect.as_ref());
        if publish.remember_text {
            self.remember_selection_text_soon();
        }
        if publish.harvest_stitch {
            self.harvest_stitch_rows_soon(store.scroll_target());
        }
    }

    /// `paintSelectionRect`: publishes a clipped rect (or the clear) now.
    pub fn paint_selection_rect<S: SelectionIo + ?Sized>(&mut self, store: &mut S, clipped: Option<SelectionRect>, remember_text: bool, now_ms: u64) {
        if let Some(publish) = self.paint.queue.publish(clipped, remember_text, now_ms) {
            self.apply_publish(store, publish);
        }
    }

    /// `cancelPendingSelectionPaint`: a pending throttled repaint would fire after a direct paint and stamp a stale rect over
    /// the current one (two coexisting highlights), so every direct paint cancels it first.
    pub fn cancel_pending_selection_paint(&mut self) {
        self.paint.timer_at = None;
        self.paint.queue.cancel_pending();
    }

    /// `flushPendingSelectionPaint`: publishes an armed but unpainted rect now, so paths that read the rendered selection (the
    /// pre-scroll stitch harvest) see the newest fast-drag rect instead of the previous one.
    pub fn flush_pending_selection_paint<S: SelectionIo + ?Sized>(&mut self, store: &mut S, now_ms: u64) {
        self.paint.timer_at = None;
        if let Some(publish) = self.paint.queue.flush_pending(now_ms) {
            self.apply_publish(store, publish);
        }
    }

    /// `applySelectionRect`: the rect becomes the drag's and is painted at once, its text remembered. A clear drops the
    /// remembered text and the stitch buffer.
    pub fn apply_selection_rect<S: SelectionIo + ?Sized>(&mut self, store: &mut S, rect: Option<SelectionRect>, now_ms: u64) {
        let clipped = self.with_selection_clip(rect, false);
        self.drag.rect.clone_from(&clipped);
        if clipped.is_none() {
            self.paint.capture_generation += 1;
            self.selection_text.clear();
            self.clear_stitch_buffer();
        }
        self.cancel_pending_selection_paint();
        self.paint_selection_rect(store, clipped, true, now_ms);
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

    /// What Node ran after the renderer's acknowledgement of a frame (`rememberSelectionTextSoon`) and on a zero timer
    /// (`harvestStitchRowsSoon`): read the selected text and the rows under the selection of the frame just painted. Call it
    /// after every painted frame.
    pub fn after_frame<S: RenderStore + ?Sized>(&mut self, store: &mut S) {
        self.run_stitch_harvest(store);
        let Some(capture) = self.paint.pending_capture.take() else { return };
        if capture != self.paint.capture_generation {
            return;
        }
        if let Some(text) = store.render_selection_text() {
            if !js_trim(&text).is_empty() {
                self.selection_text = text;
            }
        }
    }
}
