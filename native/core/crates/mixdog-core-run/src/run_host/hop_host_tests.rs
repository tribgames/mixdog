use std::sync::Mutex;

use mixdog_ai::catalog::{CatalogSnapshot, ModelsDevSource, ProviderReadiness};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::registry::keys::{ApiKeyStore, Environment, MemoryVault, SecretVault};
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

/// A session whose header updates on `write_hop` and whose writes are recorded in order.
struct Session {
    header: Mutex<Header>,
    log: Mutex<Vec<String>>,
    routes: Mutex<Vec<Obj>>,
    pins: Mutex<Vec<Value>>,
    /// The step that fails: "write", "closed" (answers nothing), "pin" or "rebuild".
    fail: Mutex<&'static str>,
}

#[async_trait]
impl HopSession for Session {
    fn header(&self) -> Option<Arc<Header>> {
        Some(Arc::new(self.header.lock().unwrap().clone()))
    }
    async fn write_hop(&self, route: Obj, write: &HopWrite) -> Result<Option<Header>, PortError> {
        self.log.lock().unwrap().push(format!("hop {} index {}", text(route.get("model")), write.index));
        self.routes.lock().unwrap().push(route.clone());
        match *self.fail.lock().unwrap() {
            "write" => Err(PortError::Failed { capability: "session".into(), message: "session store is read-only".into() }),
            "closed" => Ok(None),
            _ => {
                let mut header = self.header.lock().unwrap();
                for (k, v) in route {
                    header.insert(k, v);
                }
                header.insert("routeFallbacks".into(), Value::Array(write.chain.clone()));
                if let Some(primary) = &write.primary {
                    header.insert("routeFallbackPrimary".into(), primary.clone());
                }
                header.insert("routeFallbackIndex".into(), json!(write.index));
                header.insert("routeFallbackFailures".into(), Value::Array(write.failures.clone()));
                header.insert("wireRoute".into(), Value::Null);
                Ok(Some(header.clone()))
            }
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
    async fn restore_header(&self, previous: Header) -> Result<(), PortError> {
        self.log.lock().unwrap().push("restore".into());
        *self.header.lock().unwrap() = previous;
        Ok(())
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
/// A model outside [`AGENT`]'s scope, and the refusal its route facts return for it.
const AGENT_WRONG_MODEL: &str = "wrong-model";
const AGENT_WRONG_MODEL_STATE: &str = "Test Agent does not run the model \"wrong-model\".";
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
    async fn ensure_route_ready(&self, config: &Obj, provider: &str, model: &str) -> Result<(), String> {
        if provider == AGENT && model == AGENT_WRONG_MODEL {
            return Err(AGENT_WRONG_MODEL_STATE.to_owned());
        }
        self.ensure_ready(config, provider).await
    }
    fn model_meta(&self, provider: &str, model: &str) -> Value {
        if provider == AGENT {
            return json!({ "provider": AGENT, "id": model, "runner": "acp", "display": "Test Agent" });
        }
        self.inner.model_meta(provider, model)
    }
    fn window_meta(&self, provider: &str, model: &str, meta: &Value) -> Option<Value> {
        if provider == AGENT && model == "default" {
            return Some(json!({ "contextWindow": 1_048_576, "maxContextWindow": 1_048_576 }));
        }
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

struct EmptyEnv;
impl Environment for EmptyEnv {
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

async fn harness_with_keys(
    script: Arc<Script>,
    header: Value,
    config: Value,
    keys: Option<ApiKeyStore>,
) -> (RegistryHopHost, Arc<Session>, Arc<ProviderRegistry>) {
    let registry = Arc::new(ProviderRegistry::new(Arc::new(Builder { script, fail_init: false, ghost: false })));
    let session = Arc::new(Session {
        header: Mutex::new(header.as_object().cloned().unwrap()),
        log: Mutex::default(),
        routes: Mutex::default(),
        pins: Mutex::default(),
        fail: Mutex::new(""),
    });
    let catalog = catalog().await;
    let config_obj = config.as_object().cloned().unwrap_or_default();
    let deps = HopDeps {
        facts: facts(registry.clone(), catalog.clone()).await,
        catalog,
        config: Arc::new(move || config_obj.clone()),
        bots: Arc::new(NoBots),
        errors: Arc::new(|e| e.message.clone()),
        wiring: Arc::new(NoWiring),
    };
    let keys = keys.unwrap_or_else(|| ApiKeyStore::new(Arc::new(MemoryVault::default()), Arc::new(EmptyEnv), false));
    (
        RegistryHopHost {
            deps,
            session: session.clone(),
            eligibility: None,
            keys: Some(keys),
            env: Arc::new(EmptyEnv),
            accounts: None,
            vertex_metadata_probe: Some(Arc::new(|| Box::pin(async { None }))),
            metadata_project: Arc::new(OnceCell::new()),
        },
        session,
        registry,
    )
}

async fn harness_with_config(script: Arc<Script>, header: Value, config: Value) -> (RegistryHopHost, Arc<Session>, Arc<ProviderRegistry>) {
    harness_with_keys(script, header, config, None).await
}

async fn harness(script: Arc<Script>, header: Value) -> (RegistryHopHost, Arc<Session>, Arc<ProviderRegistry>) {
    harness_with_config(script, header, json!({})).await
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
    let (unconfigured, _, _) = harness(Arc::new(Script::default()), json!({})).await;
    assert!(matches!(unconfigured.runner("openrouter").await, Ok(None)), "unconfigured openrouter must be gated");
    assert!(matches!(unconfigured.runner("openai-oauth").await, Ok(None)), "unauthenticated OAuth provider must be gated");

    // `enabled: true` without real credentials must be rejected.
    let (keyless_enabled, _, registry) =
        harness_with_config(Arc::new(Script::default()), json!({}), json!({ "providers": { "openrouter": { "enabled": true } } })).await;
    assert!(matches!(keyless_enabled.runner("openrouter").await, Ok(None)), "keyless enabled:true must be rejected");
    assert!(registry.registered("openrouter").is_none());

    // An unregistered provider backed by an OS keychain key in ApiKeyStore is accepted.
    let vault = Arc::new(MemoryVault::default());
    vault.set("agent.openrouter.apiKey", "sk-keychain-test").await.unwrap();
    let keys = ApiKeyStore::new(vault, Arc::new(EmptyEnv), false);
    let (keychain_host, _, _) = harness_with_keys(Arc::new(Script::default()), json!({}), json!({}), Some(keys)).await;
    assert!(matches!(keychain_host.runner("openrouter").await, Ok(Some(Runner::Loop(_)))), "keychain-authenticated provider must be accepted");

    let (host, _, _) =
        harness_with_config(Arc::new(Script::default()), json!({}), json!({ "providers": { "openrouter": { "enabled": true, "apiKey": "sk-test" } } })).await;
    assert!(matches!(host.runner("openrouter").await, Ok(Some(Runner::Loop(_)))));
    // `initProviders` throws for a provider that cannot be built; its message escapes.
    assert_eq!(host.runner("broken").await.err().as_deref(), Some("[provider] Failed to init \"broken\": cannot build"));
}

#[tokio::test]
async fn custom_provider_credential_gating_respects_auth_mode_and_keychain() {
    let (missing, _, _) =
        harness_with_config(Arc::new(Script::default()), json!({}), json!({ "providers": { "custom-x": { "type": "custom", "enabled": true } } })).await;
    assert!(matches!(missing.runner("custom-x").await, Ok(None)), "custom provider without key or auth=none must be rejected");

    let (no_auth, _, _) = harness_with_config(
        Arc::new(Script::default()),
        json!({}),
        json!({ "providers": { "custom-local": { "type": "custom", "auth": "none", "enabled": true } } }),
    )
    .await;
    assert!(matches!(no_auth.runner("custom-local").await, Ok(Some(Runner::Loop(_)))), "custom auth=none should be accepted");

    let vault = Arc::new(MemoryVault::default());
    vault.set("agent.custom-kc.apiKey", "sk-custom-kc").await.unwrap();
    let keys = ApiKeyStore::new(vault, Arc::new(EmptyEnv), false);
    let (kc, _, _) =
        harness_with_keys(Arc::new(Script::default()), json!({}), json!({ "providers": { "custom-kc": { "type": "custom", "enabled": true } } }), Some(keys))
            .await;
    assert!(matches!(kc.runner("custom-kc").await, Ok(Some(Runner::Loop(_)))), "custom provider with keychain key must be accepted");
}

#[tokio::test]
async fn unauthenticated_fallback_candidates_are_blocked_and_skipped() {
    use crate::run_host::route_fallback::{RouteDecision, RouteHop, RouteReadiness};
    let header = json!({ "provider": "openai", "model": "gpt-4o", "agent": "lead" });
    let config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "openai",
            "model": "gpt-4o",
            "fallbacks": [
                { "provider": "openai-oauth", "model": "gpt-5" },
                { "provider": "openrouter", "model": "unconfigured-model" },
                { "provider": AGENT, "model": "default" },
            ],
        }],
    });
    let (host, _, registry) = harness_with_config(Arc::new(Script::default()), header, config).await;
    assert!(matches!(host.route_readiness(&json!({ "provider": "openai-oauth", "model": "gpt-5" })).await, RouteReadiness::Unauthenticated { .. }));
    assert!(matches!(host.route_readiness(&json!({ "provider": "openrouter", "model": "unconfigured-model" })).await, RouteReadiness::Unauthenticated { .. }));
    assert_eq!(host.route_readiness(&json!({ "provider": AGENT, "model": "default" })).await, RouteReadiness::Ready);
    assert!(matches!(host.route_readiness(&json!({ "provider": SIGNED_OUT, "model": "default" })).await, RouteReadiness::Unauthenticated { .. }));

    let hop = RouteHop::new(Arc::new(host));
    let RouteDecision::Outside(outside) = hop.decide(ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent), None).await else {
        panic!("unauthenticated openai-oauth and openrouter should skip cleanly to ready ACP agent");
    };
    assert_eq!(outside.header["provider"], AGENT);
    assert!(registry.registered("openai-oauth").is_none(), "unauthenticated OAuth must never be force-registered");
    assert!(registry.registered("openrouter").is_none(), "unauthenticated openrouter must never be force-registered");
}

/// A fallback route an agent outside the loop serves is the agent's to run: the hop readies nothing under its name and
/// finds no failure recorded for it, and whether the agent can run is read as a pick of the route reads it, in the
/// agent's own words.
#[tokio::test]
async fn a_route_an_agent_serves_is_the_agents_to_run_and_readies_no_provider() {
    let calls: Calls = Arc::default();
    let (host, _, registry) = harness_with_config(
        Arc::new(Script { calls: Some(calls.clone()), ..Script::default() }),
        json!({}),
        json!({ "providers": { "openrouter": { "enabled": true, "apiKey": "sk-test" } } }),
    )
    .await;
    assert!(matches!(host.runner(AGENT).await, Ok(Some(Runner::Agent))));
    assert_eq!(host.agent_ready(AGENT, "default").await, Ok(()));
    assert_eq!(host.agent_ready(AGENT, AGENT_WRONG_MODEL).await, Err(AGENT_WRONG_MODEL_STATE.to_owned()));
    assert_eq!(host.agent_ready(SIGNED_OUT, "default").await, Err(SIGNED_OUT_STATE.to_owned()));
    assert_eq!(host.unavailable_cause(AGENT).await, (None, false));
    assert!(calls.lock().unwrap().is_empty(), "{:?}", calls.lock().unwrap());
    assert!(registry.registered(AGENT).is_none());
    assert!(registry.init_errors().is_empty());
    assert!(matches!(host.runner("openrouter").await, Ok(Some(Runner::Loop(_)))), "a provider's route is readied as before");
}

#[tokio::test]
async fn acp_window_meta_guides_context_overflow_without_writing_guessed_selected_window() {
    use crate::run_host::route_fallback::{RouteDecision, RouteHop};
    let header = json!({ "provider": "openai", "model": "gpt-4o", "agent": "lead", "rawContextWindow": 200_000 });
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "openai", "model": "gpt-4o", "fallbacks": [{ "provider": AGENT, "model": "default" }] }],
    });
    let (host, session, _) = harness_with_config(Arc::new(Script::default()), header, config).await;
    assert_eq!(host.raw_context_window(AGENT, "default", &json!({})), Some(1_048_576));
    let hop = RouteHop::new(Arc::new(host));
    let decision = hop.decide(ProviderError::new(ErrorKind::ContextOverflow, DeliveryState::NotSent), None).await;
    assert!(matches!(decision, RouteDecision::Outside(_)), "1M ACP window outgrows 200K overflow");
    let written = session.routes.lock().unwrap().clone();
    assert_eq!(written.len(), 1);
    assert_eq!(written[0].get("selectedContextWindow"), Some(&Value::Null), "must not clamp ACP route with catalog guess: {:?}", written[0]);
}

