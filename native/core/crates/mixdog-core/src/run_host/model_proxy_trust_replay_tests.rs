//! Replay of `native/core/fixtures/model-proxy-host-trust-cases` through the product's entry: `modelProxy/run` on
//! `ModelProxyService` (the domain service the daemon registers, compose_flip.rs) over `ProxyRunner`, its events the
//! typed `modelProxy/run/event` notifications to the asking connection. Node's claim/event/resolve host is a replaced
//! protocol (mixdog-app-protocol/src/inventory.rs marks it Deleted); what each case pins as behaviour is compared here
//! through the manifest's `replay.fieldMap` (`Node field -> typed field`), applied by [`typed_of_node`]. Case "inline
//! attachment data passes untouched, and nesting is bounded" is mixdog-ai `service/model_proxy_trust_replay_tests.rs`.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_ai::admission::Admission;
use mixdog_ai::broker::ModelBroker;
use mixdog_app_protocol::common::RequestClass;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::rpc::InboundText;
use mixdog_app_protocol::rpc::decode_inbound_text;
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_core_api::CallContext;
use mixdog_core_api::ConnectionNotifier;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::mock::MockAttempt;
use mixdog_core_api::domain::mock::MockProvider;
use mixdog_core_api::domain::provider as p;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::mock::MockHostChannel;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderConfigSource;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderLookup;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProxyRunner;
use mixdog_core_domains::domains::ai_admin::model_proxy::QuotaProbe;
use mixdog_core_domains::domains::ai_admin::model_proxy::request_out;
use mixdog_core_domains::domains::ai_admin::model_proxy_service::ModelProxyService;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use super::model_proxy_pc::PcWireRouter;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/model-proxy-host-trust-cases/golden.json");

fn observed(case: &str) -> Value {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    golden["cases"].as_array().unwrap().iter().find(|c| c["case"] == case).unwrap_or_else(|| panic!("{case} is recorded"))["observed"].clone()
}

/// What the scripted provider does on its one attempt: the tools it reports left out (while it encodes) and the
/// events its stream yields. Every request it is sent is kept.
struct Script {
    inner: MockProvider,
    excluded: Vec<p::ToolExclusionReport>,
    events: Vec<p::StreamEvent>,
    seen: Mutex<Vec<p::ModelRequest>>,
}

struct Events(VecDeque<p::StreamEvent>);

#[async_trait]
impl p::ModelStream for Events {
    async fn next(&mut self) -> Option<Result<p::StreamEvent, p::ProviderError>> {
        self.0.pop_front().map(Ok)
    }
    fn delivery(&self) -> p::DeliveryState {
        p::DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
}

#[async_trait]
impl p::ProviderAdapter for Script {
    fn id(&self) -> &mixdog_protocol::ProviderId {
        self.inner.id()
    }
    fn codec(&self) -> &dyn p::WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &mixdog_core_api::domain::retry::RetryPolicy {
        self.inner.retry_policy()
    }
    fn keepalive(&self) -> &mixdog_core_api::domain::keepalive::KeepaliveSchedule {
        self.inner.keepalive()
    }
    async fn attempt(&self, request: Arc<p::ModelRequest>) -> Result<Box<dyn p::ModelStream>, p::ProviderError> {
        self.seen.lock().unwrap().push((*request).clone());
        if let Some(sink) = &request.options.on_tool_excluded {
            for report in &self.excluded {
                sink.report(report.clone());
            }
        }
        Ok(Box::new(Events(self.events.iter().cloned().collect())))
    }
}

fn answer(text: &str) -> Vec<p::StreamEvent> {
    vec![p::StreamEvent::TextDelta(text.into()), p::StreamEvent::Completed { stop: Some(p::StopReason::EndTurn), pricing_model: None, request_ms: None }]
}

/// The PC's provider "openai".
struct Lookup(Arc<Script>);

#[async_trait]
impl ProviderLookup for Lookup {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        (name == "openai").then(|| self.0.clone() as Arc<dyn p::ProviderAdapter>)
    }
}

struct NoQuota;
#[async_trait]
impl QuotaProbe for NoQuota {
    async fn usable(&self, _: &str, _: &str) -> Result<bool, String> {
        unreachable!("no case asks for quota")
    }
}

