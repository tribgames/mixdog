//! Replay of the call cases of `native/core/fixtures/model-proxy-host-cases` through the product's entry:
//! `modelProxy/run` (and `modelProxy/cancel`) on `ModelProxyService` over `ProxyRunner`, the service the daemon
//! registers (compose_flip.rs), with this PC's `PcQuotaProbe`, `PcWireRouter` and `PcProviderConfig` where a case
//! reads them. Node's claim/event/resolve/heartbeat host is a replaced protocol (mixdog-app-protocol/src/inventory.rs
//! marks it Deleted); what each case pins is compared through the manifest's `replay.fieldMap`: Node's callbacks by
//! [`typed_of_callbacks`], Node's rejections by [`node_failure`] against [`typed_failure`]. Both helpers consume
//! every key Node recorded and panic on one they do not map.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_ai::service::model_proxy::public_provider_config;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::rpc::InboundText;
use mixdog_app_protocol::rpc::decode_inbound_text;
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_core_api::CoreError;
use mixdog_core_api::DomainService;
use mixdog_core_api::domain::mock::MockAttempt;
use mixdog_core_api::domain::mock::MockProvider;
use mixdog_core_api::domain::provider as p;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderConfigSource;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderLookup;
use mixdog_core_domains::domains::ai_admin::model_proxy::QuotaProbe;
use mixdog_core_domains::domains::ai_admin::model_proxy::request_out;
use mixdog_core_domains::domains::ai_admin::model_proxy_service::ModelProxyService;
use mixdog_rt::CancellationToken;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::model_proxy_host_config_replay_tests::pc;
use super::model_proxy_host_config_replay_tests::scripted;
use super::model_proxy_pc::PcProviderConfig;
use super::model_proxy_pc::PcQuotaProbe;
use super::model_proxy_pc::PcRegistry;
use super::model_proxy_pc::QuotaMeasure;
use super::model_proxy_trust_replay_tests::Notes;
use super::model_proxy_trust_replay_tests::content;
use super::model_proxy_trust_replay_tests::request;
use super::model_proxy_trust_replay_tests::run_call;
use super::model_proxy_trust_replay_tests::service_of;
use super::quota_usage::Measured;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/model-proxy-host-cases/golden.json");

fn observed(case: &str) -> Value {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    golden["cases"].as_array().unwrap().iter().find(|c| c["case"] == case).unwrap_or_else(|| panic!("{case} is recorded"))["observed"].clone()
}

// -- this PC's scripted provider ------------------------------------------------------------------

/// One attempt of the scripted provider: the events (an `Err` ends it), or a stream that never yields.
enum Attempt {
    Stream(Vec<Result<p::StreamEvent, p::ProviderError>>),
    Hang,
}

struct Scripted {
    inner: MockProvider,
    attempts: Mutex<VecDeque<Attempt>>,
    seen: Mutex<Vec<p::ModelRequest>>,
    /// Holds a permit once an attempt has begun.
    started: Notify,
    /// Holds a permit once a hanging attempt was dropped (the PC provider saw the abort).
    aborted: Arc<Notify>,
    budget: fn(&str) -> Option<p::FirstResponseBudget>,
    /// The transport scopes released, in order (`releaseTransportScope`).
    released: Mutex<Vec<String>>,
}

fn provider(attempts: Vec<Attempt>) -> Arc<Scripted> {
    Arc::new(Scripted {
        inner: MockProvider::new(Vec::<MockAttempt>::new()),
        attempts: Mutex::new(attempts.into()),
        seen: Mutex::new(Vec::new()),
        started: Notify::new(),
        aborted: Arc::new(Notify::new()),
        budget: |_| None,
        released: Mutex::new(Vec::new()),
    })
}

struct Events(VecDeque<Result<p::StreamEvent, p::ProviderError>>);

