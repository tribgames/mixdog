//! The reading anchor (`transcript-scroll-anchor.mjs`, `transcript-anchor-lock.mjs::captureTopEdgeAnchor` and the pure helpers
//! of `transcript-window.mjs` the anchor arithmetic needs): which item sits at the top edge of the viewport, and the scroll
//! target that keeps it there when the row table changes.

use serde_json::Value;

/// The item and the row offset inside it at the top edge of the viewport. An item without an id (`Value::Null`) has no anchor.
#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub id: Value,
    pub offset: f64,
}

/// The geometry the last render published, so a manual scroll captures its anchor without waiting for the next commit.
#[derive(Clone, Debug, PartialEq)]
pub struct Geometry {
    /// Cumulative row starts, one per item plus the total; `None` before the first publish.
    pub prefix_rows: Option<Vec<usize>>,
    /// The item ids in order; an item without an id is `Value::Null`.
    pub ids: Vec<Value>,
    pub total_rows: usize,
    pub view_rows: usize,
    /// The scroll offset that frame was rendered with.
    pub render_offset: f64,
}

impl Default for Geometry {
    fn default() -> Self {
        Self { prefix_rows: None, ids: Vec::new(), total_rows: 0, view_rows: 1, render_offset: 0.0 }
    }
}

/// The row table and viewport of the frame being committed.
#[derive(Clone, Copy, Debug)]
pub struct Current<'a> {
    pub ids: &'a [Value],
    pub prefix_rows: Option<&'a [usize]>,
    pub total_rows: usize,
    pub view_rows: usize,
    pub max_rows: usize,
}

/// `upperBound`: the number of leading entries of `values` that are at most `target`.
pub fn upper_bound(values: &[usize], target: f64) -> usize {
    let (mut lo, mut hi) = (0, values.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if values[mid] as f64 <= target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

/// `readingAnchorAt` (and `captureTopEdgeAnchor`, which is it over the same arguments): the item and row offset at the top of
/// a viewport scrolled `target` rows up from the tail. `None` when the table has no items or the item has no id.
pub fn reading_anchor_at(prefix_rows: Option<&[usize]>, ids: &[Value], total_rows: usize, view_rows: usize, target: f64) -> Option<Anchor> {
    let prefix = prefix_rows.filter(|prefix| prefix.len() > 1)?;
    let total = total_rows as f64;
    let view = view_rows.max(1) as f64;
    let scroll = if target.is_nan() { 0.0 } else { target.max(0.0) };
    let row = (total - scroll - view).min(total).max(0.0);
    let index = upper_bound(prefix, row).saturating_sub(1).min(prefix.len() - 2);
    let id = ids.get(index).filter(|id| !id.is_null())?;
    Some(Anchor { id: id.clone(), offset: (row - prefix[index] as f64).max(0.0) })
}

/// `resolveAnchorScrollOffset`: the scroll offset that keeps `anchor` at the same screen position for the current row table.
/// `None` when the anchor has no id, the table is empty or the item is gone.
pub fn resolve_anchor_scroll_offset(anchor: &Anchor, current: &Current<'_>) -> Option<f64> {
    if anchor.id.is_null() {
        return None;
    }
    let prefix = current.prefix_rows.filter(|prefix| prefix.len() > 1)?;
    let index = current.ids.iter().rposition(|id| *id == anchor.id)?;
    if index > prefix.len() - 2 {
        return None;
    }
    let anchor_row = prefix[index] as f64 + anchor.offset;
    Some((current.total_rows as f64 - current.view_rows as f64 - anchor_row).min(current.max_rows as f64).max(0.0))
}

/// `bottomSnapRows`: a downward scroll landing within this many rows of the tail goes to the tail. It scales with the
/// viewport (a fifth of it, three to twelve rows) so fast output cannot outrun a wheel notch.
pub fn bottom_snap_rows(view_rows: usize) -> usize {
    view_rows.max(1).div_ceil(5).clamp(3, 12)
}

/// `transcriptSwapReturnsToTail`: whether an items swap destroyed the reader's position. Live appends never touch index zero,
/// so a changed head id marks a bulk swap (a session load, a clear, a compaction that trims the head and pushes its status row
/// in the same commit).
pub fn swap_returns_to_tail(count: usize, previous_count: usize, first_id: &Value, previous_first_id: &Value) -> bool {
    if previous_count == 0 || count < previous_count {
        return true;
    }
    if count == 0 {
        return false;
    }
    !first_id.is_null() && !previous_first_id.is_null() && first_id != previous_first_id
}
