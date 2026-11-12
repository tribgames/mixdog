//! The turn-assembly seams built from one [`ProcessServices`]: the provider builder's inputs, the
//! accounting identity of a send, the step judge's ladder and the hop's wiring and error text.
//! Node goldens: `anthropic-caps`, `openai-facts`, `accounting-scope` (recorders in
//! `benchmarks/rust-core/recorders`).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::text_only::MediaText;
use mixdog_ai::client_versions::ClientVersions;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ListingLookup, ModelRecord, ModelsDevSource};
use mixdog_ai::effort::{reasoning_row, RejectionEntry};
use mixdog_ai::netproxy::NetworkProxy;
use mixdog_ai::netproxy::system::SystemProxy;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::providers::openai::config::{ModelFactsSource, PromptCacheLifetime};
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::{Environment, MemoryVault};
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::provider::{
    DeliveryState, ErrorKind, ModelRequest, ProviderAdapter, ProviderError, RequestOptions, WireRequest,
};
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_protocol::ProviderId;
use mixdog_store::schema::record::Header;
use serde_json::{json, Map, Value};

use super::accounting_scope::{accounting_deps, HeaderScope};
use super::fixture_fs;
use super::builder_env::{builder_env, client_identity, CatalogCaps, CatalogOpenAiFacts};
use super::hop_bindings::HopBindings;
use super::ladder_sources::ProcessLadder;
use super::process::{
    resolve_installation_id, EffortRejections, FileRejections, HostInfo, LocalModels, ProcessServices, SessionHeaders,
};
use mixdog_core_run::run_host::route_wiring::AnthropicEffortGates;
use mixdog_core_run::run_host::route_wiring::LocalEntry;
use super::step_judge::{ladder_facts, LadderSources};
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;

const CAPS: &str = include_str!("../../../../fixtures/anthropic-caps/golden.json");
const WIRE_ANTHROPIC: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/wire-anthropic-gemini/anthropic.json");
const OPENAI: &str = include_str!("../../../../fixtures/openai-facts/golden.json");
const SCOPE: &str = include_str!("../../../../fixtures/accounting-scope/golden.json");

struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(
        &self,
        _: WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(
            ErrorKind::Transient,
            DeliveryState::NotSent,
        ))
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
    async fn ensure_server(&self, _: &str) -> Result<mixdog_ai::providers::local::Endpoint, mixdog_core_api::domain::provider::ProviderError> {
        let mut error = mixdog_core_api::domain::provider::ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Unknown, mixdog_core_api::domain::provider::DeliveryState::NotSent);
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
    headers: Arc<Headers>,
    rejections: Arc<Rejections>,
    _dir: tempfile::TempDir,
}

