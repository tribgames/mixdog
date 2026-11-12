//! API-key storage and lookup (`shared/provider-api-key.mjs`,
//! `shared/custom-provider-keys.mjs`). A key lives in the OS keychain under
//! the account `agent.<provider>.apiKey` (a custom provider's additional keys
//! under `agent.<provider>.apiKey.<keyId>`); an environment variable wins over
//! the stored key. A locked or missing keychain reads as "no stored key",
//! never as an error.
//!
//! [`ApiKeyStore`] is the one resolver; [`ProviderKey`] is the
//! [`ApiKeySource`](crate::providers::key_source::ApiKeySource) an adapter holds.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;

/// The OS keychain (or whatever backs it). Implemented over the keychain
/// store of the host; `mixdog-mcp`'s `SecretStore` has the same shape.
#[async_trait]
pub trait SecretVault: Send + Sync {
    async fn get(&self, account: &str) -> Result<Option<String>, VaultError>;
    async fn set(&self, account: &str, value: &str) -> Result<(), VaultError>;
    async fn delete(&self, account: &str) -> Result<(), VaultError>;

    /// `isFallbackSecret`: whether the account's secret lives in the private fallback file
    /// (a host with no keychain provider) rather than the keychain. Setup views label it. `Err`
    /// only for an `unrun` check.
    async fn is_fallback(&self, _account: &str) -> Result<bool, VaultError> {
        Ok(false)
    }
}

/// A vault call failed. `unrun` says the call never ran (the lane that makes it refused or
/// dropped the job): that tells nothing about the secret, so a reader must report it and never
/// take it for "no key stored". A call that ran and failed keeps Node's behaviour.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[error("{message}")]
pub struct VaultError {
    pub message: String,
    pub unrun: bool,
}

impl VaultError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), unrun: false }
    }

    /// A call whose job never ran.
    pub fn unrun(message: impl Into<String>) -> Self {
        Self { message: message.into(), unrun: true }
    }
}

/// Process environment, injectable.
pub trait Environment: Send + Sync {
    fn var(&self, name: &str) -> Option<String>;

    /// A read of a credential or key variable. Every such read in production goes through here, so the work counter
    /// sees it whichever `Environment` is injected, and what it yields is a credential before anything can carry it
    /// (`carried::keep`, the variable its source).
    fn key_var(&self, name: &str) -> Option<String> {
        #[cfg(feature = "count-work")]
        crate::work::credential_read();
        let value = self.var(name);
        crate::oauth::carried::keep(&format!("env {name}"), &value.as_deref().into_iter().collect::<Vec<_>>());
        value
    }
}

/// [`Environment::key_var`] over the real process environment for a caller with no injected one, keeping `var_os`'s answer
/// (a value that is not UTF-8 is still set). With `key_var`, the one place a credential variable is read.
pub fn process_key_var_os(name: &str) -> Option<std::ffi::OsString> {
    #[cfg(feature = "count-work")]
    crate::work::credential_read();
    let value = std::env::var_os(name);
    let text = value.as_ref().map(|value| value.to_string_lossy());
    crate::oauth::carried::keep(&format!("env {name}"), &text.as_deref().into_iter().collect::<Vec<_>>());
    value
}

/// The real process environment.
pub struct ProcessEnv;

impl Environment for ProcessEnv {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }
}

/// `AGENT_PROVIDER_ENV`: the standard variable per provider.
const AGENT_PROVIDER_ENV: [(&str, &str); 6] = [
    ("openai", "OPENAI_API_KEY"),
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("xai", "XAI_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
];
/// `AGENT_PROVIDER_ENV_ALIASES`.
const AGENT_PROVIDER_ENV_ALIASES: [(&str, &[&str]); 1] = [("xai", &["GROK_API_KEY"])];

/// `MIXDOG_AGENT_<ID>_APIKEY` with runs of dots and whitespace as `_`.
fn provider_secret_env(provider: &str) -> String {
    let mut id = String::new();
    let mut in_run = false;
    for c in provider.chars() {
        if c == '.' || c.is_whitespace() {
            if !in_run {
                id.push('_');
            }
            in_run = true;
        } else {
            id.extend(c.to_uppercase());
            in_run = false;
        }
    }
    format!("MIXDOG_AGENT_{id}_APIKEY")
}

/// The source of a value read out of the keychain `account` (`carried::keep`).
pub fn keychain_source(account: &str) -> String {
    format!("keychain {account}")
}

/// The keychain account of a provider's primary key.
pub fn api_key_account(provider: &str) -> String {
    format!("agent.{provider}.apiKey")
}

/// The keychain account of a custom provider's additional key.
pub fn custom_key_account(provider: &str, key_id: &str) -> String {
    format!("agent.{provider}.apiKey.{key_id}")
}

/// The key-related part of a provider's config entry.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyConfig {
    pub api_key: Option<String>,
    pub api_key_env: Option<String>,
}

