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

/// What the scripted provider does on its one attempt: the events its stream yields, and the tools it reports left out
/// at the points it is told to. Every request it is sent is kept.
struct Script {
    inner: MockProvider,
    /// The tools it reports left out, each once that many events were yielded (0: before the first).
    reports: Vec<(usize, p::ToolExclusionReport)>,
    events: Vec<p::StreamEvent>,
    seen: Mutex<Vec<p::ModelRequest>>,
    /// A script that holds its first attempt until released, to keep a run in flight.
    hold: Option<Arc<Hold>>,
}

/// Holds the first attempt: `entered` tells the test it arrived, `release` lets it go.
struct Hold {
    armed: std::sync::atomic::AtomicBool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

/// The stream of a [`Script`]: its events, with the tools left out reported to the request's sink after `after` of them.
struct Scripted {
    events: VecDeque<p::StreamEvent>,
    yielded: usize,
    reports: VecDeque<(usize, p::ToolExclusionReport)>,
    sink: Option<p::ToolExclusionSink>,
}

#[async_trait]
impl p::ModelStream for Scripted {
    async fn next(&mut self) -> Option<Result<p::StreamEvent, p::ProviderError>> {
        while self.reports.front().is_some_and(|(after, _)| self.yielded >= *after) {
            let (_, report) = self.reports.pop_front().expect("a report is due");
            if let Some(sink) = &self.sink {
                sink.report(report);
            }
        }
        self.yielded += 1;
        self.events.pop_front().map(Ok)
    }
    fn delivery(&self) -> p::DeliveryState {
        p::DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
}

pub(super) struct Events(pub(super) VecDeque<p::StreamEvent>);

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
        if let Some(hold) = &self.hold
            && hold.armed.swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            hold.entered.notify_one();
            tokio::time::timeout(std::time::Duration::from_secs(5), hold.release.notified()).await.expect("the test to release the first attempt it holds");
        }
        Ok(Box::new(Scripted {
            events: self.events.iter().cloned().collect(),
            yielded: 0,
            reports: self.reports.iter().cloned().collect(),
            sink: request.options.on_tool_excluded.clone(),
        }))
    }
}

pub(super) fn answer(text: &str) -> Vec<p::StreamEvent> {
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

pub(super) struct Offline;
#[async_trait]
impl mixdog_ai::transport::HttpSend for Offline {
    async fn send(&self, _: p::WireRequest, _: mixdog_ai::transport::Exchange) -> Result<mixdog_ai::transport::HttpResponse, p::ProviderError> {
        Err(p::ProviderError::new(p::ErrorKind::Transient, p::DeliveryState::NotSent))
    }
}

/// The `modelProxy/run/event` notifications, by connection.
#[derive(Default)]
pub(super) struct Notes(Mutex<Vec<(ConnectionId, String, Value)>>);

impl ConnectionNotifier for Notes {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        self.0.lock().unwrap().push((to, method.as_str().to_owned(), params));
        Ok(())
    }
}

impl Notes {
    /// The typed events of run `run_id`, in order.
    pub(super) fn events(&self, run_id: &str) -> Vec<w::ProxyEvent> {
        let notes = self.0.lock().unwrap();
        notes
            .iter()
            .filter(|(_, method, params)| method == "modelProxy/run/event" && params["runId"] == run_id)
            .map(|(_, _, params)| serde_json::from_value(params["event"].clone()).expect("a typed event"))
            .collect()
    }
}

async fn service(script: Arc<Script>) -> (ModelProxyService, Arc<Notes>) {
    service_of(Arc::new(Lookup(script)), Arc::new(NoQuota), Arc::new(NoConfig), None).await
}

