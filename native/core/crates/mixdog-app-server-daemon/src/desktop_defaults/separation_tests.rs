//! A failed one-time separation of the desktop's defaults: the config is left as the core pass wrote it, the failure is reported
//! (not raised) with a message, nothing is logged, and the next start tries again; a separation that succeeds reports ok.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "reads the files the test makes, on the test thread")]

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_rt::LaneTokens;

use crate::daemon_log::DaemonLog;

use super::*;

const INPUT: &str = r#"{"defaultsVersion":2,"desktop":{"keepAwake":true,"runInBackground":false,"zoomFactor":1}}"#;
const AT_MS: i64 = 1_767_323_045_678;

async fn open(data: &Path, tokens: &LaneTokens) -> Config {
    let publisher = Arc::new(MockStatePublisher::default());
    Config::open(data.join("mixdog-config.json"), publisher, ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io }).await.unwrap().0
}

fn log_in(dir: &Path, tokens: &LaneTokens) -> (DaemonLog, std::path::PathBuf) {
    let path = dir.join("daemon.log");
    let log = DaemonLog::new(path.clone(), tokens.maintenance_io, mixdog_rt::CancellationToken::new());
    log.enable_file_logging();
    (log, path)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_separation_leaves_the_config_reports_the_failure_and_retries_next_start() {
    let tokens = mixdog_rt::testing::tokens();
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let file = data.join("mixdog-config.json");
    std::fs::write(&file, INPUT).unwrap();
    let config = open(&data, &tokens).await;
    config.separate_defaults(AT_MS).await.unwrap();
    let after_core = std::fs::read_to_string(&file).unwrap();

    // The backup folder cannot be made: a file stands where it goes.
    std::fs::write(data.join("backups"), "not a directory").unwrap();
    let (log, log_path) = log_in(root.path(), &tokens);
    let outcome = separate(&config, AT_MS, AT_MS).await;

    assert!(!outcome.ok, "the failure is reported");
    assert!(outcome.message.as_deref().is_some_and(|message| !message.is_empty()), "with its message: {outcome:?}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), after_core, "nothing was saved");
    log.flush().await;
    assert!(!log_path.exists(), "nothing but the desktop's own diagnostics records it");

    // The next start: the obstacle gone, the marker still unset, so the pass runs and saves.
    std::fs::remove_file(data.join("backups")).unwrap();
    assert!(config.separate_desktop_defaults(AT_MS + 60_000).await.unwrap(), "the retry runs");
    let after_retry = std::fs::read_to_string(&file).unwrap();
    assert_ne!(after_retry, after_core);
    assert!(after_retry.contains("defaultsSeparationVersion"), "{after_retry}");
    assert_eq!(std::fs::read_dir(data.join("backups")).unwrap().count(), 1, "the retry made its backup");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_separation_that_succeeds_reports_ok_and_logs_nothing() {
    let tokens = mixdog_rt::testing::tokens();
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("mixdog-config.json"), INPUT).unwrap();
    let config = open(&data, &tokens).await;
    let (log, log_path) = log_in(root.path(), &tokens);
    let outcome = separate(&config, AT_MS, AT_MS).await;
    log.flush().await;
    assert_eq!(serde_json::to_value(&outcome).unwrap(), serde_json::json!({ "ok": true }));
    assert!(!log_path.exists());
    assert!(std::fs::read_to_string(data.join("mixdog-config.json")).unwrap().contains("defaultsSeparationVersion"));
}
