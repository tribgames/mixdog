//! Anthropic's server-side fallback against Node's recordings (`fixtures/provider-wire/anthropic-fallback`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-wire.mjs`): the subscription adapter sends the turn, the recorded stream
//! (a `fallback` block before any output, after some, or naming a snapshot of the requested model) comes back, and the
//! request bytes, the whole result (the model that answered and the fallback record included) and the ledger row the
//! accounting writes are compared with Node's.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use super::AnthropicAdapter;
use super::AnthropicConfig;
use super::ModelCaps;
use super::tests::MemoryStore;
use super::tests::cpu_bulk;
use crate::providers::google::wire_tests::Rows;
use crate::providers::google::wire_tests::empty_pricing;
use crate::providers::wire_fixtures::assert_same_result;
use crate::providers::wire_fixtures::core_result;
use crate::providers::wire_fixtures::load;
use crate::providers::wire_fixtures::node_result;
use crate::providers::wire_fixtures::scenarios;
use crate::registry::accounted::AccountOf;
use crate::registry::accounted::AccountedAdapter;
use crate::registry::accounted::AccountingDeps;
use crate::registry::accounting::UsageSink;
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

/// Answers each request with the recorded answer to the same method and path, in order, and keeps what was sent.
struct Served {
    records: Mutex<VecDeque<Value>>,
    sent: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for Served {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        let mut records = self.records.lock().unwrap();
        let at = records
            .iter()
            .position(|r| r["method"] == request.method.as_str() && request.url == format!("{}{}", r["origin"].as_str().unwrap(), r["path"].as_str().unwrap()))
            .unwrap_or_else(|| panic!("no recorded answer for {} {}", request.method, request.url));
        let record = records.remove(at).expect("record");
        self.sent.lock().unwrap().push(request);
        Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(Once(Some(Bytes::from(record["served"].as_str().unwrap().to_owned())))) })
    }
}

/// The recorder's account roster: the default account.
struct DefaultAccount;

#[async_trait]
impl AccountOf for DefaultAccount {
    async fn of(&self, _: &str) -> Result<String, String> {
        Ok("default".into())
    }
}

/// The ledger rows with the first-output time left out: no adapter reports where generation starts in its stream
/// (`Completed::generation_ms` is never set), so every Rust row has none where Node's has one.
fn without_ttft(rows: &Value) -> Value {
    let mut rows = rows.clone();
    for row in rows.as_array_mut().expect("rows") {
        row.as_object_mut().expect("row").shift_remove("ttftMs");
    }
    rows
}

#[test]
fn a_turn_the_fallback_model_answers_is_booked_and_reported_as_node_does() {
    // The recorder ran with TZ=Asia/Seoul: a row's day is that local day.
    mixdog_js::time::with_local_zone("Asia/Seoul".parse().unwrap(), || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(replay_fallbacks());
    });
}

async fn replay_fallbacks() {
    let names = scenarios("anthropic-fallback");
    assert_eq!(names, ["before-output", "mid-output", "snapshot-target"]);
    for name in names {
        let recorded = load("anthropic-fallback", &name);
        let input = &recorded.input;
        let http = Arc::new(Served { records: Mutex::new(recorded.exchange["records"].as_array().unwrap().iter().cloned().collect()), sent: Mutex::default() });
        let store = MemoryStore::signed_in();
        // Node's catalog answers for claude-opus-5: adaptive thinking with effort, 64k output.
        let config = AnthropicConfig::new(Arc::new(|_: &str| {
            Some(ModelCaps {
                adaptive_thinking: true,
                manual_thinking: false,
                ladder_stated: false,
                effort_levels: vec!["low".into(), "medium".into(), "high".into()],
                max_output_tokens: Some(65536),
                fast_mode: false,
                context_window: None,
                thinking_display_updates: false,
            })
        }));
        let inner = AnthropicAdapter::oauth(config, http.clone(), store.session(http.clone()), false, cpu_bulk());
        let rows = Arc::new(Rows::default());
        let ledger = rows.clone();
        let mut deps = AccountingDeps::new(empty_pricing().await, Arc::new(move || Some(ledger.clone() as Arc<dyn UsageSink>)));
        deps.now = Arc::new(|| 1_700_000_000_000);
        deps.new_id = Arc::new(|| "<req>".to_owned());
        deps.account = Arc::new(DefaultAccount);
        let adapter = AccountedAdapter::wrap(Arc::new(inner), "anthropic-oauth", Arc::new(deps));
        let messages = input["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let role = if m["role"] == "system" { Role::System } else { Role::User };
                Message::new(role, Content::Text(m["content"].as_str().unwrap().to_owned()))
            })
            .collect();
        let model = input["model"].as_str().unwrap();
        let request = ModelRequest {
            model: model.to_owned(),
            messages,
            tools: Vec::new(),
            options: RequestOptions {
                session_id: input["opts"]["sessionId"].as_str().map(str::to_owned),
                source_type: input["opts"]["sourceType"].as_str().map(str::to_owned),
                ..RequestOptions::default()
            },
        };
        let mut stream = adapter.attempt(Arc::new(request)).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let mut events = Vec::new();
        while let Some(event) = stream.next().await {
            events.push(event.unwrap_or_else(|e| panic!("{name}: {e:?}")));
        }
        drop(stream);
        let posts = recorded.posts("/v1/messages");
        let sent = http.sent.lock().unwrap();
        let sent_posts: Vec<_> = sent.iter().filter(|r| r.method == "POST").collect();
        assert_eq!(sent_posts.len(), posts.len(), "{name}: sends");
        assert_eq!(String::from_utf8(sent_posts[0].body.clone()).unwrap(), posts[0]["bodyText"].as_str().unwrap(), "{name}: request body");
        assert_same_result(&core_result(&events, model), &node_result(&recorded.result), &format!("{name}: result"));
        assert_eq!(without_ttft(&Value::Array(rows.0.lock().unwrap().clone())), without_ttft(&recorded.result["rows"]), "{name}: usage rows");
    }
}
