//! What a compaction re-arms for the model: the late MCP tools announced again by name, and the prompt-settings
//! notice told again in compact form. Only a session whose prompt is never rebuilt at a cold point (a delegated
//! worker, or a prompt with no recorded identity) is re-armed.

use mixdog_core::run_host::rearm::rearm_late_deferred_tools;
use mixdog_core::run_host::rearm::rearm_prompt_settings_notice;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

fn header(session: Value) -> Header {
    session.as_object().expect("a session object").clone()
}

/// A worker that was told `mcp__a__x` at boot; `mcp__a__y` and `mcp__a__z` joined later, only `y` is connected.
fn worker() -> Value {
    json!({
        "owner": "agent",
        "tools": [{ "name": "read" }],
        "deferredAnnouncedTools": ["mcp__a__x"],
        "deferredMcpToolNames": ["mcp__a__x", "mcp__a__y"],
        "deferredLateToolCatalog": [{ "name": "mcp__a__x" }, { "name": "mcp__a__y" }, { "name": "mcp__a__z" }],
        "mcpInstructionsAnnounced": ["a"],
        "mcpInstructionHashes": { "a": "h" },
    })
}

fn announced(session: &Header) -> Vec<String> {
    session["pendingDeferredToolDelta"]["added"].as_array().expect("an added list").iter().map(|tool| tool["name"].as_str().expect("a name").to_owned()).collect()
}

#[test]
fn a_worker_is_told_again_of_the_connected_late_tools_it_never_saw() {
    let mut session = header(worker());
    assert_eq!(rearm_late_deferred_tools(&mut session, 7), Some(vec!["mcp__a__y".to_owned()]));
    assert_eq!(announced(&session), ["mcp__a__y"], "by name: the model was told the description before");
    assert!(!session.contains_key("mcpInstructionsAnnounced") && !session.contains_key("mcpInstructionHashes"), "the instruction text is delivered again");
}

#[test]
fn a_tool_the_session_loaded_or_discovered_is_not_announced_again() {
    let mut loaded = worker();
    loaded["tools"] = json!([{ "name": "read" }, { "name": "mcp__a__y" }]);
    let mut discovered = worker();
    discovered["deferredDiscoveredTools"] = json!(["mcp__a__y"]);
    let mut callable = worker();
    callable["deferredCallableTools"] = json!(["mcp__a__y"]);
    for session in [loaded, discovered, callable] {
        let mut session = header(session);
        assert_eq!(rearm_late_deferred_tools(&mut session, 7), None);
        assert!(!session.contains_key("pendingDeferredToolDelta"));
    }
}

#[test]
fn a_lead_session_with_a_recorded_prompt_identity_keeps_its_announcements_but_forgets_the_instruction_text() {
    let mut session = worker();
    session["owner"] = json!("lead");
    session["promptIdentity"] = json!({ "id": "p" });
    let mut session = header(session);
    assert_eq!(rearm_late_deferred_tools(&mut session, 7), None);
    assert!(!session.contains_key("pendingDeferredToolDelta"));
    assert!(!session.contains_key("mcpInstructionsAnnounced"));
}

#[test]
fn a_session_without_a_tool_list_or_on_a_fixed_surface_is_not_rearmed() {
    let mut without = worker();
    without.as_object_mut().unwrap().remove("tools");
    let mut fixed = worker();
    fixed["deferredProviderMode"] = json!("full");
    for session in [without, fixed] {
        let mut session = header(session);
        assert_eq!(rearm_late_deferred_tools(&mut session, 7), None);
        assert!(!session.contains_key("pendingDeferredToolDelta"));
    }
}

#[test]
fn a_denied_tool_is_not_announced_again() {
    let mut session = worker();
    session["disallowedTools"] = json!(["mcp__a__y"]);
    // Only a bridge session's roster is held to its own policy (`roster_permits`, `tool_surface.rs`); the bridge mode is `bridge-v1`.
    session["toolExposureMode"] = json!("bridge-v1");
    let mut session = header(session);
    assert_eq!(rearm_late_deferred_tools(&mut session, 7), None);
}

#[test]
fn the_prompt_settings_notice_is_rearmed_in_compact_form_for_a_worker_that_was_told_them() {
    for told in ["promptSettingsTold", "promptSettingsNotice"] {
        let mut session = header(json!({ "owner": "agent", "promptIdentity": { "id": "p" }, told: { "revision": 1 } }));
        assert!(rearm_prompt_settings_notice(&mut session), "{told}");
        assert_eq!(Value::Object(session), json!({ "owner": "agent", "promptIdentity": { "id": "p" }, "promptSettingsRecheck": "compact" }));
    }
}

#[test]
fn the_prompt_settings_notice_is_not_rearmed_for_a_lead_or_for_a_session_never_told() {
    let cases = [
        json!({ "owner": "lead", "promptIdentity": { "id": "p" }, "promptSettingsTold": { "revision": 1 } }),
        json!({ "owner": "agent", "promptSettingsTold": null }),
        json!({ "owner": "agent" }),
    ];
    for case in cases {
        let mut session = header(case.clone());
        assert!(!rearm_prompt_settings_notice(&mut session), "{case}");
        assert_eq!(Value::Object(session), case, "nothing changes");
    }
}
