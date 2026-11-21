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
    let core = mixdog_rt::time::timeout(
        Duration::from_secs(60),
        compose(
            &tokens,
            tests::config_without_postgres(
                &data,
                dir.path(),
                crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone()),
                stop,
                "the config watch test must not install PostgreSQL",
            ),
        ),
    )
    .await
    .expect("composition did not complete within 60 seconds")
    .unwrap();
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
