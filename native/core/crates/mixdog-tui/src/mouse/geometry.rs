//! Region geometry of the mouse handler (`mouse-input/geometry.mjs`, `use-selection-geometry.mjs`): which surface owns an
//! absolute grid cell (transcript viewport, statusline band, prompt box), how a drag point snaps into its region, how a
//! stored point follows the transcript scroll, how a word or line span grows toward the pointer and the rightmost selectable
//! column of a row. Every reader resolves the current rects from [`Mouse`] at call time.

use mixdog_term::selection::{CellSpan, SelectionMode, SelectionRect};

use crate::transcript::window::selection_shift::{Cell, RowRange, compare_cell_order, status_band_row_range};

use super::host::{PromptSelection, RenderStore, SelectionIo};
use super::state::{AnchorSpan, Point, Region, SpanKind};
use super::{Mouse, MouseHost};

/// `linearSelection`: the rect from `a` to `b` along the text.
pub fn linear_selection(a: Point, b: Point) -> SelectionRect {
    SelectionRect::new(SelectionMode::Linear, a.x, a.y, b.x, b.y)
}

/// `selectionRectIsDegenerate`: both ends on the same cell.
pub fn rect_is_degenerate(rect: &SelectionRect) -> bool {
    rect.x1 == rect.x2 && rect.y1 == rect.y2
}

/// `selectionPointAtCurrentScroll`: a stored point moved by the rows the transcript scrolled since `point_scroll`.
pub fn selection_point_at_current_scroll(point: Point, point_scroll: f64, scroll_target: f64) -> Point {
    Point { x: point.x, y: (f64::from(point.y) + scroll_target - point_scroll).round() as i32 }
}

fn cell(point: Point) -> Cell {
    Cell { x: i64::from(point.x), y: i64::from(point.y) }
}

impl Mouse {
    /// `transcriptViewport`: the rows of the transcript viewport.
    pub fn transcript_viewport(&self) -> RowRange {
        self.viewport
    }

    /// `statusBand`: the bottom statusline band, the last rows of the frame.
    pub fn status_band(&self) -> RowRange {
        status_band_row_range(self.frame_rows, self.cfg.statusline_band_rows)
    }

    /// The rows a region's selection lives in.
    pub(super) fn region_rows(&self, region: Option<Region>) -> RowRange {
        if region == Some(Region::Status) { self.status_band() } else { self.viewport }
    }

    pub(super) fn is_in_transcript_viewport(&self, row: i32) -> bool {
        let RowRange { top, bottom } = self.viewport;
        i64::from(row) >= top && i64::from(row) <= bottom
    }

    pub(super) fn is_in_status_band(&self, row: i32) -> bool {
        let RowRange { top, bottom } = self.status_band();
        i64::from(row) >= top && i64::from(row) <= bottom
    }

    pub(super) fn clamp_to_region(&self, row: i32, region: Option<Region>) -> i32 {
        let RowRange { top, bottom } = self.region_rows(region);
        i64::from(row).clamp(top, bottom) as i32
    }

    /// The rightmost column of the grid.
    fn max_selection_column(&self) -> i32 {
        let columns = if self.columns > 0 { self.columns } else { 80 };
        columns as i32 - 1
    }

    /// `selectionPointInRegion`: snaps a drag point into the region that owns the selection. Rows clamp to the band, and the
    /// column follows text-selection semantics: a pointer above the band selects to the start of its first row, below it to the
    /// end of its last row. Horizontal overshoot is clamped into the grid too: while the pointer sits outside the window a
    /// terminal can report column 0 (x = -1) or a column past the width, which would order the point before or after the anchor
    /// and flip the selection.
    pub(super) fn selection_point_in_region(&self, x: i32, y: i32, region: Option<Region>) -> Point {
        let RowRange { top, bottom } = self.region_rows(region);
        let max_x = self.max_selection_column();
        if i64::from(y) < top {
            return Point { x: 0, y: top as i32 };
        }
        if i64::from(y) > bottom {
            return Point { x: max_x, y: bottom as i32 };
        }
        Point { x: x.clamp(0, max_x), y }
    }

