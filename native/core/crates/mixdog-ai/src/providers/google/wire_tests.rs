//! The Gemini API's whole request sequence against Node's recording (`fixtures/wire-anthropic-gemini/gemini.json`,
//! recorded by `benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs` from `GeminiProvider.send` with the
//! network replaced by a recorder and time by a virtual queue, at `b6f10295a`): per model family a first turn, a
//! tool-result turn, long, resumed and compacted threads, expired and forked caches, a prefix below the cache floor,
//! and the dated model redirect. Each send's requests (the cache create, the generate call, the delete a superseded
//! cache schedules) are compared with what `GoogleAdapter::attempt` puts on the wire when the recorded answers come
//! back, with the session state the send leaves behind.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use futures::future::BoxFuture;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ProviderState;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::Temperature;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use super::cache::layer::CacheRuntime;
use super::cache::policy::Tuning;
use super::cache::registry::Registry;
use super::traits::CatalogGoogleTraits;
use crate::providers::anthropic::wire_tests::mismatch;
use crate::providers::anthropic::wire_tests::recording;
use crate::providers::anthropic::wire_tests::seen_of_recorded;
use crate::providers::anthropic::wire_tests::seen_of_sent;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

const KEY: &str = "fake-credential-not-a-secret";

struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// Answers each request with the next recorded answer and keeps what was sent.
struct Recorded {
    replies: Mutex<VecDeque<(u16, String)>>,
    sent: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for Recorded {
    async fn send(&self, request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(request);
        let (status, body) = self.replies.lock().unwrap().pop_front().expect("a recorded answer for this request");
        Ok(HttpResponse { status, headers: vec![], body: Box::new(Once(Some(Bytes::from(body)))) })
    }
}

/// Node's virtual time: a clock and a timer queue that runs a task only when `advance` reaches it (due time, then
/// registration order, one task at a time).
struct Virtual {
    now: AtomicU64,
    seq: AtomicU64,
    timers: Mutex<Vec<(u64, u64, BoxFuture<'static, ()>)>>,
}

impl Virtual {
    async fn advance(&self, ms: u64) {
        let target = self.now.load(Ordering::SeqCst) + ms;
        loop {
            let due = {
                let mut timers = self.timers.lock().unwrap();
                let next = timers.iter().enumerate().filter(|(_, t)| t.0 <= target).min_by_key(|(_, t)| (t.0, t.1)).map(|(i, _)| i);
                next.map(|i| timers.remove(i))
            };
            let Some((at, _, task)) = due else { break };
            self.now.fetch_max(at, Ordering::SeqCst);
            task.await;
        }
        self.now.store(target, Ordering::SeqCst);
    }
}

impl CacheRuntime for Virtual {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        tokio::spawn(task);
    }
    fn spawn_after(&self, delay_ms: u64, task: BoxFuture<'static, ()>) {
        let due = self.now_ms() + delay_ms;
        self.timers.lock().unwrap().push((due, self.seq.fetch_add(1, Ordering::SeqCst), task));
    }
    fn deadline(&self, _ms: u64) -> BoxFuture<'static, ()> {
        Box::pin(futures::future::pending())
    }
}

fn message_of(recorded: &Value) -> Message {
    let role = match recorded["role"].as_str().expect("role") {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        other => panic!("{other}"),
    };
    let mut message = Message::new(role, Content::Text(recorded["content"].as_str().expect("content").into()));
    for call in recorded["toolCalls"].as_array().into_iter().flatten() {
        message.tool_calls.push(ToolCall {
            id: call["id"].as_str().expect("id").into(),
            name: call["name"].as_str().expect("name").into(),
            arguments: call["arguments"].clone(),
            native_type: None,
        });
    }
    message.tool_call_id = recorded["toolCallId"].as_str().map(str::to_owned);
    message
}

fn tool_of(recorded: &Value) -> ToolDefinition {
    ToolDefinition {
        name: recorded["name"].as_str().expect("name").into(),
        description: recorded["description"].as_str().expect("description").into(),
        input_schema: recorded["inputSchema"].clone(),
        defer_loading: recorded["deferLoading"] == true,
        freeform: None,
    }
}

