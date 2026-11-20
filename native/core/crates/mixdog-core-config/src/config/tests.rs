use std::ops::Deref;
use std::sync::Arc;
use std::sync::Barrier;
use std::sync::OnceLock;

use mixdog_core_api::mock::MockStatePublisher;
use serde_json::json;

use super::*;

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME
        .get_or_init(|| tokio::runtime::Runtime::new().unwrap())
        .block_on(future)
}

/// A synchronous view of `Config` for the tests; reads pass through to the handle.
#[derive(Clone)]
struct Blocking(Config);

impl Deref for Blocking {
    type Target = Config;
    fn deref(&self) -> &Config {
        &self.0
    }
}

fn open(dir: &tempfile::TempDir, initial: Option<Value>) -> (Blocking, Arc<MockStatePublisher>) {
    let path = dir.path().join("mixdog-config.json");
    if let Some(initial) = initial {
        fs::write(&path, serde_json::to_vec_pretty(&initial).unwrap()).unwrap();
    }
    let publisher = Arc::new(MockStatePublisher::default());
    let (config, _) = Blocking::open(path, publisher.clone()).unwrap();
    (config, publisher)
}

fn replace() -> ConfigWriteMode {
    ConfigWriteMode::Replace
}

fn on_disk(dir: &tempfile::TempDir) -> Value {
    serde_json::from_slice(&fs::read(dir.path().join("mixdog-config.json")).unwrap()).unwrap()
}

fn published(publisher: &MockStatePublisher) -> Vec<String> {
    publisher
        .published()
        .into_iter()
        .map(|(_, key, _)| key.unwrap())
        .collect()
}

#[test]
fn writes_keep_the_whole_document_secrets_included() {
    let dir = tempfile::tempdir().unwrap();
    let initial = json!({ "providers": { "openai": { "apiKey": "sk-secret" } }, "desktop": {} });
    let (config, publisher) = open(&dir, Some(initial));

    config.write("desktop.keepAwake", json!(false), replace()).unwrap();

    assert_eq!(config.full()["providers"]["openai"]["apiKey"], "sk-secret");
    assert_eq!(on_disk(&dir)["providers"]["openai"]["apiKey"], "sk-secret");
    assert_eq!(on_disk(&dir)["desktop"]["keepAwake"], false);
    // Only projected subtrees are published; credentials never reach a client.
    assert!(published(&publisher).iter().all(|k| k != "providers"));
    let sent = format!("{:?}", publisher.published());
    assert!(!sent.contains("sk-secret"));
}

#[test]
fn an_unconfirmed_transaction_cannot_enable_allow_all_actions() {
    let dir = tempfile::tempdir().unwrap();
    let initial = json!({ "agent": { "developer": { "allowAllActions": false } } });
    let (config, _) = open(&dir, Some(initial.clone()));

    let result = block_on(config.update_agent(|agent| {
        agent.insert("developer".into(), json!({ "allowAllActions": true, "cursorOAuth": true }));
        Ok(())
    }));
    assert!(matches!(result, Err(ConfigError::Rejected(CoreError::DomainError { code: Some(code), .. }))
        if code.as_ref() == "RISK_CONFIRMATION_REQUIRED"));
    assert_eq!(on_disk(&dir), initial, "the whole transaction is refused");
}

#[test]
fn desktop_settings_follow_the_node_rules() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    let defaults = config.desktop_settings();
    assert!(defaults.keep_awake && defaults.auto_clear && defaults.auto_compact);
    assert_eq!(defaults.notification_volume, 100);
    assert_eq!(defaults.session_auto_archive_days, 7);
    assert_eq!(defaults.session_auto_delete_days, 90);

    config.write("desktop.notificationVolume", json!(250), replace()).unwrap();
    config.write("desktop.keepAwake", json!(false), replace()).unwrap();
    config.write("agent.compaction.auto", json!(false), replace()).unwrap();
    let s = config.desktop_settings();
    assert_eq!((s.notification_volume, s.keep_awake, s.auto_compact), (250, false, false));

    // The code default is never stored; emptied agent objects go away.
    config.write("desktop.notificationVolume", json!(100), replace()).unwrap();
    config.write("agent.compaction.auto", json!(true), replace()).unwrap();
    let stored = on_disk(&dir);
    assert!(stored["desktop"].get("notificationVolume").is_none());
    assert_eq!(stored["agent"], json!({}));
}

