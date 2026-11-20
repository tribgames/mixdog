//! The stored form of an agent's connector policy and the rule that a remote change never gives a
//! tool more authority. A tool's effective level in one policy is: 0 when its account is off,
//! else the topmost entry for the tool, else the default (asks, for the stored policy; the most
//! permissive reading, auto, for the policy being written).

use serde_json::Value;
use serde_json::json;

use super::*;

fn stored(input: Value) -> Result<Option<Value>, String> {
    policy_input(&input)
}

fn allowed(before: Value, after: Value) -> bool {
    assert_not_widened(Some(&before), Some(&after), None).is_ok()
}

fn tools(connector: &str, tool: &str, permission: &str) -> Value {
    json!({ "off": [], "tools": { connector: { tool: permission } } })
}

#[test]
fn a_policy_is_saved_trimmed_sorted_and_without_what_means_nothing() {
    assert_eq!(
        stored(json!({ "off": ["b ", " a", "a", ""], "tools": { " gmail ": { "send": "auto", " read ": "needs_approval", "bad": "maybe", " ": "auto" } } })),
        Ok(Some(json!({ "off": ["a", "b"], "tools": { "gmail": { "send": "auto", "read": "needs_approval" } } })))
    );
    // A policy that switches nothing off and overrides nothing is no policy.
    for none in [Value::Null, json!({ "off": [] }), json!({ "off": ["  "], "tools": { "gmail": { "send": "maybe" } } })] {
        assert_eq!(stored(none.clone()), Ok(None), "{none}");
    }
    // Overrides alone keep the policy, with an empty switch list.
    assert_eq!(stored(json!({ "tools": { "gmail": { "send": "disabled" } } })), Ok(Some(json!({ "off": [], "tools": { "gmail": { "send": "disabled" } } }))));
}

#[test]
fn a_connector_list_is_refused_as_a_policy() {
    let error = stored(json!([{ "id": "gmail", "enabled": true }])).unwrap_err();
    assert_eq!(error, "connectors must be { off: [connector id…], tools? } or null");
}

#[test]
fn a_remote_change_may_switch_a_connector_off_or_lower_a_tool() {
    assert!(assert_not_widened(None, Some(&json!({ "off": ["gmail"] })), None).is_ok(), "switching off from no policy");
    assert!(allowed(json!({ "off": ["gmail"] }), json!({ "off": ["drive", "gmail"] })));
    assert!(allowed(tools("gmail", "send", "auto"), tools("gmail", "send", "needs_approval")));
    assert!(allowed(tools("gmail", "send", "auto"), tools("gmail", "send", "disabled")));
    assert!(allowed(tools("gmail", "send", "needs_approval"), tools("gmail", "send", "needs_approval")), "no change");
}

#[test]
fn a_remote_change_may_not_switch_a_connector_back_on_or_raise_a_tool() {
    let refused =
        |before: Value, after: Value| assert_eq!(assert_not_widened(Some(&before), Some(&after), None), Err(NO_WIDEN.to_owned()), "{before} -> {after}");
    refused(json!({ "off": ["gmail"] }), json!({ "off": [] }));
    refused(json!({ "off": ["gmail", "drive"] }), json!({ "off": ["gmail"] }));
    refused(tools("gmail", "send", "disabled"), tools("gmail", "send", "needs_approval"));
    refused(tools("gmail", "send", "needs_approval"), tools("gmail", "send", "auto"));
    // A tool with no override asks; the written policy's default reads as auto, so a new override
    // can only be as low as asking.
    refused(json!({ "off": [] }), tools("gmail", "send", "auto"));
    assert!(allowed(json!({ "off": [] }), tools("gmail", "send", "needs_approval")));
    assert!(allowed(json!({ "off": [] }), tools("gmail", "send", "disabled")));
    // Removing an override gives the tool its default back, which is more than a lowered level.
    refused(tools("gmail", "send", "disabled"), json!({ "off": [] }));
    refused(tools("gmail", "send", "needs_approval"), json!({ "off": [] }));
}

#[test]
fn a_policy_that_cannot_be_trusted_can_only_be_replaced_on_the_desktop() {
    // A stored policy that cannot be read, and an old connector list, can be neither narrowed nor widened remotely.
    assert!(assert_not_widened(Some(&json!("garbage")), Some(&json!({ "off": ["gmail"] })), None).is_err());
    assert!(assert_not_widened(Some(&json!([{ "id": "gmail", "enabled": true }])), Some(&json!({ "off": ["gmail"] })), None).is_err());
}

