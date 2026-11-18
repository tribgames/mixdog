//! The loaded config follows what changes under it: another process's write reaches it through the config watch, and a file
//! caught halfway keeps the last good config until the write completes.

use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

use mixdog_ai::oauth::{Pace, SystemPace};
use mixdog_core_config::config::ConfigWatcher;
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use super::model_list_rig::{custom_manual, rig, seeds};
use super::provider_sync::spawn_provider_sync_on;

/// Another process's write: a whole new file renamed into place.
fn foreign_write(path: &std::path::Path, text: &str) {
    let tmp = path.with_extension("json.foreign-tmp");
    std::fs::write(&tmp, text).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}

async fn within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    match mixdog_rt::time::timeout(Duration::from_secs(5), wait).await {
        Ok(done) => done,
        Err(_) => panic!("waited 5 s for {what}"),
    }
}

/// The file text of a config that stores the custom provider of `custom_manual`.
fn stored_with_provider() -> String {
    let agent: Value = serde_json::from_str(&custom_manual()["agent"].to_string().replace("__BASE_URL__", "http://127.0.0.1:9")).unwrap();
    json!({ "agent": agent }).to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_processes_config_write_reaches_the_loaded_config_through_the_watch() {
    let rig = rig(&json!({ "agent": {}, "stub": {} }), &seeds(), false).await;
    let path = rig._dir.path().join("mixdog-config.json");
    let _watch = ConfigWatcher::start(rig.config.clone()).unwrap();
    let stop = CancellationToken::new();
    let pace: Arc<dyn Pace> = Arc::new(SystemPace);
    let mut sync = spawn_provider_sync_on(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone(), pace);
    within("the sync's first pass", sync.ready.wait_for(|ready| *ready)).await.unwrap();
    assert!(rig.loaded.get()["providers"].get("custom-aaaa").is_none());

    foreign_write(&path, &stored_with_provider());
    within("the rebuild the write causes", sync.applied.wait_for(|applied| *applied >= 1)).await.unwrap();
    assert!(rig.loaded.get()["providers"].get("custom-aaaa").is_some(), "the loaded config follows the write");
    stop.cancel();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_config_caught_halfway_keeps_the_last_good_config_until_the_write_completes() {
    let rig = rig(&json!({ "agent": {}, "stub": {} }), &seeds(), false).await;
    let path = rig._dir.path().join("mixdog-config.json");
    let _watch = ConfigWatcher::start(rig.config.clone()).unwrap();
    let stop = CancellationToken::new();
    let pace: Arc<dyn Pace> = Arc::new(SystemPace);
    let mut sync = spawn_provider_sync_on(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone(), pace);
    within("the sync's first pass", sync.ready.wait_for(|ready| *ready)).await.unwrap();
    let applied = *sync.applied.borrow();

    let text = stored_with_provider();
    let (first, rest) = text.split_at(text.len() / 2);
    let mut passes = rig.config.watch_passes();
    passes.borrow_and_update();
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(first.as_bytes()).unwrap();
    file.sync_all().unwrap();
    within("the config watch's pass over the first bytes", passes.changed()).await.unwrap();
    assert_eq!(*sync.applied.borrow(), applied, "no rebuild while the file stays torn");
    assert!(rig.loaded.get()["providers"].get("custom-aaaa").is_none(), "the last good config stands");

    file.write_all(rest.as_bytes()).unwrap();
    drop(file);
    within("the rebuild once the write completes", sync.applied.wait_for(|n| *n > applied)).await.unwrap();
    assert!(rig.loaded.get()["providers"].get("custom-aaaa").is_some());
    stop.cancel();
}

async fn started_sync(rig: &super::model_list_rig::Rig) -> (super::provider_sync::ProviderSync, CancellationToken, ConfigWatcher) {
    let watch = ConfigWatcher::start(rig.config.clone()).unwrap();
    let stop = CancellationToken::new();
    let pace: Arc<dyn Pace> = Arc::new(SystemPace);
    let mut sync = spawn_provider_sync_on(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone(), pace);
    within("the sync's first pass", sync.ready.wait_for(|ready| *ready)).await.unwrap();
    (sync, stop, watch)
}

fn openai_enabled(rig: &super::model_list_rig::Rig) -> Value {
    rig.loaded.get()["providers"]["openai-oauth"]["enabled"].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn this_processs_own_config_write_reaches_the_loaded_config() {
    let rig = rig(&json!({ "agent": {}, "stub": {} }), &seeds(), false).await;
    let (mut sync, stop, _watch) = started_sync(&rig).await;
    let applied = *sync.applied.borrow();
    let agent: Value = serde_json::from_str(&custom_manual()["agent"].to_string().replace("__BASE_URL__", "http://127.0.0.1:9")).unwrap();
    let stored = agent.as_object().cloned().unwrap();
    rig.config
        .update_agent(move |doc| {
            doc.clear();
            doc.extend(stored);
            Ok(())
        })
        .await
        .unwrap();
    within("the rebuild the write causes", sync.applied.wait_for(|n| *n > applied)).await.unwrap();
    assert!(rig.loaded.get()["providers"].get("custom-aaaa").is_some());
    stop.cancel();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_processs_config_write_is_read_fresh_by_a_listener_on_the_configs_changes() {
    let rig = rig(&json!({ "agent": {}, "stub": {} }), &seeds(), false).await;
    let path = rig._dir.path().join("mixdog-config.json");
    let _watch = ConfigWatcher::start(rig.config.clone()).unwrap();
    let mut changes = rig.config.changes();
    changes.mark_unchanged();
    foreign_write(&path, &stored_with_provider());
    within("the change notification", changes.changed()).await.unwrap();
    assert!(rig.config.agent()["providers"].get("custom-aaaa").is_some(), "what the listener reads is the new file, not the old one");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_processs_oauth_login_and_logout_reach_the_loaded_config_through_the_credential_file_watch() {
    let rig = rig(&json!({ "agent": {}, "stub": {} }), &seeds(), false).await;
    let credentials = rig._dir.path().join("accounts").join("openai-oauth.json");
    let (mut sync, stop, _watch) = started_sync(&rig).await;
    assert_eq!(openai_enabled(&rig), json!(false), "no sign-in yet");

    let applied = *sync.applied.borrow();
    // The signing-in process makes the accounts folder when there is none.
    std::fs::create_dir_all(credentials.parent().unwrap()).unwrap();
    foreign_write(&credentials, r#"{"access_token":"access","refresh_token":"refresh"}"#);
    within("the rebuild the login causes", sync.applied.wait_for(|n| *n > applied)).await.unwrap();
    assert_eq!(openai_enabled(&rig), json!(true), "the sign-in is seen");

    let applied = *sync.applied.borrow();
    std::fs::remove_file(&credentials).unwrap();
    within("the rebuild the logout causes", sync.applied.wait_for(|n| *n > applied)).await.unwrap();
    assert_eq!(openai_enabled(&rig), json!(false), "the sign-out is seen");
    stop.cancel();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_credential_file_in_a_folder_that_does_not_exist_yet_is_seen_once_the_folder_and_file_appear() {
    let rig = rig(&json!({ "agent": {}, "stub": {} }), &seeds(), false).await;
    let credentials = rig._dir.path().join("accounts").join("openai-oauth.json");
    let _ = std::fs::remove_dir_all(credentials.parent().unwrap());
    let (mut sync, stop, _watch) = started_sync(&rig).await;
    let applied = *sync.applied.borrow();
    std::fs::create_dir_all(credentials.parent().unwrap()).unwrap();
    foreign_write(&credentials, r#"{"access_token":"access","refresh_token":"refresh"}"#);
    within("the rebuild", sync.applied.wait_for(|n| *n > applied)).await.unwrap();
    assert_eq!(openai_enabled(&rig), json!(true));
    stop.cancel();
}
