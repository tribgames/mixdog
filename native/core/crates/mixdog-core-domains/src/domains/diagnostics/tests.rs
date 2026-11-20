//! `goldens/doctor.json` is what `runDoctorChecks` and `formatDoctorReport` of the 1.4.5
//! daemon answered (`tools/gen-doctor-golden.mjs`) for scripted runtimes over scripted data
//! folders; the same status contracts are fed to the sources here.

#![allow(clippy::disallowed_methods, reason = "test setup: builds the scripted data folders on the test thread")]

use std::sync::Mutex;

use mixdog_core_api::ids::ThreadId;

use super::*;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;

/// The status contracts a case scripts; `{"$throw": true}` fails the reader, `{"$hang": true}`
/// never answers, an absent key is a runtime without that status.
struct Scripted {
    fixture: Value,
    node: Value,
    bridges: Value,
    migration: Value,
    notices: Mutex<Vec<(Option<ThreadId>, String)>>,
}

impl Scripted {
    async fn probe(&self, key: &str) -> Probe {
        match self.fixture.get(key) {
            None => Ok(None),
            Some(v) if v.get("$throw").is_some() => Err(ProbeFailed),
            Some(v) if v.get("$hang").is_some() => std::future::pending().await,
            Some(v) => Ok(Some(v.clone())),
        }
    }
}

#[async_trait]
impl DoctorSources for Scripted {
    async fn update(&self) -> Probe {
        self.probe("update").await
    }
    async fn node_runtime(&self) -> Probe {
        Ok(Some(self.node.clone()))
    }
    async fn provider_setup(&self) -> Probe {
        self.probe("providerSetup").await
    }
    fn active_provider(&self) -> Option<String> {
        self.fixture.get("provider").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_owned)
    }
    async fn mcp_status(&self, _thread: Option<&ThreadId>) -> Probe {
        self.probe("mcpStatus").await
    }
    async fn tool_module_settings(&self) -> Probe {
        self.probe("toolModules").await
    }
    async fn recap_settings(&self) -> Probe {
        self.probe("recap").await
    }
    async fn voice_status(&self) -> Probe {
        self.probe("voice").await
    }
    async fn channel_settings(&self) -> Probe {
        self.probe("channelSettings").await
    }
    async fn channel_worker_status(&self) -> Probe {
        self.probe("channelWorker").await
    }
    async fn channel_setup(&self) -> Probe {
        self.probe("channelSetup").await
    }
    async fn skills_status(&self) -> Probe {
        self.probe("skills").await
    }
    async fn plugins_status(&self) -> Probe {
        self.probe("plugins").await
    }
    async fn hooks_status(&self) -> Probe {
        self.probe("hooks").await
    }
    async fn session_log_migration(&self) -> Probe {
        Ok(Some(self.migration.clone()))
    }
    fn bridge_active(&self, id: &str) -> bool {
        self.bridges[id].as_bool().unwrap()
    }
    async fn notice(&self, thread: Option<&ThreadId>, text: &str) {
        self.notices.lock().unwrap().push((thread.cloned(), text.to_owned()));
    }
}

/// The data folder the generator built for `layout`.
fn layout(dir: &std::path::Path, layout: &str) {
    match layout {
        "ok" => {
            std::fs::write(dir.join("mixdog-config.json"), "{}").unwrap();
            for name in ["a.log", "b.log", "c.txt"] {
                std::fs::write(dir.join(name), "").unwrap();
            }
            std::fs::create_dir(dir.join("dir.log")).unwrap();
        }
        "broken" => std::fs::write(dir.join("mixdog-config.json"), "[1]").unwrap(),
        "many" => {
            std::fs::write(dir.join("mixdog-config.json"), "{").unwrap();
            for i in 0..301 {
                std::fs::write(dir.join(format!("p{i}.log")), "").unwrap();
            }
        }
        _ => {}
    }
}

