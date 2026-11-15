//! The queued-messages to draft restore (`app/use-prompt-queue-history.mjs` `restoreQueuedToPrompt`,
//! `use-prompt-queue-history/restore-to-prompt.mjs`). Two halves: the publisher, which owns the draft the prompt is currently
//! showing (the optimistic projection first, the service's authoritative text reconciled onto it), and the flow that asks the
//! store to retire the queue and applies the answer.
//!
//! The queue's projection is painted before the service is asked to retire it. A service that answers later
//! ([`Reply::Pending`]) leaves the flow in [`super::state::PromptState::restore_flow`]; [`finish_queued_restore`] applies the
//! answer, so the queued text is never dropped for want of a payload and a delayed answer never replaces newer typing.

use std::collections::BTreeMap;

use mixdog_term::paste::PastedImage;

use crate::editor::draft::Draft;
use crate::editor::helpers::HintTone;
use crate::editor::prompt::DraftOverride;
use crate::editor::restore::{
    merge_queued_restore_draft, queued_restore_prefix, queued_restore_projection, replace_queued_restore_prefix,
};

use super::host::{PromptHost, Reply};

/// The options of a restore (`restoreQueuedToPrompt(options)`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreOptions {
    /// Put the queued text into the draft (default); false retires the queue without touching the draft.
    pub restore_draft: bool,
    /// Report the outcome in the hint band (default).
    pub show_hint: bool,
    /// The text the box shows; the prompt's value when `None`.
    pub current_text: Option<String>,
    /// Read the editor's live draft ([`PromptHost::current_draft`]), now and again when the answer settles: the caller is the
    /// prompt input itself, which knows its caret and selection.
    pub live_draft: bool,
}

impl Default for RestoreOptions {
    fn default() -> Self {
        Self { restore_draft: true, show_hint: true, current_text: None, live_draft: false }
    }
}

/// The answer of `store.restoreQueued`: what was retired.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RestoredQueue {
    pub count: usize,
    pub text: String,
    pub pasted_images: Option<BTreeMap<u64, PastedImage>>,
    pub pasted_texts: Option<BTreeMap<u64, String>>,
    pub notice: Option<String>,
}

/// A restore started and not yet reconciled: what the publisher needs to settle it later.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreFlow {
    restore_draft: bool,
    show_hint: bool,
    live_draft: bool,
    /// The draft the restore started from.
    before: Draft,
    /// The text the optimistic projection put in front of it.
    optimistic_prefix: String,
    /// The draft this flow published last.
    last_published: Draft,
}

/// Publishes `next` into the prompt: the value the prompt reads, its layout rows and the draft override.
fn publish_draft(host: &mut dyn PromptHost, flow: &mut RestoreFlow, next: Draft) {
    host.prompt().value.clone_from(&next.value);
    host.sync_prompt_layout_rows(&next.value);
    let id = host.now_ms();
    host.prompt().publish_override(
        id,
        DraftOverride { value: next.value.clone(), cursor: Some(next.cursor), selection_anchor: next.selection_anchor },
    );
    flow.last_published = next;
}

/// The draft the prompt shows now: the editor's live one when it is current, else the last published one, else the value
/// with the caret at its end.
/// The editor's live draft as the prompt's value holds it: a lone surrogate the editor carries is U+FFFD there (the
/// callbacks give the store that text), and is one UTF-16 unit either way, so the caret and the anchor stay.
fn live_draft(host: &dyn PromptHost) -> Option<Draft> {
    host.current_draft().map(|draft| Draft { value: mixdog_termtext::lone::stored(&draft.value).into_owned(), ..draft })
}

fn current_draft(host: &mut dyn PromptHost, flow: &RestoreFlow) -> Draft {
    let latest = if flow.live_draft { live_draft(host) } else { None };
    let ref_value = host.prompt().value.clone();
    match latest {
        Some(latest) if latest.value == ref_value => latest,
        _ if flow.last_published.value == ref_value => flow.last_published.clone(),
        _ => Draft::at_end(ref_value),
    }
}

