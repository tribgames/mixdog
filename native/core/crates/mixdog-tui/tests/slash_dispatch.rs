//! `runSlashCommand`, the prompt submit and the Tab workflow cycle against a recording fake host: which opener or store call
//! each command reaches, what it reports, and when a busy state refuses it (ports of `slash-dispatch.test.mjs`,
//! `prompt-submit.test.mjs` and `prompt-submit/provider-prompts.test.mjs`). The Node twin of the same code is `slash_twin.rs`.

mod slash_support;

use mixdog_tui::slash::host::{PromptSurface, SlashHost};
use mixdog_tui::slash::submit::panel_write;
use mixdog_tui::slash::workflow_cycle::{CycleGuard, TabCycleOverlays, cycle_workflow_from_prompt, workflow_tab_cycle};
use mixdog_tui::slash::{BTW_USAGE_HINT, on_submit, run_slash_command};
use serde_json::{Value, json};
use slash_support::{Fake, prompt_from, prompt_json};

fn ok(value: Value) -> Result<Value, String> {
    Ok(value)
}

/// The fake store of `slash-dispatch.test.mjs`'s harness.
fn harness() -> Fake {
    let mut fake = Fake::new();
    fake.script("setModel", ok(json!(true)));
    fake.script("setWorkflow", ok(json!({"id": "review"})));
    fake.script("setOutputStyle", ok(json!({"current": {"id": "simple"}})));
    fake.script("getOutputStyle", ok(json!({"current": {"label": "Simple"}})));
    fake.script("listThemes", ok(json!([{"id": "dawn", "label": "Dawn"}, {"id": "dusk", "label": "Dusk"}])));
    fake.script("getTheme", ok(json!("dusk")));
    fake.script("setTheme", ok(json!({"id": "dawn"})));
    fake.script("setEffort", ok(json!("high")));
    fake.script("setFast", ok(json!(false)));
    fake.script("toggleFast", ok(json!(true)));
    fake.script("setAutoClear", ok(json!({"enabled": true, "idleMs": 600_000})));
    fake.script("getAutoClear", ok(json!({"enabled": true, "idleMs": 300_000})));
    fake.script("compact", ok(json!({"changed": true})));
    fake.script("newSession", ok(json!(true)));
    fake.script("clear", ok(Value::Null));
    fake.script("resume", ok(json!(true)));
    fake.script("memoryControl", ok(Value::Null));
    fake.script("goalControl", ok(json!({"message": "Goal paused."})));
    fake.script("inheritSession", ok(json!({"messages": 4, "sessionId": "s9"})));
    fake
}

fn names(fake: &Fake) -> Vec<String> {
    fake.call_names()
}

#[test]
fn btw_with_no_question_shows_the_usage_hint_and_asks_nothing() {
    let mut fake = harness();
    assert!(run_slash_command(&mut fake, "btw", ""));
    assert_eq!(fake.notices(), [(BTW_USAGE_HINT.to_owned(), "warn".to_owned())]);
    assert!(fake.log.iter().all(|entry| entry[0] != "btw"));
}

#[test]
fn btw_asks_the_side_question_while_a_turn_is_running() {
    let mut fake = harness();
    fake.state.busy = true;
    assert!(run_slash_command(&mut fake, "btw", "why?"));
    assert!(fake.log.contains(&json!(["btw", "why?"])));
    assert!(fake.notices().is_empty());
}

#[test]
fn bare_panel_commands_paint_a_loading_frame_and_hand_over_to_their_opener() {
    let mut fake = harness();
    let panels = [
        ("model", "model"),
        ("websearch", "websearch"),
        ("agents", "agents"),
        ("workflow", "workflow"),
        ("outputstyle", "outputstyle"),
        ("theme", "theme"),
        ("effort", "effort"),
        ("project", "project"),
        ("mcp", "mcp"),
        ("skills", "skills"),
        ("plugins", "plugins"),
        ("providers", "providers"),
        ("memory", "memory"),
        ("autoclear", "autoclear"),
        ("resume", "resume"),
        ("usage", "usage"),
        ("context", "context"),
        ("config", "settings"),
        ("profile", "profile"),
        ("update", "update"),
    ];
    for (command, opener) in panels {
        assert!(run_slash_command(&mut fake, command, ""), "{command}");
        assert_eq!(fake.opened().last().map(|(name, _)| name.as_str()), Some(opener), "{command}");
    }
    run_slash_command(&mut fake, "model", "refresh");
    assert_eq!(fake.opened().last(), Some(&("model".to_owned(), json!({"refreshModels": true}))));
    run_slash_command(&mut fake, "agents", "refresh");
    assert_eq!(fake.opened().last(), Some(&("agents".to_owned(), json!({"refreshModels": true}))));
    assert!(!fake.surface_open(), "an opener that painted nothing releases the loading frame");
}

