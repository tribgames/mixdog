//! `handlePromptInterrupt` (`app/prompt-handlers/use-prompt-interrupt.mjs`): Esc interrupts the active turn but never
//! resurrects the submitted prompt on its own. The engine decides (`restoreText` of its answer) and the prompt only restores
//! into an EMPTY draft. An asynchronous abort that settles while the turn is still busy parks its restore until idle; a newer
//! interrupt (generation) invalidates anything parked before it.

use std::collections::BTreeMap;

use mixdog_term::paste::PastedImage;

use crate::editor::interrupt::{InterruptResult, prompt_interrupt_restore_text};
use crate::editor::prompt::DraftOverride;
use crate::slash::host::Tone;

use super::host::{PromptHost, Reply};

/// The answer of `store.abort`: what the engine decided about the interrupted prompt and its attachments.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InterruptOutcome {
    pub result: InterruptResult,
    /// The attachments of the restored prompt (`pastedImages`, `pastedTexts`), installed with the draft.
    pub pasted_images: Option<BTreeMap<u64, PastedImage>>,
    pub pasted_texts: Option<BTreeMap<u64, String>>,
    /// The attachments of the cancelled prompt the engine discards (`discardPastedImages`, `discardPastedTexts`).
    pub discard_pasted_images: Option<BTreeMap<u64, PastedImage>>,
    pub discard_pasted_texts: Option<BTreeMap<u64, String>>,
}

/// A restore parked until the turn is idle.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Parked {
    generation: u64,
    outcome: InterruptOutcome,
}

/// `generationRef` and `pendingRestoreRef`.
#[derive(Debug, Default)]
pub struct InterruptState {
    generation: u64,
    pending: Option<Parked>,
}

impl InterruptState {
    /// The generation of the latest interrupt.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Whether a restore is parked.
    pub fn has_parked_restore(&self) -> bool {
        self.pending.is_some()
    }
}

fn restore_attachments(host: &mut dyn PromptHost, outcome: &InterruptOutcome) {
    let buffers = &mut host.prompt().buffers;
    if let Some(images) = &outcome.pasted_images {
        buffers.images.install(images, true);
    }
    if let Some(texts) = &outcome.pasted_texts {
        buffers.texts.install(texts, true);
    }
}

/// True once the parked restore is settled (applied or obsolete); false while the turn is still busy and it must stay parked.
fn commit_async_restore(host: &mut dyn PromptHost, pending: &Parked) -> bool {
    if pending.generation != host.prompt().interrupt.generation {
        return true;
    }
    if host.store_busy() {
        return false;
    }
    let value = host.prompt().value.clone();
    let restore_text = prompt_interrupt_restore_text(Some(&pending.outcome.result), &value);
    if restore_text.is_empty() {
        return true;
    }
    restore_attachments(host, &pending.outcome);
    host.clear_prompt_hint();
    host.sync_prompt_layout_rows(&restore_text);
    let id = host.now_ms();
    host.prompt().publish_override(id, DraftOverride { value: restore_text, cursor: None, selection_anchor: None });
    true
}

/// The `busy` effect: a parked restore re-checks the store each time the turn's busy flag flips. The owner calls this then.
pub fn on_busy_changed(host: &mut dyn PromptHost) {
    let Some(pending) = host.prompt().interrupt.pending.clone() else { return };
    if commit_async_restore(host, &pending) {
        host.prompt().interrupt.pending = None;
    }
}

fn apply_result(
    host: &mut dyn PromptHost,
    generation: u64,
    outcome: Option<InterruptOutcome>,
    draft_text: &str,
    asynchronous: bool,
) -> Option<String> {
    if generation != host.prompt().interrupt.generation {
        return None;
    }
    let outcome = outcome.unwrap_or_default();
    if outcome.result.aborted == Some(false) {
        return None;
    }
    let buffers = &mut host.prompt().buffers;
    if let Some(discard) = &outcome.discard_pasted_images {
        buffers.images.clear_snapshot(Some(discard));
    }
    if let Some(discard) = &outcome.discard_pasted_texts {
        buffers.texts.clear_snapshot(Some(discard));
    }
    if asynchronous {
        let pending = Parked { generation, outcome };
        if !commit_async_restore(host, &pending) {
            host.prompt().interrupt.pending = Some(pending);
        }
        return None;
    }
    let restore_text = prompt_interrupt_restore_text(Some(&outcome.result), draft_text);
    if restore_text.is_empty() {
        return None;
    }
    restore_attachments(host, &outcome);
    host.clear_prompt_hint();
    Some(restore_text)
}

/// `handlePromptInterrupt(currentText)`: aborts the turn and answers the prompt text to restore into the box, when the answer
/// is synchronous. An asynchronous answer ([`Reply::Pending`]) is applied by [`finish_interrupt`].
pub fn handle_prompt_interrupt(host: &mut dyn PromptHost, current_text: &str) -> Option<String> {
    let state = &mut host.prompt().interrupt;
    state.generation += 1;
    state.pending = None;
    let generation = state.generation;
    match host.abort(generation) {
        Reply::Ready(Err(error)) => {
            host.push_notice(&format!("interrupt failed: {error}"), Tone::Error);
            None
        }
        Reply::Ready(Ok(outcome)) => apply_result(host, generation, outcome, current_text, false),
        Reply::Pending => None,
    }
}

/// The answer of an abort that was [`Reply::Pending`]: the restore waits for an idle turn and goes into the draft the prompt
/// shows by then; a rejection is reported.
pub fn finish_interrupt(host: &mut dyn PromptHost, generation: u64, answer: Result<Option<InterruptOutcome>, String>) {
    match answer {
        Ok(outcome) => {
            let draft = host.prompt().value.clone();
            apply_result(host, generation, outcome, &draft, true);
        }
        Err(error) => host.push_notice(&format!("interrupt failed: {error}"), Tone::Error),
    }
}
