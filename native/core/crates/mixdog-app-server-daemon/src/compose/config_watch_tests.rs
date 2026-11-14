//! The config file's external-edit watch lives as long as the composed core (`Real::config_watch`, Node's `ensureConfigWatcher`).
//! It was once a local of the composition, dropped when `real_core` returned: an edit another process (or a hand edit) made to
//! `mixdog-config.json` then never reached the core's document, and the next settings write put the old document back. The
//! write half (a write starts from the file, `readAllForRmW`) is `mixdog-core-config`'s `a_write_keeps_an_external_edit_not_yet_reloaded`.
#![allow(clippy::disallowed_methods, reason = "test setup: reads and hand-edits the config file on the test thread")]
use super::*;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
async fn a_hand_edit_of_the_config_file_reaches_the_composed_core() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let stop = mixdog_rt::CancellationToken::new();
    let core = mixdog_rt::time::timeout(Duration::from_secs(60), compose(&tokens, ComposeConfig {
        data_dir: data.clone(), user_data_dir: dir.path().join("userdata"), runtime_root: dir.path().join("runtime"),
        js_runtime: crate::js_runtime::fixture(dir.path()), ort_library: OrtRuntime::NoBinding,
        outgoing: mixdog_app_server::Outgoing::new(),
        ownership: Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
        log: crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone()),
        stop, catalog_http: crate::compose_test_support::offline_http(),
        pg_install: Some(Arc::new(|_| Box::pin(async {
            Err(mixdog_services::memory::error::MemoryError::Runtime("the config watch test must not install PostgreSQL".into()))
        }))),
    })).await.expect("composition did not complete within 60 seconds").unwrap();
    let config = core.real.config.clone();
    let mut changes = config.changes();
    // The hand edit, made after the composition returned: what the file holds (nothing yet on a fresh profile) plus one key,
    // saved in place as an editor saves it.
    let file = crate::compose_flip::config_file(&data);
    let mut doc = match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&bytes).unwrap(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(error) => panic!("reading {}: {error}", file.display()),
    };
    doc.insert("watchProbe".into(), serde_json::json!("edited by hand"));
    std::fs::write(&file, serde_json::to_vec_pretty(&doc).unwrap()).unwrap();
    let adopted = mixdog_rt::time::timeout(Duration::from_secs(30), async {
        while config.get("watchProbe") != Some(serde_json::json!("edited by hand")) {
            changes.changed().await.expect("the config outlives the wait");
        }
    })
    .await;
    mixdog_rt::time::timeout(Duration::from_secs(30), core.stop("config watch test")).await.expect("the core stopped within 30 seconds");
    assert!(adopted.is_ok(), "the hand edit never reached the composed core's document: its file watch is gone");
}