#[test]
fn argument_forms_write_through_the_store_and_report_the_outcome() {
    let mut fake = harness();
    for (command, arg) in [
        ("model", "gpt-x"),
        ("workflow", "review"),
        ("outputstyle", "simple"),
        ("outputstyle", "status"),
        ("theme", "Dawn"),
        ("theme", "status"),
        ("theme", "nope"),
        ("effort", "high"),
        ("fast", "off"),
        ("fast", ""),
        ("fast", "maybe"),
        ("autoclear", "10m"),
        ("autoclear", "status"),
        ("memory", "search x"),
        ("project", "C:/other"),
        ("goal", "pause"),
    ] {
        run_slash_command(&mut fake, command, arg);
    }
    let called = names(&fake);
    assert_eq!(
        called,
        [
            "setModel",
            "setWorkflow",
            "setOutputStyle",
            "getOutputStyle",
            "listThemes",
            "setTheme",
            "listThemes",
            "getTheme",
            "listThemes",
            "setEffort",
            "setFast",
            "toggleFast",
            "setAutoClear",
            "getAutoClear",
            "memoryControl",
            "goalControl"
        ]
    );
    assert_eq!(
        fake.calls().iter().find(|call| call[1] == "setAutoClear").map(|call| call[2].clone()),
        Some(json!([{"duration": "10m"}]))
    );
    assert_eq!(
        fake.calls().iter().find(|call| call[1] == "memoryControl").map(|call| call[2].clone()),
        Some(json!([{"action": "search"}]))
    );
    assert!(fake.log.contains(&json!(["enterProject", "C:/other"])));
    let messages = fake.messages();
    for expected in [
        "Model saved \u{b7} new sessions",
        "Workflow saved \u{b7} new sessions",
        "Output style set to simple.",
        "Output style: Simple",
        "Theme set to dawn",
        "Theme: Dusk",
        "usage: /theme [id]. Available: dawn, dusk",
        "Effort set to high",
        "Fast mode off for openai/gpt-5",
        "usage: /fast [on|off|ultra]",
        // The real `formatDuration` (the Node test stubbed it as whole minutes): 600000 ms is "10m 0s".
        "autoclear on \u{b7} idle 10m 0s",
        "Goal paused.",
    ] {
        assert!(messages.iter().any(|message| message == expected), "{expected}: {messages:?}");
    }
}

#[test]
fn fast_ultra_selects_ultrafast_and_reports_a_model_that_lacks_it() {
    let mut fake = harness();
    run_slash_command(&mut fake, "fast", "ultra");
    assert_eq!(fake.calls().last().map(|call| call[2].clone()), Some(json!(["ultrafast"])));
    assert!(
        fake.notices()
            .iter()
            .any(|(message, _)| message == "Fast mode off for openai/gpt-5" || message == "Ultrafast for openai/gpt-5")
    );
    let mut failing = harness();
    failing.script("setFast", Err("ultrafast is not available for openai/gpt-5".to_owned()));
    run_slash_command(&mut failing, "fast", "ultra");
    assert!(failing.messages().iter().any(|message| message.contains("ultrafast is not available for openai/gpt-5")));
}

#[test]
fn busy_guards_refuse_the_destructive_session_commands_and_say_so() {
    let mut fake = harness();
    fake.state.busy = true;
    for command in ["clear", "outputstyle", "compact", "resume", "inherit", "fork"] {
        let arg = if command == "outputstyle" { "x" } else { "" };
        assert!(!run_slash_command(&mut fake, command, arg), "{command}");
    }
    assert_eq!(
        fake.messages(),
        [
            "wait for the current session command to finish before /clear",
            "wait for the current turn to finish before /OutputStyle",
            "wait for the current turn to finish before /compact",
            "wait for the current turn to finish before /resume",
            "wait for the current turn to finish before /inherit",
            "wait for the current turn to finish before /fork",
        ]
    );
    let mut busy_command = harness();
    busy_command.state.command_busy = true;
    assert!(!run_slash_command(&mut busy_command, "doctor", ""));
    assert!(!run_slash_command(&mut busy_command, "new", ""));
}

