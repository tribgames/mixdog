//! The model proxy's host side, from the code: a burst of runs, what a server is told of a run (projected events, the account id and
//! credential-shaped text kept home), and what this PC advertises of its providers and when it serves one.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_ai::admission::Admission;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::service::model_proxy::public_provider_config;
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
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::model_proxy_pc::CredentialProbe;
use super::model_proxy_pc::PcProviderConfig;
use super::model_proxy_pc::PcRegistry;
use super::model_proxy_pc::PcWireRouter;
use super::model_proxy_pc::RegistryCredentials;
use mixdog_ai::registry::keys::SecretVault as _;

/// A provider that answers every attempt with `events`, reporting `reports` (tools it left out) before its first event.
struct Script {
    inner: MockProvider,
    reports: Vec<p::ToolExclusionReport>,
    events: Vec<p::StreamEvent>,
}

struct Stream {
    events: VecDeque<p::StreamEvent>,
    reports: VecDeque<p::ToolExclusionReport>,
    sink: Option<p::ToolExclusionSink>,
}

#[async_trait]
impl p::ModelStream for Stream {
    async fn next(&mut self) -> Option<Result<p::StreamEvent, p::ProviderError>> {
        while let Some(report) = self.reports.pop_front() {
            if let Some(sink) = &self.sink {
                sink.report(report);
            }
        }
        self.events.pop_front().map(Ok)
    }
    fn delivery(&self) -> p::DeliveryState {
        p::DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
}

#[async_trait]
impl p::ProviderAdapter for Script {
    fn release_send(&self, _group: &str) {}
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
        Ok(Box::new(Stream { events: self.events.iter().cloned().collect(), reports: self.reports.iter().cloned().collect(), sink: request.options.on_tool_excluded.clone() }))
    }
}

fn answer(text: &str) -> Vec<p::StreamEvent> {
    vec![p::StreamEvent::TextDelta(text.into()), p::StreamEvent::Completed { stop: Some(p::StopReason::EndTurn), pricing_model: None, request_ms: None }]
}

fn script(reports: Vec<p::ToolExclusionReport>, events: Vec<p::StreamEvent>) -> Arc<Script> {
    Arc::new(Script { inner: MockProvider::new(Vec::<MockAttempt>::new()), reports, events })
}

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
        unreachable!("these runs ask no quota")
    }
}

struct NoConfig;

#[async_trait]
impl ProviderConfigSource for NoConfig {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String> {
        unreachable!("these runs ask no provider config")
    }
}

struct Offline;

#[async_trait]
impl mixdog_ai::transport::HttpSend for Offline {
    async fn send(&self, _: p::WireRequest, _: mixdog_ai::transport::Exchange) -> Result<mixdog_ai::transport::HttpResponse, p::ProviderError> {
        Err(p::ProviderError::new(p::ErrorKind::Transient, p::DeliveryState::NotSent))
    }
}

#[derive(Default)]
struct Notes(Mutex<Vec<(ConnectionId, String, Value)>>);

impl ConnectionNotifier for Notes {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        self.0.lock().unwrap().push((to, method.as_str().to_owned(), params));
        Ok(())
    }
}

