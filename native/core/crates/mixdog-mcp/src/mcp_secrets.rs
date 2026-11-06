//! The keychain side of MCP server edits (Node `resource-mcp-secrets.mjs`,
//! `mcp/oauth-client.mjs` and the app-password store of `connectors/gmail-app-password.mjs`):
//! storing a server's OAuth client secret or Gmail app password, and releasing a removed
//! server's or account's sign-in once no other configured server shares it.
//!
//! What touches the outside world — the keychain, Gmail's IMAP/SMTP check of an app password,
//! the OAuth token store — sits behind [`SecretOps`]; [`KeychainOps`] is the keychain part.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_secrets::SecretStore;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use crate::config::Env;
use crate::config::TransportKind;
use crate::config::expand_env;
use crate::config::normalize_url;
use crate::connector_model::account_servers;
use crate::connector_model::gmail_address;
use crate::connector_model::gmail_app_password_account;
use crate::connector_model::gmail_app_password_value;
use crate::plugin_admin::truthy;

fn hex_sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The keychain account of the app password of Gmail address `email`.
pub fn gmail_app_password_secret_account(email: &str) -> String {
    format!("gmail-app-password.{}", hex_sha256(&gmail_address(&json!(email))))
}

/// The keychain account of the user's client secret for one server URL.
pub fn oauth_client_secret_account(url: &str) -> Result<String, String> {
    let key = normalize_url(url, false).map_err(|e| match e {
        crate::config::ConfigError::InvalidUrl => "MCP http URL is invalid".to_owned(),
        other => other.to_string(),
    })?;
    Ok(format!("mcp-oauth-client.{}", hex_sha256(key.as_str())))
}

/// `resolveMcpTransportKind`: an unrecognized `type` is passed over for `transport`, `command`
/// and `url`, where [`transport_kind`] refuses it.
fn lenient_transport_kind(cfg: &Value) -> Option<TransportKind> {
    if cfg.get("type").is_some_and(truthy) {
        let kind = mixdog_js::value_to_string(&cfg["type"]).to_lowercase();
        match kind.as_str() {
            "streamable-http" | "streamablehttp" | "http" => return Some(TransportKind::Http),
            "stdio" => return Some(TransportKind::Stdio),
            "sse" => return Some(TransportKind::Sse),
            "ws" => return Some(TransportKind::WebSocket),
            _ => {}
        }
    }
    if cfg.get("transport").and_then(Value::as_str) == Some("http") {
        return Some(TransportKind::Http);
    }
    if cfg.get("command").is_some_and(truthy) {
        return Some(TransportKind::Stdio);
    }
    if cfg.get("url").is_some_and(truthy) {
        return Some(TransportKind::Http);
    }
    None
}

/// What the OAuth credentials of an HTTP/SSE server config are stored under: its exact URL, or a
/// connector account's own `oauthKey`; `None` for other transports and for a config with no
/// valid remote URL (such a server never signed in).
pub fn oauth_credential_of(cfg: &Value, env: &Env) -> Option<String> {
    match lenient_transport_kind(cfg)? {
        TransportKind::Http | TransportKind::Sse => {}
        _ => return None,
    }
    let raw = cfg.get("url").filter(|u| !u.is_null()).map(mixdog_js::value_to_string).unwrap_or_default();
    let url = normalize_url(&expand_env(&raw, env, &mut Vec::new()), false).ok()?.to_string();
    let own = cfg.get("oauthKey").and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).unwrap_or_default();
    Some(if own.is_empty() { url } else { format!("mcp-account:{own}") })
}

/// The effects the secret handling has on the world, in Node's words.
#[async_trait]
pub trait SecretOps: Send + Sync {
    /// `saveGmailAppPassword`: Gmail must accept the password over IMAP and SMTP before it is kept.
    async fn save_gmail_app_password(&self, email: &str, password: &str) -> Result<(), String>;
    async fn forget_gmail_app_password(&self, email: &str) -> Result<(), String>;
    /// `saveMcpOAuthClientSecret`; an empty secret deletes.
    async fn save_oauth_client_secret(&self, url: &str, secret: &str) -> Result<(), String>;
    /// `clearMcpServerOAuth(cfg, { revoke: true })`: whether the provider confirmed the revocation.
    async fn clear_oauth(&self, cfg: &Value) -> Result<bool, String>;
    /// What the keychain holds under `account`; `None` when nothing.
    async fn read_secret(&self, account: &str) -> Result<Option<String>, String>;
    /// Puts `value` back under `account` as it was (no check with Gmail); `None` deletes.
    async fn write_secret(&self, account: &str, value: Option<&str>) -> Result<(), String>;
    /// `forgetConnectorAccountHealth`.
    fn forget_account_health(&self, name: &str);
    /// Every configured server (`resolveConfiguredMcpCatalog().servers`): plugin and disabled
    /// ones included, even with MCP disabled for this runtime.
    fn configured_servers(&self) -> Map<String, Value>;
}

