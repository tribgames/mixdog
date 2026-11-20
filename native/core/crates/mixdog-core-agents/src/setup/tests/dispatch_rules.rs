//! The setup tool's dispatcher: who may change settings, what a receipt says, which actions the
//! dispatcher itself serves (voice, the desktop-hosted features, `open`, `status`) and how it
//! answers an action nobody owns.

use std::sync::Mutex;

use serde_json::Value;
use serde_json::json;

use super::*;

/// An owner that accepts the actions the gate tests name and answers that it ran.
struct Accepts;

#[async_trait]
impl SetupActions for Accepts {
    fn actions(&self) -> &'static [&'static str] {
        &[
            "create_definition",
            "delete_definition",
            "set_agent_route",
            "run_automation",
            "set_automation_enabled",
            "delete_automation",
            "save_automation",
            "read_definition",
            "connect_connector",
        ]
    }
    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        Ok(json!({ "ran": call.action }))
    }
}

fn as_caller(world: &World, who: &str) {
    *world.caller.lock().unwrap() = who.to_owned();
}

/// A dispatcher over a fresh config; `who` calls.
async fn gate(dir: &Path, world: &Arc<World>) -> SetupService {
    let (service, ..) = settings_service(dir, json!({ "agent": {}, "desktop": { "zoom": 1 } }), world, false).await;
    service.with_actions(Arc::new(Accepts))
}

#[tokio::test]
async fn a_room_member_a_background_run_and_an_unattended_run_cannot_change_settings() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    let change = json!({ "action": "set_ai_session_titles", "enabled": true });
    for (who, refusal) in [
        ("room", "A group-room member cannot change settings (setup set_ai_session_titles)"),
        ("headless", "A background run cannot change settings (setup set_ai_session_titles)"),
        // A human session that cannot be opened has no caller record: a background run.
        ("open_fails", "A background run cannot change settings (setup set_ai_session_titles)"),
        ("unattended", "An unattended run cannot change settings (setup set_ai_session_titles)"),
    ] {
        as_caller(&world, who);
        assert_eq!(settings_call(&service, &change).await.unwrap_err(), refusal, "{who}");
    }
    // Reading is open to all of them.
    as_caller(&world, "headless");
    let status = settings_call(&service, &json!({ "action": "status", "domain": "capabilities" })).await.unwrap();
    assert_eq!(status["domain"], "capabilities");
}

#[tokio::test]
async fn an_unattended_run_may_only_manage_automations_and_its_own_agents_route() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    as_caller(&world, "unattended");
    for args in [
        json!({ "action": "run_automation" }),
        json!({ "action": "save_automation" }),
        json!({ "action": "set_automation_enabled", "enabled": true }),
        json!({ "action": "delete_automation" }),
        json!({ "action": "set_agent_route", "agent": "helper" }),
    ] {
        assert!(settings_call(&service, &args).await.is_ok(), "{args}");
    }
    let other = settings_call(&service, &json!({ "action": "set_agent_route", "agent": "someone-else" })).await.unwrap_err();
    assert_eq!(other, "This thread manages only its own agent's settings (setup set_agent_route)");
}

#[tokio::test]
async fn an_agents_thread_changes_only_its_own_settings() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    as_caller(&world, "agent");
    let own = |agent: &str| json!({ "action": "set_agent_route", "agent": agent });
    assert!(settings_call(&service, &own("helper")).await.is_ok());
    assert!(settings_call(&service, &own("  helper ")).await.is_ok(), "the name is trimmed");
    assert_eq!(settings_call(&service, &own("writer")).await.unwrap_err(), "This thread manages only its own agent's settings (setup set_agent_route)");
    assert!(settings_call(&service, &json!({ "action": "set_agent_route" })).await.is_err(), "no name is not the agent's own");
    // A human's session is not bound to one agent.
    as_caller(&world, "human");
    assert!(settings_call(&service, &own("writer")).await.is_ok());
}

#[tokio::test]
async fn a_heartbeat_turn_only_pauses_a_routine_or_runs_one() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    as_caller(&world, "heartbeat");
    let refused = |action: &str| {
        format!("A heartbeat turn only pauses a routine or runs one again (setup {action} is refused); propose other changes with session action suggest")
    };
    assert!(settings_call(&service, &json!({ "action": "run_automation" })).await.is_ok());
    assert!(settings_call(&service, &json!({ "action": "set_automation_enabled", "enabled": false })).await.is_ok());
    assert_eq!(settings_call(&service, &json!({ "action": "set_automation_enabled", "enabled": true })).await.unwrap_err(), refused("set_automation_enabled"));
    assert_eq!(settings_call(&service, &json!({ "action": "delete_automation" })).await.unwrap_err(), refused("delete_automation"));
    // Even reading is refused.
    assert_eq!(settings_call(&service, &json!({ "action": "status" })).await.unwrap_err(), refused("status"));
}

