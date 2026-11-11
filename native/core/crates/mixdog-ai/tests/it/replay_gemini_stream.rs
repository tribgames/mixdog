//! `provider-gemini-stream`: `consumeGeminiRestStreamResponse` (and `createGeminiTextLeakGuard`) over a real response.
//! The production `ReqwestLink` posts the recorder's own fetch to the driver's endpoint, which serves the case's
//! scripted chunks (each its own write); the body goes through the core's consumer (`GoogleStream::consume`, the
//! stream every Gemini-wire route builds) with the core's `GeminiDecoder` under the recorded `label`, the recorded
//! `firstByteTimeoutMs` (else `GEMINI_FIRST_BYTE_TIMEOUT_MS`) and the idle window, the recorded clock steps run while it
//! waits. The
//! recorder's result is compared against the core's events: `progress` is every
//! `onStreamDelta` of the consumer (`ChunkProgress`; the recorded guard had no `onStreamDelta`), `text` every
//! `onTextDelta` (`TextDelta`), `dispatched` the guard's `onToolCall` (`ToolCallDone`), the error through the
//! driver's `ERROR_FIELDS`.
//!
//! The aggregated `response` is compared field by field as the shared `RESULT_FIELDS` maps each field (its parts whole,
//! its finish as the core's stop), its other fields declared not compared by the manifest; `leakedToolCalls` is the
//! decoder's recovered calls ([`GeminiDecoder::recovered_calls`]), whole; the error through `ERROR_FIELDS`. No recorded
//! value stands in for a core one, and a recorded key no comparison reads fails the case. The recorder's fetch
//! (`requests[0]`) is the harness's own POST, not a product request: it is not compared.

use std::collections::HashSet;

use mixdog_ai::providers::google::decode::DecodeDialect;
use mixdog_ai::providers::google::decode::GeminiDecoder;
use mixdog_ai::providers::google::decode::UsageStyle;
use mixdog_ai::providers::google::error::ErrorDialect;
use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::ReqwestLink;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_ai::providers::google::StreamWatch;
use mixdog_ai::providers::google::adapter::GoogleStream;
use std::time::Duration;
use mixdog_protocol::ProviderId;
use mixdog_testkit::Exact;
use mixdog_testkit::provider_fields::result_field;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::assert_exact;
use crate::provider_case::plain;
use crate::provider_case::within;
use crate::replay_errors::Left;
use crate::replay_errors::compare_error;

const SET: &str = "gemini-stream";

fn progress_name(kind: Option<ProgressKind>) -> &'static str {
    match kind {
        Some(ProgressKind::Text) => "text",
        Some(ProgressKind::Reasoning) => "reasoning",
        Some(ProgressKind::Tool) => "tool",
        None => "transport",
        Some(other) => panic!("a Gemini chunk reports no {other:?}"),
    }
}

/// The served body through the decoder: every event, the error that ended it, and the calls the guard recovered.
async fn consume(set: &CaseSet, id: &str) -> (Vec<StreamEvent>, Option<ProviderError>, Vec<mixdog_core_api::domain::provider::ToolCall>) {
    let case = set.case(id);
    let endpoint = Endpoint::start().await;
    endpoint.serve(case);
    let recorded = &case.requests[0];
    let request = WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: format!("{}{}", recorded.get("origin").as_str(), recorded.get("path").as_str()),
        headers: vec![("content-type".into(), "application/json".into())],
        body: b"{}".to_vec(),
    };
    let link = endpoint.link(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the production link"));
    let response =
        within("the scripted answer", link.send(request, mixdog_ai::transport::deadlines::MODEL_STREAM)).await.expect("answered");
    let options = case.args_of("consumeGeminiRestStreamResponse", 0)[1].clone();
    let label: &'static str = Box::leak(options.get("label").as_str().to_owned().into_boxed_str());
    let mut decoder = GeminiDecoder::new(DecodeDialect {
        owner: ProviderId::from("gemini"),
        envelope: false,
        usage: UsageStyle::Inclusive,
        errors: ErrorDialect::gemini(label),
    });
    let at = endpoint.wall_now();
    decoder = decoder.with_clock(move || at);
    if let Some(guard) = case.calls.iter().find(|c| c.entry.ends_with("createGeminiTextLeakGuard")) {
        let options = &guard.args[0];
        assert!(options.get("deferToolCalls").as_bool(), "{id}: the core's guard defers its calls");
        let names: HashSet<String> = options.get("knownToolNames").as_array().iter().map(|n| n.as_str().to_owned()).collect();
        decoder = decoder.with_known_tools(names);
    }
    let recovered = decoder.recovered_calls();
    // `firstByteTimeoutMs` as handed in, else `GEMINI_FIRST_BYTE_TIMEOUT_MS` of the recorder's scrubbed environment.
    let window = match options.try_get("firstByteTimeoutMs") {
        Some(Exact::Number(ms)) => *ms,
        _ => mixdog_ai::providers::google::cache::policy::gemini_first_byte_ms(|_| None),
    };
    // The idle window of the recorder's scrubbed environment (`PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS`).
    let idle = mixdog_ai::providers::google::cache::policy::semantic_idle_ms(|_| None).map(|ms| Duration::from_millis(ms as u64));
    let watch = StreamWatch { first_byte: Duration::from_millis(window as u64), idle, idle_after_first_chunk: false, label };
    let mut stream = GoogleStream::consume(response.body, Box::new(decoder), Some(watch));
    // The window is armed: the recorded clock steps run while the consumer waits.
    let collect = async move {
        let mut events = Vec::new();
        while let Some(item) = stream.next().await {
            match item {
                Ok(event) => events.push(event),
                Err(error) => return (events, Some(error)),
            }
        }
        (events, None)
    };
    let clock = async {
        for step in &case.clock {
            endpoint.advance(step).await;
        }
    };
    let ((events, error), ()) = within("the consumer to end", async { tokio::join!(collect, clock) }).await;
    endpoint.assert_clock(case);
    let recovered = recovered.lock().unwrap().clone();
    (events, error, recovered)
}