/// Key lookup over the environment and the keychain.
#[derive(Clone)]
pub struct ApiKeyStore {
    vault: Arc<dyn SecretVault>,
    env: Arc<dyn Environment>,
    /// A remote-mode server holds no model credentials.
    remote_client: bool,
}

impl ApiKeyStore {
    pub fn new(vault: Arc<dyn SecretVault>, env: Arc<dyn Environment>, remote_client: bool) -> Self {
        Self { vault, env, remote_client }
    }

    /// A key variable's value, as the environment holds it.
    fn read_env(&self, name: &str) -> Option<String> {
        self.env.key_var(name)
    }

    fn set_env(&self, name: &str) -> Option<String> {
        self.read_env(name).filter(|v| !v.is_empty())
    }

    /// The environment variable `get` would return for `provider`, in the
    /// resolver's precedence (standard name, `MIXDOG_AGENT_<ID>_APIKEY`, then
    /// aliases).
    fn environment_key_name(&self, provider: &str) -> Option<String> {
        let standard = AGENT_PROVIDER_ENV.iter().find(|(id, _)| *id == provider).map(|(_, n)| *n);
        if let Some(name) = standard.filter(|n| self.set_env(n).is_some()) {
            return Some(name.to_owned());
        }
        let own = provider_secret_env(provider);
        if self.set_env(&own).is_some() {
            return Some(own);
        }
        AGENT_PROVIDER_ENV_ALIASES
            .iter()
            .find(|(id, _)| *id == provider)
            .and_then(|(_, aliases)| aliases.iter().find(|a| self.set_env(a).is_some()))
            .map(|a| (*a).to_owned())
    }

    /// Name of the environment variable that supplies the effective key
    /// (provenance for the setup views; never the value).
    pub fn env_name(&self, provider: &str) -> Option<String> {
        if self.remote_client {
            return None;
        }
        self.environment_key_name(provider.trim())
    }

    /// A vault read. A read that RAN and failed is "nothing stored" (Node's `catch`); `Err` only
    /// when it never ran.
    async fn stored(&self, account: &str) -> Result<Option<String>, VaultError> {
        // Not counted here: the store behind the vault performs (and counts) the read.
        match self.vault.get(account).await {
            Ok(value) => {
                crate::oauth::carried::keep(&keychain_source(account), &value.as_deref().into_iter().collect::<Vec<_>>());
                Ok(value)
            }
            Err(error) if error.unrun => Err(error),
            Err(_) => Ok(None),
        }
    }

    /// A configured key: its source is the provider's config entry.
    fn configured(provider: &str, key: &str) -> String {
        crate::oauth::carried::keep(&format!("config {provider}"), &[key]);
        key.to_owned()
    }

    /// Presence-only probe.
    pub async fn has(&self, provider: &str) -> Result<bool, VaultError> {
        Ok(self.get(provider).await?.is_some())
    }

    /// The environment key, else the stored one. `Err` when the keychain read never ran.
    pub async fn get(&self, provider: &str) -> Result<Option<String>, VaultError> {
        if self.remote_client {
            return Ok(None);
        }
        let id = provider.trim();
        if id.is_empty() {
            return Ok(None);
        }
        if let Some(name) = self.environment_key_name(id) {
            return Ok(self.set_env(&name));
        }
        Ok(self.stored(&api_key_account(id)).await?.filter(|v| !v.is_empty()))
    }

    /// `resolveProviderApiKey`: the config's env variable alone when it names
    /// one, else an explicit config key, else [`Self::get`]. Empty when none.
    /// `Err` when the keychain read never ran: an empty key would read as "not configured".
    pub async fn resolve(&self, provider: &str, config: &KeyConfig) -> Result<String, VaultError> {
        if let Some(env) = config.api_key_env.as_deref().filter(|e| !e.is_empty()) {
            return Ok(self.read_env(env).unwrap_or_default());
        }
        if let Some(key) = config.api_key.as_deref().filter(|k| !k.is_empty()) {
            return Ok(Self::configured(provider, key));
        }
        Ok(self.get(provider).await?.unwrap_or_default())
    }

