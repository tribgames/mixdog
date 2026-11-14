//! The loaded config (`loadConfig()`) and what follows it: the canonical agent section with the
//! providers of the loaded config and the effective presets merged onto it, the provider config the
//! readiness initializes (`ProviderReadiness::set_providers`, Node's `config.providers` of the runtime)
//! and the live Main route that resolves over it. All of it is rebuilt on every tick of
//! [`Config::changes`], which a write, an external edit of the file or a stored secret all make, on a change of
//! an OAuth credential file or the account roster, and when a credential expires
//! (Node: `getConfigSnapshot` is rebuilt when one of its inputs changed).

use futures::FutureExt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use std::path::PathBuf;

use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::oauth::Pace;
use mixdog_ai::registry::effective::EffectiveProviders;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_config::config::Config;
use mixdog_core_config::section_watch::FolderTrigger;
use mixdog_core_config::section_watch::Watched;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::sync::Notify;
use tokio::sync::watch;

/// The loaded config as the sync readers see it: `getConfig()` of the runtime.
pub struct LoadedConfig {
    current: Mutex<Arc<Obj>>,
    /// One permit, held by a rebuild (`reload`, `first_pass`) from its load to its hand-on. The provider sync and the
    /// providers change effect both rebuild, so rebuilds hand on in the order they loaded: one that read an older config
    /// never replaces one that read a newer.
    rebuilding: tokio::sync::Semaphore,
}

impl LoadedConfig {
    pub fn new(initial: Obj) -> Self {
        Self { current: Mutex::new(Arc::new(initial)), rebuilding: tokio::sync::Semaphore::new(1) }
    }