struct NoConfig;
#[async_trait]
impl ProviderConfigSource for NoConfig {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String> {
        unreachable!("no case asks for the provider config")
    }
}

struct Offline;
#[async_trait]
impl mixdog_ai::transport::HttpSend for Offline {
    async fn send(&self, _: p::WireRequest, _: mixdog_ai::transport::Exchange) -> Result<mixdog_ai::transport::HttpResponse, p::ProviderError> {
        Err(p::ProviderError::new(p::ErrorKind::Transient, p::DeliveryState::NotSent))
    }
}

/// The `modelProxy/run/event` notifications, by connection.
#[derive(Default)]
struct Notes(Mutex<Vec<(ConnectionId, String, Value)>>);

impl ConnectionNotifier for Notes {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        self.0.lock().unwrap().push((to, method.as_str().to_owned(), params));
        Ok(())
    }
}

impl Notes {
    /// The typed events of run `run_id`, in order.
    fn events(&self, run_id: &str) -> Vec<w::ProxyEvent> {
        let notes = self.0.lock().unwrap();
        notes
            .iter()
            .filter(|(_, method, params)| method == "modelProxy/run/event" && params["runId"] == run_id)
            .map(|(_, _, params)| serde_json::from_value(params["event"].clone()).expect("a typed event"))
            .collect()
    }
}

async fn service(script: Arc<Script>) -> (ModelProxyService, Arc<Notes>) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    let catalog = Arc::new(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), metadata).await);
    let broker = Arc::new(ModelBroker::new(Arc::new(Admission::new()), Arc::new(mixdog_ai::retry::StandardRetryDecider)));
    let runner = ProxyRunner { providers: Arc::new(Lookup(script)), broker, quota: Arc::new(NoQuota), wire: Arc::new(PcWireRouter), config: Arc::new(NoConfig), catalog };
    let notes = Arc::new(Notes::default());
    (ModelProxyService::new(Arc::new(runner), Arc::new(MockHostChannel::default()), notes.clone()), notes)
}

fn script(excluded: Vec<p::ToolExclusionReport>, events: Vec<p::StreamEvent>) -> Arc<Script> {
    Arc::new(Script { inner: MockProvider::new(Vec::<MockAttempt>::new()), excluded, events, seen: Mutex::new(Vec::new()) })
}

/// `modelProxy/run` of a send to "openai", as the relaying connection asks it.
fn run(run_id: &str, request: &p::ModelRequest) -> CoreRequest {
    let call = w::ProxyCall::Send { provider: "openai".into(), request: Box::new(request_out(request)) };
    CoreRequest {
        method: Method("modelProxy/run"),
        params: json!({ "runId": run_id, "call": call, "allowedProviders": null }),
        op: None,
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
    }
}

fn request(messages: Vec<p::Message>) -> p::ModelRequest {
    p::ModelRequest { model: "gpt".into(), messages, tools: Vec::new(), options: p::RequestOptions::default() }
}

async fn answered(service: &ModelProxyService, call: CoreRequest) -> Value {
    let Reply::Value(answer) = service.call(call).await.expect("a run answers") else { panic!("not a value") };
    answer["result"].clone()
}

/// The streamed text of a run (Node's send result `content`).
fn content(events: &[w::ProxyEvent]) -> String {
    events.iter().filter_map(|e| if let w::ProxyEvent::TextDelta { text } = e { Some(text.as_str()) } else { None }).collect()
}

/// The manifest's `replay.fieldMap`: the typed events a K1 server receives for what Node's server callbacks received.
fn typed_of_node(stages: &[Value], excluded: &[Value]) -> (Vec<w::ProxyEvent>, Vec<w::ProxyEvent>) {
    let text = |v: &Value| v.as_str().unwrap().to_owned();
    let stages = stages
        .iter()
        .map(|stage| match stage[0].as_str().unwrap() {
            "account-changed" => w::ProxyEvent::AccountChanged { provider: text(&stage[1]["provider"]), at: stage[1]["at"].as_i64().unwrap() },
            "reconnecting" => w::ProxyEvent::AccountSwitching { message: text(&stage[1]["message"]) },
            other => panic!("stage {other} has no mapping"),
        })
        .collect();
    let excluded = excluded
        .iter()
        .map(|info| w::ProxyEvent::ToolExcluded {
            name: text(&info["name"]),
            index: info["index"].as_u64().unwrap(),
            pointer: text(&info["pointer"]),
            reason: text(&info["reason"]),
            message: text(&info["message"]),
        })
        .collect();
    (stages, excluded)
}

