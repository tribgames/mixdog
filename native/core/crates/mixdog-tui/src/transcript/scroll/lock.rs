//! The render-time anchor lock and the post-commit reconciliation of the scroll state against the geometry that just rendered.

use serde_json::Value;

use super::anchor::{Anchor, Current, Geometry, reading_anchor_at, resolve_anchor_scroll_offset};
use super::engine::{TranscriptScroll, Viewport};

/// The row table of the frame being rendered.
#[derive(Clone, Copy, Debug)]
pub struct RowIndex<'a> {
    pub total_rows: usize,
    pub prefix_rows: Option<&'a [usize]>,
}

/// What the post-commit reconciliation reads about the frame that was just committed.
#[derive(Clone, Copy, Debug)]
pub struct CommitFrame<'a> {
    pub drag_active: bool,
    pub total_rows: usize,
    pub previous_total_rows: usize,
    pub prefix_rows: Option<&'a [usize]>,
    pub ids: &'a [Value],
    pub view_rows: usize,
    pub max_rows: usize,
}

/// The anchor of the row that was at the top edge of the previously published geometry, and the offset that keeps it there
/// against the current row table. `prev_view_rows` overrides the previous viewport height when only the viewport changed.
fn lock_to_previous_top_edge(geom: &Geometry, prev_view_rows: usize, current: &Current<'_>) -> Option<(Anchor, f64)> {
    let anchor = reading_anchor_at(geom.prefix_rows.as_deref(), &geom.ids, geom.total_rows, prev_view_rows, geom.render_offset)?;
    let offset = resolve_anchor_scroll_offset(&anchor, current)?;
    Some((anchor, offset))
}

impl TranscriptScroll {
    /// Same-frame anchor lock: while the reader reads older transcript, the scroll offset that keeps the anchored viewport-top
    /// row fixed for this frame's row table, resolved before windowing uses it (resolving it only after the commit rendered the
    /// frame that grew the tail with the stale offset first, a blank band at the top). Without a usable anchor it is the live
    /// scroll offset. Records this frame's viewport.
    pub fn resolve_render_scroll_offset(&mut self, ids: &[Value], row_index: RowIndex<'_>, view_rows: usize, floating_panel_rows: usize) -> f64 {
        let has_reading_anchor = self.anchor.is_some() && !self.anchor_dirty;
        // Any positive target is a reading position; only the true bottom is pinned, so a wheel notch inside the former slack
        // band cannot re-enable follow while a stream appends rows.
        let scrolled_up = self.target.max(0.0) > 0.0;
        // An explicit follow arm owns the tail even if a stale reading anchor remains.
        let anchor_lock_active = has_reading_anchor && !self.following && scrolled_up;
        let target_near_bottom = self.following || !scrolled_up;
        let near_bottom_without_anchor = self.anchor.is_none() && !self.anchor_dirty && target_near_bottom;
        let reading_without_lock = !self.following && !near_bottom_without_anchor && scrolled_up;
        let mut render_offset = if target_near_bottom { 0.0 } else { self.scroll_offset as f64 };
        let view_rows = view_rows.max(1);
        let current = Current {
            ids,
            prefix_rows: row_index.prefix_rows,
            total_rows: row_index.total_rows,
            view_rows,
            max_rows: row_index.total_rows.saturating_sub(view_rows),
        };
        let mut adopted: Option<(Anchor, f64)> = None;
        if anchor_lock_active {
            if let Some(locked) = self.anchor.as_ref().and_then(|anchor| resolve_anchor_scroll_offset(anchor, &current)) {
                render_offset = locked;
            }
        } else if reading_without_lock {
            // Scrolled up with no usable anchor (missing, dirtied by a manual scroll whose capture failed, or dropped by a stale
            // follow arm): rendering with the stale bottom-relative offset would let any row growth this frame shift the visible
            // top before the commit could capture. Capture from the previous published geometry, which still holds the prior frame.
            adopted = lock_to_previous_top_edge(&self.geom, self.geom.view_rows, &current);
        }
        // Viewport-only transition freeze: a floating panel or view opening or closing changes the viewport height without
        // changing the items, so the bottom-relative offset would re-slice against the new height while the on-screen top edge
        // still reflects the old one. Only for a scrolled-up view with no active lock; bottom-pinned views are stable.
        let previous = self.viewport.unwrap_or_default();
        let viewport_only_changed = previous.content_height != view_rows || previous.floating_panel_rows != floating_panel_rows;
        if let Some((anchor, offset)) = adopted.take() {
            render_offset = offset;
            self.adopt(anchor);
        }
        if viewport_only_changed && !anchor_lock_active && reading_without_lock {
            let prev_view = if previous.content_height > 0 { previous.content_height } else { self.geom.view_rows };
            if let Some((anchor, offset)) = lock_to_previous_top_edge(&self.geom, prev_view, &current) {
                render_offset = offset;
                self.adopt(anchor);
            }
        }
        self.viewport = Some(Viewport { content_height: view_rows, floating_panel_rows });
        render_offset
    }