#[test]
fn session_commands_report_their_outcomes() {
    let mut fake = harness();
    for (reply, expected) in [
        (json!({"changed": true}), "Compact done."),
        (json!({"changed": false, "reason": "too small"}), "too small"),
        (json!({"changed": false}), "nothing to compact"),
        (Value::Null, "Compact failed."),
        (json!({"error": "x"}), "Compact failed: x"),
    ] {
        fake.script("compact", Ok(reply));
        let before = fake.log.len();
        run_slash_command(&mut fake, "compact", "");
        let reported: Vec<String> = fake.log[before..]
            .iter()
            .filter(|entry| entry[0] == "notice")
            .map(|entry| entry[1].as_str().unwrap_or_default().to_owned())
            .collect();
        assert_eq!(reported, [expected], "{expected}");
    }
    let mut fake = harness();
    for (command, arg) in [
        ("new", ""),
        ("clear", ""),
        ("resume", "abc"),
        ("fork", ""),
        ("inherit", ""),
        ("schedules", ""),
        ("doctor", ""),
        ("quit", ""),
        ("bogus", ""),
    ] {
        run_slash_command(&mut fake, command, arg);
    }
    assert_eq!(names(&fake), ["newSession", "clear", "resume", "inheritSession", "inheritSession"]);
    let messages = fake.messages();
    for expected in [
        "Resumed abc",
        "forked 4 messages into s9",
        "Schedules and webhooks are managed in the Mixdog desktop app",
        "unknown command: /bogus",
    ] {
        assert!(messages.iter().any(|message| message == expected), "{expected}");
    }
    assert!(fake.log.contains(&json!(["doctor"])));
    assert!(fake.log.contains(&json!(["exit"])));
    assert!(fake.log.contains(&json!(["repaint"])));
}

#[test]
fn command_aliases_reach_the_same_panels_and_exit_action() {
    let mut fake = harness();
    for (command, opener) in [
        ("projects", "project"),
        ("style", "outputstyle"),
        ("output-style", "outputstyle"),
        ("setting", "settings"),
        ("config", "settings"),
    ] {
        assert!(run_slash_command(&mut fake, command, ""));
        assert_eq!(fake.opened().last().map(|(name, _)| name.as_str()), Some(opener));
    }
    assert!(run_slash_command(&mut fake, "exit", ""));
    assert!(run_slash_command(&mut fake, "q", ""));
    assert_eq!(fake.log.iter().filter(|entry| entry[0] == "exit").count(), 2);
}

#[test]
fn palette_acceptance_preserves_the_full_new_alias_while_partial_matches_use_clear() {
    use mixdog_tui::slash::commands::{SLASH_COMMANDS, slash_command_token_for_palette_accept};
    let command = SLASH_COMMANDS.iter().find(|entry| entry.name == "clear").expect("clear is registered");
    let mut fake = harness();
    let new_token = slash_command_token_for_palette_accept(command, "/NEW");
    let clear_token = slash_command_token_for_palette_accept(command, "/ne");
    assert_eq!((new_token.as_str(), clear_token.as_str()), ("new", "clear"));
    assert!(run_slash_command(&mut fake, &new_token, ""));
    assert!(run_slash_command(&mut fake, &clear_token, ""));
    assert_eq!(names(&fake), ["newSession", "clear"]);
}

#[test]
fn shells_lists_held_shells_and_releases_one_only_with_confirm() {
    let mut fake = harness();
    fake.script(
        "listShellJobs",
        ok(json!({"jobs": [
            {"taskId": "job_a", "command": "npm run dev"},
            {"taskId": "job_b", "command": "node server.js", "terminationUnconfirmed": true}
        ]})),
    );
    fake.script("releaseShellJob", ok(json!({"released": true})));
    run_slash_command(&mut fake, "shells", "");
    let notices = fake.notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].1, "warn");
    assert!(notices[0].0.contains("job_a  running  npm run dev"));
    assert!(notices[0].0.contains("job_b  termination unconfirmed  node server.js"));
    assert!(notices[0].0.ends_with("Release a held shell with /shells release <task_id>."));
    run_slash_command(&mut fake, "shells", "release job_b");
    assert!(fake.notices()[1].0.contains("may still be running"));
    assert!(fake.notices()[1].0.ends_with("/shells release job_b --confirm"));
    assert!(!names(&fake).contains(&"releaseShellJob".to_owned()), "nothing is released without --confirm");
    run_slash_command(&mut fake, "shells", "release job_b --confirm");
    assert_eq!(
        fake.calls().last().map(|call| (call[1].clone(), call[2].clone())),
        Some((json!("releaseShellJob"), json!(["job_b"])))
    );
    assert_eq!(fake.notices()[2], ("Released job_b.".to_owned(), "info".to_owned()));
}

