//! The Rust readers over a directory the real v1.4.5 code wrote and the one-time migration then converted
//! (`benchmarks/rust-core/recorders/record-migration-145.mjs` -> `fixtures/migration-145`), set against what
//! 1.4.5 itself answered for the same data (`answers.json`).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::oauth::CredentialIo;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::PdfIntake;
use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use mixdog_core_domains::domains::ai_account::Dashboards;
use mixdog_core_domains::domains::ai_account::SetupSource;
use mixdog_core_domains::domains::ai_account::UsageService;
use mixdog_core_domains::domains::ai_account::usage::dashboard::UsageSources;
use mixdog_ledger::ledger::UsageLedger;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::refresh::Pricer;
use mixdog_ledger::refresh::UsageRefresher;
use mixdog_ledger::repair::PriceRequest;
use mixdog_ledger::repair::Priced;
use mixdog_ledger::writer::UsageWriter;
use mixdog_migrate::durable;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::MigrateOptions;
use mixdog_migrate::run::Migrator;
use mixdog_migrate::run::product_drivers;
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_protocol::ThreadId;
use mixdog_rt::LaneToken;
use mixdog_store::registry::Registry;
use mixdog_store::sqlite::SqliteStore;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::StoreThreads;
use super::testing::Rig;
use super::thread_list::LIST;
use super::thread_list::ListOverlay;
use super::thread_list::ListRooms;
use super::thread_list::RowOverlay;
use super::thread_list::ThreadListService;
use mixdog_protocol::ThreadSummary;

pub(super) struct NoDocuments;

#[async_trait]
impl DocumentText for NoDocuments {
    async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
        panic!("the recorded data has no office part, yet {filename} was extracted")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("the migration extracts no PDF text")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("the migration counts no PDF")
    }
}

pub(super) struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/migration-145")
}

fn answers() -> Value {
    serde_json::from_slice(&durable::read(&fixture().join("answers.json")).expect("answers.json")).expect("answers parse")
}

/// The recording copied to a scratch directory and migrated, as the core does at its first start.
async fn migrated() -> (tempfile::TempDir, MigrationRoots) {
    let dir = tempfile::tempdir().expect("scratch dir");
    let home = dir.path().join(".mixdog");
    let from = fixture().join(".mixdog");
    for rel in durable::walk_files(&from).expect("walk the recording") {
        let target = home.join(&rel);
        durable::create_dir_all(target.parent().expect("a file has a parent")).expect("dir");
        durable::write_synced(&target, &durable::read(&from.join(&rel)).expect("read")).expect("copy");
    }
    let roots = MigrationRoots { data: home.join("data"), home, profile: None };
    let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: tokio::runtime::Handle::current() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default())
        .run()
        .expect("the migration of the recorded data completes");
    (dir, roots)
}

