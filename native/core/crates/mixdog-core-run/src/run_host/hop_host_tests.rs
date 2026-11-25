use std::sync::Mutex;

use mixdog_ai::catalog::{CatalogSnapshot, ModelsDevSource, ProviderReadiness};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
use mixdog_core_api::domain::provider::{
    DeliveryState, ErrorKind, ErrorResponse, ModelRequest, ModelStream, WireCodec, WireDecoder, WireRequest, WireRoute, WireRouting,
};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::{Config, ConfigLanes};
use mixdog_core_ports::ports::route_facts::{AgentAnswer, AgentAsk, CatalogFacts};
use mixdog_protocol::ProviderId;

use crate::run_host::hop_host::*;

struct NoCodec;
impl WireCodec for NoCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }
    fn encode(&self, _: &ModelRequest) -> Result<WireRequest, ProviderError> {
        unreachable!()
    }
    fn decoder(&self, _: &ModelRequest) -> Box<dyn WireDecoder> {
        unreachable!()
    }
    fn classify(&self, _: &ErrorResponse) -> ProviderError {
        unreachable!()
    }
}

/// What a scripted gateway answers when asked for a model's wire, and what it was asked.
#[derive(Default)]
struct Script {
    routing: bool,
    route: Option<WireRoute>,
    fails: bool,
    asked: Mutex<Vec<(String, WireRouteContext)>>,
    /// Every observable call, in order, for the whole-hop replay.
    calls: Option<Calls>,
}

type Calls = Arc<Mutex<Vec<Value>>>;

struct Gateway {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    script: Arc<Script>,
}

#[async_trait]
impl ProviderAdapter for Gateway {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &NoCodec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        unreachable!()
    }
    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        self.script.routing.then_some(self as &dyn WireRouting)
    }
}

#[async_trait]
impl WireRouting for Gateway {
    async fn resolve_wire_route(&self, model: &str, context: &WireRouteContext) -> Result<Option<WireRoute>, ProviderError> {
        self.script.asked.lock().unwrap().push((model.to_owned(), context.clone()));
        if let Some(calls) = &self.script.calls {
            calls.lock().unwrap().push(json!({ "call": "resolveWireRoute", "model": model, "agent": context.agent, "legacy": context.legacy }));
        }
        if self.script.fails {
            return Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent));
        }
        Ok(self.script.route.clone())
    }
}

struct Builder {
    script: Arc<Script>,
    /// `gemini` cannot be built.
    fail_init: bool,
    /// `gemini` is not a provider this registry has.
    ghost: bool,
}

