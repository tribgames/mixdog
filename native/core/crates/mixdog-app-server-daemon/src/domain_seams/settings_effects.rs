//! `settings_effects`: what Node does after a setting changes (`session-runtime/boot/apis.mjs`
//! `developerAdapters`, `shell-runtime.mjs setConfiguredShell`, `cache-warm.mjs
//! noteCacheWarmingEnabled`).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::registry::ProviderRegistry;
use mixdog_ai::service::admin_models::developer_option_enabled;
use mixdog_ai::service::admin_models::developer_option_for_provider;
use mixdog_ai::warmer::Warmer;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::SettingsEffects;
use mixdog_js::js_trim;
use mixdog_rt::TaskClass;
use serde_json::Value;

/// The providers a Developer option switches on (`developerOption(id).provider`), read through the
/// provider-to-option table that gates them.
const DEV_PROVIDERS: [&str; 4] = ["antigravity-oauth", "cursor-oauth", "devin-oauth", "mimo-oauth"];

fn provider_of_option(id: &str) -> Option<&'static str> {
    DEV_PROVIDERS.into_iter().find(|provider| developer_option_for_provider(provider) == Some(id))
}

/// `_configuredShell` of `shell-runtime.mjs` (the command the settings name, `None` for none) and
/// `_resolvedShell` (the default program found by walking PATH, dropped when the command changes).
#[derive(Default)]
pub struct ConfiguredShell(Mutex<(Option<String>, Option<String>)>);

impl ConfiguredShell {
    /// `setConfiguredShell(value)`: `String(value || '').trim() || null`; true when it changed,
    /// which also drops the kept default program.
    pub fn set(&self, value: &str) -> bool {
        let next = Some(js_trim(value).to_owned()).filter(|text| !text.is_empty());
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let changed = state.0 != next;
        if changed {
            *state = (next, None);
        }
        changed
    }

    /// `getConfiguredShell()`.
    pub fn get(&self) -> String {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).0.clone().unwrap_or_default()
    }

    /// The kept default program (`_resolvedShell`).
    pub fn kept_default(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).1.clone()
    }

    /// Keeps a probed default program unless the command changed while it was probed.
    pub fn keep_default(&self, configured: &str, program: String) {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if state.0.as_deref().unwrap_or_default() == configured {
            state.1 = Some(program);
        }
    }
}

#[cfg(test)]
mod default_tests {
    use super::*;

    /// `setConfiguredShell` clears `_resolvedShell` only when the value changes.
    #[test]
    fn the_kept_default_program_is_dropped_by_a_changed_command_only() {
        let shell = ConfiguredShell::default();
        assert_eq!(shell.kept_default(), None);
        shell.keep_default("", "/bin/bash".to_owned());
        assert_eq!(shell.kept_default().as_deref(), Some("/bin/bash"));
        assert!(!shell.set("  "));
        assert_eq!(shell.kept_default().as_deref(), Some("/bin/bash"));
        assert!(shell.set("pwsh"));
        assert_eq!(shell.kept_default(), None);
        // A probe that started before the change does not keep its stale answer.
        shell.keep_default("", "/bin/bash".to_owned());
        assert_eq!(shell.kept_default(), None);
        shell.keep_default("pwsh", "/bin/zsh".to_owned());
        assert_eq!(shell.kept_default().as_deref(), Some("/bin/zsh"));
    }
}

pub struct DaemonSettingsEffects {
    shell: Arc<ConfiguredShell>,
    warmer: Arc<Warmer>,
    config: Config,
    readiness: Arc<ProviderReadiness>,
    registry: Arc<ProviderRegistry>,
}

impl DaemonSettingsEffects {
    pub fn new(
        shell: Arc<ConfiguredShell>,
        warmer: Arc<Warmer>,
        config: Config,
        readiness: Arc<ProviderReadiness>,
        registry: Arc<ProviderRegistry>,
    ) -> Arc<Self> {
        Arc::new(Self { shell, warmer, config, readiness, registry })
    }
}

#[async_trait]
impl SettingsEffects for DaemonSettingsEffects {
    fn set_configured_shell(&self, command: &str) {
        self.shell.set(command);
    }

    fn note_cache_warming_enabled(&self, enabled: bool) {
        self.warmer.note_enabled(enabled);
    }

    /// The saved option is already the config's: the provider caches drop, a switched-off
    /// provider leaves the registry at once, a switched-on one initializes in the background.
    async fn sync_developer_option(&self, id: &str) {
        let Some(provider) = provider_of_option(id) else { return };
        self.readiness.invalidate_provider_caches(false);
        let agent = self.config.agent();
        let stored = agent.get("developer").cloned().unwrap_or(Value::Null);
        if !developer_option_enabled(id, &stored) {
            self.registry.disable(provider);
            return;
        }
        let providers = agent.get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
        let readiness = self.readiness.clone();
        mixdog_rt::spawn("developer-option-providers", TaskClass::Work, async move {
            if let Err(error) = readiness.ensure_providers_ready(Some(providers)).await {
                mixdog_rt::node_console_warn!("[providers] {provider} init after enabling failed: {}", error.message);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain_seams::golden;

    #[test]
    fn the_configured_shell_follows_nodes_set_and_get() {
        let shell = ConfiguredShell::default();
        let mut previous = String::new();
        for step in golden()["shell"].as_array().unwrap() {
            // `String(value || '')`: undefined, null and 0 are the empty command.
            let command = step["set"].as_str().unwrap_or_default();
            let changed = shell.set(command);
            let expected = step["get"].as_str().unwrap();
            assert_eq!(shell.get(), expected, "{}", step["set"]);
            assert_eq!(changed, expected != previous, "{}", step["set"]);
            previous = expected.to_owned();
        }
    }

    #[test]
    fn a_developer_option_gates_the_provider_nodes_table_names() {
        let developer = golden()["developer"].as_array().unwrap().clone();
        let mut gated = Vec::new();
        for option in &developer {
            let id = option["id"].as_str().unwrap();
            let provider = option["provider"].as_str();
            assert_eq!(provider_of_option(id), provider, "{id}");
            gated.extend(provider);
            for case in option["enabled"].as_array().unwrap() {
                assert_eq!(developer_option_enabled(id, &case["stored"]), case["enabled"].as_bool().unwrap(), "{id} {}", case["stored"]);
            }
        }
        gated.sort_unstable();
        let mut known = DEV_PROVIDERS.to_vec();
        known.sort_unstable();
        assert_eq!(gated, known);
    }
}