fn stop_fake(stop_result: Value, jobs: Value) -> Fake {
    let mut fake = harness();
    fake.script("listStoppableShellJobs", ok(json!({"jobs": jobs})));
    fake.script("stopShellJobs", ok(stop_result));
    fake
}

fn two_jobs() -> Value {
    json!([{"taskId": "job_a", "command": "npm run dev"}, {"taskId": "job_b", "command": "tail -f log"}])
}

#[test]
fn stop_says_so_when_no_background_shell_is_running_and_opens_no_prompt() {
    let mut fake = stop_fake(json!({"stopped": 2, "stopping": 0}), json!([]));
    run_slash_command(&mut fake, "stop", "");
    assert_eq!(fake.notices(), [("No background shells are running.".to_owned(), "info".to_owned())]);
    assert!(!fake.surface_open());
    assert!(!names(&fake).contains(&"stopShellJobs".to_owned()));
}

#[test]
fn stop_confirms_once_with_the_commands_and_stops_only_after_the_stop_item() {
    let mut fake = stop_fake(json!({"stopped": 2, "stopping": 0}), two_jobs());
    run_slash_command(&mut fake, "stop", "");
    assert!(fake.log.contains(&json!(["paintStop", "Stop background shells (2)?", ["npm run dev", "tail -f log"]])));
    assert!(!names(&fake).contains(&"stopShellJobs".to_owned()), "nothing is stopped before the confirmation");
    fake.select("stop");
    assert_eq!(names(&fake).last().map(String::as_str), Some("stopShellJobs"));
    assert_eq!(fake.notices(), [("Stopped background shells: 2".to_owned(), "info".to_owned())]);
    assert!(!fake.surface_open());
}

#[test]
fn cancelling_the_stop_prompt_stops_nothing() {
    let mut fake = stop_fake(json!({"stopped": 2, "stopping": 0}), two_jobs());
    run_slash_command(&mut fake, "stop", "");
    fake.select("cancel");
    assert!(!names(&fake).contains(&"stopShellJobs".to_owned()));
    assert!(fake.notices().is_empty());
    assert!(!fake.surface_open());
    run_slash_command(&mut fake, "stop", "");
    fake.cancel();
    assert!(!names(&fake).contains(&"stopShellJobs".to_owned()));
    assert!(!fake.surface_open());
}

#[test]
fn stop_reports_shells_that_are_still_stopping() {
    let mut fake = stop_fake(json!({"stopped": 1, "stopping": 1}), two_jobs());
    run_slash_command(&mut fake, "stop", "");
    fake.select("stop");
    assert_eq!(
        fake.notices(),
        [("Stopped background shells: 1 \u{b7} still stopping: 1".to_owned(), "warn".to_owned())]
    );
}

#[test]
fn stop_shows_a_failed_listing_or_stop_as_the_plain_error_message() {
    let mut listing = harness();
    listing.script("listStoppableShellJobs", Err("list failed".to_owned()));
    run_slash_command(&mut listing, "stop", "");
    assert_eq!(listing.notices(), [("list failed".to_owned(), "error".to_owned())]);
    let mut stopping = stop_fake(json!(null), two_jobs());
    stopping.script("stopShellJobs", Err("stop failed".to_owned()));
    run_slash_command(&mut stopping, "stop", "");
    stopping.select("stop");
    assert_eq!(stopping.notices(), [("stop failed".to_owned(), "error".to_owned())]);
}

// ----------------------------------------------------------- prompt submit

fn settings_fake(prompt: Value) -> Fake {
    let mut fake = harness();
    fake.settings = Some(prompt_from(&prompt));
    fake
}

