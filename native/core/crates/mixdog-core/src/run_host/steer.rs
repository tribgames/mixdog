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
    let e = &input.entry;
    SteerEntry {
        content: content_of(e.get("message").unwrap_or(&serde_json::Value::Null)),
        text: e.get("text").and_then(|t| t.as_str()).map(str::to_owned),
        ids: vec![input.queued_id.as_str().to_owned()],
        submitted_at: e.get("submittedAt").and_then(|t| t.as_i64()),
        message_id: e.get("messageId").and_then(|t| t.as_str()).map(str::to_owned),
        mode: input.mode,
        execution: input.execution.clone(),
    }
}

#[async_trait::async_trait]
impl SteerSource for SteerQueue {
    async fn drain(&self, request: DrainRequest) -> Vec<SteerEntry> {
        match self.port.take_steers(request.max_priority).await {
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
            queued_id: mixdog_core_api::ids::QueuedId::from("q1".to_owned()),
            entry: serde_json::json!({"message": "hi", "messageId": "m1"}),
            mode: SteerMode::TaskNotification,
            execution: Some(serde_json::json!({"id": "e1"})),
        };
        let entry = entry_of(input);
        assert_eq!(entry.mode, SteerMode::TaskNotification);
        assert_eq!(entry.content, Content::Text("hi".into()));
        assert_eq!(entry.message_id.as_deref(), Some("m1"));
        assert_eq!(entry.ids, ["q1"]);
    }
}

