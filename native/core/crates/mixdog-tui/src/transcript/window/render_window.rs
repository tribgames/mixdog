//! The render window: which items to mount for the viewport and the scroll limits.
//!
//! The span tunables are read from (`MIXDOG_TUI_TRANSCRIPT_WINDOW_MIN_ITEMS`,
//! `MIXDOG_TUI_TRANSCRIPT_OVERSCAN_ROWS`, `MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS`, `MIXDOG_TUI_TRANSCRIPT_TAIL_OVERSCAN_ROWS`,
//! `MIXDOG_TUI_TRANSCRIPT_WINDOW_TAIL_ITEMS`); a value that is not a positive number keeps the default.

use std::sync::OnceLock;

use mixdog_term::guard::positive_int;

use super::heights::item_id;
use super::row_index::{Items, RowIndex};

/// The tunables of the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowTuning {
    /// The floor of mounted items.
    pub min_items: usize,
    /// Rows mounted above and below the viewport when scrolled up.
    pub overscan_rows: usize,
    /// The cap of mounted items when scrolled up.
    pub max_items: usize,
    /// Rows mounted around the viewport at the live tail.
    pub tail_overscan_rows: usize,
    /// The cap of mounted items at the live tail.
    pub tail_max_items: usize,
}

impl Default for WindowTuning {
    fn default() -> Self {
        Self { min_items: 12, overscan_rows: 16, max_items: 80, tail_overscan_rows: 4, tail_max_items: 20 }
    }
}

/// The window over the items for one frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenderWindow {
    /// The first mounted item.
    pub start_index: usize,
    /// One past the last mounted item.
    pub end_index: usize,
    /// The rows of the items after the window, kept as a spacer so the scroll coordinate holds.
    pub bottom_spacer_rows: usize,
    pub total_rows: usize,
    /// The furthest the transcript scrolls up from the tail.
    pub max_scroll_rows: usize,
    /// The scroll offset (rows from the tail) clamped to the limits.
    pub effective_scroll_offset: usize,
}

/// `lowerBound`: the first index of `values` that is not below `target` (`values` ascending).
pub fn lower_bound(values: &[usize], target: usize) -> usize {
    values.partition_point(|value| *value < target)
}

/// `upperBound`: the first index of `values` that is above `target` (`values` ascending).
pub fn upper_bound(values: &[usize], target: usize) -> usize {
    values.partition_point(|value| *value <= target)
}

/// `itemSpanForRows`: the items whose rows intersect `[top, bottom)`, from the one at or before `top` through the one
/// crossing `bottom`, at least one item.
fn item_span_for_rows(prefix_rows: &[usize], item_count: usize, top: usize, bottom: usize) -> (usize, usize) {
    let start = upper_bound(prefix_rows, top).saturating_sub(1);
    let end = item_count.min((start + 1).max(lower_bound(prefix_rows, bottom.max(top + 1))));
    (start, end)
}

/// `capItemSpan`: the cap never cuts into the rows needed to fill the viewport, so it is floored at the item span the visible
/// viewport covers (a run of one-line items cannot leave the top of the viewport unmounted under the small tail cap).
fn cap_item_span(prefix_rows: &[usize], item_count: usize, max_items: usize, visible_top: usize, visible_bottom: usize) -> (usize, usize) {
    let (visible_start, visible_end) = item_span_for_rows(prefix_rows, item_count, visible_top, visible_bottom);
    let effective_max = max_items.max(visible_end - visible_start);
    let mut start = visible_start.min(item_count.saturating_sub(effective_max));
    let end = item_count.min(visible_end.max(start + effective_max));
    if end - start > effective_max {
        start = end.saturating_sub(effective_max);
    }
    (start, end)
}

/// `chooseItemSpan`: the viewport plus overscan, at least `min_items`, capped at the maximum.
fn choose_item_span(
    prefix_rows: &[usize],
    item_count: usize,
    total_rows: usize,
    view_rows: usize,
    effective_scroll_offset: usize,
    tuning: &WindowTuning,
) -> (usize, usize) {
    let min_items = tuning.min_items.min(item_count);
    let at_tail = effective_scroll_offset == 0;
    let overscan_rows = if at_tail { tuning.tail_overscan_rows } else { tuning.overscan_rows };
    let max_items = min_items.max(if at_tail { tuning.tail_max_items } else { tuning.max_items });
    let visible_top = total_rows.saturating_sub(effective_scroll_offset + view_rows);
    let visible_bottom = total_rows.saturating_sub(effective_scroll_offset).min(total_rows);
    let (mut start, mut end) =
        item_span_for_rows(prefix_rows, item_count, visible_top.saturating_sub(overscan_rows), total_rows.min(visible_bottom + overscan_rows));
    while end - start < min_items && start > 0 {
        start -= 1;
    }
    while end - start < min_items && end < item_count {
        end += 1;
    }
    if end - start > max_items {
        return cap_item_span(prefix_rows, item_count, max_items, visible_top, visible_bottom);
    }
    (start, end)
}

/// `Number(value) || fallback`: a NaN or zero takes the fallback.
fn number_or(value: f64, fallback: f64) -> f64 {
    if value.is_nan() || value == 0.0 { fallback } else { value }
}

