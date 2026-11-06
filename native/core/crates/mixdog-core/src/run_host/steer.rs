//! Steering at model-call boundaries: a read through the session actor's `RunPort::take_steers`,
//! which owns the queue and hands over only entries whose enqueue is durable.

use mixdog_agent::env::DrainRequest;
use mixdog_agent::env::SteerEntry;
use mixdog_agent::env::SteerMode;
use mixdog_agent::env::SteerSource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;

use crate::session::RunPort;
use crate::session::SteerInput;

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

fn content_of(message: &serde_json::Value) -> Content {
    match message {
        serde_json::Value::Array(parts) => Content::Parts(
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .map(|t| ContentPart::Text(t.to_owned()))
                .collect(),
        ),
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
        };
        let entry = entry_of(input);
        assert_eq!(entry.mode, SteerMode::TaskNotification);
        assert_eq!(entry.content, Content::Text("hi".into()));
        assert_eq!(entry.message_id.as_deref(), Some("m1"));
        assert_eq!(entry.ids, ["q1"]);
    }
}