#[tokio::test]
async fn an_out_of_scope_agent_model_is_skipped_to_the_next_fallback() {
    use crate::run_host::route_fallback::{RouteDecision, RouteHop};
    let header = json!({ "provider": "openai", "model": "gpt-4o", "agent": "lead" });
    let config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "openai",
            "model": "gpt-4o",
            "fallbacks": [
                { "provider": AGENT, "model": AGENT_WRONG_MODEL },
                { "provider": "openrouter", "model": "m2" },
            ],
        }],
        "providers": { "openrouter": { "enabled": true, "apiKey": "sk-test" } },
    });
    let (host, _, _) = harness_with_config(Arc::new(Script::default()), header.clone(), config).await;
    let hop = RouteHop::new(Arc::new(host));
    let RouteDecision::Switch(switch) = hop.decide(ProviderError::new(ErrorKind::QuotaExhausted, DeliveryState::NotSent), None).await else {
        panic!("out-of-scope agent fallback should skip cleanly to openrouter")
    };
    assert_eq!(switch.model, "m2");

    let only_config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "openai",
            "model": "gpt-4o",
            "fallbacks": [{ "provider": AGENT, "model": AGENT_WRONG_MODEL }],
        }],
    });
    let (host, _, _) = harness_with_config(Arc::new(Script::default()), header, only_config).await;
    let hop = RouteHop::new(Arc::new(host));
    let RouteDecision::Surface(surface) = hop.decide(ProviderError::new(ErrorKind::QuotaExhausted, DeliveryState::NotSent), None).await else {
        panic!("when out-of-scope agent is the only fallback, its refusal surfaces")
    };
    assert!(surface.error.message.contains(AGENT_WRONG_MODEL_STATE), "{}", surface.error.message);
}

