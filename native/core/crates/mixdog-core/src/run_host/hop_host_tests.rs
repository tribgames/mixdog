use std::sync::Mutex;

use mixdog_ai::catalog::{CatalogSnapshot, ModelsDevSource};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
use mixdog_core_api::domain::provider::{
    DeliveryState, ErrorKind, ErrorResponse, ModelRequest, ModelStream, WireCodec, WireDecoder, WireRequest, WireRoute, WireRouting,
};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use super::*;

const GOLDEN: &str = include_str!("../../../../fixtures/hop-host/golden.json");

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
}

struct Gateway {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    script: Arc<Script>,
}

#[async_trait]
impl ProviderAdapter for Gateway {
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
        if self.script.fails {
            return Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent));
        }
        Ok(self.script.route.clone())
    }
}

struct Builder {
    script: Arc<Script>,
}

#[async_trait]
impl ProviderBuilder for Builder {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        if name == "broken" {
            return Err("cannot build".into());
        }
        Ok(Arc::new(Gateway {
            id: ProviderId::from(name),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            script: self.script.clone(),
        }))
    }
    async fn custom_key_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn available(&self, _: &str) -> bool {
        true
    }
    async fn oauth_credentials_usable(&self, _: &str) -> bool {
        false
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
impl BotRoutes for NoBots {
    fn bot_route(&self, _: &str) -> Option<Option<Value>> {
        None
    }
    fn stored_bot_route(&self, _: &str) -> Option<Value> {
        None
    }
}

struct Offline;
#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest) -> Result<HttpResponse, ProviderError> {
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

async fn harness(script: Arc<Script>, header: Value) -> (RegistryHopHost, Arc<Session>) {
    let registry = Arc::new(ProviderRegistry::new(Arc::new(Builder { script })));
    let session = Arc::new(Session { header: header.as_object().cloned().unwrap(), log: Mutex::default(), pins: Mutex::default(), fail: Mutex::new("") });
    let deps = HopDeps {
        registry,
        catalog: catalog().await,
        config: Arc::new(Obj::new),
        bots: Arc::new(NoBots),
        errors: Arc::new(|e| e.message.clone()),
        wiring: Arc::new(NoWiring),
    };
    (RegistryHopHost { deps, session: session.clone() }, session)
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

/// Every wire pin Node recorded for a hop's session: what was asked of the provider and what
/// was pinned. The two sessions that predate the wire table cannot follow a hop (a route change
/// leaves `wireRoute` null), so they are not replayed.
#[tokio::test]
async fn the_wire_pin_is_the_one_node_makes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let mut replayed = 0;
    for case in golden["pins"].as_array().unwrap() {
        let session = &case["session"];
        let asked_legacy = case["asked"].as_array().unwrap().iter().any(|a| a["legacy"] == true);
        if asked_legacy || session.get("wireRoute").is_none() && case["answered"] == true {
            continue;
        }
        let script = &case["script"];
        let route = script["route"].as_object().map(|r| WireRoute {
            wire: r["wire"].as_str().unwrap().into(),
            source: r["source"].as_str().unwrap().into(),
            profile_id: r["profileId"].as_str().unwrap().into(),
        });
        let provider = session["provider"].as_str().unwrap();
        let routing = Arc::new(Script { routing: script["noRouting"] != true, route, fails: script["throws"] == true, asked: Mutex::default() });
        let (host, written) = harness(routing.clone(), session.clone()).await;
        host.deps.registry.init_providers(&ensure_provider_enabled(&Obj::new(), provider)).await.unwrap();
        host.apply_hop(route_of(session), write()).await.unwrap().expect("updated");
        let asked: Vec<_> = routing.asked.lock().unwrap().iter().map(|(m, c)| json!({ "model": m, "agent": c.agent, "legacy": c.legacy })).collect();
        assert_eq!(Value::Array(asked), case["asked"], "{}", case["name"]);
        let pins = written.pins.lock().unwrap();
        match case["pin"].as_object() {
            Some(pin) if case["wrote"] == true => assert_eq!(*pins, [Value::Object(pin.clone())], "{}", case["name"]),
            _ => assert!(pins.is_empty(), "{}", case["name"]),
        }
        replayed += 1;
    }
    assert!(replayed >= 10);
}

#[tokio::test]
async fn the_hop_writes_then_pins_then_rebuilds_a_lead_surface() {
    let script = Arc::new(Script {
        routing: true,
        route: Some(WireRoute { wire: "chat".into(), source: "default".into(), profile_id: "openrouter:chat".into() }),
        ..Script::default()
    });
    let header = json!({ "provider": "openrouter", "model": "m", "wireRoute": null });
    let (host, session) = harness(script.clone(), header.clone()).await;
    host.deps.registry.init_providers(&ensure_provider_enabled(&Obj::new(), "openrouter")).await.unwrap();
    host.apply_hop(route_of(&header), write()).await.unwrap().expect("updated");
    assert_eq!(*session.log.lock().unwrap(), ["hop m index 1", "pin", "surface openrouter"]);

    let agent = json!({ "provider": "openrouter", "model": "m", "wireRoute": null, "owner": " Agent " });
    let (host, session) = harness(script, agent.clone()).await;
    host.deps.registry.init_providers(&ensure_provider_enabled(&Obj::new(), "openrouter")).await.unwrap();
    host.apply_hop(route_of(&agent), write()).await.unwrap().expect("updated");
    assert_eq!(*session.log.lock().unwrap(), ["hop m index 1", "pin"]);
}

#[tokio::test]
async fn the_next_provider_comes_from_the_registry_once_enabled() {
    let (host, _) = harness(Arc::new(Script::default()), json!({})).await;
    assert!(host.provider("openrouter").await.unwrap().is_some());
    // `initProviders` throws for a provider that cannot be built; its message escapes.
    assert_eq!(host.provider("broken").await.err().as_deref(), Some("[provider] Failed to init \"broken\": cannot build"));
}

#[tokio::test]
async fn names_and_windows_read_as_a_notice_needs_them() {
    let (host, _) = harness(Arc::new(Script::default()), json!({ "provider": "openai", "model": "gpt-5" })).await;
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
        let (host, session) = harness(script.clone(), header.clone()).await;
        host.deps.registry.init_providers(&ensure_provider_enabled(&Obj::new(), "openrouter")).await.unwrap();
        *session.fail.lock().unwrap() = fail;
        let got = host.apply_hop(route_of(&header), write()).await;
        let expect: Result<bool, &str> = expect;
        assert_eq!(got.map(|u| u.is_some()), expect.map_err(String::from), "{fail}");
        assert_eq!(*session.log.lock().unwrap(), log, "{fail}");
    }
}