    /// `hasProviderApiKey`: [`Self::resolve`]'s precedence without reading a value.
    pub async fn has_resolved(&self, provider: &str, config: &KeyConfig) -> Result<bool, VaultError> {
        if let Some(env) = config.api_key_env.as_deref().filter(|e| !e.is_empty()) {
            return Ok(self.set_env(env).is_some());
        }
        if config.api_key.as_deref().is_some_and(|k| !k.is_empty()) {
            return Ok(true);
        }
        self.has(provider).await
    }

    /// `reloadProviderApiKey`: after an auth rejection the stored or
    /// environment key is read first, so a rotated key beats the stale one in config.
    pub async fn reload(&self, provider: &str, config: &KeyConfig) -> Result<String, VaultError> {
        if let Some(env) = config.api_key_env.as_deref().filter(|e| !e.is_empty()) {
            return Ok(self.read_env(env).unwrap_or_default());
        }
        if let Some(key) = self.get(provider).await? {
            return Ok(key);
        }
        Ok(config.api_key.as_deref().filter(|k| !k.is_empty()).map(|key| Self::configured(provider, key)).unwrap_or_default())
    }

    /// Stores `provider`'s key in the keychain (`setSecret`).
    pub async fn save(&self, provider: &str, key: &str) -> Result<(), VaultError> {
        self.vault.set(&api_key_account(provider.trim()), key).await
    }

    /// Removes `provider`'s stored key.
    pub async fn forget(&self, provider: &str) -> Result<(), VaultError> {
        self.vault.delete(&api_key_account(provider.trim())).await
    }

    /// A custom provider's additional key, or empty when it is not readable. `Err` when the read
    /// never ran.
    pub async fn read_custom(&self, provider: &str, key_id: &str) -> Result<String, VaultError> {
        Ok(self.stored(&custom_key_account(provider, key_id)).await?.unwrap_or_default())
    }

    pub async fn save_custom(&self, provider: &str, key_id: &str, key: &str) -> Result<(), VaultError> {
        self.vault.set(&custom_key_account(provider, key_id), key).await
    }

    pub async fn forget_custom(&self, provider: &str, key_id: &str) -> Result<(), VaultError> {
        self.vault.delete(&custom_key_account(provider, key_id)).await
    }
}

/// A key read that never ran: transient, and not the statement that no key is configured.
fn unread_key(provider: &str, error: &VaultError) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    err.message = format!("The API key for {provider} could not be read: {error}.");
    err
}

fn missing_key(provider: &str) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    err.message = format!("No API key is configured for {provider}.");
    err
}

/// Where a key source reads from.
enum Origin {
    /// A provider's primary key (config, environment, keychain).
    Provider { provider: String, config: KeyConfig },
    /// One of a custom provider's additional keys: the only source is its
    /// keychain entry (an environment variable names the primary key alone).
    Custom { provider: String, key_id: String },
}

/// The key an adapter sends with. The current key is re-resolved per request,
/// so a key saved in settings applies to the next one; `reload` follows
/// `reloadProviderApiKey`. A custom additional key re-reads its own entry.
pub struct ProviderKey {
    store: ApiKeyStore,
    origin: Origin,
    /// A reload that finds a key replaces the config key, as Node rewrites its config.
    latest: Mutex<Option<String>>,
}

impl ProviderKey {
    pub fn primary(store: ApiKeyStore, provider: &str, config: KeyConfig) -> Arc<Self> {
        Arc::new(Self {
            store,
            origin: Origin::Provider { provider: provider.to_owned(), config },
            latest: Mutex::default(),
        })
    }

    pub fn additional(store: ApiKeyStore, provider: &str, key_id: &str) -> Arc<Self> {
        Arc::new(Self {
            store,
            origin: Origin::Custom { provider: provider.to_owned(), key_id: key_id.to_owned() },
            latest: Mutex::default(),
        })
    }

    fn name(&self) -> &str {
        match &self.origin {
            Origin::Provider { provider, .. } | Origin::Custom { provider, .. } => provider,
        }
    }