#[async_trait]
impl p::ModelStream for Events {
    async fn next(&mut self) -> Option<Result<p::StreamEvent, p::ProviderError>> {
        self.0.pop_front()
    }
    fn delivery(&self) -> p::DeliveryState {
        p::DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
}

struct Hanging(Arc<Notify>);

#[async_trait]
impl p::ModelStream for Hanging {
    async fn next(&mut self) -> Option<Result<p::StreamEvent, p::ProviderError>> {
        std::future::pending().await
    }
    fn delivery(&self) -> p::DeliveryState {
        p::DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
}

impl Drop for Hanging {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

#[async_trait]
impl p::ProviderAdapter for Scripted {
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
    fn first_response_budget(&self, model: &str, _: Option<&mixdog_protocol::JsonValue>) -> Option<p::FirstResponseBudget> {
        (self.budget)(model)
    }
    fn release_transport_scope(&self, scope: &str) {
        self.released.lock().unwrap().push(scope.to_owned());
    }
    async fn attempt(&self, request: Arc<p::ModelRequest>) -> Result<Box<dyn p::ModelStream>, p::ProviderError> {
        self.seen.lock().unwrap().push((*request).clone());
        self.started.notify_one();
        match self.attempts.lock().unwrap().pop_front().expect("the case scripts every attempt") {
            Attempt::Stream(events) => Ok(Box::new(Events(events.into()))),
            Attempt::Hang => Ok(Box::new(Hanging(self.aborted.clone()))),
        }
    }
}

fn completed() -> p::StreamEvent {
    p::StreamEvent::Completed { stop: Some(p::StopReason::EndTurn), pricing_model: None, request_ms: None }
}

fn answering(text: &str) -> Attempt {
    Attempt::Stream(vec![Ok(p::StreamEvent::TextDelta(text.into())), Ok(completed())])
}

/// Node's `fakeRuntime(providers)`: the PC's providers by name, every one reachable.
struct Names(Vec<(&'static str, Arc<dyn p::ProviderAdapter>)>);

#[async_trait]
impl ProviderLookup for Names {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        self.0.iter().find(|(n, _)| *n == name).map(|(_, a)| a.clone())
    }
}

fn names(list: &[(&'static str, &Arc<Scripted>)]) -> Arc<Names> {
    Arc::new(Names(list.iter().map(|(n, a)| (*n, (*a).clone() as Arc<dyn p::ProviderAdapter>)).collect()))
}

struct Unused;

#[async_trait]
impl QuotaProbe for Unused {
    async fn usable(&self, _: &str, _: &str) -> Result<bool, String> {
        unreachable!("the case asks for no quota")
    }
}

#[async_trait]
impl ProviderConfigSource for Unused {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String> {
        unreachable!("the case asks for no provider config")
    }
}

/// Node's scripted `runtime.providerConfig()`, through this PC's public projection (`public_provider_config`).
struct Configured(Value);

#[async_trait]
impl ProviderConfigSource for Configured {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String> {
        let public = public_provider_config(&self.0["providers"], &|_| true);
        let providers = public.as_object().unwrap().iter().map(|(n, v)| (n.clone(), serde_json::from_value(v.clone()).unwrap())).collect();
        Ok((providers, self.0["ready"] != false))
    }
}

// -- the field map ---------------------------------------------------------------------------------

/// `modelProxy/run` of `call` from `from`, answered: the `ProxyAnswer` as JSON.
async fn ask(service: &ModelProxyService, run_id: &str, call: w::ProxyCall, allowed: Option<&[&str]>, from: u64) -> Value {
    super::model_proxy_trust_replay_tests::answered(service, run_call(run_id, &call, allowed, ConnectionId(from), CancellationToken::new())).await
}

fn send(provider: &str, request: &p::ModelRequest) -> w::ProxyCall {
    w::ProxyCall::Send { provider: provider.into(), request: Box::new(request_out(request)) }
}

fn hi() -> p::ModelRequest {
    let mut sent = request(vec![p::Message::new(p::Role::User, p::Content::Text("hi".into()))]);
    sent.model = "gpt".into();
    sent
}

/// The manifest's `replay.fieldMap.failure`, Node side: a rejected call's error as the typed failure fields it maps to.
/// `name: "AbortError"` is the cancelled run (delivery `ambiguous`, kind `transient`), `name: "Error"` any other;
/// `props.status` is `status`, `props.retryAfter` (seconds) is `retryAfterMs`, `props.liveTextEmitted` is
/// `textEmitted`. `props.partialContent` is the text streamed before the failure, compared by the case.
fn node_failure(error: &Value) -> Value {
    let error = error.as_object().unwrap();
    let mut out = Map::new();
    for (key, value) in error {
        match key.as_str() {
            "$exact" => assert_eq!(value, "error"),
            "name" => {
                out.insert("cancelled".into(), json!(value == "AbortError"));
            }
            "message" => {
                out.insert("message".into(), value.clone());
            }
            "code" => {
                out.insert("code".into(), value.clone());
            }
            "props" => {
                for (prop, value) in value.as_object().unwrap() {
                    match prop.as_str() {
                        "name" => assert_eq!(Some(value), error.get("name"), "props.name is the class name"),
                        "status" => {
                            out.insert("status".into(), value.clone());
                        }
                        "retryAfter" => {
                            out.insert("retryAfterMs".into(), json!(value.as_u64().unwrap() * 1_000));
                        }
                        "liveTextEmitted" => {
                            out.insert("textEmitted".into(), value.clone());
                        }
                        "partialContent" => {}
                        other => panic!("props.{other} has no mapping"),
                    }
                }
            }
            other => panic!("{other} has no mapping"),
        }
    }
    Value::Object(out)
}

/// The typed side of [`node_failure`]: the fields of `answer`'s failure that the Node error names.
fn typed_failure(answer: &Value, node: &Value) -> Value {
    assert_eq!(answer["result"], "failed", "{answer}");
    let failure = &answer["failure"];
    node.as_object()
        .unwrap()
        .keys()
        .map(|key| {
            let value = match key.as_str() {
                "cancelled" => json!(failure["delivery"] == "ambiguous" && failure["kind"] == "transient"),
                "code" => failure["code"].clone(),
                other => failure[other].clone(),
            };
            (key.clone(), value)
        })
        .collect()
}

fn same_failure(answer: &Value, node_error: &Value, what: &str) {
    let node = node_failure(node_error);
    assert_eq!(typed_failure(answer, &node), node, "{what}");
    // A field Node did not set is unset on the typed failure too.
    if node.get("code").is_none() {
        assert_eq!(answer["failure"]["code"], Value::Null, "{what}: code");
    }
}

/// The manifest's `replay.fieldMap.callbacks`: Node's server callbacks, in order, as the typed events that carry
/// them. `["stage", "streaming"]` is `outputStarted`, `["text", t]` is `textDelta`, `["reset", chars]` is
/// `attemptDiscarded` (`chars` being the text of the attempt it discards).
fn typed_of_callbacks(callbacks: &[Value]) -> Vec<w::ProxyEvent> {
    let mut since_reset = 0;
    callbacks
        .iter()
        .map(|callback| match (callback[0].as_str().unwrap(), &callback[1]) {
            ("stage", stage) => {
                assert_eq!(stage, "streaming", "the only stage a provider send raises here");
                w::ProxyEvent::OutputStarted
            }
            ("text", text) => {
                since_reset += text.as_str().unwrap().chars().count();
                w::ProxyEvent::TextDelta { text: text.as_str().unwrap().into() }
            }
            ("reset", chars) => {
                assert_eq!(chars.as_u64().unwrap() as usize, since_reset, "the reset drops what the attempt showed");
                since_reset = 0;
                w::ProxyEvent::AttemptDiscarded
            }
            (other, _) => panic!("callback {other} has no mapping"),
        })
        .collect()
}

/// A run in flight: its answer is pending.
async fn pending<F: std::future::Future + Unpin>(future: &mut F) {
    assert!(futures::poll!(future).is_pending(), "the run is in flight");
}

// -- quota ---------------------------------------------------------------------------------------

/// Node's `measureProviderQuota` / `quotaMeasurementServesModel` of case 0: every call recorded, `gpt-usable` usable.
#[derive(Default)]
struct Policy(Mutex<Vec<Value>>);

#[async_trait]
impl QuotaMeasure for Policy {
    async fn measure(&self, provider: &str) -> Result<Measured, String> {
        self.0.lock().unwrap().push(json!({ "name": provider }));
        Ok(Measured::None)
    }
    async fn serves(&self, provider: &str, _: &Measured, model: &str, _: i64) -> Result<bool, String> {
        self.0.lock().unwrap().push(json!({ "name": provider, "model": model }));
        Ok(model == "gpt-usable")
    }
}

/// Node's `getProvider: () => provider`: one instance under every name.
struct OneInstance(Arc<dyn p::ProviderAdapter>);

#[async_trait]
impl PcRegistry for OneInstance {
    async fn apply(&self, _: &Map<String, Value>) -> Result<(), String> {
        Ok(())
    }
    fn live(&self) -> Vec<(String, Arc<dyn p::ProviderAdapter>)> {
        Vec::new()
    }
    async fn get(&self, _: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        Some(self.0.clone())
    }
}

/// Case 0: `quotaUsable` is refused for a provider the host may not use and for one this PC's config does not enable;
/// otherwise this PC's policy measures the provider and judges the model.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quota_requests_use_the_pc_policy_after_the_provider_guards() {
    let node = observed("quota requests use the PC policy with the selected provider and model, after provider guards");
    let policy = Arc::new(Policy::default());
    let providers = node["providers"].as_object().unwrap().clone();
    let config = Arc::new(PcProviderConfig::new(Arc::new(move || providers.clone()), Arc::new(OneInstance(provider(Vec::new()))), scripted("present")));
    let (service, _) = service_of(config, Arc::new(PcQuotaProbe::new(policy.clone(), Arc::new(|| 0))), Arc::new(Unused), None).await;
    // Node's `isProviderAllowed: (name) => name !== deniedProvider`, as the host's list.
    let denied = node["deniedProvider"].as_str().unwrap();
    let allowed: Vec<&str> = ["openai-oauth", "anthropic-oauth", "grok-oauth"].into_iter().filter(|n| *n != denied).collect();
    for usable in node["usable"].as_array().unwrap() {
        let call = w::ProxyCall::QuotaUsable { provider: "openai-oauth".into(), model: usable["model"].as_str().unwrap().into() };
        assert_eq!(ask(&service, "q", call.clone(), Some(&allowed), 1).await, json!({ "result": "usable", "usable": usable["answer"] }));
    }
    for refused in node["refused"].as_array().unwrap() {
        let call = w::ProxyCall::QuotaUsable { provider: refused["provider"].as_str().unwrap().into(), model: "test".into() };
        same_failure(&ask(&service, "q", call.clone(), Some(&allowed), 1).await, &refused["rejected"], refused["provider"].as_str().unwrap());
    }
    // `providerIsTheRegistryProvider`: the measurement is of the provider by its registry name.
    let want: Vec<Value> = node["policyCalls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|call| match call.get("providerIsTheRegistryProvider") {
            Some(is) => {
                assert_eq!(is, true);
                json!({ "name": call["name"] })
            }
            None => call.clone(),
        })
        .collect();
    assert_eq!(*policy.0.lock().unwrap(), want);
}

/// Node's case-1 measurement: counted, held while gated, failing while `fail`; `gpt-a` is servable.
#[derive(Default)]
struct Gated {
    measurements: AtomicUsize,
    gated: AtomicBool,
    fail: AtomicBool,
    began: Notify,
    release: Notify,
}

#[async_trait]
impl QuotaMeasure for Gated {
    async fn measure(&self, _: &str) -> Result<Measured, String> {
        self.measurements.fetch_add(1, Ordering::SeqCst);
        self.began.notify_one();
        if self.gated.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err("usage fetch failed".into());
        }
        Ok(Measured::None)
    }
    async fn serves(&self, _: &str, _: &Measured, model: &str, _: i64) -> Result<bool, String> {
        Ok(model == "gpt-a")
    }
}

/// Case 1: one measurement per provider for 60 s, shared by the runs of two connections; a failed one is not kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quota_requests_share_one_measurement_per_window() {
    let node = observed("quota requests share one account-wide measurement per provider; models are judged against it, never retained");
    let gated = Arc::new(Gated::default());
    let clock = Arc::new(AtomicI64::new(node["startClock"].as_i64().unwrap()));
    let now = clock.clone();
    let probe = PcQuotaProbe::new(gated.clone(), Arc::new(move || now.load(Ordering::SeqCst)));
    let lookup = names(&[("openai-oauth", &provider(Vec::new()))]);
    let (service, _) = service_of(lookup, Arc::new(probe), Arc::new(Unused), None).await;
    let quota = |model: &str| w::ProxyCall::QuotaUsable { provider: "openai-oauth".into(), model: model.into() };
    let usable = |answer: Value| {
        assert_eq!(answer["result"], "usable", "{answer}");
        answer["usable"].clone()
    };
    let measurements = || gated.measurements.load(Ordering::SeqCst);
    let window = node["windowMs"].as_i64().unwrap();
    let mut log = Vec::new();

