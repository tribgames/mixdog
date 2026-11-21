//! The leading-edge coalescer of wheel and edge-drag deltas: the first delta after an idle period flushes at once, so a
//! single wheel tick or a short drag stays responsive, while a flood within the coalesce window accumulates into one scroll per
//! tick instead of one per mouse event. The clock is the caller's.

/// The pending rows and the direction of the deltas accumulated since the last flush.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DirectionalDelta {
    pub pending_rows: f64,
    /// `1` or `-1` while a direction is held, `0` when none.
    pub direction: i32,
}

/// Accumulates a same-direction delta, but never keeps movement from the opposite direction: a quick wheel reversal must not
/// apply an older queued delta a frame later and roll the transcript back against the latest gesture. Returns whether the
/// direction reversed, so the caller cancels its coalescing timer and flushes now.
pub fn accumulate_directional_scroll_delta(state: &mut DirectionalDelta, delta_rows: f64) -> bool {
    if delta_rows == 0.0 || delta_rows.is_nan() {
        return false;
    }
    let direction = if delta_rows > 0.0 { 1 } else { -1 };
    let reversed = state.direction != 0 && state.direction != direction;
    if reversed {
        state.pending_rows = 0.0;
    }
    state.direction = direction;
    state.pending_rows += delta_rows;
    reversed
}

/// The coalescer: [`Self::queue`] for every delta, [`Self::tick`] when [`Self::deadline`] passes.
#[derive(Clone, Copy, Debug, Default)]
pub struct ScrollCoalescer {
    delta: DirectionalDelta,
    deadline_ms: Option<u64>,
}

impl ScrollCoalescer {
    /// When the pending rows flush, if a window is open; the run loop calls [`Self::tick`] then.
    pub fn deadline(&self) -> Option<u64> {
        self.deadline_ms
    }

    /// A delta arrives at `now_ms`. Returns the rows to scroll now (the leading edge, or the flush of a reversal), `None` while
    /// the delta waits for the window to close.
    pub fn queue(&mut self, delta_rows: f64, now_ms: u64, coalesce_ms: u64) -> Option<f64> {
        let reversed = accumulate_directional_scroll_delta(&mut self.delta, delta_rows);
        if reversed {
            self.deadline_ms = None;
        }
        if self.deadline_ms.is_some() {
            return None;
        }
        let rows = std::mem::take(&mut self.delta.pending_rows);
        self.deadline_ms = Some(now_ms.saturating_add(coalesce_ms));
        Some(rows)
    }

    /// The window may have closed at `now_ms`: its end clears the direction and flushes what accumulated.
    pub fn tick(&mut self, now_ms: u64) -> Option<f64> {
        if self.deadline_ms.is_none_or(|deadline| now_ms < deadline) {
            return None;
        }
        self.deadline_ms = None;
        self.delta.direction = 0;
        (self.delta.pending_rows != 0.0).then(|| std::mem::take(&mut self.delta.pending_rows))
    }

    /// Drops the window and everything pending (the view closes).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}