#[test]
fn turning_auto_compact_off_retires_the_legacy_compaction_keys() {
    let dir = tempfile::tempdir().unwrap();
    let legacy = json!({ "agent": { "compaction": { "enabled": false, "semanticModel": "m1", "recallMemoryTimeoutMs": 900, "tailTurns": 3 } } });
    let (config, _) = open(&dir, Some(legacy));
    config.write("agent.compaction.auto", json!(false), replace()).unwrap();
    assert_eq!(on_disk(&dir)["agent"]["compaction"], json!({ "auto": false, "summaryModel": "m1", "memoryTimeoutMs": 900 }));
    // On is the default: nothing but the carried successors stays.
    config.write("agent.compaction.auto", json!(true), replace()).unwrap();
    assert_eq!(on_disk(&dir)["agent"]["compaction"], json!({ "summaryModel": "m1", "memoryTimeoutMs": 900 }));
}
#[test]
fn a_device_patch_merges_onto_its_stored_or_default_record() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    let mode = |mode| config.write("notifications.devices.cred1", json!({ "events": { "error": false } }), mode);
    // A phone app with nothing stored starts from bot chats only, the patch changes just its events.
    mode(ConfigWriteMode::MergePatchBots).unwrap();
    let stored = on_disk(&dir)["notifications"]["devices"]["cred1"].clone();
    assert_eq!(stored["scope"], "bots");
    assert_eq!(stored["events"]["error"], false);
    // A stored record keeps what it has: a second patch touches only its own keys.
    config.write("notifications.devices.cred1", json!({ "quietHours": { "enabled": true } }), ConfigWriteMode::MergePatch).unwrap();
    let merged = on_disk(&dir)["notifications"]["devices"]["cred1"].clone();
    assert_eq!((merged["scope"].clone(), merged["events"]["error"].clone(), merged["quietHours"]["enabled"].clone()), (json!("bots"), json!(false), json!(true)));
    // An invalid patch is refused and nothing changes.
    assert!(config.write("notifications.devices.cred1", json!({ "scope": "nobody" }), ConfigWriteMode::MergePatch).is_err());
    assert_eq!(on_disk(&dir)["notifications"]["devices"]["cred1"], merged);
    assert!(config.write("desktop.keepAwake", json!({}), ConfigWriteMode::MergePatch).is_err());
}

/// The boot stamp (`notification-preferences.ts:228`): written once into an unwritten subtree, left alone in a written one.
#[test]
fn boot_stamps_migrated_at_into_an_unwritten_notification_subtree_only() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    assert!(!dir.path().join("mixdog-config.json").exists(), "open writes nothing");
    block_on(config.stamp_notifications(4_242)).unwrap();
    assert_eq!(on_disk(&dir)["notifications"], json!({ "migratedAt": 4_242 }));
    block_on(config.stamp_notifications(9_999)).unwrap();
    assert_eq!(on_disk(&dir)["notifications"]["migratedAt"], 4_242, "once");
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, Some(json!({ "notifications": { "devices": {} } })));
    block_on(config.stamp_notifications(4_242)).unwrap();
    assert!(on_disk(&dir)["notifications"].get("migratedAt").is_none(), "a written subtree keeps reading 0");
}

