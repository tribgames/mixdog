//! The main prompt box: the editor and the callbacks it reports to.
//!
//! The editor ([`PromptEditor`]) owns the draft and its key handling. A submit goes through [`crate::slash::on_submit`] (a text-entry
//! prompt, a slash command or a chat message, in that order) and the draft change keeps the prompt state and the layout value in
//! step. The callbacks that need the handlers' host (history, paste, interrupt, queue restore, palette) are the editor's
//! defaults until the prompt handlers are connected.

use mixdog_term::KeyFlags;

use super::AppState;
use crate::editor::{PromptCallbacks, PromptEditor, PromptProps};

/// What the editor reports to the application.
struct Bridge<'a>(&'a mut AppState);

impl PromptCallbacks for Bridge<'_> {
    fn on_submit(&mut self, text: &str) -> bool {
        crate::slash::on_submit(self.0, text)
    }

    fn on_draft_change(&mut self, value: &str) {
        self.0.prompt.draft = value.to_owned();
        self.0.prompt.value = value.to_owned();
        self.0.prompt_layout_value = value.to_owned();
    }
}

impl AppState {
    /// A new editor over an empty draft (`PromptInput`'s mount).
    pub(crate) fn new_editor() -> PromptEditor {
        PromptEditor::new("")
    }

    /// The props the key dispatch reads at event time.
    fn prompt_props(&self) -> PromptProps {
        PromptProps {
            disabled: self.prompt.exit.requested() || !self.chrome.is_ready(),
            raw_mode_supported: true,
            has_messages: self.item_count() > 0,
            ..PromptProps::default()
        }
    }

    /// Whether a surface other than the prompt owns the keys and is not connected to them yet (a text-entry prompt).
    pub fn text_entry_open(&self) -> bool {
        self.provider_prompt.is_some() || self.settings_prompt.is_some()
    }

    /// One key at the prompt box; false when the editor is not available (it is in use further up the stack).
    pub fn prompt_key(&mut self, input: &str, key: &KeyFlags) -> bool {
        let Some(mut editor) = self.editor.take() else { return false };
        let props = self.prompt_props();
        editor.handle_key(input, key, &props, &mut Bridge(self));
        editor.end_input_batch();
        self.draft = editor.draft().clone();
        self.editor = Some(editor);
        true
    }
}