#[tokio::test]
async fn names_and_windows_read_as_a_notice_needs_them() {
    let (host, _, _) = harness(Arc::new(Script::default()), json!({ "provider": "openai", "model": "gpt-5" })).await;
    assert_eq!(host.model_label("openai", "gpt-5.4-2026-01-02"), "GPT-5.4");
    assert_eq!(host.model_label("custom", "custom-model-x"), "custom-model-x");
    assert_eq!(host.provider_label("anthropic-oauth"), "Anthropic OAuth");
    assert_eq!(host.provider_label("cursor-oauth"), "Cursor OAuth");
    assert_eq!(host.provider_label(AGENT), "Test Agent");
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
        ("pin", Err("cancelled"), vec!["hop m index 1", "pin", "restore"]),
        ("rebuild", Err("surface rebuild failed"), vec!["hop m index 1", "pin", "surface openrouter", "restore"]),
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

struct MapEnv(std::collections::HashMap<&'static str, String>);
impl Environment for MapEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

#[tokio::test]
async fn keyless_registered_http_provider_is_rejected_and_custom_additional_keys_are_admitted() {
    use crate::run_host::route_fallback::RouteHop;

    // 1. An already-registered HTTP provider without real credentials must be rejected by runner() and must not
    //    shrink the final usable route's retry budget by counting as a remaining fallback.
    let header = json!({ "provider": "openai", "model": "gpt-4o", "agent": "lead" });
    let config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "openai",
            "model": "gpt-4o",
            "fallbacks": [{ "provider": "anthropic", "model": "claude-sonnet" }],
        }],
        "providers": {
            "openai": { "enabled": true, "apiKey": "sk-openai" },
            "anthropic": { "enabled": true },
        },
    });
    let (host, _, registry) = harness_with_config(Arc::new(Script::default()), header, config).await;
    registry.init_providers(&ensure_provider_enabled(&Obj::new(), "anthropic")).await.unwrap();
    assert!(registry.registered("anthropic").is_some(), "anthropic adapter is already registered");
    assert!(matches!(host.runner("anthropic").await, Ok(None)), "keyless registered HTTP adapter must not be admitted");
    let hop = RouteHop::new(Arc::new(host));
    assert!(!hop.refresh_has_fallbacks().await, "keyless registered fallback must not shrink retry budget");

    // 2. A custom provider with no primary key but a valid additional key in the real AccountStore roster
    //    (provider-accounts.json, NOT injected into raw config.agent()) is admitted both via injected AccountStore
    //    and via the default MIXDOG_DATA_DIR roster lookup used by compose_parts.
    let roster_dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let accounts = Arc::new(AccountStore::new(roster_dir.path().to_path_buf(), io));
    let key1 = mixdog_ai::accounts::new_account_id();
    let key2 = mixdog_ai::accounts::new_account_id();
    accounts.set_custom_key_ids("custom-pool", vec![key1, key2.clone()]).await.unwrap();

    let vault = Arc::new(MemoryVault::default());
    vault.set(&format!("agent.custom-pool.apiKey.{key2}"), "sk-extra-2").await.unwrap();
    let keys = ApiKeyStore::new(vault.clone(), Arc::new(EmptyEnv), false);
    let custom_cfg = json!({
        "providers": {
            "custom-pool": {
                "type": "custom",
                "enabled": true,
            }
        }
    });
    let (mut custom_host_store, _, _) = harness_with_keys(Arc::new(Script::default()), json!({}), custom_cfg.clone(), Some(keys.clone())).await;
    custom_host_store.accounts = Some(accounts);
    assert!(
        matches!(custom_host_store.runner("custom-pool").await, Ok(Some(Runner::Loop(_)))),
        "custom provider with readable additional key in AccountStore must be admitted"
    );

    let data_dir_str = roster_dir.path().to_string_lossy().into_owned();
    let data_env = Arc::new(MapEnv(std::collections::HashMap::from([("MIXDOG_DATA_DIR", data_dir_str)])));
    let (mut custom_host_file, _, _) = harness_with_keys(Arc::new(Script::default()), json!({}), custom_cfg, Some(keys)).await;
    custom_host_file.env = data_env;
    assert!(
        matches!(custom_host_file.runner("custom-pool").await, Ok(Some(Runner::Loop(_)))),
        "custom provider with readable additional key in MIXDOG_DATA_DIR/provider-accounts.json must be admitted"
    );
}

