//! A recorded send's outcome against what left the core's provider layer, field by field through the driver's
//! [`ERROR_FIELDS`](crate::provider_case::ERROR_FIELDS) table: every recorded field is compared as the table maps it,
//! or is one the table declares unread. A field the comparison does not know fails the replay.

use std::time::Duration;

use mixdog_ai::broker::SendError;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_testkit::Exact;

use crate::provider_case::error_field;
use crate::provider_case::error_field_unread;
use crate::replay_world::Events;

/// What left the provider layer: the error (none for a cancelled send) and the events the sink saw.
pub struct Left<'a> {
    pub error: Option<&'a ProviderError>,
    pub cancelled: bool,
    pub events: &'a [StreamEvent],
}

impl<'a> Left<'a> {
    pub fn of(sent: &'a Result<u32, SendError>, events: &'a Events) -> Self {
        let (error, cancelled) = match sent {
            Ok(_) => (None, false),
            Err(SendError::Cancelled) => (None, true),
            Err(SendError::Provider(e) | SendError::Exhausted(e) | SendError::Fallback { last: e, .. }) => (Some(e), false),
            Err(SendError::Admission(e)) => panic!("the send was not admitted: {e:?}"),
        };
        Self { error, cancelled, events: &events.events }
    }

    fn text(&self) -> String {
        self.events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::TextDelta(t) => Some(t.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled
    }

    /// The stream reached its terminal event.
    fn terminal(&self) -> bool {
        self.events.iter().any(|e| matches!(e, StreamEvent::Completed { .. }))
    }

    fn calls_done(&self) -> usize {
        self.events.iter().filter(|e| matches!(e, StreamEvent::ToolCallDone(_))).count()
    }

    fn text_emitted(&self) -> bool {
        self.error.map_or(!self.text().is_empty(), |e| e.exposure.text_emitted)
    }

    fn tool_input_cut(&self) -> bool {
        self.error.is_some_and(|e| e.exposure.tool_input_cut)
    }

    fn tool_dispatched(&self) -> bool {
        self.error.is_some_and(|e| e.exposure.tool_dispatched)
    }

    /// Re-sending is unsafe: Node's `replayUnsafe` / `unsafeToRetry`.
    fn replay_unsafe(&self) -> bool {
        match self.error {
            Some(e) => e.unsafe_to_retry || e.exposure.text_emitted || e.exposure.tool_dispatched || e.exposure.tool_input_cut,
            None => self.cancelled && !self.text().is_empty(),
        }
    }

    fn error(&self, field: &str) -> &ProviderError {
        self.error.unwrap_or_else(|| panic!("{field}: Node's error carries it, the core surfaced no error"))
    }
}

fn opt_str(value: &Exact) -> Option<&str> {
    match value {
        Exact::Undefined | Exact::Null => None,
        other => Some(other.as_str()),
    }
}

fn opt_bool(value: &Exact) -> bool {
    match value {
        Exact::Undefined | Exact::Null => false,
        other => other.as_bool(),
    }
}

/// The `retry-after` a recorded response head names (seconds), the wait the core holds as `retry_after`.
fn retry_after_of(headers: &Exact) -> Option<Duration> {
    let pairs = match headers.try_get("headers") {
        Some(inner) => inner.as_array().to_vec(),
        None => headers.entries().iter().map(|(k, v)| Exact::Array(vec![Exact::String(k.clone()), v.clone()])).collect(),
    };
    pairs.iter().find_map(|pair| {
        let pair = pair.as_array();
        pair[0].as_str().eq_ignore_ascii_case("retry-after").then(|| Duration::from_secs(pair[1].as_str().trim().parse().expect("seconds")))
    })
}

/// One recorded field against what left the provider layer; `what` names it in a failure.
fn compare_field(what: &str, field: &str, value: &Exact, left: &Left<'_>) {
    if error_field_unread(field) {
        return;
    }
    let mapping = error_field(field);
    match field {
        "message" if left.cancelled => assert_eq!(value.as_str(), "caller cancellation", "{what}: the caller's abort reason"),
        "message" => assert_eq!(left.error(field).message, value.as_str(), "{what}: {mapping}"),
        "name" => match value.as_str() {
            "AbortError" => assert!(left.cancelled, "{what}: an AbortError is the caller's cancel"),
            "StreamStalledError" | "AgentStallAbortError" => assert!(left.error(field).timed_out, "{what}: {mapping}"),
            _ => assert!(left.error.is_some(), "{what}: an error surfaced"),
        },
        "code" | "providerErrorCode" | "type" => assert_eq!(left.error(field).code.as_deref(), opt_str(value), "{what}: {mapping}"),
        "error" | "providerError" | "payload" => {
            let error = left.error(field);
            let code = value.try_get("code").and_then(opt_str).or_else(|| value.try_get("type").and_then(opt_str));
            assert_eq!(error.code.as_deref(), code, "{what}.code: {mapping}");
            if let Some(message) = value.try_get("message") {
                assert_eq!(error.message, message.as_str(), "{what}.message: {mapping}");
            }
        }
        "status" | "httpStatus" => {
            let want = match value {
                Exact::Undefined | Exact::Null => None,
                other => Some(other.as_f64() as u16),
            };
            assert_eq!(left.error(field).status, want, "{what}: {mapping}");
        }
        "headers" => assert_eq!(left.error(field).retry_after, retry_after_of(value), "{what}: {mapping}"),
        "param" => assert_eq!(left.error(field).rejected_tool.as_deref(), opt_str(value), "{what}: {mapping}"),
        "providerWireError" | "responseFailed" => assert!(left.error.is_some() || !opt_bool(value), "{what}: {mapping}"),
        "partialContent" => assert_eq!(left.text(), value.as_str(), "{what}: {mapping}"),
        "partialToolCalls" => match value {
            Exact::Undefined | Exact::Null => assert_eq!(left.calls_done(), 0, "{what}: {mapping}"),
            other => assert_eq!(left.calls_done(), other.as_array().len(), "{what}: {mapping}"),
        },
        "pendingToolUse" | "partialToolCall" | "partialToolCallStarted" => assert_eq!(left.tool_input_cut(), opt_bool(value), "{what}: {mapping}"),
        "partialModel" => assert_eq!(left.error(field).partial_model.as_deref(), opt_str(value), "{what}: {mapping}"),
        "partialUsage" => {
            let usage = left.error(field).partial_usage.as_deref();
            match value {
                Exact::Undefined | Exact::Null => assert!(usage.is_none(), "{what}: {mapping}"),
                recorded => {
                    let usage = usage.unwrap_or_else(|| panic!("{what}: {mapping}: the core reported none"));
                    let n = |k: &str| recorded.get(k).as_f64() as u64;
                    assert_eq!(
                        (usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens),
                        (n("inputTokens"), n("outputTokens"), n("cachedTokens"), n("cacheWriteTokens")),
                        "{what}: {mapping}"
                    );
                }
            }
        }
        "liveTextEmitted" | "emittedText" => assert_eq!(left.text_emitted(), opt_bool(value), "{what}: {mapping}"),
        "emittedToolCall" | "toolCallEmitted" => assert_eq!(left.tool_dispatched(), opt_bool(value), "{what}: {mapping}"),
        "unsafeToRetry" => assert_eq!(left.replay_unsafe(), opt_bool(value), "{what}: {mapping}"),
        "streamStalled" | "firstByteTimeout" => assert_eq!(left.error(field).timed_out, opt_bool(value), "{what}: {mapping}"),
        "streamOutcome" => compare_outcome(what, value, left),
        other => panic!("{what}: no comparison for {other} ({mapping})"),
    }
}

/// `readStreamOutcome` of the recorded error against what left the provider layer.
pub fn compare_outcome(what: &str, outcome: &Exact, left: &Left<'_>) {
    for (field, value) in outcome.entries() {
        let key = format!("streamOutcome.{field}");
        if error_field_unread(&key) {
            continue;
        }
        let mapping = error_field(&key);
        let what = format!("{what}.{field}");
        let flag = || value.as_bool();
        match field.as_str() {
            "textEmitted" => assert_eq!(left.text_emitted(), flag(), "{what}: {mapping}"),
            "replayUnsafe" => assert_eq!(left.replay_unsafe(), flag(), "{what}: {mapping}"),
            "replaySafe" => assert_eq!(!left.replay_unsafe() && !left.cancelled, flag(), "{what}: {mapping}"),
            "userAbort" => assert_eq!(left.cancelled, flag(), "{what}: {mapping}"),
            "successEligible" => assert_eq!(left.terminal() && !left.tool_input_cut(), flag(), "{what}: {mapping}"),
            "terminalObserved" => assert_eq!(left.terminal(), flag(), "{what}: {mapping}"),
            // `_finalize`: a stream that saw no terminal frame is a continuation (no frame here declares one).
            "continuation" => assert_eq!(!left.terminal(), flag(), "{what}: {mapping}"),
            // A cut with no typed cause: transient, no code, status or transport fault, no timer.
            "truncatedStream" => assert_eq!(
                left.error.is_some_and(|e| e.kind == mixdog_core_api::domain::provider::ErrorKind::Transient
                    && e.code.is_none()
                    && e.status.is_none()
                    && e.transport.is_none()
                    && !e.timed_out),
                flag(),
                "{what}: {mapping}"
            ),
            "pendingToolInput" | "toolCallsStarted" => assert_eq!(left.tool_input_cut(), flag(), "{what}: {mapping}"),
            "toolCallsComplete" => assert_eq!(left.calls_done() as f64, value.as_f64(), "{what}: {mapping}"),
            "toolCallsDispatched" => assert_eq!(left.tool_dispatched(), value.as_f64() > 0.0, "{what}: {mapping}"),
            "sideEffectDispatched" => assert_eq!(left.tool_dispatched(), flag(), "{what}: {mapping}"),
            "dispatchAmbiguous" => assert_eq!(
                left.error.is_some_and(|e| e.exposure.tool_dispatched && e.delivery == mixdog_core_api::domain::provider::DeliveryState::Ambiguous),
                flag(),
                "{what}: {mapping}"
            ),
            "stallObserved" => assert_eq!(left.error.is_some_and(|e| e.timed_out), flag(), "{what}: {mapping}"),
            "reasoningEmitted" => {
                let reasoning = left.events.iter().any(|e| matches!(e, StreamEvent::ReasoningDelta(_)));
                assert_eq!(reasoning, flag(), "{what}: {mapping}");
            }
            // `_finalize`: visible text or reasoning, observed text, a complete call or a dispatched one.
            "observedOutput" => {
                let reasoning = left.events.iter().any(|e| matches!(e, StreamEvent::ReasoningDelta(_)));
                let observed = left.text_emitted() || reasoning || left.calls_done() > 0 || left.tool_dispatched();
                assert_eq!(observed, flag(), "{what}: {mapping}");
            }
            other => panic!("{what}: no comparison for streamOutcome.{other} ({mapping})"),
        }
    }
}

/// A recorded error (an `Exact::Error`) against what left the provider layer, every field.
pub fn compare_error(what: &str, recorded: &Exact, left: &Left<'_>) {
    let Exact::Error { name, message, code, cause, props } = recorded else { panic!("{what}: not a recorded error: {recorded:?}") };
    compare_field(&format!("{what}.name"), "name", &Exact::String(name.clone()), left);
    compare_field(&format!("{what}.message"), "message", &Exact::String(message.clone()), left);
    if let Some(code) = code {
        compare_field(&format!("{what}.code"), "code", code, left);
    }
    if let Some(cause) = cause {
        compare_field(&format!("{what}.cause"), "cause", cause, left);
    }
    for (field, value) in props {
        compare_field(&format!("{what}.{field}"), field, value, left);
    }
}