struct Rig {
    service: Arc<DiagnosticsService>,
    sources: Arc<Scripted>,
    _data: tempfile::TempDir,
    _state: tempfile::TempDir,
}

/// The script runtime's version is known only from the install's metadata: absent it, the row
/// says so; a known version is judged against the package's requirement.
#[test]
fn the_node_row_reads_the_runtime_metadata() {
    let row = |node: Value| {
        let verdict = report_node(&node).expect("the node row is a verdict");
        (verdict.level, verdict.detail)
    };
    let unknown = "Node.js script runtime version unavailable";
    for node in [json!({ "version": null, "engines": "^22.19.0 || >=24.0.0" }), json!({ "engines": ">=22.0.0" })] {
        let (level, detail) = row(node);
        assert!(level == Level::Warn);
        assert_eq!(detail, unknown);
    }
    let (level, detail) = row(json!({ "version": "22.20.0", "engines": "^22.19.0 || >=24.0.0" }));
    assert!(level == Level::Ok);
    assert_eq!(detail, "v22.20.0 · requires node ^22.19.0 || >=24.0.0");
    let (level, _) = row(json!({ "version": "20.1.0", "engines": ">=22.0.0" }));
    assert!(level == Level::Fail);
    let (level, detail) = row(json!({ "version": "22.20.0", "engines": null }));
    assert!(level == Level::Warn);
    assert_eq!(detail, "v22.20.0 · engine requirement unavailable");
}

/// The session-log row also answers what the upgrade carried over after the session conversion, a step not yet recorded as pending;
/// a status without that field (a core that records none) reads as before.
#[test]
fn the_session_log_row_shows_the_upgrade_steps_when_the_core_gives_them() {
    let base = json!({ "complete": true, "started": true, "logs": 3, "pending": 0, "skipped": [] });
    let plain = session_log_row(&base).expect("a row").detail;
    assert_eq!(plain, "complete · 3 session logs");
    for steps in ["legacyRoutines: schedules=11,webhooks=0,kept=0", "legacyRoutines: pending", "unreadable (state store)"] {
        let mut status = base.clone();
        status["upgradeSteps"] = json!(steps);
        assert_eq!(session_log_row(&status).expect("a row").detail, format!("{plain} · upgrade steps: {steps}"));
    }
    let fresh = json!({ "complete": false, "started": false, "logs": 0, "pending": 0, "skipped": [], "upgradeSteps": "legacyRoutines: none" });
    assert_eq!(session_log_row(&fresh).expect("a row").detail, "nothing to migrate · upgrade steps: legacyRoutines: none");
}

/// In the packaged desktop the update row names the desktop app as the installer instead of offering `/update` (and says
/// "ok": the user has nothing to run); elsewhere it is Node's row.
#[test]
fn the_update_row_names_the_desktop_app_where_it_installs_updates() {
    let mut update = json!({ "currentVersion": "1.5.0", "latestVersion": "1.5.1", "updateAvailable": true });
    let row = report_update(None, &update).expect("a row");
    assert!(row.level == Level::Warn);
    assert_eq!(row.detail, "v1.5.0 · update available → v1.5.1");
    assert!(row.fix.is_some(), "the CLI row offers /update");

    update["managedBy"] = json!("desktop");
    let row = report_update(None, &update).expect("a row");
    assert!(row.level == Level::Ok);
    assert_eq!(row.detail, "v1.5.0 · update available → v1.5.1 · installed by the Mixdog desktop app");
    assert!(row.fix.is_none(), "no /update command: the desktop's updater is the only path");
    update["updateAvailable"] = json!(false);
    assert_eq!(report_update(None, &update).expect("a row").detail, "v1.5.0 · up to date · updates are installed by the Mixdog desktop app");
}