#[tokio::test]
async fn registered_model_proxy_client_http_adapter_is_admitted_without_local_key() {
    let config = json!({
        "providers": {
            "anthropic": { "enabled": true },
        },
    });
    let proxy_env = Arc::new(MapEnv(std::collections::HashMap::from([("MIXDOG_MODEL_PROXY", "client".to_owned())])));
    let remote_keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), proxy_env.clone(), true);
    let (mut host, _, registry) = harness_with_keys(Arc::new(Script::default()), json!({}), config.clone(), Some(remote_keys)).await;
    host.env = proxy_env;
    registry.init_providers(&ensure_provider_enabled(&Obj::new(), "anthropic")).await.unwrap();
    assert!(registry.registered("anthropic").is_some());
    assert!(
        matches!(host.runner("anthropic").await, Ok(Some(Runner::Loop(_)))),
        "already-registered model-proxy client HTTP adapter must be admitted without a local key"
    );

    // Without MIXDOG_MODEL_PROXY=client, the exact same keyless registered adapter is still rejected.
    let (local_host, _, local_registry) = harness_with_config(Arc::new(Script::default()), json!({}), config).await;
    local_registry.init_providers(&ensure_provider_enabled(&Obj::new(), "anthropic")).await.unwrap();
    assert!(matches!(local_host.runner("anthropic").await, Ok(None)));
}

