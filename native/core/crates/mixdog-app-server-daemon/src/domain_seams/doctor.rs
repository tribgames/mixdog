//! `doctor`: the statuses of `/doctor` that no domain answers (`tui/app/doctor.mjs` check table).
//! Each asks the service Node asks: the JS runtime, the provider setup, the route, the channel
//! worker and setup, the hook bus, the session-log migration, the bridge files and the live
//! session surface.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_agent::compact::settings_service::CompactionHost;
use mixdog_core_base::support::on_lane;
use mixdog_core_domains::domains::ai_account::collaborators::ProviderSetup;
use mixdog_core_domains::domains::diagnostics::Probe;
use mixdog_core_domains::domains::diagnostics::ProbeFailed;
use mixdog_protocol::ThreadId;
use mixdog_rt::InteractiveIo;
use mixdog_services::bots::live::LiveSurface;
use mixdog_services::channels::ChannelRuntime;
use mixdog_services::channels::setup::AutomationAdmin;
use mixdog_services::tidy::process::Processes;
use mixdog_services::tidy::process::RunOptions;
use mixdog_statefile::list_dir;
use mixdog_statefile::read_content;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::compose_domains::DoctorHost;
use crate::compose_mcp::BridgeFeatures;

/// `SESSION_LOG_SUFFIX`, `SESSION_LOG_MIGRATION_ID`, `PROGRESS_FILE` (`session-log-*.mjs`).
const SESSION_LOG_SUFFIX: &str = ".log.jsonl";
const SESSION_LOG_MIGRATION_ID: &str = "json-to-log-v1";
const PROGRESS_FILE: &str = "session-log-migration.json";
const PROGRESS_VERSION: i64 = 1;
/// `MIGRATION_SKIP.BUSY`.
const SKIP_BUSY: &str = "busy";
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// `runtime.hooksStatus()`: the hook bus's `status()`.
#[async_trait]
pub trait HooksStatus: Send + Sync {
    async fn status(&self) -> Value;
}

/// The JS interpreter of the install: what `process.versions.node` reports in Node.
pub struct JsInterpreter {
    pub program: PathBuf,
    /// The program is the app binary running as node (`ELECTRON_RUN_AS_NODE`).
    pub electron: bool,
}

pub struct DoctorInputs {
    pub data_dir: PathBuf,
    /// The package root: its `package.json` carries `engines.node`.
    pub package_root: PathBuf,
    pub interpreter: JsInterpreter,
    pub processes: Processes,
    pub io: InteractiveIo,
    pub providers: Arc<dyn ProviderSetup>,
    pub routes: Arc<dyn CompactionHost>,
    pub channel_runtime: Arc<ChannelRuntime>,
    pub channel_admin: Arc<dyn AutomationAdmin>,
    pub hooks: Arc<dyn HooksStatus>,
    pub bridge: Arc<dyn BridgeFeatures>,
    pub live: Arc<dyn LiveSurface>,
}

pub struct DaemonDoctorHost {
    inputs: DoctorInputs,
}

impl DaemonDoctorHost {
    pub fn new(inputs: DoctorInputs) -> Arc<Self> {
        Arc::new(Self { inputs })
    }
}

/// `readPackageJson()?.engines?.node`: `None` when the file is unreadable, not JSON, or names no
/// engine.
async fn read_engines(io: InteractiveIo, package_root: &Path) -> Result<Option<String>, ProbeFailed> {
    let path = package_root.join("package.json");
    let bytes = on_lane(io, &CancellationToken::new(), move |_lane| read_content(&path)).await.map_err(|_| ProbeFailed)?;
    let Ok(Some(bytes)) = bytes else { return Ok(None) };
    let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Ok(parsed.get("engines").and_then(|e| e.get("node")).and_then(Value::as_str).map(str::to_owned))
}