#[async_trait]
impl ProviderBuilder for Builder {
    async fn build(&self, name: &str, config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        if let Some(calls) = &self.script.calls {
            calls.lock().unwrap().push(json!({ "call": "initProviders", "provider": name, "config": config }));
        }
        if name == "broken" || (self.fail_init && name == "gemini") {
            return Err("cannot build".into());
        }
        Ok(Arc::new(Gateway {
            id: ProviderId::from(name),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            script: self.script.clone(),
        }))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, name: &str) -> bool {
        !(self.ghost && name == "gemini")
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

/// A session whose header is fixed and whose writes are recorded in order.
struct Session {
    header: Header,
    log: Mutex<Vec<String>>,
    pins: Mutex<Vec<Value>>,
    /// The step that fails: "write", "closed" (answers nothing), "pin" or "rebuild".
    fail: Mutex<&'static str>,
}

#[async_trait]
impl HopSession for Session {
    fn header(&self) -> Option<Arc<Header>> {
        Some(Arc::new(self.header.clone()))
    }
    async fn write_hop(&self, route: Obj, write: &HopWrite) -> Result<Option<Header>, PortError> {
        self.log.lock().unwrap().push(format!("hop {} index {}", text(route.get("model")), write.index));
        match *self.fail.lock().unwrap() {
            "write" => Err(PortError::Failed { capability: "session".into(), message: "session store is read-only".into() }),
            "closed" => Ok(None),
            _ => Ok(Some(self.header.clone())),
        }
    }
    async fn write_wire_pin(&self, pin: Value) -> Result<(), PortError> {
        self.log.lock().unwrap().push("pin".into());
        if *self.fail.lock().unwrap() == "pin" {
            return Err(PortError::Cancelled);
        }
        self.pins.lock().unwrap().push(pin);
        Ok(())
    }
    async fn rebuild_tool_surface(&self, provider: &str) -> Result<(), PortError> {
        self.log.lock().unwrap().push(format!("surface {provider}"));
        match *self.fail.lock().unwrap() {
            "rebuild" => Err(PortError::Failed { capability: "tools".into(), message: "surface rebuild failed".into() }),
            _ => Ok(()),
        }
    }
}

struct NoWiring;
impl HopWiring for NoWiring {
    fn wiring(&self, _: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>) {
        (None, None)
    }
}

struct NoBots;
#[async_trait]
impl BotRoutes for NoBots {
    async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, crate::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
    async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, crate::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
}

struct Offline;
#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

async fn catalog() -> Arc<CatalogService> {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await)
}

/// The route provider an agent outside the loop serves.
const AGENT: &str = "acp-agent";
/// The route provider of an agent outside the loop that is signed out, and what it says of that.
const SIGNED_OUT: &str = "acp-signed-out";
const SIGNED_OUT_STATE: &str = "Test Agent is signed out. Sign in to it in Settings.";

fn agents_route(provider: &str) -> bool {
    provider == AGENT || provider == SIGNED_OUT
}

/// The facts the composition hands the hop: the PC's catalog and registry, with agents outside the loop serving [`AGENT`]
/// and [`SIGNED_OUT`] (as `mixdog_acp::routes::AgentRouteFacts` answers for one).
struct Facts {
    inner: CatalogFacts,
    _config_dir: tempfile::TempDir,
}

#[async_trait]
impl RouteFacts for Facts {
    fn is_known(&self, provider: &str, config: &Obj) -> bool {
        agents_route(provider) || self.inner.is_known(provider, config)
    }
    async fn ensure_ready(&self, config: &Obj, provider: &str) -> Result<(), String> {
        match provider {
            AGENT => Ok(()),
            SIGNED_OUT => Err(SIGNED_OUT_STATE.to_owned()),
            _ => self.inner.ensure_ready(config, provider).await,
        }
    }
    fn model_meta(&self, provider: &str, model: &str) -> Value {
        self.inner.model_meta(provider, model)
    }
    fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value> {
        self.inner.window_meta(provider, model, meta)
    }
    fn catalog_knows(&self, model: &str, provider: &str) -> bool {
        self.inner.catalog_knows(model, provider)
    }
    fn fast_capable(&self, provider: &str, meta: &Value, effort: Option<&str>, params: &Value) -> bool {
        self.inner.fast_capable(provider, meta, effort, params)
    }
    fn ultrafast_capable(&self, provider: &str, meta: &Value) -> bool {
        self.inner.ultrafast_capable(provider, meta)
    }
    async fn sender(&self, providers: Option<&Obj>, provider: &str) -> Result<Option<RouteSender>, String> {
        if agents_route(provider) { Ok(Some(RouteSender::Agent(Arc::new(Unasked)))) } else { self.inner.sender(providers, provider).await }
    }
    fn registered(&self, provider: &str) -> Option<Arc<dyn ProviderAdapter>> {
        (!agents_route(provider)).then(|| self.inner.registered(provider)).flatten()
    }
    fn init_error(&self, provider: &str) -> Option<String> {
        (!agents_route(provider)).then(|| self.inner.init_error(provider)).flatten()
    }
}

/// An agent a hop asks nothing.
struct Unasked;

#[async_trait]
impl AgentAsk for Unasked {
    async fn ask(&self, _: &str, _: &str, _: &str) -> Result<AgentAnswer, String> {
        unreachable!("a hop asks no agent anything")
    }
}

async fn facts(registry: Arc<ProviderRegistry>, catalog: Arc<CatalogService>) -> Arc<dyn RouteFacts> {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let readiness = ProviderReadiness::new(registry.clone(), catalog.clone());
    Arc::new(Facts { inner: CatalogFacts { catalog, readiness, registry, config }, _config_dir: dir })
}

async fn harness(script: Arc<Script>, header: Value) -> (RegistryHopHost, Arc<Session>, Arc<ProviderRegistry>) {
    let registry = Arc::new(ProviderRegistry::new(Arc::new(Builder { script, fail_init: false, ghost: false })));
    let session = Arc::new(Session { header: header.as_object().cloned().unwrap(), log: Mutex::default(), pins: Mutex::default(), fail: Mutex::new("") });
    let catalog = catalog().await;
    let deps = HopDeps {
        facts: facts(registry.clone(), catalog.clone()).await,
        catalog,
        config: Arc::new(Obj::new),
        bots: Arc::new(NoBots),
        errors: Arc::new(|e| e.message.clone()),
        wiring: Arc::new(NoWiring),
    };
    (RegistryHopHost { deps, session: session.clone(), eligibility: None }, session, registry)
}

fn route_of(header: &Value) -> Obj {
    let mut route = Obj::new();
    route.insert("provider".into(), header["provider"].clone());
    route.insert("model".into(), header["model"].clone());
    route
}

fn write() -> HopWrite {
    HopWrite { chain: Vec::new(), primary: None, index: 1, failures: Vec::new(), checkpoint_route_changed: false }
}

#[tokio::test]
async fn the_hop_writes_then_pins_then_rebuilds_a_lead_surface() {
    let script = Arc::new(Script {
        routing: true,
        route: Some(WireRoute { wire: "chat".into(), source: "default".into(), profile_id: "openrouter:chat".into() }),
        ..Script::default()
    });
    let header = json!({ "provider": "openrouter", "model": "m", "wireRoute": null });
    let (host, session, registry) = harness(script.clone(), header.clone()).await;
    registry.init_providers(&ensure_provider_enabled(&Obj::new(), "openrouter")).await.unwrap();
    host.apply_hop(route_of(&header), write()).await.unwrap().expect("updated");
    assert_eq!(*session.log.lock().unwrap(), ["hop m index 1", "pin", "surface openrouter"]);

    let agent = json!({ "provider": "openrouter", "model": "m", "wireRoute": null, "owner": " Agent " });
    let (host, session, registry) = harness(script, agent.clone()).await;
    registry.init_providers(&ensure_provider_enabled(&Obj::new(), "openrouter")).await.unwrap();
    host.apply_hop(route_of(&agent), write()).await.unwrap().expect("updated");
    assert_eq!(*session.log.lock().unwrap(), ["hop m index 1", "pin"]);
}

#[tokio::test]
async fn the_next_provider_comes_from_the_registry_once_enabled() {
    let (host, _, _) = harness(Arc::new(Script::default()), json!({})).await;
    assert!(matches!(host.runner("openrouter").await, Ok(Some(Runner::Loop(_)))));
    // `initProviders` throws for a provider that cannot be built; its message escapes.
    assert_eq!(host.runner("broken").await.err().as_deref(), Some("[provider] Failed to init \"broken\": cannot build"));
}

/// A fallback route an agent outside the loop serves is the agent's to run: the hop readies nothing under its name and
/// finds no failure recorded for it, and whether the agent can run is read as a pick of the route reads it, in the
/// agent's own words.
#[tokio::test]
async fn a_route_an_agent_serves_is_the_agents_to_run_and_readies_no_provider() {
    let calls: Calls = Arc::default();
    let (host, _, registry) = harness(Arc::new(Script { calls: Some(calls.clone()), ..Script::default() }), json!({})).await;
    assert!(matches!(host.runner(AGENT).await, Ok(Some(Runner::Agent))));
    assert_eq!(host.agent_ready(AGENT).await, Ok(()));
    assert_eq!(host.agent_ready(SIGNED_OUT).await, Err(SIGNED_OUT_STATE.to_owned()));
    assert_eq!(host.unavailable_cause(AGENT).await, (None, false));
    assert!(calls.lock().unwrap().is_empty(), "{:?}", calls.lock().unwrap());
    assert!(registry.registered(AGENT).is_none());
    assert!(registry.init_errors().is_empty());
    assert!(matches!(host.runner("openrouter").await, Ok(Some(Runner::Loop(_)))), "a provider's route is readied as before");
}

#[tokio::test]
async fn names_and_windows_read_as_a_notice_needs_them() {
    let (host, _, _) = harness(Arc::new(Script::default()), json!({ "provider": "openai", "model": "gpt-5" })).await;
    assert_eq!(host.model_label("openai", "gpt-5.4-2026-01-02"), "GPT-5.4");
    assert_eq!(host.model_label("custom", "custom-model-x"), "custom-model-x");
    assert!(host.raw_context_window("openai", "gpt-5", &json!({})).is_some_and(|w| w > 0));
    assert_eq!(host.raw_context_window("openai", "", &json!({})), None);
    assert_eq!(host.session().unwrap()["model"], "gpt-5");
}

/// No step of `advanceAgentRoute` after the update has a catch (route-fallback.mjs:131-158): a
/// step that fails escapes the hop with its own message, and an update that answers nothing
/// throws "agent session closed during model fallback" (:147).
#[tokio::test]
async fn a_failed_step_escapes_the_hop_as_node_throws_it() {
    let script = Arc::new(Script {
        routing: true,
        route: Some(WireRoute { wire: "chat".into(), source: "default".into(), profile_id: "openrouter:chat".into() }),
        ..Script::default()
    });
    let header = json!({ "provider": "openrouter", "model": "m", "wireRoute": null });
    for (fail, expect, log) in [
        ("write", Err("session store is read-only"), vec!["hop m index 1"]),
        ("closed", Ok(false), vec!["hop m index 1"]),
        ("pin", Err("cancelled"), vec!["hop m index 1", "pin"]),
        ("rebuild", Err("surface rebuild failed"), vec!["hop m index 1", "pin", "surface openrouter"]),
    ] {
        let (host, session, registry) = harness(script.clone(), header.clone()).await;
        registry.init_providers(&ensure_provider_enabled(&Obj::new(), "openrouter")).await.unwrap();
        *session.fail.lock().unwrap() = fail;
        let got = host.apply_hop(route_of(&header), write()).await;
        let expect: Result<bool, &str> = expect;
        assert_eq!(got.map(|u| u.is_some()), expect.map_err(String::from), "{fail}");
        assert_eq!(*session.log.lock().unwrap(), log, "{fail}");
    }
}
