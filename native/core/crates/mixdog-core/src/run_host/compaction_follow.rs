//! The live sessions follow the saved compaction settings when the config changes: Node's
//! `adoptFullConfig` -> `syncSessionCompaction(getSession(), adopted)` (`config-lifecycle.mjs`), run
//! by a config reload and by a settings save, and only when the stored settings changed
//! (`settingsChanged`). A headless caller's injected config is never reloaded (`loadFullConfig`
//! returns null), so its sessions are left alone. The daemon has no single live session: every
//! loaded thread is synced, each as a header update on its own actor.

use std::sync::Arc;

use mixdog_agent::compact::settings::{Doc, adopt_session_compaction, normalize_compaction};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_store::schema::record::{Header, HeaderChange};
use serde_json::{Map, Value};

/// The saved `compaction` section, when the config has one (`syncSessionCompaction` leaves a session
/// alone otherwise).
fn saved_compaction(config: &Config) -> Option<Value> {
    config.agent().get("compaction").filter(|section| section.is_object()).cloned()
}

/// The header change `syncSessionCompaction` makes: the config-owned `compaction` fields follow `saved`,
/// the session's own survive. No change when the header already holds the result.
pub fn sync_change(header: &Header, saved: &Value) -> HeaderChange {
    let mut session: Doc = header.get("compaction").and_then(Value::as_object).cloned().unwrap_or_default();
    adopt_session_compaction(&mut session, &normalize_compaction(Some(saved)));
    let synced = Value::Object(session);
    let mut set = Map::new();
    if header.get("compaction") != Some(&synced) {
        set.insert("compaction".into(), synced);
    }
    HeaderChange { set, unset: Vec::new() }
}

/// Syncs every loaded thread with `saved`.
async fn sync_loaded(updates: &dyn HeaderUpdates, loaded: &(dyn Fn() -> Vec<ThreadId> + Send + Sync), saved: &Value) {
    for thread in loaded() {
        let saved = saved.clone();
        // A thread that unloaded or cannot take the update meanwhile adopts the saved settings when it is next installed.
        let _ = updates.update_header(&thread, Box::new(move |header| sync_change(header, &saved))).await;
    }
}

/// Follows `config.changes()` until the config is dropped. `injected`: the process runs on a headless
/// caller's own config, which is never reloaded.
pub async fn follow(config: Config, injected: bool, updates: Arc<dyn HeaderUpdates>, loaded: Arc<dyn Fn() -> Vec<ThreadId> + Send + Sync>) {
    if injected {
        return;
    }
    let mut changes = config.changes();
    // `loadedSnapshot`: the stored settings the sessions were last synced from.
    let mut seen = saved_compaction(&config);
    while changes.changed().await.is_ok() {
        let now = saved_compaction(&config);
        if now == seen {
            continue;
        }
        seen = now.clone();
        if let Some(saved) = now {
            sync_loaded(&*updates, &*loaded, &saved).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn header(compaction: Value) -> Header {
        let mut header = Header::default();
        header.insert("compaction".into(), compaction);
        header
    }

    /// Only the config-owned fields move; the session's own survive (`adoptSessionCompaction`).
    #[test]
    fn a_saved_change_replaces_the_config_owned_fields_and_keeps_the_sessions_own() {
        let header = header(json!({ "auto": true, "bufferTokens": 10, "lastCompactAt": 5 }));
        let change = sync_change(&header, &json!({ "auto": false }));
        let synced = change.set.get("compaction").expect("changed");
        assert_eq!(synced.get("auto"), Some(&json!(false)));
        assert_eq!(synced.get("lastCompactAt"), Some(&json!(5)));
        assert_eq!(synced.get("bufferTokens"), None);
    }

    /// Node's `syncSessionCompaction` over the recorded sessions (`golden/usage.json`, `sync` cases): the header after the
    /// change is the one Node's session holds after the sync.
    #[test]
    fn the_sync_change_leaves_the_header_node_s_sync_does() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/agent/compact/golden/usage.json")).expect("golden");
        let cases: Vec<&Value> = golden["cases"].as_array().expect("cases").iter().filter(|case| case["op"] == "sync").collect();
        assert!(!cases.is_empty());
        for case in cases {
            let mut header: Header = case["header"].as_object().expect("header").clone();
            if let Some(section) = case["args"]["config"].get("compaction").filter(|section| section.is_object()) {
                header.extend(sync_change(&header, section).set);
            }
            assert_eq!(Value::Object(header), case["after"], "{}", case["name"]);
        }
    }

    /// A header already on the saved settings is not written.
    #[test]
    fn a_header_on_the_saved_settings_is_left_alone() {
        let first = sync_change(&header(json!({})), &json!({ "auto": true }));
        let synced = first.set.get("compaction").cloned().expect("changed");
        assert!(sync_change(&header(synced), &json!({ "auto": true })).set.is_empty());
    }
}
