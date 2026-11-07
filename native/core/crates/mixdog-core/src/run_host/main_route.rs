//! The Main route a request that names no thread reads: `resolveRoute(getConfig(), {})` evaluated at
//! the call, never kept (decision `D-model-list-route-1`).
//!
//! Node's desktop asks for the model list and the web-search models on its control session, whose
//! `rt.route` was the config's route when that session was made and moves only with that session's own
//! picks and with an empty route's backfill. Rust has no control session (`protocol.md:845-847`), and a
//! stored copy of the route would be a second route state kept only to reproduce that staleness, so
//! these reads follow the live config. Visible effect: the order of the model list (the Lead
//! provider's models first) and the web-search "Default" row follow a Lead route changed since the
//! control session was made.
//!
//! The config it resolves over is the loaded one (`getConfig()` is `loadConfig()`: the canonical agent
//! section with the providers of the loaded config and the effective presets), not the stored section.

use std::sync::Arc;

use mixdog_ai::service::admin_route::{Obj, resolve_route};
use mixdog_core_domains::domains::ai_admin::provider_sync::LoadedConfig;
use serde_json::Value;

pub struct MainRoute {
    loaded: Arc<LoadedConfig>,
    is_known: Arc<dyn Fn(&str, &Obj) -> bool + Send + Sync>,
}

impl MainRoute {
    /// `is_known` is the catalog's `is_known(provider, config)` (`CatalogFacts`), as the route cell passes it.
    pub fn new(loaded: Arc<LoadedConfig>, is_known: Arc<dyn Fn(&str, &Obj) -> bool + Send + Sync>) -> Self {
        Self { loaded, is_known }
    }

    /// The route as an object (`{}` when the config resolves none, as the route cell seeds an empty one).
    pub fn route(&self) -> Obj {
        resolve_route(&self.loaded.get(), &Obj::new(), &*self.is_known).unwrap_or_default()
    }

    /// `route().provider`: the provider whose models the list shows first.
    pub fn provider(&self) -> String {
        self.route().get("provider").and_then(Value::as_str).unwrap_or_default().to_owned()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn loaded(default: &str) -> Obj {
        json!({
            "default": default,
            "presets": [
                { "id": "first", "name": "First", "provider": "openai-oauth", "model": "gpt-first" },
                { "id": "second", "name": "Second", "provider": "anthropic-oauth", "model": "claude-second" },
            ],
        })
        .as_object()
        .cloned()
        .unwrap()
    }

    /// The Lead route is the preset `default` names (`resolveRoute(config, {})`) in the loaded config the
    /// route reads at each call: a rebuilt loaded config moves the answer of the next one. (That a config
    /// write rebuilds it is `provider_sync`'s test.)
    #[test]
    fn the_route_follows_the_loaded_config_between_calls() {
        let holder = Arc::new(LoadedConfig::new(loaded("first")));
        let main = MainRoute::new(holder.clone(), Arc::new(|_, _| true));

        let before = main.route();
        assert_eq!((before["provider"].as_str(), before["model"].as_str()), (Some("openai-oauth"), Some("gpt-first")));
        assert_eq!(main.provider(), "openai-oauth");

        holder.replace(loaded("second"));

        let after = main.route();
        assert_eq!((after["provider"].as_str(), after["model"].as_str()), (Some("anthropic-oauth"), Some("claude-second")));
        assert_eq!(main.provider(), "anthropic-oauth");
    }
}