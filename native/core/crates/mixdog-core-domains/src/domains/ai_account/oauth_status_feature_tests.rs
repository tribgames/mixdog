//! What each OAuth provider says of its stored credential (`describe_oauth`) at a given time, and which dev-only providers are listed.

use serde_json::{Value, json};

use super::oauth_status::{PROVIDERS, describe_oauth, oauth_available};

const NOW: i64 = 1_800_000_000_000;
const MINUTE: i64 = 60_000;

fn described(provider: &str, loaded: Value) -> Value {
    describe_oauth(provider, Some(&loaded), NOW).unwrap_or_else(|| panic!("{provider} is one of the ten"))
}

fn summary(row: &Value) -> (String, bool, bool, bool, bool) {
    (
        row["status"].as_str().unwrap().to_owned(),
        row["authenticated"].as_bool().unwrap(),
        row["usable"].as_bool().unwrap(),
        row["refreshable"].as_bool().unwrap(),
        row["reauthRequired"].as_bool().unwrap(),
    )
}

#[test]
fn only_the_ten_providers_are_described_and_each_with_nothing_stored_is_not_set() {
    assert_eq!(describe_oauth("unknown", None, NOW), None);
    assert_eq!(PROVIDERS.len(), 10);
    for provider in PROVIDERS {
        let row = describe_oauth(provider, None, NOW).unwrap();
        assert_eq!(summary(&row), ("Not Set".to_owned(), false, false, false, false), "{provider}");
    }
    assert_eq!(describe_oauth("anthropic-oauth", None, NOW).unwrap()["detail"], "Mixdog OAuth credentials");
    assert_eq!(describe_oauth("cursor-oauth", None, NOW).unwrap()["detail"], "Mixdog token store or CURSOR_ACCESS_TOKEN");
    assert_eq!(describe_oauth("openai-oauth", None, NOW).unwrap()["detail"], "Mixdog token store");
    assert_eq!(describe_oauth("openai-oauth", Some(&Value::Null), NOW).unwrap()["status"], "Not Set");
    assert_eq!(described("openai-oauth", json!({ "refresh_token": "r" }))["status"], "Not Set", "no access token, no sign-in");
}

#[test]
fn a_token_with_a_refresh_token_is_valid_until_five_minutes_before_it_expires_then_refresh_soon_then_refresh_required() {
    let row = |expires_at: i64| described("openai-oauth", json!({ "access_token": "a", "refresh_token": "r", "expires_at": expires_at }));
    assert_eq!(summary(&row(NOW + 6 * MINUTE)), ("Valid".to_owned(), true, true, true, false));
    assert_eq!(summary(&row(NOW + 4 * MINUTE)), ("Refresh Soon".to_owned(), true, true, true, false));
    assert_eq!(summary(&row(NOW - 1)), ("Refresh Required".to_owned(), true, false, true, false));
    let valid = row(NOW + 6 * MINUTE);
    assert_eq!((valid["detail"].clone(), valid["expiresAt"].clone()), (json!("oauth"), json!(NOW + 6 * MINUTE)));
    assert_eq!(valid["plan"], Value::Null);
}

#[test]
fn a_token_without_a_refresh_token_is_access_only_until_it_expires_and_then_needs_a_new_sign_in() {
    let row = |expires_at: i64| described("openai-oauth", json!({ "access_token": "a", "expires_at": expires_at, "source": "cli" }));
    let live = row(NOW + MINUTE);
    assert_eq!(summary(&live), ("Access Only".to_owned(), true, true, false, false));
    assert_eq!(live["detail"], "cli; no refresh token");
    assert_eq!(summary(&row(NOW - 1)), ("Reauth Required".to_owned(), false, false, false, true));
    assert_eq!(summary(&row(0)), ("Access Only".to_owned(), true, true, false, false), "no expiry never expires");
}

#[test]
fn a_stored_identity_shows_its_email_and_id_trimmed_and_a_chatgpt_account_id_by_its_first_eight_characters() {
    let row = described(
        "openai-oauth",
        json!({ "access_token": "a", "refresh_token": "r", "expires_at": NOW + 10 * MINUTE, "account_id": "0123456789abcdef", "identity": { "id": " user-1 ", "email": " me@example.com " } }),
    );
    assert_eq!((row["email"].clone(), row["identityId"].clone(), row["accountId"].clone()), (json!("me@example.com"), json!("user-1"), json!("01234567…")));
}

