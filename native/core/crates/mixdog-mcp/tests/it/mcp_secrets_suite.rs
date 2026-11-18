//! An MCP server's OAuth client secret in the keychain: which edit writes or deletes it, the account names it is kept under, what a
//! server's sign-in is stored under, and putting the keychain back when a save fails.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_mcp::config::Env;
use mixdog_mcp::connector_model::GMAIL_ACCOUNT_HEADER;
use mixdog_mcp::connector_model::GMAIL_APP_PASSWORD_URL;
use mixdog_mcp::mcp_secrets::McpServerSecrets;
use mixdog_mcp::mcp_secrets::Release;
use mixdog_mcp::mcp_secrets::SecretOps;
use mixdog_mcp::mcp_secrets::gmail_app_password_secret_account;
use mixdog_mcp::mcp_secrets::oauth_client_secret_account;
use mixdog_mcp::mcp_secrets::oauth_credential_of;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

#[derive(Default)]
struct Keychain {
    log: Mutex<Vec<String>>,
    held: Mutex<HashMap<String, String>>,
    failing: Mutex<Vec<String>>,
    servers: Mutex<Map<String, Value>>,
}

#[async_trait]
impl SecretOps for Keychain {
    async fn save_gmail_app_password(&self, email: &str, password: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("gmail:{email}:{password}"));
        Ok(())
    }
    async fn forget_gmail_app_password(&self, email: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("gmail-forget:{email}"));
        Ok(())
    }
    async fn save_oauth_client_secret(&self, url: &str, secret: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("client:{url}:{secret}"));
        Ok(())
    }
    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String> {
        let name = cfg.get("name").and_then(Value::as_str).unwrap_or_default();
        self.log.lock().unwrap().push(format!("clear:{name}"));
        Ok(name == "revoker")
    }
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.held.lock().unwrap().get(account).cloned())
    }
    async fn write_secret(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("write:{account}:{}", value.unwrap_or("<deleted>")));
        if self.failing.lock().unwrap().iter().any(|failing| failing == account) {
            return Err(format!("cannot write {account}"));
        }
        Ok(())
    }
    fn forget_account_health(&self, name: &str) {
        self.log.lock().unwrap().push(format!("health:{name}"));
    }
    fn configured_servers(&self) -> Map<String, Value> {
        self.servers.lock().unwrap().clone()
    }
}

fn secrets() -> (Arc<Keychain>, McpServerSecrets) {
    let keychain = Arc::new(Keychain::default());
    let env: Env = [("SECRET_HOST".to_owned(), "example.com".to_owned())].into_iter().collect();
    (keychain.clone(), McpServerSecrets::new(keychain, env))
}

#[tokio::test]
async fn a_client_secret_is_saved_trimmed_for_a_server_with_a_client_id_and_forgotten_when_the_id_is_cleared() {
    let (keychain, secrets) = secrets();
    let cfg = json!({"url": "https://x.example/mcp", "oauthClientId": "cid"});
    secrets.store_oauth_client_secret(&json!({"oauthClientSecret": "  s3cret  "}), &cfg, &json!({})).await.unwrap();
    assert_eq!(*keychain.log.lock().unwrap(), ["client:https://x.example/mcp:s3cret"]);
    keychain.log.lock().unwrap().clear();

    // A client id with no secret typed keeps the stored one: nothing is written.
    secrets.store_oauth_client_secret(&json!({}), &cfg, &json!({"oauthClientId": "cid"})).await.unwrap();
    assert!(keychain.log.lock().unwrap().is_empty());

    // The id is cleared: the secret kept under the previous address is deleted (an empty secret deletes).
    let cleared = json!({"url": "https://x.example/mcp"});
    let before = json!({"url": "https://old.example/mcp", "oauthClientId": "cid"});
    secrets.store_oauth_client_secret(&json!({}), &cleared, &before).await.unwrap();
    assert_eq!(*keychain.log.lock().unwrap(), ["client:https://old.example/mcp:"]);
    keychain.log.lock().unwrap().clear();

    // A server with no URL, or one that never had a client id, stores nothing.
    secrets.store_oauth_client_secret(&json!({"oauthClientSecret": "x"}), &json!({"command": "run"}), &json!({})).await.unwrap();
    secrets.store_oauth_client_secret(&json!({}), &cleared, &json!({})).await.unwrap();
    assert!(keychain.log.lock().unwrap().is_empty());
}