/// Node's store stamps `migratedAt: now` when it first loads with no document (`notification-preferences.ts:228`); an
/// existing document keeps the stamp it has (`:120` reads a missing or invalid one as 0).
#[test]
fn the_first_notification_write_stamps_migrated_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    assert!(!dir.path().join("mixdog-config.json").exists(), "open writes nothing");
    config.write("notifications.devices.cred1", json!({ "scope": "off" }), ConfigWriteMode::MergePatch).unwrap();
    let stamped = on_disk(&dir)["notifications"]["migratedAt"].as_i64().unwrap();
    assert!(stamped > 0);
    config.write("notifications.devices.cred2", json!({ "scope": "off" }), ConfigWriteMode::MergePatch).unwrap();
    assert_eq!(on_disk(&dir)["notifications"]["migratedAt"].as_i64(), Some(stamped), "the stamp is written once");
    // A document that already exists, with no stamp, is left as it is: that reads as 0.
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, Some(json!({ "notifications": { "devices": {} } })));
    config.write("notifications.devices.cred1", json!({ "scope": "off" }), ConfigWriteMode::MergePatch).unwrap();
    assert!(on_disk(&dir)["notifications"].get("migratedAt").is_none());
}

#[test]
fn a_conversation_setting_replaces_the_targets_entry_and_inherit_removes_it() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    let set = |setting: Value| {
        config.write("notifications.overrides", json!({ "target": { "kind": "session", "id": "s1" }, "setting": setting }), ConfigWriteMode::SetConversation)
    };
    set(json!({ "mode": "muted", "until": null })).unwrap();
    set(json!({ "mode": "always" })).unwrap();
    assert_eq!(on_disk(&dir)["notifications"]["overrides"], json!([{ "target": { "kind": "session", "id": "s1" }, "setting": { "mode": "always" } }]));
    set(json!({ "mode": "inherit" })).unwrap();
    assert_eq!(on_disk(&dir)["notifications"]["overrides"], json!([]));
}
#[test]
fn computer_control_off_keeps_the_install_marker() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, Some(json!({ "desktop": { "computerControl": true } })));
    config.write("desktop.computerControl", json!(false), replace()).unwrap();
    let s = config.desktop_settings();
    assert!(!s.computer_control && s.computer_installed);
}

#[test]
fn invalid_values_and_unknown_keys_are_invalid_params() {
    let dir = tempfile::tempdir().unwrap();
    let (config, publisher) = open(&dir, None);
    for (path, value) in [
        ("desktop.notificationVolume", json!(401)),
        ("desktop.keepAwake", json!("yes")),
        ("desktop.sessionAutoArchiveDays", json!(5)),
        ("desktop.zoom", json!(1.5)),
        ("desktop.nonsense", json!(true)),
    ] {
        match config.write(path, value, replace()) {
            Err(ConfigError::InvalidParams { path: p, .. }) => assert_eq!(p, path),
            other => panic!("{path}: {other:?}"),
        }
    }
    // A batch is all or nothing.
    let edits = [
        ConfigEdit { path: "desktop.keepAwake".into(), value: json!(false), mode: replace() },
        ConfigEdit { path: "desktop.zoom".into(), value: json!(2), mode: replace() },
    ];
    assert!(config.batch_write(&edits).is_err());
    assert!(config.desktop_settings().keep_awake);
    assert!(publisher.published().is_empty());
}

#[test]
fn invalid_stored_retention_pauses_retention_with_one_warning() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");
    fs::write(&path, r#"{"desktop":{"sessionAutoDeleteDays":13}}"#).unwrap();
    let publisher = Arc::new(MockStatePublisher::default());
    let (config, opened) = Blocking::open(&path, publisher).unwrap();
    assert_eq!(config.session_retention(), None);
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0].path, "desktop.sessionAutoDeleteDays");

    // Unrelated edits do not repeat the warning; fixing the value clears it.
    let applied = config.write("desktop.keepAwake", json!(false), replace()).unwrap();
    assert!(applied.warnings.is_empty());
    config.write("desktop.sessionAutoDeleteDays", json!(30), replace()).unwrap();
    assert_eq!(
        config.session_retention(),
        Some(SessionRetention { auto_archive_days: 7, auto_delete_days: 30 })
    );
}