/// `transcriptRenderWindow`: the items to mount over `index` when the viewport is `viewport_height` rows high and
/// `scroll_offset` rows above the tail (rounded up, clamped to the limits; a viewport of 0 or NaN rows is 24).
pub fn transcript_render_window(index: &RowIndex, scroll_offset: f64, viewport_height: f64, tuning: &WindowTuning) -> RenderWindow {
    let item_count = index.rows.len();
    let total_rows = index.total_rows;
    let view_rows = number_or(viewport_height, 24.0).max(1.0) as usize;
    let max_scroll_rows = total_rows.saturating_sub(view_rows);
    let wanted = number_or(scroll_offset, 0.0).ceil().max(0.0);
    let effective_scroll_offset = if wanted >= max_scroll_rows as f64 { max_scroll_rows } else { wanted as usize };
    let bypass_row_budget = view_rows + tuning.overscan_rows * 2;
    if item_count <= tuning.min_items || total_rows <= bypass_row_budget {
        return RenderWindow { start_index: 0, end_index: item_count, bottom_spacer_rows: 0, total_rows, max_scroll_rows, effective_scroll_offset };
    }
    let (start_index, end_index) = choose_item_span(&index.prefix_rows, item_count, total_rows, view_rows, effective_scroll_offset, tuning);
    let end_row = index.prefix_rows.get(end_index).copied().filter(|row| *row != 0).unwrap_or(total_rows);
    RenderWindow { start_index, end_index, bottom_spacer_rows: total_rows.saturating_sub(end_row), total_rows, max_scroll_rows, effective_scroll_offset }
}

/// A reading anchor: the item at the viewport top and the offset inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnchorPoint {
    pub id: String,
    pub offset: usize,
}

/// `resolveAnchorScrollOffset`: the scroll offset that keeps a captured reading anchor at the same screen position for the
/// current prefix table; none when there is no anchor, the table is empty or the anchored item is gone. It runs during render
/// and after commit alike, so it is pure.
pub fn resolve_anchor_scroll_offset(
    anchor: Option<&AnchorPoint>,
    items: &Items,
    cur_prefix: &[usize],
    total_rows: usize,
    view_rows: usize,
    max_rows: usize,
) -> Option<usize> {
    let anchor = anchor?;
    if cur_prefix.len() <= 1 {
        return None;
    }
    let index = (0..items.len()).rev().find(|at| items.get(*at).and_then(item_id).as_deref() == Some(anchor.id.as_str()))?;
    if index > cur_prefix.len() - 2 {
        return None;
    }
    let anchor_row = cur_prefix[index] + anchor.offset;
    Some(total_rows.saturating_sub(view_rows + anchor_row).min(max_rows))
}

