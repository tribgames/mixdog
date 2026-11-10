use mixdog_core_api::mock::MockStatePublisher;

use super::*;
use crate::config::ConfigLanes;
use crate::config::NoEffects;
use crate::config::SettingsEnv;

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

/// Node's phone table over `setDeveloperOption` (`fixtures/phone-guards/golden.json`, `capability`): turning "Allow all
/// actions" on from a paired phone is refused with Node's code and text and writes nothing; what Node forwarded reaches the
/// setter. The same calls from the desktop are not refused.
#[tokio::test]
async fn a_relay_call_may_not_turn_on_allow_all_actions() {
    let golden: Value =
        serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/phone-guards/golden.json"))).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let env: SettingsEnv = Arc::new(|_| None);
    let settings = Settings::new(config, Arc::new(NoEffects), env);
    let mut seen = 0;
    for step in golden["scenarios"]["capability"].as_array().unwrap() {
        let request = &step["params"][0];
        if request["capability"] != "setDeveloperOption" {
            continue;
        }
        seen += 1;
        let params = json!({ "opId": "op-1", "id": request["args"][0], "enabled": request["args"][1] });
        let before = settings.developer();
        let answer = settings_call(&settings, "config/setDeveloperOption", &params, true).await;
        let frame = &step["frame"];
        if frame["ok"] == true {
            // Forwarded by Node, and the recorded value is the recorder's stand-in's: the relay call is answered as the
            // desktop's is (the same call again: the setter is idempotent).
            let desktop = settings_call(&settings, "config/setDeveloperOption", &params, false).await;
            assert_eq!(format!("{answer:?}"), format!("{desktop:?}"), "{request}");
            continue;
        }
        let Err(CoreError::DomainError { code, message, detail, .. }) = answer else { panic!("{request}: {answer:?}") };
        let mut node = json!({ "ok": false, "error": message.as_deref() });
        if let Some(code) = code.as_deref() {
            node["errorCode"] = json!(code);
        }
        assert_eq!((&node, detail), (frame, None), "{request}");
        assert_eq!(settings.developer(), before, "{request}: nothing written");
        let desktop = settings_call(&settings, "config/setDeveloperOption", &params, false).await;
        assert!(desktop.is_ok(), "{request}: the desktop turns it on: {desktop:?}");
        assert_ne!(settings.developer(), before, "{request}: the desktop's call writes");
    }
    assert_eq!(seen, 3);
}

/// A setter's `TypeError` reaches the window as its message (Node `settings-builtin-tools-api.mjs`
/// `installBuiltinFeature`), which an `invalidParams` answer would not carry.
#[test]
fn a_setter_type_error_answers_its_message() {
    let text = "Built-in feature must be git, memory, office, tidy, localProvider, or autoEffort.";
    match tool(Err(ToolModulesError::InvalidArgument(text.into()))) {
        Err(CoreError::DomainError { code: None, message: Some(message), .. }) => assert_eq!(&*message, text),
        other => panic!("{other:?}"),
    }
}

/// The phone-settings recording (apps/mobile/fixtures/phone-settings), what another paired phone received for each of the
/// phone's successful `updateSetting` and `notifyProviderModelsChanged` calls: the core announces the same events in the same
/// order, `desktop` even for a write that changed nothing, then `agent` when the agent section changed; a provider-models
/// announcement with its trimmed origin. A refused origin announces nothing.
#[tokio::test]
async fn a_phones_setting_write_and_provider_models_call_announce_what_node_broadcast() {
    let golden: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../apps/mobile/fixtures/phone-settings/golden.json"
    )))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("mixdog-config.json");
    std::fs::write(&file, serde_json::to_vec(&golden["world"]["seedConfig"]).unwrap()).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(file, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let announced = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let sink = announced.clone();
    config.announce_to(Arc::new(move |method, params| {
        let event = match method {
            "ui/settings/changed" => "settings-changed",
            "ui/providerModels/changed" => "provider-models-changed",
            other => panic!("unexpected announcement {other}"),
        };
        sink.lock().unwrap().push(json!({ "event": event, "payload": params }));
    }));
    let mut compared = 0;
    for case in golden["cases"].as_array().unwrap() {
        let params = &case["params"];
        let answer = match case["name"].as_str().unwrap() {
            "updateSetting" if case["frame"]["ok"] == true => {
                // The adapter's path of the setting key (shared/desktop-settings.ts `desktopSettingPath`).
                let path = match params[0].as_str().unwrap() {
                    "autoClear" => "agent.autoClear.enabled".to_owned(),
                    "autoCompact" => "agent.compaction.auto".to_owned(),
                    key => format!("desktop.{key}"),
                };
                let write = json!({ "opId": "op-1", "path": path, "value": params[1], "announce": "desktop" });
                value_write(&config, &write, true).await.map(|_| ())
            }
            "notifyProviderModelsChanged" => announce_provider_models(&config, &json!({ "origin": params[0] })).map(|_| ()),
            _ => continue,
        };
        assert_eq!(answer.is_ok(), case["frame"]["ok"] == true, "{params}: {answer:?}");
        let got = std::mem::take(&mut *announced.lock().unwrap());
        assert_eq!(Value::Array(got), case["received"]["otherPhone"], "{params}");
        compared += 1;
    }
    assert_eq!(compared, 13, "the recording's setting writes and provider-models calls");
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
