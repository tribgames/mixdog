//! Vertex AI open models against Node's recordings (`fixtures/provider-wire/vertex-maas`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-wire.mjs` through `VertexAIProvider` on a gcloud login): the adapter
//! mints a token, the first Chat Completions send is refused (a 401, a 429 answered as a JSON array, a 529) and the
//! next answers. Every request (token grants included) is compared with Node's bytes; a refusal the adapter does not
//! recover itself is retried as the loop's decider rules under the policy the adapter names for the model, with the
//! wait Node slept; the decoded answer is compared whole with Node's result.

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
use crate::providers::wire_fixtures::assert_same_result;
use crate::providers::wire_fixtures::core_result;
use crate::providers::wire_fixtures::load;
use crate::providers::wire_fixtures::node_result;
use crate::providers::wire_fixtures::scenarios;
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

/// Answers each request with the next recorded record; the first Chat Completions send gets the scenario's status
/// (the recorder's script: the failure, then the answer), with the recorder's `retry-after-ms: 1` on a 429 or 529.
struct Recorded {
    records: Mutex<VecDeque<Value>>,
    status: u16,
    refused: Mutex<bool>,
    sent: Mutex<Vec<(WireRequest, Value)>>,
}

#[async_trait]
impl HttpSend for Recorded {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        let record = self.records.lock().unwrap().pop_front().unwrap_or_else(|| panic!("no recorded request left for {}", request.url));
        let served = record["served"].as_str().unwrap().to_owned();
        let chat = record["path"].as_str().unwrap().ends_with("/chat/completions");
        self.sent.lock().unwrap().push((request, record));
        let mut refused = self.refused.lock().unwrap();
        let (status, headers) = if chat && !*refused {
            *refused = true;
            let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
            if self.status != 401 {
                headers.push(("retry-after-ms".to_owned(), "1".to_owned()));
            }
            (self.status, headers)
        } else {
            (200, Vec::new())
        };
        Ok(HttpResponse { status, headers, body: Box::new(Once(Some(Bytes::from(served)))) })
    }
}

/// The recorded wall clock (`Date.now` is START).
fn now() -> u64 {
    1_700_000_000_000
}

#[tokio::test]
async fn an_open_model_is_sent_refreshed_and_retried_as_node_does() {
    let names = scenarios("vertex-maas");
    assert_eq!(names, ["refresh-after-401", "retry-429", "retry-529"]);
    for name in names {
        let recorded = load("vertex-maas", &name);
        let status = match name.as_str() {
            "refresh-after-401" => 401,
            "retry-429" => 429,
            _ => 529,
        };
        let http = Arc::new(Recorded {
            records: Mutex::new(recorded.exchange["records"].as_array().unwrap().iter().cloned().collect()),
            status,
            refused: Mutex::new(false),
            sent: Mutex::default(),
        });
        // The recorder's gcloud login (`authorized_user`) on project `fixture-project`, location `global`.
        let adc = r#"{"type":"authorized_user","client_id":"fixture-client","client_secret":"fixture-secret","refresh_token":"fixture-refresh-token"}"#;
        let auth = VertexAuth::new(http.clone(), parse_adc(adc, "adc.json").unwrap(), Box::new(now));
        let identity = auth.identity().to_owned();
        let auth: Arc<dyn RequestAuth> = Arc::new(auth);
        let adapter = super::vertex(VertexPlace::project("fixture-project", Some("global"), None), auth, identity, http.clone(), Arc::new(CatalogGoogleTraits(Vec::new())), Arc::new(|_| None));
        let model = recorded.input["model"].as_str().unwrap();
        let request = Arc::new(ModelRequest {
            model: model.to_owned(),
            messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
            tools: Vec::new(),
            options: RequestOptions::default(),
        });
        let samples: Vec<f64> = recorded.exchange["determinism"]["rng"]["samples"].as_array().unwrap().iter().map(|s| s["value"].as_f64().unwrap()).collect();
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
                    let decision = StandardRetryDecider.verdict(&error, &state, adapter.retry_policy_for(model), JitterSamples { step: samples[0], advice: samples[1] });
                    let Verdict::Retry { delay, .. } = decision.verdict else { panic!("{name}: Node retried, Rust {:?} for {error:?}", decision.verdict) };
                    waits.push(delay.as_millis() as u64);
                    state = decision.next;
                }
            }
        };
        assert_eq!(waits, slept, "{name}: retry waits");
        let sent = http.sent.lock().unwrap();
        assert_eq!(sent.len(), recorded.exchange["records"].as_array().unwrap().len(), "{name}: requests");
        for (i, (got, want)) in sent.iter().enumerate() {
            assert_eq!(got.url, format!("{}{}", want["origin"].as_str().unwrap(), want["path"].as_str().unwrap()), "{name} #{i}: url");
            assert_eq!(String::from_utf8(got.body.clone()).unwrap(), want["bodyText"].as_str().unwrap(), "{name} #{i}: body");
        }
        assert_same_result(&core_result(&events, model), &node_result(&recorded.result), &format!("{name}: result"));
    }
}
