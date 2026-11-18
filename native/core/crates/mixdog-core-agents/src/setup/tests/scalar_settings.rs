//! The scalar setting actions: the argument rules each applies before it writes, what it stores
//! and the answer it gives.

use serde_json::json;

use super::*;

async fn human_service(dir: &Path, pending: bool) -> (SetupService, Config, Arc<mixdog_core_base::quota_resume::QuotaResumeStore>) {
    let world = Arc::new(World::default());
    *world.caller.lock().unwrap() = "human".into();
    settings_service(dir, json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, pending).await
}

#[tokio::test]
async fn the_switches_store_what_was_asked_and_answer_it() {
    let dir = tempfile::tempdir().unwrap();
    let (service, config, _) = human_service(dir.path(), false).await;

    let titles = settings_call(&service, &json!({ "action": "set_ai_session_titles", "enabled": false })).await.unwrap();
    assert_eq!(titles["aiSessionTitles"], false);
    assert_eq!(config.agent()["aiSessionTitles"], false);

    let heartbeat = settings_call(&service, &json!({ "action": "set_heartbeat_enabled", "enabled": true })).await.unwrap();
    assert_eq!(heartbeat["heartbeat"], true);
    assert_eq!(config.agent()["heartbeat"], true);
    assert_eq!(heartbeat["appliesTo"], "Mixy's next heartbeat check; no restart required");

    let reactions = settings_call(&service, &json!({ "action": "set_reactions_enabled", "enabled": false })).await.unwrap();
    assert_eq!(reactions["reactions"], false);
    assert_eq!(config.agent()["reactions"], false);

    // `enabled` must be a boolean: a word is not one.
    for action in ["set_ai_session_titles", "set_heartbeat_enabled", "set_reactions_enabled", "set_auto_update", "set_quota_auto_resume"] {
        let error = settings_call(&service, &json!({ "action": action, "enabled": "yes" })).await.unwrap_err();
        assert_eq!(error, "enabled (boolean) is required", "{action}");
    }
}

#[tokio::test]
async fn the_heartbeat_interval_is_one_of_the_offered_choices() {
    let dir = tempfile::tempdir().unwrap();
    let (service, config, _) = human_service(dir.path(), false).await;
    let error = settings_call(&service, &json!({ "action": "set_heartbeat_interval", "minutes": 45 })).await.unwrap_err();
    assert_eq!(error, "heartbeat interval must be one of 30, 60, 120, 240 minutes");
    assert!(config.agent().get("heartbeatIntervalMinutes").is_none(), "a refused value is not stored");
    let set = settings_call(&service, &json!({ "action": "set_heartbeat_interval", "minutes": 120 })).await.unwrap();
    assert_eq!(set["intervalMinutes"], 120);
    assert_eq!(config.agent()["heartbeatIntervalMinutes"], 120);
}

#[tokio::test]
async fn turning_the_update_switch_off_stores_it_and_answers_the_update_state() {
    let dir = tempfile::tempdir().unwrap();
    let (service, config, _) = human_service(dir.path(), false).await;
    let off = settings_call(&service, &json!({ "action": "set_auto_update", "enabled": false })).await.unwrap();
    assert_eq!(off["autoUpdate"], false);
    assert_eq!(config.agent()["update"]["auto"], false);
    let on = settings_call(&service, &json!({ "action": "set_auto_update", "enabled": true })).await.unwrap();
    assert_eq!(on["autoUpdate"], true);
}

#[tokio::test]
async fn turning_quota_auto_resume_off_drops_the_pending_resumes_and_on_keeps_them() {
    let dir = tempfile::tempdir().unwrap();
    let (service, config, store) = human_service(dir.path(), true).await;
    assert_eq!(store.list().len(), 1);
    let on = settings_call(&service, &json!({ "action": "set_quota_auto_resume", "enabled": true })).await.unwrap();
    assert_eq!(on["quotaAutoResume"], true);
    assert_eq!(on["appliesTo"], "subsequent usage-limit stops; turning it off cancels pending resumes");
    assert_eq!(store.list().len(), 1, "turning it on drops nothing");
    assert!(config.quota_auto_resume_enabled());

    let off = settings_call(&service, &json!({ "action": "set_quota_auto_resume", "enabled": false })).await.unwrap();
    assert_eq!(off["quotaAutoResume"], false);
    assert!(store.list().is_empty(), "the pending resume was dropped");
    assert!(!config.quota_auto_resume_enabled());
}