/// `process.versions.node` of the interpreter the install runs.
async fn probe_version(processes: &Processes, interpreter: &JsInterpreter, cwd: &Path) -> Result<String, ProbeFailed> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    if interpreter.electron {
        env.insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
    }
    let mut options = RunOptions::new(cwd);
    options.env = Some(&env);
    options.timeout = VERSION_PROBE_TIMEOUT;
    let args = ["-p".to_owned(), "process.versions.node".to_owned()];
    let result = processes.run(&interpreter.program.to_string_lossy(), &args, options).await;
    if result.code != 0 {
        return Err(ProbeFailed);
    }
    Ok(mixdog_js::js_trim(&result.stdout).to_owned())
}
/// `readMigrationProgress`: the progress record, a fresh one when the file is missing; `Err`
/// when the file is not a progress record (its skips are never guessed).
fn read_progress(path: &Path) -> Result<(bool, i64, Vec<(String, String)>), ()> {
    let bytes = match read_content(path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok((false, 0, Vec::new())),
        Err(_) => return Err(()),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let valid = value.get("v").and_then(Value::as_i64) == Some(PROGRESS_VERSION)
        && value.get("migrationId").and_then(Value::as_str) == Some(SESSION_LOG_MIGRATION_ID)
        && value.get("cursor").is_some_and(|c| c.is_null() || c.is_string())
        && value.get("complete").is_some_and(Value::is_boolean)
        && value.get("skipped").is_some_and(Value::is_object);
    if !valid {
        return Err(());
    }
    let complete = value["complete"].as_bool().unwrap_or(false);
    // `progress.updatedAt > 0`: a missing or non-numeric stamp is not a start.
    let updated = value.get("updatedAt").and_then(Value::as_f64).map_or(0, |at| if at > 0.0 { 1 } else { 0 });
    let skipped = value["skipped"]
        .as_object()
        .map(|rows| {
            rows.iter()
                .map(|(id, skip)| (id.clone(), skip.get("reason").and_then(Value::as_str).unwrap_or_default().to_owned()))
                .collect()
        })
        .unwrap_or_default();
    Ok((complete, updated, skipped))
}

/// `legacyIdsWithoutLog(names)`: the `<id>.json` names (ids of `[A-Za-z0-9_-]`) that have no log.
fn legacy_ids_without_log(names: &[String]) -> Vec<String> {
    let logs: std::collections::HashSet<&str> = names.iter().filter_map(|name| name.strip_suffix(SESSION_LOG_SUFFIX)).collect();
    let mut legacy: Vec<String> = names
        .iter()
        .filter(|name| !name.ends_with(SESSION_LOG_SUFFIX))
        .filter_map(|name| name.strip_suffix(".json"))
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
        .filter(|id| !logs.contains(id))
        .map(str::to_owned)
        .collect();
    legacy.sort();
    legacy
}

/// `readSessionLogMigration(dataDir)` (`doctor-session-log.mjs`).
fn session_log_status(data_dir: &Path, lane: &mixdog_rt::InLane<InteractiveIo>) -> std::io::Result<Value> {
    let Ok((complete, started, skipped)) = read_progress(&data_dir.join(PROGRESS_FILE)) else {
        return Ok(json!({ "unreadable": true }));
    };
    let names = match list_dir(lane, &data_dir.join("sessions")) {
        Ok(names) => names,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error),
    };
    let permanent: std::collections::HashSet<&str> =
        skipped.iter().filter(|(_, reason)| reason != SKIP_BUSY).map(|(id, _)| id.as_str()).collect();
    let pending = legacy_ids_without_log(&names).iter().filter(|id| !permanent.contains(id.as_str())).count();
    let logs = names.iter().filter(|name| name.ends_with(SESSION_LOG_SUFFIX)).count();
    let skipped: Vec<Value> = skipped.iter().map(|(id, reason)| json!({ "id": id, "reason": reason })).collect();
    Ok(json!({ "complete": complete, "started": started > 0, "logs": logs, "pending": pending, "skipped": skipped }))
}

