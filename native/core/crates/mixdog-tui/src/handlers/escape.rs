//! `handlePromptEscape` (`app/use-prompt-handlers.mjs`): the owner's side of Escape from the prompt.
//!
//! - prompt-local overlays (the usage, context and `/btw` panels) close first;
//! - active work is cancelled before queue and draft handling (the editor's own interrupt);
//! - an idle non-empty text uses the "Esc again to clear" guard;
//! - an idle empty input restores queued editable messages, and a double press opens the message selector.

use crate::editor::escape::PROMPT_ESCAPE_HINT_TIMEOUT_MS;
use crate::editor::helpers::HintTone;
use crate::editor::prompt::EscapePhase;

use super::host::PromptHost;
use super::queue_restore::{RestoreOptions, restore_queued_to_prompt};

/// Answers whether the key was consumed (for [`EscapePhase::Before`]) or whether the phase did something the editor should
/// know (the other phases only use the answer of `Select` and `Empty`).
pub fn handle_prompt_escape(host: &mut dyn PromptHost, text: &str, phase: EscapePhase) -> bool {
    if host.usage_panel_open() {
        host.close_usage_panel();
        return true;
    }
    // Esc from the prompt: this keypress owns the overlay it closes.
    if host.context_panel_open() {
        host.clear_context_panel();
        return true;
    }
    // The /btw side panel: Esc closes it (cancelling a pending ask) before the turn interrupt or draft handling sees the key.
    if host.btw_panel_open() {
        host.close_btw_panel();
        return true;
    }
    let restore = RestoreOptions { restore_draft: true, show_hint: false, current_text: Some(text.to_owned()), live_draft: false };
    match phase {
        EscapePhase::ClearArm => {
            host.show_prompt_hint("Esc again to clear", HintTone::Plain, Some(PROMPT_ESCAPE_HINT_TIMEOUT_MS));
            true
        }
        EscapePhase::SelectArm => {
            host.show_prompt_hint("Esc again to pick a message", HintTone::Plain, Some(PROMPT_ESCAPE_HINT_TIMEOUT_MS));
            true
        }
        EscapePhase::Select => {
            host.clear_prompt_hint();
            // Queue first: a stale queue projection must not let the selector shadow an editable follow-up still waiting.
            if restore_queued_to_prompt(host, &restore) {
                return true;
            }
            host.open_message_selector()
        }
        EscapePhase::Clear => {
            // Best-effort history parity: a store without the call, or one that fails, changes nothing.
            let _ = host.remember_prompt_history(text);
            let buffers = &mut host.prompt().buffers;
            buffers.images.clear_snapshot(None);
            buffers.texts.clear_snapshot(None);
            host.clear_prompt_hint();
            false
        }
        EscapePhase::Empty => restore_queued_to_prompt(host, &restore),
        // Before the prompt acts with no overlay open, and an idle empty input with no transcript to jump back into.
        EscapePhase::Before => false,
    }
}
