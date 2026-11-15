//! The scroll state and its transitions (`use-transcript-scroll-state.mjs`, `use-transcript-follow.mjs`, the
//! `scrollTranscriptRows` primitive of `use-transcript-scroll.mjs` and `use-transcript-swap-reset.mjs`).

use serde_json::Value;

use super::anchor::{Anchor, Geometry, bottom_snap_rows, reading_anchor_at, swap_returns_to_tail};

/// The glide advances this often while it runs.
pub const GLIDE_INTERVAL_MS: u64 = 16;
/// The share of the remaining distance one glide step covers.
const GLIDE_EASE: f64 = 0.32;
/// A glide within this many rows of its target lands on it.
const GLIDE_LANDING_ROWS: f64 = 0.12;

/// What a scroll needs from the application: the transcript history paging of the store and the selection that must follow
/// the content. The selection hooks belong to the mouse module; a host without a selection leaves them empty.
pub trait ScrollHost {
    /// Whether older transcript pages can be restored (`transcriptHistoryBefore`).
    fn history_before(&self) -> bool;
    /// Whether newer transcript pages can be restored (`transcriptHistoryAfter`).
    fn history_after(&self) -> bool;
    /// `restoreOlderTranscript`; whether a page was restored.
    fn restore_older(&mut self) -> bool;
    /// `restoreNewerTranscript`; whether a page was restored.
    fn restore_newer(&mut self) -> bool;
    /// Called before a scroll that moves, with the target the viewport is at: a live selection snapshots the rows under it so
    /// they survive scrolling off.
    fn selection_before_scroll(&mut self, _target_before: f64) {}
    /// Called after a scroll that moved by `applied_delta` rows to `target`: a live selection follows its content.
    fn selection_after_scroll(&mut self, _applied_delta: f64, _target: f64) {}
}

/// The viewport the last render was laid out for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Viewport {
    pub content_height: usize,
    pub floating_panel_rows: usize,
}

/// The transcript scroll state shared by the scroll engine, the mouse handler and the transcript window.
#[derive(Clone, Debug, Default)]
pub struct TranscriptScroll {
    /// Rows scrolled up from the tail as last published (`0` is pinned to the latest).
    pub scroll_offset: usize,
    /// Where the glide is; equal to `target` when none runs.
    pub position: f64,
    /// Where the viewport is going.
    pub target: f64,
    /// The committed range: the most rows the target can reach.
    pub max_scroll_rows: usize,
    pub bottom_slack_rows: usize,
    /// The item and row offset at the viewport top edge while the reader reads older transcript.
    pub anchor: Option<Anchor>,
    /// A manual scroll whose synchronous capture failed: the anchor is re-captured at the next commit.
    pub anchor_dirty: bool,
    pub geom: Geometry,
    pub viewport: Option<Viewport>,
    /// The tail is followed only while armed; a manual scroll disarms it.
    pub following: bool,
    pub last_items_count: usize,
    /// Head item of the last committed transcript (`Value::Null` before any).
    pub last_first_item_id: Value,
    /// An upward intent a zero committed max blocked for one frame, replayed by [`Self::replay_pending_readback`].
    pub pending_readback_rows: f64,
    /// Bumped when measured heights change so the row index recomputes.
    pub measured_rows_version: u64,
    /// A glide toward the target runs; the run loop ticks it while it does.
    pub glide: bool,
}

impl TranscriptScroll {
    pub fn set_scroll_offset(&mut self, rows: usize) {
        self.scroll_offset = rows;
    }

    /// Whether a glide runs and wants [`Self::glide_tick`] every [`GLIDE_INTERVAL_MS`].
    pub fn glide_running(&self) -> bool {
        self.glide
    }

    pub fn stop_smooth_scroll(&mut self) {
        self.glide = false;
    }

    pub fn start_smooth_scroll(&mut self) {
        self.glide = true;
    }

    /// One glide step toward the target; `false` once it landed or none runs. Landing above the tail drops an armed follow;
    /// landing at the tail keeps it, the glide was toward the live tail.
    pub fn glide_tick(&mut self) -> bool {
        if !self.glide {
            return false;
        }
        let next = self.position + (self.target - self.position) * GLIDE_EASE;
        if (self.target - next).abs() < GLIDE_LANDING_ROWS {
            self.position = self.target;
            self.scroll_offset = self.target.max(0.0).round() as usize;
            if self.target > 0.0 {
                self.following = false;
            }
            self.glide = false;
            return false;
        }
        self.position = next.max(0.0);
        self.scroll_offset = self.position.round() as usize;
        true
    }

    pub fn cancel_transcript_follow(&mut self) {
        self.following = false;
    }

    /// An explicit return to the tail (end key, session reset, first item): it arms follow, so growth is followed instead of
    /// capturing a reading anchor and piling up below the fold.
    pub fn reset_transcript_scroll(&mut self) {
        self.stop_smooth_scroll();
        self.pending_readback_rows = 0.0;
        self.position = 0.0;
        self.target = 0.0;
        self.anchor = None;
        self.anchor_dirty = false;
        self.following = true;
        self.set_scroll_offset(0);
    }

    /// Prompt submit: arm follow without moving the viewport; the one move to the tail happens when the transcript grows.
    pub fn arm_transcript_follow(&mut self) {
        self.anchor = None;
        self.anchor_dirty = false;
        self.pending_readback_rows = 0.0;
        self.following = true;
        self.stop_smooth_scroll();
    }