#[test]
fn the_accounts_of_a_connector_share_a_tool_and_an_account_that_is_off_does_not_hold_back_its_siblings() {
    // `gmail-2` stays off, but the plain `gmail` account is on: raising the shared tool widens it.
    let before = json!({ "off": ["gmail-2"], "tools": { "gmail": { "send": "needs_approval" } } });
    let after = json!({ "off": ["gmail-2"], "tools": { "gmail": { "send": "auto" } } });
    assert!(assert_not_widened(Some(&before), Some(&after), None).is_err());
    // Switching off a second account narrows.
    let narrower = json!({ "off": ["gmail", "gmail-2"], "tools": { "gmail": { "send": "needs_approval" } } });
    assert!(assert_not_widened(Some(&before), Some(&narrower), None).is_ok());
}

fn approval(server: &str, from: Permission, to: Permission) -> ApprovedToolChange {
    ApprovedToolChange { server: server.into(), tool: "send".into(), from, to }
}

#[test]
fn inside_an_approved_change_exactly_that_tool_may_go_to_the_approved_level() {
    let change = approval("gmail", Permission::NeedsApproval, Permission::Auto);
    let before = json!({ "off": ["drive"], "tools": { "gmail": { "send": "needs_approval", "read": "disabled" } } });
    let judge = |after: Value| assert_not_widened(Some(&before), Some(&after), Some(&change));

    assert!(judge(json!({ "off": ["drive"], "tools": { "gmail": { "send": "auto", "read": "disabled" } } })).is_ok());
    // The same write without the approval is a widening.
    assert!(assert_not_widened(Some(&before), Some(&json!({ "off": ["drive"], "tools": { "gmail": { "send": "auto", "read": "disabled" } } })), None).is_err());
    // Nothing else goes with it: another tool, a switched-on connector, or another level.
    for after in [
        json!({ "off": ["drive"], "tools": { "gmail": { "send": "auto", "read": "needs_approval" } } }),
        json!({ "off": [], "tools": { "gmail": { "send": "auto", "read": "disabled" } } }),
        json!({ "off": ["drive"], "tools": { "gmail": { "send": "needs_approval", "read": "disabled" } } }),
        json!({ "off": ["drive"], "tools": { "gmail": { "read": "disabled" } } }),
    ] {
        assert_eq!(judge(after.clone()), Err(NO_WIDEN.to_owned()), "{after}");
    }
}

#[test]
fn an_approved_change_keeps_a_restriction_that_landed_after_the_card_and_skips_one_already_there() {
    let change = approval("gmail", Permission::NeedsApproval, Permission::Auto);
    let landing = tools("gmail", "send", "auto");
    // The tool was switched off while the card was open: that newer restriction stays.
    assert_eq!(
        assert_not_widened(Some(&tools("gmail", "send", "disabled")), Some(&landing), Some(&change)),
        Err("A newer restriction on this tool landed meanwhile; it was kept.".to_owned())
    );
    let still_off = json!({ "off": ["gmail"], "tools": { "gmail": { "send": "auto" } } });
    assert_eq!(
        assert_not_widened(Some(&json!({ "off": ["gmail"], "tools": { "gmail": { "send": "needs_approval" } } })), Some(&still_off), Some(&change)),
        Err("A newer restriction on this tool landed meanwhile; it was kept.".to_owned()),
        "switching the connector off is a restriction too"
    );
    assert_eq!(
        assert_not_widened(Some(&tools("gmail", "send", "auto")), Some(&landing), Some(&change)),
        Err("The tool already has this permission or more; nothing changed.".to_owned())
    );
}

#[test]
fn an_approved_change_of_one_account_lands_on_its_connector_and_a_legacy_list_is_never_approved() {
    let change = approval("gmail-2", Permission::Disabled, Permission::NeedsApproval);
    assert!(assert_not_widened(Some(&tools("gmail", "send", "disabled")), Some(&tools("gmail", "send", "needs_approval")), Some(&change)).is_ok());
    // A stored connector list or an unreadable policy refuses even the approved change.
    let after = tools("gmail", "send", "needs_approval");
    assert_eq!(assert_not_widened(Some(&json!([{ "id": "gmail", "enabled": true }])), Some(&after), Some(&change)), Err(NO_WIDEN.to_owned()));
    assert_eq!(assert_not_widened(Some(&json!("garbage")), Some(&after), Some(&change)), Err(NO_WIDEN.to_owned()));
}
