//! The turn-assembly seams built from one [`ProcessServices`]: the provider builder's inputs, the
//! accounting identity of a send, the step judge's ladder and the hop's wiring and error text.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::text_only::MediaText;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ListingLookup, ModelRecord, ModelsDevSource};
use mixdog_ai::client_versions::ClientVersions;
use mixdog_ai::effort::RejectionEntry;
use mixdog_ai::netproxy::NetworkProxy;
use mixdog_ai::netproxy::system::SystemProxy;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::{Environment, MemoryVault};
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ModelRequest, ProviderAdapter, ProviderError, RequestOptions, WireRequest};
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_protocol::ProviderId;
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use super::accounting_scope::HeaderScope;
use super::builder_env::{CatalogCaps, CatalogOpenAiFacts, builder_env, client_identity};
use super::fixture_fs;
use super::hop_bindings::HopBindings;
use super::ladder_sources::ProcessLadder;
use super::process::{EffortRejections, FileRejections, HostInfo, LocalModels, ProcessServices, SessionHeaders, resolve_installation_id};
use super::step_judge::{LadderSources, ladder_facts};
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_run::run_host::route_wiring::LocalEntry;

struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

struct TestEnv(HashMap<String, String>);

impl Environment for TestEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

#[derive(Default)]
struct Headers(Mutex<HashMap<String, Arc<Header>>>);

impl SessionHeaders for Headers {
    fn header(&self, session_id: &str) -> Option<Arc<Header>> {
        self.0.lock().unwrap().get(session_id).cloned()
    }
}

#[derive(Default)]
struct Rejections(Mutex<BTreeMap<(String, String), RejectionEntry>>);

#[async_trait]
impl EffortRejections for Rejections {
    async fn entry(&self, provider: &str, model: &str) -> Option<RejectionEntry> {
        self.0.lock().unwrap().get(&(provider.to_owned(), model.to_owned())).cloned()
    }
}

struct NoMedia;

#[async_trait]
impl MediaText for NoMedia {
    async fn prepare_pdf_text(
        &self,
        messages: Vec<mixdog_core_api::domain::provider::Message>,
    ) -> Result<Vec<mixdog_core_api::domain::provider::Message>, Box<ProviderError>> {
        Ok(messages)
    }
    async fn prepare_for_route(
        &self,
        messages: Vec<mixdog_core_api::domain::provider::Message>,
        _: mixdog_core_api::domain::provider::MediaSupport,
    ) -> Result<Vec<mixdog_core_api::domain::provider::Message>, Box<ProviderError>> {
        Ok(messages)
    }
    fn text_form(&self, _: &mixdog_core_api::domain::provider::ContentPart) -> Result<Option<String>, Box<ProviderError>> {
        Ok(None)
    }
}

struct Local;

impl LocalModels for Local {
    fn entry(&self, model: &str) -> Option<LocalEntry> {
        (model == "qwen").then(|| LocalEntry { name: "Qwen".into(), supports_function_calling: Some(true) })
    }
    fn runtime_tools(&self, _: &str) -> Option<bool> {
        Some(false)
    }
    fn media(&self, _: &Value) -> Arc<dyn MediaText> {
        Arc::new(NoMedia)
    }
    fn runtime(&self) -> Arc<dyn mixdog_ai::providers::local::LocalRuntime> {
        Arc::new(NoRuntime)
    }
}

/// A managed runtime with nothing installed that starts no server: these worlds only register `mixdog-local`.
struct NoRuntime;

#[async_trait::async_trait]
impl mixdog_ai::providers::local::listing::InstalledModels for NoRuntime {
    async fn installed(&self) -> Result<Vec<Value>, mixdog_core_api::domain::provider::ProviderError> {
        Ok(Vec::new())
    }
}