    /// `useTranscriptSwapReset`: a bulk replacement of the items returns to the live tail. Called after every items change.
    pub fn swap_reset(&mut self, ids: &[Value]) {
        let count = ids.len();
        let previous_count = std::mem::replace(&mut self.last_items_count, count);
        let first_id = if count > 0 { ids[0].clone() } else { Value::Null };
        let previous_first_id = std::mem::replace(&mut self.last_first_item_id, first_id.clone());
        if swap_returns_to_tail(count, previous_count, &first_id, &previous_first_id) {
            self.reset_transcript_scroll();
        }
    }

    fn anchor_at_target(&self, target: f64) -> Option<Anchor> {
        let geom = &self.geom;
        reading_anchor_at(geom.prefix_rows.as_deref(), &geom.ids, geom.total_rows, geom.view_rows, target)
    }

    /// The anchor of the row at the viewport top, from the latest published geometry; a miss leaves the anchor as it is.
    fn capture_restore_anchor(&mut self) {
        let anchor = self.anchor_at_target(self.target);
        if anchor.is_some() {
            self.anchor = anchor;
            self.anchor_dirty = false;
        }
    }

    /// A manual scroll moves the reading position: capture the anchor now from the published geometry so the next render
    /// already locks to it. Only the true bottom drops it, a positive offset is an explicit reading position.
    fn capture_reading_anchor(&mut self, target: f64) {
        if target == 0.0 {
            self.anchor = None;
            self.anchor_dirty = false;
            return;
        }
        match self.anchor_at_target(target) {
            Some(anchor) => {
                self.anchor = Some(anchor);
                self.anchor_dirty = false;
            }
            None => self.anchor_dirty = true,
        }
    }

    /// Scrolling past the oldest or newest loaded edge pages the transcript history instead of moving the target. Returns
    /// whether the edge owned the gesture, a page restored or not.
    fn page_transcript_history(&mut self, host: &mut impl ScrollHost, delta_rows: f64, max_target: f64) -> bool {
        let past_oldest = delta_rows > 0.0 && self.target >= max_target && host.history_before();
        let past_newest = delta_rows < 0.0 && self.target <= 0.0 && host.history_after();
        if !past_oldest && !past_newest {
            return false;
        }
        self.capture_restore_anchor();
        let restored = if past_oldest { host.restore_older() } else { host.restore_newer() };
        if !restored {
            return true;
        }
        self.stop_smooth_scroll();
        self.cancel_transcript_follow();
        if past_newest {
            // The shared overlap now sits at the oldest edge of the newer page: keep a positive target so the anchor lock stays
            // active and resolves that row instead of treating zero as the tail.
            let anchored = max_target.max(1.0);
            self.target = anchored;
            self.position = anchored;
            self.set_scroll_offset(anchored as usize);
        }
        true
    }

    /// `scrollTranscriptRows`: scroll `delta_rows` rows (positive toward older rows), paging history at the edges, snapping to
    /// the tail inside the bottom band, keeping a blocked first read-back intent, capturing the reading anchor and moving the
    /// selection with the content. `smooth` glides to the target instead of landing on it.
    pub fn scroll_rows(&mut self, host: &mut impl ScrollHost, delta_rows: f64, smooth: bool) {
        let max_target = self.max_scroll_rows as f64;
        let geometry_max = self.geom.total_rows.saturating_sub(self.geom.view_rows.max(1)) as f64;
        if self.page_transcript_history(host, delta_rows, max_target) {
            return;
        }
        let mut target = (self.target + delta_rows).min(max_target).max(0.0);
        if delta_rows < 0.0 && target > 0.0 && target <= bottom_snap_rows(self.geom.view_rows) as f64 {
            target = 0.0;
        }
        let applied_delta = target - self.target;
        // A newly mounted row can hold the committed max at zero for one frame: keep the first upward intent instead of letting
        // the next commit infer bottom-follow from zero and yank the viewport back.
        let blocked_readback = delta_rows > 0.0 && applied_delta == 0.0 && max_target == 0.0 && geometry_max > 0.0;
        if blocked_readback {
            self.pending_readback_rows += delta_rows;
        } else if delta_rows < 0.0 || applied_delta != 0.0 {
            self.pending_readback_rows = 0.0;
        }
        if applied_delta != 0.0 {
            host.selection_before_scroll(self.target);
        }
        // A manual scroll wins over an in-flight follow.
        if applied_delta != 0.0 || blocked_readback {
            self.cancel_transcript_follow();
        }
        self.target = target;
        // A downward gesture that ends at the tail re-arms follow even when it moved nothing: wheel or page-down while already
        // at the bottom is how a reader asks to resume following.
        if delta_rows < 0.0 && target == 0.0 {
            self.anchor = None;
            self.anchor_dirty = false;
            self.following = true;
        }
        if applied_delta != 0.0 {
            self.capture_reading_anchor(target);
            host.selection_after_scroll(applied_delta, target);
        }
        if smooth {
            self.start_smooth_scroll();
            return;
        }
        self.stop_smooth_scroll();
        self.position = target;
        self.set_scroll_offset(target.round() as usize);
    }

    /// Replays the read-back intent a zero committed max blocked, once the committed range allows it. Called after every render.
    pub fn replay_pending_readback(&mut self, host: &mut impl ScrollHost) {
        let pending = self.pending_readback_rows.max(0.0);
        if pending <= 0.0 || self.max_scroll_rows == 0 {
            return;
        }
        self.pending_readback_rows = 0.0;
        self.scroll_rows(host, pending, false);
    }
}
