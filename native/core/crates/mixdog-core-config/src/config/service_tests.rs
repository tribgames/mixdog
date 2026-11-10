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
            if let Err(CoreError::DomainError { message, .. }) = &answer {
                assert!(!message.as_deref().unwrap_or_default().contains("over remote access"), "{request}: {message:?}");
            }
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