/// Checks an app password with Gmail (IMAP and SMTP); the error is the fixed
/// `GMAIL_APP_PASSWORD_<CODE>: …` sentence, never the password.
#[async_trait]
pub trait GmailVerifier: Send + Sync {
    async fn verify(&self, email: &str, password: &str) -> Result<(), String>;
}

/// The keychain half of [`SecretOps`].
pub struct KeychainOps {
    pub store: Arc<dyn SecretStore>,
    pub verifier: Arc<dyn GmailVerifier>,
}

impl KeychainOps {
    pub async fn save_gmail(&self, email: &str, password: &str) -> Result<(), String> {
        self.verifier.verify(email, password).await?;
        self.store.set(&gmail_app_password_secret_account(email), password).await.map_err(|e| e.to_string())
    }

    pub async fn forget_gmail(&self, email: &str) -> Result<(), String> {
        self.store.delete(&gmail_app_password_secret_account(email)).await.map_err(|e| e.to_string())
    }

    pub async fn save_client_secret(&self, url: &str, secret: &str) -> Result<(), String> {
        let account = oauth_client_secret_account(url)?;
        if secret.is_empty() {
            self.store.delete(&account).await.map_err(|e| e.to_string())
        } else {
            self.store.set(&account, secret).await.map_err(|e| e.to_string())
        }
    }

    pub async fn read_secret(&self, account: &str) -> Result<Option<String>, String> {
        self.store.get(account).await.map_err(|e| e.to_string())
    }

    pub async fn write_secret(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        match value {
            Some(value) => self.store.set(account, value).await,
            None => self.store.delete(account).await,
        }
        .map_err(|e| e.to_string())
    }
}

/// The keychain accounts a save is about to write, with what they held before it.
pub struct SecretSnapshot(Vec<(String, Option<String>)>);

/// How a removed server's sign-in ended up.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Release {
    /// `removed` (local secrets deleted) or `shared` (another server still uses it).
    pub removed: bool,
    pub revoked: bool,
}

impl Release {
    pub fn to_value(self) -> Value {
        json!({"signIn": if self.removed { "removed" } else { "shared" }, "revoked": self.revoked})
    }
}

pub struct McpServerSecrets {
    ops: Arc<dyn SecretOps>,
    env: Env,
}

/// Every config `servers` connects with, a multi-account server's accounts as the one-account
/// configs they are.
fn expanded_configs(servers: &Map<String, Value>) -> Vec<Value> {
    servers
        .values()
        .flat_map(|cfg| {
            let accounts = account_servers(cfg);
            if accounts.is_empty() { vec![cfg.clone()] } else { accounts }
        })
        .collect()
}

impl McpServerSecrets {
    pub fn new(ops: Arc<dyn SecretOps>, env: Env) -> Self {
        Self { ops, env }
    }

