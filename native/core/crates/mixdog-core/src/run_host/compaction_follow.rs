//! A change of the saved `autoClear` reaches the cache options of the loaded Lead sessions the same way (`change.autoClear` of
//! `config-change-effects.mjs` -> `refreshLiveSessionsCacheOpts`); a session installed later takes it at install
//! (`ConfigSeams::synced_cache_opts`).
//!
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

/// The saved `compaction` section. A reloaded full config always has one, the empty `{}` when none is stored
/// (`config.mjs:367`, `compaction: {}`; `config.mjs:302` for a stored non-object), so a removed section syncs
/// the loaded sessions to the empty-section defaults (`adoptFullConfig`, `config-lifecycle.mjs:285`).
fn saved_compaction(config: &Config) -> Value {
    config.agent().get("compaction").filter(|section| section.is_object()).cloned().unwrap_or_else(|| Value::Object(Map::new()))
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

/// The saved `autoClear` section, as the route change reads it (`route_surface`'s `auto_clear`): Null when none is stored.
fn saved_auto_clear(config: &Config) -> Value {
    config.agent().get("autoClear").cloned().unwrap_or(Value::Null)
}

/// The header change `refreshSessionProviderCacheOpts` makes for a thread on the saved `autoClear`: none for a session
/// Node leaves alone.
pub fn cache_opts_change(header: &Header, auto_clear: &Value) -> HeaderChange {
    let mut set = Map::new();
    if let Some(opts) = super::session_cache_opts::refreshed_cache_opts(header, auto_clear) {
        set.insert("providerCacheOpts".into(), opts);
    }
    HeaderChange { set, unset: Vec::new() }
}

/// Re-derives every loaded thread's cache options from `auto_clear` (`refreshLiveSessionsProviderCacheOpts`).
async fn refresh_loaded(updates: &dyn HeaderUpdates, loaded: &(dyn Fn() -> Vec<ThreadId> + Send + Sync), auto_clear: &Value) {
    for thread in loaded() {
        let auto_clear = auto_clear.clone();
        let _ = updates.update_header(&thread, Box::new(move |header| cache_opts_change(header, &auto_clear))).await;
    }
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
    // `configChangeSnapshot().autoClear`: the section the live Lead sessions' cache options were last derived from.
    let mut seen_auto_clear = saved_auto_clear(&config);
    while changes.changed().await.is_ok() {
        let now = saved_compaction(&config);
        if now != seen {
            sync_loaded(&*updates, &*loaded, &now).await;
            seen = now;
        }
        let auto_clear = saved_auto_clear(&config);
        if auto_clear != seen_auto_clear {
            refresh_loaded(&*updates, &*loaded, &auto_clear).await;
            seen_auto_clear = auto_clear;
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

    /// A header already on the saved settings is not written.
    #[test]
    fn a_header_on_the_saved_settings_is_left_alone() {
        let first = sync_change(&header(json!({})), &json!({ "auto": true }));
        let synced = first.set.get("compaction").cloned().expect("changed");
        assert!(sync_change(&header(synced), &json!({ "auto": true })).set.is_empty());
    }

    /// A fake session store: each thread's header, updated the way the actor does (the update sees the header as it stands).
    #[derive(Default)]
    struct Store {
        headers: std::sync::Mutex<std::collections::HashMap<ThreadId, Header>>,
    }

    #[async_trait::async_trait]
    impl HeaderUpdates for Store {
        async fn update_header(&self, thread: &ThreadId, update: mixdog_core_ports::ports::threads::HeaderUpdate) -> Result<(), mixdog_tools::orch::util::PortError> {
            let mut headers = self.headers.lock().expect("store");
            let header = headers.entry(thread.clone()).or_default();
            let change = update(header);
            header.extend(change.set);
            Ok(())
        }
    }

    async fn save_compaction(config: &Config, section: Value) {
        config
            .update(move |doc| {
                doc.insert("agent".into(), json!({ "compaction": section }));
                Ok(())
            })
            .await
            .expect("saved");
    }

    fn loaded_thread() -> (ThreadId, Arc<dyn Fn() -> Vec<ThreadId> + Send + Sync>) {
        let thread = ThreadId::from("t1");
        let ids = vec![thread.clone()];
        (thread, Arc::new(move || ids.clone()))
    }

    fn compaction_of(store: &Store, thread: &ThreadId) -> Option<Value> {
        store.headers.lock().expect("store").get(thread)?.get("compaction").cloned()
    }

    async fn save_auto_clear(config: &Config, section: Value) {
        config
            .update(move |doc| {
                doc.insert("agent".into(), json!({ "autoClear": section }));
                Ok(())
            })
            .await
            .expect("saved");
    }

    fn lead_header(opts: Value, overridden: bool) -> Header {
        let mut header = Header::default();
        for (key, value) in [("id", json!("sess_1")), ("provider", json!("anthropic-oauth")), ("providerCacheOpts", opts), ("providerCacheOptsOverride", json!(overridden))] {
            header.insert(key.into(), value);
        }
        header
    }

    fn messages_ttl(store: &Store, thread: &ThreadId) -> Option<Value> {
        store.headers.lock().expect("store").get(thread)?.get("providerCacheOpts")?.get("cacheStrategy")?.get("messages").cloned()
    }

    async fn open_config() -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().expect("dir");
        let tokens = mixdog_rt::testing::tokens();
        let lanes = mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), lanes).await.expect("config");
        (dir, config)
    }
    /// A saved change of the compaction settings reaches a loaded thread's header: the config-owned fields follow, the
    /// session's own survive; a save that leaves the section as it was moves nothing.
    #[tokio::test(start_paused = true)]
    async fn a_saved_compaction_change_reaches_a_loaded_threads_header() {
        let (_dir, config) = open_config().await;
        let store = Arc::new(Store::default());
        let (thread, loaded) = loaded_thread();
        store.headers.lock().expect("store").insert(thread.clone(), header(json!({ "auto": true, "lastCompactAt": 5 })));
        // The follower is driven by polling it here: one poll runs it to where it waits for the next change, and a poll after a
        // save runs it through that change. A save is acknowledged after the config ticks its changes.
        let mut follower = std::pin::pin!(follow(config.clone(), false, store.clone(), loaded));
        assert!(futures::poll!(follower.as_mut()).is_pending());
        save_compaction(&config, json!({ "auto": false })).await;
        assert!(futures::poll!(follower.as_mut()).is_pending());
        let got = compaction_of(&store, &thread).filter(|c| c.get("auto") == Some(&json!(false))).expect("the saved change reached the header");
        assert_eq!(got.get("lastCompactAt"), Some(&json!(5)), "the session's own fields survive");
        // The same section saved again changes nothing.
        let before = store.headers.lock().expect("store").get(&thread).cloned();
        store.headers.lock().expect("store").get_mut(&thread).expect("thread").insert("compaction".into(), json!({ "auto": true, "marker": 1 }));
        save_compaction(&config, json!({ "auto": false })).await;
        assert!(futures::poll!(follower.as_mut()).is_pending());
        assert_eq!(compaction_of(&store, &thread), Some(json!({ "auto": true, "marker": 1 })), "an unchanged section is not adopted again ({before:?})");
    }
    /// Turning auto-clear off, or saving an idle window of an hour or more, moves a loaded Lead session's cache TTL on the next request
    /// (the header the request reads); a session with its own policy keeps it.
    #[tokio::test(start_paused = true)]
    async fn a_saved_auto_clear_change_reaches_a_loaded_lead_sessions_cache_options() {
        let (_dir, config) = open_config().await;
        let store = Arc::new(Store::default());
        let held = json!({ "cacheStrategy": { "tools": "none", "system": "1h", "tier3": "1h", "messages": "5m" } });
        let (lead, other) = (ThreadId::from("lead"), ThreadId::from("pinned"));
        store.headers.lock().expect("store").insert(lead.clone(), lead_header(held.clone(), false));
        store.headers.lock().expect("store").insert(other.clone(), lead_header(held, true));
        let loaded: Arc<dyn Fn() -> Vec<ThreadId> + Send + Sync> = { let ids = vec![lead.clone(), other.clone()]; Arc::new(move || ids.clone()) };
        let mut follower = std::pin::pin!(follow(config.clone(), false, store.clone(), loaded));
        assert!(futures::poll!(follower.as_mut()).is_pending());
        for (section, want) in [
            (json!({ "enabled": false }), "1h"),
            (json!({ "enabled": true, "idleMs": 600_000 }), "5m"),
            (json!({ "enabled": true, "idleMs": 3_600_000 }), "1h"),
        ] {
            save_auto_clear(&config, section).await;
            assert!(futures::poll!(follower.as_mut()).is_pending());
            // `MIXDOG_CACHE_MESSAGES_TTL` overrides the saved window for every session that has a tail (a machine may set it).
            let forced = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
            let want = if matches!(forced.trim(), "1h" | "5m" | "none") { forced.trim() } else { want };
            assert_eq!(messages_ttl(&store, &lead), Some(json!(want)));
            assert_eq!(messages_ttl(&store, &other), Some(json!("5m")), "an explicit policy is kept");
        }
    }
    /// A headless caller's injected config is never reloaded, so its sessions are never followed.
    #[tokio::test(start_paused = true)]
    async fn an_injected_config_is_never_followed() {
        let (_dir, config) = open_config().await;
        let store = Arc::new(Store::default());
        let (thread, loaded) = loaded_thread();
        store.headers.lock().expect("store").insert(thread.clone(), header(json!({ "auto": true })));
        // An injected config has nothing to follow: the call returns.
        follow(config.clone(), true, store.clone(), loaded).await;
        save_compaction(&config, json!({ "auto": false })).await;
        assert_eq!(compaction_of(&store, &thread), Some(json!({ "auto": true })));
    }


    /// Node's `syncSessionCompaction` over the recorded sessions (`golden/usage.json`, `sync` cases): the header after the
    /// change is the one Node's session holds after the sync.
    #[test]
    #[cfg(node_twin)]
    fn the_sync_change_leaves_the_header_node_s_sync_does() {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent/compact/golden/usage.json")).expect("golden");
        let cases: Vec<&Value> = golden["cases"].as_array().expect("cases").iter().filter(|case| case["op"] == "sync").collect();
        assert!(!cases.is_empty());
        for case in cases {
            let mut header: Header = case["header"].as_object().expect("header").clone();
            // A config without the section leaves the session alone; a reloaded full config always has one (see `saved_compaction`).
            if let Some(section) = case["args"]["config"].get("compaction").filter(|section| section.is_object()) {
                header.extend(sync_change(&header, section).set);
            }
            assert_eq!(Value::Object(header), case["after"], "{}", case["name"]);
        }
    }
    /// Removing the saved section syncs a loaded thread to the empty-section defaults: the header after Node's
    /// `syncSessionCompaction` over the reloaded `compaction: {}` (the `sync-to-the-empty-section-...` recording).
    #[tokio::test]
    #[cfg(node_twin)]
    async fn a_removed_compaction_section_syncs_a_loaded_thread_to_the_empty_defaults() {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent/compact/golden/usage.json")).expect("golden");
        let case = golden["cases"].as_array().expect("cases").iter().find(|case| case["name"] == "sync-to-the-empty-section-after-the-saved-one-is-removed").expect("recorded case");
        let (_dir, config) = open_config().await;
        save_compaction(&config, json!({ "auto": false })).await;
        let store = Arc::new(Store::default());
        let (thread, loaded) = loaded_thread();
        store.headers.lock().expect("store").insert(thread.clone(), case["header"].as_object().expect("header").clone());
        let mut follower = std::pin::pin!(follow(config.clone(), false, store.clone(), loaded));
        assert!(futures::poll!(follower.as_mut()).is_pending());
        config
            .update(|doc| {
                doc.shift_remove("agent");
                Ok(())
            })
            .await
            .expect("removed");
        assert!(futures::poll!(follower.as_mut()).is_pending());
        let want = case["after"]["compaction"].clone();
        assert_eq!(compaction_of(&store, &thread), Some(want));
    }
}