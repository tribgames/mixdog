//! What the footer asks of the process that runs it, and where the files it reads are.

use std::path::PathBuf;

use mixdog_core_session::session::statusline_agents::RuntimeEntry;
use mixdog_view_model::display::statusline_format::ModelMetadata;
use serde_json::Map;
use serde_json::Value;

/// Where the footer reads: the plugin data directory (`MIXDOG_DATA_DIR`, else `<mixdog home>/data`: the config, session
/// routes, quota cache, usage log, shell jobs) and the config directory (`MIXDOG_CONFIG_DIR`, else `~/.mixdog`: the
/// `settings.json` the Claude-current route is read from and `cc-statusline-last.json`).
#[derive(Clone, Debug)]
pub struct StatusPaths {
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
}

/// What the Node footer reached through the modules of its own process: the model catalog, the provider rosters, the
/// OAuth usage cache and the live session runtimes.
pub trait StatusHost: Send + Sync {
    /// `getModelMetadataSync(model, provider)`.
    fn catalog_meta(&self, model: &str, provider: &str) -> Option<Map<String, Value>>;
    /// `providerCachedModelsSync(provider)`: the rows of the provider's cached roster (`<provider>-models.json`).
    fn cached_models(&self, provider: &str) -> Vec<Value>;
    /// `readCachedOAuthUsageSnapshot(route, { allowStale })` for `route` = `{ provider, model, providerKind }`: the cached
    /// plan-usage reading (`quotaWindows`, `balance`, `cachedAt`) without measuring.
    fn cached_oauth_usage(&self, route: &Value, allow_stale: bool) -> Option<Value>;
    /// `forEachSessionRuntime()`: the live session runtimes (the sub-sessions of the lead among them).
    fn agent_runtimes(&self) -> Vec<RuntimeEntry>;
    /// `listHiddenAgentNames()`: the agents the registry hides from the worker list.
    fn hidden_agent_names(&self) -> Vec<String>;
    /// The environment variable `name`.
    fn env(&self, name: &str) -> Option<String>;
}

/// `getModelMetadataSync(model, provider)` as the model segment reads it: the window and the names it is shown by.
pub fn model_metadata(host: &dyn StatusHost, model: &str, provider: &str) -> Option<ModelMetadata> {
    let meta = host.catalog_meta(model, provider)?;
    let text = |key: &str| meta.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    Some(ModelMetadata {
        context_window: meta.get("contextWindow").and_then(Value::as_f64).unwrap_or(0.0),
        display_name: text("displayName"),
        display: text("display"),
        name: text("name"),
    })
}
