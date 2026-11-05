//! The config-backed implementations of the ports other packages read their settings through:
//! `mixdog-scm`'s [`FeatureGate`] and [`SettingsSource`], the voice service's
//! [`VoiceSettingsSource`] and [`VoiceEnabledStore`], and the local provider's
//! [`LocalProviderSettings`]. Each reads the live document at use time and writes through the
//! same `Config` transaction as every other writer.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_scm::service::FeatureGate;
use mixdog_scm::worktree::settings::SettingsSource;
use mixdog_scm::worktree::settings::WorktreeSettings;
use mixdog_scm::worktree::settings::normalize;
use mixdog_services::local_provider::service::LocalProviderSettings;
use mixdog_services::voice::VoiceEnabledStore;
use mixdog_services::voice::VoiceSettingsSource;
use serde_json::Map;
use serde_json::Value;
use tokio::sync::Semaphore;

use super::Config;
use super::ConfigError;
use crate::tool_modules::builtin_feature_active;
use crate::tool_modules::with_grandfathered_builtins;

/// The id of the local provider in `providers`.
const LOCAL_PROVIDER_ID: &str = "mixdog-local";

/// Git & GitHub in Extensions: `builtinFeatureActive(withGrandfatheredBuiltins(config), 'git')`.
/// The environment override (`MIXDOG_FEATURE_GIT`) is read at use time.
pub struct ConfigFeatureGate {
    config: Config,
    env: crate::tool_modules::FeatureEnv,
}

impl ConfigFeatureGate {
    pub fn new(config: Config) -> Self {
        Self::with_env(config, Arc::new(|name| std::env::var(name).ok()))
    }

    pub fn with_env(config: Config, env: crate::tool_modules::FeatureEnv) -> Self {
        Self { config, env }
    }
}

#[async_trait]
impl FeatureGate for ConfigFeatureGate {
    async fn github_enabled(&self) -> bool {
        let doc = with_grandfathered_builtins(&self.config.full());
        builtin_feature_active(&doc, "git", &*self.env, true)
    }
}

/// The worktree settings at top-level `worktree`, normalised on every read.
pub struct ConfigWorktreeSettings {
    config: Config,
}

impl ConfigWorktreeSettings {
    pub fn new(config: Config) -> Self {
        Self { config }
    }
}

#[async_trait]
impl SettingsSource for ConfigWorktreeSettings {
    async fn worktree_settings(&self) -> WorktreeSettings {
        normalize(&self.config.get("worktree").unwrap_or(Value::Null))
    }
}

/// The live `voice` section (an empty object when there is none).
pub struct ConfigVoiceSettings {
    config: Config,
}

impl ConfigVoiceSettings {
    pub fn new(config: Config) -> Self {
        Self { config }
    }
}

impl VoiceSettingsSource for ConfigVoiceSettings {
    fn voice_section(&self) -> Value {
        self.config.get("voice").unwrap_or_else(|| Value::Object(Map::new()))
    }
}

/// Persists `voice.enabled`. Every write of it goes through one gate, so the `proceed` check
/// of an install-then-enable runs strictly before or after a competing OFF: the OFF bumps its
/// generation before it queues, and its write follows the check.
pub struct ConfigVoiceEnabled {
    config: Config,
    gate: Semaphore,
}

impl ConfigVoiceEnabled {
    pub fn new(config: Config) -> Self {
        Self { config, gate: Semaphore::new(1) }
    }
}

#[async_trait]
impl VoiceEnabledStore for ConfigVoiceEnabled {
    async fn write_enabled(
        &self,
        enabled: bool,
        proceed: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<bool, String> {
        let _turn = self.gate.acquire().await.map_err(|error| error.to_string())?;
        if !proceed() {
            return Ok(false);
        }
        self.config
            .update(move |doc| {
                let voice = object_at(doc, "voice");
                voice.insert("enabled".into(), Value::Bool(enabled));
                Ok(())
            })
            .await
            .map_err(|error| error.to_string())?;
        Ok(true)
    }
}

/// The installed-model catalog changed: refresh what the model picker lists
/// (`refreshLocalProviderCatalog`).
#[async_trait]
pub trait LocalCatalogRefresh: Send + Sync {
    async fn refresh(&self);
}

/// Persists the idle TTL at `providers.mixdog-local.idleTtlSeconds` (`setLocalProviderIdleTtl`).
pub struct ConfigLocalProviderSettings {
    config: Config,
    catalog: Arc<dyn LocalCatalogRefresh>,
}

impl ConfigLocalProviderSettings {
    pub fn new(config: Config, catalog: Arc<dyn LocalCatalogRefresh>) -> Self {
        Self { config, catalog }
    }
}

#[async_trait]
impl LocalProviderSettings for ConfigLocalProviderSettings {
    async fn persist_idle_ttl(&self, seconds: u64) -> Result<(), String> {
        self.config
            .update(move |doc| {
                let providers = object_at(doc, "providers");
                let local = object_at(providers, LOCAL_PROVIDER_ID);
                local.insert("idleTtlSeconds".into(), Value::from(seconds));
                Ok(())
            })
            .await
            .map(|_| ())
            .map_err(|error: ConfigError| error.to_string())
    }

    async fn catalog_changed(&self) {
        self.catalog.refresh().await;
    }
}

/// The object at `key`, created (or replaced, when the stored value is not an object) in place.
fn object_at<'a>(doc: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let slot = doc.entry(key).or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    match slot {
        Value::Object(map) => map,
        _ => unreachable!("the slot is an object"),
    }
}