#[test]
fn external_edit_publishes_each_changed_subtree_once() {
    let dir = tempfile::tempdir().unwrap();
    let (config, publisher) = open(&dir, Some(json!({ "desktop": {}, "agent": {}, "notifications": {} })));
    let before = publisher.published().len();

    // Our own write reloads to an identical document.
    config.write("desktop.keepAwake", json!(false), replace()).unwrap();
    assert_eq!(config.reload().unwrap(), Applied::default());
    assert_eq!(publisher.published().len(), before + 1);

    let path = dir.path().join("mixdog-config.json");
    fs::write(
        &path,
        r#"{"desktop":{"keepAwake":false},"notifications":{"x":1},"agent":{"y":2},"providers":{"k":"v"}}"#,
    )
    .unwrap();
    let applied = config.reload().unwrap();
    assert_eq!(applied.changed, vec!["agent", "notifications"]);
    assert_eq!(publisher.published().len(), before + 3);
    assert_eq!(config.full()["providers"]["k"], "v");
    assert_eq!(config.reload().unwrap(), Applied::default());
}

/// `updateConfig` starts from `readAllForRmW()`, the file itself: an edit another process made that no reload has adopted
/// yet survives the next write, and the write publishes it.
#[test]
fn a_write_keeps_an_external_edit_not_yet_reloaded() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, Some(json!({ "desktop": {}, "agent": { "profile": { "title": "Start" } } })));
    fs::write(dir.path().join("mixdog-config.json"), r#"{"desktop":{},"agent":{"profile":{"title":"Hand"},"heartbeatIntervalMinutes":240}}"#)
        .unwrap();
    let applied = config.write("desktop.keepAwake", json!(false), replace()).unwrap();
    assert_eq!(applied.changed, vec!["desktop", "agent"]);
    let saved = on_disk(&dir);
    assert_eq!((&saved["agent"]["profile"]["title"], &saved["agent"]["heartbeatIntervalMinutes"]), (&json!("Hand"), &json!(240)));
    assert_eq!(saved["desktop"]["keepAwake"], json!(false));
    assert_eq!(config.agent()["profile"]["title"], "Hand");
}

#[test]
fn unreadable_file_is_an_error_and_is_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");
    fs::write(&path, "{ not json").unwrap();
    let publisher = Arc::new(MockStatePublisher::default());
    // Node's `readConfigFile` keeps a malformed file aside (`quarantineMalformedConfig`) and the dir starts fresh.
    let (config, _) = Blocking::open(&path, publisher).unwrap();
    assert!(config.full().is_empty());
    assert!(!path.exists());
    let kept: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(kept.len(), 1);
    assert!(kept[0].starts_with("mixdog-config.json.corrupt-"));
    assert_eq!(fs::read_to_string(dir.path().join(&kept[0])).unwrap(), "{ not json");

    let other = tempfile::tempdir().unwrap();
    let (config, _) = open(&other, Some(json!({ "desktop": {} })));
    fs::write(&config.shared.path, "{ broken").unwrap();
    assert!(config.reload().is_err());
    assert!(config.full().contains_key("desktop"));
}

#[test]
fn initialize_if_missing_has_one_winner() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    let config = Arc::new(config);
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [["sessions", "agents"], ["search", "studio"]]
        .into_iter()
        .map(|pins| {
            let (config, barrier) = (config.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                config
                    .write(
                        "desktop.activityRailPins",
                        json!(pins),
                        ConfigWriteMode::InitializeIfMissing,
                    )
                    .unwrap()
            })
        })
        .collect();
    let applied: Vec<Applied> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(applied.iter().filter(|a| !a.changed.is_empty()).count(), 1);
    assert_eq!(config.activity_rail_pins().unwrap().revision, 1);

    // A later plain write bumps the revision; the default list stores the revision alone.
    let default: Vec<_> = schema::DEFAULT_ACTIVITY_RAIL_PINS.to_vec();
    config.write("desktop.activityRailPins", json!(default), replace()).unwrap();
    assert_eq!(config.get("desktop.activityRailPins"), Some(json!({ "revision": 2 })));
    assert_eq!(config.activity_rail_pins().unwrap().pins, default);
    assert!(config
        .write("desktop.activityRailPins", json!(["nope"]), replace())
        .is_err());
}

