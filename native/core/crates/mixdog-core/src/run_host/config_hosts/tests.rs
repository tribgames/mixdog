use std::path::Path;
use std::sync::Mutex;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_ports::ports::route::Route;

use super::*;

const TWIN: &str = include_str!("../../../../../fixtures/desktop/settings/config-hosts-twin.json");

struct Headers(Option<Header>);

#[async_trait]
impl ThreadHeaders for Headers {
    async fn header(&self, _: &ThreadId) -> Result<Option<Header>, CoreError> {
        Ok(self.0.clone())
    }
}

/// A header store whose read never ran.
struct Unreadable;

#[async_trait]
impl ThreadHeaders for Unreadable {
    async fn header(&self, _: &ThreadId) -> Result<Option<Header>, CoreError> {
        Err(CoreError::QueueFull { queue: "interactive".into() })
    }
}

struct Routes(Route);

impl LiveRoute for Routes {
    fn route(&self, _: &ThreadId) -> Route {
        self.0.clone()
    }
    fn adopt_held(&self, _: &ThreadId, _: &Route) {}
}

#[derive(Default)]
struct Gauge(Mutex<Vec<String>>);

impl ContextStatusCache for Gauge {
    fn invalidate(&self, thread: &ThreadId) {
        self.0.lock().unwrap().push(thread.to_string());
    }
}

struct Agents(Vec<String>);

#[async_trait]
impl CustomAgentIds for Agents {
    async fn ids(&self) -> Vec<String> {
        self.0.clone()
    }
}

/// A catalog that lists exactly the rows it is given.
struct Facts(Map<String, Value>);

#[async_trait]
impl RouteFacts for Facts {
    fn is_known(&self, provider: &str, _: &Map<String, Value>) -> bool {
        matches!(provider, "openai" | "anthropic")
    }
    async fn ensure_ready(&self, _: &Map<String, Value>, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn model_meta(&self, _: &str, model: &str) -> Value {
        self.0.get(model).cloned().unwrap_or(Value::Null)
    }
    fn window_meta(&self, _: &str, _: &str, _: &Value) -> Option<Value> {
        None
    }
    fn catalog_knows(&self, model: &str, _: &str) -> bool {
        self.0.contains_key(model)
    }
    fn fast_capable(&self, _: &str, meta: &Value, _: Option<&str>, _: &Value) -> bool {
        meta.get("supportsFastMode") == Some(&Value::Bool(true))
    }
    fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
        false
    }
}

struct Ready;

#[async_trait]
impl ProvidersReady for Ready {
    async fn ensure(&self, providers: Map<String, Value>) -> Result<(), String> {
        if providers.contains_key("broken") { Err("provider broken".into()) } else { Ok(()) }
    }
}

#[derive(Default)]
struct Refresh(Mutex<u32>);

impl AuthRefresh for Refresh {
    fn after_credential_change(&self) {
        *self.0.lock().unwrap() += 1;
    }
    fn adopt_credentials(&self) {}
    fn after_usage_auth_change(&self) {}
    fn release_admission_cooldowns(&self) {}
    fn account_selection_changed(&self) {}
}

struct Rig {
    hosts: ConfigHosts,
    gauge: Arc<Gauge>,
    refresh: Arc<Refresh>,
}

async fn rig(dir: &Path, agent: Value, header: Option<Header>, catalog: Map<String, Value>, env: &'static [(&str, &str)]) -> Rig {
    let tokens = mixdog_rt::testing::tokens();
    let path = dir.join("mixdog-config.json");
    crate::run_host::fixture_fs::write(&path, serde_json::to_vec(&json!({ "agent": agent })).unwrap());
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let gauge = Arc::new(Gauge::default());
    let refresh = Arc::new(Refresh::default());
    let route: Route = json!({ "provider": "anthropic", "model": "claude-opus-4-5" }).as_object().unwrap().clone();
    let hosts = ConfigHosts {
        config,
        headers: Arc::new(Headers(header)),
        routes: Arc::new(Routes(route)),
        gauge: gauge.clone(),
        agents: Arc::new(Agents(vec!["reviewer".into()])),
        facts: Arc::new(Facts(catalog)),
        ready: Arc::new(Ready),
        refresh: refresh.clone(),
        env: Arc::new(move |name| env.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())),
    };
    Rig { hosts, gauge, refresh }
}

fn none() -> Map<String, Value> {
    Map::new()
}

