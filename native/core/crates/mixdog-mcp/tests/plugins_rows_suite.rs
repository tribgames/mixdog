//! `pluginsStatus` replayed against what today's Node answered (`fixtures/plugins-status/golden.json`,
//! recorded by `record.mjs` over fixture plugin trees): each step's rows, `missing` list, roots and the
//! `pluginMcpSummary()` it read. The recording carries Windows paths, so the replay runs only there.
//! One replay feeds the rows Node's summary (servers connected or not); the other reads the summary
//! from the real glue, through the scope the call resolves to.
#![cfg(windows)]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_mcp::config::Env;
use mixdog_mcp::connector_accounts::AccountHealth;
use mixdog_mcp::declaration_cache::DeclarationCache;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::extension_service::PluginsService;
use mixdog_mcp::hub::McpHub;
use mixdog_mcp::mcp_glue::GlueHost;
use mixdog_mcp::mcp_glue::GlueInputs;
use mixdog_mcp::mcp_glue::McpGlue;
use mixdog_mcp::mcp_glue::McpSurface;
use mixdog_mcp::oauth::OAuthEnv;
use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_mcp::plugin_admin::PluginAdmin;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_secrets::SecretError;
use mixdog_secrets::SecretStore;
use mixdog_statefile::Opts;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const GOLDEN: &str = include_str!("../../../fixtures/plugins-status/golden.json");

/// The thread the real-glue replay asks as: its header names no scope, so it reads nothing live
/// (`scope_of_request`), which is what Node's recording with no server connected reads.
const THREAD: &str = "reader";

struct NoGit;

impl GitRunner for NoGit {
    fn run(&self, _: &[String], _: Duration) -> Result<String, String> {
        Err("git is not used".to_owned())
    }
}

#[derive(Default)]
struct Config(Mutex<Map<String, Value>>);

#[async_trait]
impl ExtensionConfig for Config {
    fn agent(&self) -> Map<String, Value> {
        self.0.lock().unwrap().clone()
    }

    async fn save_agent(&self, _: &Map<String, Value>, _: &Map<String, Value>) -> Result<(), String> {
        Ok(())
    }

    fn set_disabled_skills(&self, _: &[String]) {}
}

/// The session layer: a working folder and no scope for any thread.
struct Surface(PathBuf);

#[async_trait]
impl McpSurface for Surface {
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

struct NoSecrets;

#[async_trait]
impl SecretStore for NoSecrets {
    async fn get(&self, _: &str) -> Result<Option<String>, SecretError> {
        Ok(None)
    }
    async fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
        Ok(())
    }
    async fn delete(&self, _: &str) -> Result<(), SecretError> {
        Ok(())
    }
}

struct NoSettings;

impl SkillSettingsSource for NoSettings {
    fn current(&self) -> SkillSettings {
        SkillSettings::default()
    }
}

/// A host whose MCP summary is the one the test sets (what Node's glue read in that step).
#[derive(Default)]
struct RecordedSummary(Mutex<Value>);

#[async_trait]
impl ExtensionHost for RecordedSummary {
    async fn reconcile_plugins_and_announce(&self) {}
    async fn announce(&self, _: &str) {}
    async fn announce_without_invalidating(&self, _: &str) {}
    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    async fn reconnect_mcp_and_announce(&self, _: Option<&str>, _: bool, _: &[String]) -> Value {
        Value::Null
    }
    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        Value::Null
    }
    async fn schedule_mcp_toggle(&self, _: &str, _: bool) -> Value {
        Value::Null
    }
    async fn publish_mcp_changes(&self, _: &[(String, bool)]) {}
    async fn announce_mcp_changes(&self, _: &[(String, bool)]) {}
    async fn connect_configured_mcp(&self, _: &str, _: bool) -> Value {
        Value::Null
    }
    fn invalidate_skills(&self) {}
    async fn flush_skills_save(&self) {}
    async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
        Ok(PathBuf::new())
    }
    async fn skills_status(&self) -> Value {
        json!({"skills": []})
    }
    async fn plugin_mcp_summary(&self, _: Option<&str>) -> Result<Value, String> {
        Ok(self.0.lock().unwrap().clone())
    }
}

