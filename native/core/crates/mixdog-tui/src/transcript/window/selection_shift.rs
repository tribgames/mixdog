//! The selection geometry the readers share and the shift that keeps a released selection on its text (the selection helpers
//! of `transcript-window.mjs` and `use-transcript-window/selection-shift.mjs`).
//!
//! The effect of the Node hook is split here into the part that is arithmetic: [`SelectionLayout::capture`] records the layout
//! of a frame, [`layout_shift`] is the rows the layout moved a selection by, and [`shifted_selection`] is the rect after the
//! move. Clipping the rect to the viewport and painting it are the mouse's (`withSelectionClip`, `paintSelectionRect`); a
//! shifted rect is painted without remembering its text (it is viewport-clipped, so harvesting it would replace the full text
//! remembered at drag release with the visible fragment), and so is the repaint after a theme change.

use super::render_window::RenderWindow;

/// A selection rect on the screen grid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectionRect {
    pub mode: Option<String>,
    pub x1: i64,
    pub y1: i64,
    pub x2: i64,
    pub y2: i64,
    pub clip_y1: Option<i64>,
    pub clip_y2: Option<i64>,
    pub capture_text: Option<bool>,
}

/// `selectionRectIsDegenerate`: a rect whose two ends sit on the same cell selects nothing.
pub fn selection_rect_is_degenerate(rect: &SelectionRect) -> bool {
    rect.x1 == rect.x2 && rect.y1 == rect.y2
}

/// `selectionRectsEqual`.
pub fn selection_rects_equal(a: Option<&SelectionRect>, b: Option<&SelectionRect>) -> bool {
    a == b
}

/// A viewport's row range, top and bottom inclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowRange {
    pub top: i64,
    pub bottom: i64,
}

/// `Number(value) || 0`.
fn number_or_zero(value: f64) -> f64 {
    if value.is_nan() { 0.0 } else { value }
}

/// `transcriptViewportRowRange`: the viewport's rows normalised, the bottom never above the top (a missing one is the top).
pub fn transcript_viewport_row_range(top: Option<f64>, bottom: Option<f64>) -> RowRange {
    let top = number_or_zero(top.unwrap_or(0.0)).max(0.0);
    let bottom = number_or_zero(bottom.unwrap_or(top));
    RowRange { top: top as i64, bottom: bottom.max(top) as i64 }
}

/// `statusBandRowRange`: the bottom statusline band, the last `statusline_band_rows` rows of the frame (a missing frame
/// height means 24 rows).
pub fn status_band_row_range(frame_rows: f64, statusline_band_rows: usize) -> RowRange {
    let wanted = if number_or_zero(frame_rows) == 0.0 { 24.0 } else { frame_rows };
    let rows = wanted.max(1.0) as i64;
    let top = (rows - statusline_band_rows as i64).max(0);
    RowRange { top, bottom: top.max(rows - 1) }
}

/// `shiftSelectionRectY`: the rect moved `delta_y` rows (`Math.round`: halves go up); none stays none and a zero shift keeps the rect.
pub fn shift_selection_rect_y(rect: Option<&SelectionRect>, delta_y: f64) -> Option<SelectionRect> {
    let dy = (number_or_zero(delta_y) + 0.5).floor() as i64;
    let rect = rect?;
    if dy == 0 {
        return Some(rect.clone());
    }
    Some(SelectionRect { y1: rect.y1 + dy, y2: rect.y2 + dy, ..rect.clone() })
}

/// A grid cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub x: i64,
    pub y: i64,
}

/// `compareCellOrder`: reading order over grid cells, the row deciding and the column breaking ties; the sign of the
/// difference.
pub fn compare_cell_order(a: Cell, b: Cell) -> i32 {
    if a.y == b.y { (a.x - b.x).signum() as i32 } else { (a.y - b.y).signum() as i32 }
}

/// The layout the selection was last placed against (`selectionLayoutRef`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionLayout {
    pub top: i64,
    pub height: i64,
    pub total_rows: i64,
    pub scroll_offset: i64,
}

impl SelectionLayout {
    /// The layout of this frame: the viewport's top row on the screen (a missing one is 0), its height (at least 1) and the
    /// window's totals.
    pub fn capture(viewport_top: Option<f64>, content_height: usize, window: &RenderWindow) -> Self {
        Self {
            top: number_or_zero(viewport_top.unwrap_or(0.0)).max(0.0) as i64,
            height: content_height.max(1) as i64,
            total_rows: window.total_rows as i64,
            scroll_offset: window.effective_scroll_offset as i64,
        }
    }
}

/// The rows the layout moved the selection's text by between two frames: the viewport top and height, less the growth of the
/// transcript, plus the change of the scroll offset.
pub fn layout_shift(previous: &SelectionLayout, next: &SelectionLayout) -> i64 {
    next.top - previous.top + (next.height - previous.height) - (next.total_rows - previous.total_rows) + (next.scroll_offset - previous.scroll_offset)
}