#[test]
fn a_second_settings_submit_is_refused_while_the_first_write_is_in_flight() {
    let mut fake = settings_fake(json!({"kind": "system-shell", "label": "System shell"}));
    fake.script("setSystemShell", ok(json!(true)));
    // The first submit began a write that has not been acknowledged yet.
    let target = fake.settings.clone().expect("a settings prompt");
    let token = panel_write::begin(&mut fake, PromptSurface::Settings, &target);
    assert!(panel_write::in_flight(&fake, PromptSurface::Settings));
    assert!(!on_submit(&mut fake, "bash"), "refused: the draft is kept and no overlapping write starts");
    assert!(!names(&fake).contains(&"setSystemShell".to_owned()));
    assert!(fake.notices().iter().any(|(message, tone)| tone == "warn" && message.contains("settings change")));
    panel_write::finish(&mut fake, PromptSurface::Settings, token, |host| {
        host.push_notice("acknowledged", mixdog_tui::slash::host::Tone::Info);
    });
    assert_eq!(fake.closed_prompts("settings"), 1);
    assert!(!panel_write::in_flight(&fake, PromptSurface::Settings));
}

#[test]
fn an_ack_superseded_by_esc_never_closes_the_live_prompt_or_navigates() {
    let mut fake = settings_fake(json!({"kind": "system-shell", "label": "System shell"}));
    fake.script("setSystemShell", ok(json!(true)));
    // Esc on the prompt hands the surface back while the write is in flight.
    fake.esc_during_call = true;
    assert!(on_submit(&mut fake, "pwsh"));
    assert_eq!(fake.closed_prompts("settings"), 0);
    assert!(fake.opened().is_empty());
    // A fresh prompt and submit: the abandoned write does not block it.
    fake.esc_during_call = false;
    assert!(on_submit(&mut fake, "bash"));
    assert_eq!(fake.closed_prompts("settings"), 1);
    assert_eq!(fake.opened(), [("settings".to_owned(), json!({}))]);
}

#[test]
fn a_rejected_settings_write_restores_the_typed_value_instead_of_closing() {
    let mut fake = settings_fake(json!({"kind": "system-shell", "label": "System shell"}));
    fake.script("setSystemShell", Err("daemon offline".to_owned()));
    assert!(on_submit(&mut fake, "pwsh -NoLogo"));
    assert_eq!(fake.closed_prompts("settings"), 0);
    let restored = fake.last_prompt("settings").expect("the prompt is restored");
    assert_eq!(restored["kind"], "system-shell");
    assert_eq!(restored["initialValue"], "pwsh -NoLogo");
    assert!(restored.get("submitting").is_none());
    assert!(restored["restoreEpoch"].as_u64().unwrap_or(0) >= 1);
    assert!(fake.notices().iter().any(|(message, tone)| tone == "error" && message.contains("daemon offline")));
}

#[test]
fn empty_submits_reach_the_daemon_as_the_documented_reset_and_clear_actions() {
    let mut shell = settings_fake(json!({"kind": "system-shell", "label": "System shell"}));
    shell.script("setSystemShell", ok(json!(true)));
    assert!(on_submit(&mut shell, ""));
    assert_eq!(shell.calls().last().map(|call| call[2].clone()), Some(json!([""])));
    assert_eq!(shell.closed_prompts("settings"), 1);

    let mut auto_clear =
        settings_fake(json!({"kind": "autoclear-provider", "label": "Auto-clear", "provider": "openai"}));
    auto_clear.script("setAutoClear", ok(json!({"enabled": true})));
    assert!(on_submit(&mut auto_clear, ""));
    assert_eq!(
        auto_clear.calls().last().map(|call| call[2].clone()),
        Some(json!([{"provider": "openai", "resetProvider": true}]))
    );
    assert!(auto_clear.messages().iter().any(|message| message.contains("default reset")));

    let mut profile = settings_fake(json!({"kind": "profile-title", "label": "Profile"}));
    profile.script("setProfile", ok(json!({"title": ""})));
    assert!(on_submit(&mut profile, ""));
    assert_eq!(profile.calls().last().map(|call| call[2].clone()), Some(json!([{"title": ""}])));
    assert!(profile.messages().iter().any(|message| message.contains("Title cleared")));
}

#[test]
fn the_prompt_log_shape_hides_the_callback_flags() {
    let prompt =
        prompt_from(&json!({"kind": "oauth-code", "providerName": "Grok", "_login": "ok", "_afterSave": true}));
    assert_eq!(prompt_json(&prompt), json!({"kind": "oauth-code", "providerName": "Grok"}));
}

