use std::fs;
use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::mock::MockStatePublisher;
use serde_json::json;

use super::*;
use crate::config::ConfigLanes;

fn lanes() -> ConfigLanes {
    let tokens = mixdog_rt::testing::tokens();
    ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io }
}

async fn heard(changes: &mut tokio::sync::watch::Receiver<u64>) -> bool {
    tokio::time::timeout(Duration::from_secs(10), changes.changed()).await.is_ok()
}

/// An edit another process makes reaches the document without a call to `reload`; an unparsable
/// save keeps the document; the completed save is heard again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_external_edit_reaches_the_document() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");
    fs::write(&path, r#"{"agent":{"a":1}}"#).unwrap();
    let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes()).await.unwrap();
    let mut changes = config.changes();
    let _watch = ConfigWatcher::start(config.clone()).unwrap();

    fs::write(dir.path().join("other.json"), "{}").unwrap();
    fs::write(&path, r#"{"agent":{"a":2}}"#).unwrap();
    assert!(heard(&mut changes).await, "the edit was not heard");
    assert_eq!(config.get("agent.a"), Some(json!(2)));

    fs::write(&path, "{ half typed").unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(config.get("agent.a"), Some(json!(2)), "an unparsable save keeps the document");

    fs::write(&path, r#"{"agent":{"a":3}}"#).unwrap();
    assert!(heard(&mut changes).await, "the completed save was not heard");
    assert_eq!(config.get("agent.a"), Some(json!(3)));
}