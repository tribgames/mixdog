//! The leaked tool-call guard and the decoders that wire it, replayed from Node's recorded behaviour
//! (`golden/leaked_toolcall.json`).

use std::sync::Arc;

use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::compat::chat::ChatDecoder;
use super::connect::frame;
use super::cursor::decoder::CursorDecoder;
use super::cursor::request::BlobStore;
use super::compat::profile::CompatProfile;
use super::compat::profile::CredentialKind;
use super::google::decode::DecodeDialect;
use super::google::decode::GeminiDecoder;
use super::google::decode::UsageStyle;
use super::google::error::ErrorDialect;
use super::leak::Dedupe;
use super::leak::LeakGuard;
use super::leak_golden::calls_of;
use super::leak_golden::check;
use super::leak_golden::golden;
use super::leak_golden::known;
use super::leak_golden::route;
use super::leak_golden::text_of;
use super::openai::config::WireContext;
use super::openai::decoder::Framing;
use super::openai::decoder::ResponsesDecoder;

/// The guard on its own: the chunks of a text in, per chunk the visible text and the calls recovered, then the flush.
#[test]
fn the_guard_recovers_and_holds_back_what_node_s_does() {
    for case in golden()["guard"].as_array().expect("guard") {
        let known = case["known"].as_array().expect("known").iter().map(|n| n.as_str().expect("name").to_owned()).collect();
        let mut guard = LeakGuard::new(known, case["harmony"] == true);
        let chunks = case["chunks"].as_array().expect("chunks");
        let mut got: Vec<(String, Vec<Value>)> = chunks
            .iter()
            .map(|chunk| guard.push(chunk.as_str().expect("chunk"), false))
            .map(|(text, calls)| (text, calls.into_iter().map(|c| serde_json::json!({ "name": c.name, "arguments": c.arguments })).collect()))
            .collect();
        let (text, calls) = guard.flush();
        got.push((text, calls.into_iter().map(|c| serde_json::json!({ "name": c.name, "arguments": c.arguments })).collect()));
        let want = case["steps"].as_array().expect("steps");
        assert_eq!(want.len(), got.len(), "{}", case["name"]);
        for (index, (want, (text, calls))) in want.iter().zip(&got).enumerate() {
            let at = format!("{} (harmony {}) step {index}", case["name"], case["harmony"]);
            assert_eq!(want["text"].as_str().expect("text"), text, "{at}: text");
            assert_eq!(&want["calls"], &Value::Array(calls.clone()), "{at}: calls");
        }
    }
}

/// One 300 000-character delta passes in linear time: only its last characters can start an opener.
#[test]
fn a_long_delta_holds_back_only_its_opener_tail() {
    let mut guard = LeakGuard::new(["read".to_owned()].into_iter().collect(), false);
    let body = "x".repeat(300_000);
    let started = std::time::Instant::now();
    let (text, calls) = guard.push(&format!("{body}<inv"), false);
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "took {:?}", started.elapsed());
    assert_eq!(text, body);
    assert!(calls.is_empty());
    assert_eq!(guard.flush().0, "<inv");
}

/// A repeated native id is one call; a name+arguments repeat of a minted id is one call; a native call a leak
/// already ran is suppressed once.
#[test]
fn the_dedupe_follows_node_s_identity_rules() {
    let args = serde_json::json!({ "path": "a.txt" });
    let mut dedupe = Dedupe::default();
    assert!(dedupe.should_dispatch("read", &args, "call_leaked_0123456789abcdef"));
    assert!(!dedupe.should_dispatch("read", &args, ""));
    assert!(!dedupe.should_dispatch("read", &args, "call_native"), "the native copy of a leak that ran");
    assert!(dedupe.should_dispatch("read", &args, "call_other"), "a second native call is its own");
    assert!(!dedupe.should_dispatch("read", &args, "call_other"));
}

struct Ctx;

impl WireContext for Ctx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
        None
    }
}

fn sse_unit(event: &Value) -> Vec<u8> {
    format!("data: {event}\n\n").into_bytes()
}

/// Every wire event as one unit, then the end of the body; the events of each step.
fn run(decoder: &mut dyn WireDecoder, scenario: &Value, unit: fn(&Value) -> Vec<u8>) -> Vec<Vec<StreamEvent>> {
    let mut steps: Vec<Vec<StreamEvent>> = scenario["wire"]
        .as_array()
        .expect("wire")
        .iter()
        .map(|event| decoder.feed(&unit(event)).expect("feed"))
        .collect();
    steps.push(decoder.finish().expect("finish"));
    steps
}

fn chat_decoder(scenario: &Value) -> ChatDecoder {
    let profile = CompatProfile::plain("groq", "https://api.groq.com/v1", CredentialKind::StaticKey { reauth_on_401: false });
    ChatDecoder::new(profile, ProviderId::from("groq")).with_known_tools(known(scenario))
}

