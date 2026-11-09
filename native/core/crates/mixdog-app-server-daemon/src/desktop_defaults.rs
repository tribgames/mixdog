//! The start of the desktop's one-time `desktop` section separation (`DesktopSettingsStore.separateDefaults`), which
//! Node's app ran at app-ready as `void settingsStore.separateDefaults(dataDir).catch(...)` (`index.ts`): a failure
//! (the backup folder cannot be made, the config cannot be saved) never stopped the app. The catch recorded
//! `defaults-separation-failed {message}` in the desktop's own diagnostics log and the start went on. Nothing was
//! saved, so the marker stayed unset and the next start tried again. Here the daemon runs the pass before it serves
//! `config/*`, and a failure ends the same way. The desktop stays the only writer of its diagnostics log: the outcome
//! reaches it as `defaultsSeparation` in every `initialize` reply. As in Node, nothing else is logged.

use mixdog_app_protocol::v1::DefaultsSeparation;
use mixdog_core_config::config::Config;

/// Runs the separation; a failure is reported, never raised. Returns after the attempt, so the caller
/// serves `config/*` only once the `desktop` section is separated or the failure is on record.
pub async fn separate(config: &Config, now_ms: i64) -> DefaultsSeparation {
    match config.separate_desktop_defaults(now_ms).await {
        Ok(_) => DefaultsSeparation::default(),
        Err(error) => {
            DefaultsSeparation { ok: false, message: Some(error.node_message()) }
        }
    }
}

#[cfg(test)]
mod tests;