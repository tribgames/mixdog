//! Pure rules of the agent: the tail reminder, the model family, and the native tool-search payload.

use mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset;
use mixdog_agent::env::TailReminder;
use mixdog_agent::native_search::parse_native_tool_search;
use mixdog_agent::tail_rules::RuleTailReminder;
use mixdog_agent::tail_rules::TailContext;
use mixdog_agent::tail_rules::TailLanguage;
use mixdog_agent::tail_rules::TailRole;
use mixdog_agent::tail_rules::TailRule;
use mixdog_agent::tail_rules::model_family_id;
use serde_json::json;

/// A rule of the shape a built-in one takes, for the matching and the sending of a reminder.
pub(crate) const KOREAN_ON_OPUS: &[TailRule] = &[TailRule {
    id: "test-korean",
    provider: &[],
    model: &["claude-opus-5-5"],
    language: &["ko"],
    role: &["lead", "bot"],
    text: "Write all user-facing text in {language}.",
}];

fn reminder(role: TailRole, language: Option<(&str, &str)>) -> RuleTailReminder {
    let language = language.map(|(id, name)| TailLanguage { id: id.into(), name: name.into() });
    RuleTailReminder { context: TailContext { provider: "anthropic".into(), language, role }, rules: KOREAN_ON_OPUS }
}

#[test]
fn a_matching_rule_is_sent_as_its_text_wrapped_as_one_system_reminder() {
    let text = reminder(TailRole::Lead, Some(("ko", "Korean"))).text("claude-opus-5-5").unwrap();
    assert_eq!(text, "<system-reminder>Write all user-facing text in Korean.</system-reminder>");
    assert!(reminder(TailRole::Bot, Some(("ko", "Korean"))).text("claude-opus-5-5").is_some());
}

#[test]
fn the_reminder_needs_every_tag_to_hold_model_language_and_role() {
    let korean = Some(("ko", "Korean"));
    assert_eq!(reminder(TailRole::Lead, korean).text("claude-sonnet-4-5"), None, "another model");
    assert_eq!(reminder(TailRole::Lead, Some(("en", "English"))).text("claude-opus-5-5"), None, "another language");
    assert_eq!(reminder(TailRole::Lead, None).text("claude-opus-5-5"), None, "no language block");
    assert_eq!(reminder(TailRole::Worker, korean).text("claude-opus-5-5"), None, "a worker session");
}

#[test]
fn a_model_family_drops_its_date_and_routing_prefix_so_snapshots_share_a_rule() {
    assert_eq!(model_family_id("claude-opus-5-5"), "claude-opus-5-5");
    assert_eq!(model_family_id("claude-opus-5-5-20251101"), "claude-opus-5-5");
    assert_eq!(model_family_id("anthropic/claude-opus-5-5"), "claude-opus-5-5");
    assert_eq!(model_family_id("Claude-Opus-5-5"), "claude-opus-5-5");
    assert!(reminder(TailRole::Lead, Some(("ko", "Korean"))).text("claude-opus-5-5-20251101").is_some());
}

#[test]
fn a_tool_loading_result_with_a_native_payload_gives_its_references_and_a_summary() {
    let result = json!({ "nativeToolSearch": { "provider": " OpenAI ", "toolReferences": [" read ", "", "grep"] } }).to_string();
    let parsed = parse_native_tool_search("tool_search", &result).unwrap();
    assert_eq!(parsed["provider"], "openai");
    assert_eq!(parsed["toolReferences"], json!(["read", "grep"]));
    assert_eq!(parsed["summary"], "Loaded deferred tools: read, grep");
    // The key order is the wire's.
    assert_eq!(parsed.as_object().unwrap().keys().collect::<Vec<_>>(), ["provider", "toolReferences", "openaiTools", "summary"]);
}