#[test]
fn keychain_account_names_are_a_prefix_and_a_digest_of_the_normal_form_of_what_they_belong_to() {
    let account = oauth_client_secret_account("https://x.example/mcp").unwrap();
    let digest = account.strip_prefix("mcp-oauth-client.").expect("the prefix");
    assert!(digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit()), "{account}");
    assert_eq!(oauth_client_secret_account("https://x.example").unwrap(), oauth_client_secret_account("https://x.example/").unwrap(), "one address, one account");
    assert_ne!(account, oauth_client_secret_account("https://x.example/other").unwrap());
    assert_eq!(oauth_client_secret_account("not a url").unwrap_err(), "MCP http URL is invalid");
    let mail = gmail_app_password_secret_account("me@example.com");
    assert!(mail.strip_prefix("gmail-app-password.").is_some_and(|digest| digest.len() == 64), "{mail}");
    assert_ne!(mail, gmail_app_password_secret_account("you@example.com"));
}

#[test]
fn a_servers_sign_in_is_kept_under_its_address_or_its_accounts_own_key_and_only_remote_servers_have_one() {
    let env: Env = [("SECRET_HOST".to_owned(), "example.com".to_owned())].into_iter().collect();
    let credential = |cfg: Value| oauth_credential_of(&cfg, &env);
    assert_eq!(credential(json!({"url": "https://x.example/mcp"})).as_deref(), Some("https://x.example/mcp"));
    assert_eq!(credential(json!({"type": "sse", "url": "https://x.example/events"})).as_deref(), Some("https://x.example/events"));
    assert_eq!(credential(json!({"url": "https://x.example/mcp", "oauthKey": " acct "})).as_deref(), Some("mcp-account:acct"));
    assert_eq!(credential(json!({"url": "https://${SECRET_HOST}/mcp"})).as_deref(), Some("https://example.com/mcp"));
    assert_eq!(credential(json!({"command": "run"})), None, "a command server never signs in");
    assert_eq!(credential(json!({"type": "ws", "url": "wss://x.example/live"})), None);
    assert_eq!(credential(json!({"url": "not a url"})), None, "no valid address, no sign-in");
}

#[tokio::test]
async fn a_failed_save_puts_every_account_back_and_reports_the_first_failure() {
    let (keychain, secrets) = secrets();
    let cfg = json!({"url": "https://x.example/mcp", "oauthClientId": "cid"});
    let input = json!({"oauthClientSecret": "new"});
    let account = oauth_client_secret_account("https://x.example/mcp").unwrap();
    keychain.held.lock().unwrap().insert(account.clone(), "old".to_owned());
    let snapshot = secrets.snapshot(&input, &cfg, &json!({})).await.unwrap();
    secrets.restore(snapshot).await.unwrap();
    assert_eq!(*keychain.log.lock().unwrap(), [format!("write:{account}:old")], "what it held before is written back");
    keychain.log.lock().unwrap().clear();

    // Nothing held before: restoring deletes what the failed save wrote.
    keychain.held.lock().unwrap().clear();
    let snapshot = secrets.snapshot(&input, &cfg, &json!({})).await.unwrap();
    keychain.failing.lock().unwrap().push(account.clone());
    assert_eq!(secrets.restore(snapshot).await.unwrap_err(), format!("cannot write {account}"));
    assert_eq!(*keychain.log.lock().unwrap(), [format!("write:{account}:<deleted>")]);
}

fn gmail_server(address: &str) -> Value {
    json!({"url": GMAIL_APP_PASSWORD_URL, "headers": {GMAIL_ACCOUNT_HEADER: address}})
}

