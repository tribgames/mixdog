//! Keeps the provider config the readiness initializes (`ProviderReadiness::set_providers`, Node's
//! `config.providers` of the runtime) current: the providers of the loaded config are rebuilt on every
//! tick of [`Config::changes`], which a write, an external edit of the file or a stored secret all make.

use std::sync::Arc;

use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::registry::effective::EffectiveProviders;
use mixdog_core_config::config::Config;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use tokio::sync::watch;

/// The running sync: `applied` counts the rebuilds handed to the readiness, so a caller can wait for
/// the one a change causes; `task` ends with `stop` or with the config.
pub struct ProviderSync {
    pub applied: watch::Receiver<u64>,
    pub task: tokio::task::JoinHandle<()>,
}

/// The providers of the loaded config, rebuilt on each config change. A rebuild that fails keeps the
/// previous providers and is logged: the change that caused it has no caller to report to.
pub fn spawn_provider_sync(config: Config, effective: Arc<EffectiveProviders>, readiness: Arc<ProviderReadiness>, stop: CancellationToken) -> ProviderSync {
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
            let rebuilt = match config.loaded_agent().await {
                Ok(agent) => effective.load(&agent, true).await,
                Err(error) => Err(error.to_string()),
            };
            match rebuilt {
                Ok(providers) => {
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