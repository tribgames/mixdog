//! A bot route read that never ran is an error, never "the bot has no route" (which would hand
//! the turn to the config's route, a different model). Own test binary: it installs a backend
//! that refuses every job.

use std::sync::Arc;
use std::time::Duration;

use mixdog_core::run_host::turn_inputs::BotRouteStore;
use mixdog_core_run::run_host::route_chain::AGENT_MODE;
use mixdog_core_run::run_host::route_chain::BotRoutes;
use mixdog_core_run::run_host::route_chain::RouteReadUnavailable;
use mixdog_core_run::run_host::route_chain::owner_route_fallbacks;
use mixdog_rt::Backend;
use mixdog_rt::LaneFull;
use mixdog_rt::LaneKind;
use mixdog_rt::QueuedJob;
use mixdog_rt::TaskClass;
use mixdog_rt::ThreadKind;

struct Refusing;

impl Backend for Refusing {
    fn handle(&self, _class: TaskClass) -> tokio::runtime::Handle {
        tokio::runtime::Handle::current()
    }

    fn record_poll(&self, _task: &'static str, _class: TaskClass, _elapsed: Duration) {}

    fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        Err(LaneFull { lane: job.lane() })
    }

    fn enter_thread(&self, _kind: ThreadKind) {}

    fn lane_wedged(&self, _lane: LaneKind) -> bool {
        true
    }
}

#[tokio::test]
async fn a_bot_route_read_that_never_ran_is_an_error() {
    let tokens = mixdog_rt::install(Arc::new(Refusing)).expect("first install of this process");
    let data = tempfile::tempdir().unwrap();
    let store = BotRouteStore::new(data.path(), tokens.interactive_io);

    assert_eq!(store.bot_route("botty").await, Err(RouteReadUnavailable));
    assert_eq!(store.stored_bot_route("lead").await, Err(RouteReadUnavailable));

    // Through the readers: the chain of a bot is an error, not an empty chain or the config's.
    let config = serde_json::Map::new();
    assert_eq!(owner_route_fallbacks(AGENT_MODE, "botty", "xai", "grok-4", &config, &store).await, Err(RouteReadUnavailable));
}