/// The browser-permission rules: origins must be exactly as the URL parser serializes them,
/// duplicates collapse, defaults equal to the built-in ones are not stored, and the exception
/// list may only grow up to 300 (one already past it may still shrink).
#[test]
fn browser_permissions_follow_the_node_rules() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    let policy = json!({
        "defaults": { "notifications": "allow", "geolocation": "block", "midi": "bogus" },
        "sites": [
            { "origin": "https://example.com", "permission": "midi", "setting": "allow" },
            { "origin": "https://example.com", "embedder": "https://example.com", "permission": "midi", "setting": "block" },
            { "origin": "https://example.com:443", "permission": "midi", "setting": "allow" },
            { "origin": "ftp://x.test", "permission": "midi", "setting": "allow" },
            { "origin": "https://a.test", "embedder": "nope", "permission": "midi", "setting": "allow" },
            { "origin": "https://a.test", "permission": "nothing", "setting": "allow" },
        ]
    });
    config.write("desktop.browserPermissions", policy, replace()).unwrap();
    assert_eq!(
        config.get("desktop.browserPermissions"),
        Some(json!({
            "defaults": { "notifications": "allow" },
            "sites": [{ "origin": "https://example.com", "permission": "midi", "setting": "allow" }]
        }))
    );
    let view = config.desktop_settings().browser_permissions;
    assert_eq!(view["defaults"]["notifications"], "allow");
    assert_eq!(view["defaults"]["midi"], "ask");
    assert_eq!(view["defaults"].as_object().unwrap().len(), 13);

    let many = |n: usize| {
        json!({ "sites": (0..n).map(|i| json!({
            "origin": format!("https://s{i}.example.com"), "permission": "midi", "setting": "allow"
        })).collect::<Vec<_>>() })
    };
    config.write("desktop.browserPermissions", many(300), replace()).unwrap();
    assert!(config.write("desktop.browserPermissions", many(301), replace()).is_err());
    // A hand-edited list past the limit may shrink but not grow.
    let past_limit = many(305);
    config.update(move |doc| {
        doc.insert("desktop".into(), json!({ "browserPermissions": past_limit }));
        Ok(())
    }).unwrap();
    assert!(config.write("desktop.browserPermissions", many(306), replace()).is_err());
    config.write("desktop.browserPermissions", many(304), replace()).unwrap();
    config.write("desktop.browserPermissions", json!({}), replace()).unwrap();
    assert!(config.get("desktop.browserPermissions").is_none());
}

#[test]
fn writes_keep_the_users_key_order() {
    let dir = tempfile::tempdir().unwrap();
    let text = r#"{"zeta":1,"desktop":{"saveChatLogins":false,"keepAwake":false,"usagePinned":false},"alpha":{"b":1,"a":2}}"#;
    fs::write(dir.path().join("mixdog-config.json"), text).unwrap();
    let (config, _) = open(&dir, None);
    config.write("desktop.keepAwake", json!(true), replace()).unwrap();
    config.write("desktop.browserHidDevices", json!(true), replace()).unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(dir.path().join("mixdog-config.json")).unwrap()).unwrap();
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    // `DesktopSettingsStore.update` ends with `next.agent = agent`: a config without the section gets an empty one, last.
    assert_eq!(keys(&saved), ["zeta", "desktop", "alpha", "agent"]);
    assert_eq!(keys(&saved["desktop"]), ["saveChatLogins", "usagePinned", "browserHidDevices"]);
    assert_eq!(keys(&saved["alpha"]), ["b", "a"]);
}

