//! The caller cancelling a Claude send on Vertex AI, against Node's recordings (`fixtures/provider-wire/
//! vertex-claude-cancel`, recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs`: `opts.signal` aborted,
//! vertex-ai.mjs:507-537). The provider is built by the production builder and sent through the broker, the send path
//! that owns retries and the caller's cancellation, over the recorder's hub. Each step is signalled where Node's was:
//! the held request arriving (before the first byte), the first text delta (mid-stream), the retry announced (the
//! broker's discard before its wait). Compared: every request whole (so no retry fires after the cancel), which
//! connections the client closed, the callbacks in order, and the caller's result (Node's `AbortError` is the
//! broker's `Cancelled`).

use std::sync::Arc;

use mixdog_core_api::domain::provider::StreamEvent;
use tokio_util::sync::CancellationToken;

use crate::admission::Admission;
use crate::admission::AdmissionRequest;
use crate::admission::LaneKey;
use crate::admission::LaneSettings;
use crate::broker::AttemptSink;
use crate::broker::ModelBroker;
use crate::broker::SendError;
use crate::broker::SendRequest;
use crate::providers::anthropic::ModelCaps;
use crate::providers::wire_fixtures::Hub;
use crate::providers::wire_fixtures::Inputs;
use crate::providers::wire_fixtures::assert_minted_bearer;
use crate::providers::wire_fixtures::assert_same_events;
use crate::providers::wire_fixtures::assert_same_requests;
use crate::providers::wire_fixtures::built;
use crate::providers::wire_fixtures::load;
use crate::providers::wire_fixtures::request_of;
use crate::providers::wire_fixtures::scenarios;
use crate::retry::StandardRetryDecider;

/// The caller: keeps the events, and cancels at the scenario's step.
struct Caller {
    events: Vec<StreamEvent>,
    cancel: CancellationToken,
    on_text: bool,
    on_retry: bool,
}

impl AttemptSink for Caller {
    fn event(&mut self, event: StreamEvent) {
        let text = matches!(event, StreamEvent::TextDelta(_));
        self.events.push(event);
        if text && self.on_text {
            self.cancel.cancel();
        }
    }

    fn discard(&mut self) {
        self.events.clear();
        if self.on_retry {
            self.cancel.cancel();
        }
    }
}

#[tokio::test]
async fn a_cancelled_claude_send_ends_as_node_ends_it() {
    let names = scenarios("vertex-claude-cancel");
    assert_eq!(names, ["before-first-byte", "mid-stream", "retry-wait"]);
    for name in names {
        let recorded = load("vertex-claude-cancel", &name);
        let mut hub = Hub::new(&recorded);
        if name == "retry-wait" {
            // The recorder's script: a 529 advising a wait far longer than the run.
            let advice = vec![("content-type".to_owned(), "application/json".to_owned()), ("retry-after-ms".to_owned(), "600000".to_owned())];
            hub = hub.refuse_first(":streamRawPredict", 529, advice);
        }
        // Node's catalog answers for claude-sonnet-4-6: adaptive thinking with effort, 16k output.
        let caps = Arc::new(|_: &str| {
            Some(ModelCaps {
                adaptive_thinking: true,
                manual_thinking: false,
                ladder_stated: false,
                effort_levels: vec!["low".into(), "medium".into(), "high".into()],
                max_output_tokens: Some(16384),
                fast_mode: false,
                context_window: None,
                thinking_display_updates: false,
            })
        });
        let (adapter, _dir) = built(&recorded, hub.clone(), Inputs { caps, ..Inputs::default() }).await;
        let admission = Arc::new(Admission::new());
        let lane = admission.lane(&LaneKey::new("vertex-ai".into(), "default"), LaneSettings::default());
        let broker = ModelBroker::new(admission, Arc::new(StandardRetryDecider));
        let cancel = CancellationToken::new();
        let mut caller = Caller { events: Vec::new(), cancel: cancel.clone(), on_text: name == "mid-stream", on_retry: name == "retry-wait" };
        let send = SendRequest { request: Arc::new(request_of(&recorded)), lane, admission: AdmissionRequest::default() };
        let sending = broker.send(adapter.as_ref(), send, &mut caller, &cancel);
        let sent = if name == "before-first-byte" {
            let (sent, ()) = tokio::join!(sending, async {
                hub.step.notified().await;
                cancel.cancel();
            });
            sent
        } else {
            sending.await
        };
        assert_eq!(recorded.result["error"]["name"], "AbortError", "{name}: Node's caller got an abort");
        assert!(matches!(sent, Err(SendError::Cancelled)), "{name}: {sent:?}");
        let requests = hub.sent();
        assert_same_requests(&requests, &recorded, &[], &name);
        assert_minted_bearer(&requests, &recorded, &name);
        let node_closed: Vec<Option<bool>> =
            recorded.exchange["records"].as_array().expect("records").iter().map(|r| r["closedByClient"].as_bool()).collect();
        assert_eq!(hub.closed(), node_closed, "{name}: connections the client closed");
        assert_same_events(&caller.events, &recorded, &name);
    }
}