fn call_of(call: &mixdog_core_api::domain::provider::ToolCall) -> Exact {
    plain(&serde_json::json!({ "id": call.id, "name": call.name, "arguments": call.arguments }))
}

#[tokio::test(start_paused = true)]
async fn every_case_consumes_as_nodes() {
    let set = CaseSet::load(SET);
    assert_eq!(set.cases.len(), 18, "the recorded cases");
    for case in &set.cases {
        let id = case.id.as_str();
        let (events, error, recovered) = consume(&set, id).await;
        let what = format!("{SET} {id}");
        for (key, recorded) in case.result().entries() {
            let what = format!("{what}: {key}");
            match key.as_str() {
                "response" => {
                    assert!(error.is_none(), "{what}: the core failed: {error:?}");
                    assert_response(&set, &what, recorded, &events);
                }
                "error" => {
                    let left = Left { error: error.as_ref(), cancelled: false, exhausted: false, events: &events };
                    assert!(error.is_some(), "{what}: the core ended cleanly: {events:?}");
                    compare_error(&what, recorded, &left);
                }
                "progress" => assert_exact(
                    &what,
                    recorded,
                    &Exact::Array(
                        events
                            .iter()
                            .filter_map(|e| if let StreamEvent::ChunkProgress(kind) = e { Some(Exact::String(progress_name(*kind).into())) } else { None })
                            .collect(),
                    ),
                ),
                "text" => assert_exact(
                    &what,
                    recorded,
                    &Exact::Array(events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(Exact::String(t.clone())) } else { None }).collect()),
                ),
                "dispatched" => assert_exact(
                    &what,
                    recorded,
                    &Exact::Array(events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(call) = e { Some(call_of(call)) } else { None }).collect()),
                ),
                // `getLeakedToolCalls()`: every call the guard recovered, whether or not the turn released it.
                "leakedToolCalls" => {
                    let _ = result_field(key);
                    assert_exact(&what, recorded, &Exact::Array(recovered.iter().map(call_of).collect()));
                }
                other => panic!("{what}: a recorded property this replay does not read: {other}"),
            }
        }
    }
}

/// The aggregated response against the core's events: `candidates` (one candidate), each field as `RESULT_FIELDS` maps it
/// or declared not compared by the manifest; any other recorded field fails.
fn assert_response(set: &CaseSet, what: &str, recorded: &Exact, events: &[StreamEvent]) {
    for (key, _) in recorded.entries() {
        assert_eq!(key, "candidates", "{what}: a recorded property this replay does not read: {key}");
    }
    let candidates = recorded.get("candidates").as_array();
    assert_eq!(candidates.len(), 1, "{what}: one candidate");
    let stops: Vec<_> = events.iter().filter_map(|e| if let StreamEvent::Completed { stop, .. } = e { Some(stop.clone()) } else { None }).collect();
    let parts = events
        .iter()
        .find_map(|e| if let StreamEvent::ReasoningReplay(replay) = e { Some(plain(&replay.items["parts"])) } else { None })
        .unwrap_or_else(|| panic!("{what}: the turn's parts: {events:?}"));
    let candidate = &candidates[0];
    for (key, value) in candidate.entries() {
        let path = format!("response.candidates[].{key}");
        match key.as_str() {
            "content" => {
                for (field, value) in value.entries() {
                    let path = format!("{path}.{field}");
                    if set.excludes(&path) {
                        continue;
                    }
                    assert_eq!(field, "parts", "{what}: {path}: a recorded property this replay does not read");
                    let _ = result_field(&path);
                    assert_exact(&format!("{what}: {path}"), value, &parts);
                }
            }
            "finishReason" => {
                let _ = result_field(&path);
                assert_eq!(value.as_str(), "STOP", "{what}: {path}: a finish this set's responses do not carry");
            }
            _ => assert!(set.excludes(&path), "{what}: {path}: a recorded property this replay does not read"),
        }
    }
    // STOP and no finish are both a delivered turn (`Completed { stop: None }`, see `RESULT_FIELDS`).
    assert_eq!(stops, [None], "{what}: response.candidates[].finishReason ({})", result_field("response.candidates[].finishReason"));
}