    gated.gated.store(true, Ordering::SeqCst);
    let burst = futures::future::join_all([("gpt-a", 1), ("junk-1", 2), ("gpt-a", 2), ("junk-2", 1)].map(|(model, from)| ask(&service, model, quota(model), None, from)));
    tokio::pin!(burst);
    mixdog_core_session::session::testing::awaiting(|| "the burst to begin a measurement".to_owned(), async {
        tokio::select! {
            biased;
            () = gated.began.notified() => gated.release.notify_one(),
            _ = &mut burst => panic!("the burst ended before a measurement began"),
        }
    })
    .await;
    let answers: Vec<Value> = burst.await.into_iter().map(usable).collect();
    gated.gated.store(false, Ordering::SeqCst);
    log.push(json!({ "step": "concurrent on two connections", "answers": answers, "measurements": measurements() }));

    let mut all_false = true;
    for i in 0..50 {
        let model = format!("junk-{i}");
        all_false &= usable(ask(&service, "q", quota(&model), None, if i % 2 == 1 { 1 } else { 2 }).await) == false;
    }
    let gpt_a = usable(ask(&service, "q", quota("gpt-a"), None, 2).await);
    log.push(json!({ "step": "50 other models in the window", "allFalse": all_false, "gptA": gpt_a, "measurements": measurements() }));
    clock.fetch_add(window - 1, Ordering::SeqCst);
    usable(ask(&service, "q", quota("gpt-a"), None, 1).await);
    log.push(json!({ "step": "clock +59999", "measurements": measurements() }));
    clock.fetch_add(1, Ordering::SeqCst);
    usable(ask(&service, "q", quota("gpt-a"), None, 1).await);
    log.push(json!({ "step": "clock +1 (window over)", "measurements": measurements() }));
    let long = usable(ask(&service, "q", quota(&"x".repeat(257)), None, 1).await);
    log.push(json!({ "step": "long model name (257 chars)", "answer": long, "measurements": measurements() }));
    clock.fetch_add(window, Ordering::SeqCst);
    gated.fail.store(true, Ordering::SeqCst);
    let fail_a = ask(&service, "q", quota("gpt-a"), None, 1).await;
    let fail_b = ask(&service, "q", quota("gpt-a"), None, 2).await;
    let node_log = node["log"].as_array().unwrap();
    let failed = &node_log[5];
    same_failure(&fail_a, &failed["failA"]["rejected"], "failA");
    same_failure(&fail_b, &failed["failB"]["rejected"], "failB");
    log.push(json!({ "step": "failed measurement is not cached", "failA": failed["failA"], "failB": failed["failB"], "measurements": measurements() }));
    gated.fail.store(false, Ordering::SeqCst);
    let recovered = usable(ask(&service, "q", quota("gpt-a"), None, 1).await);
    log.push(json!({ "step": "after recovery", "answer": recovered, "measurements": measurements() }));
    assert_eq!(Value::Array(log), node["log"]);
}

// -- send ----------------------------------------------------------------------------------------

/// Case 2: the PC runs the call on its own provider and streams every event back in order; the request the provider
/// receives is the server's. Node's in-send `onTextReset` is the broker's discard of a failed attempt here.
#[tokio::test(start_paused = true)]
async fn the_pc_runs_the_call_and_streams_every_event_in_order() {
    let node = observed("the PC runs the call with its own provider and streams every callback back in order");
    let mut retryable = p::ProviderError::new(p::ErrorKind::Transient, p::DeliveryState::NotSent);
    retryable.message = "stream reset".into();
    let usage = &node["result"]["usage"];
    let usage = p::Usage { input_tokens: usage["inputTokens"].as_u64().unwrap(), output_tokens: usage["outputTokens"].as_u64().unwrap(), ..p::Usage::default() };
    let scripted = provider(vec![
        Attempt::Stream(vec![Ok(p::StreamEvent::OutputStarted), Ok(p::StreamEvent::TextDelta("Hel".into())), Ok(p::StreamEvent::TextDelta("lo".into())), Err(retryable)]),
        Attempt::Stream(vec![Ok(p::StreamEvent::TextDelta("again".into())), Ok(p::StreamEvent::Usage(usage.clone())), Ok(completed())]),
    ]);
    let (service, notes) = service_of(names(&[("anthropic-oauth", &scripted)]), Arc::new(Unused), Arc::new(Unused), None).await;
    let call = &node["pcProviderCalls"][0];
    let tool = &call["tools"][0];
    let mut sent = request(vec![p::Message::new(p::Role::User, p::Content::Text(call["messages"][0]["content"].as_str().unwrap().into()))]);
    sent.model = call["model"].as_str().unwrap().into();
    sent.tools = vec![p::ToolDefinition { name: tool["name"].as_str().unwrap().into(), description: String::new(), input_schema: tool["input_schema"].clone(), defer_loading: false, freeform: None }];
    sent.options.session_id = Some(call["options"]["sessionId"].as_str().unwrap().into());
    let answer = ask(&service, "r2", send("anthropic-oauth", &sent), None, 1).await;
    assert_eq!(answer["result"], "sent", "{answer}");
    let events = notes.events("r2");
    // Every event of the run is one the field map names: the callbacks, the usage and the end.
    let callbacks: Vec<w::ProxyEvent> =
        events.iter().filter(|e| matches!(e, w::ProxyEvent::OutputStarted | w::ProxyEvent::TextDelta { .. } | w::ProxyEvent::AttemptDiscarded)).cloned().collect();
    assert_eq!(callbacks, typed_of_callbacks(node["callbacks"].as_array().unwrap()));
    assert_eq!(events.len(), callbacks.len() + 2, "{events:?}");
    assert!(matches!(&events[events.len() - 2], w::ProxyEvent::Usage { usage } if json!({ "inputTokens": usage.input_tokens, "outputTokens": usage.output_tokens }) == node["result"]["usage"]));
    assert!(matches!(events.last(), Some(w::ProxyEvent::Completed { .. })));
    // `result.content`: the stand-in's literal return ("Hello again", model-proxy-host.test.mjs:172), not what its
    // callbacks streamed. A typed provider's content is its stream, so the content is the text after the last
    // discard, which is the text Node's callbacks leave after their reset.
    let last_discard = events.iter().rposition(|e| *e == w::ProxyEvent::AttemptDiscarded).unwrap();
    let streamed: String = node["callbacks"].as_array().unwrap().iter().rev().take_while(|c| c[0] != "reset").filter(|c| c[0] == "text").map(|c| c[1].as_str().unwrap()).collect::<Vec<_>>().into_iter().rev().collect();
    assert_eq!(content(&events[last_discard..]), streamed);
    assert_eq!(node["result"]["content"], "Hello again", "the stand-in's literal, declared in the manifest");
    // `pcProviderCalls`: the messages, model, tools and session id the provider received, once per attempt.
    // `signal` is the run's cancel token and `toolExecutionSessionId: ''` has no typed field (no tool executes on this PC).
    let seen = scripted.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    for got in seen.iter() {
        assert_eq!((got.messages.clone(), got.model.clone(), got.tools.clone(), got.options.session_id.clone()), (sent.messages.clone(), sent.model.clone(), sent.tools.clone(), sent.options.session_id.clone()));
    }
    // `hostRunningAfter: 0` and `settledCalls`: the run is over and answered.
    assert_eq!(node["hostRunningAfter"], 0);
    assert_eq!(node["settledCalls"], json!([{ "provider": "anthropic-oauth", "outcome": "answered" }]));
    tokio::time::timeout(std::time::Duration::from_secs(5), service.close()).await.expect("no run is left running");
}

/// Case 3: the provider's wire reroute reaches the server unchanged (`wireRerouted`), with the answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_wire_reroute_reaches_the_server_unchanged() {
    let node = observed("the provider send result reaches the daemon unchanged, wireReroute included");
    let result = &node["providerResult"];
    let usage = p::Usage { input_tokens: result["usage"]["inputTokens"].as_u64().unwrap(), output_tokens: result["usage"]["outputTokens"].as_u64().unwrap(), ..p::Usage::default() };
    let scripted = provider(vec![Attempt::Stream(vec![
        Ok(p::StreamEvent::TextDelta(result["content"].as_str().unwrap().into())),
        Ok(p::StreamEvent::Usage(usage)),
        Ok(p::StreamEvent::WireRerouted(result["wireReroute"].clone())),
        Ok(completed()),
    ])]);
    let (service, notes) = service_of(names(&[("anthropic-oauth", &scripted)]), Arc::new(Unused), Arc::new(Unused), None).await;
    assert_eq!(ask(&service, "r3", send("anthropic-oauth", &hi()), None, 1).await["result"], "sent");
    let events = notes.events("r3");
    assert_eq!(content(&events), result["content"].as_str().unwrap());
    let rerouted: Vec<&Value> = events.iter().filter_map(|e| if let w::ProxyEvent::WireRerouted { route } = e { Some(route) } else { None }).collect();
    assert_eq!(rerouted, [&node["wireReroute"]]);
}

/// Case 4: a provider this PC lacks is refused by name, a method outside the typed call is refused before it runs,
/// and the listing is this PC's catalog.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pc_serves_only_the_named_provider_and_the_typed_calls() {
    let node = observed("the PC serves only the named provider and the allowed methods");
    let scripted = provider(Vec::new());
    let mut snapshot = mixdog_ai::catalog::CatalogSnapshot::default();
    let id = mixdog_protocol::ProviderId::from("openai");
    let rows = node["models"].as_array().unwrap().iter().map(|m| {
        let mut row = mixdog_ai::catalog::ModelRecord::new(id.clone(), m["id"].as_str().unwrap());
        row.context_window = if m["id"] == "model-a" { node["cachedA"]["contextWindow"].as_u64() } else { None };
        row
    });
    snapshot.models.insert(id.clone(), rows.collect());
    let catalog = catalog_of(snapshot).await;
    let (service, _) = service_of(names(&[("openai", &scripted)]), Arc::new(Unused), Arc::new(Configured(node["providerConfig"].clone())), Some(catalog)).await;
    same_failure(&ask(&service, "r4", send("gemini", &hi()), None, 1).await, &node["unavailable"]["rejected"], "unavailable");
    // `forgetCredentials` is no `ProxyCall`: the request is refused as invalid before anything of this PC runs.
    let forget = run_raw(&service, json!({ "method": "forgetCredentials", "provider": "openai" })).await;
    assert!(matches!(forget, Err(CoreError::InvalidParams { .. })), "{forget:?}");
    assert_eq!(node["forget"]["rejected"]["message"], "Model proxy method \"forgetCredentials\" is not allowed.");
    let listed = ask(&service, "r4", w::ProxyCall::ListModels { provider: "openai".into(), refresh: false }, None, 1).await;
    let ids: Vec<Value> = listed["models"].as_array().unwrap().iter().map(|m| json!({ "id": m["id"] })).collect();
    assert_eq!(Value::Array(ids), node["models"]);
    // `cachedA` / `cachedB`: the context window each row carries.
    assert_eq!(listed["models"][0]["contextWindow"], node["cachedA"]["contextWindow"]);
    assert_eq!((&listed["models"][1]["contextWindow"], &node["cachedB"]), (&Value::Null, &Value::Null));
    // `listCalls: ["list"]`: one listing, answered from this PC's catalog without a refresh.
    assert_eq!(node["listCalls"], json!(["list"]));
    let config = ask(&service, "r4", w::ProxyCall::ProviderConfig, None, 1).await;
    assert_eq!(json!({ "providers": config["providers"], "ready": config["ready"] }), node["providerConfig"]);
}