async fn on_lane<T: Send + 'static>(work: impl FnOnce(&InLane<MaintenanceIo>) -> T + Send + 'static) -> T {
    mixdog_rt::testing::tokens().maintenance_io.submit(&CancellationToken::new(), work).unwrap().await.unwrap()
}

fn json_escaped(text: &str) -> String {
    let quoted = serde_json::to_string(text).unwrap();
    quoted[1..quoted.len() - 1].to_owned()
}

fn file_in(root: &Path, relative: &str) -> PathBuf {
    relative.split('/').fold(root.to_path_buf(), |path, part| path.join(part))
}

/// The recording, with the plugin folders and the registry it was recorded over laid out under `base`.
async fn lay_out(base: &Path) -> Value {
    let golden: Value = serde_json::from_str(&GOLDEN.replace("<BASE>", &json_escaped(&base.to_string_lossy()))).unwrap();
    let (base, laid) = (base.to_path_buf(), golden.clone());
    on_lane(move |lane| {
        let opts = Opts::default();
        for (name, files) in laid["fixtures"].as_object().unwrap() {
            let root = base.join("src").join(name);
            mixdog_statefile::create_dir_all(lane, &root).unwrap();
            for (relative, text) in files.as_object().unwrap() {
                let file = file_in(&root, relative);
                mixdog_statefile::create_dir_all(lane, file.parent().unwrap()).unwrap();
                mixdog_statefile::write_file(lane, &file, text.as_str().unwrap().as_bytes(), &opts).unwrap();
            }
        }
        let plugins = base.join("data").join("plugins");
        mixdog_statefile::create_dir_all(lane, &plugins).unwrap();
        mixdog_statefile::write_json(lane, &plugins.join("registry.json"), &json!({"version": 1, "plugins": laid["registry"]}), &opts).unwrap();
    })
    .await;
    golden
}