#[tokio::test]
async fn google_and_vertex_credential_gating_aligns_with_adapters() {
    let empty_cfg = Obj::new();

    // 1. Gemini rejects GOOGLE_API_KEY alone (adapter only accepts GEMINI_API_KEY).
    let google_only_env = Arc::new(MapEnv(std::collections::HashMap::from([("GOOGLE_API_KEY", "g-only".to_owned())])));
    let google_only_keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), google_only_env, false);
    assert!(
        !provider_has_credentials_with_env(&empty_cfg, "gemini", &google_only_keys, &|name| { (name == "GOOGLE_API_KEY").then(|| "g-only".to_owned()) })
            .await
            .unwrap(),
        "GOOGLE_API_KEY alone must not admit gemini"
    );

    let gemini_env = Arc::new(MapEnv(std::collections::HashMap::from([("GEMINI_API_KEY", "gem-key".to_owned())])));
    let gemini_keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), gemini_env, false);
    assert!(provider_has_credentials_with_env(&empty_cfg, "gemini", &gemini_keys, &|_| None).await.unwrap(), "GEMINI_API_KEY must admit gemini");

    // 2. Vertex AI ADC mode admits valid gcloud ADC JSON (matching vertex::parse_adc) without projectId override,
    //    rejects malformed ADC files even if metadata server is available, rejects missing explicit
    //    GOOGLE_APPLICATION_CREDENTIALS, and admits metadata-server / already-registered Vertex ADC routes.
    let dir = tempfile::tempdir().unwrap();
    let adc_path = dir.path().join("application_default_credentials.json");
    std::fs::write(&adc_path, r#"{"type":"authorized_user","client_id":"cid","client_secret":"csec","refresh_token":"rtok","quota_project_id":"demo"}"#)
        .unwrap();
    let adc_cfg_val = json!({ "providers": { "vertex-ai": { "enabled": true, "authMode": "adc" } } });
    let adc_cfg = adc_cfg_val.as_object().unwrap().clone();
    let no_keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), Arc::new(EmptyEnv), false);
    let cloudsdk = dir.path().to_string_lossy().into_owned();
    assert!(
        provider_has_credentials_with_env(&adc_cfg, "vertex-ai", &no_keys, &|name| (name == "CLOUDSDK_CONFIG").then(|| cloudsdk.clone())).await.unwrap(),
        "valid default gcloud ADC file must be admitted without projectId override"
    );

    // Malformed ADC file must be rejected even when metadata server answers.
    let bad_dir = tempfile::tempdir().unwrap();
    std::fs::write(bad_dir.path().join("application_default_credentials.json"), r#"{"type":"authorized_user","quota_project_id":"demo"}"#).unwrap();
    let bad_cloudsdk = bad_dir.path().to_string_lossy().into_owned();
    let (mut bad_adc_host, _, _) = harness_with_config(Arc::new(Script::default()), json!({}), adc_cfg_val.clone()).await;
    bad_adc_host.env = Arc::new(MapEnv(std::collections::HashMap::from([("CLOUDSDK_CONFIG", bad_cloudsdk)])));
    bad_adc_host.vertex_metadata_probe = Some(Arc::new(|| Box::pin(async { Some("meta-proj".to_owned()) })));
    assert!(matches!(bad_adc_host.runner("vertex-ai").await, Ok(None)), "malformed ADC file must be rejected and never fall back to metadata server");

    let missing_explicit = dir.path().join("does-not-exist.json").to_string_lossy().into_owned();
    assert!(
        !provider_has_credentials_with_env(&adc_cfg, "vertex-ai", &no_keys, &|name| match name {
            "GOOGLE_APPLICATION_CREDENTIALS" => Some(missing_explicit.clone()),
            "CLOUDSDK_CONFIG" => Some(cloudsdk.clone()),
            _ => None,
        })
        .await
        .unwrap(),
        "missing explicit GOOGLE_APPLICATION_CREDENTIALS must not fall back to gcloud default"
    );

    // No ADC file + GCE metadata server available admits unregistered vertex-ai route.
    let empty_dir = tempfile::tempdir().unwrap();
    let empty_cloudsdk = empty_dir.path().to_string_lossy().into_owned();
    let (mut meta_host, _, _) = harness_with_config(Arc::new(Script::default()), json!({}), adc_cfg_val.clone()).await;
    meta_host.env = Arc::new(MapEnv(std::collections::HashMap::from([("CLOUDSDK_CONFIG", empty_cloudsdk.clone())])));
    meta_host.vertex_metadata_probe = Some(Arc::new(|| Box::pin(async { Some("meta-proj".to_owned()) })));
    assert!(
        matches!(meta_host.runner("vertex-ai").await, Ok(Some(Runner::Loop(_)))),
        "working GCE metadata-server ADC route must be admitted when no local ADC file exists"
    );

    // Already-registered metadata-server Vertex ADC route is never rejected when no local ADC file exists.
    let (mut reg_meta_host, _, reg_meta_registry) = harness_with_config(Arc::new(Script::default()), json!({}), adc_cfg_val.clone()).await;
    reg_meta_host.env = Arc::new(MapEnv(std::collections::HashMap::from([("CLOUDSDK_CONFIG", empty_cloudsdk.clone())])));
    reg_meta_host.vertex_metadata_probe = Some(Arc::new(|| Box::pin(async { None })));
    reg_meta_registry.init_providers(&ensure_provider_enabled(&Obj::new(), "vertex-ai")).await.unwrap();
    assert!(
        matches!(reg_meta_host.runner("vertex-ai").await, Ok(Some(Runner::Loop(_)))),
        "already-registered Vertex ADC adapter must not be rejected for lacking a local ADC file"
    );

    // No ADC file + no metadata server + projectId alone is rejected.
    let project_only_cfg = json!({ "providers": { "vertex-ai": { "enabled": true, "authMode": "adc", "projectId": "demo" } } }).as_object().unwrap().clone();
    assert!(
        !provider_has_credentials_with_env(&project_only_cfg, "vertex-ai", &no_keys, &|name| { (name == "CLOUDSDK_CONFIG").then(|| empty_cloudsdk.clone()) })
            .await
            .unwrap(),
        "projectId alone without ADC file or metadata server must not admit vertex-ai"
    );
}