/// `webSearchCapableFor(provider, model)` of Node over a bare id, a route row and nothing, with the
/// catalog consulted by `catalogRowFor(id, provider)`.
#[tokio::test]
async fn web_search_capability_is_nodes_for_every_form_of_the_model() {
    let twin: Value = serde_json::from_str(TWIN).unwrap();
    let catalog = twin["catalog"].as_object().unwrap().clone();
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path(), json!({}), None, catalog, &[]).await;
    let cases = twin["cases"].as_array().unwrap();
    assert!(cases.len() > 700);
    for case in cases {
        let model = if case["model"].is_null() { None } else { Some(&case["model"]) };
        let got = rig.hosts.web_search_capable(case["provider"].as_str().unwrap(), model);
        assert_eq!(got, case["expected"].as_bool().unwrap(), "{case}");
    }
}

/// An unread record is not a missing thread: `ThreadNotFound` is for a record that was read.
#[tokio::test]
async fn a_thread_record_that_was_not_read_is_not_a_missing_thread() {
    let dir = tempfile::tempdir().unwrap();
    let mut rig = rig(dir.path(), json!({}), None, none(), &[]).await;
    rig.hosts.headers = Arc::new(Unreadable);
    assert_eq!(rig.hosts.thread_mode_facts("t3").await, Err(CoreError::QueueFull { queue: "interactive".into() }));
}

#[tokio::test]
async fn the_compaction_host_reads_the_threads_route_and_the_boot_route() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path(), json!({ "default": "main", "presets": [{ "id": "main", "provider": "openai", "model": "gpt-5" }] }), None, none(), &[]).await;
    let thread = ThreadId::from("t1");
    assert_eq!(rig.hosts.route_provider(Some(&thread)).as_deref(), Some("anthropic"));
    // No thread: `resolveRoute(config, {})`, the configured default route.
    assert_eq!(rig.hosts.route_provider(None).as_deref(), Some("openai"));
    rig.hosts.invalidate_context_status(Some(&thread));
    rig.hosts.invalidate_context_status(None);
    assert_eq!(*rig.gauge.0.lock().unwrap(), vec!["t1".to_owned()]);
}

#[tokio::test]
async fn a_thread_gives_the_facts_the_orchestration_mode_is_read_from() {
    let dir = tempfile::tempdir().unwrap();
    let header: Header = json!({ "orchestrationMode": "swarm", "pendingOrchestrationMode": "none", "workflow": { "id": "default" }, "title": "x" })
        .as_object()
        .unwrap()
        .clone();
    let known = rig(dir.path(), json!({}), Some(header), none(), &[]).await;
    assert_eq!(
        known.hosts.thread_mode_facts("t1").await.unwrap(),
        json!({ "orchestrationMode": "swarm", "pendingOrchestrationMode": "none", "workflow": { "id": "default" } })
    );
    let missing = rig(dir.path(), json!({}), None, none(), &[]).await;
    assert_eq!(missing.hosts.thread_mode_facts("t2").await, Err(CoreError::ThreadNotFound { thread_id: ThreadId::from("t2") }));
}

#[tokio::test]
async fn the_workflow_host_answers_from_the_providers_agents_and_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let mut catalog = Map::new();
    catalog.insert("claude-opus-4-5".into(), json!({ "id": "claude-opus-4-5", "supportsFastMode": true }));
    let rig = rig(dir.path(), json!({ "developer": {} }), None, catalog, &[]).await;
    let host = &rig.hosts;
    assert_eq!(host.custom_agent_ids().await, vec!["reviewer".to_owned()]);
    assert_eq!(host.lookup_model_meta("anthropic", "claude-opus-4-5").await.unwrap()["id"], "claude-opus-4-5");
    assert_eq!(host.lookup_model_meta("anthropic", "nope").await, None);
    assert!(host.fast_capable("anthropic", Some(&json!({ "supportsFastMode": true })), None, None));
    assert!(!host.fast_capable("anthropic", None, None, None));
    assert_eq!(host.normalize_stored_custom_config(&json!("x")), Err("[custom-provider] config must be an object".to_owned()));
    assert!(host.ensure_providers_ready(none()).await.is_ok());
    let mut broken = Map::new();
    broken.insert("broken".into(), json!({}));
    assert_eq!(host.ensure_providers_ready(broken).await, Err("provider broken".to_owned()));
    host.after_credential_change().await;
    assert_eq!(*rig.refresh.0.lock().unwrap(), 1);
}

/// `providerAvailable` over the stored Developer options, and `requireLocalProviderManagement`.
#[tokio::test]
async fn provider_gating_follows_the_developer_options_() {
    let dir = tempfile::tempdir().unwrap();
    let local = rig(dir.path(), json!({}), None, none(), &[]).await;
    assert!(local.hosts.provider_available("openai"));
    assert_eq!(local.hosts.require_local_provider_management(), Ok(()));
}
