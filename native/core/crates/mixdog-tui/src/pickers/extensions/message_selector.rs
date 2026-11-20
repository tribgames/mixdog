//! Jump back to a previous message (`src/tui/app/message-selector.mjs`): the list a double Escape from an EMPTY prompt opens
//! while idle.
//!
//! Selecting a row rewinds the conversation to just before that prompt and drops its text back into the input box for editing:
//! the transcript rows and the model-side history after it are undone, so the resubmit continues from exactly that point
//! (engine side: the store's `rewindToItem`).

use mixdog_js::{js_trim, slice_utf16, utf16_len, value_to_string};
use serde_json::{Value, json};

use super::panel::{Action, ExtItem, ExtPanel, ExtensionsHost, Handler, claim, close_now};
use crate::slash::host::Tone;
use crate::slash::notices::{truthy, value_text};

const MAX_SELECTABLE_MESSAGES: usize = 20;
const LABEL_WIDTH: usize = 56;

/// One rewindable prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserMessage {
    pub id: String,
    pub text: String,
}

fn user_text(item: &Value) -> String {
    match item.get("text") {
        Some(text) if truthy(text) => js_trim(&value_text(text)).to_owned(),
        _ => String::new(),
    }
}

/// Whether the transcript holds a user prompt with text (`hasUserMessages`): a double Escape has something to jump to.
pub fn has_user_messages(items: &[Value]) -> bool {
    items.iter().any(|item| item.get("kind").and_then(Value::as_str) == Some("user") && !user_text(item).is_empty())
}

/// The newest-last list of rewindable user prompts, capped for the picker (`selectableUserItems`).
pub fn selectable_user_items(items: &[Value], limit: usize) -> Vec<UserMessage> {
    let mut rows = Vec::new();
    for item in items.iter().rev() {
        if rows.len() >= limit {
            break;
        }
        if item.get("kind").and_then(Value::as_str) != Some("user") {
            continue;
        }
        // Prompts a compaction archived are display-only.
        let id = match item.get("id") {
            None | Some(Value::Null) => continue,
            Some(id) => value_to_string(id),
        };
        if item.get("archived") == Some(&Value::Bool(true)) {
            continue;
        }
        let text = user_text(item);
        if text.is_empty() {
            continue;
        }
        rows.push(UserMessage { id, text });
    }
    rows.reverse();
    rows
}

/// The row label: the first non-blank line, cut to `width` UTF-16 units with an ellipsis (`messageSelectorLabel`).
pub fn message_selector_label(text: &str, width: usize) -> String {
    let first = text.split('\n').map(js_trim).find(|line| !line.is_empty()).unwrap_or("");
    if utf16_len(first) <= width {
        return first.to_owned();
    }
    format!("{}\u{2026}", slice_utf16(first, width.saturating_sub(1).max(1)))
}

/// `openMessageSelector()`: false (with a hint) when there is no message to jump back to.
pub fn open_message_selector(host: &mut dyn ExtensionsHost) -> bool {
    let rows = selectable_user_items(&host.transcript_items(), MAX_SELECTABLE_MESSAGES);
    if rows.is_empty() {
        host.show_prompt_hint("No message to jump back to.", Tone::Info);
        return false;
    }
    let mut own = claim(host);
    let items = rows.iter().map(|row| ExtItem::new(&row.id, &message_selector_label(&row.text, LABEL_WIDTH), "", Action::Noop)).collect();
    let mut panel = ExtPanel::new("Jump back to a message", "Rewind the conversation to a previous prompt and edit it.", items, Handler::MessageSelector)
        .with_kind("message-selector");
    panel.initial_index = rows.len() - 1;
    host.paint(&mut own, Some(panel));
    true
}

/// Enter on a row: closes the selector and rewinds to before that prompt.
pub fn select(host: &mut dyn ExtensionsHost, id: &str) {
    close_now(host);
    match host.store_call("rewindToItem", json!([id, {"restoreFiles": false}])) {
        Ok(restored) => {
            apply_rewind(host, &restored);
        }
        Err(error) => host.show_prompt_hint(&format!("rewind failed: {error}"), Tone::Error),
    }
}

/// What the rewind answered goes back into the prompt: its text as the draft, its pasted blocks so their tokens still expand.
pub fn apply_rewind(host: &mut dyn ExtensionsHost, restored: &Value) -> bool {
    let text = match restored.get("text") {
        Some(text) if truthy(text) => value_text(text),
        _ => String::new(),
    };
    if text.is_empty() {
        host.show_prompt_hint("Could not restore that message.", Tone::Error);
        return false;
    }
    host.clear_prompt_hint();
    if let Some(images) = restored.get("pastedImages").filter(|images| truthy(images)) {
        host.install_pasted_images(images);
    }
    if let Some(texts) = restored.get("pastedTexts").filter(|texts| truthy(texts)) {
        host.install_pasted_texts(texts);
    }
    host.sync_prompt_layout_rows(&text);
    let id = host.now_ms();
    host.set_prompt_draft_override(id, &text);
    if let Some(notice) = restored.get("notice").filter(|notice| truthy(notice)) {
        host.show_prompt_hint(&value_text(notice), Tone::Error);
    }
    true
}
