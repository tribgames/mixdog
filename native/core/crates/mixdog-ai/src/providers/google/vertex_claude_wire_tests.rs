//! Claude on Vertex AI against Node's recordings (`fixtures/provider-wire/vertex-claude`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-wire.mjs` through `VertexAIProvider` on a gcloud login): the adapter
//! mints a token and sends the Anthropic request through streamRawPredict (plain; with tools and effort; refused once
//! with a 529, retried as the loop's decider rules under the policy the adapter names for the model, with the wait Node
//! slept). The provider is built by the production builder from the recorded configuration and gcloud login: every
//! request (the token grant included) is compared whole with Node's, the bearer with the token the grant answered, the
//! answer whole with Node's result, and the stream callbacks in order.

#[cfg(node_twin)]
use std::sync::Arc;

#[cfg(node_twin)]
use mixdog_core_api::domain::retry::JitterSamples;
#[cfg(node_twin)]
use mixdog_core_api::domain::retry::RetryClass;
#[cfg(node_twin)]
use mixdog_core_api::domain::retry::RetryDecider;
#[cfg(node_twin)]
use mixdog_core_api::domain::retry::RetryState;
#[cfg(node_twin)]
use mixdog_core_api::domain::retry::Verdict;

#[cfg(node_twin)]
use crate::providers::anthropic::ModelCaps;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::Hub;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::Inputs;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::assert_minted_bearer;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::assert_same_events;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::assert_same_requests;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::assert_same_result;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::attempt;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::built;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::core_result;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::load;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::node_result;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::request_of;
#[cfg(node_twin)]
use crate::providers::wire_fixtures::scenarios;
#[cfg(node_twin)]
use crate::retry::StandardRetryDecider;

#[cfg(node_twin)]
#[tokio::test]
async fn claude_is_sent_through_stream_raw_predict_as_node_sends_it() {
    let names = scenarios("vertex-claude");
    assert_eq!(names, ["retry-529", "text", "tools-effort"]);
    for name in names {
        let recorded = load("vertex-claude", &name);
        let mut hub = Hub::new(&recorded);
        if name == "retry-529" {
            // The recorder's script: the first streamRawPredict is refused with a 529 and its `retry-after-ms: 1`.
            let advice = vec![("content-type".to_owned(), "application/json".to_owned()), ("retry-after-ms".to_owned(), "1".to_owned())];
            hub = hub.refuse_first(":streamRawPredict", 529, advice);
        }
        // Node's catalog answers for claude-sonnet-4-6: adaptive thinking with effort, 16k output.
        let caps = Arc::new(|_: &str| {
            Some(ModelCaps {
                adaptive_thinking: true,
                manual_thinking: false,
                ladder_stated: false,
                effort_levels: vec!["low".into(), "medium".into(), "high".into()],
                max_output_tokens: Some(16384),
                fast_mode: false,
                context_window: None,
                thinking_display_updates: false,
            })
        });
        let (adapter, _dir) = built(&recorded, hub.clone(), Inputs { caps, ..Inputs::default() }).await;
        let request = Arc::new(request_of(&recorded));
        let model = request.model.clone();
        let samples: Vec<f64> = recorded.exchange["determinism"]["rng"]["samples"].as_array().map(|s| s.iter().map(|s| s["value"].as_f64().unwrap()).collect()).unwrap_or_default();
        let slept: Vec<u64> = recorded.exchange["determinism"]["retrySleeps"].as_array().unwrap().iter().map(|s| s["delayMs"].as_u64().unwrap()).collect();
        let mut state = RetryState::new(RetryClass::Request, &model);
        let mut waits = Vec::new();
        let events = loop {
            match attempt(adapter.as_ref(), request.clone()).await {
                Ok(events) => break events,
                Err(error) => {
                    let jitter = JitterSamples { step: samples.first().copied().unwrap_or(0.0), advice: samples.get(1).copied().unwrap_or(0.0) };
                    let decision = StandardRetryDecider.verdict(&error, &state, adapter.retry_policy_for(&model), jitter);
                    let Verdict::Retry { delay, .. } = decision.verdict else { panic!("{name}: Node retried, Rust {:?} for {error:?}", decision.verdict) };
                    waits.push(delay.as_millis() as u64);
                    state = decision.next;
                }
            }
        };
        assert_eq!(waits, slept, "{name}: retry waits");
        let sent = hub.sent();
        assert_same_requests(&sent, &recorded, &[], &name);
        assert_minted_bearer(&sent, &recorded, &name);
        assert_same_result(&core_result(&events, &model), &node_result(&recorded.result), &format!("{name}: result"));
        assert_same_events(&events, &recorded, &name);
    }
}