#[tokio::test]
async fn apply_hop_rolls_back_header_and_fallback_history_on_pin_or_surface_failure() {
    let script = Arc::new(Script {
        routing: true,
        route: Some(WireRoute { wire: "chat".into(), source: "default".into(), profile_id: "openrouter:chat".into() }),
        ..Script::default()
    });
    let original = json!({
        "provider": "openai",
        "model": "gpt-4o",
        "wireRoute": { "provider": "openai", "model": "gpt-4o", "wire": "responses" },
    });
    let dest = route_of(&json!({ "provider": "openrouter", "model": "m2" }));
    let hop_write = HopWrite {
        chain: vec![json!({ "provider": "openrouter", "model": "m2" })],
        primary: Some(json!({ "provider": "openai", "model": "gpt-4o" })),
        index: 1,
        failures: vec![json!({ "provider": "openai", "model": "gpt-4o", "kind": "transient", "error": "503" })],
        checkpoint_route_changed: false,
    };

    for fail in ["pin", "rebuild"] {
        let (host, session, registry) = harness(script.clone(), original.clone()).await;
        registry.init_providers(&ensure_provider_enabled(&Obj::new(), "openrouter")).await.unwrap();
        *session.fail.lock().unwrap() = fail;
        assert!(host.apply_hop(dest.clone(), hop_write.clone()).await.is_err(), "{fail} must return Err");
        let after = Value::Object(session.header.lock().unwrap().clone());
        assert_eq!(after, original, "{fail} failure must restore exact pre-hop header and clear uncommitted fallback history");
    }
}

#[tokio::test]
async fn apply_hop_cancelled_mid_flight_rolls_back_session_header() {
    struct HangingSession {
        header: Mutex<Header>,
        hang_on: &'static str,
        entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        restored: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    }
    #[async_trait]
    impl HopSession for HangingSession {
        fn header(&self) -> Option<Arc<Header>> {
            Some(Arc::new(self.header.lock().unwrap().clone()))
        }
        async fn write_hop(&self, route: Obj, write: &HopWrite) -> Result<Option<Header>, PortError> {
            let mut header = self.header.lock().unwrap();
            for (k, v) in route {
                header.insert(k, v);
            }
            header.insert("routeFallbacks".into(), Value::Array(write.chain.clone()));
            if let Some(primary) = &write.primary {
                header.insert("routeFallbackPrimary".into(), primary.clone());
            }
            header.insert("routeFallbackIndex".into(), json!(write.index));
            header.insert("routeFallbackFailures".into(), Value::Array(write.failures.clone()));
            header.insert("wireRoute".into(), Value::Null);
            Ok(Some(header.clone()))
        }
        async fn write_wire_pin(&self, pin: Value) -> Result<(), PortError> {
            if self.hang_on == "pin" {
                if let Some(tx) = self.entered.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                std::future::pending::<()>().await;
            }
            self.header.lock().unwrap().insert("wireRoute".into(), pin);
            Ok(())
        }
        async fn rebuild_tool_surface(&self, _provider: &str) -> Result<(), PortError> {
            if self.hang_on == "rebuild" {
                if let Some(tx) = self.entered.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                std::future::pending::<()>().await;
            }
            Ok(())
        }
        async fn restore_header(&self, previous: Header) -> Result<(), PortError> {
            *self.header.lock().unwrap() = previous;
            if let Some(tx) = self.restored.lock().unwrap().take() {
                let _ = tx.send(());
            }
            Ok(())
        }
    }

    let script = Arc::new(Script {
        routing: true,
        route: Some(WireRoute { wire: "chat".into(), source: "default".into(), profile_id: "openrouter:chat".into() }),
        ..Script::default()
    });
    let original = json!({
        "provider": "openai",
        "model": "gpt-4o",
        "wireRoute": { "provider": "openai", "model": "gpt-4o", "wire": "responses" },
    });
    let dest = route_of(&json!({ "provider": "openrouter", "model": "m2" }));
    let hop_write = HopWrite {
        chain: vec![json!({ "provider": "openrouter", "model": "m2" })],
        primary: Some(json!({ "provider": "openai", "model": "gpt-4o" })),
        index: 1,
        failures: vec![json!({ "provider": "openai", "model": "gpt-4o", "kind": "transient", "error": "503" })],
        checkpoint_route_changed: false,
    };

    for hang_on in ["pin", "rebuild"] {
        let registry = Arc::new(ProviderRegistry::new(Arc::new(Builder { script: script.clone(), fail_init: false, ghost: false })));
        registry.init_providers(&ensure_provider_enabled(&Obj::new(), "openrouter")).await.unwrap();
        let catalog = catalog().await;
        let deps = HopDeps {
            facts: facts(registry.clone(), catalog.clone()).await,
            catalog,
            config: Arc::new(Obj::new),
            bots: Arc::new(NoBots),
            errors: Arc::new(|e| e.message.clone()),
            wiring: Arc::new(NoWiring),
        };
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (restored_tx, restored_rx) = tokio::sync::oneshot::channel();
        let session = Arc::new(HangingSession {
            header: Mutex::new(original.as_object().cloned().unwrap()),
            hang_on,
            entered: Mutex::new(Some(entered_tx)),
            restored: Mutex::new(Some(restored_tx)),
        });
        let host = RegistryHopHost {
            deps,
            session: session.clone(),
            eligibility: None,
            keys: Some(ApiKeyStore::new(Arc::new(MemoryVault::default()), Arc::new(EmptyEnv), false)),
            env: Arc::new(EmptyEnv),
            accounts: None,
            vertex_metadata_probe: Some(Arc::new(|| Box::pin(async { None }))),
            metadata_project: Arc::new(OnceCell::new()),
        };

        let cancelled = tokio::select! {
            _ = host.apply_hop(dest.clone(), hop_write.clone()) => false,
            _ = entered_rx => true,
        };
        assert!(cancelled, "hop must be dropped mid-flight while awaiting {hang_on}");
        tokio::time::timeout(std::time::Duration::from_secs(5), restored_rx).await.expect("drop rollback must complete").expect("restore_header signalled");
        let after = Value::Object(session.header.lock().unwrap().clone());
        assert_eq!(after, original, "dropping apply_hop mid-{hang_on} must restore original pre-hop header");
    }
}

