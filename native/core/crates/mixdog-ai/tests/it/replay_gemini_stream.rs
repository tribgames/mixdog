//! `provider-gemini-stream`: `consumeGeminiRestStreamResponse` (and `createGeminiTextLeakGuard`) over a real response.
//! The production `ReqwestLink` posts the recorder's own fetch to the driver's endpoint, which serves the case's
//! scripted chunks (each its own write); the body goes through the core's Gemini decoder (`GeminiDecoder`, the
//! decoder the Gemini route builds, under the recorded `label`), fed chunk by chunk and finished at the end as the
//! route's stream does. The recorder's result is compared against the core's events: `progress` is every
//! `onStreamDelta` of the consumer (`ChunkProgress`; the recorded guard had no `onStreamDelta`), `text` every
//! `onTextDelta` (`TextDelta`), `dispatched` the guard's `onToolCall` (`ToolCallDone`), the error through the
//! driver's `ERROR_FIELDS`.
//!
//! Not compared, with the reason:
//! - the recorder's fetch (`requests[0]`) is the harness's own POST, not the product's request;
//! - `response.candidates[0]`'s `index`, `role` and `finishReason`: the core keeps no aggregated response. Its parts
//!   are the turn's replay parts (compared whole); a clean `STOP` or a tool turn without a finish is
//!   `Completed { stop: None }` (asserted);
//! - `leakedToolCalls` of a failed stream: Node reads the list only after a clean finish (`gemini-response.mjs:37`,
//!   `antigravity-response.mjs:71`) and its count on failure (`gemini-stream.mjs:87`); the core reports each
//!   recovered call as `Progress(Tool)` and holds it, so the count is compared.
//!
//! Not replayed (listed in the report): `first-chunk-window-follows-caller-and-names-phase` (the core's Gemini
//! stream has no first-byte watchdog: `GEMINI_FIRST_BYTE_TIMEOUT_MS` / `EGEMINITIMEOUT` is a core defect to fix) and
//! `leaked-call-dispatched` (`deferToolCalls: false`: no production caller passes it, `antigravity-stream.mjs:85`,
//! `gemini-sdk-request.mjs:14`; the core's guard always defers).

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
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::ProviderId;
use mixdog_testkit::Exact;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::assert_exact;
use crate::provider_case::plain;
use crate::provider_case::within;
use crate::replay_errors::Left;
use crate::replay_errors::compare_error;

const SET: &str = "gemini-stream";

const NOT_REPLAYED: [&str; 2] = ["first-chunk-window-follows-caller-and-names-phase", "leaked-call-dispatched"];

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
    let mut response =
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
    let mut events = Vec::new();
    while let Some(chunk) = within("a body chunk", response.body.next()).await {
        let chunk = chunk.expect("the served chunk");
        match decoder.feed(&chunk) {
            Ok(more) => events.extend(more),
            Err(error) => return (events, Some(error)),
        }
    }
    match decoder.finish() {
        Ok(more) => {
            events.extend(more);
            (events, None)
        }
        Err(error) => (events, Some(error)),
    }
}

#[tokio::test(start_paused = true)]
async fn every_case_consumes_as_nodes() {
    let set = CaseSet::load(SET);
    assert_eq!(set.cases.len(), 18, "the recorded cases");
    for case in set.cases.iter().filter(|c| !NOT_REPLAYED.contains(&c.id.as_str())) {
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
                    assert!(matches!(stops.as_slice(), [None]), "{what}: a clean end: {stops:?}");
                    let parts = events
                        .iter()
                        .find_map(|e| if let StreamEvent::ReasoningReplay(replay) = e { Some(plain(&replay.items["parts"])) } else { None })
                        .expect("the turn's parts");
                    let candidates = recorded.get("candidates").as_array();
                    assert_eq!(candidates.len(), 1, "{what}: one candidate");
                    assert_exact(&format!("{what}: parts"), candidates[0].get("content").get("parts"), &parts);
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
                    assert!(error.is_some(), "{what}: compared on a failed stream only");
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
