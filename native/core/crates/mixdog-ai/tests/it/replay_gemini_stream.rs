//! `provider-gemini-stream`: `consumeGeminiRestStreamResponse` (and `createGeminiTextLeakGuard`) over a real response.
//! The production `ReqwestLink` posts the recorder's own fetch to the driver's endpoint, which serves the case's
//! scripted chunks (each its own write); the body goes through the core's consumer (`GoogleStream::consume`, the
//! stream every Gemini-wire route builds) with the core's `GeminiDecoder` under the recorded `label` and the recorded
//! `firstByteTimeoutMs` (else `GEMINI_FIRST_BYTE_TIMEOUT_MS`), the recorded clock steps run while it waits. The
//! recorder's result is compared against the core's events: `progress` is every
//! `onStreamDelta` of the consumer (`ChunkProgress`; the recorded guard had no `onStreamDelta`), `text` every
//! `onTextDelta` (`TextDelta`), `dispatched` the guard's `onToolCall` (`ToolCallDone`), the error through the
//! driver's `ERROR_FIELDS`.
//!
//! The aggregated `response` and `leakedToolCalls` are compared field by field through the shared `RESULT_FIELDS`
//! table. The recorder's fetch (`requests[0]`) is the harness's own POST, not a product request: it is not compared.

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
use mixdog_ai::providers::google::adapter::GoogleStream;
use std::time::Duration;
use mixdog_protocol::ProviderId;
use mixdog_testkit::Exact;
use mixdog_testkit::provider_fields::result_field;
use mixdog_testkit::provider_fields::result_field_unread;

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

/// The served body through the decoder: every event, and the error that ended it.
async fn consume(set: &CaseSet, id: &str) -> (Vec<StreamEvent>, Option<ProviderError>) {
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
    // `firstByteTimeoutMs` as handed in, else `GEMINI_FIRST_BYTE_TIMEOUT_MS` of the recorder's scrubbed environment.
    let window = match options.try_get("firstByteTimeoutMs") {
        Some(Exact::Number(ms)) => *ms,
        _ => mixdog_ai::providers::google::cache::policy::gemini_first_byte_ms(|_| None),
    };
    let mut stream = GoogleStream::consume(
        response.body,
        Box::new(decoder),
        Some((Duration::from_millis(window as u64), label)),
    );
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
    assert_eq!(endpoint.steps().len(), case.clock.len(), "{id}: every recorded clock step");
    (events, error)
}

#[tokio::test(start_paused = true)]
async fn every_case_consumes_as_nodes() {
    let set = CaseSet::load(SET);
    assert_eq!(set.cases.len(), 17, "the recorded cases");
    for case in &set.cases {
        let id = case.id.as_str();
        let (events, error) = consume(&set, id).await;
        let what = format!("{SET} {id}");
        let result = case.result();
        let mut got: Vec<(String, Exact)> = Vec::new();
        for (key, recorded) in result.entries() {
            let value = match key.as_str() {
                "response" => {
                    assert!(error.is_none(), "{what}: the core failed: {error:?}");
                    let stops: Vec<_> = events.iter().filter_map(|e| if let StreamEvent::Completed { stop, .. } = e { Some(stop) } else { None }).collect();
                    let parts = events
                        .iter()
                        .find_map(|e| if let StreamEvent::ReasoningReplay(replay) = e { Some(plain(&replay.items["parts"])) } else { None })
                        .expect("the turn's parts");
                    let candidates = recorded.get("candidates").as_array();
                    assert_eq!(recorded.entries().len(), 1, "{what}: the response is its candidates");
                    assert_eq!(candidates.len(), 1, "{what}: one candidate");
                    // Each field through RESULT_FIELDS.
                    for (key, value) in candidates[0].entries() {
                        let path = format!("response.candidates[0].{key}");
                        match key.as_str() {
                            "content" => {
                                for (field, value) in value.entries() {
                                    let path = format!("{path}.{field}");
                                    if result_field_unread(&path) {
                                        continue;
                                    }
                                    assert_eq!(field, "parts", "{what}: {path} ({})", result_field(&path));
                                    assert_exact(&format!("{what}: {path}"), value, &parts);
                                }
                            }
                            "finishReason" => {
                                assert_eq!(value.as_str(), "STOP", "{what}: {path} ({})", result_field(&path));
                                assert!(matches!(stops.as_slice(), [None]), "{what}: {path}");
                            }
                            _ => assert!(result_field_unread(&path), "{what}: {path} ({})", result_field(&path)),
                        }
                    }
                    if candidates[0].try_get("finishReason").is_none() {
                        // No finish: a turn of whole calls, delivered with no stop (`Completed { stop: None }`).
                        assert!(matches!(stops.as_slice(), [None]), "{what}: no finish");
                    }
                    recorded.clone()
                }
                "error" => {
                    let left = Left { error: error.as_ref(), cancelled: false, events: &events };
                    assert!(error.is_some(), "{what}: the core ended cleanly: {events:?}");
                    compare_error(&format!("{what}: error"), recorded, &left);
                    recorded.clone()
                }
                "progress" => Exact::Array(
                    events
                        .iter()
                        .filter_map(|e| if let StreamEvent::ChunkProgress(kind) = e { Some(Exact::String(progress_name(*kind).into())) } else { None })
                        .collect(),
                ),
                "text" => Exact::Array(
                    events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(Exact::String(t.clone())) } else { None }).collect(),
                ),
                "dispatched" => Exact::Array(
                    events
                        .iter()
                        .filter_map(|e| if let StreamEvent::ToolCallDone(call) = e {
                            Some(plain(&serde_json::json!({ "id": call.id, "name": call.name, "arguments": call.arguments })))
                        } else {
                            None
                        })
                        .collect(),
                ),
                "leakedToolCalls" => {
                    assert!(error.is_some(), "{what}: compared on a failed stream only ({})", result_field(key));
                    let recovered = events.iter().filter(|e| matches!(e, StreamEvent::Progress(ProgressKind::Tool))).count();
                    assert_eq!(recovered, recorded.as_array().len(), "{what}: the recovered calls");
                    recorded.clone()
                }
                other => panic!("{what}: no answer for {other}"),
            };
            got.push((key.clone(), value));
        }
        assert_exact(&format!("{what}: result"), result, &Exact::Object(got));
    }
}