#[tokio::test]
async fn an_agent_definition_changes_only_from_mixy_the_person_or_a_session_acting_as_her() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    let create = json!({ "action": "create_definition", "definitionKind": "agent", "definition": { "body": "b" } });
    let denied = "Only Mixy (the representative agent) can create, edit or delete agents (setup create_definition); ask the user to do it with Mixy or in the Agents settings";
    for (who, allowed) in [("human", true), ("mixy_acting", true), ("acting", false), ("agent", false)] {
        as_caller(&world, who);
        match settings_call(&service, &create).await {
            Ok(_) => assert!(allowed, "{who} was let through"),
            Err(error) => assert!(!allowed && error == denied, "{who}: {error}"),
        }
    }
    // The rule is about agents: a workflow definition is open to an agent's thread.
    as_caller(&world, "agent");
    let workflow = json!({ "action": "create_definition", "definitionKind": "workflow", "definition": { "body": "b" } });
    assert!(settings_call(&service, &workflow).await.is_ok());
    // A room member and a background run are told what they are, not what Mixy is.
    as_caller(&world, "room");
    assert_eq!(settings_call(&service, &create).await.unwrap_err(), "A group-room member cannot change settings (setup create_definition)");
}

#[tokio::test]
async fn a_saved_setting_answers_a_receipt_and_a_read_or_a_background_action_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    as_caller(&world, "human");
    let saved = settings_call(&service, &json!({ "action": "set_ai_session_titles", "enabled": false })).await.unwrap();
    let keys: Vec<&str> = saved.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(&keys[..3], ["saved", "scope", "appliesTo"], "the receipt leads with its own fields, then the result's");
    assert_eq!((saved["saved"].clone(), saved["scope"].clone()), (json!(true), json!("installation")));
    assert_eq!(saved["appliesTo"], "titles generated from now on; existing titles are unchanged");
    assert_eq!(saved["aiSessionTitles"], false);

    // An action with no sentence of its own applies to new sessions.
    let other = settings_call(&service, &json!({ "action": "create_definition", "definitionKind": "agent", "definition": { "body": "b" } })).await.unwrap();
    assert_eq!(other["appliesTo"], "new sessions unless appliedToCurrentSession is true");

    // Starting work is not saving a setting.
    let started = settings_call(&service, &json!({ "action": "run_automation" })).await.unwrap();
    assert!(started.get("saved").is_none() && started["scope"] == "installation" && started["ran"] == "run_automation");
    // A read answers the bare result.
    let read = settings_call(&service, &json!({ "action": "read_definition" })).await.unwrap();
    assert_eq!(read, json!({ "ran": "read_definition" }));
}

#[tokio::test]
async fn an_action_nobody_owns_is_unavailable_and_a_missing_action_is_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    as_caller(&world, "human");
    assert_eq!(
        settings_call(&service, &json!({ "action": "set_hook_rule_enabled" })).await.unwrap_err(),
        "setup set_hook_rule_enabled has no owner registered"
    );
    for args in [json!({}), json!({ "action": "  " }), json!({ "action": 3 })] {
        assert_eq!(settings_call(&service, &args).await.unwrap_err(), "action must be one of the setup actions", "{args}");
    }
}

#[tokio::test]
async fn the_github_connector_is_refused_before_anything_else_whoever_asks() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    let message = "GitHub uses the signed-in GitHub CLI; no connector needed. Use the github tool or Settings → Git.";
    for who in ["human", "headless"] {
        as_caller(&world, who);
        for name in ["github", " GitHub "] {
            assert_eq!(settings_call(&service, &json!({ "action": "connect_connector", "connector": name })).await.unwrap_err(), message);
        }
    }
    assert!(settings_call(&service, &json!({ "action": "connect_connector", "connector": "gmail" })).await.is_ok());
}