#[async_trait::async_trait]
impl mixdog_ai::providers::local::LocalRuntime for NoRuntime {
    fn supports_tools(&self, _: &str) -> Option<bool> {
        None
    }
    async fn ensure_server(
        &self,
        _: &str,
        _: Option<mixdog_rt::CancellationToken>,
    ) -> Result<mixdog_ai::providers::local::Endpoint, mixdog_core_api::domain::provider::ProviderError> {
        let mut error = mixdog_core_api::domain::provider::ProviderError::new(
            mixdog_core_api::domain::provider::ErrorKind::Unknown,
            mixdog_core_api::domain::provider::DeliveryState::NotSent,
        );
        error.message = "[local-provider] runtime is not installed".into();
        Err(error)
    }
    async fn begin(&self, _: &str) -> Result<Box<dyn mixdog_ai::providers::local::Inference>, mixdog_core_api::domain::provider::ProviderError> {
        unreachable!("these worlds never send to mixdog-local")
    }
    fn installed_now(&self) -> Option<Vec<Value>> {
        Some(Vec::new())
    }
}

pub(crate) struct World {
    pub(crate) services: ProcessServices,
    rejections: Arc<Rejections>,
    _dir: tempfile::TempDir,
}

/// What a provider's `getCachedModelInfo` answers in these worlds: the rows its adapter stored (the listing's records, as
/// Node's rows state their levels).
struct StoredRows(Vec<Arc<Value>>);

async fn catalog_with(dir: &std::path::Path, records: Vec<ModelRecord>) -> Arc<CatalogService> {
    let tokens = mixdog_rt::testing::tokens();
    let mut snapshot = CatalogSnapshot::default();
    for record in records {
        snapshot.models.entry(record.provider.clone()).or_default().push(record);
    }
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), io);
    Arc::new(CatalogService::cold_start(snapshot, Vec::new(), metadata).await)
}

/// A subscription-route row in Node's shape: `reasoningOptions` (a stated ladder, possibly empty)
/// and `thinkingTypes`, each only where the row has them.
fn anthropic_row(row: &Value) -> ModelRecord {
    let mut record = ModelRecord::new(ProviderId::from("anthropic-oauth"), row["id"].as_str().unwrap());
    if let Some(options) = row.get("reasoningOptions").and_then(Value::as_array) {
        record.efforts_stated = true;
        record.picker.reasoning_options = serde_json::from_value(Value::Array(options.clone())).unwrap();
    }
    record.thinking_adaptive = row["thinkingTypes"]["adaptive"].as_bool();
    record.thinking_enabled = row["thinkingTypes"]["enabled"].as_bool();
    record
}

fn host() -> HostInfo {
    HostInfo { os_type: "Windows".into(), os_release: "10.0.26100".into(), arch: "x86_64".into() }
}

// ---- BuilderEnv --------------------------------------------------------------------------

/// Node's own functions on fixed inputs (`codex-client-meta.mjs`, `openai-ws-headers.mjs`,
/// `grok-client-version.mjs`, `cursor-client-version.mjs`, `antigravity-oauth-tokens.mjs`).
#[tokio::test]
async fn the_client_identity_follows_nodes_floors_and_overrides() {
    let dir = tempfile::tempdir().unwrap();
    let identity = |pairs: &[(&str, &str)]| {
        let env: Arc<dyn Environment> = Arc::new(TestEnv(pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()));
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let versions = ClientVersions::new(Arc::new(NoNetwork), dir.path().to_owned(), io, env.clone());
        client_identity(&env, &host(), "11111111-2222-4333-8444-555555555555", &versions)
    };
    let id = identity(&[]);
    assert_eq!(id.codex.user_agent.get(), "codex_cli_rs/0.166.0 (Windows 10.0.26100; x86_64) unknown");
    assert_eq!((id.codex.version.get().as_str(), id.codex.beta_features.as_str()), ("0.166.0", "remote_compaction_v2"));
    assert_eq!((id.grok.get().as_str(), id.cursor.get().as_str(), id.antigravity.get().as_str()), ("1.0.70", "cli-2026.10.22-27dcf5f", "2.32.1"));

    let id = identity(&[
        ("MIXDOG_CODEX_ORIGINATOR", " codex_exec "),
        ("TERM_PROGRAM", " vscode "),
        ("MIXDOG_CODEX_VERSION", "0.170.1"),
        ("MIXDOG_CODEX_BETA_FEATURES", "a,b"),
        ("MIXDOG_GROK_CLIENT_VERSION", "1.0.99"),
        ("MIXDOG_CURSOR_CLIENT_VERSION", "cli-2027.01.01-abc"),
        ("MIXDOG_ANTIGRAVITY_VERSION", "3.0.0"),
    ]);
    // The User-Agent carries the version the client reports live (the floor here), the `version`
    // header the pinned one.
    assert_eq!(id.codex.user_agent.get(), "codex_exec/0.166.0 (Windows 10.0.26100; x86_64) vscode");
    assert_eq!((id.codex.version.get().as_str(), id.codex.beta_features.as_str()), ("0.170.1", "a,b"));
    assert_eq!((id.grok.get().as_str(), id.cursor.get().as_str(), id.antigravity.get().as_str()), ("1.0.99", "cli-2027.01.01-abc", "3.0.0"));
    assert_eq!(identity(&[("MIXDOG_CODEX_USER_AGENT", "ua/1")]).codex.user_agent.get(), "ua/1");
}

