//! Whether a stored credential document counts as a sign-in, per provider: a document the rule rejects reads absent,
//! as after a logout.

use serde_json::Value;
use serde_json::json;

use super::validity::credential_valid;

/// 2027-01-15 in epoch milliseconds.
const NOW: f64 = 1_800_000_000_000.0;
/// Epoch milliseconds before `NOW`, and after it.
const PAST_MS: u64 = 1_000_000_000_000;
const FUTURE_MS: u64 = 4_000_000_000_000;

fn valid(provider: &str, document: Value) -> bool {
    credential_valid(provider, document.as_object().expect("a document"), NOW)
}

#[test]
fn an_anthropic_login_needs_the_inference_scope_and_an_unexpired_or_renewable_token() {
    let doc = |scopes: Value, extra: Value| {
        let mut oauth = json!({ "accessToken": "a", "scopes": scopes });
        for (key, value) in extra.as_object().unwrap() {
            oauth[key] = value.clone();
        }
        json!({ "claudeAiOauth": oauth })
    };
    let scoped = json!(["user:inference"]);
    assert!(valid("anthropic-oauth", doc(scoped.clone(), json!({ "expiresAt": FUTURE_MS }))));
    assert!(!valid("anthropic-oauth", doc(scoped.clone(), json!({ "expiresAt": PAST_MS }))), "expired with nothing to renew it");
    assert!(valid("anthropic-oauth", doc(scoped.clone(), json!({ "expiresAt": PAST_MS, "refreshToken": "r" }))), "a refresh token renews it");
    assert!(valid("anthropic-oauth", doc(scoped, json!({}))), "no recorded expiry never lapses");
    assert!(!valid("anthropic-oauth", doc(json!(["user:profile"]), json!({ "expiresAt": FUTURE_MS }))), "no inference scope");
    assert!(!valid("anthropic-oauth", json!({ "claudeAiOauth": { "scopes": ["user:inference"] } })), "no access token");
    assert!(!valid("anthropic-oauth", json!({})));
}

#[test]
fn an_openai_login_lasts_while_it_can_be_refreshed_or_its_stated_expiry_is_ahead() {
    assert!(valid("openai-oauth", json!({ "access_token": "a", "refresh_token": "r" })));
    assert!(!valid("openai-oauth", json!({ "refresh_token": "r" })), "no access token");
    assert!(valid("openai-oauth", json!({ "access_token": "a", "expires_at": FUTURE_MS })));
    assert!(!valid("openai-oauth", json!({ "access_token": "a", "expires_at": PAST_MS })));
    // An expiry written in epoch seconds is read as seconds: 4e9 s is year 2096, 1e9 s is 2001.
    assert!(valid("openai-oauth", json!({ "access_token": "a", "expires_at": 4_000_000_000_u64 })));
    assert!(!valid("openai-oauth", json!({ "access_token": "a", "expires_at": 1_000_000_000_u64 })));
    assert!(!valid("openai-oauth", json!({ "access_token": "opaque" })), "an expiry nowhere to be found is no sign-in");
}

#[test]
fn a_cursor_login_is_refused_when_marked_for_re_login_or_expired_without_a_refresh_token() {
    assert!(valid("cursor-oauth", json!({ "access_token": "a", "expires_at": FUTURE_MS })));
    assert!(!valid("cursor-oauth", json!({ "access_token": "a", "expires_at": PAST_MS })));
    assert!(valid("cursor-oauth", json!({ "access_token": "a", "expires_at": PAST_MS, "refresh_token": "r" })));
    assert!(!valid("cursor-oauth", json!({ "access_token": "a", "reauth_required": true, "refresh_token": "r" })));
    assert!(!valid("cursor-oauth", json!({ "expires_at": FUTURE_MS })));
}

#[test]
fn a_devin_login_ends_at_its_expiry_even_with_a_refresh_token() {
    assert!(valid("devin-oauth", json!({ "access_token": "a" })), "no expiry recorded");
    assert!(valid("devin-oauth", json!({ "access_token": "a", "expires_at": FUTURE_MS })));
    assert!(!valid("devin-oauth", json!({ "access_token": "a", "expires_at": PAST_MS, "refresh_token": "r" })));
    assert!(!valid("devin-oauth", json!({ "expires_at": FUTURE_MS })));
}

#[test]
fn the_other_providers_need_their_own_credential_fields() {
    assert!(valid("grok-oauth", json!({ "access_token": "a", "refresh_token": "r" })));
    assert!(!valid("grok-oauth", json!({ "access_token": "a" })));
    assert!(valid("mimo-oauth", json!({ "apiKey": "k" })));
    assert!(!valid("mimo-oauth", json!({ "apiKey": "" })));
    assert!(valid("command-code-oauth", json!({ "apiKey": "k" })));
    assert!(!valid("command-code-oauth", json!({ "apiKey": "  " })), "a blank key is none");
    assert!(valid("muse-code-oauth", json!({ "accessToken": "a", "apiKey": "k" })));
    assert!(!valid("muse-code-oauth", json!({ "accessToken": "a", "apiKey": " " })));
    assert!(valid("opencode-go-oauth", json!({ "access_token": "a", "refresh_token": "r" })));
    assert!(!valid("opencode-go-oauth", json!({ "access_token": "a", "refresh_token": " " })));
    assert!(valid("antigravity-oauth", json!({ "access_token": "a", "refresh_token": "r", "project_id": "p" })));
    assert!(!valid("antigravity-oauth", json!({ "access_token": "a", "refresh_token": "r" })), "no project");
}

#[test]
fn a_provider_without_a_rule_is_never_signed_in() {
    assert!(!valid("someone-else", json!({ "access_token": "a", "refresh_token": "r" })));
}
