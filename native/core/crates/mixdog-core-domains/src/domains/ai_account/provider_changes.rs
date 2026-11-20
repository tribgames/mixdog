//! What a change of the providers does: `change.providers` of `createConfigChangeEffects`
//! (`session-runtime/config-change-effects.mjs`), run by `applyConfigChange`
//! (`config-lifecycle.mjs`) after every persisted change.
//!
//! One subscriber follows [`Config::changes`], the one signal a config edit, an external edit
//! and a stored secret change (`SecretChanges`) all tick. It compares the providers' signature
//! with the one last applied and, when it differs, releases the admission cooldowns and
//! re-initializes the providers. An effect that fails is marked not applied and retried after a
//! backoff, whatever else changes meanwhile (`settleConfigEffects`).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use mixdog_ai::admission::Admission;
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::registry::effective::EffectiveProviders;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::SecretChanges;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::task::JoinHandle;

use crate::domains::ai_admin::provider_sync::LoadedConfig;
use crate::domains::ai_admin::provider_sync::reload;

/// `effectRetryDelaysMs`: the last delay repeats.
pub const RETRY_DELAYS: [Duration; 4] = [Duration::from_secs(1), Duration::from_secs(4), Duration::from_secs(15), Duration::from_secs(60)];

/// `PROVIDER_SECRET_ACCOUNT`: `agent.<id>.apiKey`, a custom provider's `agent.<id>.apiKey.<keyId>`,
/// and `#deleted` (a deletion may remove a secret the marker never listed).
fn is_provider_secret(account: &str) -> bool {
    if account == "#deleted" {
        return true;
    }
    let Some(rest) = account.strip_prefix("agent.") else { return false };
    let Some((id, tail)) = rest.split_once('.') else { return false };
    !id.is_empty() && tail.strip_prefix("apiKey").is_some_and(|after| after.is_empty() || after.starts_with('.'))
}

/// `configChangeSnapshot(...).providers`: the stored `agent.providers`, the developer options
/// that shape provider clients, and the change tokens of the provider secrets. Tokens are
/// compared, never the secret values.
pub fn providers_signature(config: &Config, tokens: &BTreeMap<String, String>) -> String {
    let secrets: Vec<(&String, &String)> = tokens.iter().filter(|(account, _)| is_provider_secret(account)).collect();
    json!([config.get("agent.providers").unwrap_or(Value::Null), config.get("agent.developer").unwrap_or(Value::Null), secrets]).to_string()
}

/// The two effects of a providers change.
pub trait ProviderChangeEffects: Send + Sync + 'static {
    /// `resetProviderAdmissionCooldowns()`: the cooldowns belong to the old credentials.
    fn release_admission_cooldowns(&self);
    /// `reinitProviders()`: the registry is rebuilt from the reloaded config.
    fn reinit_providers(&self) -> BoxFuture<'static, Result<(), String>>;
    /// `console.warn`: a line for the operator. Required, so no production effect can fall back to stderr
    /// unseen: the daemon's goes to its log (`LiveProviderEffects::warn`), a fake records it.
    fn warn(&self, line: &str);
}

/// `failed(domain, error)` of `createConfigChangeEffects`: the line to warn with, once per
/// distinct message. A retry failing the same way is not warned about again until the effect
/// recovers (the caller clears `warned` then).
pub fn failure_notice(warned: &mut Option<String>, message: &str) -> Option<String> {
    if warned.as_deref() == Some(message) {
        return None;
    }
    *warned = Some(message.to_owned());
    Some(format!("[config] applying the providers change failed: {message}"))
}

/// `getStoredProviders()`: the stored provider decisions (disable, logout, deleted custom providers); `None` while no
/// stored agent section reads, so a sync removes nothing.
fn stored_providers(config: &Config) -> Option<serde_json::Map<String, Value>> {
    let doc = config.full();
    let agent = doc.get("agent")?.as_object()?;
    Some(agent.get("providers").and_then(Value::as_object).cloned().unwrap_or_default())
}