#[tokio::test]
async fn oauth_credential_fingerprint_reflects_token_material_and_logout_relogin() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let accounts = Arc::new(AccountStore::new(dir.path().to_path_buf(), io));
    let (mut host, _, _) = harness_with_config(Arc::new(Script::default()), json!({}), json!({})).await;
    host.accounts = Some(accounts.clone());

    // Signed out initially -> oauth:absent (never bare "oauth:present").
    let absent = host.credential_fingerprint("openai-oauth").await.expect("fingerprint");
    assert_eq!(absent, "oauth:absent");

    // Sign in with token 1 -> real SHA-256 digest of credential material.
    let cred_path = dir.path().join("openai-oauth.json");
    std::fs::write(&cred_path, r#"{"access_token":"tok-1","refresh_token":"ref-1","expires_at":1700000000}"#).unwrap();
    let fp1 = host.credential_fingerprint("openai-oauth").await.expect("fp1");
    assert!(fp1.starts_with("sha256:"), "expected sha256 digest, got {fp1}");
    assert_ne!(fp1, "oauth:present");
    assert_eq!(host.credential_fingerprint("openai-oauth").await.as_deref(), Some(fp1.as_str()), "unchanged token keeps same fingerprint");

    // Logout removes credential file -> distinct "oauth:absent" fingerprint.
    std::fs::remove_file(&cred_path).unwrap();
    let logged_out = host.credential_fingerprint("openai-oauth").await.expect("logged out");
    assert_eq!(logged_out, "oauth:absent");
    assert_ne!(logged_out, fp1);

    // Fresh sign-in writes new token material -> distinct SHA-256 fingerprint.
    std::fs::write(&cred_path, r#"{"access_token":"tok-2","refresh_token":"ref-2","expires_at":1800000000}"#).unwrap();
    let fp2 = host.credential_fingerprint("openai-oauth").await.expect("fp2");
    assert!(fp2.starts_with("sha256:"));
    assert_ne!(fp2, fp1, "fresh sign-in must produce a distinct fingerprint");
    assert_ne!(fp2, logged_out);
}

#[tokio::test]
async fn damaged_custom_key_roster_recovers_via_account_store_backup() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let accounts = Arc::new(AccountStore::new(dir.path().to_path_buf(), io));
    let key1 = mixdog_ai::accounts::new_account_id();
    let key2 = mixdog_ai::accounts::new_account_id();
    // Write twice so AccountStore/mixdog-statefile rotates the first valid roster into provider-accounts.json.bak.
    accounts.set_custom_key_ids("custom-backup", vec![key1.clone()]).await.unwrap();
    accounts.set_custom_key_ids("custom-backup", vec![key1.clone(), key2.clone()]).await.unwrap();
    // Corrupt the primary roster file; backup holds [key1].
    std::fs::write(accounts.roster_path(), "{corrupt-json").unwrap();

    let vault = Arc::new(MemoryVault::default());
    vault.set(&format!("agent.custom-backup.apiKey.{key1}"), "sk-recovered-from-bak").await.unwrap();
    let keys = ApiKeyStore::new(vault, Arc::new(EmptyEnv), false);
    let custom_cfg = json!({
        "providers": {
            "custom-backup": { "type": "custom", "enabled": true }
        }
    });

    // 1. Production path with injected AccountStore recovers damaged roster from .bak and admits the provider.
    let (mut store_host, _, _) = harness_with_config(Arc::new(Script::default()), json!({}), custom_cfg.clone()).await;
    store_host.keys = Some(keys.clone());
    store_host.accounts = Some(accounts.clone());
    assert!(
        matches!(store_host.runner("custom-backup").await, Ok(Some(Runner::Loop(_)))),
        "AccountStore must recover damaged roster via .bak and admit custom-backup"
    );

    // 2. Fallback MIXDOG_DATA_DIR path (when AccountStore is omitted) also recovers from .bak on damaged JSON.
    let fallback_dir = tempfile::tempdir().unwrap();
    let fallback_accounts = AccountStore::new(fallback_dir.path().to_path_buf(), io);
    fallback_accounts.set_custom_key_ids("custom-backup", vec![key1.clone()]).await.unwrap();
    fallback_accounts.set_custom_key_ids("custom-backup", vec![key1.clone(), key2.clone()]).await.unwrap();
    std::fs::write(fallback_accounts.roster_path(), "{corrupt-json").unwrap();

    let (mut env_host, _, _) = harness_with_config(Arc::new(Script::default()), json!({}), custom_cfg).await;
    env_host.keys = Some(keys);
    env_host.env = Arc::new(MapEnv(std::collections::HashMap::from([("MIXDOG_DATA_DIR", fallback_dir.path().to_string_lossy().into_owned())])));
    assert!(matches!(env_host.runner("custom-backup").await, Ok(Some(Runner::Loop(_)))), "MIXDOG_DATA_DIR fallback must also recover damaged roster via .bak");
}