async fn catalog_of(snapshot: mixdog_ai::catalog::CatalogSnapshot) -> Arc<mixdog_ai::catalog::CatalogService> {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(super::model_proxy_trust_replay_tests::Offline), dir.path().to_path_buf(), io);
    Arc::new(mixdog_ai::catalog::CatalogService::cold_start(snapshot, Vec::new(), metadata).await)
}

/// `modelProxy/run` with a call as the peer wrote it.
async fn run_raw(service: &ModelProxyService, call: Value) -> Result<mixdog_core_api::Reply, CoreError> {
    let mut request = run_call("raw", &w::ProxyCall::ProviderConfig, None, ConnectionId(1), CancellationToken::new());
    request.params["call"] = call;
    service.call(request).await
}

/// Case 5, this PC's part: each listed model carries its own first-response budget; one the adapter has none for
/// (Node's `bare`, and `flash`, whose figure is not a number and so has no typed form) carries none; the config's
/// trait is the adapter's own figure.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_listing_carries_each_models_first_response_budget() {
    let node = observed("the PC reports its model-specific first-response budget through the catalog and provider config");
    let mut scripted = provider(Vec::new());
    Arc::get_mut(&mut scripted).unwrap().budget = |model| (model == "argon").then_some(p::FirstResponseBudget { transport_ms: 577_000, semantic_ms: 1_147_000 });
    assert_eq!(node["argon"], json!({ "transportMs": 577_000, "semanticMs": 1_147_000 }));
    let id = mixdog_protocol::ProviderId::from("antigravity-oauth");
    let mut snapshot = mixdog_ai::catalog::CatalogSnapshot::default();
    snapshot.models.insert(id.clone(), ["argon", "flash", "bare"].map(|m| mixdog_ai::catalog::ModelRecord::new(id.clone(), m)).into());
    let (service, _) = service_of(names(&[("antigravity-oauth", &scripted)]), Arc::new(Unused), Arc::new(Configured(node["config"].clone())), Some(catalog_of(snapshot).await)).await;
    let listed = ask(&service, "r5", w::ProxyCall::ListModels { provider: "antigravity-oauth".into(), refresh: false }, None, 1).await;
    let budgets: Vec<&Value> = listed["models"].as_array().unwrap().iter().map(|m| &m["firstResponseBudget"]).collect();
    assert_eq!(budgets, [&node["cachedArgon"]["firstResponseBudget"], &Value::Null, &Value::Null]);
    assert!(node["cachedFlash"].get("firstResponseBudget").is_none() && node["cachedBare"].is_null());
    let config = ask(&service, "r5", w::ProxyCall::ProviderConfig, None, 1).await;
    assert_eq!(json!({ "providers": config["providers"], "ready": config["ready"] }), node["config"]);
    assert_eq!(config["providers"]["antigravity-oauth"]["modelProxy"]["firstResponseBudget"], node["fallback"]);
}