    /// `isInPromptBox`.
    pub(super) fn is_in_prompt_box(&self, x: i32, y: i32) -> bool {
        let Some(rect) = self.prompt_box else { return false };
        let top = rect.top.max(0);
        let bottom = top + rect.height.max(1) - 1;
        let left = rect.left.max(0);
        let width = rect.content_width.max(1);
        y >= top && y <= bottom && x >= left && x < left + width
    }

    /// `promptOffsetAt`: the prompt-draft edit offset of an absolute grid cell through the prompt box's measured rect and its
    /// caret math. The mapped row and column clamp to the box, so a drag that runs outside it still tracks the nearest edge
    /// cell. `None` without a measured box or a prompt engine.
    pub(super) fn prompt_offset_at(&self, prompt: Option<&mut dyn PromptSelection>, x: i32, y: i32) -> Option<usize> {
        let rect = self.prompt_box?;
        let prompt = prompt?;
        let top = rect.top.max(0);
        let left = rect.left.max(0);
        let height = rect.height.max(1);
        let width = rect.content_width.max(1);
        let row = (y - top).clamp(0, height - 1);
        let col = (x - left).clamp(0, width);
        Some(prompt.offset_at_cell(row as usize, col as usize))
    }

    /// `buildSpanRect`: grows a word or line multi-click selection from its anchor span out to the word or line under the
    /// cursor. The moving end snaps to the word or line under it and falls back to the raw cell on a miss; `span_scroll`
    /// re-anchors the stored span to the current transcript scroll (the status band never scrolls). The anchor span always
    /// stays whole: the rect reaches from it toward the target when the target sits clear of it on either side, and collapses
    /// back to the anchor when the two overlap.
    pub fn build_span_rect<S: SelectionIo + ?Sized>(
        &self,
        store: &mut S,
        span: AnchorSpan,
        x: i32,
        y: i32,
        region: Option<Region>,
        span_scroll: f64,
    ) -> SelectionRect {
        let target_scroll = store.scroll_target();
        let at_current_scroll = |point: Point| {
            if region == Some(Region::Status) { point } else { selection_point_at_current_scroll(point, span_scroll, target_scroll) }
        };
        let anchor_start = at_current_scroll(span.lo);
        let anchor_end = at_current_scroll(span.hi);
        let snapped: Option<CellSpan> = match span.kind {
            SpanKind::Word => store.word_rect_at(x, y),
            SpanKind::Line => store.line_rect_at(y),
        };
        let (target_start, target_end) = match (snapped, span.kind) {
            (Some(found), _) => (Point { x: found.x1, y: found.y1 }, Point { x: found.x2, y: found.y2 }),
            (None, SpanKind::Word) => (Point { x, y }, Point { x, y }),
            (None, SpanKind::Line) => (Point { x: 0, y }, Point { x: (self.columns as i32 - 1).max(0), y }),
        };
        if compare_cell_order(cell(target_end), cell(anchor_start)) < 0 {
            return linear_selection(anchor_end, target_start);
        }
        if compare_cell_order(cell(target_start), cell(anchor_end)) > 0 {
            return linear_selection(anchor_start, target_end);
        }
        linear_selection(anchor_start, anchor_end)
    }

    /// `selectionMaxColAtRow`: the rightmost selectable column of a row, the end of its text, else the grid's last column.
    pub fn selection_max_col_at_row<S: RenderStore + ?Sized>(&self, store: &mut S, row: i32) -> i32 {
        match store.line_rect_at(row) {
            Some(line) => line.x2.max(0),
            None => (self.columns as i32 - 1).max(0),
        }
    }

    /// `selectionPointAtCurrentScroll` over the drag's own anchor: a transcript anchor is re-projected to the current scroll
    /// position, a status-band anchor is used as is.
    pub(super) fn region_anchor<H: MouseHost + ?Sized>(&self, host: &H, region: Option<Region>) -> Option<Point> {
        let anchor = self.drag.anchor?;
        if region == Some(Region::Status) {
            return Some(anchor);
        }
        Some(selection_point_at_current_scroll(anchor, self.drag.anchor_scroll, host.scroll_target()))
    }
}