    async fn current(&self) -> Result<String, ProviderError> {
        let key = match &self.origin {
            Origin::Provider { provider, config } => {
                let mut config = config.clone();
                if let Some(latest) = self.latest.lock().unwrap_or_else(PoisonError::into_inner).clone() {
                    config.api_key = Some(latest);
                }
                self.store.resolve(provider, &config).await
            }
            Origin::Custom { provider, key_id } => self.store.read_custom(provider, key_id).await,
        }
        .map_err(|error| unread_key(self.name(), &error))?;
        if key.is_empty() { Err(missing_key(self.name())) } else { Ok(key) }
    }

    async fn reloaded(&self) -> Result<String, ProviderError> {
        let key = match &self.origin {
            Origin::Provider { provider, config } => self.store.reload(provider, config).await,
            Origin::Custom { provider, key_id } => self.store.read_custom(provider, key_id).await,
        }
        .map_err(|error| unread_key(self.name(), &error))?;
        if key.is_empty() {
            return Err(missing_key(self.name()));
        }
        *self.latest.lock().unwrap_or_else(PoisonError::into_inner) = Some(key.clone());
        Ok(key)
    }
}

#[async_trait]
impl crate::providers::key_source::ApiKeySource for ProviderKey {
    async fn key(&self) -> Result<String, ProviderError> {
        self.current().await
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        self.reloaded().await
    }
}

/// An in-memory vault for tests and hosts without a keychain.
#[derive(Default)]
pub struct MemoryVault {
    entries: Mutex<HashMap<String, String>>,
}