fn options_of(recorded: &Value) -> RequestOptions {
    RequestOptions {
        session_id: recorded["sessionId"].as_str().map(str::to_owned),
        iteration: recorded["iteration"].as_u64().expect("iteration") as u32,
        effort: recorded["effort"].as_str().map(str::to_owned),
        temperature: recorded["temperature"].as_f64().and_then(Temperature::new),
        shared_cache_prefix_count: recorded["sharedCachePrefixCount"].as_u64().map(|count| count as usize),
        provider_state: (!recorded["providerState"].is_null()).then(|| serde_json::from_value(recorded["providerState"].clone()).expect("provider state")),
        ..RequestOptions::default()
    }
}

#[tokio::test]
async fn every_recorded_send_puts_the_requests_node_sent_on_the_wire() {
    let document = recording("gemini.json");
    let scenarios = document["scenarios"].as_array().expect("scenarios");
    assert_eq!(scenarios.len(), 31);
    let mut differences = Vec::new();
    for scenario in scenarios {
        let id = scenario["id"].as_str().expect("id");
        let model = scenario["model"].as_str().expect("model");
        let tools: Vec<_> = scenario["tools"].as_array().expect("tools").iter().map(tool_of).collect();
        let runtime = Arc::new(Virtual { now: AtomicU64::new(0), seq: AtomicU64::new(0), timers: Mutex::default() });
        let mut registry = Arc::new(Registry::default());
        for (n, send) in scenario["sends"].as_array().expect("sends").iter().enumerate() {
            if send["freshProcess"] == true {
                registry = Arc::new(Registry::default());
            }
            let wanted = send["requests"].as_array().expect("requests");
            let http = Arc::new(Recorded {
                replies: Mutex::new(wanted.iter().map(|r| (r["reply"]["status"].as_u64().expect("status") as u16, r["reply"]["body"].as_str().expect("reply body").to_owned())).collect()),
                sent: Mutex::default(),
            });
            let adapter = super::gemini_with(KEY, http.clone(), Arc::new(CatalogGoogleTraits(Vec::new())), runtime.clone(), registry.clone(), Tuning::default());
            runtime.now.store(send["now"].as_u64().expect("now"), Ordering::SeqCst);
            let request = ModelRequest {
                model: model.to_owned(),
                messages: send["messages"].as_array().expect("messages").iter().map(message_of).collect(),
                tools: tools.clone(),
                options: options_of(&send["opts"]),
            };
            let mut state = request.options.provider_state.clone();
            let mut notices = Vec::new();
            let mut stream = adapter.attempt(Arc::new(request)).await.unwrap_or_else(|e| panic!("{id} #{n}: {}", e.message));
            while let Some(item) = stream.next().await {
                match item.unwrap_or_else(|e| panic!("{id} #{n}: {}", e.message)) {
                    StreamEvent::ProviderState(next) => state = Some(next),
                    StreamEvent::Notice { message, warn } => notices.push(json!({ "tone": if warn { "warn" } else { "info" }, "message": message })),
                    _ => {}
                }
            }
            drop(stream);
            // The gap after the send, in which the delete of a superseded cache falls due.
            runtime.advance(send["gapMs"].as_u64().expect("gap")).await;
            let sent = http.sent.lock().unwrap();
            if sent.len() != wanted.len() {
                differences.push(format!("{id} #{n}: Node sent {} request(s), Rust {}", wanted.len(), sent.len()));
                continue;
            }
            for (i, (got, want)) in sent.iter().zip(wanted).enumerate() {
                // A request Node sent with no body (the cache delete) is a request with an empty body here.
                let mut want = want.clone();
                if want["body"].is_null() {
                    want["body"] = json!("");
                }
                if let Some(why) = mismatch(&seen_of_recorded(&want), &seen_of_sent(got)) {
                    differences.push(format!("{id} #{n} request {i}: {why}"));
                }
            }
            // What `onStageChange` got from Node as a notice is what the stream carries (the run loop shows each as a
            // transcript notice of that tone).
            if Value::Array(notices.clone()) != send["notices"] {
                differences.push(format!("{id} #{n}: notices: Node {} / Rust {}", send["notices"], Value::Array(notices)));
            }
            let left = state.as_ref().map_or(Value::Null, ProviderState::to_json);
            if left != send["providerStateAfter"] {
                differences.push(format!("{id} #{n}: session state: Node {} / Rust {left}", send["providerStateAfter"]));
            }
        }
    }
    assert!(differences.is_empty(), "{} difference(s):\n{}", differences.len(), differences.join("\n"));
}
