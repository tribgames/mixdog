//! `doctor`: the statuses of `/doctor` that no domain answers (`tui/app/doctor.mjs` check table).
//! Each asks the service Node asks: the Node runtime retained for user scripts, the provider setup, the route, the channel
//! worker and setup, the hook bus, the session-log migration, the bridge files and the live
//! session surface.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

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

/// `runtime.hooksStatus()`: the hook bus's `status()`.
#[async_trait]
pub trait HooksStatus: Send + Sync {
    async fn status(&self) -> Value;
}

/// The script interpreter the install runs user scripts with; doctor asks it for its version on every check
/// (Node's `process.versions.node`), so a removed or replaced interpreter shows as it is now.
#[derive(Debug, Clone)]
pub struct ScriptRuntime {
    pub program: PathBuf,
    /// The program is an Electron binary that needs node mode.
    pub electron: bool,
}

pub struct DoctorInputs {
    pub data_dir: PathBuf,
    pub runtime: ScriptRuntime,
    /// The installed package whose engines.node defines the requirement.
    pub package_root: PathBuf,
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

/// Keep the reference {version, engines} shape; null version means metadata is unavailable.
fn runtime_row(version: Option<String>, engines: Option<String>) -> Value {
    let version = version.filter(|version| !version.trim().is_empty());
    json!({ "version": version, "engines": engines })
}

/// Read the installed package requirement without executing any product JavaScript.
async fn read_engines(io: InteractiveIo, package_root: &Path) -> Result<Option<String>, ProbeFailed> {
    let path = package_root.join("package.json");
    let bytes = on_lane(io, &CancellationToken::new(), move |_lane| read_content(&path)).await.map_err(|_| ProbeFailed)?;
    let Ok(Some(bytes)) = bytes else { return Ok(None) };
    let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Ok(parsed.get("engines").and_then(|e| e.get("node")).and_then(Value::as_str).map(str::to_owned))
}

/// `readMigrationProgress`: the progress record, a fresh one when the file is missing; `Err`
/// when the file is not a progress record (its skips are never guessed).
type MigrationProgress = (bool, i64, Vec<(String, String)>);

fn read_progress(path: &Path) -> Result<MigrationProgress, ()> {
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
        .map(|rows| rows.iter().map(|(id, skip)| (id.clone(), skip.get("reason").and_then(Value::as_str).unwrap_or_default().to_owned())).collect())
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
    let permanent: std::collections::HashSet<&str> = skipped.iter().filter(|(_, reason)| reason != SKIP_BUSY).map(|(id, _)| id.as_str()).collect();
    let pending = legacy_ids_without_log(&names).iter().filter(|id| !permanent.contains(id.as_str())).count();
    let logs = names.iter().filter(|name| name.ends_with(SESSION_LOG_SUFFIX)).count();
    let skipped: Vec<Value> = skipped.iter().map(|(id, reason)| json!({ "id": id, "reason": reason })).collect();
    Ok(json!({ "complete": complete, "started": started > 0, "logs": logs, "pending": pending, "skipped": skipped }))
}

/// The session-log status with the upgrade's post-conversion steps beside it (`migration:` markers of the state store, one read,
/// no PostgreSQL): the doctor row shows them, so what the upgrade carried over is asked here after boot. A store that cannot be read
/// says so in the row instead of leaving the steps out.
fn with_upgrade_steps<E: std::fmt::Display>(mut status: Value, steps: Result<String, E>) -> Value {
    let line = steps.unwrap_or_else(|error| format!("unreadable ({error})"));
    if let Some(object) = status.as_object_mut() {
        object.insert("upgradeSteps".to_owned(), Value::String(line));
    }
    status
}

/// The counts of `<data>/migration/complete.json` (the two groups summed), as the doctor row's `migration` field. `None` when the
/// folder holds no such record (a fresh install, or a migration that has not completed: the row says nothing of it); a record that
/// cannot be read is `{unreadable: true}`. `quarantineDir` is named whenever anything was quarantined, expected or unexpected.
fn migration_counts(data_dir: &Path) -> Option<Value> {
    let path = data_dir.join(mixdog_store::schema::migration::COMPLETE_PATH);
    let bytes = match read_content(&path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return None,
        Err(_) => return Some(json!({ "unreadable": true })),
    };
    let Ok(complete) = serde_json::from_slice::<mixdog_store::schema::migration::Complete>(&bytes) else {
        return Some(json!({ "unreadable": true }));
    };
    let (data, profile) = (complete.kinds.data, complete.kinds.desktop_profile);
    let unexpected = data.quarantined_unexpected + profile.quarantined_unexpected;
    let mut counts = json!({
        "verified": data.verified + profile.verified,
        "quarantinedExpected": data.quarantined_expected + profile.quarantined_expected,
        "quarantinedUnexpected": unexpected,
        "retired": data.retired + profile.retired,
        "retained": data.retained + profile.retained,
        "dangling": data.dangling + profile.dangling,
    });
    let summary = crate::boot::quarantine_summary(data_dir);
    let total_aside = (unexpected + data.quarantined_expected + profile.quarantined_expected).max(summary.total_reasons);
    // Named whenever anything was set aside, expected or not; the warning level is the row's, tied to the unexpected count.
    if total_aside > 0 {
        counts["quarantineDir"] = Value::String(data_dir.join(mixdog_store::schema::migration::QUARANTINE_DIR).display().to_string());
    }
    if !summary.in_place_files.is_empty() {
        counts["movedAside"] = json!(total_aside.saturating_sub(summary.in_place_items));
        counts["keptInPlace"] = json!(summary.in_place_files);
    }
    Some(counts)
}

/// The session-log status with the migration's counts beside it, when the folder has them.
fn with_migration_counts(mut status: Value, migration: Option<Value>) -> Value {
    if let (Some(object), Some(migration)) = (status.as_object_mut(), migration) {
        object.insert("migration".to_owned(), migration);
    }
    status
}

/// What `program` reports as `process.versions.node` right now; `None` when it cannot be run or prints nothing.
///
/// The probe's life ends with the check, and nothing it started outlives it: the child runs in its own job object (Windows) or
/// process group (Unix) ([`mixdog_mcp::containment::Containment`]), and that whole tree is ended when the child has exited and
/// when `cancel` fires (the check gave up: its own deadline ends it), so a hung interpreter or a descendant it left holding a
/// handle leaves neither a process nor a job behind. The child writes to a file, never a pipe: the probe reads the file after
/// the tree is ended, so no handle a descendant holds can block it. It has no limit of its own.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "one short version probe, run only as a lane job")]
fn probe_version(runtime: &ScriptRuntime, cancel: &CancellationToken) -> Option<String> {
    if cancel.is_cancelled() {
        return None;
    }
    let output = std::env::temp_dir().join(format!("mixdog-doctor-node-{}.out", uuid::Uuid::now_v7()));
    let version = run_probe(runtime, cancel, &output);
    let _ = std::fs::remove_file(&output);
    version
}
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "one short version probe, run only as a lane job")]
fn run_probe(runtime: &ScriptRuntime, cancel: &CancellationToken, output: &Path) -> Option<String> {
    let mut command = std::process::Command::new(&runtime.program);
    if runtime.electron {
        command.env("ELECTRON_RUN_AS_NODE", "1");
    }
    command
        .args(["-p", "process.versions.node"])
        .stdin(std::process::Stdio::null())
        .stdout(std::fs::File::create_new(output).ok()?)
        .stderr(std::process::Stdio::null());
    // The child leads its own group; on Windows it starts suspended (and without a window) so it joins its job before it runs.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000 | 0x0000_0004);
    let mut child = command.spawn().ok()?;
    let tree = match mixdog_mcp::containment::Containment::attach_std(&child) {
        Ok(tree) => tree,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if !cancel.is_cancelled() => std::thread::sleep(std::time::Duration::from_millis(20)),
            _ => break None,
        }
    };
    // The group's id stays valid while any member lives, and the tree is ended at once.
    tree.terminate();
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(tree);
    if !status?.success() {
        return None;
    }
    let version = std::fs::read_to_string(output).ok()?.trim().to_owned();
    (!version.is_empty()).then_some(version)
}
#[async_trait]
impl DoctorHost for DaemonDoctorHost {
    async fn node_runtime(&self) -> Probe {
        let engines = read_engines(self.inputs.io, &self.inputs.package_root).await?;
        let runtime = self.inputs.runtime.clone();
        // Dropped with this future (the check's deadline), the token tells the running probe to kill its child and end.
        let cancel = CancellationToken::new();
        let _ends_with_the_check = cancel.clone().drop_guard();
        let probe_cancel = cancel.clone();
        let version = on_lane(self.inputs.io, &cancel, move |_lane| probe_version(&runtime, &probe_cancel)).await.map_err(|_| ProbeFailed)?;
        Ok(Some(runtime_row(version, engines)))
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
        let status = on_lane(self.inputs.io, &CancellationToken::new(), move |lane| {
            let status = session_log_status(&data_dir, lane)?;
            let status = with_migration_counts(status, migration_counts(&data_dir));
            Ok::<_, std::io::Error>(with_upgrade_steps(status, mixdog_migrate::post_upgrade::read_report(&data_dir).map(|report| report.steps_line())))
        })
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
    use serde_json::Value;

    const ENGINES: &str = "^22.19.0 || >=24.0.0";

    #[test]
    fn runtime_metadata_keeps_nodes_version_and_requirement_shape() {
        assert_eq!(runtime_row(Some("22.20.0".to_owned()), Some(ENGINES.to_owned())), json!({ "version": "22.20.0", "engines": ENGINES }));
        for version in [None, Some(String::new()), Some("  ".to_owned())] {
            assert_eq!(runtime_row(version, Some(">=22".into())), json!({ "version": null, "engines": ">=22" }));
        }
    }

    fn write_complete(data: &Path, text: &str) {
        let migration = data.join("migration");
        std::fs::create_dir_all(&migration).unwrap();
        std::fs::write(migration.join("complete.json"), text).unwrap();
    }

    const COMPLETE: &str = r#"{"format":1,"manifest_sha256":"aa","journal_end_ordinal":9,"kinds":{"data":{"verified":40,"quarantined_expected":1,"quarantined_unexpected":2,"retired":7,"retained":2,"dangling":0},"desktopProfile":{"verified":5,"quarantined_expected":0,"quarantined_unexpected":1,"retired":1,"retained":0,"dangling":3}}}"#;

    /// The doctor's migration row gets the counts of `complete.json` (the two groups summed) and, when data was quarantined
    /// unexpectedly, the folder it is in; no record says nothing, and a record that does not parse says so.
    #[test]
    fn the_migration_counts_come_from_complete_json_and_name_the_quarantine_folder_when_data_is_in_it() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(migration_counts(dir.path()), None, "a fresh install has no record");

        write_complete(dir.path(), COMPLETE);
        let counts = migration_counts(dir.path()).unwrap();
        assert_eq!(
            (counts["verified"].as_u64(), counts["quarantinedUnexpected"].as_u64(), counts["quarantinedExpected"].as_u64()),
            (Some(45), Some(3), Some(1))
        );
        assert_eq!((counts["retired"].as_u64(), counts["retained"].as_u64(), counts["dangling"].as_u64()), (Some(8), Some(2), Some(3)));
        assert_eq!(counts["quarantineDir"], dir.path().join("quarantine").display().to_string());

        write_complete(
            dir.path(),
            &COMPLETE
                .replace("\"quarantined_unexpected\":2", "\"quarantined_unexpected\":0")
                .replace("\"quarantined_unexpected\":1", "\"quarantined_unexpected\":0"),
        );
        let expected_only = migration_counts(dir.path()).unwrap();
        assert_eq!(expected_only["quarantinedUnexpected"], 0);
        assert_eq!(expected_only["quarantineDir"], dir.path().join("quarantine").display().to_string(), "expected quarantine is in the folder too");

        write_complete(
            dir.path(),
            &COMPLETE
                .replace("\"quarantined_unexpected\":2", "\"quarantined_unexpected\":0")
                .replace("\"quarantined_unexpected\":1", "\"quarantined_unexpected\":0")
                .replace("\"quarantined_expected\":1", "\"quarantined_expected\":0"),
        );
        assert!(migration_counts(dir.path()).unwrap().get("quarantineDir").is_none(), "no folder is named when nothing is in it");

        write_complete(dir.path(), "{ not json");
        assert_eq!(migration_counts(dir.path()), Some(json!({ "unreadable": true })));

        let status = json!({ "complete": true });
        assert_eq!(with_migration_counts(status.clone(), None), status);
        assert_eq!(with_migration_counts(status, Some(json!({ "verified": 1 })))["migration"]["verified"], 1);
    }

