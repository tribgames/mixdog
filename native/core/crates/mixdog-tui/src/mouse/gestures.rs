//! The button half of the mouse channel (`mouse-input/button-gestures.mjs`): click, drag and release events become a text
//! selection in the region that owns the press (prompt box, transcript viewport, statusline band) with word and line
//! multi-click, shift/ctrl/right-click extend, drag motion with edge autoscroll, and the release that finalizes the rect.

use mixdog_term::selection::SelectionRect;
use mixdog_term::{MouseKind, MouseReport};

use super::geometry::{linear_selection, rect_is_degenerate};
use super::state::{AnchorSpan, Drag, LastClick, Point, Region, SpanKind};
use super::{Mouse, MouseHost};

/// A press must land within this long of the previous one to continue a multi-click sequence.
const MULTI_CLICK_MS: u64 = 500;
/// Terminals often report a shifted cell on a repeat click, so up to this many columns and rows of drift still qualify.
const MULTI_CLICK_COLUMN_DRIFT: i32 = 2;
const MULTI_CLICK_ROW_DRIFT: i32 = 1;
/// Rows an edge scroll moves per step.
pub(super) const EDGE_SCROLL_ROWS: f64 = 3.0;

/// `multiClickCount`: the second consecutive press is a word (double click), the third a whole line (triple click). A fourth
/// qualifying press restarts the sequence at one.
fn multi_click_count(last: Option<&LastClick>, x: i32, y: i32, now_ms: u64) -> u32 {
    let Some(last) = last else { return 1 };
    let qualifies =
        now_ms.saturating_sub(last.t_ms) < MULTI_CLICK_MS && (last.y - y).abs() <= MULTI_CLICK_ROW_DRIFT && (last.x - x).abs() <= MULTI_CLICK_COLUMN_DRIFT;
    let count = if qualifies { last.count.max(1) + 1 } else { 1 };
    if count > 3 { 1 } else { count }
}

impl Mouse {
    /// `pressRegion`: the transcript viewport, then the bottom statusline band; `None` anywhere else.
    fn press_region(&self, y: i32) -> Option<Region> {
        if self.is_in_transcript_viewport(y) {
            Some(Region::Transcript)
        } else if self.is_in_status_band(y) {
            Some(Region::Status)
        } else {
            None
        }
    }

    /// `finalizeActiveDrag`: the release path. Pushes the final rect from the given point. Shared by the real release, the
    /// ctrl+wheel zoom passthrough (whose mouse-tracking disable can swallow the release event entirely) and the recovery of a
    /// stuck drag.
    pub fn finalize_active_drag<H: MouseHost + ?Sized>(&mut self, host: &mut H, fx: i32, fy: i32, now_ms: u64) {
        if !self.drag.active {
            return;
        }
        self.stop_edge_autoscroll();
        let region = self.drag.region;
        if region == Some(Region::Prompt) {
            let offset = self.prompt_offset_at(host.prompt(), fx, fy);
            self.drag.active = false;
            if let Some(prompt) = host.prompt() {
                prompt.extend_to(offset, true);
            }
            return;
        }
        let span = self.drag.anchor_span;
        // A release can land outside the region (or outside the window entirely): it snaps the way drag motion does, so the
        // finalized rect matches the highlight the user was looking at.
        let final_point = self.selection_point_in_region(fx, fy, region);
        self.drag.active = false;
        let rect = match span {
            Some(span) => Some(self.build_span_rect(host, span, final_point.x, final_point.y, region, self.drag.anchor_scroll)),
            None => {
                let anchor = self.region_anchor(host, region).unwrap_or(final_point);
                let rect = linear_selection(anchor, final_point);
                (!rect_is_degenerate(&rect)).then_some(rect)
            }
        };
        self.apply_selection_rect(host, rect, now_ms);
    }

    /// Whether the region has something to extend: a word or line anchor span, or a character drag with an anchor and a live,
    /// non-empty rect.
    fn can_extend_selection(&self, region: Region) -> bool {
        let drag = &self.drag;
        if drag.region != Some(region) {
            return false;
        }
        if drag.anchor_span.is_some() {
            return true;
        }
        drag.anchor.is_some() && drag.rect.as_ref().is_some_and(|rect| !rect_is_degenerate(rect))
    }

