//! Vertex AI open models against Node's recordings (`fixtures/provider-wire/vertex-maas`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-wire.mjs` through `VertexAIProvider` on a gcloud login): the adapter
//! mints a token, the first Chat Completions send is refused (a 401, a 429 answered as a JSON array, a 529) and the
//! next answers. The provider is built by the production builder from the recorded configuration and gcloud login:
//! every request (token grants included) is compared whole with Node's and the bearer with the token the last grant
//! answered; a refusal the adapter does not recover itself is retried as the loop's decider rules under the policy the
//! adapter names for the model, with the wait Node slept; the answer is compared whole with Node's result and the
//! stream callbacks in order.

use std::sync::Arc;

use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;

use crate::providers::wire_fixtures::Hub;
use crate::providers::wire_fixtures::Inputs;
use crate::providers::wire_fixtures::assert_minted_bearer;
use crate::providers::wire_fixtures::assert_same_events;
use crate::providers::wire_fixtures::assert_same_requests;
use crate::providers::wire_fixtures::assert_same_result;
use crate::providers::wire_fixtures::attempt;
use crate::providers::wire_fixtures::built;
use crate::providers::wire_fixtures::core_result;
use crate::providers::wire_fixtures::load;
use crate::providers::wire_fixtures::node_result;
use crate::providers::wire_fixtures::request_of;
use crate::providers::wire_fixtures::scenarios;
use crate::retry::StandardRetryDecider;

#[tokio::test]
async fn an_open_model_is_sent_refreshed_and_retried_as_node_does() {
    let names = scenarios("vertex-maas");
    assert_eq!(names, ["refresh-after-401", "retry-429", "retry-529"]);
    for name in names {
        let recorded = load("vertex-maas", &name);
        // The recorder's script: the first Chat Completions send gets the scenario's status, with `retry-after-ms: 1`
        // on a 429 or 529.
        let status = match name.as_str() {
            "refresh-after-401" => 401,
            "retry-429" => 429,
            _ => 529,
        };
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        if status != 401 {
            headers.push(("retry-after-ms".to_owned(), "1".to_owned()));
        }
        let hub = Hub::new(&recorded).refuse_first("/chat/completions", status, headers);
        let (adapter, _dir) = built(&recorded, hub.clone(), Inputs::default()).await;
        let request = Arc::new(request_of(&recorded));
        let model = request.model.clone();
        let samples: Vec<f64> = recorded.exchange["determinism"]["rng"]["samples"].as_array().unwrap().iter().map(|s| s["value"].as_f64().unwrap()).collect();
        let slept: Vec<u64> = recorded.exchange["determinism"]["retrySleeps"].as_array().unwrap().iter().map(|s| s["delayMs"].as_u64().unwrap()).collect();
        let mut state = RetryState::new(RetryClass::Request, &model);
        let mut waits = Vec::new();
        let events = loop {
            match attempt(adapter.as_ref(), request.clone()).await {
                Ok(events) => break events,
                Err(error) => {
                    let decision = StandardRetryDecider.verdict(&error, &state, adapter.retry_policy_for(&model), JitterSamples { step: samples[0], advice: samples[1] });
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