    /// Persist an anchor the render captured so the post-commit reconciliation keeps this exact one stable instead of deriving
    /// another from the already-shifted geometry.
    fn adopt(&mut self, anchor: Anchor) {
        self.anchor = Some(anchor);
        self.anchor_dirty = false;
    }

    /// Bottom follow: the viewport is already bottom-aligned, so every scroll value stays at zero instead of animating row
    /// growth (a temporary positive offset during streaming made the transcript jump and could clip the text being generated).
    /// `resume_follow` re-arms the follow when the reading position no longer exists.
    fn pin_scroll_to_bottom(&mut self, current_offset: f64, resume_follow: bool) {
        self.stop_smooth_scroll();
        self.target = 0.0;
        self.position = 0.0;
        self.anchor = None;
        self.anchor_dirty = false;
        if resume_follow {
            self.following = true;
        }
        if current_offset != 0.0 {
            self.set_scroll_offset(0);
        }
    }

    /// The absolute anchor lock after a commit. While the reader reads older transcript the anchored item is looked up in the
    /// current row table and the target re-derived so its row stays put: height changes below it only move the bottom, changes
    /// above it move its start and are absorbed the same way, with no per-frame deltas and no drift.
    pub fn sync_reading_anchor_after_commit(&mut self, frame: &CommitFrame<'_>) {
        if frame.previous_total_rows == 0 || frame.drag_active {
            return;
        }
        let row_delta = frame.total_rows as i64 - frame.previous_total_rows as i64;
        let current_target = self.target.max(0.0);
        let current_position = self.position.max(0.0);
        let current_offset = self.scroll_offset as f64;
        let max_scroll = frame.max_rows as f64;
        // The follow arm is a flag but the tail position is the truth: a commit that does not shrink content while the viewport
        // sits at the tail means the reader is at the bottom, whatever cleared the flag (a wheel tremor that moved nothing, a
        // click, a jump to the bottom). Only a shrink is excluded: it can put the offset at zero as an artifact.
        if !self.following && row_delta >= 0 && current_target == 0.0 {
            self.following = true;
        }
        // Follow ownership is explicit: zero can also mean the first read-back gesture waits for a newly mounted row's
        // measurement, so the number alone never grants permission to chase the tail. While following, stream growth and
        // viewport-only changes keep the transcript pinned instead of turning it into a reading-anchor lock.
        if self.following {
            self.pin_scroll_to_bottom(current_offset, false);
            return;
        }
        let view_rows = frame.view_rows.max(1);
        // (Re)capture the anchor from the current top edge when missing or invalidated by a manual scroll; nothing to correct.
        if self.anchor.is_none() || self.anchor_dirty {
            if let Some(captured) = reading_anchor_at(frame.prefix_rows, frame.ids, frame.total_rows, view_rows, current_target) {
                self.anchor = Some(captured);
            }
            self.anchor_dirty = false;
            return;
        }
        // The same pure helper the render path uses, so the post-commit sync can never disagree with the render correction.
        let current = Current { ids: frame.ids, prefix_rows: frame.prefix_rows, total_rows: frame.total_rows, view_rows, max_rows: frame.max_rows };
        let desired = self.anchor.as_ref().and_then(|anchor| resolve_anchor_scroll_offset(anchor, &current));
        let Some(desired) = desired else {
            if row_delta < 0 || current_target > max_scroll {
                self.pin_scroll_to_bottom(current_offset, true);
            } else {
                self.anchor_dirty = true;
            }
            return;
        };
        let applied_delta = desired - current_target;
        if applied_delta == 0.0 {
            return;
        }
        self.stop_smooth_scroll();
        self.target = desired;
        self.position = (current_position + applied_delta).min(max_scroll).max(0.0);
        // The render already applied `desired` through the anchor lock; the scroll state stays the committed authority and is not
        // mirrored back into the published offset from here.
    }

    /// Unanchored, not following and at target zero: a stale position or offset is cleared.
    pub fn reset_scroll_when_unanchored(&mut self) {
        if self.anchor.is_some() || self.anchor_dirty || self.following {
            return;
        }
        let current_target = self.target.max(0.0);
        if current_target != 0.0 {
            return;
        }
        if current_target.max(self.position.max(0.0)).max(self.scroll_offset as f64) == 0.0 {
            return;
        }
        self.stop_smooth_scroll();
        self.target = 0.0;
        self.position = 0.0;
        self.set_scroll_offset(0);
    }

    /// The auto-scroll rule (a surface that no longer overflows holds no reading position), on scroll and on content resize: a
    /// transcript that fits the viewport again after a compaction or clear re-arms follow. Otherwise every scroll value is
    /// clamped to the new maximum.
    pub fn clamp_scroll_to_overflow(&mut self, max_rows: usize) {
        let max_scroll = max_rows as f64;
        if max_rows == 0 && !self.following {
            self.anchor = None;
            self.anchor_dirty = false;
            self.following = true;
        }
        if self.target <= max_scroll && self.position <= max_scroll && self.scroll_offset as f64 <= max_scroll {
            return;
        }
        self.stop_smooth_scroll();
        let next = self.target.min(max_scroll).max(0.0);
        self.target = next;
        self.position = next;
        self.set_scroll_offset(next.round() as usize);
    }
}
