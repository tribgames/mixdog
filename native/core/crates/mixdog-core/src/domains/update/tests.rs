//! `goldens/update.json` is what `compareSemver` and `checkLatestVersion` of the 1.4.5 daemon
//! answered (`tools/gen-update-golden.mjs`, with a stubbed registry); the controller's
//! install path runs against a scripted installer.

#![allow(clippy::disallowed_methods, reason = "test setup: seeds and inspects the cache files on the test thread")]

use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering as AtomicOrdering;

use mixdog_core_api::mock::MockHostChannel;
use tokio::sync::Notify;

use super::*;
use crate::domains::support::testing::request;
use crate::domains::support::testing::scopes;
use crate::domains::support::testing::value;
use crate::domains::support::testing::with_op;

const GOLDEN: &str = include_str!("../goldens/update.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap()
}

#[test]
fn semver_orders_as_the_node_comparison_does() {
    let golden = golden();
    for case in golden["semver"].as_array().unwrap() {
        let (a, b, want) = (
            case[0].as_str().unwrap(),
            case[1].as_str().unwrap(),
            case[2].as_i64().unwrap(),
        );
        let got = match compare_semver(a, b) {
            Ordering::Less => -1,
            Ordering::Equal => 0,
            Ordering::Greater => 1,
        };
        assert_eq!(got, want, "compareSemver({a:?}, {b:?})");
    }
}

/// A registry on a loopback port: `ok` answers 200 with the body, `error` answers 500.
fn registry(status: u16, body: &'static str) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/mixdog/latest",
        listener.local_addr().unwrap().port()
    );
    let hits = Arc::new(AtomicUsize::new(0));
    let counted = hits.clone();
    std::thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            counted.fetch_add(1, AtomicOrdering::SeqCst);
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (url, hits)
}

/// A port nothing listens on.
fn closed() -> String {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    format!("http://127.0.0.1:{port}/mixdog/latest")
}

struct Installer {
    dev: bool,
    outcome: Result<Option<String>, String>,
    staged: Mutex<Vec<String>>,
    gate: Option<Arc<Notify>>,
    started: Arc<Notify>,
}

impl Installer {
    fn new(outcome: Result<Option<String>, String>) -> Arc<Self> {
        Arc::new(Self {
            dev: false,
            outcome,
            staged: Mutex::new(Vec::new()),
            gate: None,
            started: Arc::new(Notify::new()),
        })
    }
}

#[async_trait]
impl UpdateInstaller for Installer {
    fn is_dev_install(&self) -> bool {
        self.dev
    }

    async fn stage(&self, version: &str) -> Result<Option<String>, String> {
        self.staged.lock().unwrap().push(version.to_owned());
        self.started.notify_one();
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        self.outcome.clone()
    }
}

struct Rig {
    service: Arc<UpdateService>,
    host: Arc<MockHostChannel>,
    dir: tempfile::TempDir,
}