    /// `extendSelection`: extends the region's selection to the clicked cell and keeps the original anchor: by whole words or
    /// lines from an anchor span, else linearly from the anchor. `active` keeps the drag armed (a shift or ctrl press) or
    /// leaves it one-shot (a right press).
    fn extend_selection<H: MouseHost + ?Sized>(&mut self, host: &mut H, x: i32, y: i32, region: Region, now_ms: u64, active: bool) {
        let selection_y = self.clamp_to_region(y, Some(region));
        let rect = match self.drag.anchor_span {
            Some(span) => self.build_span_rect(host, span, x, selection_y, Some(region), self.drag.anchor_scroll),
            None => {
                let anchor = self.region_anchor(host, Some(region)).unwrap_or(Point { x, y: selection_y });
                linear_selection(anchor, Point { x, y: selection_y })
            }
        };
        host.stop_smooth_scroll();
        self.drag.last = Some(Point { x, y: selection_y });
        self.drag.active = active;
        self.drag.region = Some(region);
        self.apply_selection_rect(host, Some(rect), now_ms);
        self.last_click = Some(LastClick { x, y, t_ms: now_ms, count: 1 });
    }

    /// `onRightPress`: a right-button press extends the existing selection in the pressed region with the logic of the
    /// shift and ctrl paths, but only when there is something extendable there; with nothing to extend it is ignored (no
    /// clear, no drag start).
    fn on_right_press<H: MouseHost + ?Sized>(&mut self, host: &mut H, x: i32, y: i32, now_ms: u64) {
        if self.is_in_prompt_box(x, y) {
            if host.prompt().is_some_and(|prompt| prompt.has_selection()) {
                self.apply_selection_rect(host, None, now_ms);
                let offset = self.prompt_offset_at(host.prompt(), x, y);
                host.stop_smooth_scroll();
                // Right-click extend is a one-shot: applied at once, the drag left inactive so the release cannot finalize.
                self.drag = Drag::pressed(x, y, false, Region::Prompt, 0.0, None);
                if let (Some(offset), Some(prompt)) = (offset, host.prompt()) {
                    prompt.extend_to(Some(offset), true);
                }
                self.last_click = None;
                self.finish_windows_mouse_gesture(host);
            }
            return;
        }
        let Some(region) = self.press_region(y) else { return };
        if !self.can_extend_selection(region) {
            return;
        }
        if let Some(prompt) = host.prompt() {
            prompt.clear();
        }
        self.extend_selection(host, x, y, region, now_ms, false);
        self.finish_windows_mouse_gesture(host);
    }

    /// `onPromptPress`.
    fn on_prompt_press<H: MouseHost + ?Sized>(&mut self, host: &mut H, x: i32, y: i32, extend_held: bool, now_ms: u64) {
        // One highlight is ever visible: the grid selection is cleared.
        self.apply_selection_rect(host, None, now_ms);
        let offset = self.prompt_offset_at(host.prompt(), x, y);
        host.stop_smooth_scroll();
        self.drag = Drag::pressed(x, y, true, Region::Prompt, 0.0, None);
        // Shift+click extends the existing prompt selection (the anchor stays put, the cursor jumps to the click) instead of
        // starting a fresh zero-width anchor at the click point.
        if extend_held && host.prompt().is_some_and(|prompt| prompt.has_selection()) {
            if let (Some(offset), Some(prompt)) = (offset, host.prompt()) {
                prompt.extend_to(Some(offset), true);
            }
            self.last_click = None;
            return;
        }
        // Double click selects a word, triple click a line, with the same qualifying-press window as the transcript.
        let click_count = multi_click_count(self.last_click.as_ref(), x, y, now_ms);
        if let (2 | 3, Some(offset)) = (click_count, offset) {
            if let Some(prompt) = host.prompt() {
                if click_count == 2 {
                    prompt.select_word_at(offset);
                } else {
                    prompt.select_line_at(offset);
                }
            }
            // The click-select is final (the whole word or line is set). The drag is marked inactive so a release does not
            // fall into the prompt release path, which would extend to the release offset and collapse the selection back to
            // anchor and release point.
            self.drag.active = false;
            self.last_click = Some(LastClick { x, y, t_ms: now_ms, count: click_count });
            return;
        }
        if let (Some(offset), Some(prompt)) = (offset, host.prompt()) {
            prompt.anchor_at(offset);
        }
        self.last_click = Some(LastClick { x, y, t_ms: now_ms, count: 1 });
    }