#[tokio::test]
async fn voice_must_end_in_the_state_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    as_caller(&world, "human");
    let toggle = |enabled: bool| json!({ "action": "set_builtin_enabled", "name": "voice", "enabled": enabled });
    let on = settings_call(&service, &toggle(true)).await.unwrap();
    assert_eq!(on["voice"], json!({ "enabled": true, "installed": true, "components": { "whisper": true } }));
    assert_eq!(on["appliesTo"], "channel voice transcription and Desktop dictation now");
    // `install_builtin` of voice enables it too.
    let installed = settings_call(&service, &json!({ "action": "install_builtin", "name": "voice" })).await.unwrap();
    assert_eq!(installed["voice"]["enabled"], true);

    // The install failed: not enabled, and the reason is passed on.
    *world.voice.lock().unwrap() = "fail".into();
    assert_eq!(settings_call(&service, &toggle(true)).await.unwrap_err(), "Voice did not reach the requested installed and enabled state: download failed");
    // Turning it off needs only the switch to be off.
    assert_eq!(settings_call(&service, &toggle(false)).await.unwrap()["voice"]["enabled"], false);
    // A runtime that answered the opposite and gave no reason.
    *world.voice.lock().unwrap() = "silent".into();
    assert_eq!(settings_call(&service, &toggle(true)).await.unwrap_err(), "Voice did not reach the requested installed and enabled state");
    assert_eq!(settings_call(&service, &toggle(false)).await.unwrap_err(), "Voice did not reach the requested disabled state");
}

#[tokio::test]
async fn the_desktop_features_and_the_desktop_actions_go_to_the_window_and_say_so_when_none_takes_them() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    as_caller(&world, "human");
    // Browser and computer run in the window; with none attached nothing changed.
    for name in ["browser", "computer"] {
        let error = settings_call(&service, &json!({ "action": "set_builtin_enabled", "name": name, "enabled": true })).await.unwrap_err();
        assert_eq!(error, "setup: no attached Desktop surface; nothing was changed", "{name}");
    }
    let forwarded = settings_call(&service, &json!({ "action": "save_project", "project": { "path": "/p" } })).await.unwrap();
    assert_eq!(forwarded["desktopHandled"], "save_project");
    assert_eq!(forwarded["echo"]["project"]["path"], "/p", "the request goes to the window whole");
    assert_eq!(forwarded["saved"], true);
}

#[tokio::test]
async fn a_toggle_names_a_known_feature_and_a_boolean() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    let service = gate(dir.path(), &world).await;
    as_caller(&world, "human");
    let refused = |args: Value| {
        let service = &service;
        async move { settings_call(service, &args).await.unwrap_err() }
    };
    assert!(refused(json!({ "action": "set_builtin_enabled", "name": "memory", "enabled": true })).await.starts_with("name must be one of git, office, tidy"));
    assert!(refused(json!({ "action": "install_builtin", "name": "media" })).await.starts_with("name must be one of git, memory, office"));
    assert_eq!(refused(json!({ "action": "set_memory_enabled", "enabled": "yes" })).await, "enabled (boolean) is required");
    assert_eq!(refused(json!({ "action": "set_recap_enabled" })).await, "enabled (boolean) is required");
    assert!(refused(json!({ "action": "set_instruction_files", "instructionFiles": "everything" })).await.starts_with("instructionFiles must be one of"));
    assert!(refused(json!({ "action": "set_auto_effort_base", "autoEffortBase": "" })).await.starts_with("autoEffortBase must be one of"));
}

// ---- open -----------------------------------------------------------------------------------

#[tokio::test]
async fn open_navigates_an_attached_ui_and_otherwise_tells_where_to_go() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    as_caller(&world, "human");
    let (service, ..) = settings_service(dir.path(), json!({ "agent": {}, "desktop": { "zoom": 1 } }), &world, false).await;
    let taking = Arc::new(OpenUi(true, Mutex::default()));
    let service = service.with_ui(taking.clone());
    let opened = settings_call_on(&service, "sess_a", &json!({ "action": "open", "target": " mcp " })).await.unwrap();
    assert_eq!(opened["opened"], true);
    assert_eq!(opened["target"], "mcp");
    assert_eq!(opened["note"], "The attached app navigated to this surface; the user completes the step there.");
    assert_eq!(*taking.1.lock().unwrap(), [("sess_a".to_owned(), "mcp".to_owned())]);

    // A session with no id has no UI to drive.
    let none = settings_call_on(&service, "", &json!({ "action": "open", "target": "mcp" })).await.unwrap();
    assert_eq!(none["opened"], false);
    assert_eq!(taking.1.lock().unwrap().len(), 1, "no navigation for a session-less call");
    assert_eq!(none["note"], "No interactive UI is attached to this session. Tell the user where to go: Desktop: Extensions → Connectors tab · TUI: /mcp");

    let declining = Arc::new(OpenUi(false, Mutex::default()));
    let second = tempfile::tempdir().unwrap();
    let (service, ..) = settings_service(second.path(), json!({ "agent": {} }), &world, false).await;
    let service = service.with_ui(declining);
    let declined = settings_call_on(&service, "sess_a", &json!({ "action": "open", "target": "theme" })).await.unwrap();
    assert_eq!(declined["opened"], false);
    assert!(declined["note"].as_str().unwrap().ends_with("Desktop: Settings → Theme · TUI: /theme"));

    let error = settings_call_on(&service, "sess_a", &json!({ "action": "open", "target": "bogus" })).await.unwrap_err();
    assert!(error.starts_with("target must be one of settings, providers, model, websearch"), "{error}");
    assert!(error.ends_with("voice, connection"), "{error}");
}

