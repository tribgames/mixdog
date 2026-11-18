//! The usage-limit stop of a failed member turn: only a refusal no wait can change ends the exchange.

use serde_json::json;

use super::room_usage_limit;

#[test]
fn a_turn_that_did_not_fail_is_no_usage_limit() {
    assert!(room_usage_limit(&json!({ "status": "completed", "quota": { "provider": "p" } }), &json!(null)).is_none());
    assert!(room_usage_limit(&json!(null), &json!(null)).is_none());
}

#[test]
fn a_failed_turn_with_a_quota_names_its_provider_model_and_reset() {
    let done = json!({ "status": "failed", "quota": { "provider": "openai", "model": "gpt-x", "resetAt": 1_800_000_000_000_i64 } });
    let usage = room_usage_limit(&done, &json!(null)).expect("a usage limit");
    assert_eq!((usage.kind.as_str(), usage.provider.as_str(), usage.model.as_str()), ("quota_exhausted", "openai", "gpt-x"));
    assert_eq!(usage.reset_at, Some(1_800_000_000_000));
}

#[test]
fn only_quota_entitlement_and_billing_refusals_count() {
    for kind in ["quota_exhausted", "entitlement", "billing"] {
        let done = json!({ "status": "failed", "errorKind": { "kind": kind, "resetAt": 5000 } });
        let usage = room_usage_limit(&done, &json!({ "provider": "p", "model": "m" })).expect(kind);
        assert_eq!((usage.kind.as_str(), usage.reset_at), (kind, Some(5000)));
    }
    for kind in ["timeout", "overloaded", ""] {
        assert!(room_usage_limit(&json!({ "status": "failed", "errorKind": { "kind": kind } }), &json!(null)).is_none(), "{kind}");
    }
    assert!(room_usage_limit(&json!({ "status": "failed" }), &json!(null)).is_none(), "a plain failure is not a limit");
}

#[test]
fn the_provider_and_model_fall_back_from_the_quota_to_the_turn_to_the_members_route() {
    let done = json!({ "status": "failed", "quota": { "provider": "from-quota" }, "model": "from-turn" });
    let usage = room_usage_limit(&done, &json!({ "provider": "from-route", "model": "from-route" })).unwrap();
    assert_eq!((usage.provider.as_str(), usage.model.as_str()), ("from-quota", "from-turn"));
    let bare = room_usage_limit(&json!({ "status": "failed", "quota": {} }), &json!({ "provider": "route-p", "model": "route-m" })).unwrap();
    assert_eq!((bare.provider.as_str(), bare.model.as_str(), bare.reset_at), ("route-p", "route-m", None));
}

#[test]
fn a_reset_time_must_be_a_positive_number() {
    let done = json!({ "status": "failed", "quota": { "resetAt": 0 } });
    assert_eq!(room_usage_limit(&done, &json!(null)).unwrap().reset_at, None);
    let done = json!({ "status": "failed", "quota": { "resetAt": "soon" } });
    assert_eq!(room_usage_limit(&done, &json!(null)).unwrap().reset_at, None);
}
