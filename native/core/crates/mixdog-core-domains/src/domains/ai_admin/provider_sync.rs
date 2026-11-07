//! The loaded config (`loadConfig()`) and what follows it: the canonical agent section with the
//! providers of the loaded config and the effective presets merged onto it, the provider config the
//! readiness initializes (`ProviderReadiness::set_providers`, Node's `config.providers` of the runtime)
//! and the live Main route that resolves over it. All of it is rebuilt on every tick of
//! [`Config::changes`], which a write, an external edit of the file or a stored secret all make
//! (Node: `getConfigSnapshot` is rebuilt when one of its inputs changed).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::registry::effective::EffectiveProviders;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_config::config::Config;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::sync::watch;

/// The loaded config as the sync readers see it: `getConfig()` of the runtime.
pub struct LoadedConfig {
    current: Mutex<Arc<Obj>>,
}

impl LoadedConfig {
    pub fn new(initial: Obj) -> Self {
        Self { current: Mutex::new(Arc::new(initial)) }
    }

    /// The loaded config of the last rebuild.
    pub fn get(&self) -> Arc<Obj> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Stores a rebuilt loaded config.
    pub fn replace(&self, next: Obj) {
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = Arc::new(next);
    }
}

/// `loadConfig()`: the canonical agent section (`canonicalizeAgentStorage`), its `providers` replaced by
/// the providers of the loaded config and its `presets` by the effective ones (the shipped presets laid
/// under the stored ones). `Err` only when a keychain read never ran.
pub async fn load_config(config: &Config, effective: &EffectiveProviders) -> Result<Obj, String> {
    let agent = config.loaded_agent().await.map_err(|error| error.to_string())?;
    let providers = effective.load(&agent, true).await?;
    let presets = mixdog_core_config::workflow::effective_presets(&agent);
    let mut loaded = agent;
    loaded.insert("providers".into(), Value::Object(providers));
    loaded.insert("presets".into(), Value::Array(presets));
    Ok(loaded)
}

/// The running sync: `applied` counts the rebuilds handed on, so a caller can wait for the one a change
/// causes; `task` ends with `stop` or with the config.
pub struct ProviderSync {
    pub applied: watch::Receiver<u64>,
    pub task: tokio::task::JoinHandle<()>,
}

/// Rebuilds the loaded config on each config change, stores it in `loaded` and hands its providers to
/// the readiness. A rebuild that fails keeps the previous one and is logged: the change that caused it
/// has no caller to report to.
pub fn spawn_provider_sync(
    config: Config,
    effective: Arc<EffectiveProviders>,
    readiness: Arc<ProviderReadiness>,
    loaded: Arc<LoadedConfig>,
    stop: CancellationToken,
) -> ProviderSync {
    let (applied_tx, applied) = watch::channel(0u64);
    // Subscribed before the task starts, so no change between the two is missed.
    let mut changes = config.changes();
    let task = mixdog_rt::spawn("providers.sync", TaskClass::Work, async move {
        let mut count = 0u64;
        loop {
            tokio::select! {
                () = stop.cancelled() => return,
                changed = changes.changed() => if changed.is_err() { return },
            }
            match load_config(&config, &effective).await {
                Ok(next) => {
                    let providers = next.get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
                    loaded.replace(next);
                    readiness.set_providers(providers);
                    count += 1;
                    applied_tx.send_replace(count);
                }
                Err(error) => tracing::warn!(%error, "[providers] the loaded config could not be rebuilt; the previous one stays"),
            }
        }
    });
    ProviderSync { applied, task }
}