#[tokio::test]
async fn vertex_authorized_user_adc_requires_resolvable_cloud_project_and_preflight_advances() {
    let dir = tempfile::tempdir().unwrap();
    let adc_path = dir.path().join("application_default_credentials.json");
    // Valid authorized_user ADC JSON, intentionally WITHOUT quota_project_id, env project, or gcloud config project.
    std::fs::write(&adc_path, r#"{"type":"authorized_user","client_id":"cid","client_secret":"csec","refresh_token":"rtok"}"#).unwrap();
    let cloudsdk = dir.path().to_string_lossy().into_owned();
    let config = json!({
        "default": "p",
        "presets": [{
            "id": "p",
            "provider": "openai",
            "model": "gpt-4o",
            "fallbacks": [
                { "provider": "vertex-ai", "model": "gemini-2.5-pro" },
                { "provider": "openrouter", "model": "fallback-ok" }
            ]
        }],
        "providers": {
            "openai": { "enabled": false },
            "vertex-ai": { "enabled": true, "authMode": "adc" },
            "openrouter": { "enabled": true, "apiKey": "sk-or-ok" }
        }
    });
    let session = json!({
        "owner": "agent",
        "agent": "mixy",
        "provider": "openai",
        "model": "gpt-4o",
        "routeFallbackSource": { "preset": "p" },
    });
    let (mut host, session_store, _) = harness_with_config(Arc::new(Script::default()), session, config.clone()).await;
    host.env = Arc::new(MapEnv(std::collections::HashMap::from([("CLOUDSDK_CONFIG", cloudsdk.clone())])));
    host.vertex_metadata_probe = Some(Arc::new(|| Box::pin(async { None })));

    assert!(matches!(host.runner("vertex-ai").await, Ok(None)), "authorized_user ADC without any resolvable Cloud project must not be admitted as ready");

    // Preflight skips vertex-ai cleanly and lands on openrouter instead of failing adapter init.
    let hop = crate::run_host::route_fallback::RouteHop::new(Arc::new(host));
    let decision = hop.preflight(None, false, false).await.expect("preflight must not error on projectless ADC");
    assert!(
        matches!(decision, crate::run_host::route_fallback::PreflightDecision::SwitchLoop(_)),
        "preflight must advance past projectless vertex-ai ADC to openrouter"
    );
    let after = session_store.header.lock().unwrap().clone();
    assert_eq!(after.get("provider").and_then(Value::as_str), Some("openrouter"));
    assert_eq!(after.get("model").and_then(Value::as_str), Some("fallback-ok"));

    // Once gcloud active configuration supplies `[core] project = ...`, vertex-ai ADC is admitted.
    let cfgs = dir.path().join("configurations");
    std::fs::create_dir_all(&cfgs).unwrap();
    std::fs::write(cfgs.join("config_default"), "[core]\nproject = gcloud-configured-proj\n").unwrap();
    let (mut host_with_project, _, _) = harness_with_config(Arc::new(Script::default()), json!({}), config).await;
    host_with_project.env = Arc::new(MapEnv(std::collections::HashMap::from([("CLOUDSDK_CONFIG", cloudsdk)])));
    host_with_project.vertex_metadata_probe = Some(Arc::new(|| Box::pin(async { None })));
    assert!(
        matches!(host_with_project.runner("vertex-ai").await, Ok(Some(Runner::Loop(_)))),
        "authorized_user ADC with gcloud [core] project must be admitted"
    );
}
