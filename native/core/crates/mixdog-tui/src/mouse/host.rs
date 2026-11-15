//! What the application provides to the mouse code: the render selection of the terminal layer (`store.setRenderSelection`,
//! `getRenderSelectionText`, `getRenderSelectionRows`, `getWordRectAt`, `getLineRectAt`, `forceRenderRepaint`), the prompt
//! box's selection engine (`promptMouseSelectionRef`), the scroll engine, the slash palette and the clipboard.

use mixdog_term::selection::{CellSpan, SelectedRow, SelectionRect};

use crate::slash::commands::OverlayOwner;

use super::Mouse;

/// The render selection of the terminal layer (`mixdog_term::selection::SelectionState` over the last rendered grid).
pub trait RenderStore {
    /// `getWordRectAt`: the word under a cell of the rendered grid.
    fn word_rect_at(&mut self, x: i32, y: i32) -> Option<CellSpan>;
    /// `getLineRectAt`: the text extent of a rendered row.
    fn line_rect_at(&mut self, y: i32) -> Option<CellSpan>;
    /// `setRenderSelection`: publishes the rect to the renderer (`None` clears the highlight).
    fn set_render_selection(&mut self, rect: Option<&SelectionRect>);
    /// `getRenderSelectionText`: the text under the selection as of the last render.
    fn render_selection_text(&mut self) -> Option<String>;
    /// `getRenderSelectionRows`: the per-row harvest of the last render, read even for a rect that does not capture text.
    fn render_selection_rows(&mut self) -> Option<Vec<SelectedRow>>;
    /// `forceRenderRepaint`: a full clear-and-rewrite that dismisses Windows Terminal's native highlight.
    fn force_render_repaint(&mut self);
}

/// A [`RenderStore`] that also knows where the transcript is scrolled to: the stitch buffer keys rows by it.
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
