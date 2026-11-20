use mixdog_core_api::mock::MockStatePublisher;

use super::*;
use crate::config::ConfigLanes;
use crate::config::NoEffects;
use crate::config::SettingsEnv;

/// A setter's `TypeError` (Node `settings-builtin-tools-api.mjs` `installBuiltinFeature`) and its plain `Error`
/// (`heartbeat-interval.mjs` `requireHeartbeatIntervalMinutes`) reach the window as their message and no code, which
/// an `invalidParams` answer would not carry.
#[test]
fn a_setter_error_answers_its_message() {
    let type_error = "Built-in feature must be git, memory, office, tidy, localProvider, or autoEffort.";
    let error = "heartbeat interval must be one of 30, 60, 120, 240 minutes";
    for (thrown, text) in [(ToolModulesError::InvalidArgument(type_error.into()), type_error), (ToolModulesError::Failed(error.into()), error)] {
        match tool(Err(thrown)) {
            Err(CoreError::DomainError { code: None, message: Some(message), .. }) => assert_eq!(&*message, text),
            other => panic!("{other:?}"),
        }
    }
}

/// `setProfile(input)`: the wire carries the object as the `input` param next to `opId`, and the
/// answer and a later `getProfile` show what it set.
#[tokio::test]
async fn set_profile_applies_the_input_param() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let env: SettingsEnv = Arc::new(|_| None);
    let settings = Settings::new(config, Arc::new(NoEffects), env);

    let params = json!({ "opId": "op-1", "input": { "title": "Harness", "language": "en", "experienceLevel": "expert" } });
    let set = settings_call(&settings, "config/setProfile", &params, false).await.unwrap();
    assert_eq!((set["title"].as_str(), set["language"].as_str(), set["experienceLevel"].as_str()), (Some("Harness"), Some("en"), Some("expert")));
    assert_eq!(settings_call(&settings, "config/getProfile", &json!({}), false).await.unwrap(), set);
}
/// `setSystemShell(input)`: the desktop sends `{ opId, input: { command } }` (Node `input.command`),
/// not a flat `command`.
#[tokio::test]
async fn set_system_shell_applies_the_input_param() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let env: SettingsEnv = Arc::new(|_| None);
    let settings = Settings::new(config, Arc::new(NoEffects), env);

    let params = json!({ "opId": "op-1", "input": { "command": "powershell.exe" } });
    let set = settings_call(&settings, "config/setSystemShell", &params, false).await.unwrap();
    assert_eq!(set["command"], "powershell.exe");
    assert_eq!(settings_call(&settings, "config/getSystemShell", &json!({}), false).await.unwrap()["command"], "powershell.exe");
}
/// `setWorktreeSettings(patch)` stores what Node's `saveConfigAndAdopt` stores (settings-worktree-api.mjs, "defaults are not
/// stored"): only the values that differ from the defaults, and no section once every value is back at its default.
#[tokio::test]
async fn set_worktree_settings_stores_only_what_differs_from_the_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("mixdog-config.json");
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(file.clone(), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let stored = || serde_json::from_slice::<Value>(&std::fs::read(&file).unwrap()).unwrap()["agent"].get("worktree").cloned();

    let set = set_worktree_settings(&config, &json!({ "maxWorktrees": 5, "branchPrefix": "ft/" })).await.unwrap();
    assert_eq!((set["maxWorktrees"].as_u64(), set["branchPrefix"].as_str(), set["unusedDays"].as_u64()), (Some(5), Some("ft/"), Some(30)));
    assert_eq!(stored(), Some(json!({ "branchPrefix": "ft/", "maxWorktrees": 5 })));

    set_worktree_settings(&config, &json!({ "maxWorktrees": 15, "branchPrefix": "" })).await.unwrap();
    assert_eq!(stored(), None);
    assert_eq!(worktree_view(&config)["maxWorktrees"], 15);
}
/// Input audit #150: a paired phone writes only the config keys Node's relay methods wrote. Each write below is one the
/// desktop makes (it succeeds from a local connection); from a relay connection it is refused before anything is applied:
/// the file and every value stay as they were. The writes Node's relay made pass.
#[tokio::test]
async fn a_relay_write_outside_nodes_relay_methods_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("mixdog-config.json");
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(file.clone(), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    value_write(&config, &json!({ "opId": "op-0", "path": "desktop.keepAwake", "value": false }), false).await.unwrap();
    let refused = [
        json!({ "path": "remote.enabled", "value": false }),
        json!({ "path": "desktop.browserPermissions", "value": { "defaults": { "camera": "allow" }, "sites": [] } }),
        json!({ "path": "desktop.browserCookieAutoImport", "value": { "enabled": false, "profileId": "" } }),
        json!({ "path": "desktop.notificationVolume", "value": 10 }),
        json!({ "path": "desktop.sessionAutoDeleteDays", "value": 0 }),
        json!({ "path": "desktop.activityRailPins", "value": ["sessions"], "mode": "initializeIfMissing" }),
        json!({ "path": "quotaAutoResume", "value": { "enabled": true } }),
        json!({ "path": "toolPolicy.mode", "value": "allow" }),
        json!({ "path": "notifications.devices.pc", "value": { "scope": "off" } }),
        // An announcement Node's relay never made: another scope, or `desktop` after a write that was no `updateSetting`.
        json!({ "path": "desktop.keepAwake", "value": true, "announce": "git" }),
        json!({ "path": "desktop.activityRailPins", "value": ["sessions"], "announce": "desktop" }),
    ];
    for edit in refused {
        let params = json!({ "opId": "op-1", "path": edit["path"], "value": edit["value"], "mode": edit.get("mode"), "announce": edit.get("announce") });
        let before = (std::fs::read(&file).unwrap(), config.full());
        match value_write(&config, &params, true).await {
            Err(CoreError::DomainError { code, .. }) => assert_eq!(code.as_deref(), Some("REMOTE_DESKTOP_ONLY"), "{edit}"),
            other => panic!("{edit}: a phone's write was not refused: {other:?}"),
        }
        assert_eq!((std::fs::read(&file).unwrap(), config.full()), before, "{edit}: the refused write changed the config");
        value_write(&config, &params, false).await.unwrap_or_else(|error| panic!("{edit}: the desktop's write failed: {error:?}"));
    }
    for edit in [
        json!({ "path": "desktop.keepAwake", "value": true }),
        json!({ "path": "agent.autoClear.enabled", "value": false }),
        json!({ "path": "desktop.activityRailPins", "value": ["sessions", "agents"] }),
        json!({ "path": "quotaAutoResume", "value": false }),
        json!({ "path": "notifications.devices.dev1", "value": { "scope": "off" }, "mode": "mergePatch" }),
        json!({ "path": "notifications.overrides", "value": { "target": { "kind": "session", "id": "s1" }, "setting": { "mode": "always" } }, "mode": "setConversation" }),
    ] {
        let params = json!({ "opId": "op-2", "path": edit["path"], "value": edit["value"], "mode": edit.get("mode") });
        value_write(&config, &params, true).await.unwrap_or_else(|error| panic!("{edit}: Node's relay wrote it: {error:?}"));
    }
}

/// `ui/providerModels/announce` tells every client the trimmed origin, once; an origin that is not a string, is blank or is longer than
/// 128 UTF-16 units is refused and tells no one.
#[tokio::test]
async fn a_provider_models_announcement_carries_the_trimmed_origin_and_a_bad_origin_announces_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let announced = Arc::new(std::sync::Mutex::new(Vec::<(String, Value)>::new()));
    let sink = announced.clone();
    config.announce_to(Arc::new(move |method, params| sink.lock().unwrap().push((method.to_owned(), params))));
    let origin = "o".repeat(128);
    announce_provider_models(&config, &json!({ "origin": format!("  {origin}  ") })).unwrap();
    assert_eq!(*announced.lock().unwrap(), vec![("ui/providerModels/changed".to_owned(), json!({ "origin": origin }))]);
    announced.lock().unwrap().clear();
    for bad in [json!("o".repeat(129)), json!("   "), json!(7)] {
        assert!(announce_provider_models(&config, &json!({ "origin": bad })).is_err(), "{bad}");
    }
    assert!(announced.lock().unwrap().is_empty());
}
