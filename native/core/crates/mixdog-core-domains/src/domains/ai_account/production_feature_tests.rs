//! Forgetting an OAuth sign-in: the answer `{ removed }` and what the credential file holds afterwards, per provider.

use mixdog_ai::oauth::{CredentialFile, CredentialIo, Probe};
use serde_json::{Value, json};

use super::oauth_status::PROVIDERS;
use super::production::forget_file;

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

async fn after(file: &CredentialFile) -> Value {
    match file.load_document().await {
        Probe::Present(document) => Value::Object(document),
        Probe::Absent | Probe::Unreadable => Value::Null,
    }
}

async fn forget(provider: &str, before: Option<Value>) -> (Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let file = CredentialFile::new(dir.path().join("credentials.json"), io());
    if let Some(Value::Object(document)) = before {
        file.save(&Value::Object(document)).await.unwrap();
    }
    let answer = forget_file(provider, &file).await.unwrap();
    (answer, after(&file).await)
}

#[tokio::test]
async fn a_provider_that_owns_its_file_forgets_by_deleting_it() {
    let signed_in = json!({ "access_token": "a-1", "refresh_token": "r-1", "expires_at": 4_000_000_000_000_i64, "extra": "kept?" });
    for provider in PROVIDERS.iter().filter(|id| !matches!(**id, "anthropic-oauth" | "antigravity-oauth")) {
        assert_eq!(forget(provider, Some(signed_in.clone())).await, (json!({ "removed": true }), Value::Null), "{provider}: signed in");
        assert_eq!(forget(provider, None).await, (json!({ "removed": false }), Value::Null), "{provider}: no file");
        assert_eq!(forget(provider, Some(json!({}))).await, (json!({ "removed": true }), Value::Null), "{provider}: an empty document");
    }
}

#[tokio::test]
async fn antigravity_overwrites_its_file_with_an_empty_document_instead_of_deleting_it() {
    let signed_in = json!({ "access_token": "a-1", "refresh_token": "r-1", "expires_at": 4_000_000_000_000_i64 });
    assert_eq!(forget("antigravity-oauth", Some(signed_in)).await, (json!({ "removed": true }), json!({})));
    assert_eq!(forget("antigravity-oauth", Some(json!({}))).await, (json!({ "removed": true }), json!({})));
    assert_eq!(forget("antigravity-oauth", None).await, (json!({ "removed": false }), Value::Null));
}

#[tokio::test]
async fn anthropic_removes_only_its_own_sign_in_and_keeps_the_other_keys() {
    let own = json!({ "accessToken": "a", "refreshToken": "r", "expiresAt": 4_000_000_000_000_i64 });
    assert_eq!(forget("anthropic-oauth", Some(json!({ "claudeAiOauth": own, "mcpOAuth": { "s": 1 } }))).await, (json!({ "removed": true }), json!({ "mcpOAuth": { "s": 1 } })));
    assert_eq!(forget("anthropic-oauth", Some(json!({ "claudeAiOauth": { "accessToken": "a" } }))).await, (json!({ "removed": true }), json!({})));
    assert_eq!(forget("anthropic-oauth", Some(json!({ "mcpOAuth": { "s": 1 } }))).await, (json!({ "removed": false }), json!({ "mcpOAuth": { "s": 1 } })));
    assert_eq!(forget("anthropic-oauth", None).await, (json!({ "removed": false }), Value::Null));
}

#[tokio::test]
async fn forgetting_never_touches_the_clis_own_credentials_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = CredentialFile::new(dir.path().join("credentials.json"), io());
    let cli = CredentialFile::new(dir.path().join(".claude").join("credentials.json"), io());
    let side = json!({ "claudeAiOauth": { "accessToken": "cli-token", "refreshToken": "cli-refresh", "expiresAt": 4_000_000_000_000_i64 } });
    cli.save(&side).await.unwrap();
    file.save(&json!({ "claudeAiOauth": { "accessToken": "a" } })).await.unwrap();
    forget_file("anthropic-oauth", &file).await.unwrap();
    assert_eq!(after(&cli).await, side);
}

#[test]
fn every_provider_the_admin_lists_is_one_of_the_ten_with_a_forget_rule() {
    assert_eq!(PROVIDERS.len(), 10);
    assert!(PROVIDERS.contains(&"anthropic-oauth") && PROVIDERS.contains(&"antigravity-oauth"));
}