/// Case 0. The old wire's `{ type: "image", attachmentRef }` cannot be written on the typed wire (`ProxyImage` is
/// base64, url or file id); a stored file the server could not inline travels as `ProxyBinary::Unavailable` and the
/// PC lowers it to Node's text. The runner holds no attachment store, so nothing of the PC's is ever read for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reference_the_server_could_not_inline_is_the_unavailable_text_node_gave_the_provider() {
    let node = observed("a stored-attachment reference from a server never reads this PC’s attachment store");
    let saw = &node["providerSaw"][0]["content"];
    let script = script(Vec::new(), answer("ok"));
    let (service, _) = service(script.clone()).await;
    let images = [
        p::ImageSource::Base64 { data: "AAAA".into(), mime_type: "image/png".into() },
        p::ImageSource::Url("https://example.test/a.png".into()),
        p::ImageSource::FileId("file-1".into()),
    ];
    let mut user = vec![p::ContentPart::Text(node["request"]["messages"][0]["content"][0]["text"].as_str().unwrap().into(), None)];
    user.extend(images.iter().cloned().map(p::ContentPart::Image));
    let file = &node["request"]["messages"][0]["content"][2]["content"][0];
    let mut tool = p::Message::new(
        p::Role::Tool,
        p::Content::Parts(vec![p::ContentPart::File {
            source: p::BinarySource::AttachmentRef(file["attachmentRef"].as_str().unwrap().into()),
            mime_type: "application/pdf".into(),
            filename: Some(file["filename"].as_str().unwrap().into()),
            text: None,
        }]),
    );
    tool.tool_call_id = Some("call-1".into());
    let sent = request(vec![p::Message::new(p::Role::User, p::Content::Parts(user)), tool]);
    assert_eq!(answered(&service, run("r0", &sent)).await["result"], "sent");
    let seen = script.seen.lock().unwrap();
    let p::Content::Parts(user_parts) = &seen[0].messages[0].content else { panic!("parts") };
    assert_eq!(user_parts[0], p::ContentPart::Text(saw[0]["text"].as_str().unwrap().into(), None));
    assert_eq!(user_parts[1..], images.map(p::ContentPart::Image), "an inline image reaches the provider as sent");
    let p::Content::Parts(tool_parts) = &seen[0].messages[1].content else { panic!("parts") };
    assert_eq!(tool_parts[..], [p::ContentPart::Text(saw[2]["content"][0]["text"].as_str().unwrap().into(), None)]);
    let all = format!("{:?}", seen[0]);
    assert!(!all.contains(node["pcSecretBase64"].as_str().unwrap()), "nothing of this PC's store reached the provider");
}

/// Cases 2 and 3: the typed protocol's bounds on what a peer can make this core hold. There is no snapshot of
/// advertised ids: each call is its own `modelProxy/run` request (class C2), at most `inflight.c2` in flight per
/// connection, each in one frame of at most `maxInboundFrameBytes`; a run streams notifications and asks the peer
/// nothing, so no reply of the peer is ever read.
#[test]
fn a_peer_holds_at_most_its_in_flight_runs_each_one_bounded_frame() {
    let node = observed("payloads past the aggregate in-flight limit are refused, and so are oversized event replies");
    let limits = Limits::default();
    let spec = mixdog_app_protocol::client_method_spec("modelProxy/run").expect("a method of the table");
    assert_eq!(spec.class, RequestClass::C2);
    assert_eq!(limits.inflight.cap(RequestClass::C2), 8);
    // Node's 2,000-character payload is one frame; one past the bound is refused before it is parsed.
    let frame = |chars: usize| json!({ "jsonrpc": "2.0", "id": 1, "method": "modelProxy/run", "params": { "runId": "r", "call": { "method": "send", "provider": "openai", "request": { "pad": "x".repeat(chars) } } } }).to_string();
    let small = frame(node["payloadChars"].as_u64().unwrap() as usize);
    assert!(matches!(decode_inbound_text(&small, limits.max_inbound_frame_bytes as usize), InboundText::Message(_)));
    let over = frame(limits.max_inbound_frame_bytes as usize);
    assert_eq!(decode_inbound_text(&over, limits.max_inbound_frame_bytes as usize), InboundText::TooLarge);
}