/// A network that never answers: only the floors and the overrides are in play.
struct NoNetwork;

#[async_trait::async_trait]
impl mixdog_ai::transport::http::HttpSend for NoNetwork {
    async fn send(
        &self,
        _: mixdog_core_api::domain::provider::WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::http::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
        Err(mixdog_core_api::domain::provider::ProviderError::new(
            mixdog_core_api::domain::provider::ErrorKind::Transient,
            mixdog_core_api::domain::provider::DeliveryState::NotSent,
        ))
    }
}
#[tokio::test]
async fn the_installation_id_is_the_env_uuid_else_the_file_else_a_new_one_kept() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let set = |v: &str| TestEnv([("MIXDOG_CODEX_INSTALLATION_ID".to_owned(), v.to_owned())].into());
    let from_env = resolve_installation_id(&set(" 11111111-2222-4333-8444-555555555555 "), &tokens, dir.path()).await;
    assert_eq!(from_env, "11111111-2222-4333-8444-555555555555");
    // Not a uuid: ignored; a new id is created once and read back by the next process.
    let first = resolve_installation_id(&set("nope"), &tokens, dir.path()).await;
    assert_eq!(first.len(), 36);
    assert_eq!(resolve_installation_id(&TestEnv(HashMap::new()), &tokens, dir.path()).await, first);
}

