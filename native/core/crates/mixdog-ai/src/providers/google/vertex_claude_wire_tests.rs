//! Claude on Vertex AI against Node's recordings (`fixtures/provider-wire/vertex-claude`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-wire.mjs` through `VertexAIProvider` on a gcloud login): the adapter
//! mints a token and sends the Anthropic request through streamRawPredict (plain; with tools and effort; refused once
//! with a 529, retried as the loop's decider rules under the policy the adapter names for the model, with the wait Node
//! slept). Every request (the token grant included) is compared with Node's bytes and the decoded answer whole with
//! Node's result.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;
use serde_json::Value;

use super::auth::RequestAuth;
use super::auth::vertex::VertexAuth;
use super::auth::vertex::parse_adc;
use super::serving::VertexPlace;
use super::traits::CatalogGoogleTraits;
use crate::providers::anthropic::ModelCaps;
use crate::providers::wire_fixtures::assert_same_result;
use crate::providers::wire_fixtures::core_result;
use crate::providers::wire_fixtures::load;
use crate::providers::wire_fixtures::node_result;
use crate::providers::wire_fixtures::scenarios;
use crate::providers::wire_fixtures::tools;
use crate::retry::StandardRetryDecider;
use crate::transport::BodyStream;
use crate::transport::Exchange;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// Answers each request with the next recorded record; with `refusal` the first streamRawPredict gets that status
/// (the recorder's script), with the recorder's `retry-after-ms: 1`.
struct Recorded {
    records: Mutex<VecDeque<Value>>,
    refusal: Option<u16>,
    refused: Mutex<bool>,
    sent: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for Recorded {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        let record = self.records.lock().unwrap().pop_front().unwrap_or_else(|| panic!("no recorded request left for {}", request.url));
        let served = record["served"].as_str().unwrap().to_owned();
        let predict = record["path"].as_str().unwrap().ends_with(":streamRawPredict");
        self.sent.lock().unwrap().push(request);
        let mut refused = self.refused.lock().unwrap();
        let (status, headers) = match self.refusal {
            Some(status) if predict && !*refused => {
                *refused = true;
                (status, vec![("content-type".to_owned(), "application/json".to_owned()), ("retry-after-ms".to_owned(), "1".to_owned())])
            }
            _ => (200, Vec::new()),
        };
        Ok(HttpResponse { status, headers, body: Box::new(Once(Some(Bytes::from(served)))) })
    }
}

/// The recorded wall clock (`Date.now` is START).
fn now() -> u64 {
    1_700_000_000_000
}

#[tokio::test]
async fn claude_is_sent_through_stream_raw_predict_as_node_sends_it() {
    let names = scenarios("vertex-claude");
    assert_eq!(names, ["retry-529", "text", "tools-effort"]);
    for name in names {
        let recorded = load("vertex-claude", &name);
        let http = Arc::new(Recorded {
            records: Mutex::new(recorded.exchange["records"].as_array().unwrap().iter().cloned().collect()),
            refusal: (name == "retry-529").then_some(529),
            refused: Mutex::new(false),
            sent: Mutex::default(),
        });
        // The recorder's gcloud login (`authorized_user`) on project `fixture-project`, location `global`.
        let adc = r#"{"type":"authorized_user","client_id":"fixture-client","client_secret":"fixture-secret","refresh_token":"fixture-refresh-token"}"#;
        let auth = VertexAuth::new(http.clone(), parse_adc(adc, "adc.json").unwrap(), Box::new(now));
        let identity = auth.identity().to_owned();
        let auth: Arc<dyn RequestAuth> = Arc::new(auth);
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
        let place = VertexPlace::project("fixture-project", Some("global"), None);
        let adapter = super::vertex(place, auth, identity, http.clone(), Arc::new(CatalogGoogleTraits(Vec::new())), caps);
        let input = &recorded.input;
        let model = input["model"].as_str().unwrap();
        let messages = input["messages"].as_array().unwrap();
        let text = |i: usize| Content::Text(messages[i]["content"].as_str().unwrap().to_owned());
        let request = Arc::new(ModelRequest {
            model: model.to_owned(),
            messages: vec![Message::new(Role::System, text(0)), Message::new(Role::User, text(1))],
            tools: tools(&input["tools"]),
            options: RequestOptions { effort: input["opts"]["effort"].as_str().map(str::to_owned), ..RequestOptions::default() },
        });
        let samples: Vec<f64> = recorded.exchange["determinism"]["rng"]["samples"].as_array().map(|s| s.iter().map(|s| s["value"].as_f64().unwrap()).collect()).unwrap_or_default();
        let slept: Vec<u64> = recorded.exchange["determinism"]["retrySleeps"].as_array().unwrap().iter().map(|s| s["delayMs"].as_u64().unwrap()).collect();
        let mut state = RetryState::new(RetryClass::Request, model);
        let mut waits = Vec::new();
        let events = loop {
            match adapter.attempt(request.clone()).await {
                Ok(mut stream) => {
                    let mut events = Vec::new();
                    while let Some(event) = stream.next().await {
                        events.push(event.unwrap_or_else(|e| panic!("{name}: {e:?}")));
                    }
                    break events;
                }
                Err(error) => {
                    let jitter = JitterSamples { step: samples.first().copied().unwrap_or(0.0), advice: samples.get(1).copied().unwrap_or(0.0) };
                    let decision = StandardRetryDecider.verdict(&error, &state, adapter.retry_policy_for(model), jitter);
                    let Verdict::Retry { delay, .. } = decision.verdict else { panic!("{name}: Node retried, Rust {:?} for {error:?}", decision.verdict) };
                    waits.push(delay.as_millis() as u64);
                    state = decision.next;
                }
            }
        };
        assert_eq!(waits, slept, "{name}: retry waits");
        let sent = http.sent.lock().unwrap();
        let records = recorded.exchange["records"].as_array().unwrap();
        assert_eq!(sent.len(), records.len(), "{name}: requests");
        for (i, (got, want)) in sent.iter().zip(records).enumerate() {
            assert_eq!(got.url, format!("{}{}", want["origin"].as_str().unwrap(), want["path"].as_str().unwrap()), "{name} #{i}: url");
            assert_eq!(String::from_utf8(got.body.clone()).unwrap(), want["bodyText"].as_str().unwrap(), "{name} #{i}: body");
        }
        assert_same_result(&core_result(&events, model), &node_result(&recorded.result), &format!("{name}: result"));
    }
}