    /// The client secret a save writes, as (URL, secret); an empty secret deletes.
    fn client_secret_write(input: &Value, cfg: &Value, previous: &Value) -> Option<(String, String)> {
        let url = mixdog_js::value_to_string(cfg.get("url").filter(|u| truthy(u))?);
        let secret = input.get("oauthClientSecret").and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).unwrap_or_default();
        let has_client = cfg.get("oauthClientId").is_some_and(truthy);
        if has_client && !secret.is_empty() {
            Some((url, secret))
        } else if !has_client && previous.get("oauthClientId").is_some_and(truthy) {
            let old_url = previous.get("url").filter(|u| truthy(u)).map_or_else(|| url.clone(), mixdog_js::value_to_string);
            Some((old_url, String::new()))
        } else {
            None
        }
    }

    /// The app password a save writes, as (address, password).
    fn gmail_write(input: &Value, cfg: &Value) -> Option<(String, String)> {
        let account = gmail_app_password_account(cfg);
        let password = gmail_app_password_value(input.get("appPassword").unwrap_or(&Value::Null));
        (!account.is_empty() && !password.is_empty()).then_some((account, password))
    }

    /// What the keychain holds for the two secrets the stores below are about to write, so a save
    /// that fails afterwards can put it back ([`Self::restore`]).
    pub async fn snapshot(&self, input: &Value, cfg: &Value, previous: &Value) -> Result<SecretSnapshot, String> {
        let mut accounts = Vec::new();
        if let Some((url, _)) = Self::client_secret_write(input, cfg, previous)
            && let Ok(account) = oauth_client_secret_account(&url)
        {
            accounts.push(account);
        }
        if let Some((address, _)) = Self::gmail_write(input, cfg) {
            accounts.push(gmail_app_password_secret_account(&address));
        }
        let mut kept = Vec::new();
        for account in accounts {
            let value = self.ops.read_secret(&account).await?;
            kept.push((account, value));
        }
        Ok(SecretSnapshot(kept))
    }

    /// Puts a [`Self::snapshot`] back. Every account is tried; the first failure is reported.
    pub async fn restore(&self, snapshot: SecretSnapshot) -> Result<(), String> {
        let mut first = None;
        for (account, value) in snapshot.0 {
            if let Err(error) = self.ops.write_secret(&account, value.as_deref()).await {
                first.get_or_insert(error);
            }
        }
        first.map_or(Ok(()), Err)
    }

    /// The user's OAuth client secret goes to the keychain only; clearing the client id forgets it.
    pub async fn store_oauth_client_secret(&self, input: &Value, cfg: &Value, previous: &Value) -> Result<(), String> {
        match Self::client_secret_write(input, cfg, previous) {
            Some((url, secret)) => self.ops.save_oauth_client_secret(&url, &secret).await,
            None => Ok(()),
        }
    }

    /// Gmail with an app password: checked with Gmail before anything is saved and kept in the
    /// keychain only. A new connection needs one; an edit without one keeps it.
    pub async fn store_gmail_app_password(&self, input: &Value, cfg: &Value, required: bool) -> Result<(), String> {
        let account = gmail_app_password_account(cfg);
        if account.is_empty() {
            return Ok(());
        }
        let given = input.get("appPassword");
        let password = gmail_app_password_value(given.unwrap_or(&Value::Null));
        if !password.is_empty() {
            return self.ops.save_gmail_app_password(&account, &password).await;
        }
        if required || given.is_some() {
            return Err("GMAIL_APP_PASSWORD_FORMAT: An app password has 16 characters.".to_owned());
        }
        Ok(())
    }

    /// A server's OAuth tokens and client registration go with it, unless another configured
    /// server or account still uses them through the same exact URL (or account key).
    pub async fn release_oauth(&self, cfg: &Value) -> Result<Option<Release>, String> {
        let Some(key) = oauth_credential_of(cfg, &self.env) else { return Ok(None) };
        let servers = self.ops.configured_servers();
        if expanded_configs(&servers).iter().any(|other| oauth_credential_of(other, &self.env).as_deref() == Some(key.as_str())) {
            return Ok(Some(Release { removed: false, revoked: false }));
        }
        let revoked = self.ops.clear_oauth(cfg).await?;
        Ok(Some(Release { removed: true, revoked }))
    }

    /// An app password is deleted once no configured server uses its account.
    pub async fn forget_unused_gmail_app_password(&self, account: &str) -> Result<bool, String> {
        if account.is_empty() {
            return Ok(false);
        }
        let servers = self.ops.configured_servers();
        if expanded_configs(&servers).iter().any(|cfg| gmail_app_password_account(cfg) == account) {
            return Ok(false);
        }
        self.ops.forget_gmail_app_password(account).await?;
        Ok(true)
    }

    /// What the two stores kept for `cfg`, gone again unless a configured server uses it (an add
    /// that was not saved).
    pub async fn forget_stored_secrets(&self, cfg: &Value) -> Result<(), String> {
        self.forget_unused_gmail_app_password(&gmail_app_password_account(cfg)).await?;
        let (Some(url), true) = (cfg.get("url").filter(|u| truthy(u)), cfg.get("oauthClientId").is_some_and(truthy)) else { return Ok(()) };
        let servers = expanded_configs(&self.ops.configured_servers());
        if !servers.iter().any(|other| other.get("url") == Some(url) && other.get("oauthClientId").is_some_and(truthy)) {
            self.ops.save_oauth_client_secret(&mixdog_js::value_to_string(url), "").await?;
        }
        Ok(())
    }

    /// A removed account keeps no sign-in another configured server or account does not share.
    pub async fn release_account(&self, account_cfg: &Value) -> Result<Option<Release>, String> {
        self.ops.forget_account_health(account_cfg.get("name").and_then(Value::as_str).unwrap_or_default());
        let address = gmail_app_password_account(account_cfg);
        if !address.is_empty() {
            let forgotten = self.forget_unused_gmail_app_password(&address).await?;
            return Ok(Some(Release { removed: forgotten, revoked: false }));
        }
        self.release_oauth(account_cfg).await
    }
}
