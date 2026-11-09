//! The failed separation against Node's (`record-desktop-separation.mjs`, the `failures` of `desktop-separation/twin.json`):
//! the real `DesktopSettingsStore.separateDefaults` with `<data>/backups` a file, the `error.message` its catch in `index.ts`
//! records as `defaults-separation-failed`, and the retry the next start makes.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "reads the recorded twin and the files the test makes, on the test thread")]

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_rt::LaneTokens;

use crate::daemon_log::DaemonLog;
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
async fn a_failed_separation_leaves_the_config_reports_nodes_message_and_retries_next_start() {
    let twin = twin();
    let failures = twin["failures"].as_array().unwrap();
    assert_eq!(failures.len(), 2);
    for case in failures {
        let name = case["name"].as_str().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let file = data.join("mixdog-config.json");
        std::fs::write(&file, case["inputText"].as_str().unwrap()).unwrap();
        let config = open(&data, &tokens).await;
        config.separate_defaults(RECORDED_AT_MS).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), case["afterCore"].as_str().unwrap(), "{name}: the core pass");

        // The condition of the recording: the backup folder cannot be made.
        std::fs::write(data.join("backups"), "not a directory").unwrap();
        let (log, log_path) = log_in(root.path(), &tokens);
        let outcome = separate(&config, RECORDED_AT_MS).await;

        assert_eq!(std::fs::read_to_string(&file).unwrap(), case["afterFailure"].as_str().unwrap(), "{name}: the config is unchanged");
        // Node's `error.message`, the argument of its `defaults-separation-failed` record, with the recorded data folder put back.
        let message = case["error"]["message"].as_str().unwrap().replace("<data>/", &format!("{}{}", data.display(), std::path::MAIN_SEPARATOR));
        assert_eq!(outcome, DefaultsSeparation { ok: false, message: Some(message.clone()) }, "{name}: the protocol field");
        assert_eq!(serde_json::to_value(&outcome).unwrap(), serde_json::json!({ "ok": false, "message": message }), "{name}: its wire form");
        let recorded_line: Value = serde_json::from_str(case["diagnosticLine"].as_str().unwrap()).unwrap();
        assert_eq!(recorded_line["event"], "defaults-separation-failed");
        assert_eq!(recorded_line["message"], case["error"]["message"], "{name}: the recorded record carries the same message");
        log.flush().await;
        assert!(!log_path.exists(), "{name}: Node logged nothing besides the desktop diagnostic");

        // The next start: the obstacle gone, the marker still unset, so the pass runs.
        std::fs::remove_file(data.join("backups")).unwrap();
        assert!(config.separate_desktop_defaults(RECORDED_AT_MS + 60_000).await.unwrap(), "{name}: the retry runs");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), case["afterRetry"].as_str().unwrap(), "{name}: the config after the retry");
        let recorded: Vec<&str> = case["backupsAfterRetry"].as_array().unwrap().iter().map(|backup| backup["text"].as_str().unwrap()).collect();
        assert_eq!(backups(&data), recorded, "{name}: the backup of the retry");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_separation_that_succeeds_reports_ok_and_logs_nothing() {
    let tokens = mixdog_rt::testing::tokens();
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("mixdog-config.json"), twin()["failures"][0]["inputText"].as_str().unwrap()).unwrap();
    let config = open(&data, &tokens).await;
    let (log, log_path) = log_in(root.path(), &tokens);
    let outcome = separate(&config, RECORDED_AT_MS).await;
    log.flush().await;
    assert_eq!(serde_json::to_value(&outcome).unwrap(), serde_json::json!({ "ok": true }));
    assert!(!log_path.exists());
    assert_eq!(std::fs::read_to_string(data.join("mixdog-config.json")).unwrap(), twin()["failures"][0]["afterRetry"].as_str().unwrap());
}
