//! A recorded send's outcome against what left the core's provider layer, field by field through the driver's
//! [`ERROR_FIELDS`](crate::provider_case::ERROR_FIELDS) table: every recorded field is compared as the table maps it,
//! or is one the table declares unread. A field the comparison does not know fails the replay.

use std::time::Duration;

use mixdog_ai::broker::SendError;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_ai::service::error_text::sent_code;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_testkit::Exact;

use crate::provider_case::error_field;
use crate::provider_case::error_field_unread;
use crate::replay_world::Events;

/// What left the provider layer: the error (none for a cancelled send) and the events the sink saw.
pub struct Left<'a> {
    pub error: Option<&'a ProviderError>,
    pub cancelled: bool,
    /// The send ended because a ladder ran out (`SendError::Exhausted`).
    pub exhausted: bool,
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
        Self { error, cancelled, exhausted: matches!(sent, Err(SendError::Exhausted(_))), events: &events.events }
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

    /// The attempt's completed calls in Node's `{id, name, arguments}` shape, in order.
    fn calls(&self) -> Exact {
        Exact::Array(
            self.events
                .iter()
                .filter_map(|e| match e {
                    StreamEvent::ToolCallDone(call) => {
                        Some(Exact::plain(&serde_json::json!({ "id": call.id, "name": call.name, "arguments": call.arguments })))
                    }
                    _ => None,
                })
                .collect(),
        )
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
/// `user` is the recorded error's `userMessage`, the typed copy Node put in the server's text's place.
fn compare_field(what: &str, field: &str, value: &Exact, left: &Left<'_>, user: Option<&str>) {
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
            "GeminiTimeoutError" => assert!(left.error(field).timed_out, "{what}: {mapping}"),
            "TruncatedStreamError" => assert_eq!(left.error(field).transport, Some(TransportFault::TruncatedStream), "{what}: {mapping}"),
            // An error the stream's own frame carried: no transport fault, no timer.
            "GeminiInBandError" => {
                let error = left.error(field);
                assert!(error.transport.is_none() && !error.timed_out, "{what}: {mapping}");
            }
            // A JS class that names no more than an error: its typed meaning is compared through the error's other
            // fields (code, status, flags). A class not listed here fails the replay.
            "Error" | "TypeError" | "SyntaxError" | "StreamInterruptedError" | "MalformedStreamError" | "DevinWireError" | "CallerCancel"
            | "ProviderTimeoutError" | "ProviderIncompleteError" => assert!(left.error.is_some(), "{what}: an error surfaced"),
            other => panic!("{what}: no comparison for the error class {other}"),
        },
        // `sent_code`: the core's own code, `TRUNCATED_STREAM` for a cut stream that names none.
        "code" | "providerErrorCode" | "type" => {
            let sent = sent_code(left.error(field));
            assert_eq!((!sent.is_empty()).then_some(sent.as_str()), opt_str(value), "{what}: {mapping}");
        }
        "truncatedStream" => {
            assert_eq!(left.error(field).transport == Some(TransportFault::TruncatedStream), opt_bool(value), "{what}: {mapping}")
        }
        // A Gemini status names the code (`geminiErrorContract`: the status, lower-cased).
        "geminiStatus" => assert_eq!(left.error(field).code.as_deref(), Some(value.as_str().to_lowercase().as_str()), "{what}: {mapping}"),
        // The RetryInfo delay (`"<n>s"`) is the wait.
        "details" => {
            let delay = value.as_array().iter().find_map(|detail| match detail.try_get("retryDelay") {
                Some(Exact::String(text)) => text.strip_suffix('s').and_then(|n| n.parse::<f64>().ok()),
                _ => None,
            });
            assert_eq!(left.error(field).retry_after, delay.map(|s| Duration::from_millis((s * 1000.0).ceil() as u64)), "{what}: {mapping}");
        }
        // The Anthropic SDK's `error` is the API's whole envelope (`{ type: "error", error: { type, message } }`): its own
        // `type` names the envelope; the inner error's type is the error's code, and its message is in the body text the
        // error's message quotes (that message is compared whole as `message`).
        "error" if value.try_get("type").is_some_and(|t| *t == Exact::String("error".into())) && value.try_get("error").is_some() => {
            let error = left.error(field);
            for (key, _) in value.entries() {
                assert!(matches!(key.as_str(), "type" | "error"), "{what}.{key}: a recorded property this comparison does not read");
            }
            let inner = value.get("error");
            for (key, _) in inner.entries() {
                assert!(matches!(key.as_str(), "type" | "message"), "{what}.error.{key}: a recorded property this comparison does not read");
            }
            assert_eq!(error.code.as_deref(), Some(inner.get("type").as_str()), "{what}.error.type: {mapping}");
            let message = inner.get("message").as_str();
            assert!(error.message.contains(message), "{what}.error.message: {mapping}: {:?} does not carry {message:?}", error.message);
        }
        "error" | "providerError" | "payload" => {
            let error = left.error(field);
            // Every key of the body's error object is one this comparison reads.
            for (key, _) in value.entries() {
                assert!(
                    matches!(key.as_str(), "code" | "status" | "type" | "message" | "details" | "param" | "resets_at"),
                    "{what}.{key}: a recorded property this comparison does not read"
                );
            }
            // A Gemini body names its HTTP status as `code` (the response's status) and its retry advice in `details`.
            if let Some(Exact::Number(status)) = value.try_get("code") {
                assert_eq!(error.status.map(f64::from), Some(*status), "{what}.code: the HTTP status ({mapping})");
            }
            if let Some(details) = value.try_get("details") {
                let delay = details.as_array().iter().find_map(|detail| match detail.try_get("retryDelay") {
                    Some(Exact::String(text)) => text.strip_suffix('s').and_then(|n| n.parse::<f64>().ok()),
                    _ => None,
                });
                assert_eq!(error.retry_after, delay.map(|s| Duration::from_millis((s * 1000.0).ceil() as u64)), "{what}.details: {mapping}");
            }
            // `resets_at`: the reset instant in Unix seconds (`extractErrorReset`), the error's reset time.
            if let Some(at) = value.try_get("resets_at") {
                let reset = error.reset_at.map(|at| at.duration_since(std::time::UNIX_EPOCH).expect("after the epoch").as_millis() as f64);
                assert_eq!(reset, Some(at.as_f64() * 1000.0), "{what}.resets_at: {mapping}");
            }
            if let Some(param) = value.try_get("param").and_then(opt_str) {
                assert_eq!(error.rejected_tool.as_deref(), Some(param), "{what}.param: {mapping}");
            }
            // A Gemini body's error names its HTTP status as `code` and its own code as `status`.
            let code = match value.try_get("code") {
                Some(Exact::Number(_)) => value.try_get("status").map(|s| s.as_str().to_lowercase()),
                other => other.and_then(opt_str).or_else(|| value.try_get("type").and_then(opt_str)).map(str::to_owned),
            };
            let code = code.as_deref();
            assert_eq!(error.code.as_deref(), code, "{what}.code: {mapping}");
            // A Gemini body (its `code` the HTTP status): `geminiRestError` puts the raw body after `<label> <status>: `
            // (its first 300 UTF-16 units), which holds the body's own message as JSON; an in-band error puts the
            // message itself there. The whole message is compared as the error's `message`.
            if let (Some(Exact::Number(_)), Some(message)) = (value.try_get("code"), value.try_get("message")) {
                let shown = serde_json::to_string(message.as_str()).expect("a JSON string");
                assert!(
                    error.message.ends_with(&format!(": {}", message.as_str())) || error.message.contains(&shown),
                    "{what}.message: {mapping}: {:?} carries neither the message nor its body {shown}",
                    error.message
                );
            } else if let Some(message) = value.try_get("message") {
                // `httpResponseError` / `applyTypedWireMessage`: the error's message ends with the body's own message (its
                // first 200 UTF-16 units), or with the typed copy (`userMessage`) that took its place.
                let own = mixdog_js::slice_utf16(message.as_str(), 200);
                let tail = user.map_or(own.as_str(), |copy| copy);
                assert!(error.message.ends_with(tail), "{what}.message: {mapping}: {:?} does not end with {tail:?}", error.message);
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
        "retryAfterMs" => {
            assert_eq!(left.error(field).retry_after, Some(Duration::from_millis(value.as_f64() as u64)), "{what}: {mapping}");
        }
        // The recorded clock's instant of the wait: the wait itself is compared as `retryAfterMs`.
        "retryAfterAt" => assert!(left.error(field).retry_after.is_some(), "{what}: {mapping}"),
        "resetAt" => assert_eq!(
            left.error(field).reset_at.map(|at| at.duration_since(std::time::UNIX_EPOCH).expect("after the epoch").as_millis() as f64),
            Some(value.as_f64()),
            "{what}: {mapping}"
        ),
        "param" => assert_eq!(left.error(field).rejected_tool.as_deref(), opt_str(value), "{what}: {mapping}"),
        "providerWireError" | "responseFailed" => assert!(left.error.is_some() || !opt_bool(value), "{what}: {mapping}"),
        "partialContent" => assert_eq!(left.text(), value.as_str(), "{what}: {mapping}"),
        "partialToolCalls" => match value {
            Exact::Undefined | Exact::Null => crate::provider_case::assert_exact(&format!("{what}: {mapping}"), &Exact::Array(Vec::new()), &left.calls()),
            other => crate::provider_case::assert_exact(&format!("{what}: {mapping}"), other, &left.calls()),
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
        "timeoutPhase" => {
            let phase = match left.error(field).timeout_phase {
                Some(StreamTimeoutPhase::FirstChunk) => Some("first-chunk"),
                Some(StreamTimeoutPhase::Idle) => Some("idle"),
                None => None,
            };
            assert_eq!(phase, opt_str(value), "{what}: {mapping}");
        }
        "firstByteTimeout" => assert_eq!(left.error(field).timed_out, opt_bool(value), "{what}: {mapping}"),
        "streamStalled" => {
            let error = left.error(field);
            let stalled = match &error.transport {
                // A cut after relayed text keeps it (the partial-final stamp): the core keeps the attempt's text.
                Some(TransportFault::TruncatedStream) if !error.timed_out => error.exposure.text_emitted,
                _ => error.timed_out,
            };
            assert_eq!(stalled, opt_bool(value), "{what}: {mapping}");
        }
        "streamOutcome" => compare_outcome(what, value, left),
        // The refusal was the response's own (a status), not a transport fault after it.
        "initialResponseError" => assert_eq!(left.error(field).status.is_some(), opt_bool(value), "{what}: {mapping}"),
        // The parsed body: its error object, compared as the error's `error`.
        "data" => {
            for (key, _) in value.entries() {
                assert_eq!(key, "error", "{what}.{key}: a recorded property this comparison does not read");
            }
            compare_field(&format!("{what}.error"), "error", value.get("error"), left, user);
        }
        "providerRecoveryExhausted" | "providerRecoveryTerminal" => assert_eq!(left.exhausted, opt_bool(value), "{what}: {mapping}"),
        // The socket error under a network failure (`fetch failed`, `terminated`): its code is the core's transport fault.
        "cause" => {
            let Exact::Error { code, .. } = value else { panic!("{what}: a recorded socket error: {value:?}") };
            let socket_code = match left.error(field).transport {
                Some(TransportFault::Connect { os_code: Some(111 | 10061) }) => Some("ECONNREFUSED"),
                Some(TransportFault::Reset) => Some("ECONNRESET"),
                _ => None,
            };
            assert_eq!(socket_code, code.as_deref().map(Exact::as_str), "{what}: {mapping}: {:?}", left.error(field).transport);
        }
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
    let user = props.iter().find(|(field, _)| field == "userMessage").map(|(_, value)| value.as_str());
    compare_field(&format!("{what}.name"), "name", &Exact::String(name.clone()), left, user);
    compare_field(&format!("{what}.message"), "message", &Exact::String(message.clone()), left, user);
    if let Some(code) = code {
        compare_field(&format!("{what}.code"), "code", code, left, user);
    }
    if let Some(cause) = cause {
        compare_field(&format!("{what}.cause"), "cause", cause, left, user);
    }
    for (field, value) in props {
        compare_field(&format!("{what}.{field}"), field, value, left, user);
    }
}