/// `storedPreferences` / `storedOverride` (notification-preferences.ts): a bad field takes its own default and a malformed
/// override alone is dropped, and a volume stored as a float (`50.0`) is the integer Node read.
#[test]
fn notification_preferences_are_read_field_by_field() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(
        &dir,
        Some(json!({
            "desktop": { "notificationVolume": 50.0 },
            "notifications": {
                "migratedAt": 1,
                "devices": { "pc": {
                    "scope": "sometimes",
                    "automaticRuns": false,
                    "quietHours": { "enabled": true, "start": "25:00", "end": "07:30", "days": "weekends" }
                } },
                "overrides": [
                    { "target": { "kind": "agent", "id": "writer" }, "setting": { "mode": "muted", "until": null } },
                    { "target": { "kind": "agent", "id": "not valid!" }, "setting": { "mode": "always" } },
                    { "target": { "kind": "room", "id": "r1" }, "setting": { "mode": "muted", "until": 0 } },
                    { "target": { "kind": "session", "id": "s1" }, "setting": { "mode": "always" } }
                ]
            }
        })),
    );
    let pc = config.notification_device("pc");
    assert_eq!(pc.scope, mixdog_protocol::config::NotificationScope::All);
    assert!(!pc.automatic_runs);
    assert!(pc.quiet_hours.enabled);
    assert_eq!((pc.quiet_hours.start.as_str(), pc.quiet_hours.end.as_str()), ("23:00", "07:30"));
    assert_eq!(pc.quiet_hours.days, mixdog_protocol::config::NotificationQuietDays::Weekends);
    let kept: Vec<String> = config.notification_overrides_at(1).into_iter().map(|entry| entry.target.id).collect();
    assert_eq!(kept, ["writer", "s1"]);
    assert_eq!(config.desktop_settings().notification_volume, 50);
}

#[test]
fn cookie_auto_import_write_validation_matches_node() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    let path = "desktop.browserCookieAutoImport";
    for bad in [
        json!({ "enabled": true, "profileId": "" }),
        json!({ "enabled": false, "profileId": "a/b" }),
        json!({ "enabled": false, "profileId": "a\\b" }),
        json!({ "enabled": false, "profileId": "x".repeat(121) }),
        json!({ "enabled": "yes", "profileId": "Default" }),
        json!({ "enabled": true }),
    ] {
        assert!(config.write(path, bad.clone(), replace()).is_err(), "{bad}");
    }
    // An explicit off is stored; extra fields are not.
    config
        .write(path, json!({ "enabled": false, "profileId": "", "extra": 1 }), replace())
        .unwrap();
    assert_eq!(config.get(path), Some(json!({ "enabled": false, "profileId": "" })));
    assert_eq!(browser_cookie_auto_import(&config.full()), (false, String::new()));
}

