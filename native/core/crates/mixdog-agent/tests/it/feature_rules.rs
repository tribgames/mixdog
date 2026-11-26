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
        json!({ "agent": "worker", "provider": "openai", "model": "gpt-x", "modelDefaults": defaults, "effort": "low", "fast": false, "effortAuto": false });
    let spawn = resolve_agent_spawn_preset(config, &asked, &[]).unwrap();
    assert_eq!((&spawn.preset["effort"], &spawn.preset["fast"], &spawn.preset["effortAuto"]), (&json!("low"), &json!(false), &json!(false)));
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

#[test]
fn a_workflow_agent_assigned_a_preset_name_resolves_that_preset_instead_of_main() {
    let config = json!({
        "default": "main-preset",
        "presets": [
            { "id": "main-preset", "name": "MAIN", "provider": "anthropic", "model": "opus", "effort": "high" },
            {
                "id": "light",
                "name": "LIGHT",
                "provider": "openai",
                "model": "gpt-mini",
                "effort": "low",
                "fast": true,
                "fallbacks": [{ "provider": "google", "model": "gemini-flash" }]
            },
            { "id": "opus-high", "name": "OPUS HIGH", "provider": "anthropic", "model": "opus", "effort": "high" }
        ]
    });
    let config = config.as_object().unwrap();
    let spawn = resolve_agent_spawn_preset(config, &json!({ "agent": "worker" }), &[json!("light")]).unwrap();
    assert_eq!(spawn.preset_name, json!("AGENT WORKER"));
    assert_eq!(
        (&spawn.preset["provider"], &spawn.preset["model"], &spawn.preset["effort"], &spawn.preset["fast"]),
        (&json!("openai"), &json!("gpt-mini"), &json!("low"), &json!(true))
    );
    assert_eq!(spawn.preset["fallbackSource"], json!({ "preset": "light" }));
    assert_eq!(spawn.preset["fallbacks"][0]["provider"], json!("google"));
    assert_eq!(spawn.preset["fallbacks"][0]["model"], json!("gemini-flash"));

    let alias = resolve_agent_spawn_preset(config, &json!({ "agent": "worker" }), &[json!("opus-xhigh")]).unwrap();
    assert_eq!((&alias.preset["provider"], &alias.preset["model"], &alias.preset["effort"]), (&json!("anthropic"), &json!("opus"), &json!("xhigh")));
    assert_eq!(alias.preset["fallbackSource"], json!({ "preset": "opus-high" }));
}

#[test]
fn a_workflow_agent_assigned_a_shipped_default_preset_resolves_it_instead_of_main() {
    let config = json!({
        "default": "main-preset",
        "presets": [
            { "id": "main-preset", "name": "MAIN", "provider": "openai", "model": "gpt-main", "effort": "low" }
        ]
    });
    let config = config.as_object().unwrap();
    let spawn = resolve_agent_spawn_preset(config, &json!({ "agent": "worker" }), &[json!("sonnet-high")]).unwrap();
    assert_eq!(spawn.preset_name, json!("AGENT WORKER"));
    assert_eq!(spawn.preset["provider"], json!("anthropic-oauth"));
    assert_eq!(spawn.preset["effort"], json!("high"));
    assert_ne!(spawn.preset["model"], json!("gpt-main"));
    assert_eq!(spawn.preset["fallbackSource"], json!({ "preset": "sonnet-high" }));
}

#[test]
fn a_synthesized_preset_records_its_backing_stored_preset_in_fallback_source() {
    let config = json!({
        "presets": [
            {
                "id": "opus-high",
                "name": "OPUS HIGH",
                "provider": "anthropic",
                "model": "claude-opus-4-8",
                "effort": "high",
                "fallbacks": [{ "provider": "openai", "model": "gpt-5" }]
            }
        ]
    });
    let config = config.as_object().unwrap();
    let via_agent = resolve_agent_spawn_preset(config, &json!({ "agent": "worker" }), &[json!("opus-xhigh")]).unwrap();
    assert_eq!(via_agent.preset["effort"], json!("xhigh"));
    assert_eq!(via_agent.preset["fallbackSource"], json!({ "preset": "opus-high" }));
    assert_eq!(via_agent.preset["fallbacks"][0]["model"], json!("gpt-5"));

    let via_named = resolve_agent_spawn_preset(config, &json!({ "agent": "worker", "preset": "opus-xhigh" }), &[]).unwrap();
    assert_eq!(via_named.preset["effort"], json!("xhigh"));
    assert_eq!(via_named.preset["fallbackSource"], json!({ "preset": "opus-high" }));
    assert_eq!(via_named.preset["fallbacks"][0]["model"], json!("gpt-5"));
}