/// Case 4: a burst of sends all run; nothing is left running.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_burst_of_runs_all_answer() {
    let node = observed("a burst of sends all run, with no rate or concurrency refusal");
    let sends = node["sends"].as_u64().unwrap() as usize;
    let script = script(Vec::new(), answer("ok"));
    let (service, notes) = service(script).await;
    let hi = request(vec![p::Message::new(p::Role::User, p::Content::Text("hi".into()))]);
    let runs = (0..sends).map(|i| answered(&service, run(&format!("r{i}"), &hi)));
    let answers = futures::future::join_all(runs).await;
    let results: Vec<Value> = (0..sends)
        .map(|i| {
            assert_eq!(answers[i]["result"], "sent");
            json!({ "content": content(&notes.events(&format!("r{i}"))) })
        })
        .collect();
    assert_eq!(Value::Array(results), node["results"]);
    // `host.running` 0: no run is left to wait for.
    assert_eq!(node["hostRunningAfter"], 0);
    tokio::time::timeout(std::time::Duration::from_secs(5), service.close()).await.expect("no run is left running");
}

/// Case 5: what the provider reports reaches the server only as the typed events of the field map, the PC's account
/// id never among them and credential-shaped text redacted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reports_reach_the_server_projected_and_the_account_id_stays_on_this_pc() {
    let node = observed("callbacks reach the server only allowlisted and projected; account ids stay on this PC");
    let secret = "retry with key sk-DUMMY-abcdefghijklmnopqrstuv";
    let excluded = p::ToolExclusionReport {
        name: "bad_tool".into(),
        index: 3,
        pointer: "/properties/x/type".into(),
        reason: "invalid type".into(),
        message: "gemini tool \"bad_tool\" excluded; key sk-DUMMY-abcdefghijklmnopqrstuv".into(),
    };
    let mut events = vec![
        p::StreamEvent::AccountStage(p::AccountStage::Changed { provider: "openai".into(), account_id: "pc-acct-42".into(), at: 7 }),
        p::StreamEvent::AccountStage(p::AccountStage::Switching { message: secret.into() }),
    ];
    events.extend(answer(node["result"]["content"].as_str().unwrap()));
    let (service, notes) = service(script(vec![excluded], events)).await;
    let hi = request(vec![p::Message::new(p::Role::User, p::Content::Text("hi".into()))]);
    assert_eq!(answered(&service, run("r5", &hi)).await["result"], "sent");
    let got = notes.events("r5");
    let (stages, excluded) = typed_of_node(node["stages"].as_array().unwrap(), node["excluded"].as_array().unwrap());
    let of = |keep: fn(&w::ProxyEvent) -> bool| got.iter().filter(|e| keep(e)).cloned().collect::<Vec<_>>();
    assert_eq!(of(|e| matches!(e, w::ProxyEvent::AccountChanged { .. } | w::ProxyEvent::AccountSwitching { .. })), stages);
    assert_eq!(of(|e| matches!(e, w::ProxyEvent::ToolExcluded { .. })), excluded);
    assert_eq!(content(&got), node["result"]["content"].as_str().unwrap());
    let wire = serde_json::to_string(&got).unwrap();
    assert!(!wire.contains("pc-acct-42") && !wire.contains("sk-DUMMY-"), "{wire}");
    // Node's server callbacks and the typed events that carry each (`replay.fieldMap.callbacks`).
    let carried: Vec<&str> = CALLBACKS.iter().map(|(name, _)| *name).collect();
    assert_eq!(node["allowlistedCallbacks"], json!(carried));
}

/// Node `MODEL_PROXY_CALLBACKS` and the `ProxyEvent` variants that carry each on the typed wire.
const CALLBACKS: [(&str, &str); 8] = [
    ("onStageChange", "accountSwitching | accountChanged | notice"),
    ("onStreamDelta", "progress | chunkProgress"),
    ("onTextDelta", "textDelta"),
    ("onReasoningDelta", "reasoningDelta"),
    ("onTextReset", "attemptDiscarded"),
    ("onStreamItemStart", "itemStart"),
    ("onToolCall", "toolCallDone"),
    ("onToolExcluded", "toolExcluded"),
];