#[async_trait]
impl SecretVault for MemoryVault {
    async fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        Ok(self.entries.lock().unwrap_or_else(PoisonError::into_inner).get(account).cloned())
    }
    async fn set(&self, account: &str, value: &str) -> Result<(), VaultError> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner).insert(account.to_owned(), value.to_owned());
        Ok(())
    }
    async fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner).remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Env(HashMap<&'static str, &'static str>);
    impl Environment for Env {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).map(|v| (*v).to_owned())
        }
    }

    fn store(env: &[(&'static str, &'static str)], remote: bool) -> (ApiKeyStore, Arc<MemoryVault>) {
        let vault = Arc::new(MemoryVault::default());
        (ApiKeyStore::new(vault.clone(), Arc::new(Env(env.iter().copied().collect())), remote), vault)
    }

    #[test]
    fn mixdog_env_name_collapses_dots_and_blanks() {
        assert_eq!(provider_secret_env("custom-a.b  c"), "MIXDOG_AGENT_CUSTOM-A_B_C_APIKEY");
    }

    #[tokio::test]
    async fn environment_beats_the_keychain_in_node_order() {
        let (s, vault) = store(&[("XAI_API_KEY", "std"), ("GROK_API_KEY", "alias"), ("MIXDOG_AGENT_XAI_APIKEY", "own")], false);
        vault.set("agent.xai.apiKey", "stored").await.unwrap();
        assert_eq!(s.get("xai").await.unwrap().as_deref(), Some("std"));
        assert_eq!(s.env_name("xai").as_deref(), Some("XAI_API_KEY"));
        let (s, vault) = store(&[("GROK_API_KEY", "alias")], false);
        vault.set("agent.xai.apiKey", "stored").await.unwrap();
        assert_eq!(s.get("xai").await.unwrap().as_deref(), Some("alias"));
        let (s, vault) = store(&[], false);
        assert_eq!(s.get("xai").await.unwrap(), None);
        vault.set("agent.xai.apiKey", "stored").await.unwrap();
        assert_eq!(s.get("xai").await.unwrap().as_deref(), Some("stored"));
        assert!(s.has("xai").await.unwrap());
    }

    #[tokio::test]
    async fn remote_clients_hold_no_keys() {
        let (s, vault) = store(&[("OPENAI_API_KEY", "k")], true);
        vault.set("agent.openai.apiKey", "stored").await.unwrap();
        assert_eq!(s.get("openai").await.unwrap(), None);
        assert!(!s.has("openai").await.unwrap());
        assert_eq!(s.env_name("openai"), None);
    }

    #[tokio::test]
    async fn config_precedence_and_reload() {
        let (s, vault) = store(&[("MY_KEY", "from-env")], false);
        vault.set("agent.p.apiKey", "stored").await.unwrap();
        let cfg = |key: Option<&str>, env: Option<&str>| KeyConfig {
            api_key: key.map(str::to_owned),
            api_key_env: env.map(str::to_owned),
        };
        assert_eq!(s.resolve("p", &cfg(Some("cfg"), Some("MY_KEY"))).await.unwrap(), "from-env");
        assert_eq!(s.resolve("p", &cfg(Some("cfg"), Some("UNSET"))).await.unwrap(), "");
        assert_eq!(s.resolve("p", &cfg(Some("cfg"), None)).await.unwrap(), "cfg");
        assert_eq!(s.resolve("p", &cfg(None, None)).await.unwrap(), "stored");
        // A reload prefers the stored key to the one captured in config.
        assert_eq!(s.reload("p", &cfg(Some("cfg"), None)).await.unwrap(), "stored");
        assert!(s.has_resolved("p", &cfg(Some("cfg"), Some("UNSET"))).await.unwrap() == false);
    }

    #[tokio::test]
    async fn additional_keys_read_only_their_own_entry() {
        let (s, vault) = store(&[("OPENAI_API_KEY", "env")], false);
        vault.set("agent.custom-1.apiKey.k1", "extra").await.unwrap();
        let source = ProviderKey::additional(s.clone(), "custom-1", "k1");
        assert_eq!(source.current().await.unwrap(), "extra");
        vault.set("agent.custom-1.apiKey.k1", "rotated").await.unwrap();
        assert_eq!(source.reloaded().await.unwrap(), "rotated");
        let gone = ProviderKey::additional(s, "custom-1", "k2");
        assert_eq!(gone.current().await.unwrap_err().kind, ErrorKind::Auth);
    }

    /// A vault whose reads fail the way the test says.
    struct Reads(VaultError);

    #[async_trait]
    impl SecretVault for Reads {
        async fn get(&self, _: &str) -> Result<Option<String>, VaultError> {
            Err(self.0.clone())
        }
        async fn set(&self, _: &str, _: &str) -> Result<(), VaultError> {
            Ok(())
        }
        async fn delete(&self, _: &str) -> Result<(), VaultError> {
            Ok(())
        }
    }

    fn over(vault: VaultError) -> ApiKeyStore {
        ApiKeyStore::new(Arc::new(Reads(vault)), Arc::new(Env(HashMap::new())), false)
    }

    /// A keychain read that ran and failed is "no key", as in Node; one that never ran is an
    /// error, so a provider is never reported unconfigured because a lane was busy.
    #[tokio::test]
    async fn a_key_read_that_never_ran_is_an_error_not_no_key() {
        let failed = over(VaultError::new("[keychain] locked"));
        assert_eq!(failed.get("openai").await, Ok(None));
        assert_eq!(failed.has("openai").await, Ok(false));
        assert_eq!(failed.read_custom("p", "k").await, Ok(String::new()));
        let unrun = VaultError::unrun("the keychain could not be reached");
        let s = over(unrun.clone());
        assert_eq!(s.get("openai").await, Err(unrun.clone()));
        assert_eq!(s.has("openai").await, Err(unrun.clone()));
        let cfg = KeyConfig::default();
        assert_eq!(s.resolve("openai", &cfg).await, Err(unrun.clone()));
        assert_eq!(s.reload("openai", &cfg).await, Err(unrun.clone()));
        assert_eq!(s.has_resolved("openai", &cfg).await, Err(unrun.clone()));
        assert_eq!(s.read_custom("p", "k").await, Err(unrun));
        // The environment and the config key are answered without the vault.
        let with_env = ApiKeyStore::new(Arc::new(Reads(VaultError::unrun("x"))), Arc::new(Env([("OPENAI_API_KEY", "e")].into_iter().collect())), false);
        assert_eq!(with_env.resolve("openai", &cfg).await.unwrap(), "e");
    }

    #[tokio::test]
    async fn the_request_key_of_an_unread_vault_is_a_transient_error_not_missing() {
        let key = ProviderKey::primary(over(VaultError::unrun("the keychain could not be reached")), "openai", KeyConfig::default());
        let error = key.current().await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::Transient);
        assert!(error.message.contains("could not be read"), "{}", error.message);
        assert_eq!(key.reloaded().await.unwrap_err().kind, ErrorKind::Transient);
    }
}
