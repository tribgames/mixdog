//! Steering input at model-call boundaries: normalization of one drained
//! entry and the user message it becomes in the transcript.

use mixdog_core_api::domain::provider::Content;
use mixdog_protocol::JsonValue;

use crate::env::DrainStage;
use crate::env::SteerEntry;
use crate::env::SteerInjected;
use crate::env::SteerMode;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::message::content_text;

/// A drained entry after normalization.
#[derive(Clone, PartialEq, Debug)]
pub struct Merged {
    pub content: Content,
    /// Display text of the entry.
    pub text: String,
    pub ids: Vec<String>,
    pub submitted_at: Option<i64>,
    pub message_id: Option<String>,
    pub originals_missing: u32,
    pub transcript_meta: Option<JsonValue>,
    pub task_notification: bool,
    pub execution: Option<JsonValue>,
}

/// Trims string content, drops an entry that carries nothing, and keeps the
/// ids (unique, in order) and submission time. A task notification keeps its
/// execution provenance; any other entry is the user's turn.
pub fn normalize(entry: &SteerEntry) -> Option<Merged> {
    let (content, text) = match &entry.content {
        Content::Text(raw) => {
            let value = mixdog_js::js_trim(raw);
            if value.is_empty() {
                return None;
            }
            let text = entry.text.as_deref().map(mixdog_js::js_trim).unwrap_or(value);
            let text = if text.is_empty() { value } else { text };
            (Content::Text(value.to_owned().into()), text.to_owned())
        }
        Content::Parts(parts) => {
            if parts.is_empty() {
                return None;
            }
            let text = match entry.text.as_deref() {
                Some(text) => mixdog_js::js_trim(text).to_owned(),
                None => mixdog_js::js_trim(&content_text(&entry.content)).to_owned(),
            };
            (entry.content.clone(), text)
        }
    };
    let mut ids: Vec<String> = Vec::new();
    for id in &entry.ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    let task_notification = entry.mode == SteerMode::TaskNotification;
    Some(Merged {
        content,
        text,
        ids,
        submitted_at: entry.submitted_at.filter(|at| *at > 0),
        message_id: entry.message_id.clone(),
        originals_missing: entry.originals_missing,
        transcript_meta: entry.transcript_meta.clone(),
        task_notification,
        execution: task_notification.then(|| entry.execution.clone()).flatten(),
    })
}

/// The transcript message and the event for one merged entry. A task
/// notification keeps the user role the wire needs but is stored under its own
/// source, so envelope classification never mistakes it for typed input.
pub fn inject(merged: Merged, stage: DrainStage, injected_at: i64, fresh_message_id: impl FnOnce() -> String) -> (AgentMessage, SteerInjected) {
    let message_id = merged.message_id.clone().unwrap_or_else(fresh_message_id);
    let source = if merged.task_notification { Source::TaskNotification } else { Source::Steering };
    let text = if merged.text.is_empty() { content_text(&merged.content) } else { merged.text.clone() };
    let mut message = AgentMessage::user_content(merged.content);
    message.source = Some(source);
    // A notification's row keeps its execution provenance after `source` (`steering.mjs:165-170`); the message
    // type has no field for it, so it rides the row the message is written over.
    if let Some(execution) = merged.execution.clone() {
        let mut row = crate::message_row::row_of(&message);
        row["meta"]["execution"] = execution;
        message = crate::message_row::message_of(&row).expect("the row the message wrote decodes");
    }
    message.submission_ids = merged.ids.clone();
    message.message_id = Some(message_id.clone());
    message.originals_missing = merged.originals_missing;
    message.transcript_meta = merged.transcript_meta.clone();
    let event = SteerInjected {
        text,
        ids: merged.ids,
        submitted_at: merged.submitted_at,
        injected_at,
        stage,
        task_notification: merged.task_notification,
        execution: merged.execution,
        message_id,
    };
    (message, event)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(text: &str) -> SteerEntry {
        SteerEntry {
            content: Content::Text(text.into()),
            text: None,
            ids: vec!["a".into(), "a".into(), "b".into()],
            submitted_at: Some(0),
            message_id: None,
            originals_missing: 0,
            transcript_meta: None,
            mode: SteerMode::Prompt,
            execution: None,
        }
    }

    /// The entry's `transcriptMeta` rides on the message it becomes: its row stores it in `meta.transcript`, beside the
    /// message id, and an entry without one stores nothing of it.
    #[test]
    fn the_entrys_transcript_meta_is_stored_on_the_message_it_becomes() {
        let mut bot = entry("look");
        bot.transcript_meta = Some(serde_json::json!({ "sender": "bot", "hop": 2 }));
        let (message, _) = inject(normalize(&bot).unwrap(), DrainStage::PreSend, 5, || "m1".into());
        let transcript = &crate::message_row::row_of(&message)["meta"]["transcript"];
        assert_eq!((transcript["sender"].clone(), transcript["hop"].clone(), transcript["messageId"].clone()), ("bot".into(), 2.into(), "m1".into()));
        let (plain, _) = inject(normalize(&entry("look")).unwrap(), DrainStage::PreSend, 5, || "m2".into());
        assert!(crate::message_row::row_of(&plain)["meta"]["transcript"].get("sender").is_none());
    }

    /// The count the core computed for an entry is part of the message it becomes: its row records it, and an entry
    /// that lost nothing records nothing.
    #[test]
    fn the_cores_count_of_missing_originals_is_recorded_on_the_message_it_becomes() {
        let mut lost = entry("look");
        lost.originals_missing = 2;
        let (message, _) = inject(normalize(&lost).unwrap(), DrainStage::PreSend, 5, || "m1".into());
        assert_eq!(crate::message_row::row_of(&message)["meta"]["transcript"]["originalImagesMissing"], 2);
        let (message, _) = inject(normalize(&entry("look")).unwrap(), DrainStage::PreSend, 5, || "m2".into());
        assert!(crate::message_row::row_of(&message)["meta"]["transcript"].get("originalImagesMissing").is_none());
    }

    #[test]
    fn blank_entries_are_dropped_and_ids_deduplicated() {
        assert!(normalize(&entry("  \n")).is_none());
        let merged = normalize(&entry("  fix it ")).unwrap();
        assert_eq!(merged.content, Content::Text("fix it".into()));
        assert_eq!(merged.text, "fix it");
        assert_eq!(merged.ids, vec!["a".to_owned(), "b".to_owned()]);
        assert_eq!(merged.submitted_at, None);
    }

    /// The display text is trimmed as `String#trim` does: a byte-order mark goes, a next-line character stays.
    #[test]
    fn the_display_text_is_trimmed_by_javascript_rules() {
        let mut task = entry("body");
        task.text = Some("\u{feff} shown \u{85}".into());
        assert_eq!(normalize(&task).unwrap().text, "shown \u{85}");
    }

    #[test]
    fn notification_is_stored_under_its_own_source() {
        let mut task = entry("done");
        task.mode = SteerMode::TaskNotification;
        task.execution = Some(JsonValue::from("shell"));
        let (message, event) = inject(normalize(&task).unwrap(), DrainStage::PreSend, 5, || "m1".into());
        assert_eq!(message.source, Some(Source::TaskNotification));
        assert!(event.task_notification);
        assert_eq!(event.message_id, "m1");
        assert_eq!(event.execution, Some(JsonValue::from("shell")));
    }
}