/// Swaps the optimistic prefix for the authoritative one; false when the draft no longer starts with it.
fn reconcile(host: &mut dyn PromptHost, flow: &mut RestoreFlow, authoritative_text: &str) -> bool {
    if !flow.restore_draft {
        return true;
    }
    let authoritative_prefix = queued_restore_prefix(authoritative_text, &flow.before.value);
    let current = current_draft(host, flow);
    let next = replace_queued_restore_prefix(&flow.optimistic_prefix, &authoritative_prefix, &current);
    if !next.replaced {
        return false;
    }
    let current_now = current_draft(host, flow);
    let shown = host.prompt().value.clone();
    if next.draft.value != shown
        || next.draft.cursor != current_now.cursor
        || next.draft.selection_anchor != current_now.selection_anchor
    {
        publish_draft(host, flow, next.draft);
    }
    true
}

fn restore_failed(host: &mut dyn PromptHost, flow: &mut RestoreFlow) {
    reconcile(host, flow, "");
    if flow.show_hint {
        host.show_prompt_hint("Could not restore queued messages.", HintTone::Error, None);
    }
}

fn apply(host: &mut dyn PromptHost, flow: &mut RestoreFlow, restored: Option<RestoredQueue>) -> bool {
    let Some(restored) = restored.filter(|restored| restored.count > 0) else {
        reconcile(host, flow, "");
        if flow.show_hint {
            host.show_prompt_hint("No queued messages to restore.", HintTone::Info, None);
        }
        return false;
    };
    if flow.restore_draft {
        let buffers = &mut host.prompt().buffers;
        if let Some(images) = &restored.pasted_images {
            buffers.images.install(images, true);
        }
        if let Some(texts) = &restored.pasted_texts {
            buffers.texts.install(texts, true);
        }
        reconcile(host, flow, &restored.text);
    }
    if flow.show_hint {
        let plural = if restored.count == 1 { "" } else { "s" };
        host.show_prompt_hint(&format!("restored {} queued message{plural}", restored.count), HintTone::Info, None);
    } else {
        host.clear_prompt_hint();
    }
    if let Some(notice) = &restored.notice {
        host.show_prompt_hint(notice, HintTone::Error, None);
    }
    true
}

/// `restoreQueuedToPrompt(options)`: answers whether there were queued messages to restore. With an answer still to come the
/// verdict is that of the published queue and the draft is filled by [`finish_queued_restore`].
pub fn restore_queued_to_prompt(host: &mut dyn PromptHost, options: &RestoreOptions) -> bool {
    let current_text = options.current_text.clone().unwrap_or_else(|| host.prompt().value.clone());
    let projection = queued_restore_projection(&host.queued(), "");
    let queued_count = projection.count;
    if host.prompt().restore_flow.is_some() {
        return queued_count > 0;
    }
    if queued_count == 0 {
        return false;
    }
    let initial = if options.live_draft { live_draft(host) } else { None };
    let before = initial.unwrap_or_else(|| Draft::at_end(current_text));
    let optimistic_draft = merge_queued_restore_draft(&projection.text, &before);
    let optimistic_prefix = queued_restore_prefix(&projection.text, &before.value);
    let mut flow = RestoreFlow {
        restore_draft: options.restore_draft,
        show_hint: options.show_hint,
        live_draft: options.live_draft,
        last_published: before.clone(),
        before,
        optimistic_prefix,
    };
    if flow.restore_draft && !flow.optimistic_prefix.is_empty() {
        publish_draft(host, &mut flow, optimistic_draft);
    }
    match host.restore_queued() {
        Reply::Ready(Err(_)) => {
            restore_failed(host, &mut flow);
            true
        }
        Reply::Ready(Ok(restored)) => apply(host, &mut flow, restored),
        Reply::Pending => {
            host.prompt().restore_flow = Some(flow);
            queued_count > 0
        }
    }
}

/// The answer of a `restoreQueued` that was [`Reply::Pending`].
pub fn finish_queued_restore(host: &mut dyn PromptHost, answer: Result<Option<RestoredQueue>, String>) {
    let Some(mut flow) = host.prompt().restore_flow.take() else { return };
    match answer {
        Ok(restored) => {
            apply(host, &mut flow, restored);
        }
        Err(_) => restore_failed(host, &mut flow),
    }
}