async fn rig(registry_url: String, installer: Arc<Installer>, current: &str) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let host = Arc::new(MockHostChannel::default());
    let tokens = mixdog_rt::testing::tokens();
    let lanes = crate::config::ConfigLanes {
        read: tokens.interactive_io,
        write: tokens.durability_io,
    };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, b"{\"agent\":{}}").unwrap();
    let (config, _) = crate::config::Config::open(
        path,
        Arc::new(mixdog_core_api::mock::MockStatePublisher::default()),
        lanes,
    )
    .await
    .unwrap();
    let settings = crate::config::Settings::new(
        config.clone(),
        Arc::new(crate::config::NoEffects),
        Arc::new(|_| None),
    );
    let service = UpdateService::new(
        UpdateConfig {
            current_version: current.into(),
            registry_url,
            data_dir: dir.path().to_owned(),
            // `autoUpdateEnabled()`: `config.update.auto !== false`.
            auto_update: Arc::new(move || {
                config.agent().get("update").and_then(|u| u.get("auto")) != Some(&json!(false))
            }),
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
    Rig { service, host, dir }
}

fn cancel() -> mixdog_rt::CancellationToken {
    mixdog_rt::CancellationToken::new()
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
            "offline falls back to stale cache" => {
                (closed(), Some(json!({ "latestVersion": "9.9.8", "lastCheckedAt": 1000 })), true)
            }
            "registry not ok falls back" => registry(500, "{}")
                .0
                .pipe(|u| (u, Some(json!({ "latestVersion": "9.9.8", "lastCheckedAt": 1000 })), true)),
            "registry body without version" => registry(200, "{}")
                .0
                .pipe(|u| (u, Some(json!({ "latestVersion": local, "lastCheckedAt": 1000 })), true)),
            "older registry" => registry(200, r#"{"version":"0.0.1"}"#).0.pipe(|u| (u, None, true)),
            other => panic!("unknown scenario {other}"),
        };
        let rig = rig(url, Installer::new(Ok(None)), &local).await;
        if let Some(cache) = cache {
            std::fs::write(rig.dir.path().join(CACHE_FILE), cache.to_string()).unwrap();
        }
        let got = rig.service.check_latest(&cancel(), force).await;
        let want = &scenario["result"];
        assert_eq!(
            got.latest_version.as_deref(),
            want["latestVersion"].as_str(),
            "{name}"
        );
        assert_eq!(got.update_available, want["updateAvailable"], "{name}");
        assert_eq!(got.from_cache, want["fromCache"], "{name}");
        assert_eq!(got.current_version, local, "{name}");
        let fresh = got.last_checked_at.as_i64().unwrap() > now - 60_000;
        assert_eq!(fresh, want["fresh"], "{name}");
        if !fresh {
            assert_eq!(got.last_checked_at, scenario["lastCheckedAt"], "{name}");
        }
        // The cache file afterwards.
        let written: Value =
            serde_json::from_slice(&std::fs::read(rig.dir.path().join(CACHE_FILE)).unwrap())
                .unwrap();
        assert_eq!(
            written["latestVersion"], scenario["cache"]["latestVersion"],
            "{name}"
        );
        assert_eq!(
            written["lastCheckedAt"].as_i64().unwrap() > now - 60_000,
            scenario["cache"]["fresh"],
            "{name}"
        );
    }
}

trait Pipe: Sized {
    fn pipe<R>(self, f: impl FnOnce(Self) -> R) -> R {
        f(self)
    }
}
impl<T> Pipe for T {}

async fn call(
    rig: &Rig,
    method: &'static str,
    params: Value,
    op: Option<u64>,
) -> Result<Value, CoreError> {
    let params = match op {
        Some(n) => with_op(params, n),
        None => params,
    };
    value(&*rig.service, request(method, params, op)).await
}

