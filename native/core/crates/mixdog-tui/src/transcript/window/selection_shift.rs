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
    fn cells_order_by_row_then_column() {
        let at = |x, y| Cell { x, y };
        assert_eq!(compare_cell_order(at(5, 1), at(0, 2)), -1);
        assert_eq!(compare_cell_order(at(0, 3), at(9, 2)), 1);
        assert_eq!(compare_cell_order(at(4, 2), at(9, 2)), -1);
        assert_eq!(compare_cell_order(at(4, 2), at(4, 2)), 0);
    }
}
