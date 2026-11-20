//! Steering at model-call boundaries: a read through the session actor's `RunPort::take_steers`,
//! which owns the queue and hands over only entries whose enqueue is durable.

use mixdog_agent::env::DrainRequest;
use mixdog_agent::env::SteerEntry;
use mixdog_agent::env::SteerSource;
use mixdog_core_api::domain::provider::Content;

use mixdog_core_session::session::RunPort;
use mixdog_core_session::session::SteerInput;

/// `SteerSource` over the run's port. The drain's priority ceiling picks the entries: a `next`
/// drain leaves `later` entries (queued behind a Sleep) queued, a `later` drain takes all.
pub struct SteerQueue {
    port: RunPort,
}

impl SteerQueue {
    pub fn new(port: RunPort) -> Self {
        Self { port }
    }
}

/// A steered prompt's parts as an ordinary prompt's: the stored-row decoder keeps images, files and stored texts by
/// reference. The session actor hands over an entry only after `prompt_submission::deliverable` decoded its parts (an entry
/// that does not is handed back to its composer, never delivered), so the decode here is the same one, run a second time.
fn content_of(message: &serde_json::Value) -> Content {
    match message {
        serde_json::Value::Array(_) => mixdog_agent::message_row::content_from_value(message).expect("a queued prompt's parts decode as a stored row's"),
        other => Content::Text(other.as_str().unwrap_or_default().to_owned()),
    }
}

fn entry_of(input: SteerInput) -> SteerEntry {
    SteerEntry {
        content: content_of(&input.content),
        text: input.text,
        ids: input.queued_ids.iter().map(|id| id.as_str().to_owned()).collect(),
        submitted_at: input.submitted_at,
        message_id: input.message_id,
        originals_missing: input.originals_missing,
        transcript_meta: input.transcript_meta,
        mode: input.mode,
        execution: input.execution,
    }
}

#[async_trait::async_trait]
impl SteerSource for SteerQueue {
    async fn drain(&self, request: DrainRequest) -> Vec<SteerEntry> {
        match self.port.take_steers(request).await {
            Ok(inputs) => inputs.into_iter().map(entry_of).collect(),
            // A closed run has nothing left to inject.
            Err(_) => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::env::SteerMode;
    use mixdog_core_api::domain::provider::ContentPart;

    use super::*;

    #[test]
    fn a_task_notification_keeps_its_mode_and_text_content() {
        let input = SteerInput {
            queued_ids: vec![mixdog_core_api::ids::QueuedId::from("q1".to_owned())],
            content: serde_json::json!("hi"),
            text: None,
            mode: SteerMode::TaskNotification,
            execution: Some(serde_json::json!({"id": "e1"})),
            submitted_at: None,
            message_id: Some("m1".into()),
            originals_missing: 0,
            transcript_meta: None,
        };
        let entry = entry_of(input);
        assert_eq!(entry.mode, SteerMode::TaskNotification);
        assert_eq!(entry.content, Content::Text("hi".into()));
        assert_eq!(entry.message_id.as_deref(), Some("m1"));
        assert_eq!(entry.ids, ["q1"]);
    }

    #[test]
    fn a_steered_prompt_keeps_its_image_part() {
        let reference = "a".repeat(64);
        let message = serde_json::json!([
            { "type": "text", "text": "look" },
            { "type": "text", "text": "[Image: source: image.png, 587x809, displayed at 587x809]" },
            { "type": "image", "mimeType": "image/png", "attachmentRef": reference, "sizeBytes": 5 },
            { "type": "text" }
        ]);
        // The intake a submit takes, then the drain, the injection and the stored row the transcript keeps.
        let taken = mixdog_core_session::session::prompt_submission::materialize_prompt_submission(
            &mixdog_core_session::session::prompt_submission::NoStore,
            &message,
            &serde_json::Value::Null,
            mixdog_core_session::session::prompt_submission::LongText::Inline,
        )
        .unwrap();
        let entry = SteerEntry {
            content: content_of(&taken.prompt),
            text: None,
            ids: vec!["s1".into()],
            submitted_at: None,
            message_id: None,
            originals_missing: 0,
            transcript_meta: None,
            mode: SteerMode::Prompt,
            execution: None,
        };
        let merged = mixdog_agent::steer::normalize(&entry).expect("an entry that carries content");
        let (injected, _) = mixdog_agent::steer::inject(merged, mixdog_agent::env::DrainStage::PreSend, 1, || "m1".into());
        let stored = mixdog_agent::message_row::message_of(&mixdog_agent::message_row::row_of(&injected)).expect("the stored row decodes");
        for content in [&injected.message.content, &stored.message.content] {
            let Content::Parts(parts) = content else { panic!("parts") };
            assert_eq!(parts.len(), 3);
            assert!(
                matches!(&parts[2], ContentPart::File { source: mixdog_core_api::domain::provider::BinarySource::AttachmentRef(r), .. } if *r == reference)
            );
        }
    }
}
