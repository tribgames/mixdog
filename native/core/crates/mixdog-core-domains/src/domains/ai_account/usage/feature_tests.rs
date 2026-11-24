//! Which routes refresh the statusline usage reading, what an internal run is, and which stored sessions the user can open.

use mixdog_core_ports::ports::route::Route;
use serde_json::{Value, json};

use super::internal_kind;
use super::is_openable;
use super::sources::statusline_target;

fn route(value: Value) -> Route {
    value.as_object().cloned().unwrap()
}

#[test]
fn only_a_registered_oauth_provider_refreshes_the_reading() {
    let registered = |name: &str| name == "openai-oauth";
    assert_eq!(
        statusline_target(&route(json!({ "provider": "openai-oauth", "model": "gpt-x" })), &registered),
        Some(("openai-oauth".to_owned(), "gpt-x".to_owned()))
    );
    assert_eq!(
        statusline_target(&route(json!({ "provider": " openai-oauth ", "model": " m " })), &registered),
        Some(("openai-oauth".to_owned(), "m".to_owned())),
        "names are trimmed"
    );
    assert_eq!(statusline_target(&route(json!({ "provider": "openai", "model": "m" })), &|_| true), None, "an API-key provider has no reading");
    assert_eq!(
        statusline_target(&route(json!({ "provider": "anthropic-oauth", "model": "m" })), &registered),
        None,
        "an unregistered one has nothing to refresh"
    );
    assert_eq!(statusline_target(&route(json!({})), &|_| true), None);
}

#[test]
fn the_title_run_is_internal_and_the_users_own_conversation_is_not() {
    assert_eq!(internal_kind("session-title"), "session-title");
    assert_eq!(internal_kind(" Session-Title "), "session-title");
    assert_eq!(internal_kind(""), "");
}

#[test]
fn an_internal_run_is_never_openable_and_an_agent_child_is_when_an_owner_links_it() {
    assert!(!is_openable(&json!("not a row"), ""));
    let child = json!({ "agent": "reviewer", "ownerSessionId": "r_owner", "owner": "agent" });
    assert!(is_openable(&child, ""), "its own owner link");
    let unlinked = json!({ "agent": "reviewer", "owner": "agent" });
    assert!(is_openable(&unlinked, "r_owner"), "the request names the owner");
    let title = json!({ "agent": "reviewer", "ownerSessionId": "r_owner", "sourceType": "session-title" });
    assert!(!is_openable(&title, "r_owner"));
}

fn field_f64(value: &Value, key: &str) -> Option<f64> {
    value[key].as_f64()
}

#[test]
fn quota_windows_are_labelled_by_their_key_or_position_and_carry_the_figures_they_state() {
    use super::dashboard::normalise_windows;
    let by_key = normalise_windows(Some(&json!({ "five_hour": { "limitUsd": 10, "used_usd": 2.5, "reset_at": 1700 } })), "src");
    assert_eq!(by_key.len(), 1);
    assert_eq!((by_key[0]["label"].as_str(), by_key[0]["source"].as_str()), (Some("FIVE_HOUR"), Some("src")));
    assert_eq!((field_f64(&by_key[0], "limitUsd"), field_f64(&by_key[0], "usedUsd"), field_f64(&by_key[0], "resetAt")), (Some(10.0), Some(2.5), Some(1700.0)));
    assert_eq!(field_f64(&by_key[0], "usedPct"), Some(25.0), "derived from the used and limit amounts");

    let listed = normalise_windows(Some(&json!([{ "name": "weekly", "remainingUsd": 3 }, { "cost_usd": 1, "source": "own" }, "junk"])), "src");
    assert_eq!(listed.iter().map(|w| w["label"].as_str().unwrap()).collect::<Vec<_>>(), ["WEEKLY", "W2"]);
    assert_eq!(field_f64(&listed[0], "remainingUsd"), Some(3.0));
    assert_eq!((listed[1]["source"].as_str(), field_f64(&listed[1], "usedUsd")), (Some("own"), Some(1.0)));
    assert!(normalise_windows(None, "src").is_empty());
}

