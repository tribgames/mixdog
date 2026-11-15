//! What the handlers call back into: [`PromptHost`] for the prompt handlers and [`GlobalKeyHost`] for the key handler that runs
//! before the prompt sees a key. The Node hooks received these as an injected bag of refs, setters and store methods; here
//! they are trait methods over the slash host ([`SlashHost`]), so the same functions run in the application and in a test
//! with a recording fake.

use serde_json::Value;

use crate::editor::draft::Draft;
use crate::editor::helpers::HintTone;
use crate::slash::commands::OverlayOwner;
use crate::slash::host::{SlashHost, TextPrompt};
use crate::slash::palette::PaletteItem;
use crate::surface::latch::EnterLatch;
use crate::transcript::window::selection_shift::SelectionRect;

use super::global_keys::{ApprovalDecision, SelectionMove, ToolApproval};
use super::interrupt::InterruptOutcome;
use super::paste::PasteIo;
use super::queue_restore::RestoredQueue;
use super::state::PromptState;

/// A store call that Node answers with a promise. `Pending` means the answer comes later: the owner then calls the matching
/// `finish_*` function ([`super::interrupt::finish_interrupt`], [`super::queue_restore::finish_queued_restore`]) with it.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply<T> {
    Ready(Result<T, String>),
    Pending,
}

/// The application's side of the prompt handlers.
pub trait PromptHost: SlashHost + PasteIo {
    /// The prompt state.
    fn prompt(&mut self) -> &mut PromptState;

    /// `syncPromptLayoutRows(text)`.
    fn sync_prompt_layout_rows(&mut self, text: &str);
    /// `dismissWelcomePromptHint()`.
    fn dismiss_welcome_prompt_hint(&mut self);

    fn usage_panel_open(&self) -> bool;
    fn context_panel_open(&self) -> bool;
    fn btw_panel_open(&self) -> bool;
    /// `closeBtwPanel()`: closes the side panel, cancelling a pending ask.
    fn close_btw_panel(&mut self);
    /// `openMessageSelector()`: whether the selector opened.
    fn open_message_selector(&mut self) -> bool;

    /// `store.getState().busy`.
    fn store_busy(&self) -> bool;
    /// `store.rememberPromptHistory(text)`; the answer of a store that has none is `Ok`.
    fn remember_prompt_history(&mut self, text: &str) -> Result<(), String>;
    /// `store.abortAsync({ restorePrompt: false })` (or `store.abort`). When it is `Pending` the owner calls
    /// [`super::interrupt::finish_interrupt`] with `generation`.
    fn abort(&mut self, generation: u64) -> Reply<Option<InterruptOutcome>>;
    /// `store.restoreQueued('')`. When it is `Pending` the owner calls [`super::queue_restore::finish_queued_restore`].
    fn restore_queued(&mut self) -> Reply<Option<RestoredQueue>>;
    /// `state.queued`: the queued entries the snapshot publishes.
    fn queued(&self) -> Vec<Value>;
    /// The editor's live draft (`getCurrentDraft()` of the prompt input).
    fn current_draft(&self) -> Option<Draft>;
    /// `recentPromptHistory` ([`crate::history::recent_prompt_history`] over the snapshot).
    fn recent_prompt_history(&self) -> Vec<String>;
    /// `slashCommands[slashIndex]`: the palette row selected.
    fn selected_palette_item(&self) -> Option<PaletteItem>;
    /// `pickerOpenedFromEnterRef` and its expiry timer.
    fn enter_latch(&mut self) -> &mut EnterLatch;
    /// `providerPrompt.login.cancel()`, when the prompt has a login.
    fn cancel_provider_login(&mut self, target: &TextPrompt);
    /// `providerPrompt.cancelReturn || providerPrompt.onCancel`: runs it and answers whether the prompt had one.
    fn provider_cancel_return(&mut self, target: &TextPrompt) -> bool;

    /// `showPromptHint(text, tone, dismissMs)`.
    fn show_prompt_hint(&mut self, text: &str, tone: HintTone, dismiss_ms: Option<u64>) {
        let now = self.now_ms();
        self.prompt().hint.show(text, tone, dismiss_ms, now);
    }

    /// `clearPromptHint()`.
    fn clear_prompt_hint(&mut self) {
        self.prompt().hint.clear();
    }
}

/// What the key handler that runs before the prompt reads and moves.
pub trait GlobalKeyHost: PromptHost {
    /// A drag whose release never arrived is settled through the path a real release takes (`settleStuckDrag`).
    fn settle_stuck_drag(&mut self);
    /// The pending tool approval, if any.
    fn tool_approval(&self) -> Option<ToolApproval>;
    /// `store.resolveToolApproval(id, decision)`.
    fn resolve_tool_approval(&mut self, id: &str, decision: ApprovalDecision);
    /// A picker owns the keys.
    fn picker_open(&self) -> bool;
    /// `promptSelectionRef.current?.text`.
    fn prompt_selection_text(&self) -> Option<String>;
    /// `dragRef.current.region`: `prompt`, `transcript` or `status`.
    fn drag_region(&self) -> Option<String>;
    /// `dragRef.current.rect`.
    fn drag_rect(&self) -> Option<SelectionRect>;
    /// Copies `text` to the clipboard; the error is the message to show.
    fn copy_to_clipboard(&mut self, text: &str) -> Result<(), String>;
    /// `copySelection()`: copies the transcript or status grid selection.
    fn copy_selection(&mut self);
    /// `toggleExpand()`.
    fn toggle_expand(&mut self);
    /// `gridSelectionActiveRef.current()`.
    fn grid_selection_active(&self) -> bool;
    /// `moveSelectionFocus(move)`: whether the focus moved (false at an edge).
    fn move_selection_focus(&mut self, direction: SelectionMove) -> bool;
    /// `scrollFocusRef.current`: the overlay that owns scrolling.
    fn scroll_focus(&self) -> OverlayOwner;
    /// `resizeState.rows`.
    fn rows(&self) -> Option<usize>;
    fn scroll_transcript_rows(&mut self, delta: i64);
    fn reset_transcript_scroll(&mut self);
    /// `dragRef.current.active = false; region = null; anchorSpan = null`.
    fn reset_drag(&mut self);
    /// `promptMouseSelectionRef.current?.clear()`.
    fn clear_prompt_mouse_selection(&mut self);
    /// `applySelectionRect(null)`.
    fn clear_selection_rect(&mut self);
    /// `process.platform === 'win32'`.
    fn is_windows(&self) -> bool;
}