#[test]
fn notifications_have_one_typed_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    let pc = json!({
        "scope": "bots",
        "events": { "finished": true, "question": true, "approval": true, "error": false },
        "automaticRuns": true,
        "quietHours": { "enabled": false, "start": "23:00", "end": "08:00", "days": "every", "allowWaiting": false },
        "holdWhileDesktopActive": true,
        "taskbarFlash": true
    });
    let doc = json!({
        "migratedAt": 9,
        "devices": { "pc": pc.clone() },
        "overrides": [
            { "target": { "kind": "agent", "id": "a:1" }, "setting": { "mode": "muted", "until": null } },
            { "target": { "kind": "room", "id": "r1" }, "setting": { "mode": "always" } }
        ]
    });
    config.write("notifications", doc.clone(), replace()).unwrap();
    assert_eq!(config.get("notifications"), Some(doc));

    let mut quiet = pc.clone();
    quiet["quietHours"]["start"] = json!("24:00");
    let bad = [
        ("notifications.devices.phone", quiet),
        ("notifications.devices.phone", json!({ "scope": "everyone" })),
        ("notifications.overrides", json!([{ "target": { "kind": "thread", "id": "x" }, "setting": { "mode": "always" } }])),
        ("notifications.overrides", json!([{ "target": { "kind": "agent", "id": "x" }, "setting": { "mode": "muted", "until": 0 } }])),
        ("notifications.overrides", json!([{ "target": { "kind": "agent", "id": "x" }, "setting": { "mode": "muted", "until": -5 } }])),
        ("notifications.overrides", json!([{ "target": { "kind": "agent", "id": "has space" }, "setting": { "mode": "always" } }])),
        ("notifications.overrides", json!([{ "target": { "kind": "agent", "id": "a".repeat(201) }, "setting": { "mode": "always" } }])),
        ("notifications.migratedAt", json!(-1)),
        ("notifications", json!(null)),
        ("notifications.overrides", json!([{ "target": { "kind": "agent", "id": "x" }, "setting": { "mode": "inherit" } }])),
        ("notifications.conversations.t1", json!({})),
    ];
    for (path, value) in bad {
        assert!(config.write(path, value.clone(), replace()).is_err(), "{path} {value}");
    }
    // Stored as the protocol type serializes: unknown fields are dropped, missing ones defaulted.
    config.write("notifications.devices.phone", json!({ "unknown": true, "scope": "off" }), replace()).unwrap();
    let stored = config.get("notifications.devices.phone").unwrap();
    assert_eq!(stored["scope"], "off");
    assert!(stored.get("unknown").is_none());
    assert_eq!(stored["quietHours"]["start"], "23:00");
    config.write("notifications.devices.phone", pc, replace()).unwrap();
    config.write("notifications.overrides", json!([]), replace()).unwrap();
    assert_eq!(config.get("notifications.overrides"), Some(json!([])));
    assert!(config.get("notifications.devices.phone").is_some());
    // Node keeps `devices[""]`, so an empty device id is accepted, whole or inside the document.
    config.write("notifications.devices", json!({ "": { "scope": "bots" } }), replace()).unwrap();
    assert_eq!(config.get("notifications.devices").unwrap()[""]["scope"], "bots");
    config
        .write("notifications", json!({ "migratedAt": 1, "devices": { "": {} } }), replace())
        .unwrap();
    assert_eq!(config.get("notifications").unwrap()["devices"][""]["scope"], "all");
}

#[test]
fn the_stored_instruction_files_setting_is_read_as_written() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    assert_eq!(config.stored_instruction_files(), None);
    let (config, _) = open(&tempfile::tempdir().unwrap(), Some(json!({ "agent": { "instructionFiles": "claude" } })));
    assert_eq!(config.stored_instruction_files(), Some(json!("claude")));
}

#[test]
fn the_agent_section_never_shows_a_retired_key() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(
        &dir,
        Some(json!({ "agent": { "outputStyle": "terse", "search": {}, "capabilities": {}, "recap": { "enabled": false }, "modules": { "memory": {}, "git": {} } } })),
    );
    assert_eq!(Value::Object(config.agent()), json!({ "recap": { "enabled": false }, "modules": { "git": {} } }));
    std::fs::write(
        dir.path().join("mixdog-config.json"),
        br#"{"agent":{"search":{"timeout":1},"recap":{"enabled":true}}}"#,
    )
    .unwrap();
    config.reload().unwrap();
    assert_eq!(Value::Object(config.agent()), json!({ "recap": { "enabled": true } }));
}

#[test]
fn reads_do_not_wait_for_a_writer() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, Some(json!({ "desktop": { "keepAwake": false } })));
    let held = config.shared.writer.lock().unwrap();
    assert!(!config.desktop_settings().keep_awake);
    assert_eq!(config.get("desktop.keepAwake"), Some(json!(false)));
    drop(held);
}