// -- aborts --------------------------------------------------------------------------------------

/// Case 6: `modelProxy/cancel` from the server aborts the PC provider's call; the run answers the cancellation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_cancel_aborts_the_pc_provider_call() {
    let node = observed("a daemon-side abort aborts the PC provider call");
    let scripted = provider(vec![Attempt::Hang]);
    let (service, _) = service_of(names(&[("openai", &scripted)]), Arc::new(Unused), Arc::new(Unused), None).await;
    let mut run = Box::pin(ask(&service, "r6", send("openai", &hi()), None, 1));
    mixdog_core_session::session::testing::awaiting(|| "the PC call to start".to_owned(), async {
        tokio::select! {
            biased;
            () = scripted.started.notified() => {}
            answer = &mut run => panic!("the run ended before the provider call started: {answer}"),
        }
    })
    .await;
    // `runningWhileCalling: 1`.
    assert_eq!(node["runningWhileCalling"], 1);
    pending(&mut run).await;
    service.notify(Method("modelProxy/cancel"), json!({ "runId": "r6" }), ConnectionId(1));
    let answer = run.await;
    mixdog_core_session::session::testing::awaiting(|| "the PC provider to see the abort".to_owned(), scripted.aborted.notified()).await;
    same_failure(&answer, &node["pcAbortReason"], "pcAbortReason");
    same_failure(&answer, &node["settledCalls"][0]["error"], "settledCalls");
    assert_eq!((node["settledCalls"][0]["provider"].as_str(), node["settledCalls"][0]["outcome"].as_str()), (Some("openai"), Some("failed")));
    // `runningAfter: 0`.
    assert_eq!(node["runningAfter"], 0);
    tokio::time::timeout(std::time::Duration::from_secs(5), service.close()).await.expect("no run is left running");
}