#[tokio::test]
async fn a_gmail_app_password_is_saved_without_its_spaces_and_an_edit_without_one_keeps_the_stored_one() {
    let (keychain, secrets) = secrets();
    let cfg = gmail_server("Me@Example.com");
    secrets.store_gmail_app_password(&json!({"appPassword": "abcd efgh ijkl mnop"}), &cfg, true).await.unwrap();
    assert_eq!(*keychain.log.lock().unwrap(), ["gmail:me@example.com:abcdefghijklmnop"], "the address is lower-cased, the spaces are gone");
    keychain.log.lock().unwrap().clear();

    let format = "GMAIL_APP_PASSWORD_FORMAT: An app password has 16 characters.";
    assert_eq!(secrets.store_gmail_app_password(&json!({"appPassword": "short"}), &cfg, false).await.unwrap_err(), format);
    assert_eq!(secrets.store_gmail_app_password(&json!({}), &cfg, true).await.unwrap_err(), format, "a new connection needs one");
    secrets.store_gmail_app_password(&json!({}), &cfg, false).await.unwrap();
    secrets.store_gmail_app_password(&json!({"appPassword": "abcd efgh ijkl mnop"}), &json!({"url": "https://x.example/mcp"}), true).await.unwrap();
    assert!(keychain.log.lock().unwrap().is_empty(), "nothing is saved for a refusal, an edit without one, or a server that is not Gmail");
}

#[tokio::test]
async fn a_removed_servers_sign_in_goes_unless_another_server_uses_the_same_address_and_says_whether_it_was_revoked() {
    let (keychain, secrets) = secrets();
    let remote = |name: &str| json!({"name": name, "url": "https://x.example/mcp"});
    assert_eq!(secrets.release_oauth(&json!({"name": "local", "command": "run"})).await.unwrap(), None, "a command server has no sign-in");

    keychain.servers.lock().unwrap().insert("other".to_owned(), remote("other"));
    assert_eq!(secrets.release_oauth(&remote("gone")).await.unwrap(), Some(Release { removed: false, revoked: false }), "shared");
    assert!(keychain.log.lock().unwrap().is_empty(), "a shared sign-in is not cleared");

    keychain.servers.lock().unwrap().clear();
    assert_eq!(secrets.release_oauth(&remote("gone")).await.unwrap(), Some(Release { removed: true, revoked: false }));
    assert_eq!(secrets.release_oauth(&remote("revoker")).await.unwrap(), Some(Release { removed: true, revoked: true }));
    assert_eq!(*keychain.log.lock().unwrap(), ["clear:gone", "clear:revoker"]);
    assert_eq!(Release { removed: true, revoked: true }.to_value(), json!({"signIn": "removed", "revoked": true}));
    assert_eq!(Release { removed: false, revoked: false }.to_value(), json!({"signIn": "shared", "revoked": false}));
}

#[tokio::test]
async fn an_app_password_is_forgotten_only_when_no_configured_server_uses_its_account() {
    let (keychain, secrets) = secrets();
    assert!(!secrets.forget_unused_gmail_app_password("").await.unwrap());
    keychain.servers.lock().unwrap().insert("g".to_owned(), gmail_server("me@example.com"));
    assert!(!secrets.forget_unused_gmail_app_password("me@example.com").await.unwrap(), "still in use");
    assert!(keychain.log.lock().unwrap().is_empty());
    assert!(secrets.forget_unused_gmail_app_password("you@example.com").await.unwrap());
    assert_eq!(*keychain.log.lock().unwrap(), ["gmail-forget:you@example.com"]);
}

#[tokio::test]
async fn a_removed_gmail_account_forgets_its_health_and_its_password_unless_another_server_holds_it() {
    let (keychain, secrets) = secrets();
    let account = json!({"name": "work", "url": GMAIL_APP_PASSWORD_URL, "headers": {GMAIL_ACCOUNT_HEADER: "me@example.com"}});
    let release = secrets.release_account(&account).await.unwrap();
    assert_eq!(release, Some(Release { removed: true, revoked: false }));
    assert_eq!(*keychain.log.lock().unwrap(), ["health:work", "gmail-forget:me@example.com"]);
    keychain.log.lock().unwrap().clear();
    keychain.servers.lock().unwrap().insert("g".to_owned(), gmail_server("me@example.com"));
    assert_eq!(secrets.release_account(&account).await.unwrap(), Some(Release { removed: false, revoked: false }));
    assert_eq!(*keychain.log.lock().unwrap(), ["health:work"]);
}