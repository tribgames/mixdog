//! Keyboard (Shift+Arrow, Home, End) movement of a released grid selection's focus end (`use-selection-focus.mjs`). At the
//! transcript viewport edge an Up or Down move scrolls one row to reveal new content, mirroring the mouse edge-drag autoscroll,
//! instead of clamping the selection in place.

use super::geometry::{linear_selection, rect_is_degenerate};
use super::state::{Point, Region};
use super::{Mouse, MouseHost};

/// The focus moves the key handler maps Shift+Arrow, Shift+Home and Shift+End to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FocusMove {
    Left,
    Right,
    Up,
    Down,
    LineStart,
    LineEnd,
}

impl Mouse {
    /// `scrollFocusPastEdge`: scrolls the transcript `delta_rows` on behalf of an edge move. `None` when the scroll did not
    /// move; otherwise the anchor re-read from the shifted rect (the scroll replaces the drag's rect with a shifted copy), which
    /// is itself `None` when there is no rect to read.
    fn scroll_focus_past_edge<H: MouseHost + ?Sized>(&mut self, host: &mut H, delta_rows: f64) -> Option<Option<Point>> {
        let before = host.scroll_target();
        host.scroll_transcript_rows(self, delta_rows);
        if host.scroll_target() == before {
            return None;
        }
        Some(self.drag.rect.as_ref().map(|rect| Point { x: rect.x1, y: rect.y1 }))
    }

    /// `moveSelectionFocus`: moves the focus end of the released transcript or status selection. Returns whether the move was
    /// consumed (a drag in progress, no live non-empty rect, an unknown move or a clamped no-op is not).
    pub fn move_selection_focus<H: MouseHost + ?Sized>(&mut self, host: &mut H, step: FocusMove, now_ms: u64) -> bool {
        // A selection the frame draws none of has no focus end on screen to move.
        if self.drag.active || self.follow.hidden {
            return false;
        }
        let region = self.drag.region;
        if !matches!(region, Some(Region::Transcript | Region::Status)) {
            return false;
        }
        let Some(rect) = self.drag.rect.as_ref() else { return false };
        if rect_is_degenerate(rect) {
            return false;
        }
        let mut anchor = Point { x: rect.x1, y: rect.y1 };
        let mut col = rect.x2;
        let mut row = rect.y2;
        let (before_col, before_row) = (col, row);
        // Set when an edge move scrolled the transcript: row and col then numerically equal their before values (both clamp to
        // the same viewport edge index) although the content changed, so the generic no-op guard must not fire.
        let mut scrolled_edge = false;

        let band = self.region_rows(region);
        let (top, bottom) = (band.top as i32, band.bottom as i32);
        match step {
            FocusMove::Left => {
                if col > 0 {
                    col -= 1;
                } else if row > top {
                    row -= 1;
                    col = self.selection_max_col_at_row(host, row);
                }
            }
            FocusMove::Right => {
                let max_col = self.selection_max_col_at_row(host, row);
                if col < max_col {
                    col += 1;
                } else if row < bottom {
                    row += 1;
                    col = 0;
                }
            }
            FocusMove::Up => {
                if row > top {
                    row -= 1;
                } else if region == Some(Region::Transcript) {
                    // Already at the top visible row: scroll up one row (past the bottom slack when still inside it) and extend
                    // the focus onto the newly revealed top row.
                    let before_target = host.scroll_target();
                    let slack = host.bottom_slack_rows().max(0.0);
                    let delta = if before_target <= slack { slack + 1.0 - before_target } else { 1.0 };
                    if let Some(scrolled) = self.scroll_focus_past_edge(host, delta) {
                        scrolled_edge = true;
                        if let Some(shifted) = scrolled {
                            anchor = shifted;
                        }
                        row = top;
                    }
                }
            }
            FocusMove::Down => {
                if row < bottom {
                    row += 1;
                } else if region == Some(Region::Transcript) {
                    if let Some(scrolled) = self.scroll_focus_past_edge(host, -1.0) {
                        scrolled_edge = true;
                        if let Some(shifted) = scrolled {
                            anchor = shifted;
                        }
                        row = bottom;
                    }
                }
            }
            FocusMove::LineStart => col = 0,
            FocusMove::LineEnd => col = self.selection_max_col_at_row(host, row),
        }

        row = row.clamp(top, bottom);
        col = col.clamp(0, self.selection_max_col_at_row(host, row));

        if !scrolled_edge && col == before_col && row == before_row {
            return false;
        }

        // After an edge scroll the drag's rect is a new object; the live drag is what is changed.
        self.drag.anchor_span = None;
        self.apply_selection_rect(host, Some(linear_selection(anchor, Point { x: col, y: row })), now_ms);
        self.drag.last = Some(Point { x: col, y: row });
        true
    }
}
