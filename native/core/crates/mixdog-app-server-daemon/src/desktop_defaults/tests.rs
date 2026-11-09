//! The failed separation against Node's (`record-desktop-separation.mjs`, the `failures` of `desktop-separation/twin.json`):
//! the real `DesktopSettingsStore.separateDefaults` with `<data>/backups` a file, the real `createDesktopDiagnostics` line
//! `index.ts` writes for it, and the retry the next start makes.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "reads the recorded twin and the files the test makes, on the test thread")]

use std::path::Path;
use std::sync::Arc;

use mixdog_core::run_host::run_seams::EnvReader;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use serde_json::Value;

use super::*;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/desktop-separation/twin.json")).unwrap()
}

/// `Date.UTC(2026, 0, 2, 3, 4, 5, 678)`, the clock the recorded line was written with.
const RECORDED_AT_MS: i64 = 1_767_323_045_678;

async fn open(data: &Path, tokens: &LaneTokens) -> Config {
    let publisher = Arc::new(MockStatePublisher::default());
    Config::open(data.join("mixdog-config.json"), publisher, ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io })
        .await
        .unwrap()
        .0
}

fn env_of(profile: Option<&Path>) -> EnvReader {
    let profile = profile.map(|path| path.to_string_lossy().into_owned());
    Arc::new(move |name| (name == PROFILE_ENV).then(|| profile.clone()).flatten())
}

fn backups(data: &Path) -> Vec<String> {
    let mut texts: Vec<String> = std::fs::read_dir(data.join("backups"))
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path().join("mixdog-config.json")).unwrap())
        .collect();
    texts.sort();
    texts
}

fn log_in(dir: &Path, tokens: &LaneTokens) -> (DaemonLog, std::path::PathBuf) {
    let path = dir.join("daemon.log");
    let log = DaemonLog::new(path.clone(), tokens.maintenance_io, mixdog_rt::CancellationToken::new());
    log.enable_file_logging();
    (log, path)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_separation_leaves_the_config_writes_nodes_diagnostic_and_retries_next_start() {
    let twin = twin();
    let failures = twin["failures"].as_array().unwrap();
    assert_eq!(failures.len(), 2);
    for case in failures {
        let name = case["name"].as_str().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let profile = root.path().join("profile");
        std::fs::create_dir_all(&data).unwrap();
        let file = data.join("mixdog-config.json");
        std::fs::write(&file, case["inputText"].as_str().unwrap()).unwrap();
        let config = open(&data, &tokens).await;
        config.separate_defaults(RECORDED_AT_MS).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), case["afterCore"].as_str().unwrap(), "{name}: the core pass");

        // The condition of the recording: the backup folder cannot be made.
        std::fs::write(data.join("backups"), "not a directory").unwrap();
        let (log, log_path) = log_in(root.path(), &tokens);
        separate(&config, &tokens, &env_of(Some(&profile)), &log, RECORDED_AT_MS).await;

        assert_eq!(std::fs::read_to_string(&file).unwrap(), case["afterFailure"].as_str().unwrap(), "{name}: the config is unchanged");
        // The recorded line is the desktop process's; the daemon writes the fields it knows and not `packaged` / `bootId`.
        let mut want: serde_json::Map<String, Value> = serde_json::from_str(case["diagnosticLine"].as_str().unwrap()).unwrap();
        let ours: serde_json::Map<String, Value> =
            serde_json::from_str(&std::fs::read_to_string(profile.join("logs").join("desktop-diagnostics.jsonl")).unwrap()).unwrap();
        for key in ["pid", "platform", "arch", "appVersion"] {
            want.insert(key.into(), ours[key].clone());
        }
        want.remove("packaged");
        want.remove("bootId");
        let data_text = data.to_string_lossy().into_owned();
        let message = want["message"].as_str().unwrap().replace("<data>/", &format!("{data_text}{}", std::path::MAIN_SEPARATOR));
        want.insert("message".into(), message.clone().into());
        assert_eq!(
            std::fs::read_to_string(profile.join("logs").join("desktop-diagnostics.jsonl")).unwrap(),
            format!("{}\n", Value::Object(want)),
            "{name}: the diagnostic line"
        );
        assert_eq!(message, format!("EEXIST: file already exists, mkdir '{}'", data.join("backups").display()), "{name}: Node's text");
        log.flush().await;
        assert_eq!(std::fs::read_to_string(&log_path).unwrap_or_default(), "", "{name}: nothing else is logged");

        // The next start: the obstacle gone, the marker still unset, so the pass runs.
        std::fs::remove_file(data.join("backups")).unwrap();
        assert!(config.separate_desktop_defaults(RECORDED_AT_MS + 60_000).await.unwrap(), "{name}: the retry runs");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), case["afterRetry"].as_str().unwrap(), "{name}: the config after the retry");
        let recorded: Vec<&str> = case["backupsAfterRetry"].as_array().unwrap().iter().map(|backup| backup["text"].as_str().unwrap()).collect();
        assert_eq!(backups(&data), recorded, "{name}: the backup of the retry");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_named_desktop_profile_the_failure_goes_to_the_daemon_log_and_start_goes_on() {
    let tokens = mixdog_rt::testing::tokens();
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let text = twin()["failures"][0]["inputText"].as_str().unwrap().to_owned();
    std::fs::write(data.join("mixdog-config.json"), &text).unwrap();
    let config = open(&data, &tokens).await;
    std::fs::write(data.join("backups"), "not a directory").unwrap();
    let (log, log_path) = log_in(root.path(), &tokens);
    separate(&config, &tokens, &env_of(None), &log, RECORDED_AT_MS).await;
    log.flush().await;
    assert_eq!(std::fs::read_to_string(data.join("mixdog-config.json")).unwrap(), text);
    let logged = std::fs::read_to_string(&log_path).unwrap();
    assert!(logged.contains(&format!("the desktop defaults separation failed: EEXIST: file already exists, mkdir '{}'", data.join("backups").display())), "{logged}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_separation_that_succeeds_writes_no_diagnostic() {
    let tokens = mixdog_rt::testing::tokens();
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let profile = root.path().join("profile");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("mixdog-config.json"), twin()["failures"][0]["inputText"].as_str().unwrap()).unwrap();
    let config = open(&data, &tokens).await;
    let (log, _) = log_in(root.path(), &tokens);
    separate(&config, &tokens, &env_of(Some(&profile)), &log, RECORDED_AT_MS).await;
    assert!(!profile.exists());
    assert_eq!(std::fs::read_to_string(data.join("mixdog-config.json")).unwrap(), twin()["failures"][0]["afterRetry"].as_str().unwrap());
}