/// What a provider's `getCachedModelInfo` answers in these worlds: the rows its adapter stored (the listing's records, as
/// Node's rows state their levels).
struct StoredRows(Vec<Arc<Value>>);

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
    World { services, headers, rejections, _dir: dir }
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
fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
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
    assert_eq!((id.grok.get().as_str(), id.cursor.get().as_str(), id.antigravity.get().as_str()), ("1.0.70", "cli-2026.10.22-27dcf5f", "2.19.1"));

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
    ) -> Result<
        mixdog_ai::transport::http::HttpResponse,
        mixdog_core_api::domain::provider::ProviderError,
    > {
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
    for bad in ["11111111-2222-0333-8444-555555555555", "11111111-2222-9333-8444-555555555555", "11111111-2222-4333-c444-555555555555", "11111111-2222-4333-0444-555555555555"] {
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
    w.services.config.update_agent(|doc| { doc.insert("developer".into(), json!({"cursorOAuth": true})); Ok(()) }).await.unwrap();
    assert!(!(env.gated_off)("cursor-oauth"));

    // The builder builds adapters from it.
    let builder = DefaultProviderBuilder::new(env);
    for name in ["anthropic", "openai", "gemini", "xai"] {
        let adapter = builder.build(name, &json!({"enabled": true, "apiKey": "k"})).await.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(adapter.id().to_string(), name);
    }
}

/// A thread opened after a restart finds the process registry empty; its first request readies the header's provider as
/// the route hop does (`RegistryHopHost::provider`: `initProviders(ensureProviderEnabled(agentConfig, id))`, then the
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
        json!({"enabled": true, "type": "custom", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1/", "apiKey": "k"}),
    );
    let names: Vec<String> = providers.keys().cloned().collect();
    let w = world(&[], Value::Object(providers), Vec::new()).await;
    let (registry, _) = super::compose_parts::provider_registry(&w.services, builder_env(&w.services));
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

/// The listed rows the recorder fed Node's `setModelEffortCapabilities`, as the subscription
/// route lists them: a row that states no `reasoningOptions` states no ladder at all.
fn listed_rows(rows: &Value) -> Vec<ModelRecord> {
    rows.as_array().unwrap().iter().map(anthropic_row).collect()
}

#[tokio::test]
async fn the_anthropic_caps_are_nodes_floor_live_and_declared_catalog_answers() {
    let golden: Value = serde_json::from_str(CAPS).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let none = TestEnv(HashMap::new());
    let sets = [
        ("floor", Vec::new()),
        ("withLive", listed_rows(&golden["live"])),
        ("declared", listed_rows(&golden["declaredRows"])),
    ];
    for (set, rows) in sets {
        let caps = CatalogCaps::new(catalog_with(dir.path(), rows).await, &none);
        for row in golden[set].as_array().unwrap() {
            let model = row["model"].as_str().unwrap();
            let got = caps.caps(model);
            let gates = AnthropicEffortGates::for_model(model, got.as_ref());
            let supports = got.as_ref().is_some_and(|c| c.supports_effort());
            let adaptive = got.as_ref().is_some_and(|c| c.adaptive_thinking);
            let want = |key: &str| row[key].as_bool().unwrap();
            let ctx = format!("{set} {model}");
            assert_eq!(supports, want("supportsEffort"), "{ctx} supports effort");
            assert_eq!((gates.xhigh, gates.max), (want("xhigh"), want("max")), "{ctx} gates");
            assert_eq!(got.as_ref().is_some_and(|c| !c.manual_thinking), want("adaptiveOnly"), "{ctx} adaptive only");
            assert_eq!(supports && adaptive, want("betaHeader"), "{ctx} beta header");
            assert_eq!(caps.effort_levels_for(model), strings(&row["levels"]), "{ctx} levels");
            assert_eq!(caps.effort_levels_empty(model), row["levels"].as_array().unwrap().is_empty(), "{ctx} no levels");
        }
    }
}

/// The capabilities `mixdog-ai`'s Anthropic wire test feeds the adapter are what Node's functions answered for the
/// models of `anthropic.json`, with a catalog that lists them by id only (`_setInMemoryCatalog`). The product's
/// `CatalogCaps` over such a catalog gives the same answers, so the adapter test's input is the product's.
#[tokio::test]
async fn the_anthropic_wire_models_get_nodes_catalog_answers() {
    let recorded: Value = serde_json::from_str(&WIRE_ANTHROPIC).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let caps = CatalogCaps::new(catalog_with(dir.path(), Vec::new()).await, &TestEnv(HashMap::new()));
    let models = recorded["capabilities"].as_object().unwrap();
    assert!(!models.is_empty(), "the recording holds no model capabilities");
    for (model, node) in models {
        let got = caps.caps(model);
        let gates = AnthropicEffortGates::for_model(model, got.as_ref());
        let supports = got.as_ref().is_some_and(|c| c.supports_effort());
        let adaptive = got.as_ref().is_some_and(|c| c.adaptive_thinking);
        let flag = |key: &str| node[key].as_bool().unwrap();
        assert_eq!(supports, flag("supportsEffort"), "{model} supports effort");
        assert_eq!((gates.xhigh, gates.max), (flag("supportsXhighEffort"), flag("supportsMaxEffort")), "{model} gates");
        assert_eq!(got.as_ref().is_some_and(|c| !c.manual_thinking), flag("adaptiveOnly"), "{model} adaptive only");
        assert_eq!(supports && adaptive, flag("effortBeta"), "{model} effort beta");
        assert_eq!(caps.effort_levels_for(model), strings(&node["effortLevels"]), "{model} effort levels");
        assert_eq!(got.as_ref().is_some_and(|c| c.thinking_display_updates), flag("progressUpdates"), "{model} progress updates");
        assert_eq!(got.as_ref().and_then(|c| c.max_output_tokens).map(u64::from), node["declaredOutputTokens"].as_u64(), "{model} declared output tokens");
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
#[tokio::test]
async fn the_always_enable_switch_gives_every_model_adaptive_effort() {
    let dir = tempfile::tempdir().unwrap();
    let env = TestEnv([("MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT".to_owned(), " Yes ".to_owned())].into());
    let caps = CatalogCaps::new(catalog_with(dir.path(), Vec::new()).await, &env);
    assert_eq!(caps.effort_levels_for("claude-haiku-4-5"), ["low", "medium", "high"]);
    assert_eq!(caps.effort_levels_for("some-gateway-model"), ["low", "medium", "high"]);
}

#[tokio::test]
async fn the_openai_facts_are_nodes_catalog_and_documented_id_rules() {
    let dir = tempfile::tempdir().unwrap();
    let facts = CatalogOpenAiFacts::new(catalog_with(dir.path(), Vec::new()).await);
    let golden: Value = serde_json::from_str(OPENAI).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let model = case["model"].as_str().unwrap();
        let got = facts.facts(model);
        let flag = |key: &str| case[key].as_bool().unwrap();
        assert_eq!(got.reasoning, Some(flag("reasoning")), "{model} reasoning");
        assert_eq!(got.verbosity, Some(flag("verbosity")), "{model} verbosity");
        assert_eq!(got.native_tool_search, Some(flag("toolSearch")), "{model} tool search");
        assert_eq!((got.fast_tier, got.ultrafast_tier), (flag("fast"), flag("ultrafast")), "{model} tiers");
        let cache = match (case["cacheOptions"].is_null(), case["cacheRetention"].is_null()) {
            (false, true) => PromptCacheLifetime::Options30m,
            (true, false) => PromptCacheLifetime::Retention24h,
            (true, true) => PromptCacheLifetime::None,
            (false, false) => unreachable!(),
        };
        assert_eq!(got.prompt_cache, cache, "{model} prompt cache");
    }
}

// ---- AccountingDeps ----------------------------------------------------------------------

fn header_of(session: &Value) -> Arc<Header> {
    Arc::new(session.as_object().unwrap().clone())
}

#[tokio::test]
async fn a_sends_identity_is_filled_from_its_session_as_node_does() {
    let golden: Value = serde_json::from_str(SCOPE).unwrap();
    let w = world(&[], json!({}), Vec::new()).await;
    let deps = accounting_deps(&w.services);
    for case in golden["cases"].as_array().unwrap() {
        let (provider, model) = (case["provider"].as_str().unwrap(), case["model"].as_str().unwrap());
        let opts = &case["opts"];
        let text = |key: &str| opts.get(key).and_then(Value::as_str).map(str::to_owned);
        if let Some(session) = case.get("session") {
            w.headers.0.lock().unwrap().insert(text("sessionId").unwrap(), header_of(session));
        }
        let request = ModelRequest {
            model: model.into(),
            messages: Vec::new(),
            tools: Vec::new(),
            options: RequestOptions { session_id: text("sessionId"), usage_session_id: text("usageSessionId"), request_kind: text("requestKind"), ..RequestOptions::default() },
        };
        let scope = deps.scope.of(provider, &request);
        let (requested_provider, requested_model, _) = mixdog_ai::registry::accounted::requested_route(scope.primary.clone(), provider, model);
        let want = &case["identity"];
        let name = &case["name"];
        assert_eq!(json!(scope.session_id), want["sessionId"], "{name}");
        assert_eq!(scope.source_type, want["sourceType"].as_str().unwrap(), "{name}");
        assert_eq!(json!(scope.owner_session_id), want["ownerSessionId"], "{name}");
        // The row blanks a requested route equal to the sent one.
        let blank = |requested: String, sent: &str| if requested == sent { String::new() } else { requested };
        assert_eq!(blank(requested_provider, provider), want["requestedProvider"].as_str().unwrap(), "{name}");
        assert_eq!(blank(requested_model, model), want["requestedModel"].as_str().unwrap(), "{name}");
    }
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

// ---- LadderSources -----------------------------------------------------------------------

#[tokio::test]
async fn the_ladder_reads_the_process_stores() {
    let providers = json!({
        "custom-acme": {"type": "custom", "protocol": "openai-chat", "baseURL": "https://example.test/v1",
            "modelOverrides": {"m1": {"manual": true, "reasoning": {"levels": ["low", "high"]}}}},
    });
    let w = world(&[], providers, vec![anthropic_row(&json!({"id": "claude-sonnet-4-6", "reasoningOptions": [{"type": "effort", "values": ["low", "medium", "high", "max"]}]}))]).await;
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
        "custom-acme": {"type": "custom", "protocol": "openai-chat", "baseURL": "https://example.test/v1",
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

const LADDER_ROWS: &str = include_str!("../../../../fixtures/ladder-rows/golden.json");

fn listed_row(provider: &str, id: &str, levels: &Value, options: &Value) -> ModelRecord {
    let mut record = ModelRecord::new(ProviderId::from(provider), id);
    record.reasoning_efforts = strings(levels);
    record.picker.reasoning_options = serde_json::from_value(options.clone()).unwrap();
    record
}

/// `autoEffortModel` asks every provider's `getCachedModelInfo`, not a fixed few: the OpenAI OAuth
/// catalog's row and a compat provider's give the ladder Node's `effortOptionsFor` gives.
#[tokio::test]
async fn the_ladder_asks_every_provider_for_its_cached_row() {
    let golden: Value = serde_json::from_str(LADDER_ROWS).unwrap();
    for route in golden["routes"].as_array().unwrap() {
        let (provider, model) = (route["provider"].as_str().unwrap(), route["model"].as_str().unwrap());
        let records = match route["levels"].is_null() {
            true => Vec::new(),
            false => vec![listed_row(provider, model, &route["levels"], &json!([{"type": "effort", "values": route["levels"]}]))],
        };
        let w = world(&[], json!({}), records).await;
        let ladder = ProcessLadder::new(&w.services);
        assert_eq!(json!(ladder_facts(&ladder, provider, model).await.options), route["options"], "{provider} {}", route["levels"]);
    }
}

/// `effectiveCustomModelRows` layers an override onto the discovered row, and the row keeps the
/// discovered levels when the override states none (`{manual: true}`): the ladder reads the row
/// the listing holds, not one rebuilt from the config. Before any listing the config's own manual
/// row stands.
#[tokio::test]
async fn a_manual_override_keeps_the_levels_discovery_found() {
    let golden: Value = serde_json::from_str(LADDER_ROWS).unwrap();
    let levels_of = |row: &Map<String, Value>| reasoning_row(&Value::Object(row.clone())).effort_levels();
    for (case, override_, want) in [
        ("manualOnly", json!({"manual": true}), Some(vec!["low", "high"])),
        ("manualWithLevels", json!({"manual": true, "reasoning": {"levels": ["medium"]}}), Some(vec!["medium"])),
    ] {
        let node = &golden["rows"][case];
        assert_eq!(node["reasoningLevels"], json!(want), "{case}: Node's row");
        let providers = json!({"custom-acme": {"type": "custom", "protocol": "openai-chat", "baseURL": "https://example.test/v1",
            "modelOverrides": {"m1": override_}}});
        let record = listed_row("custom-acme", "m1", &node["reasoningLevels"], &node["reasoningOptions"]);
        let w = world(&[], providers, vec![record]).await;
        let ladder = ProcessLadder::new(&w.services);
        let row = ladder.cached_row("custom-acme", "m1").unwrap();
        assert_eq!(levels_of(&row), want.map(|l| l.iter().map(|s| (*s).to_owned()).collect()), "{case}");
    }
    let providers = json!({"custom-acme": {"type": "custom", "protocol": "openai-chat", "baseURL": "https://example.test/v1",
        "modelOverrides": {"m1": {"manual": true}}}});
    let w = world(&[], providers, Vec::new()).await;
    let row = ProcessLadder::new(&w.services).cached_row("custom-acme", "m1").unwrap();
    let node = &golden["rows"]["notDiscovered"];
    assert_eq!(row.get("reasoningLevels"), node.get("reasoningLevels"));
    assert_eq!(row.get("supportsReasoning"), node.get("supportsReasoning"));
    assert_eq!(row["manual"], node["manual"]);
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

async fn adapter_of(w: &World, name: &str) -> Arc<dyn ProviderAdapter> {
    DefaultProviderBuilder::new(builder_env(&w.services)).build(name, &json!({"enabled": true, "apiKey": "k"})).await.unwrap()
}

#[tokio::test]
async fn the_hop_wires_a_route_as_the_turn_start_does() {
    let providers = json!({
        "custom-acme": {"type": "custom", "protocol": "openai-chat", "baseURL": "https://example.test/v1",
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

/// The cache-warm gate's `providerAvailable(name)` (`fixtures/warm-gate-seams/golden.json`, from
/// the real Node `providerAvailable`): the builder's own `gated_off` switch, for every stored
/// Developer value and `MIXDOG_MODEL_PROXY` mode, answers as Node does.
#[tokio::test]
async fn the_gate_asks_the_builders_switch_and_gets_nodes_answer() {
    use mixdog_ai::warmer::gate::{GatedOff, ProviderSwitch};

    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/warm-gate-seams/golden.json")).unwrap();
    for case in golden["providerSwitch"].as_array().unwrap() {
        let proxy: &[(&str, &str)] = if case["proxyClient"] == true { &[("MIXDOG_MODEL_PROXY", "client")] } else { &[] };
        let w = world(proxy, json!({}), Vec::new()).await;
        let developer = case["developer"]["value"].clone();
        let absent = case["developer"]["absent"] == true;
        w.services
            .config
            .update_agent(move |doc| {
                if absent {
                    doc.shift_remove("developer");
                } else {
                    doc.insert("developer".into(), developer);
                }
                Ok(())
            })
            .await
            .unwrap();
        let switch = GatedOff(builder_env(&w.services).gated_off);
        for (name, available) in case["available"].as_object().unwrap() {
            assert_eq!(switch.available(name), *available, "{} proxy={} {name:?}", case["developer"], case["proxyClient"]);
        }
    }
}