/// What the recorder did to the folders between its steps: step 3 removes a root and a hooks folder
/// and adds a skill, step 4 removes the registry.
async fn change_disk(base: &Path, step: usize) {
    let base = base.to_path_buf();
    on_lane(move |lane| {
        let opts = Opts::default();
        let source = |name: &str| base.join("src").join(name);
        match step {
            3 => {
                mixdog_statefile::remove_dir_all(lane, &source("beta")).unwrap();
                mixdog_statefile::remove_dir_all(lane, &source("alpha").join("hooks")).unwrap();
                mixdog_statefile::write_file(lane, &source("delta").join("plugin.json"), br#"{"name":"delta","skills":"skills"}"#, &opts).unwrap();
                mixdog_statefile::create_dir_all(lane, &source("delta").join("skills")).unwrap();
                mixdog_statefile::write_file(lane, &source("delta").join("skills").join("SKILL.md"), b"x", &opts).unwrap();
            }
            4 => mixdog_statefile::remove_file(lane, &base.join("data").join("plugins").join("registry.json")).unwrap(),
            _ => {}
        }
    })
    .await;
}

/// `plugins/pluginsStatus`, without the project scope it adds to each row (`scope`, `inheritedScope`, `activeHere`).
async fn status_of(service: &PluginsService, thread: Option<&str>) -> Value {
    let params = thread.map_or_else(|| json!({}), |thread| json!({"threadId": thread}));
    let request = CoreRequest { method: Method("plugins/pluginsStatus"), params, op: None, ctx: CallContext::internal("plugins rows") };
    let Reply::Value(mut status) = service.call(request).await.unwrap() else { panic!("pluginsStatus subscribed") };
    for row in status["plugins"].as_array_mut().unwrap() {
        let row = row.as_object_mut().unwrap();
        for key in ["scope", "inheritedScope", "activeHere"] {
            assert!(row.shift_remove(key).is_some(), "the row carries {key}");
        }
    }
    status
}

/// The answer against Node's, row by row so a difference names its plugin.
fn assert_status(step: &Value, answer: &Value) {
    let (name, expected) = (step["name"].as_str().unwrap(), &step["status"]);
    assert_eq!(answer["roots"], expected["roots"], "{name}: roots");
    assert_eq!(answer["missing"], expected["missing"], "{name}: missing");
    assert_eq!(answer["count"], expected["count"], "{name}: count");
    let rows = |status: &Value| status["plugins"].as_array().unwrap().clone();
    let (got, want) = (rows(answer), rows(expected));
    let ids = |rows: &[Value]| rows.iter().map(|row| row["id"].clone()).collect::<Vec<_>>();
    assert_eq!(ids(&got), ids(&want), "{name}: the rows and their order");
    for (got, want) in got.iter().zip(&want) {
        assert_eq!(got, want, "{name}: row {}", want["id"]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_rows_are_the_ones_node_answers_for_the_summary_it_read() {
    let dir = tempfile::tempdir().unwrap();
    let golden = lay_out(dir.path()).await;
    let config = Arc::new(Config::default());
    let host = Arc::new(RecordedSummary::default());
    let admin = Arc::new(PluginAdmin::new(dir.path().join("data"), Arc::new(NoGit), Arc::new(|| {})));
    let service = PluginsService::new(admin, Arc::new(DeclarationCache::new()), config.clone(), host.clone(), mixdog_rt::testing::tokens().maintenance_io);
    for (index, step) in golden["steps"].as_array().unwrap().iter().enumerate() {
        change_disk(dir.path(), index).await;
        *config.0.lock().unwrap() = step["config"].as_object().unwrap().clone();
        *host.0.lock().unwrap() = step["summary"].clone();
        assert_status(step, &status_of(&service, None).await);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_summary_of_the_real_glue_is_the_one_node_reads_with_no_server_connected() {
    let dir = tempfile::tempdir().unwrap();
    let golden = lay_out(dir.path()).await;
    let tokens = mixdog_rt::testing::tokens();
    let data = dir.path().join("data");
    let config = Arc::new(Config::default());
    let admin = Arc::new(PluginAdmin::new(data.clone(), Arc::new(NoGit), Arc::new(|| {})));
    let declarations = Arc::new(DeclarationCache::new());
    let hub = McpHub::new(
        mixdog_mcp::server::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io },
        data.join("tool-results"),
        mixdog_mcp::result::OutputPolicy::default(),
    );
    let glue = McpGlue::new(GlueInputs {
        hub,
        config: config.clone(),
        admin: admin.clone(),
        declarations: declarations.clone(),
        maintenance: tokens.maintenance_io,
        oauth_env: OAuthEnv { store: Arc::new(NoSecrets), plugin_data: data.clone(), io: tokens.durability_io },
        env: Env::default(),
        surface: Arc::new(Surface(dir.path().join("proj"))),
        health: Arc::new(AccountHealth::default()),
    });
    let catalog = SkillCatalog::new(
        data.clone(),
        tokens.maintenance_io,
        Arc::new(|_: &InLane<MaintenanceIo>| Vec::<mixdog_mcp::skills::SkillRoot>::new()),
        Arc::new(NoSettings),
        &SkillsWatch::new(),
    );
    let host = Arc::new(GlueHost::new(glue, catalog));
    let service = PluginsService::new(admin, declarations, config.clone(), host.clone(), tokens.maintenance_io);
    for (index, step) in golden["steps"].as_array().unwrap().iter().enumerate() {
        change_disk(dir.path(), index).await;
        if step["connected"] == json!(true) {
            continue;
        }
        let name = step["name"].as_str().unwrap();
        *config.0.lock().unwrap() = step["config"].as_object().unwrap().clone();
        assert_eq!(host.plugin_mcp_summary(Some(THREAD)).await.unwrap(), step["summary"], "{name}: the summary");
        assert_status(step, &status_of(&service, Some(THREAD)).await);
    }
}