/// The live services behind [`ProviderChangeEffects`].
pub struct LiveProviderEffects {
    pub admission: Arc<Admission>,
    pub readiness: Arc<ProviderReadiness>,
    /// Where `console.warn` goes: in the daemon, `DaemonLog::console_warn_sink` (its redirect writes
    /// `[console.warn] <line>` to daemon.log; there is no stderr to see).
    pub warn: Arc<dyn Fn(&str) + Send + Sync>,
    /// What the record is rebuilt from (`provider_sync::reload`), and the runtime's loaded config it is stored in, the
    /// one the provider sync rebuilds.
    pub config: Config,
    pub effective: Arc<EffectiveProviders>,
    pub loaded: Arc<LoadedConfig>,
}

impl ProviderChangeEffects for LiveProviderEffects {
    fn release_admission_cooldowns(&self) {
        self.admission.reset_cooldowns(None);
    }

    fn warn(&self, line: &str) {
        (self.warn)(line);
    }

    fn reinit_providers(&self) -> BoxFuture<'static, Result<(), String>> {
        let (readiness, config, effective, loaded) = (self.readiness.clone(), self.config.clone(), self.effective.clone(), self.loaded.clone());
        Box::pin(async move {
            // `applyConfigChange` reloads the runtime's config before this effect, so `providerRecord()` is the reloaded
            // one. The provider sync follows the same change on its own task and may not have rebuilt it yet: it is rebuilt
            // here, after the signature was read, and is the runtime's providers before the sync. Rebuilds hand on in the
            // order they loaded, so no later one puts back a record read before this one, and a ready call after the sync
            // initializes from this record or a newer one. An initialization already running on an older record when the
            // sync runs is not covered: the registry orders it by when it reaches the apply chain, not by when it was asked.
            reload(&config, &effective, &readiness, &loaded).await?;
            readiness.reinit_providers(stored_providers(&config)).await.map_err(|error| error.message)
        })
    }
}

#[cfg(test)]
mod tests {

    use super::*;

    /// `failed()`: the same failure again is not warned about until the effect recovers.
    #[test]
    fn a_failure_is_warned_about_once_per_message() {
        let mut warned = None;
        let line = failure_notice(&mut warned, "registry refused");
        assert_eq!(line.as_deref(), Some("[config] applying the providers change failed: registry refused"));
        assert_eq!(failure_notice(&mut warned, "registry refused"), None);
        assert!(failure_notice(&mut warned, "another").is_some(), "a different message is warned about");
        warned = None;
        assert!(failure_notice(&mut warned, "another").is_some(), "after a recovery the same message is warned about again");
    }
}

/// Starts the subscriber. The signature at the start is the baseline (Node's boot snapshot), so
/// nothing runs until something differs. Dropping the handle does not stop it; aborting does.
pub fn spawn_provider_changes(
    config: Config,
    secrets: Arc<SecretChanges>,
    effects: Arc<dyn ProviderChangeEffects>,
    retry_delays: Vec<Duration>,
) -> JoinHandle<()> {
    mixdog_rt::spawn("provider-changes", TaskClass::Work, async move {
        let mut changes = config.changes();
        let signature = || providers_signature(&config, &secrets.tokens());
        // `None`: an effect failed, so it differs from every signature and the next pass runs it.
        let mut applied = Some(signature());
        let mut warned: Option<String> = None;
        let mut attempt = 0usize;
        loop {
            let backoff = (applied.is_none() && !retry_delays.is_empty()).then(|| retry_delays[attempt.min(retry_delays.len() - 1)]);
            match backoff {
                Some(delay) => {
                    tokio::select! {
                        heard = changes.changed() => if heard.is_err() { return },
                        () = mixdog_rt::time::sleep(delay) => attempt += 1,
                    }
                }
                None => {
                    if changes.changed().await.is_err() {
                        return;
                    }
                }
            }
            let now = signature();
            if applied.as_ref() == Some(&now) {
                continue;
            }
            effects.release_admission_cooldowns();
            match effects.reinit_providers().await {
                Ok(()) => {
                    warned = None;
                    applied = Some(now);
                    attempt = 0;
                }
                Err(message) => {
                    if let Some(line) = failure_notice(&mut warned, &message) {
                        effects.warn(&line);
                    }
                    applied = None;
                }
            }
        }
    })
}
