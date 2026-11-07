//! `RouteConfig` of the session's route adapter: what Node's `updateSessionRoute` reads when it
//! resolves a session's owner chain (`getConfig()` and the bot route store), at the moment of the call.
//!
//! The configuration is not held: every `agent_config()` reads the live snapshot (`config.agent()`,
//! Node's `getConfig()`), so a settings change applies to the next route update. The bot routes are the
//! store the turn path already reads (`BotRouteStore`, Node's `readBotRoute`).

use std::sync::Arc;

use mixdog_core_config::config::Config;
use mixdog_core_ports::ports::domain_sessions::Obj;
use mixdog_core_run::run_host::route_chain::BotRoutes;
use mixdog_core_session::session::route_session::RouteConfig;

use super::turn_inputs::BotRouteStore;

pub struct ConfigRouteConfig {
    config: Config,
    bots: Arc<BotRouteStore>,
}

impl ConfigRouteConfig {
    pub fn new(config: Config, bots: Arc<BotRouteStore>) -> Self {
        Self { config, bots }
    }
}

impl RouteConfig for ConfigRouteConfig {
    fn agent_config(&self) -> Obj {
        self.config.agent()
    }

    fn bots(&self) -> &(dyn BotRoutes + Send + Sync) {
        &*self.bots
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_config::config::ConfigLanes;
    use mixdog_rt::LaneToken as _;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[tokio::test]
    async fn the_agent_config_is_the_live_snapshot_and_the_bots_are_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let path = dir.path().join("mixdog-config.json");
        let bytes = serde_json::to_vec(&json!({ "agent": { "marker": 1 } })).unwrap();
        let file = path.clone();
        tokens
            .durability_io
            .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &file, &bytes, &mixdog_statefile::Opts::default()))
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let bots = Arc::new(BotRouteStore::new(dir.path(), tokens.interactive_io));
        let route_config = ConfigRouteConfig::new(config.clone(), bots.clone());
        assert_eq!(route_config.agent_config(), config.agent());
        assert_eq!(route_config.agent_config().get("marker"), Some(&json!(1)));
        let given = route_config.bots() as *const (dyn BotRoutes + Send + Sync) as *const ();
        assert!(std::ptr::eq(given, Arc::as_ptr(&bots) as *const ()), "the store itself, not a copy");
    }
}