impl Notes {
    fn events(&self, run_id: &str) -> Vec<w::ProxyEvent> {
        self.0
            .lock()
            .unwrap()
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

fn hi() -> p::ModelRequest {
    p::ModelRequest { model: "gpt".into(), messages: vec![p::Message::new(p::Role::User, p::Content::Text("hi".into()))], tools: Vec::new(), options: p::RequestOptions::default() }
}

fn run(run_id: &str) -> CoreRequest {
    let call = w::ProxyCall::Send { provider: "openai".into(), request: Box::new(request_out(&hi())) };
    CoreRequest {
        method: Method("modelProxy/run"),
        params: json!({ "runId": run_id, "call": call, "allowedProviders": null }),
        op: None,
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
    }
}

async fn answered(service: &ModelProxyService, call: CoreRequest) -> Value {
    let Reply::Value(answer) = service.call(call).await.expect("a run answers") else { panic!("not a value") };
    answer["result"].clone()
}

fn text_of(events: &[w::ProxyEvent]) -> String {
    events.iter().filter_map(|e| if let w::ProxyEvent::TextDelta { text } = e { Some(text.as_str()) } else { None }).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_burst_of_runs_all_answer_with_no_rate_or_concurrency_refusal_and_none_is_left_running() {
    let (service, notes) = service(script(Vec::new(), answer("ok"))).await;
    let runs = (0..30).map(|i| answered(&service, run(&format!("r{i}"))));
    let answers = tokio::time::timeout(std::time::Duration::from_secs(30), futures::future::join_all(runs)).await.expect("all 30 concurrent runs answer");
    for (i, answered) in answers.iter().enumerate() {
        assert_eq!(answered["result"], "sent", "run {i}");
        assert_eq!(text_of(&notes.events(&format!("r{i}"))), "ok", "run {i} streamed its own answer");
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), service.close()).await.expect("no run is left running");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_the_provider_reports_reaches_the_server_projected_with_the_account_id_and_credential_text_kept_home() {
    let secret_text = "sk-DUMMYSECRET123456789";
    let excluded = p::ToolExclusionReport { name: "lookup".into(), index: 2, pointer: "/tools/2".into(), reason: "schema".into(), message: format!("cannot take the key {secret_text} here") };
    let mut events = vec![
        p::StreamEvent::AccountStage(p::AccountStage::Switching { message: format!("switching away from Bearer abcdefghijkl1234") }),
        p::StreamEvent::AccountStage(p::AccountStage::Changed { provider: "openai".into(), account_id: "acct-private-42".into(), at: 1_700_000_000_000 }),
    ];
    events.extend(answer("ok"));
    let (service, notes) = service(script(vec![excluded], events)).await;
    assert_eq!(answered(&service, run("r1")).await["result"], "sent");
    let got = notes.events("r1");
    assert_eq!(got[0], w::ProxyEvent::ToolExcluded { name: "lookup".into(), index: 2, pointer: "/tools/2".into(), reason: "schema".into(), message: "cannot take the key [redacted] here".into() });
    assert_eq!(got[1], w::ProxyEvent::AccountSwitching { message: "switching away from [redacted]".into() });
    assert_eq!(got[2], w::ProxyEvent::AccountChanged { provider: "openai".into(), at: 1_700_000_000_000 });
    assert_eq!(text_of(&got), "ok");
    assert!(matches!(got.last(), Some(w::ProxyEvent::Completed { .. })));
    let wire = serde_json::to_string(&got).unwrap();
    assert!(!wire.contains("acct-private-42") && !wire.contains(secret_text) && !wire.contains("abcdefghijkl1234"), "{wire}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_the_server_is_told_has_credential_text_redacted() {
    let (service, _) = service(script(Vec::new(), answer("ok"))).await;
    let mut call = run("r1");
    call.params["call"]["provider"] = json!("absent-sk-DUMMYSECRET123456789");
    let failed = answered(&service, call).await;
    assert_eq!(failed["result"], "failed");
    let message = serde_json::to_string(&failed["failure"]).unwrap();
    assert!(!message.contains("DUMMYSECRET123456789"), "{message}");
}

// --- what this PC advertises --------------------------------------------------------------------------

fn info(config: &Value, name: &str) -> Value {
    config[name].clone()
}

#[test]
fn a_server_learns_of_a_provider_only_its_enabled_flag_auth_state_and_traits() {
    let providers = json!({
        "openai": { "enabled": true, "apiKey": "sk-DUMMYSECRET123456789", "baseURL": "https://secret.example", "authState": "present",
                    "modelProxy": { "inputExcludesCache": true, "nativePdf": false, "consumesReadWindows": true, "takesImages": false, "firstResponseBudget": { "transportMs": 100, "semanticMs": 200 }, "extra": 1 } },
        "off": { "enabled": "yes", "authState": "unknown", "modelProxy": { "firstResponseBudget": { "transportMs": 0, "semanticMs": 200 }, "consumesReadWindows": false, "takesImages": true } },
    });
    let public = public_provider_config(&providers, &|_| true);
    assert_eq!(
        info(&public, "openai"),
        json!({ "enabled": true, "authState": "present", "modelProxy": { "inputExcludesCache": true, "nativePdf": false, "consumesReadWindows": true, "takesImages": false, "firstResponseBudget": { "transportMs": 100, "semanticMs": 200 } } })
    );
    assert_eq!(info(&public, "off"), json!({ "enabled": false, "modelProxy": {} }), "only `enabled: true` enables; an unknown auth state, a zero budget and default traits say nothing");
    assert!(!public.to_string().contains("secret"));
}

#[test]
fn the_hosts_allow_list_decides_which_providers_are_advertised() {
    let providers = json!({ "a": { "enabled": true }, "b": { "enabled": true } });
    let public = public_provider_config(&providers, &|name| name == "b");
    assert_eq!(public.as_object().unwrap().keys().collect::<Vec<_>>(), ["b"]);
}

#[test]
fn a_custom_provider_advertises_its_trimmed_redacted_capped_name_and_only_its_hidden_model_ids() {
    let long = "n".repeat(300);
    let providers = json!({
        "custom-1": { "enabled": true, "type": "custom", "name": format!("  My sk-DUMMYSECRET123456789 gateway  "),
                      "models": [{ "id": "m1", "hidden": true }, { "id": "m2", "hidden": false }, { "id": "m3" }],
                      "modelOverrides": { "m1": { "hidden": true }, "m4": { "hidden": true }, "m5": { "hidden": false } } },
        "custom-2": { "enabled": true, "type": "custom", "name": long },
        "custom-3": { "enabled": true, "type": "custom", "name": "   " },
    });
    let public = public_provider_config(&providers, &|_| true);
    assert_eq!(info(&public, "custom-1")["name"], "My [redacted] gateway");
    assert_eq!(info(&public, "custom-1")["hiddenModels"], json!(["m1", "m4"]), "hidden by flag or override, each once");
    assert_eq!(info(&public, "custom-1")["type"], "custom");
    assert_eq!(info(&public, "custom-2")["name"].as_str().unwrap().len(), 200);
    assert!(info(&public, "custom-3").get("name").is_none(), "a blank name is not advertised");
    assert_eq!(info(&public, "custom-3")["hiddenModels"], json!([]));
}

/// A registry that keeps what it was applied: a provider is live when the config enables it (and it was ever applied).
struct Registry {
    live: Mutex<Vec<String>>,
    keeps_forever: Mutex<Vec<String>>,
}

#[async_trait]
impl PcRegistry for Registry {
    async fn apply(&self, providers: &Map<String, Value>) -> Result<(), String> {
        let mut forever = self.keeps_forever.lock().unwrap();
        for (name, entry) in providers {
            if entry.get("enabled") == Some(&Value::Bool(true)) && !forever.contains(name) {
                forever.push(name.clone());
            }
        }
        *self.live.lock().unwrap() = forever.clone();
        Ok(())
    }
    fn live(&self) -> Vec<(String, Arc<dyn p::ProviderAdapter>)> {
        self.live.lock().unwrap().iter().map(|name| (name.clone(), Arc::new(MockProvider::new(Vec::<MockAttempt>::new())) as Arc<dyn p::ProviderAdapter>)).collect()
    }
    async fn get(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        self.live.lock().unwrap().iter().any(|live| live == name).then(|| Arc::new(MockProvider::new(Vec::<MockAttempt>::new())) as Arc<dyn p::ProviderAdapter>)
    }
}

struct Auth(Mutex<&'static str>);

#[async_trait]
impl CredentialProbe for Auth {
    async fn auth_state(&self, _: &str, _: &Map<String, Value>) -> Result<&'static str, String> {
        Ok(*self.0.lock().unwrap())
    }
}

struct Pc {
    available: Arc<Mutex<Map<String, Value>>>,
    auth: Arc<Auth>,
    config: PcProviderConfig,
}

fn pc(available: Value, state: &'static str) -> Pc {
    let available = Arc::new(Mutex::new(available.as_object().unwrap().clone()));
    let read = available.clone();
    let auth = Arc::new(Auth(Mutex::new(state)));
    let registry = Arc::new(Registry { live: Mutex::new(Vec::new()), keeps_forever: Mutex::new(Vec::new()) });
    Pc { available, auth: auth.clone(), config: PcProviderConfig::new(Arc::new(move || read.lock().unwrap().clone()), registry, auth) }
}

impl Pc {
    async fn advertised(&self) -> Value {
        let (providers, ready) = self.config.public().await.expect("an answer");
        assert!(ready);
        let list: Map<String, Value> = providers.into_iter().map(|(name, info)| (name, serde_json::to_value(info).unwrap())).collect();
        Value::Object(list)
    }
    fn set(&self, available: Value) {
        *self.available.lock().unwrap() = available.as_object().unwrap().clone();
    }
    async fn reaches(&self, name: &str) -> bool {
        self.config.adapter(name).await.is_some()
    }
}

#[tokio::test]
async fn a_pc_with_nothing_enabled_still_answers_and_a_cold_one_loads_its_registry_on_the_first_read() {
    let none = pc(json!({ "openai": { "enabled": false } }), "present");
    assert_eq!(none.advertised().await["openai"]["enabled"], false);
    let cold = pc(json!({ "openai": { "enabled": true }, "gemini": { "enabled": false } }), "present");
    let answer = cold.advertised().await;
    assert_eq!((&answer["openai"]["enabled"], &answer["gemini"]["enabled"]), (&json!(true), &json!(false)), "the first read applied the config before answering");
}

#[tokio::test]
async fn a_provider_disabled_or_removed_is_not_advertised_enabled_or_reached_even_while_the_registry_keeps_it() {
    let pc = pc(json!({ "openai": { "enabled": true } }), "present");
    assert_eq!(pc.advertised().await["openai"]["enabled"], true);
    assert!(pc.reaches("openai").await);
    pc.set(json!({ "openai": { "enabled": false } }));
    assert_eq!(pc.advertised().await["openai"]["enabled"], false, "the registry still holds its instance");
    assert!(!pc.reaches("openai").await);
    pc.set(json!({}));
    assert_eq!(pc.advertised().await.get("openai").map(|info| info["enabled"].clone()), Some(json!(false)), "still live in the registry, no longer enabled");
    assert!(!pc.reaches("openai").await);
}

#[tokio::test]
async fn readiness_follows_the_credential_and_the_explicit_disable() {
    let pc = pc(json!({ "openai-oauth": { "enabled": true } }), "present");
    let read = |answer: &Value| (answer["openai-oauth"]["enabled"].clone(), answer["openai-oauth"]["authState"].clone());
    assert_eq!(read(&pc.advertised().await), (json!(true), json!("present")));
    // A probe that could not run: the provider the registry keeps stays advertised as unreadable and reachable, though the config disabled it.
    *pc.auth.0.lock().unwrap() = "unreadable";
    pc.set(json!({ "openai-oauth": { "enabled": false, "credentialProbeUnavailable": true } }));
    assert_eq!(read(&pc.advertised().await), (json!(true), json!("unreadable")));
    assert!(pc.reaches("openai-oauth").await, "a probe that could not run does not close the provider");
    // No credential: advertised disabled whatever the config persisted, and not reached.
    *pc.auth.0.lock().unwrap() = "absent";
    pc.set(json!({ "openai-oauth": { "enabled": true } }));
    assert_eq!(read(&pc.advertised().await), (json!(false), json!("absent")));
    assert!(!pc.reaches("openai-oauth").await);
    // A credential and an explicit disable: not reached.
    *pc.auth.0.lock().unwrap() = "present";
    pc.set(json!({ "openai-oauth": { "enabled": false } }));
    assert!(!pc.reaches("openai-oauth").await);
}
// --- the traits and budgets a borrowing server is told of each provider ------------------------------

/// The mock but for what an adapter declares of itself.
struct Declared {
    inner: MockProvider,
    native_pdf: bool,
    excludes_cache: Option<bool>,
    budget: Option<p::FirstResponseBudget>,
}

fn declared(native_pdf: bool, excludes_cache: Option<bool>, budget: Option<(i64, i64)>) -> Arc<dyn p::ProviderAdapter> {
    let budget = budget.map(|(transport_ms, semantic_ms)| p::FirstResponseBudget { transport_ms, semantic_ms });
    Arc::new(Declared { inner: MockProvider::new(Vec::<MockAttempt>::new()), native_pdf, excludes_cache, budget })
}

#[async_trait]
impl p::ProviderAdapter for Declared {
    fn release_send(&self, _group: &str) {}
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
        self.inner.attempt(request).await
    }
    fn native_pdf(&self) -> bool {
        self.native_pdf
    }
    fn input_excludes_cache(&self) -> Option<bool> {
        self.excludes_cache
    }
    fn first_response_budget(&self, _: &str, _: Option<&mixdog_protocol::JsonValue>) -> Option<p::FirstResponseBudget> {
        self.budget
    }
}

/// A registry whose live providers are fixed.
struct Fixed(Vec<(String, Arc<dyn p::ProviderAdapter>)>);

#[async_trait]
impl PcRegistry for Fixed {
    async fn apply(&self, _: &Map<String, Value>) -> Result<(), String> {
        Ok(())
    }
    fn live(&self) -> Vec<(String, Arc<dyn p::ProviderAdapter>)> {
        self.0.clone()
    }
    async fn get(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        self.0.iter().find(|(live, _)| live == name).map(|(_, adapter)| adapter.clone())
    }
}

/// A PC over `registry` and the config `providers`, whose credentials read as `auth`.
fn pc_over_fixed(providers: Value, registry: Vec<(&str, Arc<dyn p::ProviderAdapter>)>, auth: Arc<dyn CredentialProbe>) -> PcProviderConfig {
    let providers = providers.as_object().unwrap().clone();
    let registry = Fixed(registry.into_iter().map(|(name, adapter)| (name.to_owned(), adapter)).collect());
    PcProviderConfig::new(Arc::new(move || providers.clone()), Arc::new(registry), auth)
}

async fn advertised_by(config: &PcProviderConfig) -> Value {
    let (providers, _) = config.public().await.expect("an answer");
    Value::Object(providers.into_iter().map(|(name, info)| (name, serde_json::to_value(info).unwrap())).collect())
}

#[tokio::test]
async fn each_provider_is_advertised_with_the_traits_its_adapter_declares_and_the_ones_the_pc_knows_by_name() {
    let config = json!({
        "openai": { "enabled": true }, "anthropic": { "enabled": true }, "cursor-oauth": { "enabled": true },
        "mixdog-local": { "enabled": true }, "custom-a": { "enabled": true, "type": "custom" },
    });
    let registry = vec![
        ("openai", declared(true, None, Some((100, 200)))),
        ("anthropic", declared(true, None, None)),
        ("cursor-oauth", declared(false, None, None)),
        ("mixdog-local", declared(false, Some(false), None)),
        // A custom provider on the anthropic protocol says so itself: its name tells nothing. A budget with a zero side is no budget.
        ("custom-a", declared(true, Some(true), Some((0, 5)))),
    ];
    let advertised = advertised_by(&pc_over_fixed(config, registry, Arc::new(Auth(Mutex::new("present"))))).await;
    let traits = |name: &str| advertised[name]["modelProxy"].clone();
    assert_eq!(traits("openai"), json!({ "inputExcludesCache": false, "nativePdf": true, "firstResponseBudget": { "transportMs": 100, "semanticMs": 200 } }));
    assert_eq!(traits("anthropic"), json!({ "inputExcludesCache": true, "nativePdf": true }), "the anthropic family reports input without its cache reads");
    assert_eq!(traits("cursor-oauth"), json!({ "inputExcludesCache": false, "nativePdf": false, "consumesReadWindows": true }));
    assert_eq!(traits("mixdog-local"), json!({ "inputExcludesCache": false, "nativePdf": false, "takesImages": false }), "the local runtime reads text only");
    assert_eq!(traits("custom-a"), json!({ "inputExcludesCache": true, "nativePdf": true }));
}

#[tokio::test]
async fn a_provider_the_registry_does_not_hold_is_advertised_with_no_traits_and_disabled() {
    let advertised = advertised_by(&pc_over_fixed(json!({ "openai": { "enabled": true } }), Vec::new(), Arc::new(Auth(Mutex::new("present"))))).await;
    assert_eq!(advertised["openai"]["enabled"], false, "nothing built, nothing to borrow");
    assert_eq!(advertised["openai"]["modelProxy"], json!({}));
}

// --- the Developer-gated families ---------------------------------------------------------------------

/// The credential of a PC whose Developer options are `developer`: a gated family whose option is off reads absent.
struct GatedAuth(Value);

#[async_trait]
impl CredentialProbe for GatedAuth {
    async fn auth_state(&self, name: &str, _: &Map<String, Value>) -> Result<&'static str, String> {
        Ok(if mixdog_ai::service::admin_models::provider_available(name, false, &self.0) { "present" } else { "absent" })
    }
}

#[tokio::test]
async fn a_developer_gated_family_is_borrowed_only_while_its_option_is_exactly_on() {
    let gated = ["antigravity-oauth", "cursor-oauth", "devin-oauth", "mimo-oauth"];
    let options = ["antigravityOAuth", "cursorOAuth", "devinOAuth", "mimoOAuth"];
    let config = json!({ "antigravity-oauth": { "enabled": true }, "cursor-oauth": { "enabled": true }, "devin-oauth": { "enabled": true }, "mimo-oauth": { "enabled": true }, "openai": { "enabled": true } });
    let registry = || gated.iter().chain(["openai"].iter()).map(|name| (*name, declared(true, None, None))).collect::<Vec<_>>();
    let cases: [(Value, Vec<&str>); 3] = [
        (json!({}), vec![]),
        (json!({ "cursorOAuth": "true", "devinOAuth": 1 }), vec![]),
        (json!({ "cursorOAuth": true, "mimoOAuth": true, "allowAllActions": true }), vec!["cursor-oauth", "mimo-oauth"]),
    ];
    for (developer, on) in cases {
        let pc = pc_over_fixed(config.clone(), registry(), Arc::new(GatedAuth(developer.clone())));
        let advertised = advertised_by(&pc).await;
        for name in gated {
            let admitted = on.contains(&name);
            assert_eq!(advertised[name]["enabled"], admitted, "{name} under {developer}");
            assert_eq!(advertised[name]["authState"], if admitted { "present" } else { "absent" }, "{name} under {developer}");
            assert_eq!(pc.adapter(name).await.is_some(), admitted, "{name} is reached only when admitted, under {developer}");
        }
        assert_eq!(advertised["openai"]["enabled"], true, "an ungated family never waits on an option");
        assert!(pc.adapter("openai").await.is_some());
    }
    assert_eq!(options.map(|option| mixdog_ai::service::admin_models::developer_option_enabled(option, &json!({ option: true }))), [true; 4]);
}

// --- a key is read when it is needed --------------------------------------------------------------------

struct KeyEnv(Mutex<HashMap<String, String>>);

impl mixdog_ai::registry::keys::Environment for KeyEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.lock().unwrap().get(name).cloned()
    }
}