    /// Data folders of the 1.4.5 layout and the status each reads as (a progress file that is not a record reads `{unreadable: true}`).
    fn session_log_cases() -> Value {
        json!([
            {"name": "nothing", "files": {}, "status": {"complete": false, "started": false, "logs": 0, "pending": 0, "skipped": []}},
            {"name": "no-progress-legacy-pending", "files": {"sessions/a.json": "{}", "sessions/b.json": "{}"},
             "status": {"complete": false, "started": false, "logs": 0, "pending": 2, "skipped": []}},
            {"name": "complete",
             "files": {"session-log-migration.json": r#"{"v":1,"migrationId":"json-to-log-v1","cursor":null,"complete":true,"updatedAt":5,"skipped":{}}"#,
                       "sessions/a.log.jsonl": "", "sessions/b.log.jsonl": ""},
             "status": {"complete": true, "started": true, "logs": 2, "pending": 0, "skipped": []}},
            {"name": "skips",
             "files": {"session-log-migration.json": r#"{"v":1,"migrationId":"json-to-log-v1","cursor":null,"complete":false,"updatedAt":5,"skipped":{"a":{"reason":"unreadable"},"b":{"reason":"busy"},"z9":{"reason":"failed"}}}"#,
                       "sessions/a.json": "{}", "sessions/b.json": "{}", "sessions/c.json": "{}", "sessions/c.log.jsonl": "", "sessions/d.json": "{}",
                       "sessions/bad name.json": "{}", "sessions/e.log.jsonl.torn-1-ab": "", "sessions/note.txt": ""},
             "status": {"complete": false, "started": true, "logs": 1, "pending": 2,
                        "skipped": [{"id": "a", "reason": "unreadable"}, {"id": "b", "reason": "busy"}, {"id": "z9", "reason": "failed"}]}},
            {"name": "never-started",
             "files": {"session-log-migration.json": r#"{"v":1,"migrationId":"json-to-log-v1","cursor":null,"complete":false,"updatedAt":0,"skipped":{}}"#, "sessions/a.json": "{}"},
             "status": {"complete": false, "started": false, "logs": 0, "pending": 1, "skipped": []}},
            {"name": "wrong-version", "files": {"session-log-migration.json": r#"{"v":2}"#}, "status": {"unreadable": true}},
            {"name": "not-json", "files": {"session-log-migration.json": "{broken"}, "status": {"unreadable": true}},
            {"name": "wrong-id",
             "files": {"session-log-migration.json": r#"{"v":1,"migrationId":"other","cursor":null,"complete":false,"updatedAt":5,"skipped":{}}"#},
             "status": {"unreadable": true}}
        ])
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_session_log_status_reads_each_folder_layout() {
        for case in session_log_cases().as_array().unwrap() {
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
    /// The row's version is what the interpreter prints now: a replaced interpreter changes it, a removed one reads as unknown.
    #[test]
    fn the_version_is_probed_from_the_interpreter_not_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let (name, body) = if cfg!(windows) { ("node.cmd", "@echo 18.0.1\r\n") } else { ("node", "#!/bin/sh\necho 18.0.1\n") };
        let program = dir.path().join(name);
        std::fs::write(&program, body).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&program, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let runtime = ScriptRuntime { program: program.clone(), electron: false };
        let live = CancellationToken::new();
        assert_eq!(probe_version(&runtime, &live).as_deref(), Some("18.0.1"));
        std::fs::write(&program, body.replace("18.0.1", "22.3.0")).unwrap();
        assert_eq!(probe_version(&runtime, &live).as_deref(), Some("22.3.0"));
        std::fs::remove_file(&program).unwrap();
        assert_eq!(probe_version(&runtime, &live), None);
    }
    /// A hung interpreter is killed when the check ends: the probe returns at the cancel, and the child never gets to its marker.
    #[test]
    fn a_hung_interpreter_is_killed_when_the_check_ends() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let (name, body) = if cfg!(windows) {
            ("node.cmd", format!("@ping -n 5 127.0.0.1 >nul\r\n@echo x> \"{}\"\r\n", marker.display()))
        } else {
            ("node", format!("#!/bin/sh\nsleep 4\ntouch '{}'\n", marker.display()))
        };
        let program = dir.path().join(name);
        std::fs::write(&program, body).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&program, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let runtime = ScriptRuntime { program, electron: false };
        let cancel = CancellationToken::new();
        let ending = cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            ending.cancel();
        });
        let started = std::time::Instant::now();
        assert_eq!(probe_version(&runtime, &cancel), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "the probe outlived its check");
        canceller.join().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(6));
        assert!(!marker.exists(), "the interpreter kept running after the check ended");
    }
    /// An interpreter that starts a descendant holding its stdout and exits: the probe still returns the version at once (it never
    /// waits on a pipe the descendant holds), and the descendant is ended with the probe, so it never reaches its marker.
    #[test]
    fn a_descendant_holding_stdout_is_ended_and_does_not_hold_the_probe() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let (name, body) = if cfg!(windows) {
            (
                "node.cmd",
                format!(
                    "@start \"\" /b powershell -NoProfile -Command \"Start-Sleep 4; Set-Content -Path '{}' -Value x\"\r\n@echo 18.0.1\r\n",
                    marker.display()
                ),
            )
        } else {
            ("node", format!("#!/bin/sh\n(sleep 4; touch '{}') &\necho 18.0.1\n", marker.display()))
        };
        let program = dir.path().join(name);
        std::fs::write(&program, body).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&program, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let runtime = ScriptRuntime { program, electron: false };
        let started = std::time::Instant::now();
        assert_eq!(probe_version(&runtime, &CancellationToken::new()).as_deref(), Some("18.0.1"));
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "the probe waited for the descendant");
        std::thread::sleep(std::time::Duration::from_secs(7));
        assert!(!marker.exists(), "the descendant outlived the probe");
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn the_engine_requirement_is_the_package_jsons() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("package.json"), json!({ "name": "mixdog", "version": "1.4.5", "engines": { "node": ENGINES } }).to_string()).unwrap();
        let io = mixdog_rt::testing::tokens().interactive_io;
        assert_eq!(read_engines(io, dir.path()).await.unwrap().as_deref(), Some(ENGINES));
        std::fs::write(dir.path().join("package.json"), "not json").unwrap();
        assert_eq!(read_engines(io, dir.path()).await.unwrap(), None);
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(read_engines(io, empty.path()).await.unwrap(), None);
    }
    /// The doctor's migration row carries the upgrade's step report: what the store recorded, `pending` for a step not recorded, and
    /// the read error in its place when the store cannot be read. The session-log status itself is untouched.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_session_log_status_carries_the_upgrade_steps() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        let line = |data: &Path| mixdog_migrate::post_upgrade::read_report(data).map(|report| report.steps_line());
        let status = json!({ "complete": true, "started": true, "logs": 0, "pending": 0, "skipped": [] });

        // No state database yet: nothing is recorded, so the step is pending.
        let shown = with_upgrade_steps(status.clone(), line(dir.path()));
        assert_eq!(shown["upgradeSteps"], "legacyRoutines: pending; legacyDeliveries: pending");
        assert_eq!(shown["complete"], true);

        let tokens = mixdog_rt::testing::tokens();
        let store = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &state.join("core.sqlite")).unwrap().0;
        store.write(|tx| tx.put_meta("migration:legacyRoutines", "schedules=11,webhooks=0,kept=0,skipped=0")).await.unwrap();
        assert_eq!(
            with_upgrade_steps(status.clone(), line(dir.path()))["upgradeSteps"],
            "legacyRoutines: schedules=11,webhooks=0,kept=0,skipped=0; legacyDeliveries: pending"
        );

        assert_eq!(with_upgrade_steps(status, Err::<String, _>("locked"))["upgradeSteps"], "unreadable (locked)");
    }
}
