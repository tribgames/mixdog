//! The Messages decoder's leaked tool-call guard, replayed from Node's recorded behaviour
//! (`fixtures/agent/leaked-toolcall/golden/leaked_toolcall.json`, route `anthropic`).

use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::decoder::AnthropicDecoder;
use crate::providers::leak_golden::calls_of;
use crate::providers::leak_golden::check;
use crate::providers::leak_golden::known;
use crate::providers::leak_golden::route;

fn unit(event: &Value) -> Vec<u8> {
    format!("event: {}\ndata: {event}\n\n", event["type"].as_str().expect("type")).into_bytes()
}

#[test]
fn the_decoder_recovers_leaked_calls_as_node_does() {
    let scenarios = route("anthropic");
    assert!(!scenarios.is_empty());
    for scenario in scenarios {
        let label = format!("anthropic / {}", scenario["name"]);
        let mut decoder = AnthropicDecoder::for_model(ProviderId::from("anthropic"), "").with_known_tools(known(&scenario));
        let mut steps: Vec<Vec<StreamEvent>> = scenario["wire"]
            .as_array()
            .expect("wire")
            .iter()
            .map(|event| decoder.feed(&unit(event)).expect("feed"))
            .collect();
        steps.push(decoder.finish().expect("finish"));
        check(&label, &scenario, &steps, true);
        // A recovered call has no content block, so the turn's blocks are not replayed (Node falls back to the
        // flattened projection); a turn without one replays them.
        let all: Vec<StreamEvent> = steps.into_iter().flatten().collect();
        let leaked = calls_of(&all).iter().any(|call| call.id.starts_with("toolu_leaked_"));
        let replayed = all.iter().any(|event| matches!(event, StreamEvent::ReasoningReplay(_)));
        assert_eq!(replayed, !leaked, "{label}: replay");
        // `thinkingBlocks` stay on a leaked turn (the carrier event); a turn with a replay holds them in it.
        let node = &scenario["result"]["thinkingBlocks"];
        let kept: Vec<Value> = if leaked {
            all.iter()
                .find_map(|event| match event {
                    StreamEvent::ThinkingBlocks(blocks) => blocks.as_array().cloned(),
                    _ => None,
                })
                .unwrap_or_default()
        } else {
            all.iter()
                .find_map(|event| match event {
                    StreamEvent::ReasoningReplay(replay) => replay.items.as_array().cloned(),
                    _ => None,
                })
                .unwrap_or_default()
                .into_iter()
                .filter(|b| matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking")))
                .collect()
        };
        assert_eq!(&Value::Array(kept), node, "{label}: thinking blocks");
    }
}