#[test]
fn the_summary_names_missing_and_blocked_tools_and_a_given_summary_wins() {
    let result = json!({
        "nativeToolSearch": { "toolReferences": ["a"], "summary": "Loaded a" },
        "selected": { "tools": { "missing": ["x", " y "], "blocked": [{ "name": "z", "reason": "no" }, { "name": "w" }, ["skip"]] } },
    })
    .to_string();
    let parsed = parse_native_tool_search("load_tool", &result).unwrap();
    assert_eq!(parsed["summary"], "Loaded a\nmissing: x, y; blocked: z (no), w");
}

#[test]
fn a_result_without_a_usable_payload_or_from_another_tool_carries_none() {
    let payload = json!({ "nativeToolSearch": { "toolReferences": ["a"] } }).to_string();
    assert_eq!(parse_native_tool_search("bash", &payload), None, "only the tool-loading tools carry one");
    assert_eq!(parse_native_tool_search("tool_search", "not json"), None);
    assert_eq!(parse_native_tool_search("tool_search", "{}"), None);
    let empty = json!({ "nativeToolSearch": { "toolReferences": [" "], "openaiTools": [{ "type": 5, "name": "n" }] } }).to_string();
    assert_eq!(parse_native_tool_search("tool_search", &empty), None, "nothing usable in it");
}

#[test]
fn a_named_preset_is_the_route_a_spawned_worker_runs_on_and_remembers_where_it_came_from() {
    let config = json!({ "presets": [{ "id": "mine", "provider": "openai", "model": "gpt-x" }] });
    let spawn = resolve_agent_spawn_preset(config.as_object().unwrap(), &json!({ "agent": "worker", "preset": "mine" }), &[]).unwrap();
    assert_eq!(spawn.preset_name, json!("mine"));
    assert_eq!((&spawn.preset["provider"], &spawn.preset["model"]), (&json!("openai"), &json!("gpt-x")));
    assert_eq!(spawn.preset["fallbackSource"], json!({ "preset": "mine" }));
}

#[test]
fn a_spawn_that_names_its_model_runs_on_it_directly_with_the_pickers_defaults_under_what_it_asked() {
    let config = json!({});
    let config = config.as_object().unwrap();
    let defaults = json!({ "effort": "high", "fast": true });
    let args = json!({ "agent": "worker", "provider": "openai", "model": "gpt-x", "modelDefaults": defaults });
    let spawn = resolve_agent_spawn_preset(config, &args, &[]).unwrap();
    assert_eq!(spawn.preset_name, json!("__direct__"));
    assert_eq!(spawn.preset["id"], json!("__direct__"));
    assert_eq!((&spawn.preset["provider"], &spawn.preset["model"]), (&json!("openai"), &json!("gpt-x")));
    assert_eq!((&spawn.preset["effort"], &spawn.preset["fast"]), (&json!("high"), &json!(true)));
    assert!(spawn.preset.get("fallbacks").is_none());
    let asked =
        json!({ "agent": "worker", "provider": "openai", "model": "gpt-x", "modelDefaults": defaults, "effort": "low", "fast": false, "autoEffort": false });
    let spawn = resolve_agent_spawn_preset(config, &asked, &[]).unwrap();
    assert_eq!((&spawn.preset["effort"], &spawn.preset["fast"], &spawn.preset["autoEffort"]), (&json!("low"), &json!(false), &json!(false)));
}

#[test]
fn a_spawn_with_no_route_to_run_on_fails_naming_what_is_missing() {
    let config = json!({ "presets": [{ "id": "mine", "provider": "openai", "model": "gpt-x" }] });
    let config = config.as_object().unwrap();
    let ghost = resolve_agent_spawn_preset(config, &json!({ "agent": "worker", "preset": "ghost" }), &[]).unwrap_err();
    assert_eq!(ghost, "agent: preset \"ghost\" not found");
    let unassigned = resolve_agent_spawn_preset(config, &json!({ "agent": "worker" }), &[]).unwrap_err();
    assert_eq!(unassigned, "agent: agent \"worker\" has no Main model assignment");
}