/// The inline test executors run lane jobs on the submitting thread.
fn lanes() -> ConfigLanes {
    let tokens = mixdog_rt::testing::tokens();
    ConfigLanes {
        read: tokens.interactive_io,
        write: tokens.durability_io,
    }
}
impl Blocking {
    fn open(
        path: impl Into<PathBuf>,
        publisher: Arc<dyn StatePublisher>,
    ) -> Result<(Self, Vec<ConfigWarning>), ConfigError> {
        block_on(Config::open(path, publisher, lanes())).map(|(config, warnings)| (Self(config), warnings))
    }

    fn write(&self, path: &str, value: Value, mode: ConfigWriteMode) -> Result<Applied, ConfigError> {
        block_on(self.0.write(path, value, mode))
    }

    fn batch_write(&self, edits: &[ConfigEdit]) -> Result<Applied, ConfigError> {
        block_on(self.0.batch_write(edits))
    }

    fn update(
        &self,
        change: impl FnOnce(&mut Doc) -> Result<(), ConfigError> + Send + 'static,
    ) -> Result<Applied, ConfigError> {
        block_on(self.0.update(change))
    }

    fn reload(&self) -> Result<Applied, ConfigError> {
        block_on(self.0.reload())
    }
}
/// The boot's recovery before its migration reads the file: a malformed config is kept aside as Node's first read keeps it,
/// and an intact one is left byte for byte.
#[test]
fn recover_malformed_keeps_a_damaged_file_aside_and_leaves_an_intact_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");
    fs::write(&path, "{\"agent\": {},\n}").unwrap();
    block_on(Config::recover_malformed(&path, lanes())).unwrap();
    assert!(!path.exists());
    let kept: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(kept.len(), 1);
    assert!(kept[0].starts_with("mixdog-config.json.corrupt-"));

    let intact = tempfile::tempdir().unwrap();
    let path = intact.path().join("mixdog-config.json");
    fs::write(&path, "{\"agent\":{\"x\":1}}").unwrap();
    block_on(Config::recover_malformed(&path, lanes())).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "{\"agent\":{\"x\":1}}");
    assert_eq!(fs::read_dir(intact.path()).unwrap().count(), 1);
}
fn owner_only(path: &Path) -> bool {
    let path = path.to_path_buf();
    block_on(on_lane(lanes().read, move |lane| mixdog_statefile::is_owner_only(lane, &path))).unwrap().unwrap()
}
/// `writeJsonAtomicSync(configPath(), data, { mode: 0o600, secret: true })`: the published config is owner-only (Unix mode
/// 0600, Windows the protected single-entry DACL Node's ACL helper sets on the temp file before it is renamed into place).
#[test]
fn the_config_file_written_through_write_is_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let (config, _) = open(&dir, None);
    config.write("desktop.keepAwake", json!(true), replace()).unwrap();
    assert!(owner_only(&dir.path().join("mixdog-config.json")));
    // A rewrite of the published file keeps it so.
    config.write("desktop.keepAwake", json!(false), replace()).unwrap();
    assert!(owner_only(&dir.path().join("mixdog-config.json")));
}
/// `mkdirSync(dirname(configPath()), { recursive: true, mode: 0o700 })` sets no ACL on Windows (the mode is advisory): a
/// config folder the write creates inherits its parent's ACL and has no protected owner-only DACL of its own.
#[cfg(windows)]
#[test]
fn a_config_folder_the_write_creates_has_no_owner_only_acl_of_its_own() {
    let parent = tempfile::tempdir().unwrap();
    let folder = parent.path().join("missing").join("data");
    let (config, _) = Blocking::open(folder.join("mixdog-config.json"), Arc::new(MockStatePublisher::default())).unwrap();
    config.write("desktop.keepAwake", json!(true), replace()).unwrap();
    assert!(folder.join("mixdog-config.json").is_file());
    assert!(!owner_only(&folder));
    assert!(!owner_only(folder.parent().unwrap()));
}