/// `openai-codex-metadata.mjs` `UUID_RE` takes versions 1-8 and variants 8, 9, a, b only, and
/// `_codexInstallationId` replaces a file that holds no such uuid whole.
#[tokio::test]
async fn an_installation_id_needs_a_valid_version_and_variant_and_a_damaged_file_is_replaced() {
    let tokens = mixdog_rt::testing::tokens();
    let set = |v: &str| TestEnv([("MIXDOG_CODEX_INSTALLATION_ID".to_owned(), v.to_owned())].into());
    let valid = "11111111-2222-8333-b444-555555555555";
    assert_eq!(resolve_installation_id(&set(&valid.to_uppercase()), &tokens, tempfile::tempdir().unwrap().path()).await, valid);
    for bad in [
        "11111111-2222-0333-8444-555555555555",
        "11111111-2222-9333-8444-555555555555",
        "11111111-2222-4333-c444-555555555555",
        "11111111-2222-4333-0444-555555555555",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let id = resolve_installation_id(&set(bad), &tokens, dir.path()).await;
        assert_ne!(id, bad, "{bad} is not a uuid");
        assert_eq!(fixture_fs::read_to_string(dir.path().join("installation_id")).unwrap(), id);
    }
    // A file that holds a bad variant, nothing, or NULs is replaced by the generated id.
    for damaged in ["11111111-2222-4333-c444-555555555555", "", "\0\0\0\0"] {
        let dir = tempfile::tempdir().unwrap();
        fixture_fs::write(dir.path().join("installation_id"), damaged);
        let id = resolve_installation_id(&TestEnv(HashMap::new()), &tokens, dir.path()).await;
        assert_ne!(id, damaged);
        assert_eq!(fixture_fs::read_to_string(dir.path().join("installation_id")).unwrap(), id, "{damaged:?}");
        assert_eq!(resolve_installation_id(&TestEnv(HashMap::new()), &tokens, dir.path()).await, id, "the repaired file is read back");
    }
}
/// `m?.supports_reasoning_summaries === true` on the cached Codex roster, read for the exact id;
/// an id the roster does not hold takes summaries (`_codexModelSupportsReasoningSummaries`).
#[tokio::test]
async fn reasoning_summaries_follow_the_cached_codex_row() {
    let dir = tempfile::tempdir().unwrap();
    let mut off = ModelRecord::new(ProviderId::from("openai-oauth"), "gpt-6-sol");
    off.supports_reasoning_summaries = Some(false);
    let mut on = ModelRecord::new(ProviderId::from("openai-oauth"), "gpt-6-astra");
    on.supports_reasoning_summaries = Some(true);
    let silent = ModelRecord::new(ProviderId::from("openai-oauth"), "gpt-6-luna");
    let facts = CatalogOpenAiFacts::new(catalog_with(dir.path(), vec![off, on, silent]).await);
    assert_eq!(facts.facts("gpt-6-sol").reasoning_summaries, Some(false));
    assert_eq!(facts.facts("gpt-6-astra").reasoning_summaries, Some(true));
    assert_eq!(facts.facts("gpt-6-luna").reasoning_summaries, None);
    assert_eq!(facts.facts("gpt-6-terra").reasoning_summaries, None);
}
/// GPT 6.2 and later take top-level instructions after the input; a dated snapshot and a fine-tune read as their model.
#[tokio::test]
async fn instructions_go_after_the_input_from_gpt_6_2_on() {
    let dir = tempfile::tempdir().unwrap();
    let facts = CatalogOpenAiFacts::new(catalog_with(dir.path(), Vec::new()).await);
    for model in ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.2-sol-2026-11-18", "gpt-6.3", "gpt-7", "ft:gpt-6.2-sol:acme::a1b2"] {
        assert!(facts.facts(model).instructions_after_input, "{model}");
    }
    for model in ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.5", "gpt-reserve", "ft:gpt-6.1-sol:acme::a1b2"] {
        assert!(!facts.facts(model).instructions_after_input, "{model}");
    }
}
#[tokio::test]
async fn the_always_enable_switch_gives_every_model_adaptive_effort() {
    let dir = tempfile::tempdir().unwrap();
    let env = TestEnv([("MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT".to_owned(), " Yes ".to_owned())].into());
    let caps = CatalogCaps::new(catalog_with(dir.path(), Vec::new()).await, &env);
    assert_eq!(caps.effort_levels_for("claude-haiku-4-5"), ["low", "medium", "high"]);
    assert_eq!(caps.effort_levels_for("some-gateway-model"), ["low", "medium", "high"]);
}

// ---- AccountingDeps ----------------------------------------------------------------------

fn header_of(session: &Value) -> Arc<Header> {
    Arc::new(session.as_object().unwrap().clone())
}

#[tokio::test]
async fn a_send_with_no_session_header_is_scoped_by_its_options_alone() {
    let scope = HeaderScope::new(Arc::new(Headers::default()));
    let request = ModelRequest {
        model: "m".into(),
        messages: Vec::new(),
        tools: Vec::new(),
        options: RequestOptions { session_id: Some("s".into()), request_kind: Some("lead".into()), ..RequestOptions::default() },
    };
    let got = mixdog_ai::registry::accounted::SendScope::of(&scope, "openai", &request);
    assert_eq!((got.session_id.as_deref(), got.source_type.as_str(), got.owner_session_id, got.primary), (Some("s"), "lead", None, None));
}