pub(super) async fn threads_over(data: &Path) -> Arc<StoreThreads> {
    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = tokens
        .maintenance_io
        .submit(&mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
    Arc::new(
        StoreThreads::over_data_dir(data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("thread store"),
    )
}

pub(super) struct Idle;

impl ListOverlay for Idle {
    fn of(&self, _: &ThreadId) -> RowOverlay {
        RowOverlay::default()
    }
}

pub(super) struct NoRooms;

#[async_trait]
impl ListRooms for NoRooms {
    async fn with_rooms(&self, rows: Vec<ThreadSummary>) -> Result<Vec<ThreadSummary>, String> {
        Ok(rows)
    }
    async fn room_threads(&self) -> Result<Vec<ThreadId>, String> {
        Ok(Vec::new())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn thread_list_on_the_migrated_directory_is_what_1_4_5_listed() {
    let (_dir, roots) = migrated().await;
    let threads = threads_over(&roots.data).await;
    let list = ThreadListService::new(Arc::new(threads.index().clone()), Arc::new(Idle), Arc::new(NoRooms), Arc::new(super::testing::FixedTaskWorkspace("/tasks")));
    let answer = value(&list, request(LIST, json!({ "limit": 50 }), None)).await.expect("thread/list");
    let got = answer["data"].as_array().expect("data");
    let recorded = answers();
    let want = recorded["threadList"]["sessions"].as_array().expect("sessions");
    let ids = |rows: &[Value]| rows.iter().map(|r| r["id"].clone()).collect::<Vec<_>>();
    assert_eq!(ids(got), ids(want), "the same threads in the same order");
    assert_eq!(recorded["threadList"]["nextCursor"], Value::Null, "all four fit one page");
    // The 1.4.5 recording is the session store's list (`listSessions`); `thread/list` is the desktop's own wire shape of
    // the same sessions, so its ids and order are compared above and each session's whole store row (the row the
    // listing is built from) below.
    for want in want {
        let id = want["id"].as_str().expect("id");
        let got = Value::Object(threads.index().lead_row(id).await.expect("the store reads the row").expect("the store lists the recorded session").row);
        let mut want = want.clone();
        // The size and mtime of the 1.4.5 session json the migration retires: positive in the recording, and a
        // migrated session has no such file to measure, so its row carries 0 for both.
        for key in ["storageMtimeMs", "storageSize"] {
            assert!(want[key].as_f64() > Some(0.0), "{key} of {} was a measured file fact", want["id"]);
            want[key] = json!(0);
        }
        // The store's row also carries fields of the session record that 1.4.5's summary page leaves out; each is the
        // recorded record's own value (compactCount that of its compaction).
        let record = recorded["threads"].as_object().expect("threads").values().find(|t| t["id"] == want["id"]).expect("the thread's record");
        let record = &record["record"];
        for key in ["parentSessionId", "presetName", "effort", "fast", "modelParameters", "permissionMode", "schemaAllowedTools", "taskType"] {
            want[key] = record[key].clone();
        }
        want["compactCount"] = record["compaction"]["compactCount"].clone();
        assert_eq!(got, want, "store row of {}", want["id"]);
    }
}
/// The recording ran offline: 1.4.5 had no price catalog, so a record is priced as stored or not at all.
struct NoCatalog;

impl Pricer for NoCatalog {
    fn revision(&self) -> String {
        String::new()
    }

    fn price(&self, _: &PriceRequest) -> mixdog_ledger::Result<Priced> {
        Ok(Priced { cost_usd: None, rates: None })
    }
}

struct NoSetup;

#[async_trait]
impl SetupSource for NoSetup {
    async fn setup(&self, _: bool, _: bool) -> Result<Value, String> {
        unreachable!("a request page reads no provider setup")
    }
    async fn display_config(&self) -> Result<Value, String> {
        unreachable!("a request page reads no provider setup")
    }
}

struct NoQuotas;

#[async_trait]
impl UsageSources for NoQuotas {
    async fn cached_oauth(&self, _: &str, _: bool) -> Option<Value> {
        unreachable!("a request page reads no provider quota")
    }
    fn oauth_provider_ready(&self, _: &str) -> bool {
        unreachable!("a request page reads no provider quota")
    }
    async fn fetch_oauth(&self, _: &str, _: bool) -> Result<Option<Value>, String> {
        unreachable!("a request page reads no provider quota")
    }
    async fn cached_api(&self, _: &str) -> Option<Value> {
        unreachable!("a request page reads no provider quota")
    }
    async fn fetch_api(&self, _: &str, _: bool) -> Result<Option<Value>, String> {
        unreachable!("a request page reads no provider quota")
    }
}

fn account_store(data: &Path) -> AccountStore {
    let tokens = mixdog_rt::testing::tokens();
    AccountStore::new(data.to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_requests_through_the_usage_service_are_what_1_4_5_answered() {
    let (_dir, roots) = migrated().await;
    let tokens = mixdog_rt::testing::tokens();
    let path = roots.data.join("usage").join("ledger.sqlite");
    let ledger = UsageLedger {
        writer: UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).expect("the migrated ledger opens"),
        reader: UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io),
        refresher: UsageRefresher::new(Arc::new(NoCatalog), tokens.cpu_bulk),
    };
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(threads_over(&roots.data).await)));
    let service = UsageService::new(
        Arc::new(Arc::new(ledger)),
        directory,
        Arc::new(NoQuotas),
        account_store(&roots.data),
        Dashboards::new(Arc::new(NoSetup)),
    );
    let recorded = answers();
    let pages = recorded["usageRequests"].as_array().expect("usageRequests");
    assert!(pages.iter().any(|p| p["options"]["view"] == "hour"), "the hour view is recorded");
    for page in pages {
        let mut options = page["options"].clone();
        // The period is the one 1.4.5 resolved at its own `generatedAt`.
        options["asOf"] = page["answer"]["generatedAt"].clone();
        let got = value(&*service, request("usage/getUsageRequests", json!({ "options": options }), None)).await.expect("usage requests");
        assert_eq!(got, page["answer"], "usage requests for {}", page["options"]);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_project_registry_lists_what_1_4_5_listed() {
    let (_dir, roots) = migrated().await;
    let registry = Registry::new(roots.home.join("projects.json"));
    let got = mixdog_rt::testing::tokens()
        .durability_io
        .submit(&mixdog_rt::CancellationToken::new(), move |lane| registry.list(lane))
        .expect("lane")
        .await
        .expect("job ran");
    assert_eq!(serde_json::to_value(got).expect("entries"), answers()["projects"]);
}

struct Offline;

#[async_trait]
impl mixdog_ai::transport::HttpSend for Offline {
    async fn send(
        &self,
        request: mixdog_core_api::domain::provider::WireRequest,
        _: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
        panic!("the roster reads no network, yet {request:?} was sent")
    }
}

struct NoVariables;

impl mixdog_ai::registry::keys::Environment for NoVariables {
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

struct NoHistory;

#[async_trait]
impl mixdog_ai::service::oauth_usage::QuotaHistory for NoHistory {
    async fn record(&self, _: Vec<mixdog_ai::service::oauth_usage::QuotaSample>) -> Result<(), String> {
        Ok(())
    }
}

struct NoRefresh;

impl mixdog_core_domains::domains::ai_account::collaborators::AuthRefresh for NoRefresh {
    fn after_credential_change(&self) {}
    fn custom_provider_removed(&self, _: &str) {}
    fn adopt_credentials(&self) {}
    fn after_usage_auth_change(&self) {}
    fn release_admission_cooldowns(&self) {}
    fn account_selection_changed(&self) {}
}

struct NoAdc;

#[async_trait]
impl mixdog_core_domains::domains::ai_account::collaborators::VertexAdc for NoAdc {
    async fn login(&self, _: &str) -> Result<Option<String>, String> {
        unreachable!("a roster runs no gcloud check")
    }
}

/// The provider builder over the migrated config: a dev-gated provider answers to the migrated Developer options
/// (`providerAvailable`), as the production builder does. It builds no adapter, and the credential probe of the
/// recording never ran (the recorded config says `credentialProbeUnavailable`).
struct GatedBuilder {
    developer: Value,
}

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for GatedBuilder {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Err(format!("no adapter for {name} is built here"))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, name: &str) -> bool {
        mixdog_ai::service::admin_models::provider_available(name, false, &self.developer)
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Err("the credential probe is not run here".to_owned())
    }
}

fn now_ms() -> i64 {
    i64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_millis()).expect("ms")
}

/// The production `ProviderAdmin` over the migrated directory and config, the one that serves the desktop's account
/// list (`getProviderAccounts`). Only the collaborators a roster never reaches are inert.
async fn provider_admin(roots: &MigrationRoots) -> Arc<mixdog_core_domains::domains::ai_account::ProviderAdmin> {
    use mixdog_core_domains::domains::ai_account::production::{OAuthWiring, oauth_providers};
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let accounts = account_store(&roots.data);
    let config = migrated_config(roots).await;
    let http: Arc<dyn mixdog_ai::transport::HttpSend> = Arc::new(Offline);
    let env: Arc<dyn mixdog_ai::registry::keys::Environment> = Arc::new(NoVariables);
    let versions = mixdog_ai::client_versions::ClientVersions::new(http.clone(), roots.data.clone(), io, env.clone());
    let wiring = Arc::new(OAuthWiring {
        accounts: accounts.clone(),
        http: http.clone(),
        pace: Arc::new(mixdog_ai::oauth::SystemPace),
        file: OAuthWiring::files_of(accounts.clone()),
        io,
        plugin_data: roots.data.clone(),
        versions: versions.clone(),
        now_ms: Arc::new(now_ms),
        env,
        cli_auth: roots.home.join("command-code-cli-auth.json"),
    });
    let builder: Arc<dyn mixdog_ai::registry::providers::ProviderBuilder> =
        Arc::new(GatedBuilder { developer: config.agent().get("developer").cloned().unwrap_or(Value::Null) });
    let oauth_usage = mixdog_ai::service::oauth_usage::OAuthUsage::new(mixdog_ai::service::oauth_usage::UsageDeps {
        http: Arc::new(mixdog_ai::service::usage_ports::RoutedUsageHttp::new(http.clone())),
        source: Arc::new(mixdog_ai::service::usage_ports::ProviderUsageSource::new(accounts.clone(), http).with_versions(versions.clone())),
        grok: Arc::new(mixdog_ai::service::usage_ports::GrokVersionHeaders::new(versions)),
        history: Arc::new(NoHistory),
        store: accounts.clone(),
        io,
        log: Arc::new(|_| {}),
        data_dir: roots.data.clone(),
    });
    mixdog_core_domains::domains::ai_account::ProviderAdmin::new(
        oauth_providers(&wiring),
        builder.clone(),
        accounts,
        Arc::new(mixdog_ai::registry::keys::MemoryVault::default()),
        config,
        Arc::new(NoRefresh),
        Arc::new(NoAdc),
        Arc::new(mixdog_ai::registry::ProviderRegistry::new(builder)),
        oauth_usage,
        io,
    )
}

/// `listProviderAccounts(provider)` for every provider the recording asked, the whole answer, the refusals of the
/// providers a Developer option gates included.
///
/// Gaps against 1.4.5''s answer: none in the fields; `usage`, `blockedUntil` and `limit` are null in the recording
/// (no quota was measured), so a measured one is not exercised here.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_provider_roster_reads_back_as_1_4_5_listed_it() {
    let (_dir, roots) = migrated().await;
    let admin = provider_admin(&roots).await;
    let recorded = answers();
    let providers = recorded["accounts"].as_object().expect("accounts");
    assert!(providers.len() > 3, "several providers are recorded");
    assert!(providers.values().any(|want| want.get("error").is_some()), "a refused provider is recorded");
    assert!(providers.values().any(|want| want["accounts"].as_array().is_some_and(|rows| rows.iter().any(|r| r["id"] == "default"))), "a default account is recorded");
    for (provider, want) in providers {
        let got = match admin.list_provider_accounts(provider).await {
            Ok(roster) => roster,
            Err(failure) => json!({ "error": failure.message() }),
        };
        assert_eq!(&got, want, "{provider}");
    }
}struct NoEvidence;

#[async_trait]
impl mixdog_core_agents::agents::AgentEvidence for NoEvidence {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

async fn migrated_config(roots: &MigrationRoots) -> mixdog_core_config::config::Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = mixdog_core_config::config::Config::open(
        roots.data.join("mixdog-config.json"),
        Arc::new(mixdog_core_api::mock::MockStatePublisher::default()),
        lanes,
    )
    .await
    .expect("the migrated config opens");
    config
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_custom_agents_list_as_1_4_5_listed_them() {
    let (dir, roots) = migrated().await;
    let config = migrated_config(&roots).await;
    let tokens = mixdog_rt::testing::tokens();
    // The shipped roles are the 1.4.5 install root `src/agents`, which is what the recorded listing was built over.
    let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../src");
    let agents = mixdog_core_agents::agents::AgentDefinitions::new(
        &shipped,
        &roots.data,
        tokens.interactive_io,
        mixdog_core_config::config::agent_routes::AgentRoutes::new(config, &roots.data),
        Arc::new(NoEvidence),
        Arc::new(|| json!({ "provider": "stub", "model": "stub-model" })),
        dir.path().join("task"),
    );
    let got: Vec<Value> = agents
        .catalog()
        .await
        .expect("the catalog")
        .as_array()
        .expect("rows")
        .iter()
        .filter(|row| row["custom"] == json!(true))
        .map(|row| json!({ "id": row["id"], "label": row["label"], "kind": row["kind"], "route": row["route"] }))
        .collect();
    assert_eq!(Value::Array(got), answers()["agents"]);
}

struct WorkflowHostStub;

#[async_trait]
impl mixdog_core_config::workflow::WorkflowHost for WorkflowHostStub {
    fn main_route(&self) -> Value {
        unreachable!("listing workflows asks no route")
    }
    async fn adopt_lead_route(&self, _: Value) {
        unreachable!("listing workflows saves no route")
    }
    async fn custom_agent_ids(&self) -> Vec<String> {
        unreachable!("listing workflows asks no agents")
    }
    fn provider_available(&self, _: &str) -> bool {
        unreachable!("listing workflows asks no provider")
    }
    fn require_local_provider_management(&self) -> Result<(), String> {
        unreachable!("listing workflows manages no provider")
    }
    fn normalize_stored_custom_config(&self, _: &Value) -> Result<Value, String> {
        unreachable!("listing workflows reads no custom provider")
    }
    async fn after_credential_change(&self) {
        unreachable!("listing workflows changes no credential")
    }
    async fn ensure_providers_ready(&self, _: serde_json::Map<String, Value>) -> Result<(), String> {
        unreachable!("listing workflows readies no provider")
    }
    async fn lookup_model_meta(&self, _: &str, _: &str) -> Option<Value> {
        unreachable!("listing workflows looks up no model")
    }
    fn web_search_capable(&self, _: &str, _: Option<&Value>) -> bool {
        unreachable!("listing workflows asks no web search")
    }
    fn fast_capable(&self, _: &str, _: Option<&Value>, _: Option<&str>, _: Option<&Value>) -> bool {
        unreachable!("listing workflows asks no fast mode")
    }
    fn web_search_route_saved(&self, _: &Value) {
        unreachable!("listing workflows saves no route")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_workflow_catalog_lists_as_1_4_5_listed_it() {
    let (dir, roots) = migrated().await;
    let config = migrated_config(&roots).await;
    let service = mixdog_core_config::workflow::WorkflowConfig::new(
        config,
        mixdog_core_config::workflow::pack::WorkflowPaths {
            root: Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/workflow-config/shipped"),
            data: roots.data.clone(),
        },
        Arc::new(WorkflowHostStub),
        mixdog_core_base::support::testing::scopes(dir.path(), "config").await,
        &mixdog_rt::testing::tokens(),
    );
    assert_eq!(service.list_workflows().await.expect("workflows"), answers()["workflows"]);
}

fn readers() -> Value {
    serde_json::from_slice(&durable::read(&fixture().join("readers.json")).expect("readers.json")).expect("readers parse")
}

/// The dashboard is built in its preview form, which reads no provider quota.
struct NoQuotaRead;

#[async_trait]
impl UsageSources for NoQuotaRead {
    async fn cached_oauth(&self, _: &str, _: bool) -> Option<Value> {
        unreachable!("a preview reads no provider quota")
    }
    fn oauth_provider_ready(&self, _: &str) -> bool {
        unreachable!("a preview reads no provider quota")
    }
    async fn fetch_oauth(&self, _: &str, _: bool) -> Result<Option<Value>, String> {
        unreachable!("a preview fetches no provider quota")
    }
    async fn cached_api(&self, _: &str) -> Option<Value> {
        unreachable!("a preview reads no provider quota")
    }
    async fn fetch_api(&self, _: &str, _: bool) -> Result<Option<Value>, String> {
        unreachable!("a preview fetches no provider quota")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_usage_dashboard_on_the_migrated_directory_is_what_1_4_5_built() {
    let (_dir, roots) = migrated().await;
    let recorded = readers();
    let dashboard = &recorded["usageDashboard"];
    let checked_at = dashboard["answer"]["checkedAt"].as_i64().expect("checkedAt");
    // The config is the migrated one, as the production `SetupSourceOf::display_config` reads it: the stored agent section
    // with `providers` loaded over it (defaults, the stored section folded on, the Developer options applied).
    let migrated = migrated_config(&roots).await;
    let mut config = migrated.loaded_agent().await.expect("the migrated agent section");
    let effective = mixdog_ai::registry::effective::EffectiveProviders::new(
        Arc::new(GatedBuilder { developer: config.get("developer").cloned().unwrap_or(Value::Null) }),
        mixdog_ai::registry::keys::ApiKeyStore::new(Arc::new(mixdog_ai::registry::keys::MemoryVault::default()), Arc::new(NoVariables), false),
        Arc::new(NoVariables),
    );
    let providers = effective.load(&config, false).await.expect("the providers of the migrated config");
    config.insert("providers".into(), Value::Object(providers));
    let config = Value::Object(config);
    let got = mixdog_core_domains::domains::ai_account::usage::dashboard::create_usage_dashboard(
        &config,
        &dashboard["setup"],
        &mixdog_core_domains::domains::ai_account::usage::dashboard::DashboardOptions { preview: true, ..Default::default() },
        checked_at,
        &NoQuotaRead,
        &account_store(&roots.data),
    )
    .await;
    for (got_row, want_row) in got["rows"].as_array().expect("rows").iter().zip(dashboard["answer"]["rows"].as_array().expect("recorded rows")) {
        assert_eq!(got_row, want_row, "{}", want_row["id"]);
    }
    assert_eq!(got, dashboard["answer"]);
}

struct ConfigAgent(mixdog_core_config::config::Config);

#[async_trait]
impl mixdog_mcp::extension_service::ExtensionConfig for ConfigAgent {
    fn agent(&self) -> serde_json::Map<String, Value> {
        self.0.agent()
    }
    async fn save_agent(&self, _: &serde_json::Map<String, Value>, _: &serde_json::Map<String, Value>) -> Result<(), String> {
        unreachable!("reading the MCP servers saves no config")
    }
    fn set_disabled_skills(&self, _: &[String]) {
        unreachable!("reading the MCP servers sets no skills")
    }
}

struct NoSurface(PathBuf);

#[async_trait]
impl mixdog_mcp::mcp_glue::McpSurface for NoSurface {
    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Ok(self.0.clone())
    }
    async fn thread_scope(&self, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn refresh_surface(&self) {}
    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn open_browser(&self, _: &str) {}
    fn announce_plugins(&self) {}
    async fn flush_skills_save(&self) {}
}

struct NoGit;

impl mixdog_mcp::plugin_admin::GitRunner for NoGit {
    fn run(&self, _: &[String], _: std::time::Duration) -> Result<String, String> {
        Err("git is not used".to_owned())
    }
}

struct NoSecrets;

#[async_trait]
impl mixdog_secrets::SecretStore for NoSecrets {
    async fn get(&self, _: &str) -> Result<Option<String>, mixdog_secrets::SecretError> {
        Ok(None)
    }
    async fn set(&self, _: &str, _: &str) -> Result<(), mixdog_secrets::SecretError> {
        Ok(())
    }
    async fn delete(&self, _: &str) -> Result<(), mixdog_secrets::SecretError> {
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_mcp_servers_on_the_migrated_directory_are_what_1_4_5_listed() {
    use mixdog_mcp::mcp_service::McpRuntime;
    let (dir, roots) = migrated().await;
    let tokens = mixdog_rt::testing::tokens();
    let admin = Arc::new(mixdog_mcp::plugin_admin::PluginAdmin::new(roots.data.clone(), Arc::new(NoGit), Arc::new(|| {})));
    let glue = mixdog_mcp::mcp_glue::McpGlue::new(mixdog_mcp::mcp_glue::GlueInputs {
        hub: mixdog_mcp::hub::McpHub::new(
            mixdog_mcp::server::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk },
            roots.data.join("tool-results"),
            mixdog_mcp::result::OutputPolicy::default(),
        ),
        config: Arc::new(ConfigAgent(migrated_config(&roots).await)),
        admin,
        declarations: Arc::new(mixdog_mcp::declaration_cache::DeclarationCache::new()),
        maintenance: tokens.maintenance_io,
        oauth_env: mixdog_mcp::oauth::OAuthEnv { store: Arc::new(NoSecrets), plugin_data: roots.data.clone(), io: tokens.durability_io },
        env: std::env::vars().collect::<mixdog_mcp::config::Env>(),
        surface: Arc::new(NoSurface(dir.path().join("work"))),
        health: Arc::new(mixdog_mcp::connector_accounts::AccountHealth::default()),
        login_feeds: Arc::new(mixdog_core_api::feed_publisher::LoginFeeds::new(Arc::new(
            mixdog_core_api::mock::MockScopedFeeds::new(mixdog_core_api::mock::MockLimits::default()),
        ))),
    });
    let recorded = readers();
    assert_eq!(glue.status().await, recorded["mcp"]["status"]);
    let configs = recorded["mcp"]["configs"].as_object().expect("configs");
    assert!(configs.len() > 1, "several servers are recorded");
    for (name, want) in configs {
        assert_eq!(glue.server_config(name).await.expect("config"), *want, "{name}");
    }
}