    /// A press outside every selectable region drops the selection of whichever region held one.
    fn on_press_outside_regions<H: MouseHost + ?Sized>(&mut self, host: &mut H, now_ms: u64) {
        self.last_click = None;
        self.drag.active = false;
        self.drag.region = None;
        self.drag.anchor_span = None;
        if let Some(prompt) = host.prompt() {
            prompt.clear();
        }
        self.apply_selection_rect(host, None, now_ms);
        self.finish_windows_mouse_gesture(host);
    }

    /// The word (2 clicks) or line (3) under the cell, recorded as the drag's anchor span so a following drag extends by whole
    /// words or lines from it. The drag stays armed: a release without motion keeps this highlight, any motion extends.
    /// False when the host has no span there and the press falls back to a plain one.
    fn select_word_or_line<H: MouseHost + ?Sized>(
        &mut self,
        host: &mut H,
        at: Point,
        region: Region,
        anchor_scroll: f64,
        click_count: u32,
        now_ms: u64,
    ) -> bool {
        let Point { x, y } = at;
        let kind = if click_count == 2 { SpanKind::Word } else { SpanKind::Line };
        let found = match kind {
            SpanKind::Word => host.word_rect_at(x, y),
            SpanKind::Line => host.line_rect_at(y),
        };
        let Some(found) = found else { return false };
        let lo = Point { x: found.x1, y: found.y1 };
        let hi = Point { x: found.x2, y: found.y2 };
        let rect = linear_selection(lo, hi);
        host.stop_smooth_scroll();
        self.begin_selection(host, region, y);
        self.drag = Drag::pressed(x, y, true, region, anchor_scroll, Some(AnchorSpan { lo, hi, kind }));
        self.apply_selection_rect(host, Some(rect), now_ms);
        self.last_click = Some(LastClick { x, y, t_ms: now_ms, count: click_count });
        true
    }

    /// `onLeftPress`: the region router. A press decides which surface owns the selection: the prompt box first (it overlaps no
    /// transcript rows), then the transcript viewport, then the bottom statusline band. A press anywhere else clears any prior
    /// selection.
    fn on_left_press<H: MouseHost + ?Sized>(&mut self, host: &mut H, x: i32, y: i32, extend_held: bool, now_ms: u64) {
        // A fresh press ends the held-at-edge autoscroll of any prior drag.
        self.stop_edge_autoscroll();
        if self.is_in_prompt_box(x, y) {
            self.on_prompt_press(host, x, y, extend_held, now_ms);
            return;
        }
        let Some(region) = self.press_region(y) else {
            self.on_press_outside_regions(host, now_ms);
            return;
        };
        // A press always clears the prompt box selection (a single active region).
        if let Some(prompt) = host.prompt() {
            prompt.clear();
        }
        // Shift+click extends the existing selection of this same region to the click point: an anchor span extends by whole
        // words or lines, a character drag with a live non-empty rect from its original anchor. An empty or absent selection
        // falls through to a normal fresh press.
        if extend_held && self.can_extend_selection(region) {
            self.extend_selection(host, x, y, region, now_ms, true);
            return;
        }
        // Works for transcript and status rows alike, the word and line rects are grid based. Copy still happens on Ctrl+C.
        let click_count = multi_click_count(self.last_click.as_ref(), x, y, now_ms);
        let anchor_scroll = if region == Region::Transcript { host.scroll_target() } else { 0.0 };
        if (click_count == 2 || click_count == 3) && self.select_word_or_line(host, Point { x, y }, region, anchor_scroll, click_count, now_ms) {
            return;
        }
        self.last_click = Some(LastClick { x, y, t_ms: now_ms, count: 1 });
        // A new selection is anchored here. Nothing is painted yet: a plain single click must not flash a one-cell highlight,
        // the selection renders once a drag extends past the anchor. The status band never scrolls, so its anchor scroll is 0.
        host.stop_smooth_scroll();
        // A fresh character-drag anchor drops the rows read for a prior selection and takes its own row as content.
        self.begin_selection(host, region, y);
        self.drag = Drag::pressed(x, y, true, region, anchor_scroll, None);
    }