#[tokio::test]
async fn a_profile_needs_a_field_and_only_ids_the_pickers_offer() {
    let dir = tempfile::tempdir().unwrap();
    let (service, ..) = human_service(dir.path(), false).await;
    for args in [json!({ "action": "set_profile" }), json!({ "action": "set_profile", "profile": {} }), json!({ "action": "set_profile", "profile": "Dr" })] {
        assert_eq!(settings_call(&service, &args).await.unwrap_err(), "profile with title, language, or experienceLevel is required", "{args}");
    }
    let bad_language = settings_call(&service, &json!({ "action": "set_profile", "profile": { "language": "klingon" } })).await.unwrap_err();
    assert!(bad_language.starts_with("profile.language must be one of \""), "{bad_language}");
    let bad_level = settings_call(&service, &json!({ "action": "set_profile", "profile": { "experienceLevel": "wizard" } })).await.unwrap_err();
    assert!(bad_level.starts_with("profile.experienceLevel must be one of \"\", \""), "the empty level is a choice: {bad_level}");

    let language = mixdog_core_config::config::PROFILE_LANGUAGES[0].0;
    let level = mixdog_core_config::config::PROFILE_EXPERIENCE_LEVELS[0].0;
    let saved = settings_call(&service, &json!({ "action": "set_profile", "profile": { "title": "Dr", "language": language, "experienceLevel": level } })).await.unwrap();
    assert_eq!((saved["title"].clone(), saved["language"].clone(), saved["experienceLevel"].clone()), (json!("Dr"), json!(language), json!(level)));
}

#[tokio::test]
async fn an_agent_cannot_turn_on_allow_all_actions_and_a_warned_option_needs_the_persons_acceptance() {
    let dir = tempfile::tempdir().unwrap();
    let (service, config, _) = human_service(dir.path(), false).await;
    let option = |name: &str, enabled: bool, accepted: Option<bool>| {
        let mut args = json!({ "action": "set_developer_option", "name": name, "enabled": enabled });
        if let Some(accepted) = accepted {
            args["riskAccepted"] = json!(accepted);
        }
        args
    };
    assert_eq!(
        settings_call(&service, &option("nope", true, None)).await.unwrap_err(),
        "Unknown developer option \"nope\"; read status developer"
    );
    assert_eq!(
        settings_call(&service, &option("allowAllActions", true, Some(true))).await.unwrap_err(),
        "\"Allow all actions\" cannot be turned on by an agent; only the person can turn it on in Settings → Developer options.",
        "accepting the risk is no help: the person turns this on"
    );
    let unaccepted = settings_call(&service, &option("cursorOAuth", true, None)).await.unwrap_err();
    assert!(unaccepted.starts_with("Enabling Cursor requires riskAccepted:true after the user explicitly accepts: "), "{unaccepted}");
    assert!(config.agent().get("developer").is_none(), "nothing was stored");

    let accepted = settings_call(&service, &option("cursorOAuth", true, Some(true))).await.unwrap();
    let cursor = accepted["developer"]["sections"][1]["options"].as_array().unwrap().iter().find(|o| o["id"] == "cursorOAuth").unwrap().clone();
    assert_eq!(cursor["enabled"], true);
    // Turning a warned option off needs no acceptance.
    let off = settings_call(&service, &option("cursorOAuth", false, None)).await.unwrap();
    assert_eq!(off["developer"]["sections"][1]["options"][1]["enabled"], false);
    // The registry is not an object: a missing name is the text "undefined".
    let unnamed = settings_call(&service, &json!({ "action": "set_developer_option", "enabled": true })).await.unwrap_err();
    assert_eq!(unnamed, "Unknown developer option \"undefined\"; read status developer");
}

#[tokio::test]
async fn prompt_cache_warming_is_stored_once_the_settings_are_wired() {
    let dir = tempfile::tempdir().unwrap();
    let (service, config, _) = human_service(dir.path(), false).await;
    let off = json!({ "action": "set_cache_warming_enabled", "enabled": false });
    let error = settings_call(&service, &off).await.unwrap_err();
    assert_eq!(error, "the scalar settings are not wired", "the service was built without them");

    let service = service.with_settings(Settings::new(config, Arc::new(NoEffects), Arc::new(|_| None)));
    let answered = settings_call(&service, &off).await.unwrap();
    assert_eq!(answered["promptCacheWarming"], false);
    assert_eq!(answered["appliesTo"], "the next prompt-cache warm of every session; no restart required");
}