#[test]
fn only_a_subscription_account_that_has_the_feature_shows_credits() {
    use super::dashboard::credits_from_snapshot;
    let openai = credits_from_snapshot("openai-oauth", Some(&json!({ "balance": { "unit": "credits", "remainingCredits": 5 } }))).unwrap();
    assert_eq!((openai["unit"].as_str(), field_f64(&openai, "balance")), (Some("credits"), Some(5.0)));
    let unlimited = credits_from_snapshot("openai-oauth", Some(&json!({ "balance": { "unit": "credits", "unlimited": true } }))).unwrap();
    assert_eq!((unlimited["balance"].clone(), unlimited["unlimited"].clone()), (Value::Null, json!(true)));
    assert!(credits_from_snapshot("openai-oauth", Some(&json!({ "balance": { "unit": "usd", "remainingCredits": 5 } }))).is_none());
    assert!(credits_from_snapshot("openai-oauth", Some(&json!({ "balance": { "unit": "credits", "remainingCredits": 0 } }))).is_none());

    let spend = credits_from_snapshot("anthropic-oauth", Some(&json!({ "balance": { "remainingUsd": 7, "budgetUsd": 20, "spentUsd": 13 } }))).unwrap();
    assert_eq!(
        (spend["unit"].as_str(), field_f64(&spend, "balance"), field_f64(&spend, "monthlyLimit"), field_f64(&spend, "spent")),
        (Some("usd"), Some(7.0), Some(20.0), Some(13.0))
    );
    let extra = credits_from_snapshot("anthropic-oauth", Some(&json!({ "quotaWindows": [{ "label": "EXTRA", "limitUsd": 20, "usedUsd": 5 }] }))).unwrap();
    assert_eq!(field_f64(&extra, "balance"), Some(15.0), "the limit less what was spent");
    assert!(credits_from_snapshot("anthropic-oauth", Some(&json!({}))).is_none());
    assert!(credits_from_snapshot("grok-oauth", Some(&json!({ "balance": { "unit": "credits", "remainingCredits": 5 } }))).is_none());
}

struct Quotas;

#[async_trait::async_trait]
impl super::dashboard::UsageSources for Quotas {
    async fn cached_oauth(&self, provider: &str, _: bool) -> Option<Value> {
        (provider == "grok-oauth").then(|| json!({ "credentialStamp": "0123456789abcdef", "quotaWindows": [{ "label": "5h", "usedPct": 50 }] }))
    }
    fn oauth_provider_ready(&self, _: &str) -> bool {
        false
    }
    async fn fetch_oauth(&self, _: &str, _: bool) -> Result<Option<Value>, String> {
        Ok(None)
    }
    async fn cached_api(&self, _: &str) -> Option<Value> {
        None
    }
    async fn fetch_api(&self, _: &str, _: bool) -> Result<Option<Value>, String> {
        Ok(None)
    }
}

#[tokio::test]
async fn a_dashboard_row_says_what_its_provider_could_be_asked() {
    use super::dashboard::{DashboardOptions, create_usage_dashboard};
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let accounts = mixdog_ai::accounts::AccountStore::new(
        dir.path().to_path_buf(),
        mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
    );
    let setup = json!({
        "api": [{ "id": "openai", "authenticated": false }, { "id": "deepseek", "authenticated": true }],
        "oauth": [{ "id": "grok-oauth", "authenticated": true }, { "id": "mimo-oauth", "authenticated": true }],
    });
    let read = |preview: bool| {
        let (setup, accounts) = (&setup, &accounts);
        async move {
            let options = DashboardOptions { preview, ..DashboardOptions::default() };
            create_usage_dashboard(&json!({}), setup, &options, 1, &Quotas, accounts).await
        }
    };
    let shown = |dashboard: &Value, id: &str| {
        let row = dashboard["rows"].as_array().unwrap().iter().find(|row| row["id"] == id).unwrap().clone();
        ["status", "source", "sourceLabel", "primary", "detail", "tone"].map(|key| row[key].as_str().unwrap().to_owned())
    };
    let dashboard = read(false).await;
    assert_eq!(shown(&dashboard, "openai"), ["missing", "not-configured", "no key", "not configured", "Configure auth", "missing"]);
    assert_eq!(shown(&dashboard, "deepseek"), ["hidden", "provider-hidden", "unavailable", "-", "DeepSeek balance unavailable", "warn"]);
    assert_eq!(shown(&dashboard, "grok-oauth"), ["partial", "provider-api", "API window", "5H 50%", "subscription quota", "warn"]);
    assert_eq!(shown(&dashboard, "mimo-oauth"), ["hidden", "usage-disabled", "disabled", "", "No current usage query result", "warn"]);

    let row = |id: &str| dashboard["rows"].as_array().unwrap().iter().find(|row| row["id"] == id).unwrap().clone();
    assert_eq!(row("grok-oauth")["credentialStamp"], "0123456789abcdef", "a row names the account its reading was measured for");
    assert!(row("mimo-oauth").get("credentialStamp").is_none(), "a reading with no stamp names no account");

    let preview = read(true).await;
    assert_eq!(shown(&preview, "grok-oauth"), ["checking", "checking", "checking", "", "Checking provider usage", "ok"]);
    assert_eq!(preview["refresh"], false);
    assert_eq!(preview["checking"], true);
}
