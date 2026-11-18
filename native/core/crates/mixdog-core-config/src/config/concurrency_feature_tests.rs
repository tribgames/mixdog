//! Writers of one config file lose nothing of each other: a write changes the keys it names and keeps what a peer saved.
#![allow(clippy::disallowed_methods, reason = "test setup: seeds and reads the config file on the test thread")]

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use serde_json::Value;
use serde_json::json;

use super::Config;
use super::ConfigLanes;

async fn open(seed: &Value) -> (Config, std::path::PathBuf, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, seed.to_string()).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(&path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    (config, path, dir)
}

fn file(path: &std::path::Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test]
async fn concurrent_updates_of_different_sections_are_both_kept() {
    let (config, path, _dir) = open(&json!({ "agent": { "profile": {} } })).await;
    let (left, right) = tokio::join!(
        config.update_agent(|agent| {
            agent.entry("shell").or_insert_with(|| json!({}))["extra"] = json!("peer");
            Ok(())
        }),
        config.update_agent(|agent| {
            agent.entry("profile").or_insert_with(|| json!({}))["language"] = json!("ko");
            Ok(())
        }),
    );
    left.unwrap();
    right.unwrap();
    let saved = file(&path);
    assert_eq!(saved["agent"]["shell"]["extra"], json!("peer"));
    assert_eq!(saved["agent"]["profile"]["language"], json!("ko"));
}

#[tokio::test]
async fn a_save_writes_only_what_it_changed_and_keeps_what_a_peer_saved_meanwhile() {
    let (config, path, _dir) = open(&json!({ "agent": { "compaction": { "auto": true } } })).await;
    config
        .update_agent(|agent| {
            agent.entry("shell").or_insert_with(|| json!({}))["extra"] = json!("peer");
            Ok(())
        })
        .await
        .unwrap();
    let before = json!({ "compaction": { "auto": true } });
    let after = json!({ "compaction": { "auto": false } });
    config.save_agent_config(before.as_object().unwrap(), after.as_object().unwrap(), false).await.unwrap();
    let saved = file(&path);
    assert_eq!(saved["agent"]["compaction"]["auto"], json!(false));
    assert_eq!(saved["agent"]["shell"]["extra"], json!("peer"), "the peer's key survives a save that never named it");
}