#[tokio::test]
async fn the_bot_order_keeps_trimmed_distinct_ids_in_order_and_refuses_anything_else_whole() {
    let dir = tempfile::tempdir().unwrap();
    let (service, config, _) = human_service(dir.path(), false).await;
    let service = service.with_settings(Settings::new(config.clone(), Arc::new(NoEffects), Arc::new(|_| None)));
    let order = |ids: serde_json::Value| json!({ "action": "set_bot_order", "botOrder": ids });

    let saved = settings_call(&service, &order(json!(["beta", " alpha ", "beta", "gamma"]))).await.unwrap();
    assert_eq!(saved["botOrder"], json!(["beta", "alpha", "gamma"]));
    assert_eq!(saved["appliesTo"], "the Bots page and the Sessions bot section on every device");
    assert_eq!(config.agent()["botOrder"], json!(["beta", "alpha", "gamma"]));

    let too_many: Vec<String> = (0..501).map(|n| format!("b{n}")).collect();
    for junk in [json!("beta"), json!(null), json!([1]), json!([{ "id": "a" }]), json!(["a", ""]), json!(["a", "  "]), json!(["x".repeat(129)]), json!(too_many)] {
        let error = settings_call(&service, &order(junk.clone())).await.unwrap_err();
        assert!(error.contains("an array of agent ids"), "{junk}: {error}");
    }
    assert_eq!(config.agent()["botOrder"], json!(["beta", "alpha", "gamma"]), "a refused order changes nothing");

    // 128 characters is the longest id; an empty list clears the order.
    assert!(settings_call(&service, &order(json!(["x".repeat(128)]))).await.is_ok());
    let cleared = settings_call(&service, &order(json!([]))).await.unwrap();
    assert_eq!(cleared["botOrder"], json!([]));
    assert!(config.agent().get("botOrder").is_none());
}

#[tokio::test]
async fn auto_clears_the_system_shell_and_a_command_is_stored_unquoted() {
    let dir = tempfile::tempdir().unwrap();
    let (service, config, _) = human_service(dir.path(), false).await;
    let shell = |command: &str| json!({ "action": "set_system_shell", "command": command });
    #[cfg(windows)]
    let (command, quoted) = ("pwsh.exe", "\"pwsh.exe\"");
    #[cfg(not(windows))]
    let (command, quoted) = ("/bin/zsh", "'/bin/zsh'");

    let set = settings_call(&service, &shell(quoted)).await.unwrap();
    assert_eq!((set["command"].clone(), set["source"].clone()), (json!(command), json!("config")));
    assert_eq!(config.agent()["shell"]["command"], command);

    for clear in ["auto", " AUTO ", ""] {
        let cleared = settings_call(&service, &shell(clear)).await.unwrap();
        assert_eq!((cleared["command"].clone(), cleared["source"].clone()), (json!(""), json!("auto")), "{clear:?}");
        settings_call(&service, &shell(command)).await.unwrap();
    }
}

#[cfg(windows)]
#[tokio::test]
async fn on_windows_only_powershell_can_be_the_system_shell() {
    let dir = tempfile::tempdir().unwrap();
    let (service, config, _) = human_service(dir.path(), false).await;
    for command in ["cmd.exe", "C:\\Windows\\System32\\bash.exe", "/bin/sh"] {
        let error = settings_call(&service, &json!({ "action": "set_system_shell", "command": command })).await.unwrap_err();
        assert_eq!(error, "system shell command must be powershell.exe or pwsh on Windows", "{command}");
    }
    assert!(config.agent().get("shell").is_none(), "a refused shell is not stored");
    for command in ["powershell.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "PWSH"] {
        assert!(settings_call(&service, &json!({ "action": "set_system_shell", "command": command })).await.is_ok(), "{command}");
    }
}

#[cfg(not(windows))]
#[tokio::test]
async fn off_windows_any_command_can_be_the_system_shell() {
    let dir = tempfile::tempdir().unwrap();
    let (service, ..) = human_service(dir.path(), false).await;
    let set = settings_call(&service, &json!({ "action": "set_system_shell", "command": "fish" })).await.unwrap();
    assert_eq!(set["effective"], "fish");
}