/// Case 7's protection on the typed protocol: a run belongs to the request of a live connection; when the server's
/// connection goes (Node: silent past its lease), the request's cancel token ends the PC provider's call.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gone_server_connection_ends_its_runs() {
    let node = observed("a daemon silent past its lease makes the PC abandon every active call");
    assert_eq!((node["runningBefore"].as_u64(), node["runningAfter"].as_u64()), (Some(1), Some(0)));
    let scripted = provider(vec![Attempt::Hang]);
    let (service, _) = service_of(names(&[("openai", &scripted)]), Arc::new(Unused), Arc::new(Unused), None).await;
    let connection = CancellationToken::new();
    let mut run = Box::pin(super::model_proxy_trust_replay_tests::answered(&service, run_call("r7", &send("openai", &hi()), None, ConnectionId(1), connection.child_token())));
    mixdog_core_session::session::testing::awaiting(|| "the PC call to start".to_owned(), async {
        tokio::select! {
            biased;
            () = scripted.started.notified() => {}
            answer = &mut run => panic!("the run ended before the provider call started: {answer}"),
        }
    })
    .await;
    connection.cancel();
    let answer = run.await;
    mixdog_core_session::session::testing::awaiting(|| "the PC provider to see the abort".to_owned(), scripted.aborted.notified()).await;
    // Node's abandon is an abort of the provider call; its message reaches nobody on a closed connection.
    assert_eq!(node_failure(&node["abortReason"])["cancelled"], true);
    assert_eq!(typed_failure(&answer, &json!({ "cancelled": true })), json!({ "cancelled": true }));
}

/// Case 8: closing the service aborts every run; the PC provider sees the abort and the server is told the app is closing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_aborts_every_run() {
    let node = observed("disposing the host aborts and drops every active call");
    let scripted = provider(vec![Attempt::Hang]);
    let (service, _) = service_of(names(&[("openai", &scripted)]), Arc::new(Unused), Arc::new(Unused), None).await;
    let run = ask(&service, "r8", send("openai", &hi()), None, 1);
    let close = async {
        scripted.started.notified().await;
        service.close().await;
    };
    let (answer, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async { tokio::join!(run, close) }).await.expect("closing ends the run");
    mixdog_core_session::session::testing::awaiting(|| "the PC provider to see the abort".to_owned(), scripted.aborted.notified()).await;
    same_failure(&answer, &node["abortReason"], "abortReason");
    same_failure(&answer, &node["daemonOutcome"]["rejected"], "daemonOutcome");
    assert_eq!((node["runningBefore"].as_u64(), node["runningAfterDispose"].as_u64()), (Some(1), Some(0)));
}

// -- what a server may send ------------------------------------------------------------------------

/// Case 13: of the server's send options only the typed ones reach the provider; Node's `baseURL`, `requestHeaders`,
/// `extraBody`, `codexInstallationId` and `_providerSeam` are fields `ProxyOptions` does not have, dropped as the call
/// is read, and the server's `toolExecutionSessionId` has no typed field either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_send_options_are_reduced_to_the_typed_ones() {
    let node = observed("server send options are reduced to the allowlist");
    let options = &node["options"];
    let scripted = provider(vec![answering("ok")]);
    let (service, _) = service_of(names(&[("openai", &scripted)]), Arc::new(Unused), Arc::new(Unused), None).await;
    let mut call = serde_json::to_value(send("openai", &hi())).unwrap();
    for (key, value) in options.as_object().unwrap() {
        call["request"]["options"][key] = value.clone();
    }
    let mixdog_core_api::Reply::Value(answer) = run_raw(&service, call).await.expect("the call runs") else { panic!("not a value") };
    assert_eq!(answer["result"]["result"], "sent", "{answer}");
    let seen = scripted.seen.lock().unwrap();
    let got = &seen[0].options;
    let seen_node = &node["seen"];
    assert_eq!(got.session_id.as_deref(), seen_node["sessionId"].as_str());
    assert_eq!(got.temperature.map(p::Temperature::get), seen_node["temperature"].as_f64());
    assert_eq!(got.transport_scope, None);
    // `signal` is the run's cancel token; `toolExecutionSessionId: ''`: no tool executes on this PC.
    assert_eq!(seen_node["toolExecutionSessionId"], "");
    assert_eq!(seen_node.as_object().unwrap().keys().collect::<Vec<_>>(), ["sessionId", "temperature", "signal", "toolExecutionSessionId"]);
}

