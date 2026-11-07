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

use std::sync::Arc;

use mixdog_ai::service::admin_route::{Obj, resolve_route};
use mixdog_core_config::config::Config;
use serde_json::Value;

pub struct MainRoute {
    config: Config,
    is_known: Arc<dyn Fn(&str, &Obj) -> bool + Send + Sync>,
}

impl MainRoute {
    /// `is_known` is the catalog's `is_known(provider, config)` (`CatalogFacts`), as the route cell passes it.
    pub fn new(config: Config, is_known: Arc<dyn Fn(&str, &Obj) -> bool + Send + Sync>) -> Self {
        Self { config, is_known }
    }

    /// The route as an object (`{}` when the config resolves none, as the route cell seeds an empty one).
    pub fn route(&self) -> Obj {
        resolve_route(&self.config.agent(), &Obj::new(), &*self.is_known).unwrap_or_default()
    }

    /// `route().provider`: the provider whose models the list shows first.
    pub fn provider(&self) -> String {
        self.route().get("provider").and_then(Value::as_str).unwrap_or_default().to_owned()
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_config::config::ConfigLanes;
    use serde_json::json;

    use super::*;

    // Test files go through the durability lane and `mixdog_statefile`, as the tree's other tests do.
    fn on_lane<R: Send + 'static>(job: impl FnOnce(&mixdog_rt::InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> R {
        use futures::FutureExt as _;
        use mixdog_rt::LaneToken as _;
        tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&mixdog_rt::CancellationToken::new(), job).unwrap())
            .now_or_never()
            .expect("the test backend runs the job inline")
            .unwrap()
    }

    fn write_file(path: &std::path::Path, body: &[u8]) {
        let (path, body) = (path.to_owned(), body.to_vec());
        on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default())).unwrap();
    }

    /// The Lead route is the preset `default` names (`resolveRoute(config, {})`): changing `default`
    /// through the config's own write path between two calls moves the answer of the second one.
    #[tokio::test]
    async fn the_route_follows_the_config_between_calls() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.path().join("mixdog-config.json");
        let agent = json!({
            "default": "first",
            "presets": [
                { "id": "first", "name": "First", "provider": "openai-oauth", "model": "gpt-first" },
                { "id": "second", "name": "Second", "provider": "anthropic-oauth", "model": "claude-second" },
            ],
        });
        write_file(&path, &serde_json::to_vec(&json!({ "agent": agent })).unwrap());
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let main = MainRoute::new(config.clone(), Arc::new(|_, _| true));

        let before = main.route();
        assert_eq!((before["provider"].as_str(), before["model"].as_str()), (Some("openai-oauth"), Some("gpt-first")));
        assert_eq!(main.provider(), "openai-oauth");

        config
            .update_agent(|doc| {
                doc.insert("default".into(), json!("second"));
                Ok(())
            })
            .await
            .unwrap();

        let after = main.route();
        assert_eq!((after["provider"].as_str(), after["model"].as_str()), (Some("anthropic-oauth"), Some("claude-second")));
        assert_eq!(main.provider(), "anthropic-oauth");
    }
}