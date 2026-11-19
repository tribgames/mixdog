//! `fixtures/provider-anthropic-stream` (`record-anthropic-stream.mjs`): `AnthropicProvider({ apiKey }).send` against
//! the scripted SSE body, replayed through `DefaultProviderBuilder::build("anthropic")` and `ModelBroker::send`.

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::StreamEvent;
use tokio_util::sync::CancellationToken;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_case::within;
use crate::replay_anthropic;
#[cfg(node_twin)]
use crate::replay_world;

#[cfg(node_twin)]
pub const REPLAYS: &[crate::provider_case::Replay] = &[crate::provider_case::Replay { set: "anthropic-stream", run: every_case_replays_as_nodes }];

/// Every case whole: the request as it arrives at the socket (the Anthropic SDK's headers in its order and letter
/// case, undici's own, the body bytes), and the send's result and callbacks as Node's.
#[cfg(node_twin)]
#[tokio::test(start_paused = true)]
async fn every_case_replays_as_nodes() {
    let set = CaseSet::load("anthropic-stream");
    for case in &set.cases {
        let endpoint = Endpoint::start().await;
        endpoint.serve(case);
        let home = tempfile::tempdir().expect("a home");
        let builder = replay_world::builder(&endpoint, home.path(), Vec::new()).await;
        let config = plain_config(case.args_of("AnthropicProvider", 0));
        let adapter = replay_world::adapter(&builder, "anthropic", &config).await;
        let args = case.args_of("AnthropicProvider#send", 0);
        assert_eq!(args[2].as_array().len(), 0, "{}: no tools", case.id);
        let request = ModelRequest {
            model: args[1].as_str().to_owned(),
            messages: args[0].as_array().iter().map(replay_world::message).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        let cancel = CancellationToken::new();
        let (outcome, events) = within(&format!("{}: the send", case.id), replay_world::send_with(adapter.as_ref(), request, &cancel, Default::default())).await;
        assert_eq!(outcome.expect("the scripted stream completes"), 1, "{}: one attempt", case.id);
        set.assert_requests(case, &endpoint.arrivals(), None);
        let frames = crate::provider_cases::plain(&case.input);
        let (shown, departed) = without_opening_inputs(&case.id, &frames["events"], events.events.clone());
        if departed {
            set.departed(&case.id, OPENING_INPUT_DEPARTURE);
        }
        let (shown, held) = without_held_usage(&case.id, &frames["events"], shown);
        if held {
            set.departed(&case.id, HELD_USAGE_DEPARTURE);
        }
        replay_anthropic::assert_send(&set, &case.id, &case.recorded(), &replay_anthropic::send(&shown, args[1].as_str()));
    }
}

/// A decided departure: a later usage report that names a count as `null` leaves the earlier reported count in the core's
/// `usage.raw` (the decoder's `UsageAcc`), so the ledger and the raw agree; Node's raw shows the `null`.
#[cfg(node_twin)]
const HELD_USAGE_DEPARTURE: &str = "a later usage report that names a count as null keeps the earlier reported count in usage.raw; \
     Node's raw shows the null (the billed slots are the same)";

/// The core's usage events with each held count ([`HELD_USAGE_DEPARTURE`]) checked against the earlier frame that reported
/// it, then given Node's `null`; whether any count departed.
#[cfg(node_twin)]
fn without_held_usage(id: &str, frames: &serde_json::Value, mut events: Vec<StreamEvent>) -> (Vec<StreamEvent>, bool) {
    const COUNTS: [&str; 4] = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
    let reports: Vec<&serde_json::Value> =
        frames.as_array().expect("the scripted frames").iter().filter_map(|f| f.get("usage").or_else(|| f.pointer("/message/usage"))).collect();
    let mut departed = false;
    for count in COUNTS {
        let Some(last) = reports.iter().rev().find(|r| r.get(count).is_some()) else { continue };
        if !last[count].is_null() {
            continue;
        }
        let earlier = reports.iter().filter_map(|r| r[count].as_u64()).next_back();
        let Some(earlier) = earlier else { continue };
        for event in &mut events {
            if let StreamEvent::Usage(usage) = event
                && let Some(raw) = usage.raw.as_mut().and_then(|raw| raw.as_object_mut())
                && raw.get(count).is_some_and(|held| !held.is_null())
            {
                assert_eq!(raw[count], serde_json::json!(earlier), "{id}: {count} keeps the earlier report");
                raw.insert(count.to_owned(), serde_json::Value::Null);
                departed = true;
            }
        }
    }
    (events, departed)
}

/// A decided departure from Node's SDK accumulator, which starts every `tool_use` input from an empty buffer.
#[cfg(node_twin)]
const OPENING_INPUT_DEPARTURE: &str = "a tool_use block that opens with a non-empty input and streams no input_json_delta is called with \
     that opening input (the decoder's opening_input); Node calls it with {}";

/// The core's events with each opening-input call ([`OPENING_INPUT_DEPARTURE`]) checked to carry its opening input in the
/// dispatched call and the replay block, then given Node's `{}`; whether any case call departed.
#[cfg(node_twin)]
fn without_opening_inputs(id: &str, frames: &serde_json::Value, mut events: Vec<StreamEvent>) -> (Vec<StreamEvent>, bool) {
    let frames = frames.as_array().expect("the scripted frames");
    let opened: Vec<(&serde_json::Value, &serde_json::Value)> = frames
        .iter()
        .filter(|f| f["type"] == "content_block_start" && f["content_block"]["type"] == "tool_use")
        .filter(|f| f["content_block"]["input"].as_object().is_some_and(|input| !input.is_empty()))
        .filter(|f| !frames.iter().any(|d| d["index"] == f["index"] && d["delta"]["type"] == "input_json_delta"))
        .map(|f| (&f["content_block"]["id"], &f["content_block"]["input"]))
        .collect();
    for (call_id, input) in &opened {
        let mut seen = 0;
        for event in &mut events {
            match event {
                StreamEvent::ToolCallDone(call) if call.id == **call_id => {
                    assert_eq!(&call.arguments, *input, "{id}: the call carries its opening input");
                    call.arguments = serde_json::json!({});
                    seen += 1;
                }
                StreamEvent::ReasoningReplay(replay) => {
                    for block in replay.items.as_array_mut().expect("replay blocks").iter_mut().filter(|b| b["id"] == **call_id) {
                        assert_eq!(&block["input"], *input, "{id}: the replay block carries its opening input");
                        block["input"] = serde_json::json!({});
                    }
                }
                _ => {}
            }
        }
        assert_eq!(seen, 1, "{id}: the call with an opening input is dispatched once");
    }
    (events, !opened.is_empty())
}

/// The recorded `new AnthropicProvider(config)` argument as the builder's config.
fn plain_config(args: &[mixdog_testkit::Exact]) -> serde_json::Value {
    let config = crate::provider_cases::plain(&args[0]);
    assert!(config.as_object().is_some_and(|c| c.keys().all(|k| k == "apiKey")), "a key-only config: {config}");
    config
}
