//! `goldens/update.json` is what `compareSemver` and `checkLatestVersion` of the 1.4.5 daemon
//! answered (`tools/gen-update-golden.mjs`, with a stubbed registry); the controller's
//! install path runs against a scripted installer.

#![allow(clippy::disallowed_methods, reason = "test setup: seeds and inspects the cache files on the test thread")]

use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering as AtomicOrdering;

use mixdog_core_api::mock::MockHostChannel;
use tokio::sync::Notify;

use super::*;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::scopes;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;

/// What a scripted registry answers: each request takes the next entry, the last one repeats.
struct Script {
    answers: Vec<(u16, &'static str)>,
    hits: Arc<AtomicUsize>,
}

/// The registries tests script, by URL. The fake client answers from here; nothing reaches a network.
static SCRIPTS: std::sync::LazyLock<Mutex<HashMap<String, Script>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_REGISTRY: AtomicUsize = AtomicUsize::new(0);

struct FakeRegistry;

#[async_trait]
impl RegistryHttp for FakeRegistry {
    async fn get(&self, url: &str) -> Option<RegistryAnswer> {
        let scripts = SCRIPTS.lock().unwrap();
        let script = scripts.get(url)?;
        let at = script.hits.fetch_add(1, AtomicOrdering::SeqCst).min(script.answers.len() - 1);
        let (status, body) = script.answers[at];
        Some(RegistryAnswer { success: (200..300).contains(&status), body: body.as_bytes().to_vec() })
    }
}

fn script(answers: Vec<(u16, &'static str)>) -> (String, Arc<AtomicUsize>) {
    let url = format!("fake://registry/{}/mixdog/latest", NEXT_REGISTRY.fetch_add(1, AtomicOrdering::SeqCst));
    let hits = Arc::new(AtomicUsize::new(0));
    SCRIPTS.lock().unwrap().insert(url.clone(), Script { answers, hits: hits.clone() });
    (url, hits)
}

/// A registry that answers with the status and body.
fn registry(status: u16, body: &'static str) -> (String, Arc<AtomicUsize>) {
    script(vec![(status, body)])
}

/// A registry nothing answers: the request fails.
fn closed() -> String {
    "fake://registry/closed/mixdog/latest".to_owned()
}

struct Installer {
    dev: bool,
    /// The packaged desktop's core (`managed_by_desktop`).
    desktop: bool,
    outcome: Result<Option<String>, String>,
    staged: Mutex<Vec<String>>,
    gate: Option<Arc<Notify>>,
    started: Arc<Notify>,
}

impl Installer {
    fn new(outcome: Result<Option<String>, String>) -> Arc<Self> {
        Arc::new(Self { dev: false, desktop: false, outcome, staged: Mutex::new(Vec::new()), gate: None, started: Arc::new(Notify::new()) })
    }
}

#[async_trait]
impl UpdateInstaller for Installer {
    fn is_dev_install(&self) -> bool {
        self.dev
    }

    fn managed_by_desktop(&self) -> bool {
        self.desktop
    }

    async fn stage(&self, version: &str) -> Result<Option<String>, String> {
        self.staged.lock().unwrap().push(version.to_owned());
        self.started.notify_one();
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        self.outcome.clone()
    }

    /// Staged once a stage call succeeded.
    async fn is_staged(&self, version: &str) -> bool {
        self.outcome.is_ok() && self.staged.lock().unwrap().iter().any(|staged| staged == version)
    }
}

struct Rig {
    service: Arc<UpdateService>,
    host: Arc<MockHostChannel>,
    _dir: tempfile::TempDir,
    /// The versions the "update ready" notice was sent for.
    notices: Arc<Mutex<Vec<String>>>,
}

async fn rig(registry_url: String, installer: Arc<Installer>, current: &str) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let host = Arc::new(MockHostChannel::default());
    let tokens = mixdog_rt::testing::tokens();
    let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, b"{\"agent\":{}}").unwrap();
    let (config, _) = mixdog_core_config::config::Config::open(path, Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.unwrap();
    let settings = mixdog_core_config::config::Settings::new(config.clone(), Arc::new(mixdog_core_config::config::NoEffects), Arc::new(|_| None));
    let notices = Arc::new(Mutex::new(Vec::new()));
    let service = UpdateService::new(
        UpdateConfig {
            current_version: current.into(),
            registry_url,
            registry: Arc::new(FakeRegistry),
            ready_notice: {
                let notices = notices.clone();
                Arc::new(move |version: &str| notices.lock().unwrap().push(version.to_owned()))
            },
            data_dir: dir.path().to_owned(),
            // `autoUpdateEnabled()`: `config.update.auto !== false`.
            auto_update: Arc::new(move || config.agent().get("update").and_then(|u| u.get("auto")) != Some(&json!(false))),
            auto_switch: Arc::new(settings),
        },
        installer,
        host.clone(),
        scopes(dir.path(), "update").await,
        {
            let own = dir.path().join("config-scope");
            std::fs::create_dir(&own).unwrap();
            scopes(&own, "config").await
        },
        &mixdog_rt::testing::tokens(),
    );
    Rig { service, host, _dir: dir, notices }
}

fn cancel() -> mixdog_rt::CancellationToken {
    mixdog_rt::CancellationToken::new()
}

trait Pipe: Sized {
    fn pipe<R>(self, f: impl FnOnce(Self) -> R) -> R {
        f(self)
    }
}
impl<T> Pipe for T {}

async fn call(rig: &Rig, method: &'static str, params: Value, op: Option<u64>) -> Result<Value, CoreError> {
    let params = match op {
        Some(n) => with_op(params, n),
        None => params,
    };
    value(&*rig.service, request(method, params, op)).await
}

/// A staging that never completes is polled every 3 s for 10 min (paused time), then given up on
/// without a notice.
#[tokio::test(start_paused = true)]
async fn the_boot_check_gives_up_on_a_staging_that_never_completes() {
    let (url, _) = registry(200, r#"{"version":"9.9.9"}"#);
    let installer = Installer::new(Err("staging in progress".into()));
    let rig = rig(url, installer.clone(), "1.4.5").await;
    rig.service.start_boot_check().await.unwrap();
    assert_eq!(*installer.staged.lock().unwrap(), ["9.9.9"]);
    assert!(rig.notices.lock().unwrap().is_empty());
}

/// The packaged desktop's core still learns the latest version (the settings and the doctor row show it), but it never stages,
/// never announces "update ready", and `runUpdateNow` says who installs updates there.
#[tokio::test]
async fn the_packaged_desktop_core_never_stages_or_announces_an_update() {
    let (url, _) = registry(200, r#"{"version":"9.9.9"}"#);
    let installer =
        Arc::new(Installer { dev: false, desktop: true, outcome: Ok(None), staged: Mutex::new(Vec::new()), gate: None, started: Arc::new(Notify::new()) });
    let desktop = rig(url, installer.clone(), "1.4.5").await;
    desktop.service.start_boot_check().await.unwrap();
    assert!(installer.staged.lock().unwrap().is_empty(), "nothing is staged");
    assert!(desktop.notices.lock().unwrap().is_empty(), "no update-ready notice");
    let settings = call(&desktop, "config/getUpdateSettings", json!({}), None).await.unwrap();
    assert_eq!((settings["latestVersion"].as_str(), settings["updateAvailable"].as_bool()), (Some("9.9.9"), Some(true)));
    assert_eq!(settings["managedBy"], "desktop");
    let now = call(&desktop, "update/runUpdateNow", json!({}), Some(1)).await.unwrap();
    assert_eq!((now["ok"].as_bool(), now["error"].as_str()), (Some(false), Some(MANAGED_BY_DESKTOP)));
    assert!(installer.staged.lock().unwrap().is_empty());

    // Every other install keeps the settings' shape: no `managedBy`.
    let (url, _) = registry(200, r#"{"version":"9.9.9"}"#);
    let plain = rig(url, Installer::new(Ok(None)), "1.4.5").await;
    plain.service.start_boot_check().await.unwrap();
    assert!(call(&plain, "config/getUpdateSettings", json!({}), None).await.unwrap().get("managedBy").is_none());
}

/// `startBootCheck()`: one forced check at boot fills the settings (`latestVersion`) that a
/// read answers, and leaves the phase alone.
#[tokio::test]
async fn the_boot_check_remembers_the_latest_version() {
    let (url, hits) = registry(200, r#"{"version":"9.9.9"}"#);
    let installer = Installer::new(Ok(None));
    let rig = rig(url, installer.clone(), "1.4.5").await;
    rig.service.start_boot_check().await.unwrap();
    // `update.auto` is on and 9.9.9 is newer: it is staged in the background.
    assert_eq!(*installer.staged.lock().unwrap(), ["9.9.9"]);
    // ...and announced once, when the staging is complete.
    assert_eq!(*rig.notices.lock().unwrap(), ["9.9.9"]);
    let settings = call(&rig, "config/getUpdateSettings", json!({}), None).await.unwrap();
    assert_eq!(settings["latestVersion"], "9.9.9");
    assert_eq!(settings["updateAvailable"], true);
    assert_eq!(hits.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(call(&rig, "update/getUpdateStatus", json!({}), None).await.unwrap(), json!({ "phase": "idle", "version": null, "error": null }));
}

#[tokio::test]
async fn the_status_starts_idle_and_a_check_reports_the_update_settings() {
    let (url, hits) = registry(200, r#"{"version":"9.9.9"}"#);
    let rig = rig(url, Installer::new(Ok(None)), "1.4.5").await;
    assert_eq!(call(&rig, "update/getUpdateStatus", json!({}), None).await.unwrap(), json!({ "phase": "idle", "version": null, "error": null }));
    // Nothing is known before a check.
    let settings = call(&rig, "update/checkForUpdate", json!({ "options": { "force": true } }), Some(1)).await.unwrap();
    assert_eq!(settings["autoUpdate"], true);
    assert_eq!(settings["currentVersion"], "1.4.5");
    assert_eq!(settings["latestVersion"], "9.9.9");
    assert_eq!(settings["updateAvailable"], true);
    assert_eq!(hits.load(AtomicOrdering::SeqCst), 1);
    // The same op again changes nothing and does not ask the registry again.
    let again = call(&rig, "update/checkForUpdate", json!({ "options": { "force": true } }), Some(1)).await.unwrap();
    assert_eq!(again, settings);
    assert_eq!(hits.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(call(&rig, "update/getUpdateStatus", json!({}), None).await.unwrap()["phase"], "idle");
}

#[tokio::test]
async fn update_now_stages_the_version_a_check_found() {
    let (url, _) = registry(200, r#"{"version":"9.9.9"}"#);
    let installer = Installer::new(Ok(None));
    let rig = rig(url, installer.clone(), "1.4.5").await;
    // No check yet: nothing to install.
    let none = call(&rig, "update/runUpdateNow", json!({}), Some(1)).await.unwrap();
    assert_eq!(none, json!({ "ok": false, "phase": "idle", "version": null, "error": "no update available" }));
    call(&rig, "update/checkForUpdate", json!({ "options": { "force": true } }), Some(2)).await.unwrap();
    let done = call(&rig, "update/runUpdateNow", json!({}), Some(3)).await.unwrap();
    assert_eq!(done, json!({ "ok": true, "phase": "installed", "version": "9.9.9", "error": null }));
    assert_eq!(*installer.staged.lock().unwrap(), vec!["9.9.9".to_owned()]);
    assert_eq!(call(&rig, "update/getUpdateStatus", json!({}), None).await.unwrap(), json!({ "phase": "installed", "version": "9.9.9", "error": null }));
}

#[tokio::test]
async fn update_now_reports_a_failed_stage_and_a_dev_install() {
    let (url, _) = registry(200, r#"{"version":"9.9.9"}"#);
    let rig_failed = rig(url.clone(), Installer::new(Err("npm install exited with code 1".into())), "1.4.5").await;
    call(&rig_failed, "update/checkForUpdate", json!({ "options": { "force": true } }), Some(1)).await.unwrap();
    let failed = call(&rig_failed, "update/runUpdateNow", json!({}), Some(2)).await.unwrap();
    assert_eq!(failed, json!({ "ok": false, "phase": "failed", "version": null, "error": "npm install exited with code 1" }));
    let blank = rig(url.clone(), Installer::new(Err(String::new())), "1.4.5").await;
    call(&blank, "update/checkForUpdate", json!({ "options": { "force": true } }), Some(1)).await.unwrap();
    assert_eq!(call(&blank, "update/runUpdateNow", json!({}), Some(2)).await.unwrap()["error"], "update failed");

    let dev =
        Arc::new(Installer { dev: true, desktop: false, outcome: Ok(None), staged: Mutex::new(Vec::new()), gate: None, started: Arc::new(Notify::new()) });
    let rig_dev = rig(url, dev.clone(), "1.4.5").await;
    let refused = call(&rig_dev, "update/runUpdateNow", json!({}), Some(1)).await.unwrap();
    assert_eq!(refused, json!({ "ok": false, "phase": "failed", "version": null, "error": "dev install — update skipped" }));
    assert!(dev.staged.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_second_update_while_one_installs_is_told_so() {
    let (url, _) = registry(200, r#"{"version":"9.9.9"}"#);
    let gate = Arc::new(Notify::new());
    let installer = Arc::new(Installer {
        dev: false,
        desktop: false,
        outcome: Ok(None),
        staged: Mutex::new(Vec::new()),
        gate: Some(gate.clone()),
        started: Arc::new(Notify::new()),
    });
    let started = installer.started.clone();
    let rig = Arc::new(rig(url, installer, "1.4.5").await);
    call(&rig, "update/checkForUpdate", json!({ "options": { "force": true } }), Some(1)).await.unwrap();
    let first = {
        let rig = rig.clone();
        tokio::spawn(async move { call(&rig, "update/runUpdateNow", json!({}), Some(2)).await })
    };
    started.notified().await;
    assert_eq!(call(&rig, "update/getUpdateStatus", json!({}), None).await.unwrap(), json!({ "phase": "installing", "version": "9.9.9", "error": null }));
    let second = call(&rig, "update/runUpdateNow", json!({}), Some(3)).await.unwrap();
    assert_eq!(second, json!({ "ok": false, "alreadyInstalling": true, "phase": "installing", "version": "9.9.9", "error": "update already in progress" }));
    gate.notify_one();
    assert_eq!(first.await.unwrap().unwrap()["phase"], "installed");
}

#[tokio::test]
async fn the_desktop_updater_is_commanded_through_the_host() {
    let rig = rig(closed(), Installer::new(Ok(None)), "1.4.5").await;
    assert!(matches!(call(&rig, "update/desktop/command", json!({ "action": "check" }), Some(1)).await, Err(CoreError::CapabilityUnavailable { .. })));
    rig.host.claim(HostCapability::Updater);
    rig.host.reply(Method("host/update/command"), json!({ "phase": "checking" }));
    assert_eq!(call(&rig, "update/desktop/command", json!({ "action": "install" }), Some(2)).await.unwrap(), json!({ "phase": "checking" }));
    let sent = rig.host.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].1, &sent[0].2), (Method("host/update/command"), &json!({ "action": "install" })));
    rig.host.fail(Method("host/update/command"), -32000, "Updater is busy", None);
    let error = call(&rig, "update/desktop/command", json!({ "action": "check" }), Some(3)).await.unwrap_err();
    assert!(matches!(
        error,
        CoreError::DomainError { message: Some(ref message), detail: None, .. }
            if &**message == "Updater is busy"
    ));
}

/// A registry that answers each request with the next body; the last one repeats.
fn sequence(bodies: &'static [&'static str]) -> (String, Arc<AtomicUsize>) {
    script(bodies.iter().map(|body| (200, *body)).collect())
}

/// What the checks, the switch and the controller answer for a local version 1.4.5, with the registry answers each scenario is given:
/// the entries are the literal results (`<local>` is the local version, `<fresh>` a time within the last minute).
fn golden() -> Value {
    json!({
        "local": "1.4.5",
        "scenarios": [
            { "name": "registry newer, force", "result": { "latestVersion": "9.9.9", "updateAvailable": true, "fromCache": false, "fresh": true }, "lastCheckedAt": 0, "cache": { "latestVersion": "9.9.9", "fresh": true } },
            { "name": "fresh cache is used", "result": { "latestVersion": "9.9.8", "updateAvailable": true, "fromCache": true, "fresh": true }, "lastCheckedAt": 0, "cache": { "latestVersion": "9.9.8", "fresh": true } },
            { "name": "stale cache refreshed", "result": { "latestVersion": "9.9.9", "updateAvailable": true, "fromCache": false, "fresh": true }, "lastCheckedAt": 0, "cache": { "latestVersion": "9.9.9", "fresh": true } },
            { "name": "offline falls back to stale cache", "result": { "latestVersion": "9.9.8", "updateAvailable": true, "fromCache": true, "fresh": false }, "lastCheckedAt": 1000, "cache": { "latestVersion": "9.9.8", "fresh": false } },
            { "name": "registry not ok falls back", "result": { "latestVersion": "9.9.8", "updateAvailable": true, "fromCache": true, "fresh": false }, "lastCheckedAt": 1000, "cache": { "latestVersion": "9.9.8", "fresh": false } },
            { "name": "registry body without version", "result": { "latestVersion": "1.4.5", "updateAvailable": false, "fromCache": true, "fresh": false }, "lastCheckedAt": 1000, "cache": { "latestVersion": "1.4.5", "fresh": false } },
            { "name": "older registry", "result": { "latestVersion": "0.0.1", "updateAvailable": false, "fromCache": false, "fresh": true }, "lastCheckedAt": 0, "cache": { "latestVersion": "0.0.1", "fresh": true } },
        ],
        "controller": [
            { "name": "status at start", "result": { "phase": "idle", "version": null, "error": null } },
            { "name": "update now before any check", "result": { "ok": false, "phase": "failed", "version": null, "error": "dev install — update skipped" } },
            { "name": "status after refusal", "result": { "phase": "failed", "version": null, "error": "dev install — update skipped" } },
            { "name": "check newer", "result": { "autoUpdate": true, "currentVersion": "<local>", "latestVersion": "9.9.9", "updateAvailable": true, "lastCheckedAt": "<fresh>" } },
            { "name": "update now with an update found", "result": { "ok": false, "phase": "failed", "version": null, "error": "dev install — update skipped" } },
            { "name": "check older", "result": { "autoUpdate": true, "currentVersion": "<local>", "latestVersion": "0.0.1", "updateAvailable": false, "lastCheckedAt": "<fresh>" } },
            { "name": "check without force reads the fresh cache", "result": { "autoUpdate": true, "currentVersion": "<local>", "latestVersion": "0.0.1", "updateAvailable": false, "lastCheckedAt": "<fresh>" } },
        ],
        "autoSwitch": [
            { "name": "settings with no stored switch", "result": { "autoUpdate": true, "currentVersion": "<local>", "latestVersion": "0.0.1", "updateAvailable": false, "lastCheckedAt": "<fresh>" }, "stored": {} },
            { "name": "switch off", "result": { "autoUpdate": false, "currentVersion": "<local>", "latestVersion": "0.0.1", "updateAvailable": false, "lastCheckedAt": "<fresh>" }, "stored": { "update": { "auto": false } } },
            { "name": "settings with the switch off", "result": { "autoUpdate": false, "currentVersion": "<local>", "latestVersion": "0.0.1", "updateAvailable": false, "lastCheckedAt": "<fresh>" }, "stored": { "update": { "auto": false } } },
            { "name": "switch on", "result": { "autoUpdate": true, "currentVersion": "<local>", "latestVersion": "0.0.1", "updateAvailable": false, "lastCheckedAt": "<fresh>" }, "stored": { "update": { "auto": true } } },
            { "name": "switch off again", "result": { "autoUpdate": false, "currentVersion": "<local>", "latestVersion": "0.0.1", "updateAvailable": false, "lastCheckedAt": "<fresh>" }, "stored": { "update": { "auto": false } } },
        ],
    })
}
/// `compareSemver` (`parse_semver`, `compare_semver`): the core's three numbers decide first (a missing or non-numeric one is 0, a fourth is
/// ignored, a leading `v`, spaces and `+build` do not count); then a prerelease ranks below its release, identifiers compare numerically
/// when both are numbers (a number ranks below a word), by ASCII otherwise, and the shorter of two equal prefixes is lower.
#[test]
fn semver_orders_by_the_core_numbers_then_the_prerelease_identifiers() {
    for (a, b, want) in [
        ("1.4.5", "1.4.5", 0),
        ("1.4.5", "v1.4.5", 0),
        ("1.4.5", "1.4.6", -1),
        ("1.4.5", "1.10.0", -1),
        ("1.4.5", "1.4", 1),
        ("1.4.5", "2", -1),
        ("1.4.5", "1.4.5+build7", 0),
        ("1.4.5", "01.4.5", 0),
        ("1.4.5", " 1.4.5 ", 0),
        ("1.4.5", "1.2.3.4", 1),
        ("1.4.5", "x.y.z", 1),
        ("1.4.5", "", 1),
        ("1.4.5", "1.4.5-beta.1", 1),
        ("1.4.5-beta.1", "1.4.5", -1),
        ("1.4.6", "1.4.5-beta.1", 1),
        ("1.4.5-beta.1", "1.4.6", -1),
        ("1.4.5-beta.1", "1.4.5-beta.1", 0),
        ("1.4.5-beta.1", "1.4.5-beta.2", -1),
        ("1.4.5-beta.9", "1.4.5-beta.10", -1),
        ("1.4.5-beta", "1.4.5-beta.1", -1),
        ("1.4.5-beta", "1.4.5-alpha", 1),
        ("1.4.5-rc.1", "1.4.5-beta.1", 1),
        ("1.4.5-1", "1.4.5-alpha", -1),
        ("1.4.5-alpha", "1.4.5-1", 1),
    ] {
        let got = match compare_semver(a, b) {
            Ordering::Less => -1,
            Ordering::Equal => 0,
            Ordering::Greater => 1,
        };
        assert_eq!(got, want, "compareSemver({a:?}, {b:?})");
    }
}
#[tokio::test]
async fn the_registry_check_answers_what_the_node_check_answered() {
    let golden = golden();
    let local = golden["local"].as_str().unwrap().to_owned();
    let day_ms = 24 * 3600 * 1000;
    let now = now_ms();
    for scenario in golden["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let (url, cache, force): (String, Option<Value>, bool) = match name {
            "registry newer, force" => registry(200, r#"{"version":" 9.9.9 "}"#).0.pipe(|u| (u, None, true)),
            "fresh cache is used" => (closed(), Some(json!({ "latestVersion": "9.9.8", "lastCheckedAt": now - 1000 })), false),
            "stale cache refreshed" => registry(200, r#"{"version":"9.9.9"}"#)
                .0
                .pipe(|u| (u, Some(json!({ "latestVersion": "9.9.8", "lastCheckedAt": now - day_ms - 3_600_000 })), false)),
            "offline falls back to stale cache" => (closed(), Some(json!({ "latestVersion": "9.9.8", "lastCheckedAt": 1000 })), true),
            "registry not ok falls back" => registry(500, "{}").0.pipe(|u| (u, Some(json!({ "latestVersion": "9.9.8", "lastCheckedAt": 1000 })), true)),
            "registry body without version" => registry(200, "{}").0.pipe(|u| (u, Some(json!({ "latestVersion": local, "lastCheckedAt": 1000 })), true)),
            "older registry" => registry(200, r#"{"version":"0.0.1"}"#).0.pipe(|u| (u, None, true)),
            other => panic!("unknown scenario {other}"),
        };
        let rig = rig(url, Installer::new(Ok(None)), &local).await;
        if let Some(cache) = cache {
            std::fs::write(rig._dir.path().join(CACHE_FILE), cache.to_string()).unwrap();
        }
        let got = rig.service.check_latest(&cancel(), force).await;
        let want = &scenario["result"];
        assert_eq!(got.latest_version.as_deref(), want["latestVersion"].as_str(), "{name}");
        assert_eq!(got.update_available, want["updateAvailable"], "{name}");
        assert_eq!(got.from_cache, want["fromCache"], "{name}");
        assert_eq!(got.current_version, local, "{name}");
        let fresh = got.last_checked_at.as_i64().unwrap() > now - 60_000;
        assert_eq!(fresh, want["fresh"], "{name}");
        if !fresh {
            assert_eq!(got.last_checked_at, scenario["lastCheckedAt"], "{name}");
        }
        // The cache file afterwards.
        let written: Value = serde_json::from_slice(&std::fs::read(rig._dir.path().join(CACHE_FILE)).unwrap()).unwrap();
        assert_eq!(written["latestVersion"], scenario["cache"]["latestVersion"], "{name}");
        assert_eq!(written["lastCheckedAt"].as_i64().unwrap() > now - 60_000, scenario["cache"]["fresh"], "{name}");
    }
}
/// `getUpdateSettings` and `setAutoUpdate` of the Node settings API over a config the setter
/// rewrites (`autoSwitch` of the golden), and the config file the Rust switch stores to.
#[tokio::test]
async fn the_auto_update_switch_answers_what_the_node_api_answered() {
    let golden = golden();
    let local = golden["local"].as_str().unwrap().to_owned();
    // The golden's settings carry the check state of a registry that answered 0.0.1 before the
    // first step (`getUpdateSettings` reads the remembered check, it never checks itself).
    let (url, _) = registry(200, r#"{"version":"0.0.1"}"#);
    let rig = rig(url, Installer::new(Ok(None)), &local).await;
    let now = now_ms();
    call(&rig, "update/checkForUpdate", json!({ "options": { "force": true } }), Some(1)).await.unwrap();
    let mut op = 1;
    for step in golden["autoSwitch"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        op += 1;
        let mut got = match name {
            n if n.starts_with("settings") => call(&rig, "config/getUpdateSettings", json!({}), None).await,
            "switch off" | "switch off again" => call(&rig, "config/setAutoUpdate", json!({ "enabled": false }), Some(op)).await,
            "switch on" => call(&rig, "config/setAutoUpdate", json!({ "enabled": true }), Some(op)).await,
            other => panic!("unknown step {other}"),
        }
        .unwrap();
        if got.get("currentVersion") == Some(&json!(local)) {
            got["currentVersion"] = json!("<local>");
        }
        if got["lastCheckedAt"].as_i64().is_some_and(|at| at > now - 60_000) {
            got["lastCheckedAt"] = json!("<fresh>");
        }
        assert_eq!(got, step["result"], "step {name}");
        // The switch is in the file: `update.auto` is what Node stored, and absent before.
        let stored: Value = serde_json::from_slice(&std::fs::read(rig._dir.path().join("mixdog-config.json")).unwrap()).unwrap();
        // The golden records the adopted config; the file holds it as `storedAgentForm`
        // writes it (orchestrator/config.mjs), the default `auto: true` dropped.
        let kept = step["stored"].get("update").filter(|u| u["auto"] != json!(true));
        assert_eq!(stored["agent"].get("update"), kept, "stored switch after {name}");
    }
}
/// The Node controller and its settings API replayed (`controller` of the golden). Node ran
/// from a git checkout, a dev install, so its staging path is not recorded; the Rust service
/// runs with a dev installer. `settings …` steps are `getUpdateSettings`, which the update
/// domain does not serve: a check answers the same object and is compared instead.
#[tokio::test]
async fn the_update_methods_answer_what_the_node_api_answered() {
    let golden = golden();
    let local = golden["local"].as_str().unwrap().to_owned();
    let (url, hits) = sequence(&[r#"{"version":"9.9.9"}"#, r#"{"version":"0.0.1"}"#]);
    let installer =
        Arc::new(Installer { dev: true, desktop: false, outcome: Ok(None), staged: Mutex::new(Vec::new()), gate: None, started: Arc::new(Notify::new()) });
    let rig = rig(url, installer.clone(), &local).await;
    let now = now_ms();
    let mut op = 0;
    for step in golden["controller"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        op += 1;
        let mut got = match name {
            "status at start" | "status after refusal" => call(&rig, "update/getUpdateStatus", json!({}), None).await,
            "update now before any check" | "update now with an update found" => call(&rig, "update/runUpdateNow", json!({}), Some(op)).await,
            "settings before any check" | "settings after check" => continue,
            "check newer" | "check older" => call(&rig, "update/checkForUpdate", json!({ "options": { "force": true } }), Some(op)).await,
            "check without force reads the fresh cache" => call(&rig, "update/checkForUpdate", json!({}), Some(op)).await,
            other => panic!("unknown step {other}"),
        }
        .unwrap();
        if got.get("currentVersion") == Some(&json!(local)) {
            got["currentVersion"] = json!("<local>");
        }
        if got["lastCheckedAt"].as_i64().is_some_and(|at| at > now - 60_000) {
            got["lastCheckedAt"] = json!("<fresh>");
        }
        assert_eq!(got, step["result"], "step {name}");
    }
    assert_eq!(hits.load(AtomicOrdering::SeqCst), 2, "the last check came from the cache");
    assert!(installer.staged.lock().unwrap().is_empty());
}

/// A transport whose request is never answered: it gives up when the window the update check's exchange names has passed.
struct Unanswered {
    windows: Mutex<Vec<(std::time::Duration, Option<String>)>>,
}

#[async_trait]
impl HttpSend for Unanswered {
    async fn send(
        &self,
        _request: WireRequest,
        exchange: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
        let expired = exchange.liveness.bound_head(std::future::pending::<()>()).await.expect_err("never answered");
        self.windows.lock().unwrap().push((expired.after, exchange.surface.timeout_text(expired.after)));
        Err(mixdog_ai::transport::link::deadline_error(expired, mixdog_core_api::domain::provider::DeliveryState::Ambiguous, exchange.surface))
    }
}

#[tokio::test(start_paused = true)]
async fn a_registry_that_does_not_answer_is_given_five_seconds_and_no_check_result() {
    let transport = Unanswered { windows: Mutex::new(Vec::new()) };
    assert!(get_through(&transport, REGISTRY_URL).await.is_none());
    assert_eq!(
        *transport.windows.lock().unwrap(),
        [(std::time::Duration::from_secs(5), Some(mixdog_ai::transport::ABORTED.to_owned()))],
        "one request, five seconds, read as an aborted fetch"
    );
}
