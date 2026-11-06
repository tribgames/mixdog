//! The turn-assembly seams built from one [`ProcessServices`]: the provider builder's inputs, the
//! accounting identity of a send, the step judge's ladder and the hop's wiring and error text.
//! Node goldens: `anthropic-caps`, `openai-facts`, `accounting-scope` (recorders in
//! `benchmarks/rust-core/recorders`).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::text_only::MediaText;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ListingLookup, ModelRecord, ModelsDevSource};
use mixdog_ai::effort::RejectionEntry;
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
use serde_json::{json, Value};

use super::accounting_scope::{accounting_deps, HeaderScope};
use super::builder_env::{builder_env, client_identity, CatalogCaps, CatalogOpenAiFacts};
use super::hop_bindings::HopBindings;
use super::ladder_sources::ProcessLadder;
use super::process::{
    resolve_installation_id, EffortRejections, FileRejections, HostInfo, LocalModels, ProcessServices, SessionHeaders,
};
use super::route_wiring::{AnthropicEffortGates, LocalEntry};
use super::step_judge::{ladder_facts, LadderSources};
use crate::config::{Config, ConfigLanes};

const CAPS: &str = include_str!("../../../../fixtures/anthropic-caps/golden.json");
const OPENAI: &str = include_str!("../../../../fixtures/openai-facts/golden.json");
const SCOPE: &str = include_str!("../../../../fixtures/accounting-scope/golden.json");

struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest) -> Result<HttpResponse, ProviderError> {
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

impl EffortRejections for Rejections {
    fn entry(&self, provider: &str, model: &str) -> Option<RejectionEntry> {
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
}

struct World {
    services: ProcessServices,
    headers: Arc<Headers>,
    rejections: Arc<Rejections>,
    _dir: tempfile::TempDir,
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

async fn world(env: &[(&str, &str)], providers: Value, records: Vec<ModelRecord>) -> World {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    config
        .update_agent(move |doc| {
            doc.insert("providers".into(), providers);
            Ok(())
        })
        .await
        .unwrap();
    let env: Arc<dyn Environment> = Arc::new(TestEnv(env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()));
    let headers = Arc::new(Headers::default());
    let rejections = Arc::new(Rejections::default());
    let services = ProcessServices {
        config,
        catalog: catalog_with(dir.path(), records).await,
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

fn anthropic_row(id: &str, levels: &[&str]) -> ModelRecord {
    let mut record = ModelRecord::new(ProviderId::from("anthropic"), id);
    record.reasoning_efforts = levels.iter().map(|l| (*l).to_owned()).collect();
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
#[test]
fn the_client_identity_follows_nodes_floors_and_overrides() {
    let none = TestEnv(HashMap::new());
    let id = client_identity(&none, &host(), "11111111-2222-4333-8444-555555555555");
    assert_eq!(id.codex.user_agent, "codex_cli_rs/0.166.0 (Windows 10.0.26100; x86_64) unknown");
    assert_eq!((id.codex.version.as_str(), id.codex.beta_features.as_str()), ("0.166.0", "remote_compaction_v2"));
    assert_eq!((id.grok, id.cursor, id.antigravity.as_str()), (None, None, "2.19.1"));

    let set = |pairs: &[(&str, &str)]| TestEnv(pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect());
    let env = set(&[
        ("MIXDOG_CODEX_ORIGINATOR", " codex_exec "),
        ("TERM_PROGRAM", " vscode "),
        ("MIXDOG_CODEX_VERSION", "0.170.1"),
        ("MIXDOG_CODEX_BETA_FEATURES", "a,b"),
        ("MIXDOG_GROK_CLIENT_VERSION", "1.0.99"),
        ("MIXDOG_CURSOR_CLIENT_VERSION", "cli-2027.01.01-abc"),
        ("MIXDOG_ANTIGRAVITY_VERSION", "3.0.0"),
    ]);
    let id = client_identity(&env, &host(), "i");
    // The User-Agent carries the version the client reports live (the floor here), the `version`
    // header the pinned one.
    assert_eq!(id.codex.user_agent, "codex_exec/0.166.0 (Windows 10.0.26100; x86_64) vscode");
    assert_eq!((id.codex.version.as_str(), id.codex.beta_features.as_str()), ("0.170.1", "a,b"));
    assert_eq!((id.grok.as_deref(), id.cursor.as_deref(), id.antigravity.as_str()), (Some("1.0.99"), Some("cli-2027.01.01-abc"), "3.0.0"));
    let pinned = set(&[("MIXDOG_CODEX_USER_AGENT", "ua/1")]);
    assert_eq!(client_identity(&pinned, &host(), "i").codex.user_agent, "ua/1");
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

#[tokio::test]
async fn a_remote_client_holds_no_model_credentials() {
    let w = world(&[("MIXDOG_MODEL_PROXY", "client"), ("OPENAI_API_KEY", "sk-live")], json!({}), Vec::new()).await;
    let env = builder_env(&w.services);
    assert!(env.keys.get("openai").await.is_none());
    // The PC's providers are available whatever the local Developer option says.
    assert!(!(env.gated_off)("cursor-oauth"));
    let local = world(&[("OPENAI_API_KEY", "sk-live")], json!({}), Vec::new()).await;
    assert_eq!(builder_env(&local.services).keys.get("openai").await.as_deref(), Some("sk-live"));
}

#[tokio::test]
async fn the_anthropic_caps_are_nodes_floor_and_live_catalog_answers() {
    let golden: Value = serde_json::from_str(CAPS).unwrap();
    let live: Vec<ModelRecord> = golden["live"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let values = strings(&row["reasoningOptions"][0]["values"]);
            anthropic_row(row["id"].as_str().unwrap(), &values.iter().map(String::as_str).collect::<Vec<_>>())
        })
        .collect();
    let dir = tempfile::tempdir().unwrap();
    let none = TestEnv(HashMap::new());
    for (set, catalog) in [("floor", catalog_with(dir.path(), Vec::new()).await), ("withLive", catalog_with(dir.path(), live).await)] {
        let caps = CatalogCaps::new(catalog, &none);
        for row in golden[set].as_array().unwrap() {
            let model = row["model"].as_str().unwrap();
            let got = caps.caps(model);
            let advertised = got.as_ref().filter(|c| c.supports_effort());
            let gates = AnthropicEffortGates::for_model(model, advertised);
            let supports = advertised.is_some();
            let adaptive = got.as_ref().is_some_and(|c| c.adaptive_thinking);
            let want = |key: &str| row[key].as_bool().unwrap();
            let ctx = format!("{set} {model}");
            assert_eq!(supports, want("supportsEffort"), "{ctx} supports effort");
            assert_eq!((gates.xhigh, gates.max), (want("xhigh"), want("max")), "{ctx} gates");
            assert_eq!(got.as_ref().is_some_and(|c| !c.manual_thinking), want("adaptiveOnly"), "{ctx} adaptive only");
            assert_eq!(supports && adaptive, want("betaHeader"), "{ctx} beta header");
            assert_eq!(caps.effort_levels_for(model), strings(&row["levels"]), "{ctx} levels");
        }
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
    let w = world(&[], providers, vec![anthropic_row("claude-sonnet-4-6", &["low", "medium", "high", "max"])]).await;
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
    assert_eq!(ladder.rejected("openai", "gpt-5.5").map(|e| e.rejected), Some(vec!["xhigh".to_owned()]));
    assert!(ladder.rejected("openai", "gpt-5.4").is_none());

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
    let custom = ladder_facts(&ladder, "custom-acme", "m1");
    let route = custom.custom.expect("a custom route carries its row and config");
    assert_eq!(route.base_url, "https://example.test/v1");
    let anthropic = ladder_facts(&ladder, "anthropic", "claude-opus-5");
    assert_eq!(anthropic.options, ["low", "medium", "high", "xhigh"]);
    assert!(anthropic.custom.is_none());
}

#[tokio::test]
async fn a_rejection_the_file_holds_reaches_the_ladder() {
    let w = world(&[], json!({}), Vec::new()).await;
    std::fs::create_dir_all(&w.services.plugin_data).unwrap();
    std::fs::write(
        w.services.plugin_data.join("effort-rejections.json"),
        r#"{"version":1,"models":{"openai:gpt-5.5":{"rejected":["xhigh"],"allowed":["low","high"]},"x:y":{"rejected":[]}}}"#,
    )
    .unwrap();
    let store = FileRejections::load(&w.services.lanes, &w.services.plugin_data).await;
    let entry = store.entry("openai", "GPT-5.5 ").unwrap();
    assert_eq!((entry.rejected, entry.allowed), (vec!["xhigh".to_owned()], vec!["low".to_owned(), "high".to_owned()]));
    assert!(store.entry("openai", "gpt-5.4").is_none());
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