/// Case 15: a provider failure reaches the server with the recovery fields, its credential text redacted; the text
/// streamed before it (Node's `partialContent`) is the run's text events.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pc_failure_reaches_the_server_with_the_recovery_fields_redacted() {
    let node = observed("PC errors reach the server with only the recovery fields, credentials redacted");
    let thrown = &node["thrown"];
    let mut error = p::ProviderError::new(p::ErrorKind::Auth, p::DeliveryState::Accepted);
    error.message = "401 from upstream for key sk-DUMMY-abcdefghijklmnopqrstuvwxyz".into();
    error.code = Some("auth_failed".into());
    error.status = Some(401);
    error.retry_after = Some(std::time::Duration::from_secs(3));
    error.exposure.text_emitted = true;
    let partial = thrown["props"]["partialContent"].as_str().unwrap();
    let scripted = provider(vec![Attempt::Stream(vec![Ok(p::StreamEvent::TextDelta(partial.into())), Err(error)])]);
    let (service, notes) = service_of(names(&[("openai", &scripted)]), Arc::new(Unused), Arc::new(Unused), None).await;
    let answer = ask(&service, "r15", send("openai", &hi()), None, 1).await;
    same_failure(&answer, thrown, "thrown");
    assert_eq!(content(&notes.events("r15")), partial);
    let wire = answer.to_string();
    assert!(!wire.contains("sk-DUMMY-") && !wire.contains("internal.pc.example") && !wire.contains("pc-secret-token"), "{wire}");
}

/// Case 16: the config a server learns names availability and traits only, without the providers it may not use; a
/// send to one of those is refused by name.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_config_tells_traits_only_and_refuses_a_disallowed_provider() {
    let node = observed("providerConfig tells a server availability and traits only; disallowed providers are refused");
    // The recorder's `runtime.providerConfig()` answer (record-model-proxy-host-cases.mjs).
    let pc_config = json!({ "ready": true, "providers": {
        "openai": { "enabled": true, "baseURL": "https://corp.example/v1", "organization": "acme", "accountLabel": "work@acme.example", "modelProxy": { "nativePdf": true, "consumesReadWindows": true, "extra": "x" } },
        "mixdog-local": { "enabled": true, "modelProxy": { "nativePdf": false, "takesImages": false } },
        "custom-1": { "type": "custom", "enabled": true, "baseURL": "http://10.0.0.5" },
    } });
    let (openai, custom) = (provider(vec![answering("x")]), provider(Vec::new()));
    let (service, notes) = service_of(names(&[("openai", &openai), ("custom-1", &custom)]), Arc::new(Unused), Arc::new(Configured(pc_config)), None).await;
    let denied = node["deniedProvider"].as_str().unwrap();
    let allowed = ["openai", "mixdog-local"];
    assert!(!allowed.contains(&denied));
    let config = ask(&service, "r16", w::ProxyCall::ProviderConfig, Some(&allowed), 1).await;
    assert_eq!(json!({ "providers": config["providers"], "ready": config["ready"] }), node["advertised"]);
    same_failure(&ask(&service, "r16", send(denied, &hi()), Some(&allowed), 1).await, &node["customSend"]["rejected"], "customSend");
    assert_eq!(ask(&service, "r16b", send("openai", &hi()), Some(&allowed), 1).await["result"], "sent");
    assert_eq!(content(&notes.events("r16b")), node["openaiSend"]["content"].as_str().unwrap());
}

/// Case 17, this PC's part: the wire a server pins is this PC's adapter's answer for the model and the session's
/// context. The pin itself does not travel with a send (`options_in`'s `wire_pin: None`, model_proxy.rs), and an
/// adapter without wire routing answers none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_wire_route_is_this_pcs_adapters_answer() {
    let node = observed("a remote session pins its wire through the PC adapter and the pin reaches the PC send");
    let model = node["session"]["model"].as_str().unwrap();
    let pc = pc(json!({ "openrouter": { "enabled": true } }), scripted("present")).await;
    let (service, _) = service_of(Arc::new(pc.config), Arc::new(Unused), Arc::new(Unused), None).await;
    let resolved = &node["resolved"][0];
    assert_eq!(resolved["model"], model);
    let context = w::ProxyRouteContext { agent: resolved["ctx"]["agent"] == true, legacy: resolved["ctx"]["legacy"] == true };
    let call = w::ProxyCall::ResolveWireRoute { provider: "openrouter".into(), model: model.into(), context };
    let answer = ask(&service, "r17", call.clone(), None, 1).await;
    let pinned = &node["pinnedRoute"];
    assert_eq!((&pinned["provider"], &pinned["model"]), (&json!("openrouter"), &json!(model)));
    assert_eq!(answer["route"], json!({ "wire": pinned["wire"], "source": pinned["source"], "profileId": pinned["profileId"] }));
    // `solo`: an adapter without wire routing answers none.
    let solo = provider(Vec::new());
    let (service, _) = service_of(names(&[("openai", &solo)]), Arc::new(Unused), Arc::new(Unused), None).await;
    let call = w::ProxyCall::ResolveWireRoute { provider: "openai".into(), model: "gpt-x".into(), context: w::ProxyRouteContext { agent: true, legacy: false } };
    assert_eq!(ask(&service, "r17s", call.clone(), None, 1).await["route"], node["solo"]["answers"][0]);
}

/// Case 18: a run is taken while another still runs: there is no concurrency cap of the proxy's own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_run_answers_while_the_first_still_runs() {
    let node = observed("a call is claimed and run while another is still running: there is no concurrency cap");
    let scripted = provider(vec![Attempt::Hang, answering(node["second"]["content"].as_str().unwrap())]);
    let (service, notes) = service_of(names(&[("openai", &scripted)]), Arc::new(Unused), Arc::new(Unused), None).await;
    let mut first = Box::pin(ask(&service, "first", send("openai", &hi()), None, 1));
    mixdog_core_session::session::testing::awaiting(|| "the first call to start".to_owned(), async {
        tokio::select! {
            biased;
            () = scripted.started.notified() => {}
            answer = &mut first => panic!("the first run ended: {answer}"),
        }
    })
    .await;
    assert_eq!(ask(&service, "second", send("openai", &hi()), None, 1).await["result"], "sent");
    assert_eq!(content(&notes.events("second")), node["second"]["content"].as_str().unwrap());
    // `runningAfterSecond: 2` counted the second run before its settle was seen; the first is still running.
    pending(&mut first).await;
    service.notify(Method("modelProxy/cancel"), json!({ "runId": "first" }), ConnectionId(1));
    assert_eq!(first.await["result"], "failed");
}