    /// The loaded config of the last rebuild.
    pub fn get(&self) -> Arc<Obj> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// The providers of the loaded config (`loadConfig().providers`): the runtime's provider config the readiness
    /// initializes.
    pub fn providers(&self) -> Obj {
        self.get().get("providers").and_then(Value::as_object).cloned().unwrap_or_default()
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

/// One rebuild: `loadConfig()`, then, unless `only_if_changed` finds it the same as the one held, the loaded config is
/// stored in `loaded` and its providers are handed to the readiness. Whether it was handed on; `Err` when the load
/// failed, which keeps the previous one. One rebuild at a time (`LoadedConfig::rebuilding`).
async fn rebuild(
    config: &Config,
    effective: &EffectiveProviders,
    readiness: &ProviderReadiness,
    loaded: &LoadedConfig,
    only_if_changed: bool,
) -> Result<bool, String> {
    // The semaphore is never closed, so the permit is always granted.
    let _rebuilding = loaded.rebuilding.acquire().await;
    let next = load_config(config, effective).await?;
    if only_if_changed && next == *loaded.get() {
        return Ok(false);
    }
    loaded.replace(next);
    readiness.set_providers(loaded.providers());
    Ok(true)
}

/// Rebuilds the loaded config now and hands its providers to the readiness, as the sync does on a change (Node's
/// `applyConfigChange` reloads the runtime's config before its effects run). `Err` when the load failed; the previous
/// one stays.
pub async fn reload(config: &Config, effective: &EffectiveProviders, readiness: &ProviderReadiness, loaded: &LoadedConfig) -> Result<(), String> {
    rebuild(config, effective, readiness, loaded, false).await.map(drop)
}

/// The running sync: `applied` counts the rebuilds handed on, so a caller can wait for the one a change
/// causes; `task` ends with `stop` or with the config.
pub struct ProviderSync {
    pub applied: watch::Receiver<u64>,
    /// True once the sync has taken in what changed before its watch began and has read the credential expiry it waits for:
    /// from then on every change reaches `applied`. Only a test waits for it.
    #[cfg(test)]
    pub ready: watch::Receiver<bool>,
    pub task: tokio::task::JoinHandle<()>,
}

/// Rebuilds the loaded config on each change of its inputs, stores it in `loaded` and hands its providers to
/// the readiness. A rebuild that fails keeps the previous one and is logged: the change that caused it
/// has no caller to report to.
pub fn spawn_provider_sync(
    config: Config,
    effective: Arc<EffectiveProviders>,
    readiness: Arc<ProviderReadiness>,
    loaded: Arc<LoadedConfig>,
    stop: CancellationToken,
) -> ProviderSync {
    spawn_provider_sync_on(config, effective, readiness, loaded, stop, Arc::new(mixdog_ai::oauth::SystemPace))
}

/// What the credential watch watches for `inputs` (`config-snapshot.mjs` `watchInputs`): each file directly in its
/// folder, and for a file whose folder does not exist yet, the highest missing folder (recursively, once created).
#[allow(clippy::disallowed_methods, reason = "a one-time look at which folders exist, as the watch setup beside it touches them")]
fn watched_inputs(inputs: &[PathBuf]) -> Watched {
    let mut watched = Watched::default();
    for path in inputs {
        let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else { continue };
        if dir.is_dir() {
            watched.files.push((dir.to_path_buf(), name.to_owned()));
            continue;
        }
        let mut missing = dir;
        while let Some(parent) = missing.parent().filter(|parent| !parent.is_dir()) {
            missing = parent;
        }
        if !watched.roots.iter().any(|root| root == missing) {
            watched.roots.push(missing.to_path_buf());
        }
    }
    watched
}

/// [`spawn_provider_sync`] on `pace`'s clock. Node's snapshot (`config-snapshot.mjs`) rebuilds after any input
/// change: a config change ([`Config::changes`]), a write or removal of a credential file or the account roster (its
/// watch), and the expiry of an access token with no refresh token (one timer at that moment).
pub fn spawn_provider_sync_on(
    config: Config,
    effective: Arc<EffectiveProviders>,
    readiness: Arc<ProviderReadiness>,
    loaded: Arc<LoadedConfig>,
    stop: CancellationToken,
    pace: Arc<dyn Pace>,
) -> ProviderSync {
    let (applied_tx, applied) = watch::channel(0u64);
    #[cfg(test)]
    let (ready_tx, ready) = watch::channel(false);
    // Subscribed before the task starts, so no change between the two is missed.
    let mut changes = config.changes();
    // Watched before the task starts, for the same reason. A watch that cannot start leaves the config trigger.
    let touched = Arc::new(Notify::new());
    let watch = FolderTrigger::start("provider-credentials", watched_inputs(&effective.credential_inputs()), touched.clone())
        .map_err(|error| tracing::warn!(%error, "[providers] the credential files cannot be watched"))
        .ok();
    let task = mixdog_rt::spawn("providers.sync", TaskClass::Work, async move {
        let _watch = watch;
        let mut count = 0u64;
        if first_pass(&config, &effective, &readiness, &loaded, &mut changes, &touched).await {
            count += 1;
            applied_tx.send_replace(count);
        }
        let mut expiry = effective.credential_expiry().await;
        #[cfg(test)]
        ready_tx.send_replace(true);
        loop {
            let deadline = {
                let pace = pace.clone();
                async move {
                    match expiry {
                        Some(at) => pace.wait(std::time::Duration::from_millis((at - pace.now_ms() as f64).max(0.0) as u64)).await,
                        None => std::future::pending().await,
                    }
                }
            };
            tokio::select! {
                () = stop.cancelled() => return,
                changed = changes.changed() => if changed.is_err() { return },
                () = touched.notified() => {}
                () = deadline => {}
            }
            expiry = effective.credential_expiry().await;
            match reload(&config, &effective, &readiness, &loaded).await {
                Ok(()) => {
                    count += 1;
                    applied_tx.send_replace(count);
                }
                Err(error) => tracing::warn!(%error, "[providers] the loaded config could not be rebuilt; the previous one stays"),
            }
        }
    });
    ProviderSync {
        applied,
        #[cfg(test)]
        ready,
        task,
    }
}

/// Node watches its inputs before it loads (`config-snapshot.mjs`, "Watch before loading, so a write after the load is
/// never missed"); the caller loaded before this watch began, so what changed in between is taken in now, and only that:
/// a load that finds the same config hands nothing on. Every change signalled so far is marked seen before the load reads, so
/// the load that took it in is the only one it causes. Whether a rebuild was handed on.
pub(super) async fn first_pass(
    config: &Config,
    effective: &EffectiveProviders,
    readiness: &ProviderReadiness,
    loaded: &LoadedConfig,
    changes: &mut watch::Receiver<u64>,
    touched: &Notify,
) -> bool {
    changes.borrow_and_update();
    // A stored permit is a touch before this load; the load reads what it left.
    touched.notified().now_or_never();
    rebuild(config, effective, readiness, loaded, true).await.unwrap_or(false)
}