/// `transcriptSwapReturnsToTail`: whether an items swap destroyed the reader's position, so the viewport returns to the live
/// tail with follow re-armed. A bulk swap (session load or clear, a compaction that trims the head and pushes its status row
/// in the same commit, so the count can stay level) drops the history the reader was anchored to. Live appends never touch
/// index 0, so a changed head id is the bulk-swap signal.
pub fn transcript_swap_returns_to_tail(count: usize, previous_count: usize, first_id: Option<&str>, previous_first_id: Option<&str>) -> bool {
    if previous_count == 0 {
        return true;
    }
    if count < previous_count {
        return true;
    }
    if count == 0 {
        return false;
    }
    matches!((first_id, previous_first_id), (Some(first), Some(previous)) if first != previous)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn index_of(rows: &[usize]) -> RowIndex {
        let mut prefix_rows = vec![0];
        for row in rows {
            prefix_rows.push(prefix_rows.last().copied().unwrap_or(0) + row);
        }
        RowIndex { rows: rows.to_vec(), total_rows: prefix_rows.last().copied().unwrap_or(0), prefix_rows }
    }

    #[test]
    fn bounds_partition_a_prefix_table() {
        let prefix = [0, 2, 2, 5, 9];
        assert_eq!(lower_bound(&prefix, 2), 1);
        assert_eq!(upper_bound(&prefix, 2), 3);
        assert_eq!(lower_bound(&prefix, 10), 5);
        assert_eq!(upper_bound(&prefix, 0), 1);
    }

    #[test]
    fn a_short_transcript_mounts_every_item() {
        let window = transcript_render_window(&index_of(&[1; 10]), 0.0, 6.0, &WindowTuning::default());
        assert_eq!((window.start_index, window.end_index, window.bottom_spacer_rows), (0, 10, 0));
        assert_eq!(window.max_scroll_rows, 4);
    }

    #[test]
    fn the_tail_view_mounts_a_small_span_and_a_scrolled_view_a_larger_one() {
        let index = index_of(&[1; 200]);
        let tuning = WindowTuning::default();
        let tail = transcript_render_window(&index, 0.0, 6.0, &tuning);
        assert_eq!(tail.end_index, 200);
        assert_eq!(tail.start_index, 188, "the viewport and its overscan cover 10 items, the floor of 12 pulls two more in");
        assert_eq!(tail.bottom_spacer_rows, 0);
        let scrolled = transcript_render_window(&index, 100.0, 6.0, &tuning);
        assert_eq!(scrolled.effective_scroll_offset, 100);
        assert!(scrolled.start_index <= 200 - 100 - 6 - tuning.overscan_rows);
        assert!(scrolled.end_index - scrolled.start_index <= tuning.max_items);
        assert_eq!(scrolled.bottom_spacer_rows, 200 - scrolled.end_index);
    }

    #[test]
    fn the_scroll_offset_is_rounded_up_and_clamped() {
        let index = index_of(&[1; 200]);
        let tuning = WindowTuning::default();
        assert_eq!(transcript_render_window(&index, 2.1, 6.0, &tuning).effective_scroll_offset, 3);
        assert_eq!(transcript_render_window(&index, 10_000.0, 6.0, &tuning).effective_scroll_offset, 194);
        assert_eq!(transcript_render_window(&index, -5.0, 6.0, &tuning).effective_scroll_offset, 0);
        assert_eq!(transcript_render_window(&index, f64::NAN, 0.0, &tuning).max_scroll_rows, 176);
    }

    #[test]
    fn the_cap_never_cuts_into_the_viewport() {
        let index = index_of(&[1; 200]);
        let tuning = WindowTuning { tail_max_items: 2, ..WindowTuning::default() };
        let window = transcript_render_window(&index, 0.0, 30.0, &tuning);
        assert!(window.end_index - window.start_index >= 30);
    }

    #[test]
    fn tuning_reads_positive_numbers_and_ignores_the_rest() {
        let tuned = WindowTuning::from_vars(|name| match name {
            "MIXDOG_TUI_TRANSCRIPT_WINDOW_MIN_ITEMS" => Some("5".to_owned()),
            "MIXDOG_TUI_TRANSCRIPT_OVERSCAN_ROWS" => Some("0".to_owned()),
            "MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS" => Some("many".to_owned()),
            "MIXDOG_TUI_TRANSCRIPT_TAIL_OVERSCAN_ROWS" => Some("9.7".to_owned()),
            _ => None,
        });
        assert_eq!(tuned, WindowTuning { min_items: 5, tail_overscan_rows: 9, ..WindowTuning::default() });
    }

    #[test]
    fn the_anchor_keeps_its_screen_position() {
        let items_data: Vec<_> = (0..4).map(|n| json!({"id": format!("i{n}"), "kind": "user"})).collect();
        let items = Items::new(&items_data, None);
        let prefix = [0, 3, 6, 9, 12];
        let anchor = AnchorPoint { id: "i2".to_owned(), offset: 1 };
        assert_eq!(resolve_anchor_scroll_offset(Some(&anchor), &items, &prefix, 12, 4, 8), Some(1));
        assert_eq!(resolve_anchor_scroll_offset(Some(&anchor), &items, &prefix, 12, 4, 0), Some(0));
        assert_eq!(resolve_anchor_scroll_offset(Some(&AnchorPoint { id: "gone".to_owned(), offset: 0 }), &items, &prefix, 12, 4, 8), None);
        assert_eq!(resolve_anchor_scroll_offset(None, &items, &prefix, 12, 4, 8), None);
        assert_eq!(resolve_anchor_scroll_offset(Some(&anchor), &items, &[0], 12, 4, 8), None);
    }

    #[test]
    fn a_swap_returns_to_the_tail_when_the_head_changed() {
        assert!(transcript_swap_returns_to_tail(5, 0, Some("a"), None));
        assert!(transcript_swap_returns_to_tail(3, 5, Some("a"), Some("a")));
        assert!(transcript_swap_returns_to_tail(0, 1, None, None), "a cleared transcript returns to the tail");
        assert!(!transcript_swap_returns_to_tail(5, 5, Some("a"), Some("a")));
        assert!(transcript_swap_returns_to_tail(5, 5, Some("b"), Some("a")), "a compaction trims the head and keeps the count");
        assert!(!transcript_swap_returns_to_tail(5, 5, None, Some("a")));
    }
}

impl WindowTuning {
    /// The tunables as `var` (an environment lookup) sets them.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Self {
        let default = Self::default();
        let read = |name: &str, fallback: usize| positive_int(var(name), fallback as u64) as usize;
        Self {
            min_items: read("MIXDOG_TUI_TRANSCRIPT_WINDOW_MIN_ITEMS", default.min_items),
            overscan_rows: read("MIXDOG_TUI_TRANSCRIPT_OVERSCAN_ROWS", default.overscan_rows),
            max_items: read("MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS", default.max_items),
            tail_overscan_rows: read("MIXDOG_TUI_TRANSCRIPT_TAIL_OVERSCAN_ROWS", default.tail_overscan_rows),
            tail_max_items: read("MIXDOG_TUI_TRANSCRIPT_WINDOW_TAIL_ITEMS", default.tail_max_items),
        }
    }

    /// The tunables of this process, read once.
    pub fn current() -> Self {
        static CURRENT: OnceLock<WindowTuning> = OnceLock::new();
        *CURRENT.get_or_init(|| Self::from_vars(|name| std::env::var(name).ok()))
    }
}