#[test]
fn an_incomplete_stored_preset_does_not_shadow_a_valid_shipped_default() {
    let config = json!({
        "default": "main-preset",
        "presets": [
            { "id": "main-preset", "name": "MAIN", "provider": "openai", "model": "gpt-main", "effort": "low" },
            { "id": "sonnet-high", "name": "SONNET HIGH" },
            { "id": "broken-custom", "name": "BROKEN CUSTOM" }
        ]
    });
    let config = config.as_object().unwrap();

    // Agent assignment pointing to `sonnet-high` resolves the valid shipped default instead of Main.
    let spawn = resolve_agent_spawn_preset(config, &json!({ "agent": "worker" }), &[json!("sonnet-high")]).unwrap();
    assert_eq!(spawn.preset_name, json!("AGENT WORKER"));
    assert_eq!(spawn.preset["provider"], json!("anthropic-oauth"));
    assert_eq!(spawn.preset["effort"], json!("high"));
    assert_ne!(spawn.preset["model"], json!("gpt-main"));
    assert_eq!(spawn.preset["fallbackSource"], json!({ "preset": "sonnet-high" }));

    // Explicit `preset: "sonnet-high"` also resolves the valid shipped default.
    let named = resolve_agent_spawn_preset(config, &json!({ "agent": "worker", "preset": "sonnet-high" }), &[]).unwrap();
    assert_eq!(named.preset["provider"], json!("anthropic-oauth"));
    assert_eq!(named.preset["effort"], json!("high"));

    // An incomplete custom preset with no shipped default still reports incomplete route.
    let err = resolve_agent_spawn_preset(config, &json!({ "agent": "worker", "preset": "broken-custom" }), &[]).unwrap_err();
    assert_eq!(err, "agent: preset \"broken-custom\" has no complete route");
}

#[test]
fn a_renamed_complete_stored_override_shadows_the_shipped_default_and_never_resurrects_its_old_name() {
    let config = json!({
        "default": "main-preset",
        "presets": [
            { "id": "main-preset", "name": "MAIN", "provider": "openai", "model": "gpt-main", "effort": "low" },
            { "id": "sonnet-high", "name": "CUSTOM SONNET", "provider": "openai", "model": "gpt-override", "effort": "medium" }
        ]
    });
    let config = config.as_object().unwrap();

    // Looking up by ID or by the renamed display name resolves the stored override.
    let by_id = resolve_agent_spawn_preset(config, &json!({ "agent": "worker", "preset": "sonnet-high" }), &[]).unwrap();
    assert_eq!((&by_id.preset["provider"], &by_id.preset["model"]), (&json!("openai"), &json!("gpt-override")));
    let by_new_name = resolve_agent_spawn_preset(config, &json!({ "agent": "worker", "preset": "CUSTOM SONNET" }), &[]).unwrap();
    assert_eq!((&by_new_name.preset["provider"], &by_new_name.preset["model"]), (&json!("openai"), &json!("gpt-override")));

    // Looking up the old shipped display name `SONNET HIGH` must NOT resurrect the shadowed shipped `sonnet-high` route.
    let err = resolve_agent_spawn_preset(config, &json!({ "agent": "worker", "preset": "SONNET HIGH" }), &[]).unwrap_err();
    assert_eq!(err, "agent: preset \"SONNET HIGH\" not found");

    // An agent candidate pointing to the old shipped display name also must not resurrect shipped `sonnet-high`.
    let via_agent = resolve_agent_spawn_preset(config, &json!({ "agent": "worker" }), &[json!("SONNET HIGH")]).unwrap();
    assert_eq!((&via_agent.preset["provider"], &via_agent.preset["model"]), (&json!("openai"), &json!("gpt-main")));
}

#[test]
fn stored_preset_id_deduplication_is_exact_case_like_core_config() {
    let config = json!({
        "default": "main-preset",
        "presets": [
            { "id": "main-preset", "name": "MAIN", "provider": "openai", "model": "gpt-main", "effort": "low" },
            { "id": "SONNET-HIGH", "name": "CUSTOM", "provider": "openai", "model": "gpt-custom", "effort": "medium" }
        ]
    });
    let config = config.as_object().unwrap();

    // Exact-case dedup matches `mixdog-core-config::workflow::presets`: stored `SONNET-HIGH`
    // does not suppress shipped `sonnet-high` (display name `SONNET HIGH`).
    let custom = resolve_agent_spawn_preset(config, &json!({ "agent": "worker", "preset": "CUSTOM" }), &[]).unwrap();
    assert_eq!((&custom.preset["provider"], &custom.preset["model"]), (&json!("openai"), &json!("gpt-custom")));
    assert_eq!(custom.preset["fallbackSource"], json!({ "preset": "SONNET-HIGH" }));

    let shipped = resolve_agent_spawn_preset(config, &json!({ "agent": "worker", "preset": "SONNET HIGH" }), &[]).unwrap();
    assert_eq!(shipped.preset["provider"], json!("anthropic-oauth"));
    assert_eq!(shipped.preset["effort"], json!("high"));
    assert_eq!(shipped.preset["fallbackSource"], json!({ "preset": "sonnet-high" }));
}