/// The builder's part of a credential probe, which a key probe never reaches.
struct NoBuilds;

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for NoBuilds {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn p::ProviderAdapter>, String> {
        Err(format!("unknown enabled provider: {name}"))
    }
    fn available(&self, _: &str) -> bool {
        true
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

fn probe(env: Arc<KeyEnv>, vault: Arc<mixdog_ai::registry::keys::MemoryVault>) -> RegistryCredentials {
    RegistryCredentials { builder: Arc::new(NoBuilds), keys: mixdog_ai::registry::keys::ApiKeyStore::new(vault, env.clone(), false), env }
}

#[tokio::test]
async fn the_credential_state_follows_the_variable_and_the_keychain_as_they_are_at_each_read() {
    let env = Arc::new(KeyEnv(Mutex::new(HashMap::new())));
    let vault = Arc::new(mixdog_ai::registry::keys::MemoryVault::default());
    let credentials = probe(env.clone(), vault.clone());
    let custom = json!({ "type": "custom", "apiKeyEnv": "GATEWAY_KEY" }).as_object().unwrap().clone();
    let state = async |name: &str, entry: &Map<String, Value>| credentials.auth_state(name, entry).await.unwrap();
    // A custom provider names the variable its key lives in: read as it is now, never kept from an earlier read.
    assert_eq!(state("gateway", &custom).await, "absent");
    env.0.lock().unwrap().insert("GATEWAY_KEY".into(), "k-1".into());
    assert_eq!(state("gateway", &custom).await, "present");
    env.0.lock().unwrap().insert("GATEWAY_KEY".into(), String::new());
    assert_eq!(state("gateway", &custom).await, "absent", "an empty variable is no key");
    // A built-in provider's key is the keychain's (or the config's own), found when it is put there.
    let builtin = Map::new();
    assert_eq!(state("openai", &builtin).await, "absent");
    vault.set(&mixdog_ai::registry::keys::api_key_account("openai"), "sk-stored").await.unwrap();
    assert_eq!(state("openai", &builtin).await, "present");
    vault.delete(&mixdog_ai::registry::keys::api_key_account("openai")).await.unwrap();
    assert_eq!(state("openai", &builtin).await, "absent");
    let inline = json!({ "apiKey": "sk-in-the-config" }).as_object().unwrap().clone();
    assert_eq!(state("openai", &inline).await, "present");
    // The local runtime and a custom provider that needs no authentication have no key to read.
    assert_eq!(state("mixdog-local", &builtin).await, "present");
    let open = json!({ "type": "custom", "auth": "none", "apiKeyEnv": "GATEWAY_KEY" }).as_object().unwrap().clone();
    assert_eq!(state("open-gateway", &open).await, "present");
}