#[tokio::test]
async fn the_status_starts_idle_and_a_check_reports_the_update_settings() {
    let (url, hits) = registry(200, r#"{"version":"9.9.9"}"#);
    let rig = rig(url, Installer::new(Ok(None)), "1.4.5").await;
    assert_eq!(
        call(&rig, "update/getUpdateStatus", json!({}), None)
            .await
            .unwrap(),
        json!({ "phase": "idle", "version": null, "error": null })
    );
    // Nothing is known before a check.
    let settings = call(
        &rig,
        "update/checkForUpdate",
        json!({ "options": { "force": true } }),
        Some(1),
    )
    .await
    .unwrap();
    assert_eq!(settings["autoUpdate"], true);
    assert_eq!(settings["currentVersion"], "1.4.5");
    assert_eq!(settings["latestVersion"], "9.9.9");
    assert_eq!(settings["updateAvailable"], true);
    assert_eq!(hits.load(AtomicOrdering::SeqCst), 1);
    // The same op again changes nothing and does not ask the registry again.
    let again = call(
        &rig,
        "update/checkForUpdate",
        json!({ "options": { "force": true } }),
        Some(1),
    )
    .await
    .unwrap();
    assert_eq!(again, settings);
    assert_eq!(hits.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(
        call(&rig, "update/getUpdateStatus", json!({}), None)
            .await
            .unwrap()["phase"],
        "idle"
    );
}

#[tokio::test]
async fn update_now_stages_the_version_a_check_found() {
    let (url, _) = registry(200, r#"{"version":"9.9.9"}"#);
    let installer = Installer::new(Ok(None));
    let rig = rig(url, installer.clone(), "1.4.5").await;
    // No check yet: nothing to install.
    let none = call(&rig, "update/runUpdateNow", json!({}), Some(1))
        .await
        .unwrap();
    assert_eq!(
        none,
        json!({ "ok": false, "phase": "idle", "version": null, "error": "no update available" })
    );
    call(
        &rig,
        "update/checkForUpdate",
        json!({ "options": { "force": true } }),
        Some(2),
    )
    .await
    .unwrap();
    let done = call(&rig, "update/runUpdateNow", json!({}), Some(3))
        .await
        .unwrap();
    assert_eq!(
        done,
        json!({ "ok": true, "phase": "installed", "version": "9.9.9", "error": null })
    );
    assert_eq!(*installer.staged.lock().unwrap(), vec!["9.9.9".to_owned()]);
    assert_eq!(
        call(&rig, "update/getUpdateStatus", json!({}), None)
            .await
            .unwrap(),
        json!({ "phase": "installed", "version": "9.9.9", "error": null })
    );
}

#[tokio::test]
async fn update_now_reports_a_failed_stage_and_a_dev_install() {
    let (url, _) = registry(200, r#"{"version":"9.9.9"}"#);
    let rig_failed = rig(
        url.clone(),
        Installer::new(Err("npm install exited with code 1".into())),
        "1.4.5",
    )
    .await;
    call(
        &rig_failed,
        "update/checkForUpdate",
        json!({ "options": { "force": true } }),
        Some(1),
    )
    .await
    .unwrap();
    let failed = call(&rig_failed, "update/runUpdateNow", json!({}), Some(2))
        .await
        .unwrap();
    assert_eq!(
        failed,
        json!({ "ok": false, "phase": "failed", "version": null, "error": "npm install exited with code 1" })
    );
    let blank = rig(url.clone(), Installer::new(Err(String::new())), "1.4.5").await;
    call(
        &blank,
        "update/checkForUpdate",
        json!({ "options": { "force": true } }),
        Some(1),
    )
    .await
    .unwrap();
    assert_eq!(
        call(&blank, "update/runUpdateNow", json!({}), Some(2))
            .await
            .unwrap()["error"],
        "update failed"
    );

    let dev = Arc::new(Installer {
        dev: true,
        outcome: Ok(None),
        staged: Mutex::new(Vec::new()),
        gate: None,
        started: Arc::new(Notify::new()),
    });
    let rig_dev = rig(url, dev.clone(), "1.4.5").await;
    let refused = call(&rig_dev, "update/runUpdateNow", json!({}), Some(1))
        .await
        .unwrap();
    assert_eq!(
        refused,
        json!({ "ok": false, "phase": "failed", "version": null, "error": "dev install — update skipped" })
    );
    assert!(dev.staged.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_second_update_while_one_installs_is_told_so() {
    let (url, _) = registry(200, r#"{"version":"9.9.9"}"#);
    let gate = Arc::new(Notify::new());
    let installer = Arc::new(Installer {
        dev: false,
        outcome: Ok(None),
        staged: Mutex::new(Vec::new()),
        gate: Some(gate.clone()),
        started: Arc::new(Notify::new()),
    });
    let started = installer.started.clone();
    let rig = Arc::new(rig(url, installer, "1.4.5").await);
    call(
        &rig,
        "update/checkForUpdate",
        json!({ "options": { "force": true } }),
        Some(1),
    )
    .await
    .unwrap();
    let first = {
        let rig = rig.clone();
        tokio::spawn(async move { call(&rig, "update/runUpdateNow", json!({}), Some(2)).await })
    };
    started.notified().await;
    assert_eq!(
        call(&rig, "update/getUpdateStatus", json!({}), None)
            .await
            .unwrap(),
        json!({ "phase": "installing", "version": "9.9.9", "error": null })
    );
    let second = call(&rig, "update/runUpdateNow", json!({}), Some(3))
        .await
        .unwrap();
    assert_eq!(
        second,
        json!({ "ok": false, "alreadyInstalling": true, "phase": "installing", "version": "9.9.9", "error": "update already in progress" })
    );
    gate.notify_one();
    assert_eq!(first.await.unwrap().unwrap()["phase"], "installed");
}

#[tokio::test]
async fn the_desktop_updater_is_commanded_through_the_host() {
    let rig = rig(closed(), Installer::new(Ok(None)), "1.4.5").await;
    assert!(matches!(
        call(
            &rig,
            "update/desktop/command",
            json!({ "action": "check" }),
            Some(1)
        )
        .await,
        Err(CoreError::CapabilityUnavailable { .. })
    ));
    rig.host.claim(HostCapability::Updater);
    rig.host.reply(
        Method("host/update/command"),
        json!({ "phase": "checking" }),
    );
    assert_eq!(
        call(
            &rig,
            "update/desktop/command",
            json!({ "action": "install" }),
            Some(2)
        )
        .await
        .unwrap(),
        json!({ "phase": "checking" })
    );
    let sent = rig.host.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        (sent[0].1, &sent[0].2),
        (
            Method("host/update/command"),
            &json!({ "action": "install" })
        )
    );
    rig.host.fail(
        Method("host/update/command"),
        -32000,
        "Updater is busy",
        None,
    );
    let error = call(
        &rig,
        "update/desktop/command",
        json!({ "action": "check" }),
        Some(3),
    )
    .await
    .unwrap_err();
    assert!(matches!(
        error,
        CoreError::DomainError { message: Some(ref message), detail: None, .. }
            if &**message == "Updater is busy"
    ));
}

/// A registry that answers each request with the next body; the last one repeats.
fn sequence(bodies: &'static [&'static str]) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/mixdog/latest",
        listener.local_addr().unwrap().port()
    );
    let hits = Arc::new(AtomicUsize::new(0));
    let counted = hits.clone();
    std::thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0u8; 2048];
            let _ = stream.read(&mut buffer);
            let body = bodies[counted
                .fetch_add(1, AtomicOrdering::SeqCst)
                .min(bodies.len() - 1)];
            let response = format!(
                "HTTP/1.1 200 X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (url, hits)
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
    call(&rig, "update/checkForUpdate", json!({ "options": { "force": true } }), Some(1))
        .await
        .unwrap();
    let mut op = 1;
    for step in golden["autoSwitch"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        op += 1;
        let mut got = match name {
            n if n.starts_with("settings") => {
                call(&rig, "config/getUpdateSettings", json!({}), None).await
            }
            "switch off" | "switch off again" => {
                call(&rig, "config/setAutoUpdate", json!({ "enabled": false }), Some(op)).await
            }
            "switch on" => {
                call(&rig, "config/setAutoUpdate", json!({ "enabled": true }), Some(op)).await
            }
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
        let stored: Value =
            serde_json::from_slice(&std::fs::read(rig.dir.path().join("mixdog-config.json")).unwrap())
                .unwrap();
        // The golden records the adopted config; the file holds it as `storedAgentForm`
        // writes it (orchestrator/config.mjs), the default `auto: true` dropped.
        let kept = step["stored"].get("update").filter(|u| u["auto"] != json!(true));
        assert_eq!(
            stored["agent"].get("update"),
            kept,
            "stored switch after {name}"
        );
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
    let installer = Arc::new(Installer {
        dev: true,
        outcome: Ok(None),
        staged: Mutex::new(Vec::new()),
        gate: None,
        started: Arc::new(Notify::new()),
    });
    let rig = rig(url, installer.clone(), &local).await;
    let now = now_ms();
    let mut op = 0;
    for step in golden["controller"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        op += 1;
        let mut got = match name {
            "status at start" | "status after refusal" => {
                call(&rig, "update/getUpdateStatus", json!({}), None).await
            }
            "update now before any check" | "update now with an update found" => {
                call(&rig, "update/runUpdateNow", json!({}), Some(op)).await
            }
            "settings before any check" | "settings after check" => continue,
            "check newer" | "check older" => {
                call(
                    &rig,
                    "update/checkForUpdate",
                    json!({ "options": { "force": true } }),
                    Some(op),
                )
                .await
            }
            "check without force reads the fresh cache" => {
                call(&rig, "update/checkForUpdate", json!({}), Some(op)).await
            }
            other => panic!("unknown step {other}"),
        }
        .unwrap();
        if got.get("currentVersion") == Some(&json!(local)) {
            got["currentVersion"] = json!("<local>");
        }
        if got["lastCheckedAt"]
            .as_i64()
            .is_some_and(|at| at > now - 60_000)
        {
            got["lastCheckedAt"] = json!("<fresh>");
        }
        assert_eq!(got, step["result"], "step {name}");
    }
    assert_eq!(
        hits.load(AtomicOrdering::SeqCst),
        2,
        "the last check came from the cache"
    );
    assert!(installer.staged.lock().unwrap().is_empty());
}
