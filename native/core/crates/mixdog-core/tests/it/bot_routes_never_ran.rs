//! A bot route read that never ran is an error, never "the bot has no route" (which would hand
//! the turn to the config's route, a different model). The test backend every test of the binary
//! shares refuses the jobs this test's thread submits (a lane with no healthy worker), so the test
//! holds whatever else runs in its binary.

use mixdog_core::run_host::turn_inputs::BotRouteStore;
use mixdog_core_run::run_host::route_chain::AGENT_MODE;
use mixdog_core_run::run_host::route_chain::BotRoutes;
use mixdog_core_run::run_host::route_chain::RouteReadUnavailable;
use mixdog_core_run::run_host::route_chain::owner_route_fallbacks;

// Current-thread: the reads submit from the test thread, the one the refusal covers.
#[tokio::test(flavor = "current_thread")]
async fn a_bot_route_read_that_never_ran_is_an_error() {
    let tokens = mixdog_rt::testing::tokens();
    let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
    let data = tempfile::tempdir().unwrap();
    let store = BotRouteStore::new(data.path(), tokens.interactive_io);

    assert_eq!(store.bot_route("botty").await, Err(RouteReadUnavailable));
    assert_eq!(store.stored_bot_route("lead").await, Err(RouteReadUnavailable));

    // Through the readers: the chain of a bot is an error, not an empty chain or the config's.
    let config = serde_json::Map::new();
    assert_eq!(owner_route_fallbacks(AGENT_MODE, "botty", "xai", "grok-4", &config, &store).await, Err(RouteReadUnavailable));
}
