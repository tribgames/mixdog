//! The scrolled item column of the transcript viewport (`app-view/transcript-viewport/transcript-rows.jsx`) and the viewport
//! around it (`app-view/transcript-viewport.jsx`).
//!
//! The viewport is a bounded box that clips: the explicit height is what lets older rows never overprint newer ones. The
//! newest content is pinned to its bottom edge (`justify-content: flex-end`) and older content overflows the top and is
//! clipped. The item column inside it is as tall as its items and the spacer that holds the scroll coordinate of the older
//! history; a scroll offset of N pushes the whole column N rows down past the bottom edge (the negative bottom margin of the
//! Node column), bringing older rows into view. The rows that trail the column (welcome hint, panel-close mask, overlay hint
//! band, guard band) come after it, still inside the viewport.

use std::sync::Arc;

use mixdog_term::frame::{Rect, Style};
use mixdog_term::paint::Painter;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::transcript::{ItemCtx, render_item};

use super::bands::{paint_hint_cell, paint_welcome_hint_row};
use crate::surface::layout::ShellLayout;
use crate::transcript::window::heights::{HeightParams, ItemHeights, item_id};
use crate::transcript::window::render_window::{RenderWindow, WindowTuning};
use crate::transcript::window::row_index::Items;
use crate::transcript::window::visible_items::OverlayHint;

/// What mounting the items of the window needs.
pub struct MountInput<'a> {
    pub items: &'a Items<'a>,
    pub window: &'a RenderWindow,
    pub layout: &'a ShellLayout,
    pub frame_columns: usize,
    pub tool_output_expanded: bool,
    /// The id of the streaming assistant message, if one is live.
    pub streaming_tail_id: Option<&'a str>,
    pub overlay: &'a OverlayHint,
    /// The clock tool cards derive their blink and elapsed time from, in milliseconds since the epoch.
    pub now_ms: f64,
}

/// The items of the window rendered to lines, with what the column needs to place them.
#[derive(Clone, Debug, Default)]
pub struct MountedRows {
    pub items: Vec<Arc<Vec<Line>>>,
    /// The rows of the items after the window, kept as a spacer under the items.
    pub bottom_spacer_rows: usize,
    /// How far the column is pushed down from the tail, in rows.
    pub scroll_offset: usize,
}

/// `renderTranscriptRows` item by item: every mounted item with the kind of the row above it, the live tail cut to its window
/// while the view is pinned to the tail, and the prompt hint overprinted on the last drawn item when the overlay hint
/// attaches there. The lines of an item are kept by `heights` while nothing that shapes them changed; the item that carries
/// the hint is rendered with it.
pub fn mount_rows(heights: &mut ItemHeights, input: &MountInput<'_>) -> MountedRows {
    let params = HeightParams { columns: input.frame_columns, tool_output_expanded: input.tool_output_expanded };
    let end = input.window.end_index.min(input.items.len());
    let mut items = Vec::with_capacity(end.saturating_sub(input.window.start_index));
    for (offset, at) in (input.window.start_index..end).enumerate() {
        let Some(item) = input.items.get(at) else { continue };
        let prev_kind = input.items.prev_kind(at);
        let attach_hint = input.overlay.on_last_item && input.overlay.attach_item_index == Some(offset);
        let live_tail = input.overlay.tail_pinned && input.streaming_tail_id.is_some() && item_id(item).as_deref() == input.streaming_tail_id;
        let streaming_window_rows = if live_tail { input.layout.transcript_content_height + WindowTuning::current().tail_overscan_rows } else { 0 };
        let lines = if attach_hint {
            let ctx = ItemCtx {
                columns: input.frame_columns,
                prev_kind: prev_kind.map(str::to_owned),
                tool_output_expanded: input.tool_output_expanded,
                right_message: input.layout.input_hint.clone(),
                right_tone: input.layout.input_hint_tone.clone(),
                right_message_width: attach_hint_width(input.layout),
                streaming_window_rows,
                now_ms: input.now_ms,
            };
            Arc::new(render_item(item, &ctx))
        } else {
            heights.lines(item, prev_kind, &params, streaming_window_rows, input.now_ms)
        };
        items.push(lines);
    }
    MountedRows { items, bottom_spacer_rows: input.window.bottom_spacer_rows, scroll_offset: input.window.effective_scroll_offset }
}

/// `guardHintWidth || transientStatusWidth || 24`: the width of the hint cell on the item that carries the hint.
fn attach_hint_width(layout: &ShellLayout) -> f64 {
    [layout.guard_hint_width, layout.transient_status_width].into_iter().find(|width| *width > 0).unwrap_or(24) as f64
}

