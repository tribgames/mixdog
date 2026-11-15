//! The prompt state the App shares between the prompt input, its handlers, the mouse handler and the layout
//! (`app/use-prompt-state.mjs`). The layout rows (`promptLayoutValueRef`, `setPromptLayoutRows`,
//! `setTextEntryLayoutRows`) are [`crate::surface::prompt_rows::PromptLayoutRows`]; the prompt box's drag selection engine is
//! [`crate::editor::mouse_selection`]; both are reached through [`super::host::PromptHost`].

use crate::editor::prompt::{BoxRect, DraftOverride, SelectionInfo};

use super::exit::ExitFlow;
use super::hint::PromptHint;
use super::history_nav::HistoryNav;
use super::interrupt::InterruptState;
use super::pasted_buffers::PastedBuffers;
use super::queue_restore::RestoreFlow;

/// A draft published into the prompt (`promptDraftOverride`): the id tells a new publication from the previous one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedOverride {
    pub id: u64,
    pub draft: DraftOverride,
}

#[derive(Debug, Default)]
pub struct PromptState {
    /// The draft lifted into the App when it can affect the slash palette (`promptDraft`).
    pub draft: String,
    pub draft_override: Option<PublishedOverride>,
    /// The caret as the prompt reports it (`promptCaret`, `None` = end of the draft); the `$name` palette reads the mention
    /// before it.
    pub caret: Option<i64>,
    /// The text the prompt shows now (`promptValueRef`).
    pub value: String,
    /// The prompt box's selection (`promptSelectionRef`).
    pub selection: Option<SelectionInfo>,
    /// The editable text's absolute rect (`promptBoxRectRef`).
    pub box_rect: Option<BoxRect>,
    pub history_nav: HistoryNav,
    /// The last Up/Down replaced the draft: the next draft change shows no argument hint (`promptHistoryDraftChangeRef`).
    pub history_draft_change: bool,
    pub hint: PromptHint,
    /// The draft whose slash palette the user dismissed (`slashDismissedFor`).
    pub slash_dismissed_for: String,
    pub buffers: PastedBuffers,
    pub interrupt: InterruptState,
    /// The queue restore waiting for its answer (`queuedRestoreInFlightRef`).
    pub restore_flow: Option<RestoreFlow>,
    pub exit: ExitFlow,
}

impl PromptState {
    pub fn new() -> Self {
        Self::default()
    }

    /// `resetPromptHistoryNav()`.
    pub fn reset_history_nav(&mut self) {
        self.history_nav = HistoryNav::idle();
    }

    /// `setPromptDraftOverride({ id: Date.now(), ... })`.
    pub fn publish_override(&mut self, id: u64, draft: DraftOverride) {
        self.draft_override = Some(PublishedOverride { id, draft });
    }
}