/// The migration's own counts follow the row: all quiet is an ok row; data quarantined unexpectedly makes it a warning that
/// names the folder; a record that cannot be read is a warning too.
#[test]
fn the_session_log_row_shows_the_migration_counts_and_warns_on_quarantined_data() {
    let base = json!({ "complete": true, "started": true, "logs": 3, "pending": 0, "skipped": [] });
    let counts = |unexpected: u64| json!({ "verified": 40, "quarantinedExpected": 1, "quarantinedUnexpected": unexpected, "retired": 7, "retained": 2, "dangling": 0, "quarantineDir": "C:/data/quarantine" });
    let mut quiet = base.clone();
    quiet["migration"] = counts(0);
    let row = session_log_row(&quiet).expect("a row");
    assert!(row.level == Level::Ok);
    // Expected quarantine is named with its folder too, and is not a warning.
    assert_eq!(
        row.detail,
        "complete · 3 session logs · migration: 40 verified, 7 retired, 2 retained, 0 dangling, 1 quarantined as expected, 0 quarantined unexpectedly (moved aside to C:/data/quarantine, each with its reason.json)"
    );

    let mut nothing = base.clone();
    nothing["migration"] = json!({ "verified": 40, "quarantinedExpected": 0, "quarantinedUnexpected": 0, "retired": 7, "retained": 2, "dangling": 0 });
    let row = session_log_row(&nothing).expect("a row");
    assert!(row.level == Level::Ok);
    assert!(!row.detail.contains("moved aside"), "{}", row.detail);

    let mut hurt = base.clone();
    hurt["migration"] = counts(3);
    let row = session_log_row(&hurt).expect("a row");
    assert!(row.level == Level::Warn);
    assert!(row.detail.ends_with("3 quarantined unexpectedly (moved aside to C:/data/quarantine, each with its reason.json)"), "{}", row.detail);

    let mut unreadable = base;
    unreadable["migration"] = json!({ "unreadable": true });
    let row = session_log_row(&unreadable).expect("a row");
    assert!(row.level == Level::Warn);
    assert!(row.detail.ends_with("migration record: unreadable"));
}

/// The data-folder row asks the folder, not its attribute: a folder that takes a file reads writable and keeps nothing of the
/// probe; a path that is not a folder (which `readonly()` called writable) is not.
#[test]
fn the_data_folder_row_probes_whether_a_file_can_be_created() {
    let dir = tempfile::tempdir().unwrap();
    assert!(folder_accepts_a_file(dir.path(), &CancellationToken::new()));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "the probe left a file behind");
    assert!(data_folder(dir.path(), &CancellationToken::new()).unwrap().level == Level::Ok);

    let file = dir.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    assert!(data_folder(&file, &CancellationToken::new()).unwrap().level == Level::Fail);
    assert!(!folder_accepts_a_file(&dir.path().join("missing"), &CancellationToken::new()));
    assert!(data_folder(&dir.path().join("missing"), &CancellationToken::new()).unwrap().level == Level::Fail);
}

/// "Writable" means the file was created and removed: a probe whose removal fails is not writable, and a check that has ended
/// creates nothing.
#[test]
fn a_probe_whose_removal_fails_or_whose_check_ended_is_not_writable() {
    let dir = tempfile::tempdir().unwrap();
    let live = CancellationToken::new();
    assert!(!folder_accepts_a_file_with(dir.path(), &live, |_| Err(std::io::Error::other("busy"))));
    let ended = CancellationToken::new();
    ended.cancel();
    let clean = tempfile::tempdir().unwrap();
    assert!(!folder_accepts_a_file(clean.path(), &ended));
    assert_eq!(std::fs::read_dir(clean.path()).unwrap().count(), 0);
}