/// Paints the viewport: `top` is its first row and `height` the rows it ended up with (the layout's, less what the frame had
/// to give back). The bands that trail the item column are positioned from the bottom, as the viewport pins its content
/// there.
pub fn paint_viewport(painter: &mut Painter, top: i32, height: usize, frame_columns: usize, layout: &ShellLayout, overlay: &OverlayHint, rows: &MountedRows) {
    let viewport = Rect::new(0, top.max(0) as u16, frame_columns as u16, height as u16);
    let outer = painter.push_clip(viewport);
    let bands = layout.welcome_prompt_hint_rows + layout.panel_close_mask_rows + layout.overlay_hint_band_rows + layout.transcript_guard_rows;
    let content_height = layout.transcript_content_height;
    // The content box and the bands under it stack from the bottom of the viewport; what does not fit overflows the top.
    let content_top = top + height as i32 - (content_height + bands) as i32;
    paint_item_column(painter, content_top, content_height, frame_columns, rows);
    let mut y = content_top + content_height as i32;
    if layout.welcome_prompt_hint_rows > 0 {
        paint_welcome_hint_row(painter, y, frame_columns, &layout.welcome_prompt_hint_text);
        y += layout.welcome_prompt_hint_rows as i32;
    }
    y += layout.panel_close_mask_rows as i32;
    if layout.overlay_hint_band_rows > 0 {
        paint_hint_cell(painter, frame_columns, y, &layout.input_hint, &layout.input_hint_tone, layout.guard_hint_width);
        y += layout.overlay_hint_band_rows as i32;
    }
    // The guard band shows the hint in its first row when the hint has no item to sit on and no band of its own.
    if layout.transcript_guard_rows > 0 && overlay.fallback_row && layout.overlay_hint_band_rows == 0 {
        paint_hint_cell(painter, frame_columns, y, &layout.input_hint, &layout.input_hint_tone, layout.guard_hint_width);
    }
    painter.pop_clip(outer);
}

/// The item column in a clipping box one row high, holding more rows than that. Yoga does not keep the column's height here
/// the way it does for a box of two rows or more (the column is measured at most one row high, and its items, which can
/// shrink, give up all their content rows): what stays is each item's top margin, the gap above its first content row. The
/// column is then as tall as the margins add up to and, pinned to the bottom edge, starts that many rows above the box's
/// bottom row; an item's content is a text that is still drawn whole from the item's top, and the items overprint each other in
/// order. A content row lands on the box row when the margins of the items after it add up to one: the row shown is the first
/// content row of the item before the last (the second-to-last item's text), as Ink draws it.
fn paint_squeezed_column(painter: &mut Painter, box_top: i32, rows: &MountedRows) {
    let margins: Vec<usize> = rows.items.iter().map(|lines| lines.iter().take_while(|line| line.0.is_empty()).count()).collect();
    let mut after = 0usize;
    let mut tops = vec![0i32; rows.items.len()];
    for (at, margin) in margins.iter().enumerate().rev() {
        tops[at] = 1 - after as i32;
        after += margin;
    }
    for (at, lines) in rows.items.iter().enumerate() {
        for (k, line) in lines.iter().skip(margins[at]).enumerate() {
            let y = tops[at] + k as i32;
            if y == 0 && !line.0.is_empty() {
                painter.line(0, box_top, &without_container_fill(&line.0), Style::default());
            }
        }
    }
}

/// The text of an item's row without the fill of the box around it: a box that keeps no rows paints no background, so the
/// padding before the text stays unpainted and the fill after it is not there (the text keeps its own background).
fn without_container_fill(line: &str) -> String {
    const RESET: &str = "\u{1b}[0m";
    let pieces: Vec<&str> = line.split(RESET).collect();
    let split = |piece: &str| -> (usize, bool) {
        // `\e[...m` then the text: a fill is blank text under a background and no foreground.
        match piece.strip_prefix('\u{1b}').and_then(|rest| rest.find('m').map(|end| (end + 1, &rest[..=end]))) {
            Some((sgr_len, sgr)) => (sgr_len + 1, !piece[sgr_len + 1..].is_empty() && piece[sgr_len + 1..].chars().all(|c| c == ' ') && sgr.contains("48;") && !sgr.contains("38;")),
            None => (0, false),
        }
    };
    let is_text = |piece: &str| !piece.is_empty() && !split(piece).1;
    let (Some(first), Some(last)) = (pieces.iter().position(|piece| is_text(piece)), pieces.iter().rposition(|piece| is_text(piece))) else {
        return line.to_owned();
    };
    let mut out = String::with_capacity(line.len());
    for (at, piece) in pieces.iter().enumerate() {
        let (start, fill) = split(piece);
        if fill && at > last {
            continue;
        }
        if at > 0 {
            out.push_str(RESET);
        }
        out.push_str(if fill && at < first { &piece[start..] } else { piece });
    }
    out
}

/// The column of items in its clipping box: the column's bottom edge is the box's bottom plus the scroll offset.
fn paint_item_column(painter: &mut Painter, box_top: i32, box_height: usize, frame_columns: usize, rows: &MountedRows) {
    // The box may start above the viewport (its top overflows and is clipped): only the part from row 0 is a clip.
    let visible_top = box_top.max(0);
    let visible_height = box_top + box_height as i32 - visible_top;
    if visible_height <= 0 {
        return;
    }
    let clip = Rect::new(0, visible_top as u16, frame_columns as u16, u16::try_from(visible_height).unwrap_or(u16::MAX));
    let outer = painter.push_clip(clip);
    let drawn: usize = rows.items.iter().map(|lines| lines.len()).sum();
    if box_height == 1 && drawn > 1 && rows.scroll_offset == 0 && rows.bottom_spacer_rows == 0 {
        paint_squeezed_column(painter, box_top, rows);
        painter.pop_clip(outer);
        return;
    }
    let column_bottom = box_top + box_height as i32 + rows.scroll_offset as i32;
    let mut y = column_bottom - (drawn + rows.bottom_spacer_rows) as i32;
    for lines in &rows.items {
        for line in lines.iter() {
            painter.line(0, y, &line.0, Style::default());
            y += 1;
        }
    }
    painter.pop_clip(outer);
}