    /// `onDragMotion`.
    fn on_drag_motion<H: MouseHost + ?Sized>(&mut self, host: &mut H, x: i32, y: i32, now_ms: u64) {
        let region = self.drag.region;
        if region == Some(Region::Prompt) {
            // The prompt drag extends the prompt selection to the mapped offset: the cell is clamped to the box rows, so a
            // drag outside still tracks the nearest edge of the editable content.
            let offset = self.prompt_offset_at(host.prompt(), x, y);
            self.drag.last = Some(Point { x, y });
            if let (Some(offset), Some(prompt)) = (offset, host.prompt()) {
                prompt.extend_to(Some(offset), false);
            }
            return;
        }
        // A transcript or status drag extends the selection to the current cell snapped into the owning region's band: rows
        // clamp and a pointer outside the band takes that row's start or end column.
        let motion_point = self.selection_point_in_region(x, y, region);
        let previous_y = self.drag.last.map_or(y, |last| last.y);
        self.drag.last = Some(motion_point);
        let rect: SelectionRect = match self.drag.anchor_span {
            // A word or line multi-click drag extends by whole words or lines from the anchor span to the one under the cursor.
            Some(span) => self.build_span_rect(host, span, motion_point.x, motion_point.y, region, self.drag.anchor_scroll),
            None => {
                let anchor = self.region_anchor(host, region).unwrap_or(motion_point);
                linear_selection(anchor, motion_point)
            }
        };
        self.apply_selection_rect_throttled(host, Some(rect), now_ms);
        // Autoscroll while dragging is transcript-only; the status band does not scroll.
        if region != Some(Region::Transcript) {
            return;
        }
        let viewport = self.transcript_viewport();
        let (top, bottom) = (viewport.top as i32, viewport.bottom as i32);
        // The edge autoscroll runs only when the pointer pushes toward the edge: this motion moved vertically toward it, or the
        // pointer sits beyond the viewport rows entirely. A horizontal drag along the top or bottom row must not scroll, it used
        // to scroll away the very rows being selected. The edge is the viewport's own first and last row.
        if y <= top && (y < previous_y || y < top) {
            host.queue_scroll_coalesced(self, EDGE_SCROLL_ROWS);
            self.start_edge_autoscroll(1, now_ms);
        } else if y >= bottom && (y > previous_y || y > bottom) {
            host.queue_scroll_coalesced(self, -EDGE_SCROLL_ROWS);
            self.start_edge_autoscroll(-1, now_ms);
        } else {
            // The pointer moved back inside the viewport (or along an edge row without pushing toward it): the held-at-edge
            // autoscroll halts.
            self.stop_edge_autoscroll();
        }
    }

    /// `routeButtonEvent`: one click, drag or release report.
    pub fn route_button<H: MouseHost + ?Sized>(&mut self, report: &MouseReport, host: &mut H, now_ms: u64) {
        let button = report.button;
        // The terminal counts from 1; the report is already 0-based.
        let (x, y) = (report.col, report.row);
        let press = report.kind != MouseKind::Release;
        // The low two bits are the button id; bit 5 (32) is the motion-while-pressed flag.
        let base_button = button & 3;
        let is_motion = button & 32 != 0;
        // Windows Terminal keeps shift mouse native even when it forwards the event, so the app and terminal selections cannot
        // double-paint.
        if self.cfg.windows_terminal && report.shift {
            return;
        }
        // Ctrl+left-click is the app-side extend trigger (the base button of a ctrl+left press is already 0); the right-button
        // press is the second. This is unrelated to the ctrl+wheel zoom passthrough, which never reaches this code.
        let extend_held = report.shift || report.ctrl;
        if base_button == 2 && press && !is_motion {
            self.on_right_press(host, x, y, now_ms);
        } else if base_button == 0 && press && !is_motion {
            self.on_left_press(host, x, y, extend_held, now_ms);
        } else if base_button == 0 && is_motion && self.drag.active {
            self.on_drag_motion(host, x, y, now_ms);
        } else if !press && base_button == 0 && self.drag.active {
            // A release while dragging finalizes with the release coordinate and keeps the selection visible. Copy is not
            // automatic: Ctrl+C copies, and the highlight stays until Escape or a plain click. A stray right-button release
            // never finalizes. Windows Terminal keeps its native overlay across incremental frames, so it is dismissed once per
            // completed gesture, after the final selection is published.
            self.finalize_active_drag(host, x, y, now_ms);
            self.finish_windows_mouse_gesture(host);
        }
    }
}