fn oauth_fake(prompt: Value) -> Fake {
    let mut fake = harness();
    fake.provider = Some(prompt_from(&prompt));
    fake
}

#[test]
fn an_accepted_oauth_code_clears_the_in_flight_guard_and_returns_to_the_caller() {
    let mut fake =
        oauth_fake(json!({"kind": "oauth-code", "providerName": "Grok", "_login": "ok", "_successReturn": true}));
    assert!(on_submit(&mut fake, "abc#state"));
    assert!(!fake.oauth_submitting());
    let tail: Vec<Value> = fake
        .log
        .iter()
        .filter(|entry| !matches!(entry[0].as_str(), Some("setPrompt" | "markSubmitting" | "oauth" | "notice")))
        .cloned()
        .collect();
    assert_eq!(tail, [json!(["completeCode", "abc#state"]), json!(["clearCaches", "all"]), json!(["successReturn"])]);
    assert!(fake.messages().contains(&"Grok login complete".to_owned()));
}

#[test]
fn an_oauth_code_prompt_whose_login_is_gone_still_releases_the_in_flight_guard() {
    let mut fake = oauth_fake(json!({"kind": "oauth-code", "providerName": "Grok", "_failureReturn": true}));
    assert!(on_submit(&mut fake, "abc#state"));
    assert!(!fake.oauth_submitting());
    assert_eq!(fake.log.iter().filter(|entry| entry[0] == "failureReturn").count(), 1);
    assert!(fake.notices().iter().any(|(message, tone)| message.starts_with("oauth code failed") && tone == "error"));
    assert_eq!(fake.last_prompt("provider"), Some(Value::Null));
}

#[test]
fn an_oauth_code_completion_that_throws_releases_the_in_flight_guard() {
    let mut fake = oauth_fake(json!({"kind": "oauth-code", "providerName": "Grok", "_login": "throw:bad state"}));
    assert!(on_submit(&mut fake, "abc#state"));
    assert!(!fake.oauth_submitting());
    assert!(fake.messages().contains(&"oauth code failed: bad state".to_owned()));
}

#[test]
fn express_mode_vertex_key_saves_with_auth_mode_api_key_and_other_saves_send_no_options() {
    let save = |prompt: Value, value: &str| {
        let mut fake = oauth_fake(prompt);
        fake.script("saveProviderApiKey", ok(Value::Null));
        on_submit(&mut fake, value);
        fake.calls().into_iter().map(|call| call[2].clone()).collect::<Vec<_>>()
    };
    assert_eq!(
        save(
            json!({"kind": "api-key", "providerId": "vertex-ai", "authMode": "api-key", "_afterSave": true}),
            "AQ.key"
        ),
        [json!(["vertex-ai", "AQ.key", {"authMode": "api-key"}])]
    );
    assert_eq!(
        save(json!({"kind": "api-key", "providerId": "vertex-ai", "_afterSave": true}), "{}"),
        [json!(["vertex-ai", "{}"])]
    );
}

#[test]
fn a_provider_write_is_refused_while_another_is_in_flight() {
    let mut fake = oauth_fake(json!({"kind": "api-key", "providerId": "openai"}));
    fake.script("saveProviderApiKey", ok(Value::Null));
    let target = fake.provider.clone().expect("a provider prompt");
    panel_write::begin(&mut fake, PromptSurface::Provider, &target);
    assert!(!on_submit(&mut fake, "k"));
    assert!(fake.messages().contains(&"API key is already being saved".to_owned()));
    assert!(names(&fake).is_empty());
}

#[test]
fn a_missing_service_method_is_reported_as_a_failed_write() {
    let mut fake = oauth_fake(json!({"kind": "api-key", "providerId": "openai"}));
    assert!(on_submit(&mut fake, "k"));
    assert!(
        fake.messages()
            .contains(&"api key save failed: project service method saveProviderApiKey is unavailable".to_owned())
    );
}

#[test]
fn a_blank_submit_is_refused_unless_a_prompt_takes_it() {
    let mut fake = harness();
    assert!(!on_submit(&mut fake, "   "));
    assert!(fake.log.is_empty());
}

#[test]
fn a_slash_line_runs_the_command_and_a_busy_session_refuses_it() {
    let mut fake = harness();
    assert!(on_submit(&mut fake, "/theme dawn"));
    assert_eq!(names(&fake), ["listThemes", "setTheme"]);
    fake.state.command_busy = true;
    assert!(!on_submit(&mut fake, "/theme dusk"));
    assert_eq!(fake.messages().last().map(String::as_str), Some("wait for the current command to finish"));
}