#[async_trait]
impl DoctorHost for DaemonDoctorHost {
    async fn node_runtime(&self) -> Probe {
        let version = probe_version(&self.inputs.processes, &self.inputs.interpreter, &self.inputs.data_dir).await?;
        let engines = read_engines(self.inputs.io, &self.inputs.package_root).await?;
        Ok(Some(json!({ "version": version, "engines": engines })))
    }
    async fn provider_setup(&self) -> Probe {
        self.inputs.providers.get(false, false, false, false).await.map(Some).map_err(|_| ProbeFailed)
    }

    fn active_provider(&self) -> Option<String> {
        self.inputs.routes.route_provider(None)
    }

    async fn channel_worker_status(&self) -> Probe {
        Ok(Some(self.inputs.channel_runtime.status().to_json()))
    }

    async fn channel_setup(&self) -> Probe {
        self.inputs.channel_admin.get_channel_setup().await.map(Some).map_err(|_| ProbeFailed)
    }

    async fn hooks_status(&self) -> Probe {
        Ok(Some(self.inputs.hooks.status().await))
    }

    async fn session_log_migration(&self) -> Probe {
        let data_dir = self.inputs.data_dir.clone();
        let status = on_lane(self.inputs.io, &CancellationToken::new(), move |lane| session_log_status(&data_dir, lane))
            .await
            .map_err(|_| ProbeFailed)?;
        status.map(Some).map_err(|_| ProbeFailed)
    }

    fn bridge_active(&self, id: &str) -> bool {
        self.inputs.bridge.present(id)
    }

    /// `options.notice` (the TUI's own doctor): the report is a muted line of the thread. With no
    /// thread there is no live session to show it in.
    async fn notice(&self, thread: Option<&ThreadId>, text: &str) {
        let Some(thread) = thread else { return };
        if let Err(error) = self.inputs.live.notice(thread.as_str(), json!({ "text": text, "tone": "info" })).await {
            tracing::warn!(%error, "the doctor report was not shown in the thread");
        }
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test lays out its fixture files with blocking calls on the test thread")]
mod tests {
    use super::*;
    use crate::domain_seams::golden;

    /// Every data folder Node's `readSessionLogMigration` was recorded over: the same files, the
    /// same status (a progress file that is not a record reads `{unreadable: true}`).
    #[tokio::test(flavor = "multi_thread")]
    async fn the_session_log_status_matches_nodes_for_each_folder() {
        for case in golden()["sessionLog"].as_array().unwrap() {
            let dir = tempfile::tempdir().unwrap();
            for (rel, text) in case["files"].as_object().unwrap() {
                let path = dir.path().join(rel);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, text.as_str().unwrap()).unwrap();
            }
            let data = dir.path().to_path_buf();
            let status = on_lane(mixdog_rt::testing::tokens().interactive_io, &CancellationToken::new(), move |lane| session_log_status(&data, lane))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(status, case["status"], "{}", case["name"]);
        }
    }

    /// The package the doctor reads `engines.node` from: the recorded `package.json` gives the
    /// recorded engine; a folder without one gives none.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_engine_requirement_is_the_package_jsons() {
        let node = &golden()["nodeRuntime"];
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), node["packageJson"].as_str().unwrap()).unwrap();
        let io = mixdog_rt::testing::tokens().interactive_io;
        assert_eq!(read_engines(io, dir.path()).await.unwrap().as_deref(), node["engines"].as_str());
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(read_engines(io, empty.path()).await.unwrap(), None);
    }

    /// `process.versions.node` is a dotted triple: the recorded one and the interpreter's.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_interpreters_version_has_the_shape_nodes_has() {
        let shaped = |version: &str| {
            let parts: Vec<&str> = version.split('.').collect();
            parts.len() == 3 && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        };
        assert!(shaped(golden()["nodeRuntime"]["version"].as_str().unwrap()));
        let tokens = mixdog_rt::testing::tokens();
        let manager = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
        let processes = Processes::new(manager, tokens.durability_io);
        let interpreter = JsInterpreter { program: PathBuf::from("node"), electron: false };
        let version = probe_version(&processes, &interpreter, &std::env::temp_dir()).await.unwrap();
        assert!(shaped(&version), "{version}");
    }
}