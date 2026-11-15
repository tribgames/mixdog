//! The held-at-edge autoscroll (`mouse-input/edge-autoscroll.mjs`). SGR mode 1002 reports drag motion only when the pointer
//! changes cell, so a pointer held still against the top or bottom row of the viewport stops emitting events and the
//! motion-driven scroll of the gestures stalls. This timer keeps scrolling, the scroll re-extending the selection to the
//! still-held last cell each step, until the pointer leaves the edge, the drag ends or a scroll boundary is reached. The timer
//! is the caller's: it wakes at [`Mouse::next_deadline`] and calls [`Mouse::tick`].

use super::gestures::EDGE_SCROLL_ROWS;
use super::state::Region;
use super::{Mouse, MouseHost};

/// How often the held-at-edge autoscroll steps.
pub const EDGE_AUTOSCROLL_INTERVAL_MS: u64 = 50;
/// Consecutive steps that moved nothing before the timer stops: more than 150 ms, far above the 16 ms the wheel coalescer
/// holds a delta, so any pending scroll has certainly flushed and only a real top or bottom clamp keeps the target pinned.
const NO_MOVE_STEPS_TO_STOP: u32 = 3;

#[derive(Debug, Default)]
pub(super) struct EdgeAutoscroll {
    /// `1` scrolls toward older rows, `-1` toward newer, `0` none.
    dir: i32,
    /// When the next step is due, while the timer runs.
    next_at: Option<u64>,
    no_move: u32,
}

impl EdgeAutoscroll {
    pub(super) fn deadline(&self) -> Option<u64> {
        self.next_at
    }

    pub(super) fn stop(&mut self) {
        self.next_at = None;
        self.dir = 0;
        self.no_move = 0;
    }
}

impl Mouse {
    /// `stopEdgeAutoscroll`.
    pub fn stop_edge_autoscroll(&mut self) {
        self.edge.stop();
    }

    /// `startEdgeAutoscroll(dir)`: a no-op while already scrolling that way.
    pub(super) fn start_edge_autoscroll(&mut self, dir: i32, now_ms: u64) {
        if self.edge.dir == dir && self.edge.next_at.is_some() {
            return;
        }
        self.edge.stop();
        self.edge.dir = dir;
        self.edge.next_at = Some(now_ms.saturating_add(EDGE_AUTOSCROLL_INTERVAL_MS));
    }

    /// One step of the timer when it is due.
    pub(super) fn edge_tick<H: MouseHost + ?Sized>(&mut self, host: &mut H, now_ms: u64) {
        if self.edge.next_at.is_none_or(|at| now_ms < at) {
            return;
        }
        self.edge.next_at = Some(now_ms.saturating_add(EDGE_AUTOSCROLL_INTERVAL_MS));
        if !self.drag.active || self.drag.region != Some(Region::Transcript) || self.edge.dir == 0 {
            self.edge.stop();
            return;
        }
        let before = host.scroll_target();
        let rows = f64::from(self.edge.dir) * EDGE_SCROLL_ROWS;
        host.queue_scroll_coalesced(self, rows);
        // A single unchanged tick is ambiguous (the coalescer may not have flushed the delta yet), so only consecutive ticks
        // that moved nothing stop the timer; any movement resets the count.
        if host.scroll_target() != before {
            self.edge.no_move = 0;
        } else {
            self.edge.no_move += 1;
            if self.edge.no_move >= NO_MOVE_STEPS_TO_STOP {
                self.edge.stop();
            }
        }
    }
}