/// The rect a released selection is moved to when the layout changed under it: none while there is no previous layout, no
/// rect, a drag in progress (its edge autoscroll commits on every pointer motion) or no shift.
pub fn shifted_selection(previous: Option<&SelectionLayout>, next: &SelectionLayout, rect: Option<&SelectionRect>, drag_active: bool) -> Option<SelectionRect> {
    let (previous, rect) = (previous?, rect?);
    if drag_active {
        return None;
    }
    let delta = layout_shift(previous, next);
    if delta == 0 {
        return None;
    }
    shift_selection_rect_y(Some(rect), delta as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x1: i64, y1: i64, x2: i64, y2: i64) -> SelectionRect {
        SelectionRect { mode: None, x1, y1, x2, y2, clip_y1: None, clip_y2: None, capture_text: None }
    }

    #[test]
    fn shared_selection_geometry_normalizes_both_row_ranges_and_the_empty_rect() {
        assert!(selection_rect_is_degenerate(&rect(3, 4, 3, 4)));
        assert!(!selection_rect_is_degenerate(&rect(3, 4, 4, 4)));
        assert!(!selection_rect_is_degenerate(&rect(3, 4, 3, 5)));

        assert_eq!(transcript_viewport_row_range(Some(2.0), Some(9.0)), RowRange { top: 2, bottom: 9 });
        assert_eq!(transcript_viewport_row_range(Some(-4.0), Some(3.0)), RowRange { top: 0, bottom: 3 });
        assert_eq!(transcript_viewport_row_range(Some(7.0), Some(2.0)), RowRange { top: 7, bottom: 7 });
        assert_eq!(transcript_viewport_row_range(None, None), RowRange { top: 0, bottom: 0 });

        assert_eq!(status_band_row_range(24.0, 2), RowRange { top: 22, bottom: 23 });
        assert_eq!(status_band_row_range(0.0, 2), RowRange { top: 22, bottom: 23 }, "a missing frame height means 24 rows");
        assert_eq!(status_band_row_range(3.0, 8), RowRange { top: 0, bottom: 2 });
        assert_eq!(status_band_row_range(1.0, 2), RowRange { top: 0, bottom: 0 });
    }

    #[test]
    fn rects_compare_by_every_field_and_shift_by_whole_rows() {
        let a = rect(1, 2, 3, 4);
        assert!(selection_rects_equal(Some(&a), Some(&rect(1, 2, 3, 4))));
        assert!(!selection_rects_equal(Some(&a), Some(&SelectionRect { capture_text: Some(true), ..rect(1, 2, 3, 4) })));
        assert!(!selection_rects_equal(Some(&a), None));
        assert!(selection_rects_equal(None, None));
        assert_eq!(shift_selection_rect_y(Some(&a), 2.4), Some(rect(1, 4, 3, 6)));
        assert_eq!(shift_selection_rect_y(Some(&a), 0.2), Some(a.clone()));
        assert_eq!(shift_selection_rect_y(None, 3.0), None);
    }

    #[test]
    fn cells_order_by_row_then_column() {
        let at = |x, y| Cell { x, y };
        assert_eq!(compare_cell_order(at(5, 1), at(0, 2)), -1);
        assert_eq!(compare_cell_order(at(0, 3), at(9, 2)), 1);
        assert_eq!(compare_cell_order(at(4, 2), at(9, 2)), -1);
        assert_eq!(compare_cell_order(at(4, 2), at(4, 2)), 0);
    }

    #[test]
    fn a_released_selection_follows_its_text_when_the_layout_moves() {
        let layout = |top, height, total_rows, scroll_offset| SelectionLayout { top, height, total_rows, scroll_offset };
        let before = layout(0, 20, 100, 0);
        let selection = rect(0, 5, 8, 6);
        // Ten rows appended while the anchor lock keeps the view (the offset grows with the total): no shift.
        assert_eq!(shifted_selection(Some(&before), &layout(0, 20, 110, 10), Some(&selection), false), None);
        // Ten rows appended at the tail: the text moved up ten rows.
        assert_eq!(shifted_selection(Some(&before), &layout(0, 20, 110, 0), Some(&selection), false), Some(rect(0, -5, 8, -4)));
        // The viewport shrank by 3 rows (a panel opened).
        assert_eq!(layout_shift(&before, &layout(0, 17, 100, 0)), -3);
        assert_eq!(shifted_selection(None, &before, Some(&selection), false), None);
        assert_eq!(shifted_selection(Some(&before), &layout(0, 20, 110, 0), None, false), None);
        assert_eq!(shifted_selection(Some(&before), &layout(0, 20, 110, 0), Some(&selection), true), None, "a drag is not shifted");
    }

    #[test]
    fn the_layout_of_a_frame_comes_from_its_window() {
        let window = RenderWindow { start_index: 0, end_index: 3, bottom_spacer_rows: 0, total_rows: 40, max_scroll_rows: 30, effective_scroll_offset: 4 };
        assert_eq!(SelectionLayout::capture(Some(2.0), 0, &window), SelectionLayout { top: 2, height: 1, total_rows: 40, scroll_offset: 4 });
        assert_eq!(SelectionLayout::capture(None, 12, &window).top, 0);
    }
}
