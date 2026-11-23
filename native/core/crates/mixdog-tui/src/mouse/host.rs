//! What the application provides to the mouse code: the render selection of the terminal layer (`store.setRenderSelection`,
//! `getWordRectAt`, `getLineRectAt`, `forceRenderRepaint`), the last frame as content, the prompt box's selection engine
//! (`promptMouseSelectionRef`), the scroll engine, the slash palette and the clipboard.

use mixdog_term::selection::{CellSpan, SelectionRect};

use crate::slash::commands::OverlayOwner;

use super::Mouse;
use super::follow::{DrawnItem, RowText};

/// The render selection of the terminal layer (`mixdog_term::selection::SelectionState` over the last rendered grid).
pub trait RenderStore {
    /// `getWordRectAt`: the word under a cell of the rendered grid.
    fn word_rect_at(&mut self, x: i32, y: i32) -> Option<CellSpan>;
    /// `getLineRectAt`: the text extent of a rendered row.
    fn line_rect_at(&mut self, y: i32) -> Option<CellSpan>;
    /// `setRenderSelection`: publishes the rect to the renderer (`None` clears the highlight).
    fn set_render_selection(&mut self, rect: Option<&SelectionRect>);
    /// `forceRenderRepaint`: a full clear-and-rewrite that dismisses Windows Terminal's native highlight.
    fn force_render_repaint(&mut self);

    // The last painted frame as content ([`super::follow`]). Asked only on behalf of a selection; a host that keeps no frame
    // answers none, and its selections have no place in the content.

    /// The session the frame shows; none before the first frame.
    fn frame_session(&self) -> Option<&str> {
        None
    }
    /// The columns the frame laid its items out in.
    fn frame_columns(&self) -> usize {
        0
    }
    /// The transcript item rendered on screen row `y`, clipped away or not: its index in the transcript and the row inside
    /// the whole item.
    fn content_row_at(&mut self, _y: i32) -> Option<(usize, usize)> {
        None
    }
    /// The id of the item at `index` of the transcript.
    fn item_id_at(&mut self, _index: usize) -> Option<String> {
        None
    }
    /// The index of the item `item`, last seen at `index`; none when the transcript no longer has it.
    fn find_item(&mut self, _item: &str, _index: usize) -> Option<usize> {
        None
    }
    /// The run of items the frame rendered: the index of the first and how many.
    fn drawn_items(&mut self) -> Option<(usize, usize)> {
        None
    }
    /// How the frame rendered the item at `index`; none for an item it did not render.
    fn drawn_item(&mut self, _index: usize) -> Option<DrawnItem> {
        None
    }
    /// What row `row` of the item at `index` reads, the whole row as the item itself renders it (nothing painted over
    /// it); none for a row the frame did not render.
    fn content_row_text(&mut self, _index: usize, _row: usize) -> Option<RowText> {
        None
    }
    /// What rows `lo..=hi` of the whole item at `index` read now, as the item itself renders them: an item the frame did not
    /// render, or not from row `lo`, or with something painted over it, is rendered for them. Fewer rows when the item ends
    /// before `hi`; none for an item that cannot be rendered.
    fn item_rows_text(&mut self, _index: usize, _lo: usize, _hi: usize) -> Option<Vec<RowText>> {
        None
    }
    /// The same rows of an item with cells the clock drives, as they read at a fixed time; none for any other item.
    fn still_rows(&mut self, _index: usize, _lo: usize, _hi: usize) -> Option<Vec<RowText>> {
        None
    }
    /// The text `rect` selects on the frame as painted, for a selection outside the transcript's items.
    fn frame_selection_text(&mut self, _rect: &SelectionRect) -> Option<String> {
        None
    }
}

/// A [`RenderStore`] that also knows where the transcript is scrolled to: a selection made between two frames counts its
/// rows from it.
pub trait SelectionIo: RenderStore {
    /// `scrollTargetRef.current`.
    fn scroll_target(&self) -> f64;
}

/// The prompt box's drag-selection driver (`components/prompt-input/mouse-selection.mjs`), which
/// [`crate::editor::PromptEditor`]'s `mouse_*` methods implement.
pub trait PromptSelection {
    /// `offsetAtCell`: the edit offset of a cell of the content box.
    fn offset_at_cell(&mut self, row: usize, col: usize) -> usize;
    fn has_selection(&mut self) -> bool;
    fn clear(&mut self);
    fn anchor_at(&mut self, offset: usize);
    /// `extendTo`: `None` is a drag outside the box (a release cancels the waiting commit).
    fn extend_to(&mut self, offset: Option<usize>, immediate: bool);
    fn select_word_at(&mut self, offset: usize);
    fn select_line_at(&mut self, offset: usize);
}

/// `slashPaletteRef.current`: whether the slash palette is open and how many rows it lists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SlashPalette {
    pub open: bool,
    pub count: usize,
}

/// The tone of the hint the copy shows in the prompt hint band.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HintTone {
    Plain,
    Error,
}

/// Everything the gestures need from the application.
pub trait MouseHost: SelectionIo {
    /// The prompt box's selection engine, `None` while no prompt is mounted.
    fn prompt(&mut self) -> Option<&mut dyn PromptSelection>;
    /// `stopSmoothScroll`.
    fn stop_smooth_scroll(&mut self);
    /// `queueScrollCoalesced`: the delta joins the leading-edge coalescer. Applying a scroll goes through
    /// [`super::scroll::SelectionScroll`], which needs the mouse state, so the mouse is handed back.
    fn queue_scroll_coalesced(&mut self, mouse: &mut Mouse, rows: f64);
    /// `scrollTranscriptRows`: scroll now by `rows` (positive toward older rows), the selection following.
    fn scroll_transcript_rows(&mut self, mouse: &mut Mouse, rows: f64);
    /// `transcriptBottomSlackRowsRef.current`.
    fn bottom_slack_rows(&self) -> f64;
    /// `slashPaletteRef.current`.
    fn slash_palette(&self) -> SlashPalette;
    /// `scrollFocusRef.current`: what owns the floating area.
    fn overlay_owner(&self) -> OverlayOwner;
    /// `setSlashIndex(index => clamp(index - wheelDir, 0, count - 1))`.
    fn step_slash_index(&mut self, wheel_dir: i32, count: usize);
    /// The ctrl+wheel zoom passthrough: mouse tracking and alternate scroll go off so the terminal zooms its font, and come
    /// back after 700 ms (`mixdog_term::modes::MouseTrackingRestore::passthrough`).
    fn passthrough_ctrl_wheel_zoom(&mut self);
    /// The clipboard write (`mixdog_term::clipboard::copy_to_clipboard`); the error is the message shown to the user.
    fn write_clipboard(&mut self, text: &str) -> Result<(), String>;
    /// `showSelectionCopyHint`: the message in the prompt hint band.
    fn show_selection_copy_hint(&mut self, message: &str, tone: HintTone);
}