// ---- status ---------------------------------------------------------------------------------

/// Answers its domain with what it was asked, so a test sees what the dispatcher passed on.
struct Echo;

#[async_trait]
impl StatusReader for Echo {
    fn domains(&self) -> &'static [&'static str] {
        &["mcp"]
    }
    async fn read(&self, domain: &str, detail: bool, thread: &ThreadId) -> Result<Value, PortError> {
        Ok(json!({ "asked": domain, "detail": detail, "thread": thread.as_str(), "domain": "overwritten" }))
    }
}

/// A window that takes every request and answers what it was asked.
struct Window;

#[async_trait]
impl SetupDesktop for Window {
    async fn request(&self, _: &ThreadId, args: &Value) -> Result<DesktopAnswer, PortError> {
        Ok(DesktopAnswer::Done(json!({ "window": args })))
    }
}

#[tokio::test]
async fn status_answers_the_domain_asked_and_says_so_when_a_domain_has_no_reader() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    as_caller(&world, "human");
    let (service, ..) = settings_service(dir.path(), json!({ "agent": {} }), &world, false).await;
    let service = service.with_status(Arc::new(Echo));

    let answered = settings_call_on(&service, "sess_a", &json!({ "action": "status", "domain": " mcp ", "detail": true })).await.unwrap();
    assert_eq!(answered["asked"], "mcp");
    assert_eq!(answered["detail"], true);
    assert_eq!(answered["thread"], "sess_a");
    assert_eq!(answered["domain"], "overwritten", "the reader's own fields follow `domain`");
    assert_eq!(answered.as_object().unwrap().keys().next().unwrap(), "domain");
    // Only `detail: true` itself asks for detail.
    let truthy = settings_call_on(&service, "sess_a", &json!({ "action": "status", "domain": "mcp", "detail": "yes" })).await.unwrap();
    assert_eq!(truthy["detail"], false);

    // No domain is the summary, which nobody registered here.
    let summary = settings_call(&service, &json!({ "action": "status" })).await.unwrap_err();
    assert_eq!(summary, "the summary status reader is not wired");
    let unknown = settings_call(&service, &json!({ "action": "status", "domain": "weather" })).await.unwrap_err();
    assert!(unknown.starts_with("domain must be one of summary, model, agents, workflow"), "{unknown}");
    // The capabilities table needs no reader.
    let capabilities = settings_call(&service, &json!({ "action": "status", "domain": "capabilities" })).await.unwrap();
    assert_eq!(capabilities["domain"], "capabilities");
    assert!(capabilities.as_object().unwrap().len() > 1);
}

#[tokio::test]
async fn the_desktop_domains_of_status_are_read_by_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let world = Arc::new(World::default());
    as_caller(&world, "human");
    let (service, ..) = settings_service(dir.path(), json!({ "agent": {} }), &world, false).await;
    // `Desktop` of the shared fixture claims no status request.
    let error = settings_call(&service, &json!({ "action": "status", "domain": "appearance" })).await.unwrap_err();
    assert_eq!(error, "setup: no attached Desktop surface; nothing was changed");

    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let publisher = Arc::new(MockStatePublisher::default());
    let (config, _) = Config::open(dir.path().join("window.json"), publisher.clone(), lanes).await.unwrap();
    let modules = ToolModules::with_env(config.clone(), Arc::new(Host(watch::channel(0).0)), publisher, CancellationToken::new(), Arc::new(|_| None));
    let service = SetupService::new(config, modules, Arc::new(Callers(world.clone())), Arc::new(Window), Arc::new(Voice(world)));
    for domain in ["desktop", "appearance", "projects", "connection"] {
        let shown = settings_call(&service, &json!({ "action": "status", "domain": domain })).await.unwrap();
        assert_eq!(shown["domain"], domain);
        assert_eq!(shown["window"], json!({ "action": "status", "domain": domain }));
    }
}