/// The service the daemon registers, over this PC's provider lookup, quota probe and config; `catalog` is the PC's
/// catalog (an empty cold one when `None`).
pub(super) async fn service_of(
    providers: Arc<dyn ProviderLookup>,
    quota: Arc<dyn QuotaProbe>,
    config: Arc<dyn ProviderConfigSource>,
    catalog: Option<Arc<mixdog_ai::catalog::CatalogService>>,
) -> (ModelProxyService, Arc<Notes>) {
    let catalog = match catalog {
        Some(catalog) => catalog,
        None => {
            let dir = tempfile::tempdir().unwrap();
            let tokens = mixdog_rt::testing::tokens();
            let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
            let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
            Arc::new(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), metadata).await)
        }
    };
    let broker = Arc::new(ModelBroker::new(Arc::new(Admission::new()), Arc::new(mixdog_ai::retry::StandardRetryDecider)));
    let runner = ProxyRunner { providers, broker, quota, wire: Arc::new(PcWireRouter), config, catalog };
    let notes = Arc::new(Notes::default());
    (ModelProxyService::new(Arc::new(runner), Arc::new(MockHostChannel::default()), notes.clone()), notes)
}

fn script(excluded: Vec<p::ToolExclusionReport>, events: Vec<p::StreamEvent>) -> Arc<Script> {
    script_reporting_after(0, excluded, events)
}

/// A script that reports the tools it left out once `after` of its events were yielded.
fn script_reporting_after(after: usize, excluded: Vec<p::ToolExclusionReport>, events: Vec<p::StreamEvent>) -> Arc<Script> {
    script_reporting_at(excluded.into_iter().map(|report| (after, report)).collect(), events)
}

/// A script that reports each tool it left out once its number of events were yielded.
fn script_reporting_at(reports: Vec<(usize, p::ToolExclusionReport)>, events: Vec<p::StreamEvent>) -> Arc<Script> {
    Arc::new(Script { inner: MockProvider::new(Vec::<MockAttempt>::new()), reports, events, seen: Mutex::new(Vec::new()), hold: None })
}

/// A script whose first attempt waits for its `release`.
fn held_script(events: Vec<p::StreamEvent>) -> (Arc<Script>, Arc<Hold>) {
    let hold = Arc::new(Hold { armed: std::sync::atomic::AtomicBool::new(true), entered: tokio::sync::Notify::new(), release: tokio::sync::Notify::new() });
    let script = Arc::new(Script { inner: MockProvider::new(Vec::<MockAttempt>::new()), reports: Vec::new(), events, seen: Mutex::new(Vec::new()), hold: Some(hold.clone()) });
    (script, hold)
}

/// `modelProxy/run` of a send to "openai", as the relaying connection asks it.
fn run(run_id: &str, request: &p::ModelRequest) -> CoreRequest {
    let call = w::ProxyCall::Send { provider: "openai".into(), request: Box::new(request_out(request)) };
    run_call(run_id, &call, None, ConnectionId(1), CancellationToken::new())
}

/// `modelProxy/run` of `call` from connection `from`, with the providers its host may use and the request's own
/// cancel token (a child of the connection's: it is cancelled when the connection goes).
pub(super) fn run_call(run_id: &str, call: &w::ProxyCall, allowed: Option<&[&str]>, from: ConnectionId, cancel: CancellationToken) -> CoreRequest {
    CoreRequest {
        method: Method("modelProxy/run"),
        params: json!({ "runId": run_id, "call": call, "allowedProviders": allowed }),
        op: None,
        ctx: CallContext::connection(from, mixdog_protocol::Origin::Local, cancel),
    }
}

pub(super) fn request(messages: Vec<p::Message>) -> p::ModelRequest {
    p::ModelRequest { model: "gpt".into(), messages, tools: Vec::new(), options: p::RequestOptions::default() }
}

pub(super) async fn answered(service: &ModelProxyService, call: CoreRequest) -> Value {
    let Reply::Value(answer) = service.call(call).await.expect("a run answers") else { panic!("not a value") };
    answer["result"].clone()
}

/// The streamed text of a run (Node's send result `content`).
pub(super) fn content(events: &[w::ProxyEvent]) -> String {
    events.iter().filter_map(|e| if let w::ProxyEvent::TextDelta { text } = e { Some(text.as_str()) } else { None }).collect()
}