// ------------------------------------------------------- Tab workflow cycle

fn cycle_fake() -> Fake {
    let mut fake = harness();
    fake.clock = 10_000;
    fake.script(
        "listWorkflows",
        ok(json!([{"id": "wf0", "name": "Default WF", "active": true}, {"id": "wf1"}, {"id": "wf2"}])),
    );
    fake.script("setWorkflow", ok(json!({"id": "wf1"})));
    fake
}

#[test]
fn the_tab_cycle_advances_to_the_next_workflow_and_a_key_repeat_is_swallowed() {
    let mut fake = cycle_fake();
    let mut guard = CycleGuard::default();
    assert!(cycle_workflow_from_prompt(&mut fake, &mut guard));
    assert_eq!(fake.calls().last().map(|call| call[2].clone()), Some(json!(["wf1"])));
    assert!(fake.log.contains(&json!(["noticeTtl", "Workflow saved \u{b7} new sessions", "info", 1200])));
    let calls = fake.calls().len();
    fake.clock += 100;
    assert!(cycle_workflow_from_prompt(&mut fake, &mut guard));
    assert_eq!(fake.calls().len(), calls, "a repeat inside the guard window does nothing");
    fake.clock += 400;
    assert!(cycle_workflow_from_prompt(&mut fake, &mut guard));
    assert!(fake.calls().len() > calls);
}

#[test]
fn the_tab_cycle_is_swallowed_by_a_surface_that_owns_the_keys() {
    let mut fake = cycle_fake();
    let mut guard = CycleGuard::default();
    for overlays in [
        TabCycleOverlays { slash_palette_open: true, ..TabCycleOverlays::default() },
        TabCycleOverlays { picker: true, ..TabCycleOverlays::default() },
        TabCycleOverlays { tool_approval: true, ..TabCycleOverlays::default() },
        TabCycleOverlays { usage_panel: true, ..TabCycleOverlays::default() },
    ] {
        assert!(workflow_tab_cycle(&mut fake, &mut guard, overlays));
    }
    assert!(fake.log.is_empty());
    fake.state.command_busy = true;
    assert!(workflow_tab_cycle(&mut fake, &mut guard, TabCycleOverlays::default()));
    assert!(fake.log.is_empty(), "a running session command swallows the key");
}

#[test]
fn the_tab_cycle_reports_an_empty_list_a_single_workflow_and_a_failure() {
    let mut none = cycle_fake();
    none.script("listWorkflows", ok(json!([])));
    cycle_workflow_from_prompt(&mut none, &mut CycleGuard::default());
    assert_eq!(none.notices(), [("no workflows available".to_owned(), "warn".to_owned())]);
    let mut one = cycle_fake();
    one.script("listWorkflows", ok(json!([{"id": "only", "name": "Only"}])));
    cycle_workflow_from_prompt(&mut one, &mut CycleGuard::default());
    assert_eq!(one.notices(), [("Workflow: Only".to_owned(), "info".to_owned())]);
    let mut failing = cycle_fake();
    failing.script("setWorkflow", Err("no set".to_owned()));
    let mut guard = CycleGuard::default();
    cycle_workflow_from_prompt(&mut failing, &mut guard);
    assert_eq!(failing.notices(), [("Couldn\u{2019}t switch workflow: no set".to_owned(), "error".to_owned())]);
    assert!(!guard.pending);
}

// --------------------------------------------------------- skill mention list

#[test]
fn the_skill_list_is_fetched_only_while_a_mention_is_typed_and_kept_when_the_fetch_fails() {
    use mixdog_tui::slash::palette::fetch_mention_skills;
    let mut fake = harness();
    fake.script("skillsStatus", ok(json!({"skills": [{"name": "pdf"}]})));
    assert_eq!(fetch_mention_skills(&mut fake, false), None);
    assert!(fake.log.is_empty(), "no mention, no fetch");
    assert_eq!(fetch_mention_skills(&mut fake, true), Some(vec![json!({"name": "pdf"})]));
    fake.script("skillsStatus", ok(json!({"skills": "none"})));
    assert_eq!(fetch_mention_skills(&mut fake, true), Some(Vec::new()));
    fake.script("skillsStatus", Err("down".to_owned()));
    assert_eq!(fetch_mention_skills(&mut fake, true), None);
}
