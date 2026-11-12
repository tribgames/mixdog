//! The providers of the loaded config (`loadConfig().providers`): the probe-built defaults
//! (`buildDefaultConfig`, `orchestrator/config.mjs`) with the stored section folded onto them
//! and the API keys overlaid (`mergeStoredProviders`, `config-providers-merge.mjs`).
//!
//! The stored section (`Config::agent()`) holds only the user's own decisions; what a reader of
//! the loaded config sees (the dashboard rows, the web-search list, the quick model rows, the
//! provider registry) is this.

use std::sync::Arc;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::keys::ApiKeyStore;
use super::keys::Environment;
use super::providers::ProviderBuilder;
use crate::accounts::CredentialState;

/// `AGENT_PROVIDER_ENV`, in Node's key order: the provider and the variable that enables it.
const KEY_PROVIDERS: [(&str, &str); 6] = [
    ("openai", "OPENAI_API_KEY"),
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("gemini", "GEMINI_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("xai", "XAI_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
];

/// The OAuth entries of `buildDefaultConfig`, in order. The first six always exist; the rest only
/// while their Developer option is on (`isOAuthProviderAvailable`).
const OAUTH_ALWAYS: [&str; 6] = ["openai-oauth", "anthropic-oauth", "grok-oauth", "muse-code-oauth", "command-code-oauth", "opencode-go-oauth"];
const OAUTH_DEV_GATED: [&str; 4] = ["mimo-oauth", "cursor-oauth", "devin-oauth", "antigravity-oauth"];

pub struct EffectiveProviders {
    builder: Arc<dyn ProviderBuilder>,
    keys: ApiKeyStore,
    env: Arc<dyn Environment>,
}

impl EffectiveProviders {
    pub fn new(builder: Arc<dyn ProviderBuilder>, keys: ApiKeyStore, env: Arc<dyn Environment>) -> Self {
        Self { builder, keys, env }
    }

    /// The files a change of which changes [`Self::load`]'s answer beside the config (the OAuth probes' inputs).
    pub fn credential_inputs(&self) -> Vec<std::path::PathBuf> {
        self.builder.credential_inputs()
    }

    /// The earliest moment ahead at which a present OAuth credential stops being a sign-in, so [`Self::load`]'s answer
    /// changes with no file changing (`loaded.expiresAt` of `observeOAuthCredentialExpiry`); `None` when none does.
    pub async fn credential_expiry(&self) -> Option<f64> {
        let mut earliest: Option<f64> = None;
        for name in OAUTH_ALWAYS.iter().chain(OAUTH_DEV_GATED.iter()) {
            if let Some(until) = self.builder.oauth_credential_expiry(name).await {
                earliest = Some(earliest.map_or(until, |at| at.min(until)));
            }
        }
        earliest
    }

    /// `buildDefaultConfig({ detectCredentials }).providers`.
    async fn defaults(&self, detect: bool) -> Map<String, Value> {
        let mut providers = Map::new();
        for (name, variable) in KEY_PROVIDERS {
            let key = if detect { self.env.key_var(variable).filter(|key| !key.is_empty()) } else { None };
            let mut entry = Map::new();
            entry.insert("enabled".into(), Value::Bool(key.is_some()));
            if let Some(key) = key {
                entry.insert("apiKey".into(), Value::String(key));
            }
            providers.insert(name.into(), Value::Object(entry));
        }
        providers.insert("vertex-ai".into(), json!({ "enabled": false, "authMode": "service-account" }));
        for name in OAUTH_ALWAYS {
            let extra = if name == "openai-oauth" { json!({ "websocket": true }) } else { json!({}) };
            providers.insert(name.into(), self.oauth_entry(name, detect, extra).await);
        }
        for name in OAUTH_DEV_GATED {
            if self.builder.available(name) {
                providers.insert(name.into(), self.oauth_entry(name, detect, json!({})).await);
            }
        }
        providers.insert("mixdog-local".into(), json!({ "enabled": false }));
        providers
    }

    /// `oauthEntry(name, extra)`: `enabled` is the probe's `present`; an unreadable credential, or
    /// one never probed, is carried as `credentialProbeUnavailable` (never a logout).
    async fn oauth_entry(&self, name: &str, detect: bool, extra: Value) -> Value {
        let state = if detect {
            // A probe that never ran is a momentary failure (Node's catch), not a logout.
            Some(self.builder.oauth_credential_state(name).await.unwrap_or(CredentialState::Unreadable))
        } else {
            None
        };
        let mut entry = Map::new();
        entry.insert("enabled".into(), Value::Bool(state == Some(CredentialState::Present)));
        if matches!(state, None | Some(CredentialState::Unreadable)) {
            entry.insert("credentialProbeUnavailable".into(), Value::Bool(true));
        }
        if let Value::Object(extra) = extra {
            entry.extend(extra);
        }
        Value::Object(entry)
    }

    /// `loadConfig({ secrets: include_secrets }).providers` over the stored agent section. `Err`
    /// only when a keychain read never ran: a missing key would read as "not configured".
    pub async fn load(&self, agent: &Map<String, Value>, include_secrets: bool) -> Result<Map<String, Value>, String> {
        #[cfg(feature = "count-work")]
        crate::work::providers_loaded();
        let stored = agent.get("providers").and_then(Value::as_object);
        let mut merged = self.defaults(include_secrets).await;
        for (name, value) in stored.into_iter().flatten() {
            let Some(own) = value.as_object() else {
                merged.insert(name.clone(), value.clone());
                continue;
            };
            let mut entry = merged.get(name).and_then(Value::as_object).cloned().unwrap_or_default();
            entry.extend(own.clone());
            // A STORED `enabled` is the user's own decision and outranks the probe.
            if own.contains_key("enabled") {
                entry = entry.into_iter().filter(|(key, _)| key != "credentialProbeUnavailable").collect();
            }
            merged.insert(name.clone(), Value::Object(entry));
        }
        let stored_enabled = |name: &str| stored.and_then(|s| s.get(name)).and_then(|entry| entry.get("enabled"));
        // A custom provider with no auth never carries a key, not even a hand-edited one.
        for value in merged.values_mut() {
            let keyless = value.get("type").and_then(Value::as_str) == Some("custom") && value.get("auth").and_then(Value::as_str) == Some("none");
            if keyless && let Some(entry) = value.as_object_mut() {
                *entry = std::mem::take(entry).into_iter().filter(|(key, _)| key != "apiKey").collect();
            }
        }
        if include_secrets {
            for (name, _) in KEY_PROVIDERS {
                if let Some(key) = self.keys.get(name).await.map_err(|error| error.message)? {
                    let mut entry = merged.get(name).and_then(Value::as_object).cloned().unwrap_or_default();
                    entry.insert("apiKey".into(), Value::String(key));
                    entry.insert("enabled".into(), Value::Bool(stored_enabled(name) != Some(&Value::Bool(false))));
                    merged.insert(name.into(), Value::Object(entry));
                }
            }
            let custom: Vec<String> = merged
                .iter()
                .filter(|(name, value)| {
                    name.starts_with("custom-")
                        && value.get("type").and_then(Value::as_str) == Some("custom")
                        && value.get("auth").and_then(Value::as_str) != Some("none")
                })
                .map(|(name, _)| name.clone())
                .collect();
            for name in custom {
                let mut entry = merged.get(&name).and_then(Value::as_object).cloned().unwrap_or_default();
                if let Some(variable) = entry.get("apiKeyEnv").and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned) {
                    // Env mode: the named variable is the only key source.
                    entry = entry.into_iter().filter(|(key, _)| key != "apiKey").collect();
                    if let Some(key) = self.env.key_var(&variable).filter(|key| !key.is_empty()) {
                        entry.insert("apiKey".into(), Value::String(key));
                    }
                } else if let Some(key) = self.keys.get(&name).await.map_err(|error| error.message)? {
                    entry.insert("apiKey".into(), Value::String(key));
                    entry.insert("enabled".into(), Value::Bool(stored_enabled(&name) != Some(&Value::Bool(false))));
                }
                merged.insert(name, Value::Object(entry));
            }
        }
        // Cursor account access is OAuth-only: the "API" meter is a quota bucket, not a provider.
        merged.shift_remove("cursor-api");
        Ok(merged)
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use mixdog_core_api::domain::provider::ProviderAdapter;

    use super::super::keys::MemoryVault;
    use super::super::keys::SecretVault;
    use super::*;

    struct Probe {
        present: Vec<&'static str>,
        unreadable: Vec<&'static str>,
        gated: Vec<&'static str>,
    }

    #[async_trait]
    impl ProviderBuilder for Probe {
        async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Err("not built here".into())
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, name: &str) -> bool {
            !self.gated.contains(&name)
        }
        async fn oauth_credentials_usable(&self, name: &str) -> Result<bool, String> {
            Ok(self.present.contains(&name))
        }
        async fn oauth_credential_state(&self, name: &str) -> Result<CredentialState, String> {
            Ok(if self.present.contains(&name) {
                CredentialState::Present
            } else if self.unreadable.contains(&name) {
                CredentialState::Unreadable
            } else {
                CredentialState::Absent
            })
        }
    }

    struct Vars(Vec<(&'static str, &'static str)>);
    impl Environment for Vars {
        fn var(&self, name: &str) -> Option<String> {
            self.0.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
        }
    }

    fn effective(probe: Probe, vars: Vec<(&'static str, &'static str)>, vault: Arc<MemoryVault>) -> EffectiveProviders {
        let env: Arc<dyn Environment> = Arc::new(Vars(vars));
        EffectiveProviders::new(Arc::new(probe), ApiKeyStore::new(vault, env.clone(), false), env)
    }

    fn nothing() -> Probe {
        Probe { present: Vec::new(), unreadable: Vec::new(), gated: vec!["mimo-oauth", "cursor-oauth", "devin-oauth", "antigravity-oauth"] }
    }

    #[tokio::test]
    async fn a_profile_with_no_credentials_gets_the_default_providers() {
        let providers = effective(nothing(), Vec::new(), Arc::new(MemoryVault::default())).load(&Map::new(), true).await.unwrap();
        let names: Vec<&str> = providers.keys().map(String::as_str).collect();
        assert_eq!(
            names,
            ["openai", "anthropic", "gemini", "deepseek", "xai", "openrouter", "vertex-ai", "openai-oauth", "anthropic-oauth", "grok-oauth", "muse-code-oauth", "command-code-oauth", "opencode-go-oauth", "mixdog-local"]
        );
        assert_eq!(providers["openai-oauth"], json!({ "enabled": false, "websocket": true }));
        assert_eq!(providers["anthropic-oauth"], json!({ "enabled": false }));
        assert_eq!(providers["vertex-ai"], json!({ "enabled": false, "authMode": "service-account" }));
        assert_eq!(providers["openai"], json!({ "enabled": false }));
    }

    #[tokio::test]
    async fn an_oauth_entry_follows_its_probe_and_a_stored_enabled_outranks_it() {
        let probe = Probe { present: vec!["anthropic-oauth"], unreadable: vec!["grok-oauth"], gated: nothing().gated };
        let stored = json!({ "providers": { "anthropic-oauth": { "enabled": false }, "grok-oauth": { "model": "m" } } });
        let providers = effective(probe, Vec::new(), Arc::new(MemoryVault::default())).load(stored.as_object().unwrap(), true).await.unwrap();
        assert_eq!(providers["anthropic-oauth"], json!({ "enabled": false }));
        assert_eq!(providers["grok-oauth"], json!({ "enabled": false, "credentialProbeUnavailable": true, "model": "m" }));
        let unprobed = effective(nothing(), Vec::new(), Arc::new(MemoryVault::default())).load(&Map::new(), false).await.unwrap();
        assert_eq!(unprobed["openai-oauth"], json!({ "enabled": false, "credentialProbeUnavailable": true, "websocket": true }));
    }

    #[tokio::test]
    async fn a_key_enables_its_provider_and_a_dev_gated_one_appears_only_when_on() {
        let vault = Arc::new(MemoryVault::default());
        vault.set("agent.gemini.apiKey", "stored").await.unwrap();
        let probe = Probe { present: Vec::new(), unreadable: Vec::new(), gated: vec!["mimo-oauth", "devin-oauth", "antigravity-oauth"] };
        let providers = effective(probe, vec![("OPENAI_API_KEY", "from-env")], vault).load(&Map::new(), true).await.unwrap();
        assert_eq!(providers["openai"], json!({ "enabled": true, "apiKey": "from-env" }));
        assert_eq!(providers["gemini"], json!({ "enabled": true, "apiKey": "stored" }));
        assert!(providers.contains_key("cursor-oauth") && !providers.contains_key("mimo-oauth"));
    }
}