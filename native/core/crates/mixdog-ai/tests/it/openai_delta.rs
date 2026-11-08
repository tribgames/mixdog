//! Delta frames against Node's `_anchorResponseChain` / `_computeDelta` run on
//! scripted exchanges (`oracles/openai-ws-delta-golden.json`): the same mode,
//! the same reason, the same frame bytes.

#![allow(clippy::disallowed_methods, reason = "test-only: reads a recorded fixture synchronously")]

use mixdog_ai::providers::openai::delta::Chain;
use mixdog_ai::providers::openai::delta::Mode;
use mixdog_ai::providers::openai::delta::compute;
use mixdog_ai::providers::openai::delta::sans_input;
use mixdog_ai::providers::openai::delta::stable_stringify;
use serde_json::Map;
use serde_json::Value;

fn golden() -> Value {
    let path = format!("{}/../../fixtures/providers/oracles/openai-ws-delta-golden.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[test]
fn every_scripted_exchange_frames_as_node_frames_it() {
    let golden = golden();
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() >= 15);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut chain = Chain::default();
        if let Some(previous) = case["previous"].as_object() {
            let body = object(&previous["body"]);
            chain.anchor(previous["responseId"].as_str().unwrap(), &body, previous["items"].as_array().unwrap());
            assert_eq!(
                stable_stringify(&Value::Object(sans_input(&body))),
                case["anchor"]["lastRequestSansInput"].as_str().unwrap(),
                "{name}: anchor"
            );
        }
        let framed = compute(&chain, &object(&case["body"]));
        let expected = &case["expected"];
        let mode = if framed.mode == Mode::Delta { "delta" } else { "full" };
        assert_eq!(mode, expected["mode"].as_str().unwrap(), "{name}: mode");
        assert_eq!(framed.reason.as_deref(), expected["reason"].as_str(), "{name}: reason");
        assert_eq!(framed.stripped as u64, expected["stripped"].as_u64().unwrap(), "{name}: stripped");
        assert_eq!(
            serde_json::to_string(&Value::Object(framed.frame)).unwrap(),
            expected["frame"].as_str().unwrap(),
            "{name}: frame"
        );
    }
}