/// The ledger scope of a request assembled through the session-aware identity (the turn's, a delegated agent's, and a
/// side question's rebuilt request all share it): a Codex route sends its wire id as the provider session, and the spend still
/// belongs to the visible thread with its source type and owner. A request that names no session stays sessionless.
#[tokio::test]
async fn a_codex_requests_spend_is_scoped_to_its_thread_and_a_sessionless_one_stays_sessionless() {
    let wire = "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d";
    let header = header_of(&json!({
        "provider": "openai-oauth", "codexWireSessionId": wire, "sourceType": "cli", "ownerSessionId": "lead-1"
    }));
    let headers = Arc::new(Headers::default());
    headers.0.lock().unwrap().insert("agent-1".into(), header.clone());
    let scope = HeaderScope::new(headers);
    let of = |options: RequestOptions| {
        let request = ModelRequest { model: "gpt-6-astra".into(), messages: Vec::new(), tools: Vec::new(), options };
        mixdog_ai::registry::accounted::SendScope::of(&scope, "openai-oauth", &request)
    };

    let mut options = RequestOptions::default();
    super::assemble::apply_identity(&mut options, &"agent-1".into(), &header, None);
    assert_eq!(options.session_id.as_deref(), Some(wire), "the provider still sees the wire id");
    let got = of(options);
    assert_eq!((got.session_id.as_deref(), got.source_type.as_str(), got.owner_session_id.as_deref()), (Some("agent-1"), "cli", Some("lead-1")));

    // An attribution set upstream is kept.
    let mut options = RequestOptions { usage_session_id: Some("other".into()), ..RequestOptions::default() };
    super::assemble::apply_identity(&mut options, &"agent-1".into(), &header, None);
    assert_eq!(options.usage_session_id.as_deref(), Some("other"));

    // A one-shot (the heartbeat) builds no identity: no session, so none is recorded.
    let got = of(RequestOptions { request_kind: Some("heartbeat".into()), ..RequestOptions::default() });
    assert_eq!((got.session_id, got.source_type.as_str(), got.owner_session_id), (None, "heartbeat", None));
}
async fn adapter_of(w: &World, name: &str) -> Arc<dyn ProviderAdapter> {
    DefaultProviderBuilder::new(builder_env(&w.services)).build(name, &json!({"enabled": true, "apiKey": "k"})).await.unwrap()
}