#[test]
fn chat_replays_node_s_leaked_calls() {
    let scenarios = route("chat");
    assert!(!scenarios.is_empty());
    for scenario in scenarios {
        let label = format!("chat / {}", scenario["name"]);
        let mut decoder = chat_decoder(&scenario);
        if scenario["result"].get("error").is_some() {
            // `finish_reason: error` is an interruption, whatever the text carried.
            for event in scenario["wire"].as_array().expect("wire") {
                decoder.feed(&sse_unit(event)).expect("feed");
            }
            assert!(decoder.finish().is_err(), "{label}");
            continue;
        }
        let steps = run(&mut decoder, &scenario, sse_unit);
        let all: Vec<StreamEvent> = steps.iter().flatten().cloned().collect();
        let stop = all.iter().rev().find_map(|event| match event {
            StreamEvent::Completed { stop, .. } => stop.clone(),
            _ => None,
        });
        match scenario["result"]["stopReason"].as_str().expect("stop") {
            // A turn cut at the token limit or filtered never runs a call it leaked: Node returns the call and
            // rejects the response, so the call must not reach the executor.
            cut @ ("length" | "content_filter") => {
                assert_eq!(text_of(&all), scenario["result"]["content"].as_str().expect("content"), "{label}: content");
                // Nothing runs live, but the returned list holds the recovered call and the loop runs it
                // (the recorded stored transcript shows the tool ran).
                assert!(calls_of(&all).is_empty(), "{label}: nothing dispatched live");
                super::leak_golden::assert_calls(&label, &scenario["result"]["toolCalls"], &super::leak_golden::returned_of(&all));
                let want = if cut == "length" { StopReason::MaxTokens } else { StopReason::ContentFilter };
                assert_eq!(stop, Some(want), "{label}");
            }
            // Node dispatches a recovered chat call at the end of a normally finished turn, not as the text arrives.
            _ => {
                check(&label, &scenario, &steps, false);
                assert!(stop.is_some(), "{label}");
            }
        }
    }
}

fn responses_decoder(scenario: &Value, framing: Framing, compat: bool) -> ResponsesDecoder {
    let decoder = ResponsesDecoder::new(framing, Arc::new(Ctx), ProviderId::from("openai")).with_known_tools(known(scenario));
    if compat { decoder.compat_events() } else { decoder }
}

fn ws_unit(event: &Value) -> Vec<u8> {
    event.to_string().into_bytes()
}

fn replay_responses(route_name: &str, framing: Framing, compat: bool, unit: fn(&Value) -> Vec<u8>) {
    let scenarios = route(route_name);
    assert!(!scenarios.is_empty());
    for scenario in scenarios {
        let label = format!("{route_name} / {}", scenario["name"]);
        let mut decoder = responses_decoder(&scenario, framing, compat);
        let steps = run(&mut decoder, &scenario, unit);
        check(&label, &scenario, &steps, true);
    }
}

#[test]
fn the_websocket_responses_decoder_replays_node_s_leaked_calls() {
    replay_responses("responses-ws", Framing::WebSocket, false, ws_unit);
}

#[test]
fn the_http_responses_decoder_replays_node_s_leaked_calls() {
    replay_responses("responses-sse", Framing::Sse, false, sse_unit);
}

#[test]
fn the_compatible_responses_decoder_replays_node_s_leaked_calls() {
    replay_responses("responses-compat", Framing::Sse, true, sse_unit);
}

/// Cursor's text path: the frames Node's stream response consumed, the chat consumer's guard after its think filter.
#[test]
fn the_cursor_decoder_replays_node_s_leaked_calls() {
    let scenarios = route("cursor");
    assert!(!scenarios.is_empty());
    for scenario in scenarios {
        let label = format!("cursor / {}", scenario["name"]);
        let mut decoder =
            CursorDecoder::new(BlobStore::default(), Vec::new(), None).with_known_tools(known(&scenario));
        let steps = run(&mut decoder, &scenario, cursor_unit);
        check(&label, &scenario, &steps, true);
    }
}

fn cursor_unit(payload: &Value) -> Vec<u8> {
    let bytes: Vec<u8> = payload
        .as_str()
        .expect("hex")
        .as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).expect("ascii"), 16).expect("hex digit"))
        .collect();
    frame::encode(&bytes, 0)
}

fn gemini_unit(event: &Value) -> Vec<u8> {
    format!("data: {event}\r\n\r\n").into_bytes()
}

/// Gemini holds a recovered call until the stream finished cleanly and returns the native calls first; a turn that
/// carries a recovered call has no parts to replay.
#[test]
fn the_gemini_decoder_replays_node_s_leaked_calls() {
    let scenarios = route("gemini");
    assert!(!scenarios.is_empty());
    for scenario in scenarios {
        let label = format!("gemini / {}", scenario["name"]);
        let mut decoder = GeminiDecoder::new(DecodeDialect {
            owner: ProviderId::from("gemini"),
            envelope: false,
            usage: UsageStyle::Inclusive,
            errors: ErrorDialect { capacity_by_status: false },
        })
        .with_known_tools(known(&scenario));
        let steps = run(&mut decoder, &scenario, gemini_unit);
        check(&label, &scenario, &steps, false);
        let replayed = steps.iter().flatten().any(|event| matches!(event, StreamEvent::ReasoningReplay(_)));
        assert_eq!(replayed, scenario["result"]["replay"] == true, "{label}: replay");
    }
}
