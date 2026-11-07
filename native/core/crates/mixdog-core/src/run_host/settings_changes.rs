//! `announceSettingsChange` (`session-runtime/boot/providers.mjs`): the step that announces a settings change to the attached surfaces.
//! Node runs it from `applyConfigChange` (`config-lifecycle.mjs`) when `diffConfigSnapshots` finds `settings` changed: the stored
//! settings root without its `desktop` section, and the secret change tokens, differ from what this runtime last applied
//! (`configChangeSnapshot`, `config-change-effects.mjs`). The baseline is the configuration at boot. A rewrite of identical content,
//! a change of the `desktop` section alone, and a token refresh nobody announced are not settings changes.

use std::sync::Arc;

use mixdog_core_config::config::Config;
use mixdog_core_config::config::SecretChanges;
use mixdog_rt::TaskClass;
use serde_json::json;
use tokio::sync::watch;

/// `configChangeSnapshot(...).settings`.
fn settings_signature(config: &Config, secrets: &SecretChanges) -> String {
    let mut root = (*config.full()).clone();
    root.remove("desktop");
    json!([root, secrets.tokens()]).to_string()
}

pub struct SettingsChanges {
    announced: watch::Sender<u64>,
}

impl SettingsChanges {
    /// Starts following `config`: the configuration as it is now is the applied baseline.
    pub fn start(config: Config, secrets: Arc<SecretChanges>) -> Arc<Self> {
        let (announced, _) = watch::channel(0_u64);
        let this = Arc::new(Self { announced });
        let mut ticks = config.changes();
        let mut applied = settings_signature(&config, &secrets);
        let sender = this.announced.clone();
        drop(mixdog_rt::spawn("settings-changes", TaskClass::Work, async move {
            while ticks.changed().await.is_ok() {
                let next = settings_signature(&config, &secrets);
                if next != applied {
                    applied = next;
                    sender.send_modify(|count| *count += 1);
                }
            }
        }));
        this
    }

    /// The count of settings changes announced so far; it moves once per announcement.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.announced.subscribe()
    }
}