/// Case 19's protection on the typed protocol: a call is one `modelProxy/run` frame, and a frame over
/// `maxInboundFrameBytes` is refused before it is parsed, so no provider runs. Node's 200-byte cap was the test's
/// host option; the typed bound is the protocol's.
#[test]
fn a_call_over_the_frame_bound_is_refused_before_any_provider_runs() {
    let node = observed("a call payload over the request cap is refused before any provider runs");
    assert_eq!(node["providerSent"], false);
    assert_eq!((node["outcome"]["rejected"]["code"].as_str(), node["outcome"]["rejected"]["props"]["status"].as_u64()), (Some("MODEL_PROXY_REQUEST_TOO_LARGE"), Some(413)));
    let limits = Limits::default();
    let mut big = hi();
    big.messages = vec![p::Message::new(p::Role::User, p::Content::Text("x".repeat(limits.max_inbound_frame_bytes as usize)))];
    let frame = json!({ "jsonrpc": "2.0", "id": 1, "method": "modelProxy/run", "params": { "runId": "r", "call": send("openai", &big) } }).to_string();
    assert_eq!(decode_inbound_text(&frame, limits.max_inbound_frame_bytes as usize), InboundText::TooLarge);
}

/// `<session>#proxy:<uuid>` with the uuid replaced: the recording's uuids are a scripted counter, this PC's are random
/// (the manifest's `normalised.transportScope`); its form is asserted.
fn scope_shape(scope: &str) -> String {
    let (session, id) = scope.split_once("#proxy:").unwrap_or_else(|| panic!("{scope} is no PC-forked scope"));
    assert!(id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'), "{scope}");
    format!("{session}#proxy:<uuid>")
}

/// Case 14: a request the server forked from a session names a transport scope of its own; this PC allocates
/// `<session>#proxy:<uuid>` for it, sends with that scope and releases it however the request ends (success, failure,
/// the server's cancel). A request that names none gets none. Node's `closed` (the global connection-close hook) and
/// `released` (the provider's `releaseTransportScope`) are one release here: `ProviderAdapter::release_transport_scope`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forked_side_request_gets_its_own_transport_scope_released_when_it_ends() {
    let node = observed("a proxied side request gets its own transport scope on the PC, disposed when the request ends");
    let main_scope = node["mainScope"].as_str().unwrap();
    let mut refused = p::ProviderError::new(p::ErrorKind::InvalidRequest, p::DeliveryState::NotSent);
    refused.message = "provider down".into();
    let scripted = provider(vec![answering("ok"), Attempt::Stream(vec![Err(refused)]), Attempt::Hang, answering("ok")]);
    let (service, _) = service_of(names(&[("openai", &scripted)]), Arc::new(Unused), Arc::new(Unused), None).await;
    // `proxied.send([], 'gpt', undefined, { sessionId, transportScope: mainScope, signal })`.
    let side = |session: &str, forked: bool, cancel: CancellationToken| {
        let mut sent = hi();
        sent.options.session_id = Some(session.into());
        sent.options.transport_scope = forked.then(|| main_scope.to_owned());
        run_call(session, &send("openai", &sent), None, ConnectionId(1), cancel)
    };
    let view = |scripted: &Scripted| {
        let seen = scripted.seen.lock().unwrap();
        let scopes: Vec<Value> = seen.iter().map(|r| r.options.transport_scope.as_deref().map_or_else(|| json!({ "$exact": "undefined" }), |s| json!(scope_shape(s)))).collect();
        let released: Vec<String> = scripted.released.lock().unwrap().iter().map(|s| scope_shape(s)).collect();
        json!({ "sentScopes": scopes, "sentHaveTransportScope": seen.iter().map(|r| r.options.transport_scope.is_some()).collect::<Vec<_>>(), "closed": released, "released": released })
    };
    fn shaped(value: &mut Value) {
        match value {
            Value::String(text) if text.contains("#proxy:") => *text = scope_shape(text),
            Value::Array(items) => items.iter_mut().for_each(shaped),
            Value::Object(map) => map.values_mut().for_each(shaped),
            _ => {}
        }
    }
    let recorded = |step: &Value| {
        let mut step = step.clone();
        shaped(&mut step);
        step
    };
    let step_of = |step: &str, mut view: Value| {
        view["step"] = json!(step);
        view
    };
    let node_log = node["log"].as_array().unwrap();
    let node_step = |at: usize| recorded(&node_log[at]);
    let compared = |at: usize, got: Value, node_step: &Value| {
        let mut want = node_step.clone();
        want.as_object_mut().unwrap().retain(|key, _| got.get(key).is_some());
        assert_eq!(got, want, "step {at}");
    };

    let answered = super::model_proxy_trust_replay_tests::answered(&service, side("ok", true, CancellationToken::new())).await;
    assert_eq!(answered["result"], "sent");
    compared(0, step_of("success", view(&scripted)), &node_step(0));

    let answer = super::model_proxy_trust_replay_tests::answered(&service, side("fail", true, CancellationToken::new())).await;
    same_failure(&answer, &node_log[1]["fail"]["rejected"], "fail");
    compared(1, step_of("error", view(&scripted)), &node_step(1));

    // The permit the failed run's attempt left, taken so the next one is the hanging request's.
    mixdog_core_session::session::testing::awaiting(|| "the failed side request's attempt to have started".to_owned(), scripted.started.notified()).await;
    let cancel = CancellationToken::new();
    let mut hanging = Box::pin(super::model_proxy_trust_replay_tests::answered(&service, side("hang", true, cancel.clone())));
    mixdog_core_session::session::testing::awaiting(|| "the hanging side request to start".to_owned(), async {
        tokio::select! {
            biased;
            () = scripted.started.notified() => {}
            answer = &mut hanging => panic!("the side request ended before it started: {answer}"),
        }
    })
    .await;
    let while_running = view(&scripted);
    cancel.cancel();
    let cancelled = hanging.await;
    // Node's `cancelled.rejected` ("user stop") is the abort reason the server's own signal carries; this PC's part is
    // that the run ended as a cancellation.
    assert_eq!(node_failure(&node_log[2]["cancelled"]["rejected"])["message"], "user stop");
    assert_eq!(typed_failure(&cancelled, &json!({ "cancelled": true })), json!({ "cancelled": true }));
    let mut cancel_step = step_of("cancel", view(&scripted));
    cancel_step["whileRunning"] = while_running;
    compared(2, cancel_step, &node_step(2));

    let answered = super::model_proxy_trust_replay_tests::answered(&service, side("main", false, CancellationToken::new())).await;
    assert_eq!(answered["result"], "sent");
    compared(3, step_of("no scope named", view(&scripted)), &node_step(3));
    assert_eq!(node_log.len(), 4);
}
