//! The API-key route's stream up to its first output (`sendWithReplayBeforeOutput`,
//! `providers/lib/replay-before-output.mjs`): Node replays a send whose failure came before any
//! output reached the caller, so the events read until then are held, and an error before them
//! is the adapter's to replay (a rejected version-floor feature, `withAnthropicCapabilityFallback`).

use std::collections::VecDeque;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;

/// Output that reached the caller in Node: a text or reasoning delta, a finished tool call, or
/// stream progress of a visible kind (`isVisibleStreamProgress`: text, reasoning, tool).
fn shows_output(event: &StreamEvent) -> bool {
    let visible = |kind: &ProgressKind| matches!(kind, ProgressKind::Text | ProgressKind::Reasoning | ProgressKind::Tool);
    match event {
        StreamEvent::TextDelta(_) | StreamEvent::ReasoningDelta(_) | StreamEvent::ToolCallDone(_) => true,
        StreamEvent::Progress(kind) | StreamEvent::ChunkProgress(Some(kind)) => visible(kind),
        _ => false,
    }
}

pub(super) struct BeforeOutput {
    held: VecDeque<StreamEvent>,
    failed: Option<ProviderError>,
    rest: Box<dyn ModelStream>,
}

impl BeforeOutput {
    /// Reads `rest` up to and including its first output, its end, or its error.
    pub(super) async fn read(mut rest: Box<dyn ModelStream>) -> Self {
        let mut held = VecDeque::new();
        let mut failed = None;
        while let Some(next) = rest.next().await {
            match next {
                Ok(event) => {
                    let output = shows_output(&event);
                    held.push_back(event);
                    if output {
                        break;
                    }
                }
                Err(err) => {
                    failed = Some(err);
                    break;
                }
            }
        }
        Self { held, failed, rest }
    }

    /// The error the stream ended with before any output.
    pub(super) fn failure(&self) -> Option<&ProviderError> {
        self.failed.as_ref()
    }
}

#[async_trait]
impl ModelStream for BeforeOutput {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if let Some(event) = self.held.pop_front() {
            return Some(Ok(event));
        }
        if let Some(err) = self.failed.take() {
            return Some(Err(err));
        }
        self.rest.next().await
    }

    fn delivery(&self) -> DeliveryState {
        self.rest.delivery()
    }

    fn on_wire_left(&mut self, left: std::sync::Arc<dyn Fn() + Send + Sync>) {
        self.rest.on_wire_left(left);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    use super::*;

    type Left = Arc<dyn Fn() + Send + Sync>;

    /// Keeps the callback it is handed.
    struct Keeps(Arc<Mutex<Option<Left>>>);

    #[async_trait]
    impl ModelStream for Keeps {
        async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
            None
        }
        fn delivery(&self) -> DeliveryState {
            DeliveryState::Accepted
        }
        fn on_wire_left(&mut self, left: Left) {
            *self.0.lock().unwrap() = Some(left);
        }
    }

    /// The stream under it is a leaf today, so the production stacks cannot show this hand-over; the wrapper is held
    /// to it directly.
    #[test]
    fn the_consumers_callback_is_handed_to_the_stream_it_wraps() {
        let handed = Arc::new(Mutex::new(None));
        let mut stream = BeforeOutput { held: VecDeque::new(), failed: None, rest: Box::new(Keeps(Arc::clone(&handed))) };
        let called = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&called);
        stream.on_wire_left(Arc::new(move || flag.store(true, Ordering::SeqCst)));
        let left = handed.lock().unwrap().take().expect("the wrapped stream was handed the callback");
        left();
        assert!(called.load(Ordering::SeqCst), "the callback handed on is the consumer's");
    }
}
