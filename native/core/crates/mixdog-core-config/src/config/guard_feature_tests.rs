//! The user-data guard seen through the config: every write is snapshotted, and a config that is lost or damaged in a dir that
//! was initialized comes back from the newest complete snapshot.
#![allow(clippy::disallowed_methods, reason = "test setup: lays out and removes the config file on the test thread")]

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_core_api::mock::MockStatePublisher;
use serde_json::json;

use super::Config;
use super::ConfigLanes;
use crate::user_data::Env;
use crate::user_data::UserData;

fn lanes() -> ConfigLanes {
    let tokens = mixdog_rt::testing::tokens();
    ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io }
}

fn guard(root: &Path) -> Arc<UserData> {
    let mhome = root.join("mhome").to_string_lossy().into_owned();
    let env = Env::new(move |name| (name == "MIXDOG_HOME").then(|| mhome.clone()), Some(root.join("home")));
    let ids = AtomicU64::new(0);
    Arc::new(UserData::new(
        env,
        || 1_767_225_600_000,
        move || format!("00000000-0000-4000-8000-{:012}", ids.fetch_add(1, Ordering::SeqCst) + 1),
        |_| {},
    ))
}

async fn write_config(root: &Path, set: serde_json::Value) {
    let path = root.join("data").join("mixdog-config.json");
    let config = Config::open_unread(path, Arc::new(MockStatePublisher::default()), lanes(), guard(root));
    let set = set.as_object().unwrap().clone();
    config
        .update(move |doc| {
            for (key, value) in set {
                doc.insert(key, value);
            }
            Ok(())
        })
        .await
        .unwrap();
}

async fn read_config(root: &Path) -> serde_json::Value {
    let path = root.join("data").join("mixdog-config.json");
    let (config, _) = Config::open_guarded(path, Arc::new(MockStatePublisher::default()), lanes(), guard(root)).await.unwrap();
    serde_json::Value::Object((*config.full()).clone())
}

#[tokio::test]
async fn a_written_config_reads_back_through_the_guard() {
    let dir = tempfile::tempdir().unwrap();
    write_config(dir.path(), json!({ "agent": { "name": "a" }, "theme": "dark" })).await;
    let read = read_config(dir.path()).await;
    assert_eq!(read["theme"], json!("dark"));
    assert_eq!(read["agent"], json!({ "name": "a" }));
}

#[tokio::test]
async fn a_config_lost_from_an_initialized_dir_is_restored_from_its_newest_backup() {
    let dir = tempfile::tempdir().unwrap();
    write_config(dir.path(), json!({ "agent": { "name": "a" }, "theme": "dark" })).await;
    std::fs::remove_file(dir.path().join("data/mixdog-config.json")).unwrap();
    let read = read_config(dir.path()).await;
    assert_eq!(read["theme"], json!("dark"));
}

#[tokio::test]
async fn a_damaged_config_is_restored_the_same_way() {
    let dir = tempfile::tempdir().unwrap();
    write_config(dir.path(), json!({ "agent": { "name": "a" }, "theme": "dark" })).await;
    std::fs::write(dir.path().join("data/mixdog-config.json"), "{ not json").unwrap();
    let read = read_config(dir.path()).await;
    assert_eq!(read["theme"], json!("dark"));
}

#[tokio::test]
async fn a_dir_that_was_never_initialized_opens_as_an_empty_config() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    let read = read_config(dir.path()).await;
    assert!(read.as_object().unwrap().get("theme").is_none());
}