impl mixdog_ai::catalog::CachedModelInfo for StoredRows {
    fn cached_row(&self, model: &str) -> Option<Arc<Value>> {
        self.0.iter().find(|row| row["id"] == model).cloned()
    }
}
/// The registry's providers as production binds them (`ProviderReadiness::new` binds `route_provider`), here without
/// a registry: a provider with listed `records` answers their rows; a custom provider of the config with none holds the
/// rows its config states, through its real listing (`CustomListing`, which the custom builder hands the registry).
fn bind_providers(catalog: &CatalogService, providers: &Value, records: &[ModelRecord]) {
    let mut stored: HashMap<String, Vec<Arc<Value>>> = HashMap::new();
    for record in records {
        let mut row = json!({ "id": record.id, "provider": record.provider.as_str(), "reasoningLevels": record.reasoning_efforts, "reasoningOptions": record.picker.reasoning_options });
        if let Some(custom) = &record.picker.custom_reasoning {
            row["customReasoning"] = json!(custom);
        }
        stored.entry(record.provider.as_str().to_owned()).or_default().push(Arc::new(row));
    }
    let mut custom: HashMap<String, Arc<mixdog_ai::providers::custom::listing::CustomListing>> = HashMap::new();
    for (name, cfg) in providers.as_object().into_iter().flatten().filter(|(name, _)| name.starts_with("custom-")) {
        let Ok(protocol) = serde_json::from_value(cfg["protocol"].clone()) else { continue };
        let listing = mixdog_ai::providers::custom::listing::CustomListing::new(
            name,
            protocol,
            cfg["baseURL"].as_str().unwrap_or_default(),
            Vec::new(),
            Arc::new(Offline),
            Arc::new(mixdog_ai::providers::connect::rewrite::StaticCredential(None)),
            true,
            cfg,
            ListingLookup::new(),
        );
        custom.insert(name.clone(), Arc::new(listing));
    }
    catalog.bind_providers(Arc::new(move |name| {
        let cached: Option<Arc<dyn mixdog_ai::catalog::CachedModelInfo>> = match (stored.get(name), custom.get(name)) {
            (Some(rows), _) => Some(Arc::new(StoredRows(rows.clone()))),
            (None, Some(listing)) => Some(listing.clone()),
            (None, None) => return None,
        };
        Some(mixdog_ai::catalog::RouteProvider { cached, listing: None })
    }));
}
pub(crate) async fn world(env: &[(&str, &str)], providers: Value, records: Vec<ModelRecord>) -> World {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let providers_config = providers.clone();
    config
        .update_agent(move |doc| {
            doc.insert("providers".into(), providers);
            Ok(())
        })
        .await
        .unwrap();
    let catalog = catalog_with(dir.path(), records.clone()).await;
    bind_providers(&catalog, &providers_config, &records);
    let env: Arc<dyn Environment> = Arc::new(TestEnv(env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()));
    let headers = Arc::new(Headers::default());
    let rejections = Arc::new(Rejections::default());
    let services = ProcessServices {
        config,
        catalog,
        listing: ListingLookup::new(),
        network: NetworkProxy::new(Arc::new(mixdog_ai::netproxy::route::ProcessEnv), SystemProxy::default()),
        vault: Arc::new(MemoryVault::default()),
        env,
        lanes: tokens,
        plugin_data: dir.path().join("plugin-data"),
        home_dir: dir.path().to_path_buf(),
        host: HostInfo { os_type: "Windows".into(), os_release: "10.0.26100".into(), arch: "x86_64".into() },
        build_version: "9.8.7".into(),
        installation_id: "11111111-2222-4333-8444-555555555555".into(),
        ledger: Arc::new(|| None),
        sessions: headers.clone(),
        rejections: rejections.clone(),
        unsupported: Arc::new(UnsupportedEfforts::default()),
        local: Arc::new(Local),
    };
    World { services, rejections, _dir: dir }
}
#[tokio::test]
async fn every_builder_input_comes_from_the_process_services() {
    let w = world(&[], json!({}), Vec::new()).await;
    let env = builder_env(&w.services);
    assert_eq!(env.client_version, "9.8.7");
    assert_eq!(env.codex_identity.installation_id, "11111111-2222-4333-8444-555555555555");
    assert_eq!(env.home_dir, w.services.home_dir);

    // `providerAvailable`: a gated provider follows its stored Developer option, live.
    assert!((env.gated_off)("cursor-oauth"));
    assert!(!(env.gated_off)("anthropic"));
    w.services
        .config
        .update_agent(|doc| {
            doc.insert("developer".into(), json!({"cursorOAuth": true}));
            Ok(())
        })
        .await
        .unwrap();
    assert!(!(env.gated_off)("cursor-oauth"));

    // The builder builds adapters from it.
    let builder = DefaultProviderBuilder::new(env);
    for name in ["anthropic", "openai", "gemini", "xai"] {
        let adapter = builder.build(name, &json!({"enabled": true, "apiKey": "k"})).await.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(adapter.id().to_string(), name);
    }
}
/// A thread opened after a restart finds the process registry empty; its first request readies the header's provider as
/// the route hop does (`RegistryHopHost::runner`: `initProviders(ensureProviderEnabled(agentConfig, id))`, then the
/// registry) — for every kind of provider the agent config can name, not only a custom one.
#[tokio::test]
async fn after_a_reload_each_provider_kind_is_readied_from_the_agent_config() {
    let key = json!({"enabled": true, "apiKey": "k"});
    let mut providers = Map::new();
    for name in ["anthropic", "openai", "gemini", "xai", "deepseek", "openrouter"] {
        providers.insert(name.into(), key.clone());
    }
    providers.insert(
        "custom-abc".into(),
        json!({"enabled": true, "type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1/", "apiKey": "k"}),
    );
    let names: Vec<String> = providers.keys().cloned().collect();
    let w = world(&[], Value::Object(providers), Vec::new()).await;
    let (registry, _) = super::compose_parts::provider_registry(
        &w.services,
        builder_env(&w.services),
        Arc::new(mixdog_exthost::ExtImageCodec::new(Arc::new(mixdog_core_api::domain::mock::MockExtPool::new(1)))),
        None,
    );
    for name in names {
        let enabled = mixdog_ai::service::admin_route::ensure_provider_enabled(&w.services.config.agent(), &name);
        registry.init_providers(&enabled).await.unwrap_or_else(|e| panic!("{name}: {e}"));
        let adapter = registry.try_get(&name).await.unwrap().unwrap_or_else(|| panic!("{name}: not readied"));
        assert_eq!(adapter.id().to_string(), name);
    }
}
#[tokio::test]
async fn a_remote_client_holds_no_model_credentials() {
    let w = world(&[("MIXDOG_MODEL_PROXY", "client"), ("OPENAI_API_KEY", "sk-live")], json!({}), Vec::new()).await;
    let env = builder_env(&w.services);
    assert!(env.keys.get("openai").await.unwrap().is_none());
    // The PC's providers are available whatever the local Developer option says.
    assert!(!(env.gated_off)("cursor-oauth"));
    let local = world(&[("OPENAI_API_KEY", "sk-live")], json!({}), Vec::new()).await;
    assert_eq!(builder_env(&local.services).keys.get("openai").await.unwrap().as_deref(), Some("sk-live"));
}
// ---- LadderSources -----------------------------------------------------------------------

