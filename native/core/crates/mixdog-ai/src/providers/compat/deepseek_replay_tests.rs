//! The empty-versus-absent `reasoning_content` of `deepseek-replay.test.mjs` against `fixtures/provider-deepseek-replay`
//! (recorded by `benchmarks/rust-core/recorders/record-deepseek-replay.mjs` from `b6f10295a`): the production builder's
//! DeepSeek provider sends the recorded call to a stand-in endpoint serving Node's chat stream. The request is compared
//! whole with Node's, then the result: the content, the model, the stop reason, the usage and whether the reasoning
//! text rides the result at all (`reasoningContent` present, even empty, or absent). The third recorded case runs the
//! agent loop over two replies and belongs to the session replays.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::StreamEvent;
use serde_json::Value;
use serde_json::json;

use crate::providers::case_replay::Capture;
use crate::providers::case_replay::assert_same_requests;
use crate::providers::case_replay::cases;
use crate::providers::case_replay::without_undefined;
use crate::providers::wire_fixtures::Inputs;
use crate::providers::wire_fixtures::Recorded;
use crate::providers::wire_fixtures::attempt;
use crate::providers::wire_fixtures::built_on;
use crate::providers::wire_fixtures::message;

/// What a send returns, in Node's result fields: the reasoning text is there when the stream carried one, empty or not.
fn folded(events: &[StreamEvent], requested: &str) -> Value {
    let (mut content, mut model, mut stop, mut reasoning, mut usage) = (String::new(), requested.to_owned(), Value::Null, None, Value::Null);
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => content.push_str(text),
            StreamEvent::FinalContent(text) => content.clone_from(text),
            StreamEvent::ServedModel(served) => model.clone_from(served),
            StreamEvent::ReasoningReplay(replay) => reasoning = replay.items.get("reasoningContent").cloned(),
            StreamEvent::Usage(u) => usage = json!({"inputTokens": u.input_tokens, "outputTokens": u.output_tokens}),
            StreamEvent::Completed { stop: Some(s), .. } => stop = json!(crate::providers::wire_fixtures::stop_text(s)),
            _ => {}
        }
    }
    let mut out = json!({"content": content, "model": model, "stopReason": stop});
    if let Some(reasoning) = reasoning {
        out["reasoningContent"] = reasoning;
    }
    if !usage.is_null() {
        out["usage"] = usage;
    }
    out
}

#[tokio::test]
async fn an_empty_reasoning_text_stays_a_result_field_and_an_absent_one_does_not() {
    let set = cases(mixdog_testkit::fixture!("../../fixtures/provider-deepseek-replay/cases.json"));
    for case in set["cases"].as_array().unwrap().iter().filter(|c| c["requests"].as_array().is_some_and(|r| r.len() == 1)) {
        let id = case["id"].as_str().unwrap();
        let capture = Capture::new(case);
        let make = &case["calls"][0]["args"];
        let recorded = Recorded { input: json!({"provider": make[0], "config": make[1], "clientVersion": "1.0.0"}), exchange: Value::Null, result: Value::Null };
        let (adapter, _dir) = built_on(&recorded, capture.clone(), Inputs::default()).await;
        let send = &case["calls"][1]["args"];
        let request = Arc::new(ModelRequest {
            model: send[1].as_str().unwrap().to_owned(),
            messages: send[0].as_array().unwrap().iter().map(message).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        });
        let events = attempt(adapter.as_ref(), request.clone()).await.unwrap_or_else(|e| panic!("{id}: {e:?}"));
        assert_same_requests(&capture, case);
        let node = without_undefined(&case["result"]["result"]);
        let mut wanted = node.clone();
        // Node's own timing and tool-call fields: the window of an instant stream, and the absent calls.
        wanted.as_object_mut().unwrap().shift_remove("generationMs");
        assert_eq!(folded(&events, &request.model), wanted, "{id}: the result");
        assert_eq!(folded(&events, &request.model).get("reasoningContent").is_some(), case["result"]["messageHasReasoningContent"], "{id}: reasoningContent is a result field");
    }
}
