//! The rule a notification's Allow follows (`approval_notification.rs`), written from the rule with inline inputs: the decision each kind
//! of approval gets (the one the card's 한 번만 허용 sends, `apps/desktop/src/shared/approval-enter-rule.ts` `approvalAllowOnceDecision`,
//! pinned on the JS side by `shared/approval-enter-rule.test.mjs`: change one, change the other), the approvals a bare Allow never
//! takes, and the two facts behind the relay's refusal of a bare Allow for an approval only a click allows. Unlike `approval_notification_tests.rs`
//! these compare nothing recorded.

use serde_json::Value;
use serde_json::json;

use super::allow_once_decision;
use super::bare_allow;
use super::pointer_only;

fn permission(scopes: Value) -> Value {
    json!({ "kind": "permission", "permission": { "scopes": scopes } })
}

#[test]
fn a_tool_or_outbound_approval_is_allowed_once_with_a_bare_allow_and_an_office_commit_says_approve() {
    assert_eq!(allow_once_decision(&json!({ "kind": "approval", "name": "shell", "args": { "command": "npm test" } })), Some(json!({ "approved": true })));
    assert_eq!(allow_once_decision(&json!({ "kind": "outbound", "outbound": { "category": "comment" } })), Some(json!({ "approved": true })));
    assert_eq!(allow_once_decision(&json!({ "name": "shell" })), Some(json!({ "approved": true })), "a card without a kind is a tool approval");
    assert_eq!(
        allow_once_decision(&json!({ "kind": "approval", "name": "Office", "args": { "action": "Commit" } })),
        Some(json!({ "approved": true, "response": "approve" }))
    );
}

#[test]
fn a_permission_is_allowed_once_with_its_narrowest_once_type_option_the_first_of_that_kind() {
    let both = permission(json!([
        { "id": "a", "kind": "allow_always" },
        { "id": "s", "kind": "allow_session" },
        { "id": "o", "kind": "allow_once" },
        { "id": "o2", "kind": "allow_once" },
    ]));
    assert_eq!(allow_once_decision(&both), Some(json!({ "approved": true, "scope": "o" })));
    let session = permission(json!([{ "id": "a", "kind": "allow_always" }, { "id": "s", "kind": "allow_session" }]));
    assert_eq!(allow_once_decision(&session), Some(json!({ "approved": true, "scope": "s" })));
    assert_eq!(allow_once_decision(&permission(json!([{ "id": "once" }]))), Some(json!({ "approved": true, "scope": "once" })), "no kind: read by its id");
    assert_eq!(allow_once_decision(&permission(json!([{ "id": "x", "kind": "ALLOW_ONCE" }]))), Some(json!({ "approved": true, "scope": "x" })), "kinds read in lower case");
}

#[test]
fn what_a_bare_enter_does_not_allow_has_no_once_decision() {
    for approval in [
        json!({ "kind": "outbound", "outbound": { "category": "payment" } }),
        json!({ "kind": "outbound", "outbound": { "category": "delete" } }),
        json!({ "kind": "approval", "name": "office", "args": { "action": "rollback" } }),
        json!({ "kind": "approval", "name": "office", "args": { "action": "discard" } }),
        json!({ "kind": "connector" }),
        permission(json!([{ "id": "always", "kind": "allow_always" }])),
        permission(json!([{ "id": "no", "kind": "reject" }])),
        permission(json!([])),
        json!({ "kind": "takeover" }),
        json!({ "kind": "secret" }),
        json!({ "kind": "question" }),
        json!({ "kind": "something-new" }),
        Value::Null,
        json!([]),
    ] {
        assert_eq!(allow_once_decision(&approval), None, "{approval}");
    }
}

#[test]
fn a_bare_allow_is_an_approval_without_a_response_and_only_a_click_allows_what_is_pointer_only() {
    // The relay's refusal (`refuses_remote_allow`) is this pair of facts for the approval the thread shows: the answer is a bare Allow, and
    // the approval is one only a click on its card may allow.
    assert!(bare_allow(&json!({ "approved": true })));
    assert!(bare_allow(&json!({ "approved": true, "response": null })));
    assert!(!bare_allow(&json!({ "approved": true, "response": "approve" })), "an answer that says what it approves is no bare Allow");
    assert!(!bare_allow(&json!({ "approved": false })));
    assert!(!bare_allow(&json!({})));
    for approval in [
        json!({ "kind": "outbound", "outbound": { "category": "payment" } }),
        json!({ "kind": "outbound", "outbound": { "category": "delete" } }),
        json!({ "kind": "approval", "name": "Office", "args": { "action": "Rollback" } }),
        json!({ "kind": "approval", "name": "office", "args": { "action": "discard" } }),
        json!({ "kind": "connector" }),
    ] {
        assert!(pointer_only(approval.as_object().unwrap()), "{approval}");
    }
    for approval in [
        json!({ "kind": "approval", "name": "shell" }),
        json!({ "kind": "outbound", "outbound": { "category": "comment" } }),
        json!({ "kind": "approval", "name": "office", "args": { "action": "commit" } }),
        permission(json!([{ "id": "o", "kind": "allow_once" }])),
    ] {
        assert!(!pointer_only(approval.as_object().unwrap()), "{approval}");
    }
}