#[tokio::test]
async fn the_ladder_reads_the_process_stores() {
    let providers = json!({
        "custom-acme": {"type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-chat", "baseURL": "https://example.test/v1",
            "modelOverrides": {"m1": {"manual": true, "reasoning": {"levels": ["low", "high"]}}}},
    });
    let w = world(
        &[],
        providers,
        vec![anthropic_row(&json!({"id": "claude-sonnet-4-6", "reasoningOptions": [{"type": "effort", "values": ["low", "medium", "high", "max"]}]}))],
    )
    .await;
    w.rejections.0.lock().unwrap().insert(("openai".into(), "gpt-5.5".into()), RejectionEntry { rejected: vec!["xhigh".into()], allowed: Vec::new() });
    let ladder = ProcessLadder::new(&w.services);

    // The custom provider's config, and the row it states for a model.
    assert_eq!(ladder.custom_config("custom-acme").map(|(_, url)| url).as_deref(), Some("https://example.test/v1"));
    assert!(ladder.custom_config("openai").is_none());
    assert!(ladder.custom_config("custom-missing").is_none());
    let row = ladder.cached_row("custom-acme", "m1").unwrap();
    assert_eq!(row["reasoningLevels"], json!(["low", "high"]));
    assert_eq!(row["reasoningOptions"], json!([{"type": "effort", "values": ["low", "high"]}]));
    // First-party adapters without a listing of their own have no cached row.
    assert!(ladder.cached_row("openai", "gpt-5.5").is_none());

    // What an endpoint refused.
    assert_eq!(ladder.rejected("openai", "gpt-5.5").await.map(|e| e.rejected), Some(vec!["xhigh".to_owned()]));
    assert!(ladder.rejected("openai", "gpt-5.4").await.is_none());

    // The Anthropic efforts of the catalog's caps.
    assert_eq!(ladder.anthropic_levels("claude-sonnet-4-6"), ["low", "medium", "high"]);
    assert_eq!(ladder.anthropic_levels("claude-opus-5"), ["low", "medium", "high", "xhigh"]);
    assert!(ladder.anthropic_levels("claude-haiku-4-5").is_empty());
}
#[tokio::test]
async fn the_ladder_facts_of_a_custom_and_an_anthropic_route() {
    let providers = json!({
        "custom-acme": {"type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-chat", "baseURL": "https://example.test/v1",
            "modelOverrides": {"m1": {"manual": true, "reasoning": {"levels": ["low", "high"]}}}},
    });
    let w = world(&[], providers, Vec::new()).await;
    let ladder = ProcessLadder::new(&w.services);
    let custom = ladder_facts(&ladder, "custom-acme", "m1").await;
    let route = custom.custom.expect("a custom route carries its row and config");
    assert_eq!(route.base_url, "https://example.test/v1");
    let anthropic = ladder_facts(&ladder, "anthropic", "claude-opus-5").await;
    assert_eq!(anthropic.options, ["low", "medium", "high", "xhigh"]);
    assert!(anthropic.custom.is_none());
}
#[tokio::test]
async fn a_rejection_the_file_holds_reaches_the_ladder() {
    let w = world(&[], json!({}), Vec::new()).await;
    fixture_fs::create_dir_all(&w.services.plugin_data);
    fixture_fs::write(
        w.services.plugin_data.join("effort-rejections.json"),
        r#"{"version":1,"models":{"openai:gpt-5.5":{"rejected":["xhigh"],"allowed":["low","high"]},"x:y":{"rejected":[]}}}"#,
    );
    let store = FileRejections::new(&w.services.lanes, &w.services.plugin_data);
    let entry = store.entry("openai", "GPT-5.5 ").await.unwrap();
    assert_eq!((entry.rejected, entry.allowed), (vec!["xhigh".to_owned()], vec!["low".to_owned(), "high".to_owned()]));
    assert!(store.entry("openai", "gpt-5.4").await.is_none());
}
/// `effort-rejection.mjs` `load`: the cached copy is trusted only while the file's mtime and size
/// are unchanged, so a rejection another process persists (or a file it removes) shows on the
/// next read.
#[tokio::test]
async fn a_file_another_process_changed_is_reloaded_on_the_next_read() {
    let w = world(&[], json!({}), Vec::new()).await;
    let file = w.services.plugin_data.join("effort-rejections.json");
    fixture_fs::create_dir_all(&w.services.plugin_data);
    let store = FileRejections::new(&w.services.lanes, &w.services.plugin_data);
    assert!(store.entry("openai", "gpt-5.5").await.is_none(), "no file holds nothing");
    fixture_fs::write(&file, r#"{"version":1,"models":{"openai:gpt-5.5":{"rejected":["xhigh"]}}}"#);
    assert_eq!(store.entry("openai", "gpt-5.5").await.map(|e| e.rejected), Some(vec!["xhigh".to_owned()]));
    fixture_fs::write(&file, r#"{"version":1,"models":{"openai:gpt-5.5":{"rejected":["xhigh","high"]},"x:y":{"rejected":["low"]}}}"#);
    assert_eq!(store.entry("openai", "gpt-5.5").await.map(|e| e.rejected), Some(vec!["xhigh".to_owned(), "high".to_owned()]));
    assert_eq!(store.entry("x", "y").await.map(|e| e.rejected), Some(vec!["low".to_owned()]));
    fixture_fs::remove_file(&file);
    assert!(store.entry("openai", "gpt-5.5").await.is_none(), "a removed file holds nothing");
}
// ---- HopWiring and ErrorText --------------------------------------------------------------

#[tokio::test]
async fn the_hop_phrases_errors_with_present_error_text() {
    let w = world(&[], json!({}), Vec::new()).await;
    let bindings = HopBindings::new(&w.services);
    let error = ProviderError::new(ErrorKind::RateLimited, DeliveryState::NotSent);
    let want = mixdog_ai::service::error_text::present_error_text(&(&error).into(), &Default::default());
    assert_eq!((bindings.errors)(&error), want);
    assert!(!want.is_empty());
}
#[tokio::test]
async fn the_hop_wires_a_route_as_the_turn_start_does() {
    let providers = json!({
        "custom-acme": {"type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-chat", "baseURL": "https://example.test/v1",
            "modelOverrides": {"m1": {"manual": true, "reasoning": {"levels": ["low", "high"]}}}},
    });
    let w = world(&[], providers, Vec::new()).await;
    let bindings = HopBindings::new(&w.services);
    let openai = adapter_of(&w, "openai").await;

    // A first-party Responses route projects its efforts; it is not text-only.
    let (effort, text_only) = bindings.wiring.wiring(&json!({"provider": "openai", "model": "gpt-6-astra", "effort": "high", "messages": []}), &openai);
    let effort = effort.expect("the Responses route projects efforts");
    assert_eq!((effort.route.provider.as_str(), effort.route.model.as_str()), ("openai", "gpt-6-astra"));
    assert!(text_only.is_none());

    // A custom route's effort rides each request: nothing is projected.
    let (effort, _) = bindings.wiring.wiring(&json!({"provider": "custom-acme", "model": "m1", "effort": "high", "messages": []}), &openai);
    assert!(effort.is_none());

    // The managed local runtime is text-only, named by its entry, with the runtime's tool support.
    let (_, text_only) = bindings.wiring.wiring(&json!({"provider": "mixdog-local", "model": "qwen", "messages": []}), &openai);
    let model = text_only.expect("the local runtime is text-only").model;
    assert_eq!((model.name.as_str(), model.supports_tools), ("Qwen", Some(false)));
}