/// Each probe has a file of its own: a file an earlier probe could not remove does not fail the next one, and probes that run at
/// the same time in one folder both read writable.
#[test]
fn a_leftover_probe_file_and_concurrent_probes_do_not_decide_each_others_answer() {
    let dir = tempfile::tempdir().unwrap();
    let live = CancellationToken::new();
    assert!(!folder_accepts_a_file_with(dir.path(), &live, |_| Err(std::io::Error::other("busy"))));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "the failed removal left its file");
    assert!(folder_accepts_a_file(dir.path(), &live), "the leftover made the next probe fail");

    let barrier = std::sync::Barrier::new(8);
    let answers: Vec<bool> = std::thread::scope(|scope| {
        let probes: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    (0..20).all(|_| folder_accepts_a_file(dir.path(), &live))
                })
            })
            .collect();
        probes.into_iter().map(|probe| probe.join().unwrap()).collect()
    });
    assert!(answers.iter().all(|writable| *writable), "a concurrent probe read not writable: {answers:?}");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "only the leftover of the failed removal remains");
}

async fn rig(golden: &Value, case: &Value) -> Rig {
    let data = tempfile::tempdir().unwrap();
    layout(data.path(), case["layout"].as_str().unwrap());
    let state = tempfile::tempdir().unwrap();
    let sources = Arc::new(Scripted {
        fixture: case["fixture"].clone(),
        node: golden["node"].clone(),
        bridges: golden["bridges"].clone(),
        migration: case["migration"].clone(),
        notices: Mutex::new(Vec::new()),
    });
    let service = DiagnosticsService::new(
        sources.clone(),
        DoctorConfig {
            data_dir: data.path().to_owned(),
            package_version: golden["packageVersion"].as_str().map(str::to_owned),
            check_timeout: Duration::from_millis(case["timeoutMs"].as_u64().unwrap()),
        },
        scopes(state.path(), "diagnostics").await,
        &mixdog_rt::testing::tokens(),
    );
    Rig { service, sources, _data: data, _state: state }
}

/// A healthy install: scripted runtime statuses with nothing to report beyond the data folder and the config.
fn healthy() -> (Value, Value) {
    let golden = json!({ "node": { "version": "22.20.0", "engines": ">=22.0.0" }, "bridges": {}, "packageVersion": "1.5.0" });
    let case = json!({
        "layout": "ok",
        "fixture": {},
        "migration": { "complete": true, "started": true, "logs": 3, "pending": 0, "skipped": [] },
        "timeoutMs": 1000,
    });
    (golden, case)
}

#[tokio::test]
async fn the_text_report_is_a_notice_only_when_asked_and_a_second_run_is_busy() {
    let (golden, case) = healthy();
    let rig = rig(&golden, &case).await;
    value(&*rig.service, request("diagnostics/runDoctor", with_op(json!({}), 1), Some(1))).await.unwrap();
    assert!(rig.sources.notices.lock().unwrap().is_empty());
    let params = with_op(json!({ "threadId": "th-1", "options": { "notice": true } }), 2);
    value(&*rig.service, request("diagnostics/runDoctor", params, Some(2))).await.unwrap();
    {
        let notices = rig.sources.notices.lock().unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].0, Some(ThreadId::from("th-1")));
        assert!(notices[0].1.contains("Data folder") || notices[0].1.contains("data"), "{}", notices[0].1);
    }

    rig.service.running.store(true, AtomicOrdering::SeqCst);
    let busy = value(&*rig.service, request("diagnostics/runDoctor", with_op(json!({}), 3), Some(3))).await.unwrap();
    assert_eq!(busy, json!({ "busy": true }));
}
#[tokio::test]
async fn a_repeated_op_runs_the_checks_once() {
    let (golden, case) = healthy();
    let rig = rig(&golden, &case).await;
    let params = with_op(json!({ "options": { "notice": true } }), 5);
    let first = value(&*rig.service, request("diagnostics/runDoctor", params.clone(), Some(5))).await.unwrap();
    let again = value(&*rig.service, request("diagnostics/runDoctor", params, Some(5))).await.unwrap();
    assert_eq!(first, again);
    assert_eq!(rig.sources.notices.lock().unwrap().len(), 1);
}