#[test]
fn key_style_providers_are_valid_with_a_key_and_never_expire() {
    let muse = described("muse-code-oauth", json!({ "apiKey": "k", "email": "m@x.io" }));
    assert_eq!(summary(&muse), ("Valid".to_owned(), true, true, false, false));
    assert_eq!((muse["expiresAt"].clone(), muse["email"].clone()), (json!(0), json!("m@x.io")));
    assert_eq!(describe_oauth("muse-code-oauth", Some(&json!({})), NOW).unwrap()["status"], "Not Set");
    assert_eq!(described("command-code-oauth", json!({ "userId": "u1", "userName": "Ada" }))["detail"], "Mixdog token store; API key");
    assert_eq!(described("mimo-oauth", json!({ "uid": "u9" }))["identityId"], "u9");
}

#[test]
fn an_antigravity_sign_in_stays_usable_past_its_expiry_while_a_refresh_token_remains() {
    let row = |expires_at: i64, refresh: bool| {
        let mut doc = json!({ "access_token": "a", "expires_at": expires_at, "email": "me@x.io", "project_id": "p1" });
        if refresh {
            doc["refresh_token"] = json!("r");
        }
        described("antigravity-oauth", doc)
    };
    assert_eq!(summary(&row(NOW - 1, true)), ("Signed In".to_owned(), true, true, true, false));
    assert_eq!(summary(&row(NOW - 1, false)), ("Reauth Required".to_owned(), true, false, false, true));
    assert_eq!(row(NOW + MINUTE, false)["detail"], "me@x.io · project p1");
}

#[test]
fn an_anthropic_credential_without_the_inference_scope_or_marked_for_reauth_is_refused() {
    let doc = |extra: Value| {
        let mut base = json!({ "scopes": ["user:inference"], "refreshToken": "r", "expiresAt": NOW + 30 * MINUTE, "path": "~/.claude/.credentials.json" });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        described("anthropic-oauth", base)
    };
    assert_eq!(summary(&doc(json!({}))), ("Valid".to_owned(), true, true, true, false));
    assert_eq!(summary(&doc(json!({ "scopes": ["user:profile"] }))), ("Missing Scope".to_owned(), false, false, false, true));
    assert_eq!(summary(&doc(json!({ "reauthRequired": true }))), ("Reauth Required".to_owned(), false, false, false, true));
}

#[test]
fn a_cursor_credential_that_expired_with_no_refresh_token_needs_a_new_sign_in() {
    let row = |doc: Value| summary(&described("cursor-oauth", doc));
    assert_eq!(row(json!({ "expires_at": NOW - 1 })), ("Reauth Required".to_owned(), false, false, false, true));
    assert_eq!(row(json!({ "expires_at": NOW - 1, "refresh_token": "r" })), ("Refresh Required".to_owned(), true, false, true, false));
    assert_eq!(row(json!({ "expires_at": NOW + MINUTE, "refresh_token": "r" })), ("Refresh Soon".to_owned(), true, true, true, false));
    assert_eq!(row(json!({ "expires_at": NOW + 10 * MINUTE })), ("Access Only".to_owned(), true, true, false, false));
    assert_eq!(row(json!({ "reauth_required": true })), ("Reauth Required".to_owned(), false, false, false, true));
}

#[test]
fn a_dev_only_provider_is_listed_only_while_its_stored_option_is_the_boolean_true() {
    for provider in ["openai-oauth", "anthropic-oauth", "grok-oauth", "muse-code-oauth", "command-code-oauth", "opencode-go-oauth"] {
        assert!(oauth_available(provider, &json!({})), "{provider} is always listed");
    }
    for (provider, option) in
        [("antigravity-oauth", "antigravityOAuth"), ("cursor-oauth", "cursorOAuth"), ("devin-oauth", "devinOAuth"), ("mimo-oauth", "mimoOAuth")]
    {
        assert!(!oauth_available(provider, &json!({})), "{provider}: off without its option");
        assert!(!oauth_available(provider, &json!({ option: "true" })), "{provider}: only a boolean counts");
        assert!(!oauth_available(provider, &json!({ option: false })));
        assert!(oauth_available(provider, &json!({ option: true })));
    }
}