/// The manifest's `replay.fieldMap`: the typed events a K1 server receives for the server callbacks Node's host relayed,
/// in the order the recording's wire carried them (`modelProxyEvent` operations, `[id, "[{name, args}]"]`). A callback with
/// no typed event (`onStreamDelta`, whose free text is unrepresentable) maps to none.
fn typed_in_recorded_order(wire: &[Value]) -> Vec<w::ProxyEvent> {
    let text = |v: &Value| v.as_str().unwrap().to_owned();
    let mut events = Vec::new();
    for operation in wire.iter().filter(|op| op["direction"] == "pc->daemon" && op["operation"] == "modelProxyEvent") {
        let sent: Vec<Value> = serde_json::from_str(operation["text"].as_str().unwrap()).unwrap();
        let callbacks: Vec<Value> = serde_json::from_str(sent[1].as_str().unwrap()).unwrap();
        for callback in callbacks {
            let args = &callback["args"];
            match callback["name"].as_str().unwrap() {
                "onStageChange" => events.push(match args[0].as_str().unwrap() {
                    "account-changed" => w::ProxyEvent::AccountChanged { provider: text(&args[1]["provider"]), at: args[1]["at"].as_i64().unwrap() },
                    "reconnecting" => w::ProxyEvent::AccountSwitching { message: text(&args[1]["message"]) },
                    other => panic!("stage {other} has no mapping"),
                }),
                "onToolExcluded" => events.push(w::ProxyEvent::ToolExcluded {
                    name: text(&args[0]["name"]),
                    index: args[0]["index"].as_u64().unwrap(),
                    pointer: text(&args[0]["pointer"]),
                    reason: text(&args[0]["reason"]),
                    message: text(&args[0]["message"]),
                }),
                "onStreamDelta" => {}
                other => panic!("callback {other} has no mapping"),
            }
        }
    }
    events
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

/// Case 3, the call bound: a call is one `modelProxy/run` frame of at most `maxInboundFrameBytes`, and a run streams
/// notifications and asks the peer nothing, so no reply of the peer is ever read. What the calls in flight may hold
/// together is the service's own bound, `a_call_that_would_take_the_data_held_past_its_bound_is_refused_as_busy`.
#[test]
fn a_peer_holds_at_most_its_in_flight_runs_each_one_bounded_frame() {
    let node = observed("payloads past the aggregate in-flight limit are refused, and so are oversized event replies");
    let limits = Limits::default();
    let spec = mixdog_app_protocol::client_method_spec("modelProxy/run").expect("a method of the table");
    assert_eq!(spec.class, RequestClass::C2);
    // Node's 2,000-character payload is one frame; one past the bound is refused before it is parsed.
    let frame = |chars: usize| json!({ "jsonrpc": "2.0", "id": 1, "method": "modelProxy/run", "params": { "runId": "r", "call": { "method": "send", "provider": "openai", "request": { "pad": "x".repeat(chars) } } } }).to_string();
    let small = frame(node["payloadChars"].as_u64().unwrap() as usize);
    assert!(matches!(decode_inbound_text(&small, limits.max_inbound_frame_bytes as usize), InboundText::Message(_)));
    let over = frame(limits.max_inbound_frame_bytes as usize);
    assert_eq!(decode_inbound_text(&over, limits.max_inbound_frame_bytes as usize), InboundText::TooLarge);
}

/// Case 3, the aggregate bound: a second call that would take the payload this PC holds for the server past its bound is
/// refused with Node's `MODEL_PROXY_BUSY` (429) and its words, before any provider is looked up; the share a finished call
/// held goes back, so the same call is then served. Node's host option `maxInflightBytes` is the recording's 3,000.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_that_would_take_the_data_held_past_its_bound_is_refused_as_busy() {
    let node = observed("payloads past the aggregate in-flight limit are refused, and so are oversized event replies");
    let rejected = &node["secondCall"]["rejected"];
    let payload = "x".repeat(node["payloadChars"].as_u64().unwrap() as usize);
    let (script, hold) = held_script(answer("ok"));
    let (service, _) = service(script.clone()).await;
    let service = Arc::new(service.with_inflight_bound(node["maxInflightBytes"].as_u64().unwrap() as usize));
    let big = request(vec![p::Message::new(p::Role::User, p::Content::Text(payload))]);

    let first = tokio::spawn({
        let (service, call) = (service.clone(), run("r1", &big));
        async move { answered(&service, call).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), hold.entered.notified()).await.expect("the first call to reach its provider");

    let refused = answered(&service, run("r2", &big)).await;
    assert_eq!(refused["result"], "failed");
    let failure = &refused["failure"];
    assert_eq!((failure["code"].as_str(), failure["status"].as_u64(), failure["message"].as_str()), (rejected["code"].as_str(), rejected["props"]["status"].as_u64(), rejected["message"].as_str()));
    assert_eq!(script.seen.lock().unwrap().len(), 1, "the refused call never reached a provider");

    hold.release.notify_one();
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), first).await.expect("the first call to end").unwrap();
    assert_eq!(first["result"], "sent");
    assert_eq!(answered(&service, run("r3", &big)).await["result"], "sent", "the share the first call held is back");
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
    let answers = tokio::time::timeout(std::time::Duration::from_secs(30), futures::future::join_all(runs))
        .await
        .expect("all 30 concurrent modelProxy/run calls to answer");
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
    // What the provider reports is what Node's real account pool and request builder reported (the recording's `stages` and
    // `excluded`, which the PC host had redacted before they crossed): the tool name carries the credential-shaped text of the
    // recorded input tool, so the report the provider makes is the recorded one with that text back.
    let raw_name = node["tools"][0]["name"].as_str().unwrap();
    let recorded = &node["excluded"][0];
    let redacted_name = recorded["name"].as_str().unwrap();
    let excluded = p::ToolExclusionReport {
        name: raw_name.into(),
        index: recorded["index"].as_u64().unwrap() as usize,
        pointer: recorded["pointer"].as_str().unwrap().into(),
        reason: recorded["reason"].as_str().unwrap().into(),
        message: recorded["message"].as_str().unwrap().replace(redacted_name, raw_name),
    };
    let [switching, changed] = [&node["stages"][0][1], &node["stages"][1][1]];
    let account_id = node["accounts"][1].as_str().unwrap();
    let mut events = vec![
        p::StreamEvent::AccountStage(p::AccountStage::Switching { message: switching["message"].as_str().unwrap().into() }),
        p::StreamEvent::AccountStage(p::AccountStage::Changed { provider: changed["provider"].as_str().unwrap().into(), account_id: account_id.into(), at: changed["at"].as_i64().unwrap() }),
    ];
    // The recorder's scripted `send` returns `{ content: 'ok' }`: the provider is scripted from that, never from the
    // recorded result, whose content the core's own events must fold to.
    events.extend(answer("ok"));
    // The order of the recording is the order a real send raises these in (b6f10295a): the adapter builds its request body, and
    // so reports the tools it leaves out, at the start of each account attempt (gemini-request-body.mjs:66, antigravity-request.mjs:260);
    // the account pool announces the switch to the next account after a refused attempt (account-pool.mjs:625), the next attempt
    // reports again, and the committed change comes last, after the answer (account-pool.mjs:586). The provider is scripted the
    // same way: its report before its first event, the switch, the report again, the change.
    let (service, notes) = service(script_reporting_at(vec![(0, excluded.clone()), (1, excluded)], events)).await;
    let hi = request(vec![p::Message::new(p::Role::User, p::Content::Text("hi".into()))]);
    assert_eq!(answered(&service, run("r5", &hi)).await["result"], "sent");
    let got = notes.events("r5");
    // The whole ordered list of the run: the callbacks in the order Node's wire carried them, then the text, and the end
    // the scripted stream names.
    let mut want = typed_in_recorded_order(node["wire"].as_array().unwrap());
    want.push(w::ProxyEvent::TextDelta { text: node["result"]["content"].as_str().unwrap().to_owned() });
    want.push(w::ProxyEvent::Completed { stop: Some(w::ProxyStop::EndTurn), pricing_model: None, request_ms: None });
    assert_eq!(got, want);
    let wire = serde_json::to_string(&got).unwrap();
    assert!(!wire.contains(account_id) && !wire.contains("sk-DUMMY-"), "{wire}");
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
